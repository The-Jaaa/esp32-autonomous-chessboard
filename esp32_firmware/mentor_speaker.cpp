#include "mentor_speaker.h"

#include <ArduinoJson.h>
#include <algorithm>
#include <WiFi.h>
#include <WiFiClient.h>
#include <driver/i2s_std.h>
#include <esp_heap_caps.h>
#include <freertos/semphr.h>

namespace {

constexpr uint8_t PROTOCOL_VERSION = 1;
constexpr size_t FRAME_HEADER_BYTES = 16;
constexpr uint32_t SAMPLE_RATE = 24000;
constexpr const char* AUDIO_ENCODING = "ima_adpcm4";
constexpr size_t BYTES_PER_SECOND = SAMPLE_RATE * sizeof(int16_t);
constexpr size_t RING_BYTES = 2097152;
constexpr size_t PREBUFFER_BYTES = (BYTES_PER_SECOND * 1800) / 1000;
constexpr size_t MAX_FRAME_BYTES = 262144;
constexpr uint32_t RECONNECT_MS = 2000;
constexpr uint32_t TELEMETRY_MS = 250;
constexpr uint32_t I2S_WRITE_TIMEOUT_MS = 20;
constexpr uint32_t STARVATION_GRACE_MS = 800;
constexpr uint8_t PLAYBACK_BURST_WRITES = 8;
constexpr size_t RECEIVE_BUDGET_BYTES = 32768;
constexpr int8_t IMA_INDEX_TABLE[16] = {
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8
};
constexpr int16_t IMA_STEP_TABLE[89] = {
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
  143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
  494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
  1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026,
  4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
  27086, 29794, 32767
};

enum FrameType : uint8_t {
  FRAME_START = 1,
  FRAME_PCM = 2,
  FRAME_CLEAR = 3,
  FRAME_END = 4,
  FRAME_PING = 5
};

struct RingBuffer {
  uint8_t* data = nullptr;
  size_t head = 0;
  size_t tail = 0;
  size_t count = 0;
};

struct ReceiverState {
  uint8_t header[FRAME_HEADER_BYTES] = {0};
  size_t headerBytes = 0;
  uint8_t type = 0;
  uint32_t sequence = 0;
  uint32_t payloadLength = 0;
  uint32_t payloadRead = 0;
  bool discardPayload = false;
  char controlPayload[768] = {0};
};

MentorSpeakerConfig speakerConfig;
char hostStorage[96] = {0};
char boardIdStorage[65] = {0};
char tokenStorage[129] = {0};
RingBuffer pcmRing;
ReceiverState receiver;
WiFiClient audioClient;
i2s_chan_handle_t i2sTx = nullptr;
TaskHandle_t audioTaskHandle = nullptr;
TaskHandle_t playbackTaskHandle = nullptr;
SemaphoreHandle_t ringMutex = nullptr;
SemaphoreHandle_t i2sMutex = nullptr;
SemaphoreHandle_t socketWriteMutex = nullptr;
volatile bool speakerAvailable = false;
volatile bool speakerConnected = false;
volatile bool speakerPlaying = false;
volatile uint32_t speakerUnderrunCount = 0;
volatile uint32_t speakerBufferedMilliseconds = 0;
volatile uint32_t speakerSensorMaxGapMs = 0;
volatile uint32_t speakerPreviousSensorScanMs = 0;
volatile uint32_t streamReceivedBytes = 0;
volatile uint32_t streamConsumedBytes = 0;
volatile uint32_t streamReceivedHash = 2166136261UL;
volatile uint32_t streamConsumedHash = 2166136261UL;
bool handshakeAccepted = false;
volatile bool streamEnding = false;
volatile bool prebuffering = true;
uint8_t streamVolume = 50;
uint32_t lastSequence = 0;
uint32_t lastConnectAttemptMs = 0;
uint32_t lastTelemetryMs = 0;
uint32_t lastPcmMs = 0;
uint32_t starvationStartedMs = 0;
uint32_t i2sWindowStartedMs = 0;
uint32_t i2sWindowBytes = 0;
uint32_t i2sBytesPerSecond = 0;
uint32_t i2sWindowTimeouts = 0;
uint32_t i2sTimeoutsPerSecond = 0;
uint32_t ringGeneration = 0;
int32_t adpcmPredictor = 0;
int adpcmIndex = 0;
char activeSessionId[80] = {0};
String handshakeLine;

uint32_t updateFnv1a(uint32_t hash, const uint8_t* bytes, size_t length) {
  for (size_t index = 0; index < length; ++index) {
    hash ^= bytes[index];
    hash *= 16777619UL;
  }
  return hash;
}

int16_t decodeImaAdpcmNibble(uint8_t codeValue) {
  const uint8_t code = codeValue & 0x0f;
  const int step = IMA_STEP_TABLE[adpcmIndex];
  int delta = step >> 3;
  if (code & 4) delta += step;
  if (code & 2) delta += step >> 1;
  if (code & 1) delta += step >> 2;
  adpcmPredictor += (code & 8) ? -delta : delta;
  adpcmPredictor = std::max<int32_t>(-32768, std::min<int32_t>(32767, adpcmPredictor));
  adpcmIndex = std::max(0, std::min(88, adpcmIndex + IMA_INDEX_TABLE[code]));
  return static_cast<int16_t>(adpcmPredictor);
}

void clearRing() {
  if (ringMutex) xSemaphoreTake(ringMutex, portMAX_DELAY);
  pcmRing.head = 0;
  pcmRing.tail = 0;
  pcmRing.count = 0;
  ringGeneration++;
  speakerBufferedMilliseconds = 0;
  starvationStartedMs = 0;
  if (ringMutex) xSemaphoreGive(ringMutex);
}

size_t ringFree() {
  if (ringMutex) xSemaphoreTake(ringMutex, portMAX_DELAY);
  const size_t freeBytes = RING_BYTES - pcmRing.count;
  if (ringMutex) xSemaphoreGive(ringMutex);
  return freeBytes;
}

size_t ringCount() {
  if (ringMutex) xSemaphoreTake(ringMutex, portMAX_DELAY);
  const size_t count = pcmRing.count;
  if (ringMutex) xSemaphoreGive(ringMutex);
  return count;
}

size_t ringWrite(const uint8_t* source, size_t length) {
  if (ringMutex) xSemaphoreTake(ringMutex, portMAX_DELAY);
  const size_t writable = std::min(length, RING_BYTES - pcmRing.count);
  const size_t first = std::min(writable, RING_BYTES - pcmRing.head);
  memcpy(pcmRing.data + pcmRing.head, source, first);
  if (writable > first) memcpy(pcmRing.data, source + first, writable - first);
  pcmRing.head = (pcmRing.head + writable) % RING_BYTES;
  pcmRing.count += writable;
  speakerBufferedMilliseconds = static_cast<uint32_t>((pcmRing.count * 1000ULL) / BYTES_PER_SECOND);
  if (ringMutex) xSemaphoreGive(ringMutex);
  return writable;
}

size_t ringPeek(uint8_t* destination, size_t length, uint32_t& generation) {
  if (ringMutex) xSemaphoreTake(ringMutex, portMAX_DELAY);
  const size_t readable = std::min(length, pcmRing.count);
  const size_t first = std::min(readable, RING_BYTES - pcmRing.tail);
  memcpy(destination, pcmRing.data + pcmRing.tail, first);
  if (readable > first) memcpy(destination + first, pcmRing.data, readable - first);
  generation = ringGeneration;
  if (ringMutex) xSemaphoreGive(ringMutex);
  return readable;
}

void ringDiscard(size_t length, uint32_t generation) {
  if (ringMutex) xSemaphoreTake(ringMutex, portMAX_DELAY);
  if (generation != ringGeneration) {
    if (ringMutex) xSemaphoreGive(ringMutex);
    return;
  }
  const size_t discarded = std::min(length, pcmRing.count);
  pcmRing.tail = (pcmRing.tail + discarded) % RING_BYTES;
  pcmRing.count -= discarded;
  speakerBufferedMilliseconds = static_cast<uint32_t>((pcmRing.count * 1000ULL) / BYTES_PER_SECOND);
  if (ringMutex) xSemaphoreGive(ringMutex);
}

void resetReceiver() {
  receiver = ReceiverState{};
}

void sendTelemetry(const char* type, const char* error = nullptr) {
  if (!audioClient.connected() || !handshakeAccepted) return;
  StaticJsonDocument<512> document;
  document["type"] = type;
  if (activeSessionId[0]) document["sessionId"] = activeSessionId;
  document["bufferedMs"] = speakerBufferedMilliseconds;
  document["underruns"] = speakerUnderrunCount;
  document["freePsram"] = ESP.getFreePsram();
  document["freeHeap"] = ESP.getFreeHeap();
  document["sensorMaxGapMs"] = speakerSensorMaxGapMs;
  document["i2sBytesPerSecond"] = i2sBytesPerSecond;
  document["i2sTimeoutsPerSecond"] = i2sTimeoutsPerSecond;
  document["streamReceivedBytes"] = streamReceivedBytes;
  document["streamConsumedBytes"] = streamConsumedBytes;
  document["streamReceivedHash"] = streamReceivedHash;
  document["streamConsumedHash"] = streamConsumedHash;
  if (error) document["error"] = error;
  if (socketWriteMutex) xSemaphoreTake(socketWriteMutex, portMAX_DELAY);
  if (audioClient.connected() && handshakeAccepted) {
    serializeJson(document, audioClient);
    audioClient.write('\n');
  }
  if (socketWriteMutex) xSemaphoreGive(socketWriteMutex);
}

bool initializeI2s() {
  i2s_chan_config_t channelConfig = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  channelConfig.dma_desc_num = 12;
  channelConfig.dma_frame_num = 480;
  channelConfig.auto_clear = true;
  channelConfig.intr_priority = 2;
  if (i2s_new_channel(&channelConfig, &i2sTx, nullptr) != ESP_OK) return false;

  i2s_std_config_t standardConfig = {};
  standardConfig.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE);
  standardConfig.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
    I2S_DATA_BIT_WIDTH_16BIT,
    I2S_SLOT_MODE_STEREO
  );
  standardConfig.slot_cfg.slot_mask = I2S_STD_SLOT_BOTH;
  standardConfig.gpio_cfg.mclk = I2S_GPIO_UNUSED;
  standardConfig.gpio_cfg.bclk = static_cast<gpio_num_t>(speakerConfig.bclkPin);
  standardConfig.gpio_cfg.ws = static_cast<gpio_num_t>(speakerConfig.lrclkPin);
  standardConfig.gpio_cfg.dout = static_cast<gpio_num_t>(speakerConfig.dataPin);
  standardConfig.gpio_cfg.din = I2S_GPIO_UNUSED;
  standardConfig.gpio_cfg.invert_flags.mclk_inv = false;
  standardConfig.gpio_cfg.invert_flags.bclk_inv = false;
  standardConfig.gpio_cfg.invert_flags.ws_inv = false;

  if (i2s_channel_init_std_mode(i2sTx, &standardConfig) != ESP_OK) {
    i2s_del_channel(i2sTx);
    i2sTx = nullptr;
    return false;
  }
  if (i2s_channel_enable(i2sTx) != ESP_OK) {
    i2s_del_channel(i2sTx);
    i2sTx = nullptr;
    return false;
  }
  return true;
}

