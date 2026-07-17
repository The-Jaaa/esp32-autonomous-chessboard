#include <Adafruit_NeoPixel.h>
#include <WiFi.h>
#include <esp_rom_sys.h>

#if __has_include("../../esp32_firmware/firmware_secrets.h")
#include "../../esp32_firmware/firmware_secrets.h"
#else
#include "../../esp32_firmware/firmware_secrets.example.h"
#endif

namespace {

constexpr uint8_t kLedPin = 8;
constexpr uint16_t kLedCount = 256;
constexpr uint8_t kBrightness = 40;
constexpr uint8_t kMagnetPin = 38;
constexpr uint8_t kMotorPins[] = {39, 40, 41, 42};
constexpr uint32_t kPhaseDurationMs = 30000;
constexpr uint32_t kRefreshMs = 100;
constexpr uint32_t kPhaseGapMs = 2000;

Adafruit_NeoPixel strip(kLedCount, kLedPin, NEO_GRB + NEO_KHZ800);

struct PhaseOptions {
  const char* id;
};

PhaseOptions core0Phase{};
volatile bool core0WriterFinished = false;

void setSquareColor(int square, uint8_t red, uint8_t green, uint8_t blue) {
  const int firstPixel = square * 4;
  for (int pixel = 0; pixel < 4; ++pixel) {
    strip.setPixelColor(firstPixel + pixel, strip.Color(red, green, blue));
  }
}

void renderDensePattern() {
  strip.clear();
  for (int square = 0; square < 64; ++square) {
    const int rank = square / 8;
    const int file = square % 8;
    if (((rank + file) % 2) == 0) {
      setSquareColor(square, 0, 90, 255);
    } else {
      setSquareColor(square, 255, 120, 0);
    }
  }
}

void clearLeds() {
  strip.clear();
  strip.show();
}

void emitPhase(const char* type, const PhaseOptions& options, uint32_t showCount) {
  esp_rom_printf(
      "[LED_CORE_COMPARE] {\"type\":\"%s\",\"id\":\"%s\","
      "\"core\":%d,\"wifi\":\"%s\",\"refreshMs\":%lu,"
      "\"durationMs\":%lu,\"showCount\":%lu}\n",
      type,
      options.id,
      xPortGetCoreID(),
      WiFi.status() == WL_CONNECTED ? "connected" : "disconnected",
      static_cast<unsigned long>(kRefreshMs),
      static_cast<unsigned long>(kPhaseDurationMs),
      static_cast<unsigned long>(showCount));
}

uint32_t runPhase(const PhaseOptions& options) {
  emitPhase("phase-start", options, 0);
  esp_rom_printf(
      "[LED_CORE_COMPARE] Bend the data wire gently and consistently now. "
      "Every square must remain in the blue/orange checkerboard.\n");

  const uint32_t startedAt = millis();
  uint32_t lastShowAt = 0;
  uint32_t showCount = 0;
  bool firstFrame = true;
  while (millis() - startedAt < kPhaseDurationMs) {
    const uint32_t elapsed = millis() - startedAt;
    if (firstFrame || elapsed - lastShowAt >= kRefreshMs) {
      renderDensePattern();
      strip.show();
      showCount++;
      lastShowAt = elapsed;
      firstFrame = false;
    }
    delay(2);
  }

  emitPhase("phase-end", options, showCount);
  return showCount;
}

void phaseGap() {
  clearLeds();
  esp_rom_printf("[LED_CORE_COMPARE] {\"type\":\"phase-gap\"}\n");
  delay(kPhaseGapMs);
}

void core0LedWriter(void*) {
  static_cast<void>(runPhase(core0Phase));
  core0WriterFinished = true;
  vTaskDelete(nullptr);
}

void runCore1Phase(const PhaseOptions& options) {
  static_cast<void>(runPhase(options));
  phaseGap();
}

bool runCore0Phase(const PhaseOptions& options) {
  core0Phase = options;
  core0WriterFinished = false;
  const BaseType_t created = xTaskCreatePinnedToCore(
      core0LedWriter,
      "ledCore0",
      4096,
      nullptr,
      1,
      nullptr,
      0);
  if (created != pdPASS) {
    esp_rom_printf(
        "[LED_CORE_COMPARE] {\"type\":\"error\","
        "\"message\":\"core0-task-create-failed\"}\n");
    return false;
  }
  while (!core0WriterFinished) delay(10);
  phaseGap();
  return true;
}

bool safetyOutputsLow() {
  if (digitalRead(kMagnetPin) != LOW) return false;
  for (const uint8_t pin : kMotorPins) {
    if (digitalRead(pin) != LOW) return false;
  }
  return true;
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(CHESS_WIFI_SSID, CHESS_WIFI_PASSWORD);
  const uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 15000U) {
    delay(100);
  }
}

}  // namespace

void setup() {
  pinMode(kMagnetPin, OUTPUT);
  digitalWrite(kMagnetPin, LOW);
  for (const uint8_t pin : kMotorPins) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  }

  Serial.begin(115200);
  strip.begin();
  strip.setBrightness(kBrightness);
  clearLeds();

  // Allow the host serial monitor to reconnect after flashing.
  delay(3000);
  connectWifi();

  esp_rom_printf(
      "[LED_CORE_COMPARE] {\"type\":\"start\",\"pattern\":\"dense-checkerboard\","
      "\"litSquares\":64,\"litPixels\":256,\"durationMs\":30000,"
      "\"refreshMs\":100,\"motorsLocked\":true,\"magnetLow\":true}\n");

  runCore1Phase({"dense-core1-round1"});
  if (!runCore0Phase({"dense-core0-round1"})) return;
  if (!runCore0Phase({"dense-core0-round2"})) return;
  runCore1Phase({"dense-core1-round2"});

  clearLeds();
  esp_rom_printf(
      "[LED_CORE_COMPARE] {\"type\":\"summary\",\"pass\":true,"
      "\"visualResultRequired\":true,\"safetyOutputsLow\":%s}\n",
      safetyOutputsLow() ? "true" : "false");
}

void loop() {
  digitalWrite(kMagnetPin, LOW);
  for (const uint8_t pin : kMotorPins) digitalWrite(pin, LOW);
  delay(20);
}
