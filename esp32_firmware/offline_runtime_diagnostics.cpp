#include "offline_runtime_diagnostics.h"

#if ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS

#include "offline_ownership_diagnostics.h"

#include <AccelStepper.h>
#include <ArduinoJson.h>
#include <esp_heap_caps.h>
#include <esp_memory_utils.h>
#include <esp_rom_sys.h>

#include <algorithm>
#include <cstdint>
#include <memory>
#include <new>
#include <string>

extern AccelStepper motorA;
extern AccelStepper motorB;
extern bool offlineRuntimeMagnetIsLow();

volatile uint32_t offlineRuntimeSensorScanCount = 0;
volatile uint32_t offlineRuntimeSensorMaxGapMs = 0;
volatile uint32_t offlineRuntimeSnapshotRevision = 0;

namespace {

constexpr std::size_t kRuntimeStackBytes = 49152;
constexpr std::uint32_t kSerialAttachTimeoutMs = 15000;
constexpr std::uint32_t kRuntimeStartupDelayMs = 2000;
constexpr std::uint32_t kLoopDelayMs = 20;
constexpr std::uint32_t kSetupLogIntervalMs = 1000;
constexpr std::size_t kMinimumInternalHeapBytes = 96 * 1024;
constexpr std::size_t kMinimumLargestInternalBlockBytes = 64 * 1024;
constexpr std::size_t kMinimumFreePsramBytes = 5 * 1024 * 1024;
constexpr std::size_t kMinimumStackHeadroomBytes = 2 * 1024;
constexpr std::uint32_t kMaximumSensorGapMs = 25;
constexpr std::uint32_t kSearchOverrunAllowanceMs = 100;

portMUX_TYPE runtimeMux = portMUX_INITIALIZER_UNLOCKED;
offline::Occupancy snapshotMailbox{};
std::uint32_t snapshotMailboxRevision = 0;
std::uint32_t snapshotMailboxChangedAtMs = 0;
bool snapshotMailboxReady = false;
offline::OwnershipSafety publishedSafety;

bool overallPass = true;
bool summaryEmitted = false;
std::uint32_t lastSetupLogMs = 0;
offline::OfflineRuntimePhase lastLoggedPhase = offline::OfflineRuntimePhase::Disabled;
offline::OfflineRuntimeEvent lastLoggedEvent = offline::OfflineRuntimeEvent::None;

void emitDocument(JsonDocument& document) {
  String payload;
  serializeJson(document, payload);
  esp_rom_printf("[OFFLINE_RUNTIME_DIAG] %s\n", payload.c_str());
}

void emitCheck(const char* name, bool pass) {
  if (!pass) overallPass = false;
  StaticJsonDocument<256> document;
  document["type"] = "check";
  document["name"] = name;
  document["pass"] = pass;
  emitDocument(document);
}

std::string occupancyHex(const offline::Occupancy& occupancy) {
  unsigned long long mask = 0;
  for (std::size_t index = 0; index < occupancy.size(); ++index) {
    if (occupancy[index]) mask |= (1ULL << index);
  }
  char text[17] = {};
  snprintf(text, sizeof(text), "%016llX", mask);
  return text;
}

void addStrings(JsonArray array, const std::vector<std::string>& values) {
  for (const std::string& value : values) array.add(value.c_str());
}

void addDifference(JsonObject object, const offline::OccupancyDiff& difference) {
  addStrings(object.createNestedArray("missing"), difference.missing);
  addStrings(object.createNestedArray("extra"), difference.extra);
}

bool copySnapshot(
    offline::Occupancy& occupancy,
    std::uint32_t& revision,
    std::uint32_t& changedAtMs) {
  portENTER_CRITICAL(&runtimeMux);
  const bool ready = snapshotMailboxReady;
  if (ready) {
    occupancy = snapshotMailbox;
    revision = snapshotMailboxRevision;
    changedAtMs = snapshotMailboxChangedAtMs;
  }
  portEXIT_CRITICAL(&runtimeMux);
  return ready;
}

void storeSafety(const offline::OwnershipSafety& safety) {
  portENTER_CRITICAL(&runtimeMux);
  publishedSafety = safety;
  portEXIT_CRITICAL(&runtimeMux);
}

offline::OwnershipDecision ownershipDecision(
    const OfflineOwnershipDiagnosticSnapshot& snapshot) {
  offline::OwnershipDecision decision;
  decision.state = snapshot.state;
  decision.event = snapshot.event;
  decision.allowOfflineControl = snapshot.allowOfflineControl;
  decision.handoffRequired = snapshot.handoffRequired;
  return decision;
}

void emitRuntimeUpdate(
    const offline::OfflineRuntimeUpdate& update, std::uint32_t nowMs) {
  const bool phaseChanged = update.phase != lastLoggedPhase;
  const bool eventChanged = update.event != offline::OfflineRuntimeEvent::None &&
                            (update.event != lastLoggedEvent || phaseChanged);
  const bool setupEvent = update.event == offline::OfflineRuntimeEvent::SetupMismatch ||
                          update.event == offline::OfflineRuntimeEvent::SetupStabilizing;
  if (!phaseChanged && !eventChanged &&
      (!setupEvent || nowMs - lastSetupLogMs < kSetupLogIntervalMs)) {
    return;
  }
  if (setupEvent) lastSetupLogMs = nowMs;
  lastLoggedPhase = update.phase;
  lastLoggedEvent = update.event;

  DynamicJsonDocument document(3072);
  document["type"] = "runtime";
  document["phase"] = offline::offlineRuntimePhaseName(update.phase);
  document["event"] = offline::offlineRuntimeEventName(update.event);
  document["sessionActive"] = update.sessionActive;
  document["frozen"] = update.frozen;
  document["fen"] = update.committedFen.c_str();
  document["message"] = update.message.c_str();
  if (!update.setupDifference.empty()) {
    addDifference(document.createNestedObject("setupDifference"), update.setupDifference);
  }
  if (update.acceptedMove) {
    JsonObject move = document.createNestedObject("acceptedMove");
    move["uci"] = update.acceptedMove->uci.c_str();
    move["san"] = update.acceptedMove->san.c_str();
    move["from"] = update.acceptedMove->from.c_str();
    move["to"] = update.acceptedMove->to.c_str();
  }
  emitDocument(document);
}

void emitSearch(
    const offline::EngineSearchRequest& request,
    const offline::SearchResult& result,
    std::uint32_t sensorScans,
    std::uint32_t heartbeatAttempts) {
  DynamicJsonDocument document(3072);
  document["type"] = "search";
  document["generation"] = request.generation;
  document["fen"] = request.fen.c_str();
  document["bestMove"] = result.bestMove.c_str();
  document["score"] = result.score;
  document["mateIn"] = result.mateIn;
  document["depth"] = result.completedDepth;
  document["nodes"] = result.nodes;
  document["elapsedMs"] = result.elapsedMs;
  document["stopReason"] = offline::searchStopReasonName(result.stopReason);
  document["sensorScansDuringSearch"] = sensorScans;
  document["heartbeatAttemptsDuringSearch"] = heartbeatAttempts;
  addStrings(document.createNestedArray("principalVariation"), result.principalVariation);
  emitDocument(document);
}

void addRouteTargets(JsonArray targets, const std::vector<offline::ExternalRouteTarget>& values) {
  for (const auto& value : values) {
    JsonObject target = targets.createNestedObject();
    target["role"] = value.role.c_str();
    if (!value.square.empty()) target["square"] = value.square.c_str();
    if (value.rawIndex >= 0) target["rawIndex"] = value.rawIndex;
    if (!value.label.empty()) target["label"] = value.label.c_str();
    if (value.lane != '\0') target["lane"] = String(value.lane);
    if (value.rank > 0) target["rank"] = value.rank;
    target["x"] = value.x;
    target["y"] = value.y;
  }
}

void emitMotionPhase(
    std::size_t index, const offline::MotionPhase& phase) {
  DynamicJsonDocument document(6144);
  document["type"] = "phase";
  document["index"] = index;
  document["kind"] = offline::motionPhaseKindName(phase.kind);
  document["from"] = phase.from.c_str();
  document["to"] = phase.to.c_str();
  const String expectedBefore(occupancyHex(phase.expectedBefore).c_str());
  const String expectedAfter(occupancyHex(phase.expectedAfter).c_str());
  document["expectedBefore"] = expectedBefore;
  document["expectedAfter"] = expectedAfter;

  if (phase.transfer) {
    document["routeMode"] = offline::externalRouteModeName(phase.transfer->mode);
    document["routeCost"] = phase.transfer->routeCost;
    addStrings(document.createNestedArray("rawPath"), phase.transfer->rawPathSquares);
    addStrings(
        document.createNestedArray("compressedPath"),
        phase.transfer->compressedPathSquares);
    addRouteTargets(document.createNestedArray("targets"), phase.transfer->targets);
  }
  if (phase.graveyard) {
    document["routeMode"] = offline::externalRouteModeName(phase.graveyard->mode);
    document["routeCost"] = phase.graveyard->routeCost;
    document["routeScore"] = phase.graveyard->routeScore;
    document["graveyard"] = phase.graveyard->slot.label.c_str();
    addStrings(document.createNestedArray("rawPath"), phase.graveyard->rawPathSquares);
    addStrings(
        document.createNestedArray("compressedPath"),
        phase.graveyard->compressedPathSquares);
    addRouteTargets(document.createNestedArray("targets"), phase.graveyard->targets);
  }
  emitDocument(document);
}

bool emitMotionPlan(const offline::OfflineReadOnlyRuntime& runtime) {
  const auto state = runtime.coordinator().currentState();
  const auto transaction = runtime.coordinator().pendingMotionTransaction();
  if (!state.opponentPlan || !transaction) return false;

  DynamicJsonDocument document(4096);
  document["type"] = "plan";
  document["transactionId"] = transaction->transactionId;
  document["engineGeneration"] = transaction->engineGeneration;
  document["preferredMove"] = transaction->preferredMove.c_str();
  document["selectedMove"] = transaction->selectedMove.c_str();
  document["selectedScore"] = transaction->selectedScore;
  document["selectedMateIn"] = transaction->selectedMateIn;
  document["usedFallback"] = transaction->usedFallback;
  document["fallbackReason"] = transaction->fallbackReason.c_str();
  document["strategy"] = offline::motionStrategyName(transaction->motion.strategy);
  document["routeCost"] = transaction->motion.routeCost;
  document["phaseCount"] = transaction->motion.phases.size();
  document["graveyardState"] =
      offline::graveyardSlotStateName(transaction->graveyardState);
  if (!transaction->graveyardSlotKey.empty()) {
    document["graveyardProposal"] = transaction->graveyardSlotKey.c_str();
  }
  document["beforeFen"] = state.opponentPlan->beforeFen.c_str();
  document["previewAfterFen"] = state.opponentPlan->afterFen.c_str();
  const String committedFen(runtime.coordinator().physical().game().fen().c_str());
  const String expectedOccupancy(
      occupancyHex(transaction->motion.finalExpectedOccupancy).c_str());
  document["committedFen"] = committedFen;
  document["expectedOccupancy"] = expectedOccupancy;
  document["rejectedCandidateCount"] = transaction->rejectedCandidates.size();
  emitDocument(document);

  for (std::size_t index = 0; index < transaction->motion.phases.size(); ++index) {
    emitMotionPhase(index, transaction->motion.phases[index]);
  }

  const bool noneVerified = std::none_of(
      transaction->verifiedPhases.begin(),
      transaction->verifiedPhases.end(),
      [](bool verified) { return verified; });
  return runtime.phase() == offline::OfflineRuntimePhase::PlanReady &&
         runtime.coordinator().phase() == offline::OfflineTurnPhase::OpponentMoveReady &&
         runtime.coordinator().physical().game().fen() == state.opponentPlan->beforeFen &&
         transaction->currentPhase == 0 && noneVerified;
}

void emitSummary(
    bool planFrozen,
    std::uint32_t searchSensorScans,
    std::uint32_t searchHeartbeatAttempts,
    std::uint32_t searchElapsedMs,
    long initialMotorA,
    long initialMotorB) {
  const std::size_t internalFree =
      heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t largestInternal =
      heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  const std::size_t stackHeadroom = uxTaskGetStackHighWaterMark(nullptr);
  const bool motorsUnchanged = motorA.currentPosition() == initialMotorA &&
                               motorB.currentPosition() == initialMotorB;
  const bool magnetLow = offlineRuntimeMagnetIsLow();

  emitCheck("motion-plan-frozen", planFrozen);
  emitCheck("motors-unchanged", motorsUnchanged);
  emitCheck("magnet-low", magnetLow);
  emitCheck("internal-heap-threshold", internalFree >= kMinimumInternalHeapBytes);
  emitCheck(
      "largest-internal-block-threshold",
      largestInternal >= kMinimumLargestInternalBlockBytes);
  emitCheck("psram-threshold", psramFree >= kMinimumFreePsramBytes);
  emitCheck("stack-threshold", stackHeadroom >= kMinimumStackHeadroomBytes);
  emitCheck(
      "sensor-loop-progress",
      searchSensorScans > 0 && offlineRuntimeSensorMaxGapMs < kMaximumSensorGapMs);
  emitCheck("heartbeat-progress", searchHeartbeatAttempts >= 2);
  emitCheck(
      "search-deadline",
      searchElapsedMs <= 3000U + kSearchOverrunAllowanceMs);

  DynamicJsonDocument document(1536);
  document["type"] = "summary";
  document["pass"] = overallPass;
  document["motorsLocked"] = true;
  document["magnetLow"] = magnetLow;
  document["opponentMoveCommitted"] = false;
  document["sensorScans"] = offlineRuntimeSensorScanCount;
  document["sensorMaxGapMs"] = offlineRuntimeSensorMaxGapMs;
  document["searchSensorScans"] = searchSensorScans;
  document["heartbeatAttempts"] = ownershipDiagnosticHeartbeatAttempts;
  document["searchHeartbeatAttempts"] = searchHeartbeatAttempts;
  document["heartbeatMaxElapsedMs"] = ownershipDiagnosticHeartbeatMaxElapsedMs;
  document["searchElapsedMs"] = searchElapsedMs;
  document["internalFree"] = internalFree;
  document["largestInternal"] = largestInternal;
  document["psramFree"] = psramFree;
  document["stackHeadroom"] = stackHeadroom;
  document["core"] = xPortGetCoreID();
  document["priority"] = uxTaskPriorityGet(nullptr);
  emitDocument(document);
}

void runtimeTask(void*) {
  const std::uint32_t serialWaitStartedAt = millis();
  while (!Serial && millis() - serialWaitStartedAt < kSerialAttachTimeoutMs) {
    vTaskDelay(pdMS_TO_TICKS(50));
  }
  vTaskDelay(pdMS_TO_TICKS(kRuntimeStartupDelayMs));

  const long initialMotorA = motorA.currentPosition();
  const long initialMotorB = motorB.currentPosition();
  StaticJsonDocument<384> start;
  start["type"] = "start";
  start["motorsLocked"] = true;
  start["magnetLow"] = offlineRuntimeMagnetIsLow();
  start["core"] = xPortGetCoreID();
  start["priority"] = uxTaskPriorityGet(nullptr);
  start["setupStableMs"] = 500;
  start["humanColor"] = "white";
  start["searchTimeMs"] = 3000;
  start["maxDepth"] = 12;
  emitDocument(start);

  emitCheck("psram-found", psramFound());
  if (!psramFound()) {
    emitSummary(false, 0, 0, 0, initialMotorA, initialMotorB);
    vTaskDelete(nullptr);
    return;
  }

  chess::attacks::initAttacks();
  chess::movegen::initEmbeddedBetweenTable();
  const bool tablesReady = chess::attacks::embeddedAttackTablesReady() &&
                           chess::movegen::embeddedBetweenTableReady() &&
                           esp_ptr_external_ram(chess::attacks::embeddedRookAttackTable()) &&
                           esp_ptr_external_ram(chess::attacks::embeddedBishopAttackTable()) &&
                           esp_ptr_external_ram(chess::movegen::embeddedBetweenTable());
  emitCheck("psram-tables-ready", tablesReady);
  if (!tablesReady) {
    emitSummary(false, 0, 0, 0, initialMotorA, initialMotorB);
    vTaskDelete(nullptr);
    return;
  }

  offline::OfflineRuntimeConfig config;
  config.setupStableMs = 500;
  config.coordinator.humanColor = offline::HumanColor::White;
  config.coordinator.searchLimits.timeLimitMs = 3000;
  config.coordinator.searchLimits.maxNodes = 0;
  config.coordinator.searchLimits.maxDepth = 12;
  config.coordinator.externalSlots = offline::defaultExternalSlots();
  std::unique_ptr<offline::OfflineReadOnlyRuntime> runtime(
      new (std::nothrow) offline::OfflineReadOnlyRuntime(config));
  emitCheck("runtime-allocation", runtime != nullptr);
  if (!runtime) {
    emitSummary(false, 0, 0, 0, initialMotorA, initialMotorB);
    vTaskDelete(nullptr);
    return;
  }

  offline::OfflineEngine engine;
  std::uint32_t consumedRevision = 0;
  std::uint32_t searchedGeneration = 0;
  std::uint32_t searchSensorScans = 0;
  std::uint32_t searchHeartbeatAttempts = 0;
  std::uint32_t searchElapsedMs = 0;

  for (;;) {
    offline::Occupancy occupancy;
    std::uint32_t revision = 0;
    std::uint32_t changedAtMs = 0;
    OfflineOwnershipDiagnosticSnapshot ownership;
    if (!copySnapshot(occupancy, revision, changedAtMs) ||
        !copyOfflineOwnershipDiagnosticSnapshot(ownership)) {
      vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
      continue;
    }
    (void)changedAtMs;

    const std::uint32_t nowMs = millis();
    auto update = runtime->applyOwnershipDecision(
        nowMs, ownershipDecision(ownership), occupancy);
    emitRuntimeUpdate(update, nowMs);

    if (revision != consumedRevision) {
      consumedRevision = revision;
      update = runtime->processStableSnapshot(nowMs, occupancy);
      emitRuntimeUpdate(update, nowMs);
    }
    storeSafety(runtime->ownershipSafety(occupancy));

    const auto request = runtime->pendingEngineRequest();
    if (request && request->generation != searchedGeneration) {
      searchedGeneration = request->generation;
      const std::uint32_t scansBefore = offlineRuntimeSensorScanCount;
      const std::uint32_t heartbeatsBefore = ownershipDiagnosticHeartbeatAttempts;
      offlineRuntimeSensorMaxGapMs = 0;
      const offline::SearchResult result = engine.searchFen(request->fen, request->limits);
      searchSensorScans = offlineRuntimeSensorScanCount - scansBefore;
      searchHeartbeatAttempts =
          ownershipDiagnosticHeartbeatAttempts - heartbeatsBefore;
      searchElapsedMs = result.elapsedMs;
      emitSearch(*request, result, searchSensorScans, searchHeartbeatAttempts);

      std::uint32_t latestRevision = 0;
      std::uint32_t latestChangedAtMs = 0;
      if (copySnapshot(occupancy, latestRevision, latestChangedAtMs)) {
        consumedRevision = latestRevision;
      }
      update = runtime->submitEngineResult(request->generation, result, occupancy);
      emitRuntimeUpdate(update, millis());
      storeSafety(runtime->ownershipSafety(occupancy));
    }

    if (!summaryEmitted && runtime->phase() == offline::OfflineRuntimePhase::PlanReady) {
      const bool planFrozen = emitMotionPlan(*runtime);
      emitSummary(
          planFrozen,
          searchSensorScans,
          searchHeartbeatAttempts,
          searchElapsedMs,
          initialMotorA,
          initialMotorB);
      summaryEmitted = true;
    }

    vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
  }
}

}  // namespace

