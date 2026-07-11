/*
  ESP32-S3 MAX98357A Speaker Test

  Upload flow for your PCB:
    1. Upload this sketch over USB.
    2. Upload the sketch data folder so /test.mp3 is stored in flash.
    3. Unplug USB from the PC.
    4. Power the PCB/ESP32 from the external supply.
    5. After 5 seconds, /test.mp3 plays in a loop.

  Requires Arduino library:
    ESP32-audioI2S by schreibfaul1

  Important for the rewired PCB:
    These safe I2S pins avoid the ESP32-S3 N16R8 Octal PSRAM pins.
    Use OPI PSRAM ENABLED for this MP3 decoder test.

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

constexpr uint8_t I2S_DOUT_PIN = 11;  // MAX98357A DIN
constexpr uint8_t I2S_BCLK_PIN = 10;  // MAX98357A BCLK
constexpr uint8_t I2S_LRC_PIN  = 9;   // MAX98357A LRC / LRCLK

constexpr uint32_t STARTUP_DELAY_MS = 5000;
constexpr uint32_t REPLAY_DELAY_MS  = 1500;
constexpr uint32_t STATUS_INTERVAL_MS = 1000;

// ESP32-audioI2S volume is 0..21. Start low while diagnosing brownouts.
constexpr uint8_t START_VOLUME = 20;

// Diagnostic mode:
//   true  = decode /test.mp3 but block the final I2S write. This should be silent.
//   false = normal MP3 playback through GPIO9/10/11.
constexpr bool DECODE_ONLY_DIAG = false;
constexpr uint32_t RUN_CPU_MHZ = 240;
constexpr uint32_t DECODE_ONLY_FRAME_DELAY_MS = 24;

Audio audio;
HardwareSerial& DebugUart = Serial0;
const char* audioPath = "/test.mp3";
bool startedPlayback = false;
fs::FS* activeFS = nullptr;
const char* activeFsName = nullptr;
uint32_t lastStatusMs = 0;

void logLine(const char* line) {
  Serial.println(line);
  DebugUart.println(line);
}

void logBlankLine() {
  Serial.println();
  DebugUart.println();
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

void audio_process_i2s(int32_t* outBuff, int16_t validSamples, bool* continueI2S) {
  (void)outBuff;

  if (!DECODE_ONLY_DIAG) return;

  static uint32_t lastDiagMs = 0;
  static uint32_t decodedFrames = 0;
  decodedFrames++;

  const uint32_t now = millis();
  if (now - lastDiagMs >= 1000) {
    lastDiagMs = now;
    char line[120];
    snprintf(line, sizeof(line),
             "[DIAG] decodedFrames=%lu samples=%d; I2S output suppressed.",
             static_cast<unsigned long>(decodedFrames),
             static_cast<int>(validSamples));
    logLine(line);
  }

  if (DECODE_ONLY_FRAME_DELAY_MS > 0) {
    delay(DECODE_ONLY_FRAME_DELAY_MS);
  }

  *continueI2S = false;
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
    Serial.println(F("ERROR: /test.mp3 exists but is too small; upload is probably wrong."));
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
  if (now - lastStatusMs < STATUS_INTERVAL_MS) return;
  lastStatusMs = now;

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

void setup() {
  if (RUN_CPU_MHZ > 0) {
    setCpuFrequencyMhz(RUN_CPU_MHZ);
  }

  Audio::audio_info_callback = my_audio_info;
  Serial.begin(115200);
  DebugUart.begin(115200);
  delay(STARTUP_DELAY_MS);

  logBlankLine();
  logLine("ESP32-S3 speaker test starting.");
  logLine("I2S pins: DIN=11, BCLK=10, LRC=9");
  if (DECODE_ONLY_DIAG) {
    logLine("DIAGNOSTIC MODE: MP3 will decode, but I2S output is suppressed. No sound is expected.");
  } else {
    logLine("PLAYBACK MODE: normal I2S output is enabled.");
  }
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
    logLine("PSRAM detected, which is correct for MP3 playback on the safe I2S pins.");
  } else {
    logLine("WARNING: PSRAM not detected. MP3 playback may fail with AudioBuffer OOM.");
    logLine("Use Tools > PSRAM > OPI PSRAM after rewiring audio to GPIO9/10/11.");
  }

  audio.setPinout(I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN);
  audio.setOutput48KHz(false);
  audio.setVolume(START_VOLUME);
  audio.forceMono(true);
  Serial.print(F("Audio volume: "));
  Serial.println(START_VOLUME);
  DebugUart.print(F("Audio volume: "));
  DebugUart.println(START_VOLUME);

  if (!mountAndFindAudio()) {
    logLine("No playable /test.mp3 found. Upload the sketch data folder to LittleFS or SPIFFS.");
    return;
  }

  startPlayback();
}

void loop() {
  audio.loop();
  printPlaybackStatus();

  if (startedPlayback && !audio.isRunning()) {
    logLine("Track ended. Replaying...");
    delay(REPLAY_DELAY_MS);
    startPlayback();
  }
}
