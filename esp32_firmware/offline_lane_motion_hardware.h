#pragma once

#include "offline_embedded_config.h"
#include "offline_quiet_motion_hardware.h"

#if ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS

#include <Arduino.h>
#include <OfflineCore.h>

using OfflineLaneHardwareResult = OfflineQuietHardwareResult;

bool queueOfflineLaneHome(std::uint32_t requestId);
bool queueOfflineLaneProgram(
    std::uint32_t requestId,
    const offline::LaneMotionProgram& program);
bool takeOfflineLaneHardwareResult(
    std::uint32_t requestId,
    OfflineLaneHardwareResult& result);
void abortOfflineLaneMotionHardware();
void serviceOfflineLaneMotionHardware();

#endif
