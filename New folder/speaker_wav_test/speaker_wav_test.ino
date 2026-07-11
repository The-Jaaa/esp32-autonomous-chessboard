/*
  ESP32-S3 MAX98357A WAV Speaker Test

  This avoids the PSRAM-heavy MP3 decoder library.

  Upload flow:
    1. Upload this sketch.
    2. Upload the data folder as SPIFFS. It contains /test.wav.
    3. Unplug USB.
    4. Power the PCB externally.
    5. Wait 5 seconds; /test.wav should loop.

  Arduino IDE settings:
    Board: ESP32S3 Dev Module
    Flash Size: 16MB
    Partition Scheme: No OTA (2MB APP/2MB SPIFFS)
    PSRAM: Disabled or OPI PSRAM

  Rewired safe I2S pins:
    MAX98357A DIN  -> GPIO11
    MAX98357A BCLK -> GPIO10
    MAX98357A LRC  -> GPIO9
*/

#include <Arduino.h>
#include "ESP_I2S.h"
#include "FS.h"
#include "SPIFFS.h"

constexpr uint8_t I2S_DOUT_PIN = 11;
constexpr uint8_t I2S_BCLK_PIN = 10;
constexpr uint8_t I2S_LRC_PIN  = 9;
constexpr uint8_t MAGNET_PIN   = 38;

constexpr uint32_t STARTUP_DELAY_MS = 5000;
constexpr const char* WAV_PATH = "/test.wav";
constexpr size_t MONO_SAMPLES_PER_CHUNK = 512;

I2SClass i2s;
bool i2sStarted = false;

struct WavInfo {
  uint16_t audioFormat = 0;
  uint16_t channels = 0;
  uint32_t sampleRate = 0;
  uint16_t bitsPerSample = 0;
  uint32_t dataOffset = 0;
  uint32_t dataSize = 0;
};

uint16_t readU16LE(File& file) {
  uint8_t b[2];
  if (file.read(b, 2) != 2) return 0;
  return static_cast<uint16_t>(b[0]) | (static_cast<uint16_t>(b[1]) << 8);
}

uint32_t readU32LE(File& file) {
  uint8_t b[4];
  if (file.read(b, 4) != 4) return 0;
  return static_cast<uint32_t>(b[0]) |
         (static_cast<uint32_t>(b[1]) << 8) |
         (static_cast<uint32_t>(b[2]) << 16) |
         (static_cast<uint32_t>(b[3]) << 24);
}

bool readChunkId(File& file, char id[5]) {
  if (file.read(reinterpret_cast<uint8_t*>(id), 4) != 4) return false;
  id[4] = '\0';
  return true;
}

bool parseWavHeader(File& file, WavInfo& info) {
  char id[5];

  if (!readChunkId(file, id) || strcmp(id, "RIFF") != 0) return false;
  readU32LE(file);
  if (!readChunkId(file, id) || strcmp(id, "WAVE") != 0) return false;

  bool foundFmt = false;
  bool foundData = false;

  while (file.available()) {
    if (!readChunkId(file, id)) break;
    const uint32_t chunkSize = readU32LE(file);
    const uint32_t chunkDataStart = file.position();

    if (strcmp(id, "fmt ") == 0) {
      info.audioFormat = readU16LE(file);
      info.channels = readU16LE(file);
      info.sampleRate = readU32LE(file);
      readU32LE(file);
      readU16LE(file);
      info.bitsPerSample = readU16LE(file);
      foundFmt = true;
    } else if (strcmp(id, "data") == 0) {
      info.dataOffset = chunkDataStart;
      info.dataSize = chunkSize;
      foundData = true;
      break;
    }

    file.seek(chunkDataStart + chunkSize + (chunkSize & 1));
  }

  return foundFmt && foundData &&
         info.audioFormat == 1 &&
         (info.channels == 1 || info.channels == 2) &&
         info.bitsPerSample == 16 &&
         info.sampleRate > 0;
}

void printSpiffsInfo() {
  Serial.print(F("SPIFFS total bytes: "));
  Serial.println(SPIFFS.totalBytes());
  Serial.print(F("SPIFFS used bytes: "));
  Serial.println(SPIFFS.usedBytes());

  File root = SPIFFS.open("/");
  File file = root.openNextFile();
  Serial.println(F("SPIFFS root files:"));
  while (file) {
    Serial.print(F("  "));
    Serial.print(file.name());
    Serial.print(F("  "));
    Serial.print(file.size());
    Serial.println(F(" bytes"));
    file = root.openNextFile();
  }
}

bool startI2S(uint32_t sampleRate) {
  if (i2sStarted) return true;

  i2s.setPins(I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN);
  i2sStarted = i2s.begin(I2S_MODE_STD, sampleRate, I2S_DATA_BIT_WIDTH_16BIT,
                         I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH);

  if (!i2sStarted) {
    Serial.println(F("I2S init failed."));
  }

  return i2sStarted;
}

void playWavFile() {
  File file = SPIFFS.open(WAV_PATH, FILE_READ);
  if (!file) {
    Serial.println(F("ERROR: /test.wav not found."));
    return;
  }

  WavInfo info;
  if (!parseWavHeader(file, info)) {
    Serial.println(F("ERROR: WAV must be PCM 16-bit mono/stereo."));
    file.close();
    return;
  }

  Serial.print(F("Playing /test.wav, sampleRate="));
  Serial.print(info.sampleRate);
  Serial.print(F(", channels="));
  Serial.print(info.channels);
  Serial.print(F(", dataBytes="));
  Serial.println(info.dataSize);

  if (!startI2S(info.sampleRate)) {
    file.close();
    return;
  }

  file.seek(info.dataOffset);

  int16_t input[MONO_SAMPLES_PER_CHUNK * 2];
  int16_t output[MONO_SAMPLES_PER_CHUNK * 2];
  uint32_t bytesRemaining = info.dataSize;
  const size_t sourceFrameBytes = info.channels * sizeof(int16_t);

  while (bytesRemaining > 0) {
    const size_t maxInputBytes = sizeof(input);
    const size_t bytesToRead = min<size_t>(maxInputBytes, bytesRemaining);
    const size_t bytesRead = file.read(reinterpret_cast<uint8_t*>(input), bytesToRead);
    if (bytesRead == 0) break;

    const size_t sourceFrames = bytesRead / sourceFrameBytes;

    for (size_t i = 0; i < sourceFrames; i++) {
      int16_t mono;
      if (info.channels == 1) {
        mono = input[i];
      } else {
        const int32_t left = input[i * 2];
        const int32_t right = input[(i * 2) + 1];
        mono = static_cast<int16_t>((left + right) / 2);
      }

      output[i * 2] = mono;
      output[(i * 2) + 1] = mono;
    }

    i2s.write(reinterpret_cast<uint8_t*>(output), sourceFrames * 2 * sizeof(int16_t));
    bytesRemaining -= bytesRead;
    yield();
  }

  file.close();
  Serial.println(F("Track ended."));
}

void setup() {
  Serial.begin(115200);

  pinMode(MAGNET_PIN, OUTPUT);
  digitalWrite(MAGNET_PIN, LOW);

  delay(STARTUP_DELAY_MS);

  Serial.println();
  Serial.println(F("ESP32-S3 WAV speaker test starting."));
  Serial.println(F("I2S pins: DIN=11, BCLK=10, LRC=9"));

  if (!SPIFFS.begin(false)) {
    Serial.println(F("SPIFFS mount failed."));
    return;
  }

  printSpiffsInfo();
}

void loop() {
  playWavFile();
  delay(1500);
}
