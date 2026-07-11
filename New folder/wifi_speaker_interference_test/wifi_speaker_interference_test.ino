/*
  ESP32-S3 WiFi + Speaker Interference Test

  Goal:
    Play the already-uploaded local /test.mp3 from LittleFS while WiFi is active.
    This tests whether WiFi radio/CPU activity causes speaker noise, dropouts,
    stutters, or brownouts before we stream audio from the server.

  Default test:
    WiFi scan stress only. No SSID/password needed.

  I2S wiring:
    MAX98357A DIN  -> GPIO11
    MAX98357A BCLK -> GPIO10
    MAX98357A LRC  -> GPIO9
*/

#include <Arduino.h>
#include "Audio.h"
#include "FS.h"
#include "LittleFS.h"
#include "SPIFFS.h"
#include "esp_system.h"
#include <WiFi.h>
#include <HTTPClient.h>

constexpr uint8_t I2S_DOUT_PIN = 11;
constexpr uint8_t I2S_BCLK_PIN = 10;
constexpr uint8_t I2S_LRC_PIN = 9;

constexpr uint32_t STARTUP_DELAY_MS = 5000;
constexpr uint32_t REPLAY_DELAY_MS = 1500;
constexpr uint32_t STATUS_INTERVAL_MS = 1000;
constexpr uint32_t WIFI_STATUS_INTERVAL_MS = 3000;
constexpr uint32_t WIFI_SCAN_INTERVAL_MS = 7000;
constexpr uint32_t HTTP_STRESS_INTERVAL_MS = 5000;
constexpr uint32_t HTTP_STRESS_MAX_MS = 1200;
constexpr uint32_t WIFI_BOOT_STEP_DELAY_MS = 1000;

// Keep the known-stable audio settings from the brownout fix.
constexpr uint32_t RUN_CPU_MHZ = 240;
constexpr uint8_t START_VOLUME = 20;  // ESP32-audioI2S volume is 0..21.

// Stage 1: leave this true. It does active WiFi scans while audio plays.
constexpr bool ENABLE_WIFI_SCAN_STRESS = true;
constexpr bool WIFI_PASSIVE_SCAN = true;
constexpr uint32_t WIFI_PASSIVE_SCAN_MS_PER_CHANNEL = 120;
constexpr wifi_power_t WIFI_START_TX_POWER = WIFI_POWER_2dBm;

// Stage 2: set this true only after Stage 1 passes, then fill in your WiFi.
constexpr bool CONNECT_TO_WIFI = true;
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Stage 3: after WiFi connection works, set this true to add download traffic.
constexpr bool ENABLE_HTTP_STRESS = true;
const char* HTTP_STRESS_URL = "http://YOUR_PC_IP:8000/test.mp3";

Audio audio;
HardwareSerial& DebugUart = Serial0;
const char* audioPath = "/test.mp3";
bool startedPlayback = false;
fs::FS* activeFS = nullptr;
const char* activeFsName = nullptr;
uint32_t lastPlaybackStatusMs = 0;
uint32_t lastWifiStatusMs = 0;
uint32_t lastScanStartMs = 0;
uint32_t lastHttpStressMs = 0;
bool scanRunning = false;
bool wifiBeginCalled = false;

void logLine(const char* line) {
  Serial.println(line);
  DebugUart.println(line);
  Serial.flush();
  DebugUart.flush();
}

