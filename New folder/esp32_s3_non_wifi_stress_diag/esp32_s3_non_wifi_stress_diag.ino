/*
  ESP32-S3 Non-WiFi Stress Diagnostic

  Purpose:
    Stress the ESP32-S3 without enabling WiFi/BT:
      - CPU at 240 MHz
      - heap allocation
      - PSRAM allocation/fill/verify, if PSRAM is enabled
      - flash partition reads
      - optional LED/GPIO blinking

  Expected result:
    A healthy board should run this continuously without brownout. If this
    passes but WiFi boot browns out, the failing load is specifically the
    WiFi/RF startup current on the 3.3V rail.
*/

#include <Arduino.h>
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"

constexpr uint32_t STARTUP_DELAY_MS = 3000;
constexpr uint32_t STATUS_INTERVAL_MS = 1000;
constexpr uint32_t RUN_CPU_MHZ = 240;

// Set to a real simple LED GPIO if your board has one. -1 disables it.
// Many ESP32-S3 N16R8 devkits use an addressable RGB LED instead of a simple LED,
// so this may not visibly blink unless you set the correct simple LED pin.
constexpr int SIMPLE_LED_PIN = -1;

// Allocate this much PSRAM if PSRAM is enabled. Keep below 8 MB to leave margin.
constexpr size_t PSRAM_TEST_BYTES = 5 * 1024 * 1024;
constexpr size_t INTERNAL_TEST_BYTES = 64 * 1024;
constexpr size_t FLASH_READ_BYTES_PER_LOOP = 512 * 1024;

HardwareSerial& DebugUart = Serial0;
uint8_t* psramBlock = nullptr;
uint8_t* internalBlock = nullptr;
const esp_partition_t* runningPartition = nullptr;
uint32_t lastStatusMs = 0;
uint32_t loopCount = 0;
uint32_t cpuAccumulator = 0x12345678;

void logLine(const char* line) {
  Serial.println(line);
  DebugUart.println(line);
  Serial.flush();
  DebugUart.flush();
}

const char* resetReasonName(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_EXT: return "EXTERNAL_RESET";
    case ESP_RST_SW: return "SOFTWARE_RESET";
    case ESP_RST_PANIC: return "PANIC_EXCEPTION";
    case ESP_RST_INT_WDT: return "INTERRUPT_WATCHDOG";
    case ESP_RST_TASK_WDT: return "TASK_WATCHDOG";
    case ESP_RST_WDT: return "OTHER_WATCHDOG";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_SDIO: return "SDIO";
    default: return "UNKNOWN";
  }
}

void printStatus(const char* label) {
  char line[260];
  snprintf(line, sizeof(line),
           "[STATUS] %s ms=%lu loops=%lu cpu=%lu heapFree=%lu heapMin=%lu heapMaxAlloc=%lu psramFound=%s psramFree=%lu psramMaxAlloc=%lu acc=0x%08lx",
           label,
           static_cast<unsigned long>(millis()),
           static_cast<unsigned long>(loopCount),
           static_cast<unsigned long>(getCpuFrequencyMhz()),
           static_cast<unsigned long>(ESP.getFreeHeap()),
           static_cast<unsigned long>(ESP.getMinFreeHeap()),
           static_cast<unsigned long>(ESP.getMaxAllocHeap()),
           psramFound() ? "yes" : "no",
           static_cast<unsigned long>(ESP.getFreePsram()),
           static_cast<unsigned long>(ESP.getMaxAllocPsram()),
           static_cast<unsigned long>(cpuAccumulator));
  logLine(line);
}

void fillPattern(uint8_t* data, size_t len, uint32_t seed) {
  uint32_t x = seed;
  for (size_t i = 0; i < len; i++) {
    x = x * 1664525UL + 1013904223UL;
    data[i] = static_cast<uint8_t>((x >> 24) ^ i);
  }
}

bool verifyPattern(uint8_t* data, size_t len, uint32_t seed) {
  uint32_t x = seed;
  for (size_t i = 0; i < len; i++) {
    x = x * 1664525UL + 1013904223UL;
    const uint8_t expected = static_cast<uint8_t>((x >> 24) ^ i);
    if (data[i] != expected) {
      char line[120];
      snprintf(line, sizeof(line), "[ERROR] memory verify failed at offset=%lu got=%u expected=%u",
               static_cast<unsigned long>(i),
               static_cast<unsigned int>(data[i]),
               static_cast<unsigned int>(expected));
      logLine(line);
      return false;
    }
  }
  return true;
}

