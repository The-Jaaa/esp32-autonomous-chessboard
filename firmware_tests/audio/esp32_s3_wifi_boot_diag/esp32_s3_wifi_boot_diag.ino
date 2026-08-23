/*
  ESP32-S3 WiFi Boot Diagnostic

  This intentionally does not include Audio.h, LittleFS, I2S, or speaker code.
  It only checks whether WiFi startup itself resets the ESP32-S3.
*/

#include <Arduino.h>
#include <WiFi.h>
#include "esp_system.h"

constexpr uint32_t STARTUP_DELAY_MS = 5000;
constexpr uint32_t STEP_DELAY_MS = 1000;

// Match the known-stable speaker playback setup.
constexpr uint32_t RUN_CPU_MHZ = 160;

HardwareSerial& DebugUart = Serial0;

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
  char line[220];
  snprintf(line, sizeof(line),
           "[STATUS] %s ms=%lu cpu=%lu heapFree=%lu heapMin=%lu psramFound=%s psramFree=%lu wifiStatus=%d",
           label,
           static_cast<unsigned long>(millis()),
           static_cast<unsigned long>(getCpuFrequencyMhz()),
           static_cast<unsigned long>(ESP.getFreeHeap()),
           static_cast<unsigned long>(ESP.getMinFreeHeap()),
           psramFound() ? "yes" : "no",
           static_cast<unsigned long>(ESP.getFreePsram()),
           static_cast<int>(WiFi.status()));
  logLine(line);
}

void setup() {
  if (RUN_CPU_MHZ > 0) {
    setCpuFrequencyMhz(RUN_CPU_MHZ);
  }

  Serial.begin(115200);
  DebugUart.begin(115200);
  delay(STARTUP_DELAY_MS);

  logLine("");
  logLine("ESP32-S3 WiFi boot diagnostic starting.");

  const esp_reset_reason_t reason = esp_reset_reason();
  char resetLine[80];
  snprintf(resetLine, sizeof(resetLine), "Last reset reason: %d (%s)",
           static_cast<int>(reason), resetReasonName(reason));
  logLine(resetLine);
  printStatus("startup");

  logLine("[WIFI-BOOT] persistent(false)");
  WiFi.persistent(false);
  delay(STEP_DELAY_MS);
  printStatus("after persistent");

  logLine("[WIFI-BOOT] mode(WIFI_OFF) begin");
  WiFi.mode(WIFI_OFF);
  delay(STEP_DELAY_MS);
  logLine("[WIFI-BOOT] mode(WIFI_OFF) done");
  printStatus("after wifi off");

  logLine("[WIFI-BOOT] mode(WIFI_STA) begin");
  WiFi.mode(WIFI_STA);
  delay(STEP_DELAY_MS);
  logLine("[WIFI-BOOT] mode(WIFI_STA) done");
  printStatus("after wifi sta");

  logLine("[WIFI-BOOT] setTxPower(2dBm) begin");
  WiFi.setTxPower(WIFI_POWER_2dBm);
  delay(STEP_DELAY_MS);
  char powerLine[80];
  snprintf(powerLine, sizeof(powerLine), "[WIFI-BOOT] txPower=%d", static_cast<int>(WiFi.getTxPower()));
  logLine(powerLine);
  printStatus("after tx power");

  logLine("[WIFI-BOOT] passive scan begin");
  WiFi.scanNetworks(true, true, true, 120);
}

void loop() {
  const int scanResult = WiFi.scanComplete();
  if (scanResult >= 0) {
    char line[80];
    snprintf(line, sizeof(line), "[WIFI] passive scan complete networks=%d", scanResult);
    logLine(line);
    WiFi.scanDelete();
    delay(5000);
    logLine("[WIFI] passive scan restart");
    WiFi.scanNetworks(true, true, true, 120);
  }

  printStatus("loop");
  delay(1000);
}