void resetPlayback(const char* telemetryType = nullptr) {
  clearRing();
  streamEnding = false;
  prebuffering = true;
  speakerPlaying = false;
  lastSequence = 0;
  lastPcmMs = 0;
  i2sWindowStartedMs = millis();
  i2sWindowBytes = 0;
  i2sBytesPerSecond = 0;
  i2sWindowTimeouts = 0;
  i2sTimeoutsPerSecond = 0;
  adpcmPredictor = 0;
  adpcmIndex = 0;
  if (i2sTx) {
    if (i2sMutex) xSemaphoreTake(i2sMutex, portMAX_DELAY);
    i2s_channel_disable(i2sTx);
    i2s_channel_enable(i2sTx);
    if (i2sMutex) xSemaphoreGive(i2sMutex);
  }
  if (telemetryType) sendTelemetry(telemetryType);
}

bool parseSessionControl(const char* payload, size_t length, char* destination, size_t destinationSize) {
  if (length >= sizeof(receiver.controlPayload)) return false;
  StaticJsonDocument<512> document;
  const DeserializationError error = deserializeJson(document, payload, length);
  if (error) return false;
  const char* session = document["sessionId"] | "";
  if (!session[0] || strlen(session) >= destinationSize) return false;
  strlcpy(destination, session, destinationSize);
  return true;
}

