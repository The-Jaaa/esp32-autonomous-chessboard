#include "offline_ownership_diagnostics.h"
#include "offline_diagnostic_serial.h"

#if ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS || ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || \
    ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS

#include <OfflineCore.h>

#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <cstdint>
#include <string>

#if ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS
#include "offline_runtime_diagnostics.h"
#endif

extern const char* SERVER_BASE_URL;
extern Adafruit_NeoPixel strip;
extern void setSquareColor(int squareNumber, uint8_t r, uint8_t g, uint8_t b);
extern void clearBoardLeds();

volatile uint32_t ownershipDiagnosticSensorScanCount = 0;
volatile uint32_t ownershipDiagnosticSensorMaxGapMs = 0;
volatile uint32_t ownershipDiagnosticSuccessfulHeartbeats = 0;
volatile uint32_t ownershipDiagnosticHeartbeatAttempts = 0;
volatile uint32_t ownershipDiagnosticHeartbeatMaxElapsedMs = 0;

namespace {

constexpr uint32_t kLedTransitionDurationMs = 1200;
constexpr uint32_t kLedRenderIntervalMs = 100;
constexpr int kCornerSquares[] = {0, 7, 56, 63};

offline::OfflineOwnershipManager liveManager;
volatile int displayedState = static_cast<int>(offline::OwnershipState::BootProbe);
volatile uint32_t displayedStateSinceMs = 0;
bool diagnosticsStarted = false;
bool startEmitted = false;
bool summaryEmitted = false;
bool overallPass = true;
uint32_t heartbeatMaxElapsedMs = 0;
portMUX_TYPE decisionMux = portMUX_INITIALIZER_UNLOCKED;
OfflineOwnershipDiagnosticSnapshot latestDecision;

offline::OwnershipSafety idleSafety() {
  offline::OwnershipSafety safety;
  safety.boardStable = true;
  return safety;
}

offline::OwnershipSafety diagnosticSafety() {
#if ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS
  return offlineRuntimeOwnershipSafety();
#else
  return idleSafety();
#endif
}

void storeDecision(const offline::OwnershipDecision& decision) {
  portENTER_CRITICAL(&decisionMux);
  latestDecision.state = decision.state;
  latestDecision.event = decision.event;
  latestDecision.allowOfflineControl = decision.allowOfflineControl;
  latestDecision.handoffRequired = decision.handoffRequired;
  latestDecision.valid = true;
  portEXIT_CRITICAL(&decisionMux);
}

void emitCheck(const char* name, bool pass) {
  if (!pass) overallPass = false;
  StaticJsonDocument<192> document;
  document["type"] = "check";
  document["name"] = name;
  document["pass"] = pass;
  String payload;
  serializeJson(document, payload);
  emitOfflineDiagnosticJson("OWNERSHIP_DIAG", payload);
}

void publishDecision(
    offline::OwnershipState previous,
    const offline::OwnershipDecision& decision,
    uint32_t nowMs) {
  storeDecision(decision);
  if (decision.state != previous) {
    displayedState = static_cast<int>(decision.state);
    displayedStateSinceMs = nowMs;
  }

  if (decision.state == previous && decision.event == offline::OwnershipEvent::None) return;

  StaticJsonDocument<384> document;
  document["type"] = "transition";
  document["from"] = offline::ownershipStateName(previous);
  document["to"] = offline::ownershipStateName(decision.state);
  document["event"] = offline::ownershipEventName(decision.event);
  document["failures"] = decision.consecutiveFailures;
  document["successes"] = decision.consecutiveSuccesses;
  String payload;
  serializeJson(document, payload);
  emitOfflineDiagnosticJson("OWNERSHIP_DIAG", payload);
}

offline::ServerHeartbeat probeServer() {
  offline::ServerHeartbeat heartbeat;
  if (WiFi.status() != WL_CONNECTED) return heartbeat;

  HTTPClient http;
  http.setConnectTimeout(static_cast<int32_t>(liveManager.config().httpTimeoutMs));
  http.setTimeout(static_cast<uint16_t>(liveManager.config().httpTimeoutMs));
  if (!http.begin(String(SERVER_BASE_URL) + "/api/physical/heartbeat")) return heartbeat;

  const int code = http.GET();
  const String response = code >= 200 && code < 300 ? http.getString() : String();
  http.end();
  if (code < 200 || code >= 300) return heartbeat;

  StaticJsonDocument<768> doc;
  if (deserializeJson(doc, response)) return heartbeat;

  heartbeat.success = doc["success"] | false;
  heartbeat.protocolVersion = doc["protocolVersion"] | 0U;
  heartbeat.serverInstanceId = (doc["serverInstanceId"] | "");
  heartbeat.sessionGeneration = doc["sessionGeneration"] | 0U;
  heartbeat.sessionActive = doc["sessionActive"] | false;
  heartbeat.safeToSwitch = doc["safeToSwitch"] | false;
  return heartbeat;
}

offline::ServerHeartbeat syntheticHeartbeat(
    const char* server = "synthetic-server", uint32_t generation = 1) {
  offline::ServerHeartbeat heartbeat;
  heartbeat.success = true;
  heartbeat.protocolVersion = offline::kOfflineOwnershipProtocolVersion;
  heartbeat.serverInstanceId = server;
  heartbeat.sessionGeneration = generation;
  heartbeat.safeToSwitch = true;
  return heartbeat;
}

bool runSyntheticTransitionSmoke() {
  offline::OfflineOwnershipManager idleManager;
  const auto online = idleManager.observeHeartbeat(0, syntheticHeartbeat());
  if (online.state != offline::OwnershipState::OnlineOwned) return false;

  for (uint32_t now = 1000; now <= 3000; now += 1000) {
    static_cast<void>(idleManager.observeHeartbeat(now, {}, idleSafety()));
  }
  if (idleManager.state() != offline::OwnershipState::OfflineIdle) return false;

  const auto pending = idleManager.observeHeartbeat(4000, syntheticHeartbeat());
  if (pending.state != offline::OwnershipState::ReconnectPending) return false;
  const auto restored = idleManager.observeHeartbeat(5000, syntheticHeartbeat());
  if (restored.state != offline::OwnershipState::OnlineOwned) return false;

  offline::OfflineOwnershipManager pausedManager;
  static_cast<void>(pausedManager.observeHeartbeat(0, syntheticHeartbeat()));
  offline::OwnershipSafety active;
  active.onlineGameActive = true;
  active.motionExecuting = true;
  for (uint32_t now = 1000; now <= 3000; now += 1000) {
    static_cast<void>(pausedManager.observeHeartbeat(now, {}, active));
  }
  if (pausedManager.state() != offline::OwnershipState::OnlinePaused) return false;
  active.motionExecuting = false;
  static_cast<void>(pausedManager.observeHeartbeat(4000, syntheticHeartbeat(), active));
  const auto resumed = pausedManager.observeHeartbeat(5000, syntheticHeartbeat(), active);
  if (resumed.state != offline::OwnershipState::OnlineOwned) return false;
  const auto changed = pausedManager.observeHeartbeat(
      6000, syntheticHeartbeat("replacement-server", 1), active);
  if (changed.state != offline::OwnershipState::RecoveryRequired) return false;

  offline::OfflineOwnershipManager handoffManager;
  static_cast<void>(handoffManager.tick(10000));
  offline::OwnershipSafety offlineGame;
  offlineGame.offlineGameActive = true;
  offlineGame.offlineAtTurnBoundary = false;
  static_cast<void>(
      handoffManager.observeHeartbeat(11000, syntheticHeartbeat(), offlineGame));
  static_cast<void>(
      handoffManager.observeHeartbeat(12000, syntheticHeartbeat(), offlineGame));
  offlineGame.offlineAtTurnBoundary = true;
  const auto handoff = handoffManager.tick(13000, offlineGame);
  return handoff.event == offline::OwnershipEvent::HandoffRequired &&
         handoff.handoffRequired && !handoff.allowNewMotion;
}

void setCorners(uint8_t red, uint8_t green, uint8_t blue) {
  for (const int square : kCornerSquares) {
    setSquareColor(square, red, green, blue);
  }
}

}  // namespace

