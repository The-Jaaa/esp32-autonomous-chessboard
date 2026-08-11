/*
  ESP32-S3 MAX98357A WiFi Streaming Speaker Test

  Streams MP3 directly over WiFi from a local HTTP server.
  This does not use LittleFS/SPIFFS for the audio file.

  I2S wiring:
    MAX98357A DIN  -> GPIO11
    MAX98357A BCLK -> GPIO10
    MAX98357A LRC  -> GPIO9
*/

#include <Arduino.h>
#include <WiFi.h>
#include "Audio.h"
#include "esp_system.h"

#if __has_include("wifi_stream_secrets.h")
#include "wifi_stream_secrets.h"
#else
#include "wifi_stream_secrets.example.h"
#endif

constexpr uint8_t I2S_DOUT_PIN = 11;
constexpr uint8_t I2S_BCLK_PIN = 10;
constexpr uint8_t I2S_LRC_PIN = 9;

constexpr uint32_t RUN_CPU_MHZ = 240;
constexpr uint8_t START_VOLUME = 20;
constexpr uint32_t STARTUP_DELAY_MS = 5000;
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 20000;
constexpr uint32_t STATUS_INTERVAL_MS = 1000;
constexpr uint32_t WIFI_STATUS_INTERVAL_MS = 5000;
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 5000;
constexpr uint32_t RESTART_DELAY_MS = 2000;

const char* WIFI_SSID = STREAM_WIFI_SSID;
const char* WIFI_PASSWORD = STREAM_WIFI_PASSWORD;
const char* STREAM_URL = SPOTIFY_STREAM_URL;
const char* STREAM_TOKEN = SPOTIFY_STREAM_TOKEN;

Audio audio;
HardwareSerial& DebugUart = Serial0;

uint32_t lastStatusMs = 0;
uint32_t lastWifiStatusMs = 0;
uint32_t streamRestartAtMs = 0;
uint32_t nextWifiRetryAtMs = 0;
bool streamStarted = false;

void logLine(const char* line) {
  Serial.println(line);
  DebugUart.println(line);
  Serial.flush();
  DebugUart.flush();
}

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

void printMemoryStatus(const char* label) {
  char line[240];
  snprintf(line, sizeof(line),
           "[MEM] %s heapFree=%lu heapMin=%lu heapMaxAlloc=%lu psramSize=%lu psramFree=%lu psramMaxAlloc=%lu",
           label,
           static_cast<unsigned long>(ESP.getFreeHeap()),
           static_cast<unsigned long>(ESP.getMinFreeHeap()),
           static_cast<unsigned long>(ESP.getMaxAllocHeap()),
           static_cast<unsigned long>(ESP.getPsramSize()),
           static_cast<unsigned long>(ESP.getFreePsram()),
           static_cast<unsigned long>(ESP.getMaxAllocPsram()));
  logLine(line);
}

void my_audio_info(Audio::msg_t m) {
  Serial.printf("%s: %s\n", m.s, m.msg);
  DebugUart.printf("%s: %s\n", m.s, m.msg);
}

void printPlaybackStatus() {
  const uint32_t now = millis();
  if (now - lastStatusMs < STATUS_INTERVAL_MS) return;
  lastStatusMs = now;

  char line[260];
  snprintf(line, sizeof(line),
           "[STREAM] ms=%lu running=%s time=%lu/%lus fileSize=%lu bitrate=%lu sampleRate=%lu channels=%u inBuf=%u/%u heapFree=%lu psramFree=%lu",
           static_cast<unsigned long>(now),
           audio.isRunning() ? "yes" : "no",
           static_cast<unsigned long>(audio.getAudioCurrentTime()),
           static_cast<unsigned long>(audio.getAudioFileDuration()),
           static_cast<unsigned long>(audio.getFileSize()),
           static_cast<unsigned long>(audio.getBitRate()),
           static_cast<unsigned long>(audio.getSampleRate()),
           static_cast<unsigned int>(audio.getChannels()),
           static_cast<unsigned int>(audio.inBufferFilled()),
           static_cast<unsigned int>(audio.inBufferFree()),
           static_cast<unsigned long>(ESP.getFreeHeap()),
           static_cast<unsigned long>(ESP.getFreePsram()));
  logLine(line);
}

void printWifiStatus() {
  const uint32_t now = millis();
  if (now - lastWifiStatusMs < WIFI_STATUS_INTERVAL_MS) return;
  lastWifiStatusMs = now;

  char line[180];
  if (WiFi.status() == WL_CONNECTED) {
    IPAddress ip = WiFi.localIP();
    snprintf(line, sizeof(line),
             "[WIFI] connected rssi=%ld ip=%u.%u.%u.%u heapFree=%lu psramFree=%lu",
             static_cast<long>(WiFi.RSSI()),
             ip[0], ip[1], ip[2], ip[3],
             static_cast<unsigned long>(ESP.getFreeHeap()),
             static_cast<unsigned long>(ESP.getFreePsram()));
  } else {
    snprintf(line, sizeof(line),
             "[WIFI] disconnected status=%d heapFree=%lu psramFree=%lu",
             static_cast<int>(WiFi.status()),
             static_cast<unsigned long>(ESP.getFreeHeap()),
             static_cast<unsigned long>(ESP.getFreePsram()));
  }
  logLine(line);
}

