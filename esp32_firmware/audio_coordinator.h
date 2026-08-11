#pragma once

#include <Arduino.h>

#include "mentor_speaker.h"

struct BoardAudioCoordinatorConfig {
  MentorSpeakerConfig mentor;
  const char* token = nullptr;
  uint8_t bclkPin = 10;
  uint8_t lrclkPin = 9;
  uint8_t dataPin = 11;
  uint8_t relayVolume = 20;
};

bool beginBoardAudioCoordinator(const BoardAudioCoordinatorConfig& config);
void applyBoardAudioDesiredState(const char* mode, const char* streamUrl, uint32_t revision);
const char* boardAudioMode();
const char* boardAudioState();
const char* boardAudioLastError();
uint32_t boardAudioRetries();
uint32_t boardAudioRevision();
uint32_t boardAudioStatusSequence();