void beginOfflineOwnershipDiagnostics() {
  liveManager.reset(millis());
  storeDecision(liveManager.tick(millis(), diagnosticSafety()));
  displayedState = static_cast<int>(offline::OwnershipState::BootProbe);
  displayedStateSinceMs = millis();
  diagnosticsStarted = true;
}

void runOfflineOwnershipNetworkStep(uint32_t nowMs) {
  if (!diagnosticsStarted) return;

  if (!startEmitted) {
    startEmitted = true;
    StaticJsonDocument<192> document;
    document["type"] = "start";
    document["motorsLocked"] = true;
    document["core"] = xPortGetCoreID();
    document["priority"] = uxTaskPriorityGet(nullptr);
    String payload;
    serializeJson(document, payload);
    emitOfflineDiagnosticJson("OWNERSHIP_DIAG", payload);
  }

  const offline::OwnershipState beforeTick = liveManager.state();
  const auto tick = liveManager.tick(nowMs, diagnosticSafety());
  publishDecision(beforeTick, tick, nowMs);

  if (liveManager.heartbeatDue(nowMs)) {
    ownershipDiagnosticHeartbeatAttempts++;
    const uint32_t heartbeatStartedAtMs = millis();
    const offline::ServerHeartbeat heartbeat = probeServer();
    const uint32_t heartbeatElapsedMs = millis() - heartbeatStartedAtMs;
    heartbeatMaxElapsedMs =
        heartbeatElapsedMs > heartbeatMaxElapsedMs ? heartbeatElapsedMs
                                                   : heartbeatMaxElapsedMs;
    ownershipDiagnosticHeartbeatMaxElapsedMs = heartbeatMaxElapsedMs;
    const offline::OwnershipState beforeHeartbeat = liveManager.state();
    const auto observed =
        liveManager.observeHeartbeat(nowMs, heartbeat, diagnosticSafety());
    if (heartbeat.success) ownershipDiagnosticSuccessfulHeartbeats++;
    publishDecision(beforeHeartbeat, observed, nowMs);
    StaticJsonDocument<256> document;
    document["type"] = "heartbeat";
    document["success"] = heartbeat.success;
    document["state"] = offline::ownershipStateName(observed.state);
    document["generation"] = heartbeat.sessionGeneration;
    document["elapsedMs"] = heartbeatElapsedMs;
    String payload;
    serializeJson(document, payload);
    emitOfflineDiagnosticJson("OWNERSHIP_DIAG", payload);
  }

  if (!summaryEmitted && liveManager.state() == offline::OwnershipState::OnlineOwned &&
      ownershipDiagnosticSuccessfulHeartbeats >= 2 &&
      ownershipDiagnosticSensorScanCount >= 100) {
    const bool syntheticPass = runSyntheticTransitionSmoke();
    emitCheck("synthetic-ownership-transitions", syntheticPass);
    const bool timingPass = ownershipDiagnosticSensorMaxGapMs < 25;
    emitCheck("sensor-loop-timing", timingPass);
    StaticJsonDocument<256> timing;
    timing["type"] = "timing";
    timing["sensorScans"] = ownershipDiagnosticSensorScanCount;
    timing["sensorMaxGapMs"] = ownershipDiagnosticSensorMaxGapMs;
    timing["successfulHeartbeats"] = ownershipDiagnosticSuccessfulHeartbeats;
    timing["heartbeatMaxElapsedMs"] = heartbeatMaxElapsedMs;
    String timingPayload;
    serializeJson(timing, timingPayload);
    emitOfflineDiagnosticJson("OWNERSHIP_DIAG", timingPayload);
    summaryEmitted = true;
    StaticJsonDocument<192> summary;
    summary["type"] = "summary";
    summary["pass"] = overallPass;
    summary["motorsLocked"] = true;
    summary["core"] = xPortGetCoreID();
    summary["priority"] = uxTaskPriorityGet(nullptr);
    String summaryPayload;
    serializeJson(summary, summaryPayload);
    emitOfflineDiagnosticJson("OWNERSHIP_DIAG", summaryPayload);
  }
}