void beginOfflineRuntimeDiagnostics() {
  publishedSafety.boardStable = true;
  const BaseType_t created = xTaskCreatePinnedToCore(
      runtimeTask,
      "offlineRuntime",
      kRuntimeStackBytes,
      nullptr,
      tskIDLE_PRIORITY,
      nullptr,
      0);
  if (created != pdPASS) {
    esp_rom_printf(
        "[OFFLINE_RUNTIME_DIAG] {\"type\":\"summary\",\"pass\":false,"
        "\"error\":\"task-create-failed\"}\n");
  }
}

void publishOfflineRuntimeStableSnapshot(
    const bool occupancy[64], uint32_t nowMs) {
  static offline::Occupancy lastPublished{};
  static bool hasLastPublished = false;
  offline::Occupancy next;
  bool changed = !hasLastPublished;
  for (std::size_t index = 0; index < next.size(); ++index) {
    next[index] = occupancy[index];
    changed = changed || next[index] != lastPublished[index];
  }
  if (!changed) return;

  lastPublished = next;
  hasLastPublished = true;
  portENTER_CRITICAL(&runtimeMux);
  snapshotMailbox = next;
  snapshotMailboxChangedAtMs = nowMs;
  snapshotMailboxRevision++;
  offlineRuntimeSnapshotRevision = snapshotMailboxRevision;
  snapshotMailboxReady = true;
  portEXIT_CRITICAL(&runtimeMux);
}

offline::OwnershipSafety offlineRuntimeOwnershipSafety() {
  offline::OwnershipSafety safety;
  portENTER_CRITICAL(&runtimeMux);
  safety = publishedSafety;
  portEXIT_CRITICAL(&runtimeMux);
  return safety;
}

#endif
