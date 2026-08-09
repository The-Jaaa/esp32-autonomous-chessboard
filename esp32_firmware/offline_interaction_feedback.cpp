#include "offline_interaction_feedback.h"

#if ENABLE_OFFLINE_PRODUCTION_INTERACTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CONTINUOUS_GAMEPLAY_DIAGNOSTICS

#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>

#include "offline_diagnostic_serial.h"

extern Adafruit_NeoPixel strip;

namespace {

portMUX_TYPE frameMux = portMUX_INITIALIZER_UNLOCKED;
offline::LedFrame pendingFrame{};
offline::LedFrame displayedFrame{};
bool framePending = false;
bool frameDisplayed = false;
std::uint32_t frameRevision = 0;
std::uint32_t maximumShowUs = 0;
volatile OfflineInteractionSensorStage sensorStage =
    OfflineInteractionSensorStage::Idle;
volatile OfflineInteractionSensorStage maximumSensorGapStage =
    OfflineInteractionSensorStage::Idle;
volatile std::uint32_t maximumRecordedSensorGapMs = 0;

bool framesEqual(const offline::LedFrame& left, const offline::LedFrame& right) {
  for (std::size_t index = 0; index < left.size(); ++index) {
    if (left[index] != right[index]) return false;
  }
  return true;
}

}  // namespace

void submitOfflineInteractionFrame(
    const offline::LedFrame& frame,
    offline::OfflineFeedbackState state,
    bool deliberateAnimationStep) {
  bool submitted = false;
  std::uint32_t submittedRevision = 0;
  portENTER_CRITICAL(&frameMux);
  const offline::LedFrame& comparisonFrame = framePending ? pendingFrame : displayedFrame;
  const bool changed = (!framePending && !frameDisplayed) ||
      !framesEqual(frame, comparisonFrame);
  if (changed || deliberateAnimationStep) {
    pendingFrame = frame;
    framePending = true;
    frameRevision++;
    submitted = true;
    submittedRevision = frameRevision;
  }
  portEXIT_CRITICAL(&frameMux);

  if (submitted) {
    StaticJsonDocument<256> document;
    document["type"] = "feedback-frame";
    document["state"] = offline::offlineFeedbackStateName(state);
    document["revision"] = submittedRevision;
    document["animationStep"] = deliberateAnimationStep;
    String payload;
    serializeJson(document, payload);
    emitOfflineDiagnosticJson(
#if ENABLE_OFFLINE_CONTINUOUS_GAMEPLAY_DIAGNOSTICS
        "OFFLINE_GAME_DIAG",
#else
        "OFFLINE_INTERACTION_DIAG",
#endif
        payload);
  }
}

void serviceOfflineInteractionFrame() {
  offline::LedFrame frame;
  bool ready = false;

  portENTER_CRITICAL(&frameMux);
  if (framePending) {
    frame = pendingFrame;
    framePending = false;
    ready = true;
  }
  portEXIT_CRITICAL(&frameMux);
  if (!ready) return;

  for (std::size_t index = 0; index < frame.size(); ++index) {
    const auto& color = frame[index];
    strip.setPixelColor(index, strip.Color(color.red, color.green, color.blue));
  }
  const std::uint32_t showStartedUs = micros();
  strip.show();
  const std::uint32_t showElapsedUs = micros() - showStartedUs;
  if (showElapsedUs > maximumShowUs) maximumShowUs = showElapsedUs;

  portENTER_CRITICAL(&frameMux);
  displayedFrame = frame;
  frameDisplayed = true;
  portEXIT_CRITICAL(&frameMux);

}

std::uint32_t offlineInteractionMaximumShowUs() {
  return maximumShowUs;
}

void resetOfflineInteractionSensorTiming() {
  maximumRecordedSensorGapMs = 0;
  maximumSensorGapStage = sensorStage;
}

void setOfflineInteractionSensorStage(OfflineInteractionSensorStage stage) {
  sensorStage = stage;
}

void recordOfflineInteractionSensorGap(std::uint32_t gapMs) {
  if (gapMs > maximumRecordedSensorGapMs) {
    maximumRecordedSensorGapMs = gapMs;
    maximumSensorGapStage = sensorStage;
  }
}

std::uint32_t offlineInteractionMaximumRecordedSensorGapMs() {
  return maximumRecordedSensorGapMs;
}

OfflineInteractionSensorStage offlineInteractionMaximumSensorGapStage() {
  return maximumSensorGapStage;
}

#endif
