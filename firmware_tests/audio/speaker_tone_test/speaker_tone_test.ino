/*
  ESP32-S3 MAX98357A Tone Test

  Purpose:
    Prove the speaker hardware and I2S pins work before testing MP3/filesystem.

  Upload flow:
    1. Upload this sketch only. No data folder upload needed.
    2. Unplug USB from the PC.
    3. Power the PCB/ESP32 from the external supply.
    4. Wait 5 seconds.
    5. Listen for repeating test tones.

  Rewired safe I2S pins:
    MAX98357A DIN  -> GPIO11
    MAX98357A BCLK -> GPIO10
    MAX98357A LRC  -> GPIO9
*/

#include <Arduino.h>
#include "ESP_I2S.h"
#include <math.h>

constexpr uint8_t I2S_DOUT_PIN = 11;  // MAX98357A DIN
constexpr uint8_t I2S_BCLK_PIN = 10;  // MAX98357A BCLK
constexpr uint8_t I2S_LRC_PIN  = 9;   // MAX98357A LRC / LRCLK
constexpr uint8_t MAGNET_PIN   = 38;  // Keep electromagnet off during audio test

constexpr uint32_t STARTUP_DELAY_MS = 5000;
constexpr uint32_t SAMPLE_RATE = 44100;
constexpr uint16_t FRAME_COUNT = 256;
constexpr int16_t TONE_AMPLITUDE = 7000;  // 32767 max. Keep modest for first test.

I2SClass i2s;

void writeSilence(uint32_t durationMs) {
  int16_t frames[FRAME_COUNT * 2] = {0};
  const uint32_t totalFrames = (SAMPLE_RATE * durationMs) / 1000;
  uint32_t framesWritten = 0;

  while (framesWritten < totalFrames) {
    const uint32_t framesThisChunk = min<uint32_t>(FRAME_COUNT, totalFrames - framesWritten);
    i2s.write(reinterpret_cast<uint8_t*>(frames), framesThisChunk * 2 * sizeof(int16_t));
    framesWritten += framesThisChunk;
    yield();
  }
}

void playTone(float frequencyHz, uint32_t durationMs) {
  int16_t frames[FRAME_COUNT * 2];
  const uint32_t totalFrames = (SAMPLE_RATE * durationMs) / 1000;
  const float phaseStep = (2.0f * PI * frequencyHz) / static_cast<float>(SAMPLE_RATE);
  float phase = 0.0f;
  uint32_t framesWritten = 0;

  while (framesWritten < totalFrames) {
    const uint32_t framesThisChunk = min<uint32_t>(FRAME_COUNT, totalFrames - framesWritten);

    for (uint32_t i = 0; i < framesThisChunk; i++) {
      const int16_t sample = static_cast<int16_t>(sinf(phase) * TONE_AMPLITUDE);
      phase += phaseStep;
      if (phase >= 2.0f * PI) {
        phase -= 2.0f * PI;
      }

      // Duplicate the same mono sample into both I2S channels.
      frames[i * 2] = sample;
      frames[(i * 2) + 1] = sample;
    }

    i2s.write(reinterpret_cast<uint8_t*>(frames), framesThisChunk * 2 * sizeof(int16_t));
    framesWritten += framesThisChunk;
    yield();
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(MAGNET_PIN, OUTPUT);
  digitalWrite(MAGNET_PIN, LOW);

  delay(STARTUP_DELAY_MS);

  Serial.println();
  Serial.println(F("ESP32-S3 MAX98357A tone test starting."));
  Serial.println(F("I2S pins: DIN=11, BCLK=10, LRC=9"));

  i2s.setPins(I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN);

  if (!i2s.begin(I2S_MODE_STD, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) {
    Serial.println(F("I2S init failed."));
    while (true) {
      delay(1000);
    }
  }

  Serial.println(F("I2S init OK. Playing tones."));
}

void loop() {
  // Mono pattern: same audio is sent to both I2S channels.
  playTone(440.0f, 1000);
  writeSilence(500);
  playTone(660.0f, 1000);
  writeSilence(500);
  playTone(880.0f, 1000);
  writeSilence(500);
  playTone(1000.0f, 1500);
  writeSilence(2000);
}
