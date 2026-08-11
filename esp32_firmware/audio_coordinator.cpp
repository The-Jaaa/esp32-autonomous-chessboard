#include "audio_coordinator.h"

#include <Audio.h>
#include <freertos/semphr.h>

namespace {

constexpr uint32_t RELAY_START_GRACE_MS = 8000;
constexpr uint32_t RELAY_STALL_MS = 5000;
constexpr uint32_t RETRY_DELAYS_MS[] = {2000, 4000, 8000, 16000, 30000};

BoardAudioCoordinatorConfig coordinatorConfig;
SemaphoreHandle_t stateMutex = nullptr;
TaskHandle_t coordinatorTaskHandle = nullptr;
Audio* relayAudio = nullptr;
char desiredMode[16] = "mentor";
char desiredUrl[256] = {0};
char currentMode[16] = "mentor";
char currentState[24] = "starting";
char lastError[128] = {0};
uint32_t desiredRevision = 0;
uint32_t appliedRevision = 0;
uint32_t retryCount = 0;
uint32_t nextRetryAt = 0;
uint32_t relayStartedAt = 0;
uint32_t relayLastRunningAt = 0;
uint32_t statusSequence = 0;

void setStatus(const char* mode, const char* state, const char* error = nullptr) {
  if (stateMutex) xSemaphoreTake(stateMutex, portMAX_DELAY);
  strlcpy(currentMode, mode, sizeof(currentMode));
  strlcpy(currentState, state, sizeof(currentState));
  strlcpy(lastError, error ? error : "", sizeof(lastError));
  statusSequence++;
  if (stateMutex) xSemaphoreGive(stateMutex);
  Serial.printf(
    "[AUDIO] mode=%s state=%s retries=%lu%s%s\n",
    mode,
    state,
    static_cast<unsigned long>(retryCount),
    error ? " error=" : "",
    error ? error : ""
  );
}

void stopRelay() {
  if (!relayAudio) return;
  relayAudio->stopSong();
  delete relayAudio;
  relayAudio = nullptr;
  delay(60);
}

void startMentor() {
  stopRelay();
  if (beginMentorSpeaker(coordinatorConfig.mentor)) {
    retryCount = 0;
    setStatus("mentor", "ready");
  } else {
    setStatus("mentor", "recovering", "mentor_start_failed");
  }
}

uint32_t retryDelay() {
  size_t index = retryCount > 0 ? retryCount - 1 : 0;
  const size_t lastIndex = (sizeof(RETRY_DELAYS_MS) / sizeof(RETRY_DELAYS_MS[0])) - 1;
  if (index > lastIndex) index = lastIndex;
  return RETRY_DELAYS_MS[index];
}

bool startRelay(const char* url) {
  endMentorSpeaker();
  delay(60);
  setStatus("relay", "relay_connecting");
  relayAudio = new Audio();
  if (!relayAudio) {
    setStatus("mentor", "recovering", "relay_audio_allocation_failed");
    return false;
  }
  relayAudio->setPinout(
    coordinatorConfig.bclkPin,
    coordinatorConfig.lrclkPin,
    coordinatorConfig.dataPin
  );
  relayAudio->setVolume(coordinatorConfig.relayVolume);
  relayAudio->forceMono(true);
  relayAudio->setConnectionTimeout(2500, 2500);
  if (!relayAudio->connecttohost(url, "esp32", coordinatorConfig.token)) {
    stopRelay();
    setStatus("mentor", "recovering", "relay_connect_failed");
    return false;
  }
  relayStartedAt = millis();
  relayLastRunningAt = relayStartedAt;
  appliedRevision = desiredRevision;
  setStatus("relay", "relay_connecting");
  return true;
}

void fallbackAndSchedule(const char* error) {
  stopRelay();
  retryCount++;
  nextRetryAt = millis() + retryDelay();
  beginMentorSpeaker(coordinatorConfig.mentor);
  setStatus("mentor", "recovering", error);
}

void audioCoordinatorTask(void*) {
  startMentor();
  for (;;) {
    char mode[16];
    char url[256];
    uint32_t revision;
    if (stateMutex) xSemaphoreTake(stateMutex, portMAX_DELAY);
    strlcpy(mode, desiredMode, sizeof(mode));
    strlcpy(url, desiredUrl, sizeof(url));
    revision = desiredRevision;
    if (stateMutex) xSemaphoreGive(stateMutex);

    if (strcmp(mode, "mentor") == 0) {
      if (relayAudio || strcmp(currentMode, "mentor") != 0 || appliedRevision != revision) {
        appliedRevision = revision;
        startMentor();
      }
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    if (strcmp(mode, "relay") != 0 || !url[0]) {
      appliedRevision = revision;
      startMentor();
      setStatus("mentor", "recovering", "invalid_relay_state");
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    if (relayAudio && appliedRevision != revision) {
      stopRelay();
      nextRetryAt = 0;
    }

    if (!relayAudio) {
      if (static_cast<int32_t>(millis() - nextRetryAt) >= 0) {
        if (!startRelay(url)) fallbackAndSchedule("relay_connect_failed");
      }
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    relayAudio->loop();
    const uint32_t now = millis();
    if (relayAudio->isRunning()) {
      relayLastRunningAt = now;
      if (strcmp(currentState, "relay") != 0) {
        retryCount = 0;
        setStatus("relay", "relay");
      }
    } else if (now - relayStartedAt > RELAY_START_GRACE_MS
        && now - relayLastRunningAt > RELAY_STALL_MS) {
      fallbackAndSchedule("relay_stream_stalled");
    }
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

}  // namespace

bool beginBoardAudioCoordinator(const BoardAudioCoordinatorConfig& config) {
  if (coordinatorTaskHandle) return true;
  if (!config.mentor.host || !config.mentor.token || !config.token) return false;
  coordinatorConfig = config;
  stateMutex = xSemaphoreCreateMutex();
  if (!stateMutex) return false;
  const BaseType_t created = xTaskCreatePinnedToCore(
    audioCoordinatorTask,
    "audioCoordinator",
    16384,
    nullptr,
    2,
    &coordinatorTaskHandle,
    0
  );
  if (created != pdPASS) {
    vSemaphoreDelete(stateMutex);
    stateMutex = nullptr;
    coordinatorTaskHandle = nullptr;
    return false;
  }
  return true;
}

void applyBoardAudioDesiredState(const char* mode, const char* streamUrl, uint32_t revision) {
  if (!stateMutex) return;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  strlcpy(desiredMode, mode ? mode : "mentor", sizeof(desiredMode));
  strlcpy(desiredUrl, streamUrl ? streamUrl : "", sizeof(desiredUrl));
  desiredRevision = revision;
  xSemaphoreGive(stateMutex);
}

const char* boardAudioMode() { return currentMode; }
const char* boardAudioState() { return currentState; }
const char* boardAudioLastError() { return lastError; }
uint32_t boardAudioRetries() { return retryCount; }
uint32_t boardAudioRevision() { return appliedRevision; }
uint32_t boardAudioStatusSequence() { return statusSequence; }
