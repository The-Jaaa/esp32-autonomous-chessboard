#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
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
constexpr uint32_t kPollIntervalMs = 100;
constexpr uint32_t kWifiRetryIntervalMs = 5000;

Adafruit_NeoPixel strip(kLedCount, kLedPin, NEO_GRB + NEO_KHZ800);
int32_t lastRevision = -1;
uint32_t lastPollMs = 0;
uint32_t lastWifiAttemptMs = 0;

void holdHardwareSafe() {
  digitalWrite(kMagnetPin, LOW);
  for (const uint8_t pin : kMotorPins) digitalWrite(pin, LOW);
}

void renderPixel(int pixelIndex) {
  strip.clear();
  if (pixelIndex >= 0 && pixelIndex < kLedCount) {
    strip.setPixelColor(pixelIndex, strip.Color(255, 255, 255));
  }
  strip.show();
  esp_rom_printf(
      "[LED_INDEX_CAL] {\"type\":\"render\",\"pixelIndex\":%d,"
      "\"pixelNumber\":%d,\"core\":%d}\n",
      pixelIndex,
      pixelIndex >= 0 ? pixelIndex + 1 : 0,
      xPortGetCoreID());
}

void ensureWifi(uint32_t nowMs) {
  if (WiFi.status() == WL_CONNECTED) return;
  if (nowMs - lastWifiAttemptMs < kWifiRetryIntervalMs) return;
  lastWifiAttemptMs = nowMs;
  WiFi.disconnect();
  WiFi.begin(CHESS_WIFI_SSID, CHESS_WIFI_PASSWORD);
  esp_rom_printf("[LED_INDEX_CAL] {\"type\":\"wifi-retry\"}\n");
}

void pollCalibrationState() {
  HTTPClient http;
  http.setConnectTimeout(1000);
  http.setTimeout(1000);
  const String url = String(CHESS_SERVER_BASE_URL) +
      "/api/led-calibration/poll?revision=" + String(lastRevision);
  if (!http.begin(url)) return;
  const int status = http.GET();
  if (status < 200 || status >= 300) {
    http.end();
    return;
  }

  StaticJsonDocument<512> document;
  const DeserializationError error = deserializeJson(document, http.getString());
  http.end();
  if (error || document["success"] != true) return;

  const int32_t revision = document["revision"] | -1;
  const bool changed = document["changed"] | false;
  if (!changed || revision == lastRevision) return;

  const int pixelIndex = document["pixelIndex"] | -1;
  renderPixel(pixelIndex);
  lastRevision = revision;
}

}  // namespace

void setup() {
  pinMode(kMagnetPin, OUTPUT);
  for (const uint8_t pin : kMotorPins) pinMode(pin, OUTPUT);
  holdHardwareSafe();

  Serial.begin(115200);
  strip.begin();
  strip.setBrightness(kBrightness);
  renderPixel(-1);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(CHESS_WIFI_SSID, CHESS_WIFI_PASSWORD);
  esp_rom_printf(
      "[LED_INDEX_CAL] {\"type\":\"start\",\"pixels\":256,"
      "\"motorsLocked\":true,\"magnetLow\":true}\n");
}

void loop() {
  holdHardwareSafe();
  const uint32_t nowMs = millis();
  ensureWifi(nowMs);
  if (WiFi.status() == WL_CONNECTED && nowMs - lastPollMs >= kPollIntervalMs) {
    lastPollMs = nowMs;
    pollCalibrationState();
  }
  delay(5);
}