void stressCpu(uint32_t durationMs) {
  const uint32_t endMs = millis() + durationMs;
  uint32_t a = cpuAccumulator;
  while (static_cast<int32_t>(millis() - endMs) < 0) {
    for (uint32_t i = 0; i < 2000; i++) {
      a ^= (a << 7);
      a ^= (a >> 9);
      a += 0x9e3779b9UL + i;
    }
    yield();
  }
  cpuAccumulator = a;
}

void stressMemoryBlock(uint8_t* block, size_t len, const char* name, uint32_t seed) {
  if (!block || len == 0) return;

  char line[100];
  snprintf(line, sizeof(line), "[MEMTEST] %s fill %lu bytes", name, static_cast<unsigned long>(len));
  logLine(line);
  fillPattern(block, len, seed);

  snprintf(line, sizeof(line), "[MEMTEST] %s verify", name);
  logLine(line);
  if (!verifyPattern(block, len, seed)) {
    logLine("[MEMTEST] stopping after verify failure");
    while (true) delay(1000);
  }
}

void stressFlash() {
  if (!runningPartition) return;

  uint8_t buffer[1024];
  size_t bytesRead = 0;
  uint32_t checksum = 0;
  const size_t limit = min(static_cast<size_t>(runningPartition->size), FLASH_READ_BYTES_PER_LOOP);

  while (bytesRead < limit) {
    const size_t toRead = min(sizeof(buffer), limit - bytesRead);
    if (esp_partition_read(runningPartition, bytesRead, buffer, toRead) != ESP_OK) {
      logLine("[FLASH] read failed");
      return;
    }

    for (size_t i = 0; i < toRead; i++) {
      checksum = (checksum << 5) ^ (checksum >> 2) ^ buffer[i];
    }
    bytesRead += toRead;
  }

  cpuAccumulator ^= checksum;
}

void setup() {
  if (RUN_CPU_MHZ > 0) {
    setCpuFrequencyMhz(RUN_CPU_MHZ);
  }

  Serial.begin(115200);
  DebugUart.begin(115200);
  delay(STARTUP_DELAY_MS);

  logLine("");
  logLine("ESP32-S3 non-WiFi stress diagnostic starting.");

  const esp_reset_reason_t reason = esp_reset_reason();
  char resetLine[80];
  snprintf(resetLine, sizeof(resetLine), "Last reset reason: %d (%s)",
           static_cast<int>(reason), resetReasonName(reason));
  logLine(resetLine);
  printStatus("startup");

  if (SIMPLE_LED_PIN >= 0) {
    pinMode(SIMPLE_LED_PIN, OUTPUT);
  }

  internalBlock = static_cast<uint8_t*>(malloc(INTERNAL_TEST_BYTES));
  if (internalBlock) {
    logLine("[ALLOC] internal heap block allocated");
  } else {
    logLine("[ALLOC] internal heap block allocation failed");
  }

  if (psramFound()) {
    psramBlock = static_cast<uint8_t*>(ps_malloc(PSRAM_TEST_BYTES));
    if (psramBlock) {
      logLine("[ALLOC] PSRAM block allocated");
    } else {
      logLine("[ALLOC] PSRAM block allocation failed");
    }
  } else {
    logLine("[ALLOC] PSRAM not enabled/found; skipping PSRAM block");
  }

  runningPartition = esp_ota_get_running_partition();
  if (runningPartition) {
    char line[120];
    snprintf(line, sizeof(line), "[FLASH] running partition offset=0x%lx size=%lu",
             static_cast<unsigned long>(runningPartition->address),
             static_cast<unsigned long>(runningPartition->size));
    logLine(line);
  }

  printStatus("after setup");
}

void loop() {
  loopCount++;

  if (SIMPLE_LED_PIN >= 0) {
    digitalWrite(SIMPLE_LED_PIN, loopCount % 2);
  }

  stressCpu(300);
  stressMemoryBlock(internalBlock, INTERNAL_TEST_BYTES, "internal", 0x11110000UL + loopCount);
  stressMemoryBlock(psramBlock, PSRAM_TEST_BYTES, "psram", 0x22220000UL + loopCount);
  stressFlash();

  const uint32_t now = millis();
  if (now - lastStatusMs >= STATUS_INTERVAL_MS) {
    lastStatusMs = now;
    printStatus("loop");
  }
}