bool copyOfflineOwnershipDiagnosticSnapshot(
    OfflineOwnershipDiagnosticSnapshot& snapshot) {
  portENTER_CRITICAL(&decisionMux);
  snapshot = latestDecision;
  portEXIT_CRITICAL(&decisionMux);
  return snapshot.valid;
}

void updateOfflineOwnershipDiagnosticLeds(uint32_t nowMs) {
  static uint32_t lastRenderMs = 0;
  static int lastRenderedState = -1;
  static bool transitionCleared = false;
  if (nowMs - lastRenderMs < kLedRenderIntervalMs) return;
  lastRenderMs = nowMs;

  const auto state = static_cast<offline::OwnershipState>(displayedState);
  if (lastRenderedState != displayedState) {
    lastRenderedState = displayedState;
    transitionCleared = false;
  }

  const uint32_t stateAgeMs = nowMs - displayedStateSinceMs;
  const bool pulse = ((nowMs / 250U) % 2U) == 0U;
  const bool briefState = state == offline::OwnershipState::OnlineOwned ||
                          state == offline::OwnershipState::OfflineIdle ||
                          state == offline::OwnershipState::ReconnectPending;
  if (briefState && stateAgeMs >= kLedTransitionDurationMs) {
    if (!transitionCleared) {
      clearBoardLeds();
      transitionCleared = true;
    }
    return;
  }

  strip.clear();
  switch (state) {
    case offline::OwnershipState::BootProbe:
      setCorners(0, pulse ? 80 : 20, pulse ? 255 : 80);
      break;
    case offline::OwnershipState::OnlineOwned:
      setCorners(0, 220, 70);
      break;
    case offline::OwnershipState::OfflineIdle:
      setCorners(255, 150, 0);
      break;
    case offline::OwnershipState::ReconnectPending:
      setCorners(pulse ? 0 : 255, pulse ? 120 : 110, pulse ? 255 : 0);
      break;
    case offline::OwnershipState::OnlinePaused:
      setCorners(255, pulse ? 180 : 0, 0);
      break;
    case offline::OwnershipState::RecoveryRequired:
      setCorners(255, 0, pulse ? 170 : 30);
      break;
  }
  strip.show();
}

#endif