void processControlFrame() {
  receiver.controlPayload[std::min<size_t>(receiver.payloadLength, sizeof(receiver.controlPayload) - 1)] = '\0';
  if (receiver.type == FRAME_START) {
    StaticJsonDocument<512> document;
    if (deserializeJson(document, receiver.controlPayload, receiver.payloadLength)) {
      sendTelemetry("error", "invalid_start");
      return;
    }
    const char* session = document["sessionId"] | "";
    if (!session[0] || strlen(session) >= sizeof(activeSessionId)
        || document["sampleRate"].as<uint32_t>() != SAMPLE_RATE
        || strcmp(document["encoding"] | "", AUDIO_ENCODING) != 0
        || document["bitsPerSample"].as<uint8_t>() != 4
        || document["decodedBitsPerSample"].as<uint8_t>() != 16) {
      sendTelemetry("error", "unsupported_start");
      return;
    }
    strlcpy(activeSessionId, session, sizeof(activeSessionId));
    streamVolume = constrain(static_cast<int>(document["volume"] | 50), 0, 100);
    resetPlayback();
    streamReceivedBytes = 0;
    streamConsumedBytes = 0;
    streamReceivedHash = 2166136261UL;
    streamConsumedHash = 2166136261UL;
    speakerSensorMaxGapMs = 0;
    Serial.printf("[MENTOR_SPEAKER] stream start session=%s volume=%u\n", activeSessionId, streamVolume);
    sendTelemetry("started");
    return;
  }

  if (receiver.type == FRAME_CLEAR) {
    char session[80] = {0};
    if (parseSessionControl(receiver.controlPayload, receiver.payloadLength, session, sizeof(session))
        && strcmp(session, activeSessionId) == 0) {
      resetPlayback("cleared");
      Serial.println("[MENTOR_SPEAKER] stream cleared");
    }
    return;
  }

  if (receiver.type == FRAME_END) {
    char session[80] = {0};
    if (parseSessionControl(receiver.controlPayload, receiver.payloadLength, session, sizeof(session))
        && strcmp(session, activeSessionId) == 0) {
      streamEnding = true;
      if (ringCount() == 0) {
        speakerPlaying = false;
        prebuffering = true;
        streamEnding = false;
        sendTelemetry("ended");
        Serial.println("[MENTOR_SPEAKER] stream ended");
        activeSessionId[0] = '\0';
      }
    }
    return;
  }

  if (receiver.type == FRAME_PING) sendTelemetry("pong");
}

