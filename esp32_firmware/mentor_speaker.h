#pragma once

#include <Arduino.h>

struct MentorSpeakerConfig {
  const char* host = nullptr;
  uint16_t port = 3001;
  const char* boardId = "main-board";
  const char* token = nullptr;
  uint8_t bclkPin = 10;
  uint8_t lrclkPin = 9;
  uint8_t dataPin = 11;
};

bool beginMentorSpeaker(const MentorSpeakerConfig& config);
void endMentorSpeaker();
bool mentorSpeakerAvailable();
bool mentorSpeakerConnected();
bool mentorSpeakerPlaying();
uint32_t mentorSpeakerUnderruns();
uint32_t mentorSpeakerBufferedMs();
void mentorSpeakerRecordSensorScan(uint32_t nowMs);
