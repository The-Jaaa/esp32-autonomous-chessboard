#pragma once
#include "music_spectrum.h"

// Network task writes a latest-value mailbox; only ledTask touches the LEDs.
struct ExhibitionState {
  char server[40] = "";
  uint32_t revision = 0;
  bool enabled = false;
  bool concurrentMotion = false;
  bool recovery = false;
  bool recoverySquares[64] = {};
  uint8_t pattern = 0;
  uint8_t brightness = 100;
  uint32_t period = 6000;
};
ExhibitionState exhibitionDesired, exhibitionApplied, exhibitionRendering;
bool exhibitionDirty = false;
bool boardLedTaskReady = false;
bool ledCommandBusy = false;
bool exhibitionMotionBusy = false;
SpectrumDisplay exhibitionSpectrum;
uint32_t exhibitionSpectrumGeneration = UINT32_MAX;
uint32_t exhibitionStarted = 0, exhibitionFrame = 0;

void receiveExhibition(JsonObject value) {
  if (value.isNull()) return;
  ExhibitionState next;
  strlcpy(next.server, value["serverInstanceId"] | "", sizeof(next.server));
  next.revision = value["revision"] | 0;
  next.enabled = value["enabled"] | false;
  next.concurrentMotion = value["concurrentMotion"] | false;
  next.recovery = value["recovery"] | false;
  for(JsonVariant item : value["recoverySquares"].as<JsonArray>()) {
    const int i=item.as<int>(); if(i>=0 && i<64) next.recoverySquares[i]=true;
  }
  next.brightness = constrain(value["brightnessPercent"] | 100, 10, 100);
  const char* pattern = value["pattern"] | "auto";
  next.pattern = strcmp(pattern, "wave") == 0 ? 1 : strcmp(pattern, "chessboard") == 0 ? 2
    : strcmp(pattern, "sweep") == 0 ? 3 : strcmp(pattern, "breathing") == 0 ? 4 : strcmp(pattern, "music") == 0 ? 5 : 0;
  const char* speed = value["speed"] | "normal";
  next.period = strcmp(speed, "slow") == 0 ? 10000 : strcmp(speed, "fast") == 0 ? 3000 : 6000;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    if (!next.concurrentMotion && !exhibitionMotionBusy && !hasPendingMotionCommand) {
      autonomousRunId[0] = 0;
      autonomousRestoring = autonomousTakeover = autonomousInterference = false;
    }
    if(next.recovery && !exhibitionMotionBusy && !hasPendingMotionCommand) {
      for(JsonVariant item : value["recoveryProtected"].as<JsonArray>()) {
        const int i=item.as<int>(); if(i>=0 && i<64) autonomousProtected[i]=true;
      }
    }
    if (strcmp(next.server, exhibitionDesired.server) != 0 || next.revision > exhibitionDesired.revision
      || next.concurrentMotion != exhibitionDesired.concurrentMotion || next.recovery != exhibitionDesired.recovery
      || memcmp(next.recoverySquares, exhibitionDesired.recoverySquares, sizeof(next.recoverySquares)) != 0) {
      exhibitionDesired = next;
      exhibitionDirty = true;
    }
    xSemaphoreGive(sharedMutex);
  }
}

void stopExhibitionRendering() {
  if (!exhibitionRendering.enabled) return;
  exhibitionRendering.enabled = false;
  setMusicSpectrumEnabled(false);
  exhibitionSpectrum.reset(millis());
  strip.clear();
  strip.show();
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    exhibitionApplied.enabled = false;
    xSemaphoreGive(sharedMutex);
  }
  markSnapshotDirty();
}