bool parseFrameHeader() {
  if (memcmp(receiver.header, "CMSP", 4) != 0 || receiver.header[4] != PROTOCOL_VERSION) return false;
  receiver.type = receiver.header[5];
  receiver.sequence = (static_cast<uint32_t>(receiver.header[8]) << 24)
    | (static_cast<uint32_t>(receiver.header[9]) << 16)
    | (static_cast<uint32_t>(receiver.header[10]) << 8)
    | static_cast<uint32_t>(receiver.header[11]);
  receiver.payloadLength = (static_cast<uint32_t>(receiver.header[12]) << 24)
    | (static_cast<uint32_t>(receiver.header[13]) << 16)
    | (static_cast<uint32_t>(receiver.header[14]) << 8)
    | static_cast<uint32_t>(receiver.header[15]);
  if (receiver.payloadLength > MAX_FRAME_BYTES) return false;
  if (receiver.type == FRAME_PCM) {
    receiver.discardPayload = !activeSessionId[0]
      || receiver.sequence <= lastSequence;
  } else if (receiver.payloadLength >= sizeof(receiver.controlPayload)) {
    return false;
  }
  return true;
}

void receiveFrames() {
  uint8_t temporary[512];
  uint8_t decodedPcm[2048];
  size_t processedBytes = 0;
  while (audioClient.connected() && audioClient.available() > 0
         && processedBytes < RECEIVE_BUDGET_BYTES) {
    if (receiver.headerBytes < FRAME_HEADER_BYTES) {
      const size_t wanted = FRAME_HEADER_BYTES - receiver.headerBytes;
      const size_t received = audioClient.read(
        receiver.header + receiver.headerBytes,
        std::min<size_t>(wanted, audioClient.available())
      );
      if (received == 0) break;
      receiver.headerBytes += received;
      processedBytes += received;
      if (receiver.headerBytes < FRAME_HEADER_BYTES) break;
      if (!parseFrameHeader()) {
        sendTelemetry("error", "invalid_frame_header");
        audioClient.stop();
        return;
      }
    }

    const size_t remaining = receiver.payloadLength - receiver.payloadRead;
    if (remaining == 0) {
      if (receiver.type != FRAME_PCM) processControlFrame();
      else if (!receiver.discardPayload) lastSequence = receiver.sequence;
      resetReceiver();
      continue;
    }

    size_t readable = std::min<size_t>(
      remaining,
      std::min<size_t>(sizeof(temporary), audioClient.available())
    );
    if (receiver.type == FRAME_PCM && !receiver.discardPayload) {
      readable = std::min(readable, ringFree() / (2 * sizeof(int16_t)));
    }
    if (readable == 0) break;
    const size_t received = audioClient.read(temporary, readable);
    if (received == 0) break;
    processedBytes += received;
    if (receiver.type == FRAME_PCM) {
      if (!receiver.discardPayload) {
        for (size_t index = 0; index < received; ++index) {
          const int16_t first = decodeImaAdpcmNibble(temporary[index] & 0x0f);
          const int16_t second = decodeImaAdpcmNibble(temporary[index] >> 4);
          memcpy(decodedPcm + index * 4, &first, sizeof(first));
          memcpy(decodedPcm + index * 4 + sizeof(first), &second, sizeof(second));
        }
        const size_t decodedBytes = received * 2 * sizeof(int16_t);
        const size_t written = ringWrite(decodedPcm, decodedBytes);
        streamReceivedHash = updateFnv1a(streamReceivedHash, decodedPcm, written);
        streamReceivedBytes += written;
        lastPcmMs = millis();
      }
    } else {
      memcpy(receiver.controlPayload + receiver.payloadRead, temporary, received);
    }
    receiver.payloadRead += received;
    if (receiver.payloadRead == receiver.payloadLength) {
      if (receiver.type != FRAME_PCM) processControlFrame();
      else if (!receiver.discardPayload) lastSequence = receiver.sequence;
      resetReceiver();
    }
  }
}

