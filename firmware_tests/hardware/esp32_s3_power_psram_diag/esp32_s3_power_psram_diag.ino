/*
  ESP32-S3 USB/PSRAM Power Diagnostic

  Purpose:
    Run the ESP32-S3 by itself, disconnected from the chessboard PCB, and verify
    whether USB power plus the selected Arduino board settings are stable.

  Suggested Arduino IDE settings:
    Board: ESP32S3 Dev Module
    Flash Size: 16MB
    PSRAM: OPI PSRAM
    USB CDC On Boot: Enabled
    Partition Scheme: any 16MB/default scheme is fine
*/

#include <Arduino.h>
#include "esp_system.h"

HardwareSerial& DebugUart = Serial0;

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
           "[STATUS] %s ms=%lu freeHeap=%lu minHeap=%lu maxAllocHeap=%lu psramFound=%s psramSize=%lu freePsram=%lu maxAllocPsram=%lu",
           label,
           static_cast<unsigned long>(millis()),
           static_cast<unsigned long>(ESP.getFreeHeap()),
           static_cast<unsigned long>(ESP.getMinFreeHeap()),
           static_cast<unsigned long>(ESP.getMaxAllocHeap()),
           psramFound() ? "yes" : "no",
           static_cast<unsigned long>(ESP.getPsramSize()),
           static_cast<unsigned long>(ESP.getFreePsram()),
           static_cast<unsigned long>(ESP.getMaxAllocPsram()));
  Serial.println(line);
  DebugUart.println(line);
}

void setup() {
  Serial.begin(115200);
  DebugUart.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println(F("ESP32-S3 USB/PSRAM power diagnostic starting."));
  DebugUart.println();
  DebugUart.println(F("ESP32-S3 USB/PSRAM power diagnostic starting."));

  const esp_reset_reason_t reason = esp_reset_reason();
  char line[80];
  snprintf(line, sizeof(line), "Last reset reason: %d (%s)", static_cast<int>(reason), resetReasonName(reason));
  Serial.println(line);
  DebugUart.println(line);

  printStatus("startup");
}

void loop() {
  printStatus("loop");
  delay(1000);
}