void serviceExhibition() {
  ExhibitionState next;
  bool apply = false;
  if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    if (exhibitionDirty && (!exhibitionDesired.enabled
      || exhibitionDesired.concurrentMotion || (!exhibitionMotionBusy && !hasPendingMotionCommand && digitalRead(MAGNET_PIN) == LOW))) {
      next = exhibitionDesired;
      exhibitionDirty = false;
      apply = true;
    }
    xSemaphoreGive(sharedMutex);
  }
  if (apply) {
    stopExhibitionRendering();
    if (!next.enabled && (exhibitionRendering.recovery || next.concurrentMotion)) { strip.clear(); strip.show(); }
    exhibitionRendering = next;
    setMusicSpectrumEnabled(next.enabled && next.pattern == 5);
    if (next.enabled || next.concurrentMotion) {
      activeLedAnimation = LED_ANIM_NONE;
      promotionLedDisplay = PromotionLedDisplay{};
      // Drop obsolete celebration/calibration frames before exhibition ownership.
      if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        pendingLedCommandHead = pendingLedCommandTail = pendingLedCommandCount = 0;
        xSemaphoreGive(sharedMutex);
      }
    }
    exhibitionStarted = millis();
    exhibitionFrame = 0;
    if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
      exhibitionApplied = next;
      xSemaphoreGive(sharedMutex);
    }
    markSnapshotDirty();
  }
  if (exhibitionMotionBusy && !exhibitionRendering.concurrentMotion) stopExhibitionRendering();
  const uint32_t now = millis();
  if ((!exhibitionRendering.enabled && !exhibitionRendering.recovery) || now - exhibitionFrame < 50) return;
  exhibitionFrame = now;
  const uint32_t elapsed = now - exhibitionStarted;
  const uint8_t pattern = exhibitionRendering.pattern ? exhibitionRendering.pattern : 1 + (elapsed / 30000) % 4;
  const float phase = float(elapsed % exhibitionRendering.period) / exhibitionRendering.period;
  const float pulse = 0.15f + 0.85f * (0.5f - 0.5f * cosf(phase * 6.2831853f));
  SpectrumFrame spectrumFrame;
  uint32_t spectrumGeneration;
  const bool spectrumReady = takeMusicSpectrum(now, spectrumFrame, spectrumGeneration);
  if (spectrumGeneration != exhibitionSpectrumGeneration) {
    exhibitionSpectrum.reset(now);
    exhibitionSpectrumGeneration = spectrumGeneration;
  }
  exhibitionSpectrum.update(now, spectrumReady ? &spectrumFrame : nullptr);
  for (int index = 0; index < 64; index++) {
    // Raw squares snake H8..H1,G1..G8,...,A1..A8.
    const int file = 7 - index / 8;
    const int rank = (index / 8) % 2 == 0 ? 7 - index % 8 : index % 8;
    uint32_t color;
    float intensity = 1.0f;
    if (pattern == 5) {
      static constexpr uint8_t spectrumColours[8][3] = {
        {30, 70, 255}, {0, 180, 255}, {40, 255, 80}, {255, 230, 0},
        {255, 160, 0}, {255, 20, 0}, {255, 40, 180}, {150, 40, 255}
      };
      color = strip.Color(spectrumColours[rank][0], spectrumColours[rank][1], spectrumColours[rank][2]);
      intensity = constrain(exhibitionSpectrum.heights[file] - rank, 0.0f, 1.0f);
    } else if (pattern == 1) color = colorWheel(uint8_t(int(phase * 255) + file * 20 + rank * 8));
    else if (pattern == 2) {
      color = (file + rank) % 2 ? strip.Color(15, 110, 255) : strip.Color(255, 100, 15);
      intensity = (file + rank) % 2 ? pulse : 1.15f - pulse;
    } else if (pattern == 3) {
      color = colorWheel(uint8_t(phase * 255));
      intensity = max(0.0f, 1.0f - fabsf(float(file) - (phase * 12 - 2)) / 2.0f);
    } else { color = strip.Color(100, 40, 255); intensity = pulse; }
    if (exhibitionRendering.recovery) { color = strip.Color(255, 170, 0); intensity = exhibitionRendering.recoverySquares[index] ? pulse : 0.0f; }
    const float scale = intensity * exhibitionRendering.brightness / 100.0f;
    setSquareColor(index, uint8_t(((color >> 16) & 255) * scale),
      uint8_t(((color >> 8) & 255) * scale), uint8_t((color & 255) * scale));
  }
  strip.show();
}

bool waitForMotionLeds() {
  const uint32_t started = millis();
  while (millis() - started < 20000) {
    bool pending = true;
    if (xSemaphoreTake(sharedMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
      pending = ledCommandBusy || pendingLedCommandCount > 0;
      xSemaphoreGive(sharedMutex);
    }
    if (!pending) return true;
    scanSensors();
    delay(2);
  }
  return false;
}

void queueMotionLed(JsonObject step, const char* mode) {
  if (exhibitionDesired.concurrentMotion) return;
  StaticJsonDocument<4096> copy;
  copy.set(step);
  copy["mode"] = mode;
  if (enqueueLedCommand(copy.as<JsonObject>())) waitForMotionLeds();
}

void ledTask(void*) {
  for (;;) {
    serviceExhibition();
    if (!exhibitionRendering.concurrentMotion) {
      serviceLedCommandQueue();
      servicePromotionLedDisplay(millis());
      updateLedAnimation();
    }
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}