void servicePlayback() {
  if (!activeSessionId[0] || !i2sTx) return;
  const uint32_t now = millis();
  if (i2sWindowStartedMs == 0) i2sWindowStartedMs = now;
  if (now - i2sWindowStartedMs >= 1000) {
    const uint32_t elapsed = now - i2sWindowStartedMs;
    i2sBytesPerSecond = static_cast<uint32_t>(
      (static_cast<uint64_t>(i2sWindowBytes) * 1000ULL) / elapsed
    );
    i2sTimeoutsPerSecond = i2sWindowTimeouts;
    i2sWindowStartedMs = now;
    i2sWindowBytes = 0;
    i2sWindowTimeouts = 0;
  }
  if (prebuffering) {
    const size_t bufferedBytes = ringCount();
    if (bufferedBytes < PREBUFFER_BYTES && !(streamEnding && bufferedBytes > 0)) return;
    prebuffering = false;
    speakerPlaying = true;
    sendTelemetry("playing");
  }

  if (ringCount() > 0) {
    starvationStartedMs = 0;
    uint8_t monoBytes[512];
    int16_t stereoSamples[512];
    uint32_t generation = 0;
    const size_t monoLength = ringPeek(monoBytes, sizeof(monoBytes), generation)
      & ~static_cast<size_t>(1);
    const size_t sampleCount = monoLength / sizeof(int16_t);
    for (size_t index = 0; index < sampleCount; ++index) {
      int16_t sample;
      memcpy(&sample, monoBytes + index * 2, sizeof(sample));
      const int32_t scaled = (static_cast<int32_t>(sample) * streamVolume) / 100;
      const int16_t output = static_cast<int16_t>(constrain(scaled, -32768L, 32767L));
      const size_t outputIndex = index * 2;
      stereoSamples[outputIndex] = output;
      stereoSamples[outputIndex + 1] = output;
    }
    size_t bytesWritten = 0;
    if (i2sMutex) xSemaphoreTake(i2sMutex, portMAX_DELAY);
    const esp_err_t result = i2s_channel_write(
      i2sTx,
      stereoSamples,
      sampleCount * 2 * sizeof(int16_t),
      &bytesWritten,
      pdMS_TO_TICKS(I2S_WRITE_TIMEOUT_MS)
    );
    if (i2sMutex) xSemaphoreGive(i2sMutex);
    // ESP-IDF may return ESP_ERR_TIMEOUT after accepting part of the buffer.
    // Those bytes have already reached DMA and must not be replayed.
    if (bytesWritten > 0) {
      i2sWindowBytes += bytesWritten;
      const size_t consumedBytes = (bytesWritten / 2) & ~static_cast<size_t>(1);
      streamConsumedHash = updateFnv1a(streamConsumedHash, monoBytes, consumedBytes);
      streamConsumedBytes += consumedBytes;
      ringDiscard(consumedBytes, generation);
    }
    if (result == ESP_ERR_TIMEOUT) i2sWindowTimeouts++;
    if (result != ESP_OK && result != ESP_ERR_TIMEOUT) {
      sendTelemetry("error", "i2s_write_failed");
    }
  }

  const size_t bufferedBytes = ringCount();
  if (streamEnding && bufferedBytes == 0) {
    speakerPlaying = false;
    prebuffering = true;
    streamEnding = false;
    sendTelemetry("ended");
    Serial.printf(
      "[MENTOR_SPEAKER] stream ended received=%lu/%08lx consumed=%lu/%08lx\n",
      static_cast<unsigned long>(streamReceivedBytes),
      static_cast<unsigned long>(streamReceivedHash),
      static_cast<unsigned long>(streamConsumedBytes),
      static_cast<unsigned long>(streamConsumedHash)
    );
    activeSessionId[0] = '\0';
  } else if (!streamEnding && speakerPlaying && bufferedBytes == 0) {
    if (starvationStartedMs == 0) {
      starvationStartedMs = now;
      return;
    }
    if (now - starvationStartedMs < STARVATION_GRACE_MS) return;
    starvationStartedMs = 0;
    speakerPlaying = false;
    prebuffering = true;
    speakerUnderrunCount++;
    sendTelemetry("underrun");
  }
}

