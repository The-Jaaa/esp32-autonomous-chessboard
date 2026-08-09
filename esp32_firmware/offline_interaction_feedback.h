#pragma once

#include "offline_embedded_config.h"

#if ENABLE_OFFLINE_PRODUCTION_INTERACTION_DIAGNOSTICS

#include <OfflineCore.h>

enum class OfflineInteractionSensorStage : std::uint8_t {
  Idle = 0,
  Search,
  Travel,
  Pickup,
  Drag,
  Drop,
  Verify,
  Settle
};

void submitOfflineInteractionFrame(
    const offline::LedFrame& frame,
    offline::OfflineFeedbackState state,
    bool deliberateAnimationStep = false);
void serviceOfflineInteractionFrame();
std::uint32_t offlineInteractionMaximumShowUs();
void resetOfflineInteractionSensorTiming();
void setOfflineInteractionSensorStage(OfflineInteractionSensorStage stage);
void recordOfflineInteractionSensorGap(std::uint32_t gapMs);
std::uint32_t offlineInteractionMaximumRecordedSensorGapMs();
OfflineInteractionSensorStage offlineInteractionMaximumSensorGapStage();

#else

inline void serviceOfflineInteractionFrame() {}

#endif
