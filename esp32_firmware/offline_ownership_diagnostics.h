#pragma once

#include "offline_embedded_config.h"

#include <stdint.h>

#if ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS

#include <Arduino.h>

extern volatile uint32_t ownershipDiagnosticSensorScanCount;
extern volatile uint32_t ownershipDiagnosticSensorMaxGapMs;
extern volatile uint32_t ownershipDiagnosticSuccessfulHeartbeats;

void beginOfflineOwnershipDiagnostics();
void runOfflineOwnershipNetworkStep(uint32_t nowMs);
void updateOfflineOwnershipDiagnosticLeds(uint32_t nowMs);

inline bool offlineOwnershipDiagnosticsActive() {
  return true;
}

#else

inline void beginOfflineOwnershipDiagnostics() {}
inline void runOfflineOwnershipNetworkStep(uint32_t) {}
inline void updateOfflineOwnershipDiagnosticLeds(uint32_t) {}

inline bool offlineOwnershipDiagnosticsActive() {
  return false;
}

#endif