void disconnectAudio() {
  const bool wasConnected = speakerConnected;
  audioClient.stop();
  handshakeAccepted = false;
  speakerConnected = false;
  activeSessionId[0] = '\0';
  resetReceiver();
  resetPlayback();
  handshakeLine = "";
  if (wasConnected) Serial.println("[MENTOR_SPEAKER] disconnected");
}

void sendHello() {
  StaticJsonDocument<512> document;
  document["type"] = "hello";
  document["protocolVersion"] = PROTOCOL_VERSION;
  document["boardId"] = speakerConfig.boardId;
  document["token"] = speakerConfig.token;
  JsonObject capabilities = document.createNestedObject("capabilities");
  capabilities["encoding"] = AUDIO_ENCODING;
  capabilities["sampleRate"] = SAMPLE_RATE;
  capabilities["channels"] = 1;
  capabilities["decodedBitsPerSample"] = 16;
  capabilities["bufferBytes"] = RING_BYTES;
  if (socketWriteMutex) xSemaphoreTake(socketWriteMutex, portMAX_DELAY);
  serializeJson(document, audioClient);
  audioClient.write('\n');
  if (socketWriteMutex) xSemaphoreGive(socketWriteMutex);
}

bool receiveHandshake() {
  while (audioClient.available() > 0) {
    const char character = static_cast<char>(audioClient.read());
    if (character == '\n') {
      StaticJsonDocument<256> response;
      const bool valid = !deserializeJson(response, handshakeLine)
        && strcmp(response["type"] | "", "accepted") == 0
        && response["protocolVersion"].as<uint8_t>() == PROTOCOL_VERSION;
      handshakeLine = "";
      if (valid) {
        handshakeAccepted = true;
        speakerConnected = true;
        sendTelemetry("ready");
        Serial.printf("[MENTOR_SPEAKER] connected board=%s\n", speakerConfig.boardId);
        return true;
      }
      audioClient.stop();
      return false;
    }
    if (handshakeLine.length() >= 512) {
      handshakeLine = "";
      audioClient.stop();
      return false;
    }
    handshakeLine += character;
  }
  return false;
}

