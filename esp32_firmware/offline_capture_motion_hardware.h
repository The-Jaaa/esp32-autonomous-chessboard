#pragma once

#include "offline_embedded_config.h"
#include "offline_quiet_motion_hardware.h"

#if ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS

#include <Arduino.h>
#include <OfflineCore.h>

using OfflineCaptureHardwareResult = OfflineQuietHardwareResult;

bool queueOfflineCaptureHome(std::uint32_t requestId);
bool queueOfflineCaptureProgram(
    std::uint32_t requestId,
    const offline::CaptureMotionProgram& program);
bool takeOfflineCaptureHardwareResult(
    std::uint32_t requestId,
    OfflineCaptureHardwareResult& result);
void abortOfflineCaptureMotionHardware();
void serviceOfflineCaptureMotionHardware();

#endif
