#pragma once

#include "offline_embedded_config.h"

#include <stdint.h>

#if ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS

#include <Arduino.h>
#include <OfflineCore.h>

extern volatile uint32_t offlineRuntimeSensorScanCount;
extern volatile uint32_t offlineRuntimeSensorMaxGapMs;
extern volatile uint32_t offlineRuntimeSnapshotRevision;

void beginOfflineRuntimeDiagnostics();
void publishOfflineRuntimeStableSnapshot(
    const bool occupancy[64], uint32_t nowMs);
offline::OwnershipSafety offlineRuntimeOwnershipSafety();

inline bool offlineRuntimeDiagnosticsActive() {
  return true;
}

#else

inline void beginOfflineRuntimeDiagnostics() {}
inline void publishOfflineRuntimeStableSnapshot(const bool[64], uint32_t) {}

inline bool offlineRuntimeDiagnosticsActive() {
  return false;
}

#endif