void mentorSpeakerTask(void*) {
  speakerAvailable = true;
  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      if (audioClient.connected() || handshakeAccepted) disconnectAudio();
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    if (!audioClient.connected()) {
      if (handshakeAccepted) disconnectAudio();
      const uint32_t now = millis();
      if (now - lastConnectAttemptMs >= RECONNECT_MS) {
        lastConnectAttemptMs = now;
        if (audioClient.connect(speakerConfig.host, speakerConfig.port, 2000)) {
          audioClient.setNoDelay(true);
          sendHello();
        }
      }
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    if (!handshakeAccepted) {
      receiveHandshake();
      vTaskDelay(pdMS_TO_TICKS(2));
      continue;
    }

    receiveFrames();
    const uint32_t now = millis();
    if (speakerPlaying && now - lastTelemetryMs >= TELEMETRY_MS) {
      lastTelemetryMs = now;
      sendTelemetry("playing");
    }
    vTaskDelay(pdMS_TO_TICKS(1));
  }
}

void mentorSpeakerPlaybackTask(void*) {
  for (;;) {
    for (uint8_t writeIndex = 0; writeIndex < PLAYBACK_BURST_WRITES; ++writeIndex) {
      servicePlayback();
      if (prebuffering || ringCount() == 0) break;
    }
    vTaskDelay(pdMS_TO_TICKS(prebuffering ? 2 : 1));
  }
}

}  // namespace

