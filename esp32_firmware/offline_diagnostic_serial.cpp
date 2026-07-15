#include "offline_diagnostic_serial.h"

#if ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS || ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS || \
    ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS

#include <esp_rom_sys.h>

namespace {

SemaphoreHandle_t diagnosticSerialMutex = nullptr;

}  // namespace

void beginOfflineDiagnosticSerial() {
  if (diagnosticSerialMutex == nullptr) {
    diagnosticSerialMutex = xSemaphoreCreateMutex();
  }
}

void emitOfflineDiagnosticJson(const char* prefix, const String& payload) {
  if (diagnosticSerialMutex == nullptr) {
    esp_rom_printf("[%s] %s\n", prefix, payload.c_str());
    return;
  }

  if (xSemaphoreTake(diagnosticSerialMutex, portMAX_DELAY) != pdTRUE) return;
  esp_rom_printf("[%s] %s\n", prefix, payload.c_str());
  xSemaphoreGive(diagnosticSerialMutex);
}

#endif
