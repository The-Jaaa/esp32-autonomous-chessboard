/*
  ESP32-S3 LittleFS Read Diagnostic

  Purpose:
    Mount the same LittleFS partition used by speaker_test, read /test.mp3 in a
    loop, and print progress without starting I2S or powering audio output.

  If this runs without reset, the MP3 file/filesystem/PSRAM path is stable and
  the brownout is likely caused by amplifier/speaker power draw.
*/

#include <Arduino.h>
#include "FS.h"
#include "LittleFS.h"
#include "esp_system.h"

HardwareSerial& DebugUart = Serial0;

constexpr const char* AUDIO_PATH = "/test.mp3";
constexpr size_t READ_CHUNK = 4096;

void logLine(const char* line) {
  Serial.println(line);
  DebugUart.println(line);
}

void logBlankLine() {
  Serial.println();
  DebugUart.println();
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

void printMemory(const char* label) {
  char line[180];
  snprintf(line, sizeof(line),
           "[MEM] %s freeHeap=%lu minHeap=%lu psramFound=%s freePsram=%lu",
           label,
           static_cast<unsigned long>(ESP.getFreeHeap()),
           static_cast<unsigned long>(ESP.getMinFreeHeap()),
           psramFound() ? "yes" : "no",
           static_cast<unsigned long>(ESP.getFreePsram()));
  logLine(line);
}

void setup() {
  Serial.begin(115200);
  DebugUart.begin(115200);
  delay(1000);

  logBlankLine();
  logLine("ESP32-S3 LittleFS read diagnostic starting.");
  const esp_reset_reason_t reason = esp_reset_reason();
  char resetLine[80];
  snprintf(resetLine, sizeof(resetLine), "Last reset reason: %d (%s)",
           static_cast<int>(reason), resetReasonName(reason));
  logLine(resetLine);
  printMemory("startup");

  if (!LittleFS.begin(false)) {
    logLine("LittleFS mount failed.");
    while (true) delay(1000);
  }

  char fsLine[80];
  snprintf(fsLine, sizeof(fsLine), "LittleFS total bytes: %lu",
           static_cast<unsigned long>(LittleFS.totalBytes()));
  logLine(fsLine);
  snprintf(fsLine, sizeof(fsLine), "LittleFS used bytes: %lu",
           static_cast<unsigned long>(LittleFS.usedBytes()));
  logLine(fsLine);
}

void loop() {
  File file = LittleFS.open(AUDIO_PATH, FILE_READ);
  if (!file) {
    logLine("ERROR: /test.mp3 not found.");
    delay(2000);
    return;
  }

  const size_t fileSize = file.size();
  uint8_t buffer[READ_CHUNK];
  size_t totalRead = 0;
  uint32_t lastReport = millis();

  char startLine[90];
  snprintf(startLine, sizeof(startLine), "Reading %s, bytes=%lu",
           AUDIO_PATH, static_cast<unsigned long>(fileSize));
  logLine(startLine);

  while (file.available()) {
    const size_t n = file.read(buffer, sizeof(buffer));
    totalRead += n;

    const uint32_t now = millis();
    if (now - lastReport >= 1000) {
      lastReport = now;
      char line[140];
      snprintf(line, sizeof(line),
               "[READ] pos=%lu/%lu freeHeap=%lu freePsram=%lu",
               static_cast<unsigned long>(totalRead),
               static_cast<unsigned long>(fileSize),
               static_cast<unsigned long>(ESP.getFreeHeap()),
               static_cast<unsigned long>(ESP.getFreePsram()));
      logLine(line);
    }

    delay(1);
  }

  file.close();
  char doneLine[80];
  snprintf(doneLine, sizeof(doneLine), "Read complete, bytes=%lu",
           static_cast<unsigned long>(totalRead));
  logLine(doneLine);
  printMemory("after read");
  delay(1500);
}