bool beginMentorSpeaker(const MentorSpeakerConfig& config) {
  if (audioTaskHandle) return speakerAvailable;
  if (!config.host || !config.host[0] || !config.token || !config.token[0]
      || !config.boardId || !config.boardId[0] || !psramFound()) {
    Serial.println("[MENTOR_SPEAKER] unavailable: configuration or PSRAM missing");
    return false;
  }
  pcmRing.data = static_cast<uint8_t*>(heap_caps_malloc(
    RING_BYTES,
    MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
  ));
  if (!pcmRing.data) {
    Serial.println("[MENTOR_SPEAKER] unavailable: PSRAM allocation failed");
    return false;
  }
  ringMutex = xSemaphoreCreateMutex();
  i2sMutex = xSemaphoreCreateMutex();
  socketWriteMutex = xSemaphoreCreateMutex();
  if (!ringMutex || !i2sMutex || !socketWriteMutex) {
    if (ringMutex) vSemaphoreDelete(ringMutex);
    if (i2sMutex) vSemaphoreDelete(i2sMutex);
    if (socketWriteMutex) vSemaphoreDelete(socketWriteMutex);
    ringMutex = nullptr;
    i2sMutex = nullptr;
    socketWriteMutex = nullptr;
    heap_caps_free(pcmRing.data);
    pcmRing.data = nullptr;
    Serial.println("[MENTOR_SPEAKER] unavailable: synchronization allocation failed");
    return false;
  }
  strlcpy(hostStorage, config.host, sizeof(hostStorage));
  strlcpy(boardIdStorage, config.boardId, sizeof(boardIdStorage));
  strlcpy(tokenStorage, config.token, sizeof(tokenStorage));
  speakerConfig = config;
  speakerConfig.host = hostStorage;
  speakerConfig.boardId = boardIdStorage;
  speakerConfig.token = tokenStorage;
  if (!initializeI2s()) {
    vSemaphoreDelete(ringMutex);
    vSemaphoreDelete(i2sMutex);
    vSemaphoreDelete(socketWriteMutex);
    ringMutex = nullptr;
    i2sMutex = nullptr;
    socketWriteMutex = nullptr;
    heap_caps_free(pcmRing.data);
    pcmRing.data = nullptr;
    Serial.println("[MENTOR_SPEAKER] unavailable: I2S initialization failed");
    return false;
  }
  const BaseType_t playbackCreated = xTaskCreatePinnedToCore(
    mentorSpeakerPlaybackTask,
    "mentorPlayback",
    12288,
    nullptr,
    4,
    &playbackTaskHandle,
    0
  );
  if (playbackCreated != pdPASS) {
    i2s_channel_disable(i2sTx);
    i2s_del_channel(i2sTx);
    i2sTx = nullptr;
    vSemaphoreDelete(ringMutex);
    vSemaphoreDelete(i2sMutex);
    vSemaphoreDelete(socketWriteMutex);
    ringMutex = nullptr;
    i2sMutex = nullptr;
    socketWriteMutex = nullptr;
    heap_caps_free(pcmRing.data);
    pcmRing.data = nullptr;
    Serial.println("[MENTOR_SPEAKER] unavailable: playback task creation failed");
    return false;
  }
  const BaseType_t created = xTaskCreatePinnedToCore(
    mentorSpeakerTask,
    "mentorSpeaker",
    12288,
    nullptr,
    2,
    &audioTaskHandle,
    0
  );
  if (created != pdPASS) {
    vTaskDelete(playbackTaskHandle);
    playbackTaskHandle = nullptr;
    i2s_channel_disable(i2sTx);
    i2s_del_channel(i2sTx);
    i2sTx = nullptr;
    vSemaphoreDelete(ringMutex);
    vSemaphoreDelete(i2sMutex);
    vSemaphoreDelete(socketWriteMutex);
    ringMutex = nullptr;
    i2sMutex = nullptr;
    socketWriteMutex = nullptr;
    heap_caps_free(pcmRing.data);
    pcmRing.data = nullptr;
    Serial.println("[MENTOR_SPEAKER] unavailable: task creation failed");
    return false;
  }
  speakerAvailable = true;
  Serial.printf(
    "[MENTOR_SPEAKER] initialized host=%s port=%u board=%s buffer=%u\n",
    speakerConfig.host,
    speakerConfig.port,
    speakerConfig.boardId,
    static_cast<unsigned int>(RING_BYTES)
  );
  return speakerAvailable;
}

bool mentorSpeakerAvailable() {
  return speakerAvailable;
}

bool mentorSpeakerConnected() {
  return speakerConnected;
}

bool mentorSpeakerPlaying() {
  return speakerPlaying;
}

uint32_t mentorSpeakerUnderruns() {
  return speakerUnderrunCount;
}

uint32_t mentorSpeakerBufferedMs() {
  return speakerBufferedMilliseconds;
}

void mentorSpeakerRecordSensorScan(uint32_t nowMs) {
  const uint32_t previous = speakerPreviousSensorScanMs;
  speakerPreviousSensorScanMs = nowMs;
  if (previous == 0 || !speakerPlaying) return;
  const uint32_t gap = nowMs - previous;
  if (gap > speakerSensorMaxGapMs) speakerSensorMaxGapMs = gap;
}
