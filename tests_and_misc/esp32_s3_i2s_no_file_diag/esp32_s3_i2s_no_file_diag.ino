/*
  ESP32-S3 I2S No-File Diagnostic

  Purpose:
    Start I2S on the project speaker pins and generate a low-level tone without
    using LittleFS, MP3 decoding, or ESP32-audioI2S.

  Test with the amp disconnected first. If this is stable, the brownout/reset is
  coming from the MP3/audio-library path rather than the I2S pins themselves.
*/

#include <Arduino.h>
#include "ESP_I2S.h"
#include "esp_system.h"
#include <math.h>

constexpr uint8_t I2S_DOUT_PIN = 11;
constexpr uint8_t I2S_BCLK_PIN = 10;
constexpr uint8_t I2S_LRC_PIN  = 9;

constexpr uint32_t SAMPLE_RATE = 44100;
constexpr uint16_t FRAME_COUNT = 256;
constexpr int16_t TONE_AMPLITUDE = 2000;

I2SClass i2s;
HardwareSerial& DebugUart = Serial0;

const char* resetReasonName(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_EXT: return "EXTERNAL_RESET";
    case ESP_RST_SW: return "SOFTWARE_RESET";
    case ESP_RST_PANIC: return "PANIC_EXCEPTION";
    case ESP_RST_INT_WDT: return "INTERRUPT_WATCHDOG";
    case ESP_RST_TASK_WDT: return "TASK_WATCHDOG";
    case ESP_RST_WDT: return "OTHER_WATCHDOG";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_SDIO: return "SDIO";
    default: return "UNKNOWN";
  }
}

void logLine(const char* line) {
  Serial.println(line);
  DebugUart.println(line);
}

void printStatus(const char* label) {
  char line[180];
  snprintf(line, sizeof(line),
           "[STATUS] %s ms=%lu heapFree=%lu heapMin=%lu psramFound=%s psramFree=%lu",
           label,
           static_cast<unsigned long>(millis()),
           static_cast<unsigned long>(ESP.getFreeHeap()),
           static_cast<unsigned long>(ESP.getMinFreeHeap()),
           psramFound() ? "yes" : "no",
           static_cast<unsigned long>(ESP.getFreePsram()));
  logLine(line);
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
      if (phase >= 2.0f * PI) phase -= 2.0f * PI;

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
  DebugUart.begin(115200);
  delay(1000);

  Serial.println();
  DebugUart.println();
  logLine("ESP32-S3 I2S no-file diagnostic starting.");
  logLine("I2S pins: DIN=11, BCLK=10, LRC=9");

  const esp_reset_reason_t reason = esp_reset_reason();
  char resetLine[80];
  snprintf(resetLine, sizeof(resetLine), "Last reset reason: %d (%s)",
           static_cast<int>(reason), resetReasonName(reason));
  logLine(resetLine);
  printStatus("before i2s");

  i2s.setPins(I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN);
  if (!i2s.begin(I2S_MODE_STD, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT,
                 I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) {
    logLine("I2S init failed.");
    while (true) delay(1000);
  }

  printStatus("after i2s init");
  logLine("I2S init OK. Generating low-level tone.");
}

void loop() {
  printStatus("before tone");
  playTone(440.0f, 1000);
  printStatus("after tone");
  delay(1000);
}
