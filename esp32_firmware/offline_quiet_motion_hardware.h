#pragma once

#include "offline_embedded_config.h"

#if ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS

#include <Arduino.h>
#include <OfflineCore.h>

enum class OfflineQuietHardwareJobKind {
  None,
  Home,
  Program
};

struct OfflineQuietHardwareResult {
  std::uint32_t requestId = 0;
  OfflineQuietHardwareJobKind kind = OfflineQuietHardwareJobKind::None;
  bool success = false;
  bool homed = false;
  bool motorActivity = false;
  bool magnetEverHigh = false;
  bool magnetLow = true;
  long motorAPosition = 0;
  long motorBPosition = 0;
  long x = 0;
  long y = 0;
  offline::Occupancy observedOccupancy{};
  String error;
};

bool queueOfflineQuietHome(std::uint32_t requestId);
bool queueOfflineQuietProgram(
    std::uint32_t requestId,
    const offline::QuietMotionProgram& program);
bool takeOfflineQuietHardwareResult(
    std::uint32_t requestId,
    OfflineQuietHardwareResult& result);
void abortOfflineQuietMotionHardware();
void serviceOfflineQuietMotionHardware();
bool offlineQuietMotionMagnetAuthorized();

#endif
