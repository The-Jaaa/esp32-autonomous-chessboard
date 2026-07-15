#pragma once

#include "offline_embedded_config.h"

#include <stdint.h>

#if ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS || ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || \
    ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS

#include <Arduino.h>
#include <OfflineCore.h>

extern volatile uint32_t ownershipDiagnosticSensorScanCount;
extern volatile uint32_t ownershipDiagnosticSensorMaxGapMs;
extern volatile uint32_t ownershipDiagnosticSuccessfulHeartbeats;
extern volatile uint32_t ownershipDiagnosticHeartbeatAttempts;
extern volatile uint32_t ownershipDiagnosticHeartbeatMaxElapsedMs;

struct OfflineOwnershipDiagnosticSnapshot {
  offline::OwnershipState state = offline::OwnershipState::BootProbe;
  offline::OwnershipEvent event = offline::OwnershipEvent::None;
  bool allowOfflineControl = false;
  bool handoffRequired = false;
  bool valid = false;
};

void beginOfflineOwnershipDiagnostics();
void runOfflineOwnershipNetworkStep(uint32_t nowMs);
void updateOfflineOwnershipDiagnosticLeds(uint32_t nowMs);
bool copyOfflineOwnershipDiagnosticSnapshot(
    OfflineOwnershipDiagnosticSnapshot& snapshot);

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