bool connectWifi() {
  logLine("[WIFI] persistent(false)");
  WiFi.persistent(false);

  logLine("[WIFI] mode(WIFI_STA)");
  WiFi.mode(WIFI_STA);

  logLine("[WIFI] sleep(false)");
  WiFi.setSleep(false);

  logLine("[WIFI] txPower=8.5dBm");
  WiFi.setTxPower(WIFI_POWER_8_5dBm);

  WiFi.disconnect(false, false);
  delay(100);

  logLine("[WIFI] begin");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const uint32_t startMs = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startMs < WIFI_CONNECT_TIMEOUT_MS) {
    delay(250);
    Serial.print('.');
    DebugUart.print('.');
  }
  Serial.println();
  DebugUart.println();

  if (WiFi.status() != WL_CONNECTED) {
    logLine("[WIFI] connect failed");
    return false;
  }

  nextWifiRetryAtMs = 0;
  printWifiStatus();
  return true;
}

void scheduleWifiRetry() {
  nextWifiRetryAtMs = millis() + WIFI_RETRY_INTERVAL_MS;
  char line[120];
  snprintf(line, sizeof(line), "[WIFI] retry scheduled in %lu ms", static_cast<unsigned long>(WIFI_RETRY_INTERVAL_MS));
  logLine(line);
}

void startStream() {
  if (WiFi.status() != WL_CONNECTED) {
    logLine("[STREAM] cannot start: WiFi is not connected");
    streamRestartAtMs = millis() + RESTART_DELAY_MS;
    return;
  }

  char line[220];
  snprintf(line, sizeof(line), "[STREAM] connecttohost %s", STREAM_URL);
  logLine(line);
  printMemoryStatus("before connecttohost");

  const bool ok = audio.connecttohost(STREAM_URL, "esp32", STREAM_TOKEN);
  streamStarted = ok;

  snprintf(line, sizeof(line), "[STREAM] connecttohost result=%s", ok ? "ok" : "failed");
  logLine(line);
  printMemoryStatus("after connecttohost");

  if (!ok) {
    streamRestartAtMs = millis() + RESTART_DELAY_MS;
  }
}

void setup() {
  Serial.begin(115200);
  DebugUart.begin(115200);
  delay(STARTUP_DELAY_MS);

  if (RUN_CPU_MHZ > 0) {
    setCpuFrequencyMhz(RUN_CPU_MHZ);
  }

  Audio::audio_info_callback = my_audio_info;

  logLine("ESP32-S3 WiFi stream speaker test starting.");
  logLine("I2S pins: DIN=11, BCLK=10, LRC=9");

  char line[120];
  snprintf(line, sizeof(line), "Runtime CPU frequency: %lu MHz", static_cast<unsigned long>(getCpuFrequencyMhz()));
  logLine(line);

  const esp_reset_reason_t reason = esp_reset_reason();
  snprintf(line, sizeof(line), "Last reset reason: %d (%s)", static_cast<int>(reason), resetReasonName(reason));
  logLine(line);

  printMemoryStatus("startup");

  if (psramFound()) {
    logLine("PSRAM detected.");
  } else {
    logLine("WARNING: PSRAM not detected. MP3 streaming may fail.");
  }

  audio.setPinout(I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN);
  audio.setOutput48KHz(false);
  audio.setVolume(START_VOLUME);
  audio.forceMono(true);

  snprintf(line, sizeof(line), "Audio volume: %u", START_VOLUME);
  logLine(line);

  if (connectWifi()) {
    startStream();
  } else {
    scheduleWifiRetry();
  }
}

void loop() {
  audio.loop();
  printPlaybackStatus();
  printWifiStatus();

  if (WiFi.status() != WL_CONNECTED) {
    if (streamStarted || audio.isRunning()) {
      logLine("[WIFI] disconnected; stopping stream");
      audio.stopSong();
      streamStarted = false;
      streamRestartAtMs = 0;
    }

    if (nextWifiRetryAtMs == 0) {
      scheduleWifiRetry();
    }

    if (millis() >= nextWifiRetryAtMs) {
      nextWifiRetryAtMs = 0;
      if (connectWifi()) {
        startStream();
      } else {
        scheduleWifiRetry();
      }
    }

    delay(1);
    return;
  }

  if (streamStarted && !audio.isRunning() && streamRestartAtMs == 0) {
    logLine("[STREAM] ended or stopped; replay scheduled");
    streamRestartAtMs = millis() + RESTART_DELAY_MS;
  }

  if (streamRestartAtMs != 0 && millis() >= streamRestartAtMs) {
    streamRestartAtMs = 0;
    streamStarted = false;
    startStream();
  }

  delay(1);
}