void logBlankLine() {
  Serial.println();
  DebugUart.println();
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

void listFsRoot(fs::FS& fs, const char* fsName) {
  Serial.print(fsName);
  Serial.println(F(" root files:"));

  File root = fs.open("/");
  if (!root) {
    Serial.println(F("  Could not open filesystem root."));
    return;
  }

  File file = root.openNextFile();
  if (!file) {
    Serial.println(F("  No files found."));
  }

  while (file) {
    Serial.print(F("  "));
    Serial.print(file.name());
    Serial.print(F("  "));
    Serial.print(file.size());
    Serial.println(F(" bytes"));
    file = root.openNextFile();
  }
}

bool findAudioOnFS(fs::FS& fs, const char* fsName, size_t totalBytes, size_t usedBytes) {
  Serial.print(fsName);
  Serial.print(F(" total bytes: "));
  Serial.println(totalBytes);
  Serial.print(fsName);
  Serial.print(F(" used bytes: "));
  Serial.println(usedBytes);
  listFsRoot(fs, fsName);

  File audioFile = fs.open(audioPath, FILE_READ);
  if (!audioFile) {
    Serial.print(F("No /test.mp3 found in "));
    Serial.println(fsName);
    return false;
  }

  Serial.print(F("/test.mp3 size: "));
  Serial.print(audioFile.size());
  Serial.println(F(" bytes"));

  if (audioFile.size() < 1024) {
    Serial.println(F("ERROR: /test.mp3 exists but is too small."));
    audioFile.close();
    return false;
  }

  audioFile.close();
  activeFS = &fs;
  activeFsName = fsName;
  return true;
}

bool mountAndFindAudio() {
  printMemoryStatus("before filesystem mount");

  Serial.println(F("Mounting LittleFS..."));
  if (LittleFS.begin(false)) {
    if (findAudioOnFS(LittleFS, "LittleFS", LittleFS.totalBytes(), LittleFS.usedBytes())) {
      return true;
    }
  } else {
    Serial.println(F("LittleFS mount failed."));
  }

  Serial.println(F("Mounting SPIFFS..."));
  if (SPIFFS.begin(false)) {
    if (findAudioOnFS(SPIFFS, "SPIFFS", SPIFFS.totalBytes(), SPIFFS.usedBytes())) {
      return true;
    }
  } else {
    Serial.println(F("SPIFFS mount failed."));
  }

  return false;
}

void startPlayback() {
  Serial.print(F("Playing "));
  Serial.println(audioPath);
  DebugUart.print(F("Playing "));
  DebugUart.println(audioPath);

  if (!activeFS) {
    logLine("No mounted filesystem is selected.");
    startedPlayback = false;
    return;
  }

  Serial.print(F("Using filesystem: "));
  Serial.println(activeFsName);
  DebugUart.print(F("Using filesystem: "));
  DebugUart.println(activeFsName);
  printMemoryStatus("before connecttoFS");
  startedPlayback = audio.connecttoFS(*activeFS, audioPath);
  printMemoryStatus("after connecttoFS");

  if (!startedPlayback) {
    logLine("Audio library could not start the MP3 file.");
  }
}

void printPlaybackStatus() {
  const uint32_t now = millis();
  if (now - lastPlaybackStatusMs < STATUS_INTERVAL_MS) return;
  lastPlaybackStatusMs = now;

  char line[300];
  snprintf(line, sizeof(line),
           "[PLAY] ms=%lu running=%s time=%lu/%lus pos=%lu/%lu bitrate=%lu sampleRate=%lu channels=%u inBuf=%lu/%lu heapFree=%lu psramFree=%lu",
           static_cast<unsigned long>(now),
           audio.isRunning() ? "yes" : "no",
           static_cast<unsigned long>(audio.getAudioCurrentTime()),
           static_cast<unsigned long>(audio.getAudioFileDuration()),
           static_cast<unsigned long>(audio.getAudioFilePosition()),
           static_cast<unsigned long>(audio.getFileSize()),
           static_cast<unsigned long>(audio.getBitRate()),
           static_cast<unsigned long>(audio.getSampleRate()),
           static_cast<unsigned int>(audio.getChannels()),
           static_cast<unsigned long>(audio.inBufferFilled()),
           static_cast<unsigned long>(audio.getInBufferSize()),
           static_cast<unsigned long>(ESP.getFreeHeap()),
           static_cast<unsigned long>(ESP.getFreePsram()));
  logLine(line);
}

void beginWifiStress() {
  logLine("[WIFI-BOOT] persistent(false)");
  WiFi.persistent(false);
  delay(WIFI_BOOT_STEP_DELAY_MS);

  logLine("[WIFI-BOOT] mode(WIFI_OFF) begin");
  WiFi.mode(WIFI_OFF);
  delay(WIFI_BOOT_STEP_DELAY_MS);
  logLine("[WIFI-BOOT] mode(WIFI_OFF) done");

  logLine("[WIFI-BOOT] mode(WIFI_STA) begin");
  WiFi.mode(WIFI_STA);
  delay(WIFI_BOOT_STEP_DELAY_MS);
  logLine("[WIFI-BOOT] mode(WIFI_STA) done");

  logLine("[WIFI-BOOT] set low TX power begin");
  WiFi.setTxPower(WIFI_START_TX_POWER);
  delay(WIFI_BOOT_STEP_DELAY_MS);
  char powerLine[80];
  snprintf(powerLine, sizeof(powerLine), "[WIFI-BOOT] TX power now=%d", static_cast<int>(WiFi.getTxPower()));
  logLine(powerLine);

  logLine("[WIFI-BOOT] setSleep(true) begin");
  WiFi.setSleep(true);
  delay(WIFI_BOOT_STEP_DELAY_MS);
  logLine("[WIFI-BOOT] setSleep(true) done");

  if (CONNECT_TO_WIFI) {
    logLine("[WIFI] Connecting to configured network.");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    wifiBeginCalled = true;
  } else {
    logLine("[WIFI] Scan-only stress mode. No SSID/password needed.");
  }
}

void serviceWifiStatus() {
  const uint32_t now = millis();
  if (now - lastWifiStatusMs < WIFI_STATUS_INTERVAL_MS) return;
  lastWifiStatusMs = now;

  char line[180];
  if (WiFi.status() == WL_CONNECTED) {
    IPAddress ip = WiFi.localIP();
    snprintf(line, sizeof(line),
             "[WIFI] connected rssi=%d ip=%u.%u.%u.%u heapFree=%lu psramFree=%lu",
             WiFi.RSSI(),
             ip[0], ip[1], ip[2], ip[3],
             static_cast<unsigned long>(ESP.getFreeHeap()),
             static_cast<unsigned long>(ESP.getFreePsram()));
  } else {
    snprintf(line, sizeof(line),
             "[WIFI] status=%d scanRunning=%s heapFree=%lu psramFree=%lu",
             static_cast<int>(WiFi.status()),
             scanRunning ? "yes" : "no",
             static_cast<unsigned long>(ESP.getFreeHeap()),
             static_cast<unsigned long>(ESP.getFreePsram()));
  }
  logLine(line);

  if (CONNECT_TO_WIFI && !wifiBeginCalled) {
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    wifiBeginCalled = true;
  }
}

void serviceScanStress() {
  if (!ENABLE_WIFI_SCAN_STRESS) return;

  const uint32_t now = millis();
  const int scanResult = WiFi.scanComplete();

  if (scanRunning && scanResult >= 0) {
    int strongestRssi = -127;
    String strongestSsid = "";
    for (int i = 0; i < scanResult; i++) {
      if (WiFi.RSSI(i) > strongestRssi) {
        strongestRssi = WiFi.RSSI(i);
        strongestSsid = WiFi.SSID(i);
      }
    }

    char line[180];
    snprintf(line, sizeof(line),
             "[WIFI] scan complete networks=%d strongestRssi=%d strongest='%s'",
             scanResult,
             strongestRssi,
             strongestSsid.c_str());
    logLine(line);
    WiFi.scanDelete();
    scanRunning = false;
    lastScanStartMs = now;
    return;
  }

  if (scanRunning) return;
  if (now - lastScanStartMs < WIFI_SCAN_INTERVAL_MS) return;

  if (WIFI_PASSIVE_SCAN) {
    logLine("[WIFI] starting async passive scan stress");
  } else {
    logLine("[WIFI] starting async active scan stress");
  }
  WiFi.scanNetworks(true, true, WIFI_PASSIVE_SCAN, WIFI_PASSIVE_SCAN_MS_PER_CHANNEL);
  scanRunning = true;
  lastScanStartMs = now;
}

void serviceHttpStress() {
  if (!CONNECT_TO_WIFI || !ENABLE_HTTP_STRESS) return;
  if (WiFi.status() != WL_CONNECTED) return;

  const uint32_t now = millis();
  if (now - lastHttpStressMs < HTTP_STRESS_INTERVAL_MS) return;
  lastHttpStressMs = now;

  logLine("[HTTP] starting short download stress");

  HTTPClient http;
  http.setReuse(false);
  if (!http.begin(HTTP_STRESS_URL)) {
    logLine("[HTTP] begin failed");
    return;
  }

  const int code = http.GET();
  size_t bytesRead = 0;
  uint32_t startMs = millis();

  if (code > 0) {
    WiFiClient* stream = http.getStreamPtr();
    uint8_t buffer[512];
    while (http.connected() && millis() - startMs < HTTP_STRESS_MAX_MS) {
      audio.loop();
      const int availableBytes = stream->available();
      if (availableBytes <= 0) {
        delay(1);
        continue;
      }

      const size_t toRead = min(static_cast<size_t>(availableBytes), sizeof(buffer));
      const int got = stream->readBytes(buffer, toRead);
      if (got <= 0) break;
      bytesRead += static_cast<size_t>(got);
    }
  }

  http.end();

  char line[120];
  snprintf(line, sizeof(line), "[HTTP] done code=%d bytes=%lu",
           code,
           static_cast<unsigned long>(bytesRead));
  logLine(line);
}

void setup() {
  if (RUN_CPU_MHZ > 0) {
    setCpuFrequencyMhz(RUN_CPU_MHZ);
  }

  Audio::audio_info_callback = my_audio_info;
  Serial.begin(115200);
  DebugUart.begin(115200);
  delay(STARTUP_DELAY_MS);

  logBlankLine();
  logLine("ESP32-S3 WiFi + speaker interference test starting.");
  logLine("I2S pins: DIN=11, BCLK=10, LRC=9");

  char cpuLine[80];
  snprintf(cpuLine, sizeof(cpuLine), "Runtime CPU frequency: %lu MHz",
           static_cast<unsigned long>(getCpuFrequencyMhz()));
  logLine(cpuLine);

  const esp_reset_reason_t reason = esp_reset_reason();
  char resetLine[80];
  snprintf(resetLine, sizeof(resetLine), "Last reset reason: %d (%s)",
           static_cast<int>(reason), resetReasonName(reason));
  logLine(resetLine);
  printMemoryStatus("startup");

  if (psramFound()) {
    logLine("PSRAM detected.");
  } else {
    logLine("WARNING: PSRAM not detected. MP3 playback may fail.");
  }

  audio.setPinout(I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN);
  audio.setOutput48KHz(false);
  audio.setVolume(START_VOLUME);
  audio.forceMono(true);
  Serial.print(F("Audio volume: "));
  Serial.println(START_VOLUME);
  DebugUart.print(F("Audio volume: "));
  DebugUart.println(START_VOLUME);

  beginWifiStress();

  if (!mountAndFindAudio()) {
    logLine("No playable /test.mp3 found. Keep the same custom partition and LittleFS upload.");
    return;
  }

  startPlayback();
}

void loop() {
  audio.loop();
  printPlaybackStatus();
  serviceWifiStatus();
  serviceScanStress();
  serviceHttpStress();

  if (startedPlayback && !audio.isRunning()) {
    logLine("Track ended. Replaying...");
    delay(REPLAY_DELAY_MS);
    startPlayback();
  }
}
