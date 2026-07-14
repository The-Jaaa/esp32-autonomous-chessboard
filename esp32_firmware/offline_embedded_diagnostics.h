#pragma once

#include "offline_embedded_config.h"

#if ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS

#include <Arduino.h>

extern volatile uint32_t offlineDiagnosticSensorScanCount;
extern volatile uint32_t offlineDiagnosticSensorMaxGapMs;
extern volatile uint32_t offlineDiagnosticSuccessfulPollCount;

void beginOfflineEmbeddedDiagnostics();

inline bool offlineEmbeddedDiagnosticsActive() {
  return true;
}

#else

inline void beginOfflineEmbeddedDiagnostics() {}

inline bool offlineEmbeddedDiagnosticsActive() {
  return false;
}

#endif
