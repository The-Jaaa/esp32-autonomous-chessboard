#include "offline_runtime_diagnostics.h"

#if ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS

#include "offline_ownership_diagnostics.h"
#include "offline_diagnostic_serial.h"
#include "offline_quiet_motion_hardware.h"
#include "offline_capture_motion_hardware.h"
#include "offline_lane_motion_hardware.h"

#include <AccelStepper.h>
#include <ArduinoJson.h>
#include <esp_heap_caps.h>
#include <esp_memory_utils.h>
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

constexpr bool kPhaseExecutionDiagnostic =
    ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS != 0;
constexpr bool kQuietMotionDiagnostic =
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS != 0;
constexpr bool kCaptureMotionDiagnostic =
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS != 0;
constexpr bool kStagedCaptureMotionDiagnostic =
    ENABLE_OFFLINE_STAGED_CAPTURE_MOTION_DIAGNOSTICS != 0;
constexpr bool kCaptureLaneMotionDiagnostic =
    ENABLE_OFFLINE_CAPTURE_LANE_MOTION_DIAGNOSTICS != 0;
constexpr bool kEnPassantMotionDiagnostic =
    ENABLE_OFFLINE_EN_PASSANT_MOTION_DIAGNOSTICS != 0;
constexpr bool kCastlingMotionDiagnostic =
    ENABLE_OFFLINE_CASTLING_MOTION_DIAGNOSTICS != 0;
constexpr bool kPromotionMotionDiagnostic =
    ENABLE_OFFLINE_PROMOTION_MOTION_DIAGNOSTICS != 0;
constexpr bool kUnifiedTurnDiagnostic =
    ENABLE_OFFLINE_UNIFIED_TURN_DIAGNOSTICS != 0;
constexpr bool kLaneMotionDiagnostic =
    ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS != 0;
constexpr bool kLaneBoardFixture = OFFLINE_LANE_MOTION_FIXTURE == 1;

const char* diagnosticPrefix() {
  if (kUnifiedTurnDiagnostic) {
    return "OFFLINE_UNIFIED_TURN_DIAG";
  }
  if (kStagedCaptureMotionDiagnostic) {
    return "OFFLINE_STAGED_CAPTURE_MOTION_DIAG";
  }
  if (kCaptureLaneMotionDiagnostic) {
    return "OFFLINE_CAPTURE_LANE_MOTION_DIAG";
  }
  if (kEnPassantMotionDiagnostic) {
    return "OFFLINE_EN_PASSANT_MOTION_DIAG";
  }
  if (kCastlingMotionDiagnostic) {
    return "OFFLINE_CASTLING_MOTION_DIAG";
  }
  if (kPromotionMotionDiagnostic) {
    return "OFFLINE_PROMOTION_MOTION_DIAG";
  }
  if (kCaptureMotionDiagnostic) return "OFFLINE_CAPTURE_MOTION_DIAG";
  if (kLaneMotionDiagnostic) return "OFFLINE_LANE_MOTION_DIAG";
  if (kQuietMotionDiagnostic) return "OFFLINE_QUIET_MOTION_DIAG";
  return kPhaseExecutionDiagnostic ? "OFFLINE_PHASE_DIAG" : "OFFLINE_RUNTIME_DIAG";
}

void emitDocument(JsonDocument& document) {
  String payload;
  serializeJson(document, payload);
  emitOfflineDiagnosticJson(diagnosticPrefix(), payload);
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

#if ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS

struct PhaseExecutionDiagnosticResult {
  bool committed = false;
  bool firstPhaseRetryObserved = false;
  bool orderedPhases = true;
  bool realBoardUnchanged = false;
  std::size_t verifiedPhaseCount = 0;
  std::string committedFen;
  std::string actualOccupancy;
  std::string simulatedOccupancy;
};

void emitExecutionUpdate(const offline::OfflinePhaseExecutionUpdate& update) {
  DynamicJsonDocument document(4096);
  document["type"] = "execution";
  document["state"] = offline::offlinePhaseExecutionStateName(update.state);
  document["event"] = offline::offlinePhaseExecutionEventName(update.event);
  document["message"] = update.message.c_str();
  if (update.request) {
    JsonObject token = document.createNestedObject("token");
    token["transactionId"] = update.request->token.transactionId;
    token["phaseIndex"] = update.request->token.phaseIndex;
    token["attempt"] = update.request->token.attempt;
    document["phaseKind"] = offline::motionPhaseKindName(update.request->phase.kind);
    document["from"] = update.request->phase.from.c_str();
    document["to"] = update.request->phase.to.c_str();
    document["expectedBefore"] = occupancyHex(update.request->phase.expectedBefore).c_str();
    document["expectedAfter"] = occupancyHex(update.request->phase.expectedAfter).c_str();
    document["graveyardState"] =
        offline::graveyardSlotStateName(update.request->graveyardState);
    if (!update.request->graveyardSlotKey.empty()) {
      document["graveyardSlot"] = update.request->graveyardSlotKey.c_str();
    }
    if (update.request->phase.transfer) {
      document["routeMode"] =
          offline::externalRouteModeName(update.request->phase.transfer->mode);
      document["routeCost"] = update.request->phase.transfer->routeCost;
    } else if (update.request->phase.graveyard) {
      document["routeMode"] =
          offline::externalRouteModeName(update.request->phase.graveyard->mode);
      document["routeCost"] = update.request->phase.graveyard->routeCost;
    }
  }
  if (update.coordinatorResult && update.coordinatorResult->motionTransaction) {
    document["graveyardStateAfter"] = offline::graveyardSlotStateName(
        update.coordinatorResult->motionTransaction->graveyardState);
    document["verifiedPhaseCount"] = std::count(
        update.coordinatorResult->motionTransaction->verifiedPhases.begin(),
        update.coordinatorResult->motionTransaction->verifiedPhases.end(),
        true);
  }
  if (!update.differenceFromBefore.empty()) {
    addDifference(
        document.createNestedObject("differenceFromBefore"),
        update.differenceFromBefore);
  }
  if (!update.differenceFromExpected.empty()) {
    addDifference(
        document.createNestedObject("differenceFromExpected"),
        update.differenceFromExpected);
  }
  emitDocument(document);
}

void emitPhaseReport(
    const offline::OfflinePhaseExecutionReport& report,
    const char* purpose) {
  StaticJsonDocument<512> document;
  document["type"] = "phase-report";
  document["purpose"] = purpose;
  document["transactionId"] = report.token.transactionId;
  document["phaseIndex"] = report.token.phaseIndex;
  document["attempt"] = report.token.attempt;
  document["success"] = report.success;
  document["occupancy"] = occupancyHex(report.occupancy).c_str();
  emitDocument(document);
}

PhaseExecutionDiagnosticResult runSimulatedPhaseExecution(
    offline::OfflineReadOnlyRuntime& runtime,
    const offline::Occupancy& postHumanOccupancy,
    const std::string& previewAfterFen) {
  PhaseExecutionDiagnosticResult diagnostic;
  diagnostic.simulatedOccupancy = occupancyHex(postHumanOccupancy);
  offline::OfflinePhaseExecutionAdapter adapter(runtime);
  auto update = adapter.begin();
  emitExecutionUpdate(update);
  if (update.state != offline::OfflinePhaseExecutionState::PhaseReady ||
      !update.request) {
    return diagnostic;
  }

  std::size_t expectedPhaseIndex = 0;
  bool injectedFailure = false;
  offline::OfflinePhaseExecutionToken failedToken;
  offline::Occupancy simulatedOccupancy = postHumanOccupancy;

  for (std::size_t guard = 0; guard < 64; ++guard) {
    if (adapter.state() == offline::OfflinePhaseExecutionState::PhaseReady ||
        adapter.state() == offline::OfflinePhaseExecutionState::RetryReady) {
      update = adapter.takeCurrentRequest();
      emitExecutionUpdate(update);
      if (update.state != offline::OfflinePhaseExecutionState::AwaitingReport ||
          !update.request) {
        diagnostic.orderedPhases = false;
        break;
      }

      const auto request = *update.request;
      if (request.token.phaseIndex != expectedPhaseIndex) {
        diagnostic.orderedPhases = false;
        break;
      }

      offline::OfflinePhaseExecutionReport report;
      report.token = request.token;
      if (!injectedFailure) {
        injectedFailure = true;
        failedToken = request.token;
        report.success = false;
        report.occupancy = request.phase.expectedBefore;
        emitPhaseReport(report, "controlled-unchanged-failure");
        update = adapter.submitReport(report);
        emitExecutionUpdate(update);
        diagnostic.firstPhaseRetryObserved =
            update.state == offline::OfflinePhaseExecutionState::RetryReady &&
            update.request &&
            update.request->token.transactionId == failedToken.transactionId &&
            update.request->token.phaseIndex == failedToken.phaseIndex &&
            update.request->token.attempt == failedToken.attempt + 1;
        if (!diagnostic.firstPhaseRetryObserved) break;
        continue;
      }

      if (request.token.phaseIndex == failedToken.phaseIndex &&
          request.token.attempt <= failedToken.attempt) {
        diagnostic.orderedPhases = false;
        break;
      }
      report.success = true;
      report.occupancy = request.phase.expectedAfter;
      simulatedOccupancy = report.occupancy;
      emitPhaseReport(report, "simulated-success");
      update = adapter.submitReport(report);
      emitExecutionUpdate(update);
      diagnostic.verifiedPhaseCount++;
      expectedPhaseIndex++;
      continue;
    }

    if (adapter.state() == offline::OfflinePhaseExecutionState::PromotionPending) {
      const auto state = runtime.coordinator().currentState();
      if (!state.opponentPlan || state.opponentPlan->move.promotion.empty()) {
        diagnostic.orderedPhases = false;
        break;
      }
      const offline::Occupancy expected = state.opponentPlan->expectedOccupancy;
      offline::Occupancy replacementInProgress = expected;
      const int targetIndex = offline::squareToRawIndex(state.opponentPlan->move.to);
      if (targetIndex < 0) {
        diagnostic.orderedPhases = false;
        break;
      }
      replacementInProgress[static_cast<std::size_t>(targetIndex)] = false;
      update = adapter.processPromotionSnapshot(replacementInProgress);
      emitExecutionUpdate(update);
      update = adapter.processPromotionSnapshot(expected);
      emitExecutionUpdate(update);
      update = adapter.confirmPromotion(
          state.opponentPlan->move.promotion.front(), expected);
      emitExecutionUpdate(update);
      simulatedOccupancy = expected;
      continue;
    }

    if (adapter.state() == offline::OfflinePhaseExecutionState::Complete ||
        adapter.state() == offline::OfflinePhaseExecutionState::GameOver) {
      diagnostic.committed =
          runtime.coordinator().physical().game().fen() == previewAfterFen;
      diagnostic.committedFen = runtime.coordinator().physical().game().fen();
      diagnostic.simulatedOccupancy = occupancyHex(simulatedOccupancy);
      break;
    }

    diagnostic.orderedPhases = false;
    break;
  }

  offline::Occupancy actualOccupancy;
  std::uint32_t revision = 0;
  std::uint32_t changedAtMs = 0;
  if (copySnapshot(actualOccupancy, revision, changedAtMs)) {
    (void)revision;
    (void)changedAtMs;
    diagnostic.realBoardUnchanged = actualOccupancy == postHumanOccupancy;
    diagnostic.actualOccupancy = occupancyHex(actualOccupancy);
  }

  DynamicJsonDocument comparison(1024);
  comparison["type"] = "board-comparison";
  comparison["realBoardUnchanged"] = diagnostic.realBoardUnchanged;
  comparison["actualOccupancy"] = diagnostic.actualOccupancy.c_str();
  comparison["simulatedOccupancy"] = diagnostic.simulatedOccupancy.c_str();
  comparison["committedFen"] = diagnostic.committedFen.c_str();
  comparison["previewAfterFen"] = previewAfterFen.c_str();
  emitDocument(comparison);
  return diagnostic;
}

#if ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS

struct QuietMotionDiagnosticResult {
  bool homeSucceeded = false;
  bool programCompiled = false;
  bool primitiveOrderValid = false;
  bool retryObserved = false;
  bool retryExhausted = false;
  bool recoveryRequired = false;
  bool opponentMoveCommitted = false;
  bool finalOccupancyMatched = false;
  bool motorActivity = false;
  bool magnetEverHigh = false;
  bool magnetLow = true;
  std::string selectedMove;
  std::string committedFen;
  std::string actualOccupancy;
  std::string expectedOccupancy;
  String error;
};

void emitQuietHardwareResult(
    const OfflineQuietHardwareResult& result,
    const char* stage) {
  DynamicJsonDocument document(1536);
  document["type"] = "hardware-result";
  document["stage"] = stage;
  document["requestId"] = result.requestId;
  document["success"] = result.success;
  document["homed"] = result.homed;
  document["motorActivity"] = result.motorActivity;
  document["magnetEverHigh"] = result.magnetEverHigh;
  document["magnetLow"] = result.magnetLow;
  document["motorA"] = result.motorAPosition;
  document["motorB"] = result.motorBPosition;
  document["x"] = result.x;
  document["y"] = result.y;
  document["occupancy"] = occupancyHex(result.observedOccupancy).c_str();
  if (result.error.length() > 0) document["error"] = result.error;
  emitDocument(document);
}

void emitQuietProgram(const offline::QuietMotionProgram& program) {
  DynamicJsonDocument document(4096);
  document["type"] = "quiet-program";
  document["status"] = offline::quietMotionCompileStatusName(program.status);
  document["message"] = program.blockedReason.c_str();
  document["move"] = program.moveUci.c_str();
  document["from"] = program.from.c_str();
  document["to"] = program.to.c_str();
  document["sourceRawIndex"] = program.sourceRawIndex;
  document["targetRawIndex"] = program.targetRawIndex;
  document["routeMode"] = offline::externalRouteModeName(program.routeMode);
  document["routeCost"] = program.routeCost;
  document["transactionId"] = program.token.transactionId;
  document["phaseIndex"] = program.token.phaseIndex;
  document["attempt"] = program.token.attempt;
  document["expectedBefore"] = occupancyHex(program.expectedBefore).c_str();
  document["expectedAfter"] = occupancyHex(program.expectedAfter).c_str();
  addStrings(document.createNestedArray("rawPath"), program.rawPathSquares);
  addStrings(
      document.createNestedArray("compressedPath"),
      program.compressedPathSquares);
  JsonArray primitives = document.createNestedArray("primitives");
  for (const offline::QuietMotionPrimitive& primitive : program.primitives) {
    JsonObject item = primitives.createNestedObject();
    item["kind"] = offline::quietMotionPrimitiveKindName(primitive.kind);
    if (primitive.sourceRawIndex >= 0) {
      item["sourceRawIndex"] = primitive.sourceRawIndex;
    }
    if (primitive.targetRawIndex >= 0) {
      item["targetRawIndex"] = primitive.targetRawIndex;
    }
    item["finalBoardDrop"] = primitive.finalBoardDrop;
  }
  emitDocument(document);
}

bool waitForQuietHardwareResult(
    std::uint32_t requestId,
    std::uint32_t timeoutMs,
    OfflineQuietHardwareResult& result) {
  const std::uint32_t startedAt = millis();
  while (millis() - startedAt < timeoutMs) {
    if (takeOfflineQuietHardwareResult(requestId, result)) return true;
    vTaskDelay(pdMS_TO_TICKS(20));
  }
  return false;
}

bool runQuietHomeGate(QuietMotionDiagnosticResult& diagnostic) {
  StaticJsonDocument<256> waiting;
  waiting["type"] = "home";
  waiting["event"] = "waiting_for_offline_idle";
  waiting["axisTimeoutMs"] = 20000;
  emitDocument(waiting);

  OfflineOwnershipDiagnosticSnapshot ownership;
  for (;;) {
    if (copyOfflineOwnershipDiagnosticSnapshot(ownership) &&
        ownership.valid &&
        ownership.state == offline::OwnershipState::OfflineIdle &&
        ownership.allowOfflineControl) {
      break;
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }

  constexpr std::uint32_t kHomeRequestId = 1;
  if (!queueOfflineQuietHome(kHomeRequestId)) {
    diagnostic.error = "Could not queue the bounded homing job.";
    return false;
  }
  StaticJsonDocument<256> queued;
  queued["type"] = "home";
  queued["event"] = "queued";
  queued["requestId"] = kHomeRequestId;
  emitDocument(queued);

  OfflineQuietHardwareResult result;
  if (!waitForQuietHardwareResult(kHomeRequestId, 50000, result)) {
    abortOfflineQuietMotionHardware();
    diagnostic.error = "Bounded homing did not return a result within 50 seconds.";
    return false;
  }
  emitQuietHardwareResult(result, "home");
  diagnostic.homeSucceeded = result.success && result.homed &&
                             result.magnetLow && result.motorActivity;
  if (!diagnostic.homeSucceeded) {
    diagnostic.error = result.error.length() > 0
                           ? result.error
                           : String("Bounded homing failed its safety checks.");
  }
  return diagnostic.homeSucceeded;
}

bool expectedQuietPrimitiveOrder(const offline::QuietMotionProgram& program) {
  if (program.primitives.size() < 5 ||
      program.primitives.front().kind != offline::QuietMotionPrimitiveKind::Travel ||
      program.primitives[1].kind != offline::QuietMotionPrimitiveKind::Pickup ||
      program.primitives[program.primitives.size() - 2].kind !=
          offline::QuietMotionPrimitiveKind::Drop ||
      program.primitives.back().kind != offline::QuietMotionPrimitiveKind::Verify) {
    return false;
  }
  std::size_t finalDragCount = 0;
  for (std::size_t index = 2; index + 2 < program.primitives.size(); ++index) {
    if (program.primitives[index].kind != offline::QuietMotionPrimitiveKind::Drag) {
      return false;
    }
    if (program.primitives[index].finalBoardDrop) finalDragCount++;
  }
  return finalDragCount == 1 &&
         program.primitives[program.primitives.size() - 3].finalBoardDrop;
}

QuietMotionDiagnosticResult runRealQuietMotionExecution(
    offline::OfflineReadOnlyRuntime& runtime,
    const std::string& previewAfterFen) {
  QuietMotionDiagnosticResult diagnostic;
  diagnostic.homeSucceeded = true;
  const auto transaction = runtime.coordinator().pendingMotionTransaction();
  if (!transaction || transaction->motion.phases.size() != 1) {
    diagnostic.error = "The opponent plan is not one quiet motion phase.";
    return diagnostic;
  }
  diagnostic.selectedMove = transaction->selectedMove;

  offline::OfflinePhaseExecutionAdapter adapter(runtime);
  auto update = adapter.begin();
  emitExecutionUpdate(update);
  if (update.state != offline::OfflinePhaseExecutionState::PhaseReady ||
      !update.request) {
    diagnostic.error = "The phase adapter did not issue the quiet phase.";
    return diagnostic;
  }

  std::uint32_t hardwareRequestId = 10;
  for (std::size_t guard = 0; guard < 4; ++guard) {
    if ((adapter.state() != offline::OfflinePhaseExecutionState::PhaseReady &&
         adapter.state() != offline::OfflinePhaseExecutionState::RetryReady) ||
        !adapter.currentRequest()) {
      break;
    }

    const auto request = *adapter.currentRequest();
    const offline::QuietMotionProgram program =
        offline::OfflineQuietMotionCompiler{}.compile(request);
    emitQuietProgram(program);
    diagnostic.programCompiled = program.success();
    diagnostic.primitiveOrderValid = expectedQuietPrimitiveOrder(program);
    diagnostic.expectedOccupancy = occupancyHex(program.expectedAfter);
    if (!program.success() || !diagnostic.primitiveOrderValid) {
      diagnostic.error = program.blockedReason.c_str();
      return diagnostic;
    }
    if (!offline::quietMotionAttemptAllowed(request.token)) {
      diagnostic.retryExhausted = true;
      diagnostic.error = "The single automatic retry was exhausted.";
      return diagnostic;
    }

    update = adapter.takeCurrentRequest();
    emitExecutionUpdate(update);
    if (update.state != offline::OfflinePhaseExecutionState::AwaitingReport) {
      diagnostic.error = "The adapter did not accept the quiet hardware request.";
      return diagnostic;
    }

    const std::uint32_t requestId = hardwareRequestId++;
    if (!queueOfflineQuietProgram(requestId, program)) {
      diagnostic.error = "Could not queue the quiet hardware program.";
      return diagnostic;
    }
    OfflineQuietHardwareResult hardware;
    if (!waitForQuietHardwareResult(requestId, 120000, hardware)) {
      abortOfflineQuietMotionHardware();
      diagnostic.error = "Quiet hardware execution timed out after 120 seconds.";
      return diagnostic;
    }
    emitQuietHardwareResult(hardware, "quiet-move");
    diagnostic.motorActivity = diagnostic.motorActivity || hardware.motorActivity;
    diagnostic.magnetEverHigh = diagnostic.magnetEverHigh || hardware.magnetEverHigh;
    diagnostic.magnetLow = hardware.magnetLow;
    diagnostic.actualOccupancy = occupancyHex(hardware.observedOccupancy);

    offline::OfflinePhaseExecutionReport report;
    report.token = request.token;
    report.success = hardware.success;
    report.occupancy = hardware.observedOccupancy;
    emitPhaseReport(report, hardware.success ? "real-success" : "real-failure");
    update = adapter.submitReport(report);
    emitExecutionUpdate(update);

    if (hardware.success) {
      diagnostic.finalOccupancyMatched =
          hardware.observedOccupancy == program.expectedAfter;
    } else if (hardware.observedOccupancy == program.expectedBefore &&
               request.token.attempt == 1 &&
               update.state == offline::OfflinePhaseExecutionState::RetryReady) {
      diagnostic.retryObserved = true;
      continue;
    } else if (update.state ==
               offline::OfflinePhaseExecutionState::RecoveryRequired) {
      diagnostic.recoveryRequired = true;
      diagnostic.error = hardware.error;
      return diagnostic;
    }

    if (adapter.state() == offline::OfflinePhaseExecutionState::Complete ||
        adapter.state() == offline::OfflinePhaseExecutionState::GameOver) {
      diagnostic.committedFen = runtime.coordinator().physical().game().fen();
      diagnostic.opponentMoveCommitted =
          diagnostic.committedFen == previewAfterFen;
      return diagnostic;
    }
  }

  if (diagnostic.error.length() == 0) {
    diagnostic.error = "Quiet execution stopped before the opponent move committed.";
  }
  return diagnostic;
}

void emitQuietSummary(
    const QuietMotionDiagnosticResult& diagnostic,
    std::uint32_t searchSensorScans,
    std::uint32_t searchHeartbeatAttempts,
    std::uint32_t searchElapsedMs) {
  const std::size_t internalFree =
      heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t largestInternal =
      heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  const std::size_t stackHeadroom = uxTaskGetStackHighWaterMark(nullptr);

  emitCheck("bounded-home", diagnostic.homeSucceeded);
  emitCheck("quiet-program-compiled", diagnostic.programCompiled);
  emitCheck("ordered-primitives", diagnostic.primitiveOrderValid);
  emitCheck("real-motor-activity", diagnostic.motorActivity);
  emitCheck("magnet-activated-for-drag", diagnostic.magnetEverHigh);
  emitCheck("magnet-low", diagnostic.magnetLow && offlineRuntimeMagnetIsLow());
  emitCheck("final-occupancy", diagnostic.finalOccupancyMatched);
  emitCheck("opponent-move-committed", diagnostic.opponentMoveCommitted);
  emitCheck("retry-limit", !diagnostic.retryExhausted);
  emitCheck("no-unresolved-recovery", !diagnostic.recoveryRequired);
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

  DynamicJsonDocument document(2048);
  document["type"] = "summary";
  document["pass"] = overallPass;
  document["homeSucceeded"] = diagnostic.homeSucceeded;
  document["realMotionEnabled"] = true;
  document["motorActivity"] = diagnostic.motorActivity;
  document["magnetEverHigh"] = diagnostic.magnetEverHigh;
  document["magnetLow"] = diagnostic.magnetLow && offlineRuntimeMagnetIsLow();
  document["commandConsumptionBlocked"] = true;
  document["programCompiled"] = diagnostic.programCompiled;
  document["orderedPrimitives"] = diagnostic.primitiveOrderValid;
  document["retryObserved"] = diagnostic.retryObserved;
  document["retryExhausted"] = diagnostic.retryExhausted;
  document["recoveryRequired"] = diagnostic.recoveryRequired;
  document["finalOccupancyMatched"] = diagnostic.finalOccupancyMatched;
  document["opponentMoveCommitted"] = diagnostic.opponentMoveCommitted;
  document["selectedMove"] = diagnostic.selectedMove.c_str();
  document["committedFen"] = diagnostic.committedFen.c_str();
  document["actualOccupancy"] = diagnostic.actualOccupancy.c_str();
  document["expectedOccupancy"] = diagnostic.expectedOccupancy.c_str();
  if (diagnostic.error.length() > 0) document["error"] = diagnostic.error;
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

#endif

#if ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS

struct CaptureMotionDiagnosticResult {
  bool homeSucceeded = false;
  bool programsCompiled = false;
  bool primitiveOrderValid = false;
  bool graveyardTransitionObserved = false;
  bool graveyardOvershootDisabled = false;
  bool attackerStageOvershootEnabled = false;
  bool attackerOvershootEnabled = false;
  bool retryObserved = false;
  bool retryExhausted = false;
  bool recoveryRequired = false;
  bool opponentMoveCommitted = false;
  bool finalOccupancyMatched = false;
  bool motorActivity = false;
  bool magnetEverHigh = false;
  bool magnetLow = true;
  std::size_t verifiedPhaseCount = 0;
  std::string selectedMove;
  std::string graveyardSlot;
  std::string committedFen;
  std::string actualOccupancy;
  std::string expectedOccupancy;
  String error;
};

void emitCaptureHardwareResult(
    const OfflineCaptureHardwareResult& result,
    const char* stage) {
  DynamicJsonDocument document(1536);
  document["type"] = "hardware-result";
  document["stage"] = stage;
  document["requestId"] = result.requestId;
  document["success"] = result.success;
  document["homed"] = result.homed;
  document["motorActivity"] = result.motorActivity;
  document["magnetEverHigh"] = result.magnetEverHigh;
  document["magnetLow"] = result.magnetLow;
  document["motorA"] = result.motorAPosition;
  document["motorB"] = result.motorBPosition;
  document["x"] = result.x;
  document["y"] = result.y;
  document["occupancy"] = occupancyHex(result.observedOccupancy).c_str();
  if (result.error.length() > 0) document["error"] = result.error;
  emitDocument(document);
}

void emitCaptureProgram(
    const offline::CaptureMotionProgram& program,
    const char* type = "capture-program") {
  DynamicJsonDocument document(5120);
  document["type"] = type;
  document["status"] = offline::captureMotionCompileStatusName(program.status);
  document["message"] = program.blockedReason.c_str();
  document["move"] = program.moveUci.c_str();
  document["phaseKind"] = offline::motionPhaseKindName(program.phaseKind);
  document["from"] = program.from.c_str();
  document["to"] = program.to.c_str();
  document["sourceRawIndex"] = program.sourceRawIndex;
  if (program.targetRawIndex >= 0) {
    document["targetRawIndex"] = program.targetRawIndex;
  }
  document["routeMode"] = offline::externalRouteModeName(program.routeMode);
  document["routeCost"] = program.routeCost;
  document["transactionId"] = program.token.transactionId;
  document["phaseIndex"] = program.token.phaseIndex;
  document["attempt"] = program.token.attempt;
  document["graveyardSlot"] = program.graveyardSlotKey.c_str();
  if (!program.graveyardLabel.empty()) {
    document["graveyardLabel"] = program.graveyardLabel.c_str();
    document["graveyardX"] = program.graveyardX;
    document["graveyardY"] = program.graveyardY;
  }
  document["expectedBefore"] = occupancyHex(program.expectedBefore).c_str();
  document["expectedAfter"] = occupancyHex(program.expectedAfter).c_str();
  addStrings(document.createNestedArray("rawPath"), program.rawPathSquares);
  addStrings(
      document.createNestedArray("compressedPath"),
      program.compressedPathSquares);
  addRouteTargets(
      document.createNestedArray("routeTargets"),
      program.routeTargets);
  JsonArray primitives = document.createNestedArray("primitives");
  for (const offline::CaptureMotionPrimitive& primitive : program.primitives) {
    JsonObject item = primitives.createNestedObject();
    item["kind"] = offline::captureMotionPrimitiveKindName(primitive.kind);
    if (primitive.sourceRawIndex >= 0) {
      item["sourceRawIndex"] = primitive.sourceRawIndex;
    }
    if (primitive.targetRawIndex >= 0) {
      item["targetRawIndex"] = primitive.targetRawIndex;
    }
    if (primitive.kind == offline::CaptureMotionPrimitiveKind::DragCoordinate) {
      item["targetX"] = primitive.targetX;
      item["targetY"] = primitive.targetY;
    }
    item["finalBoardDrop"] = primitive.finalBoardDrop;
  }
  emitDocument(document);
}

bool waitForCaptureHardwareResult(
    std::uint32_t requestId,
    std::uint32_t timeoutMs,
    OfflineCaptureHardwareResult& result) {
  const std::uint32_t startedAt = millis();
  while (millis() - startedAt < timeoutMs) {
    if (takeOfflineCaptureHardwareResult(requestId, result)) return true;
    vTaskDelay(pdMS_TO_TICKS(20));
  }
  return false;
}

bool runCaptureHomeGate(CaptureMotionDiagnosticResult& diagnostic) {
  StaticJsonDocument<256> waiting;
  waiting["type"] = "home";
  waiting["event"] = "waiting_for_offline_idle";
  waiting["axisTimeoutMs"] = 20000;
  emitDocument(waiting);

  OfflineOwnershipDiagnosticSnapshot ownership;
  for (;;) {
    if (copyOfflineOwnershipDiagnosticSnapshot(ownership) && ownership.valid &&
        ownership.state == offline::OwnershipState::OfflineIdle &&
        ownership.allowOfflineControl) {
      break;
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }

  constexpr std::uint32_t kHomeRequestId = 1;
  if (!queueOfflineCaptureHome(kHomeRequestId)) {
    diagnostic.error = "Could not queue the bounded capture homing job.";
    return false;
  }
  StaticJsonDocument<256> queued;
  queued["type"] = "home";
  queued["event"] = "queued";
  queued["requestId"] = kHomeRequestId;
  emitDocument(queued);

  OfflineCaptureHardwareResult result;
  if (!waitForCaptureHardwareResult(kHomeRequestId, 50000, result)) {
    abortOfflineCaptureMotionHardware();
    diagnostic.error = "Bounded capture homing timed out after 50 seconds.";
    return false;
  }
  emitCaptureHardwareResult(result, "home");
  diagnostic.homeSucceeded = result.success && result.homed &&
                             result.magnetLow && result.motorActivity;
  if (!diagnostic.homeSucceeded) {
    diagnostic.error = result.error.length() > 0
                           ? result.error
                           : String("Bounded capture homing failed.");
  }
  return diagnostic.homeSucceeded;
}

bool validateCapturePrimitiveOrder(
    const offline::CaptureMotionProgram& program,
    bool& graveyardOvershootDisabled,
    bool& attackerStageOvershootEnabled,
    bool& attackerOvershootEnabled) {
  if (program.primitives.size() < 5 ||
      program.primitives.front().kind !=
          offline::CaptureMotionPrimitiveKind::TravelBoard ||
      program.primitives[1].kind !=
          offline::CaptureMotionPrimitiveKind::Pickup ||
      program.primitives[program.primitives.size() - 2].kind !=
          offline::CaptureMotionPrimitiveKind::Drop ||
      program.primitives.back().kind !=
          offline::CaptureMotionPrimitiveKind::Verify) {
    return false;
  }

  std::size_t coordinateDrags = 0;
  std::size_t boardOvershoots = 0;
  for (std::size_t index = 2; index + 2 < program.primitives.size(); ++index) {
    const auto& primitive = program.primitives[index];
    if (primitive.kind == offline::CaptureMotionPrimitiveKind::DragCoordinate) {
      coordinateDrags++;
    } else if (primitive.kind != offline::CaptureMotionPrimitiveKind::DragBoard) {
      return false;
    }
    if (primitive.finalBoardDrop) boardOvershoots++;
  }

  if (program.phaseKind == offline::MotionPhaseKind::CapturedRemoval) {
    const bool graveyardMatches = kCaptureLaneMotionDiagnostic
        ? program.graveyardLabel == "Z2" &&
              program.graveyardX == 24800 &&
              program.graveyardY == 34450
        : program.graveyardLabel == "I4" &&
              program.graveyardX == 17600 &&
              program.graveyardY == -350;
    graveyardOvershootDisabled =
        coordinateDrags == 1 && boardOvershoots == 0 && graveyardMatches;
    return graveyardOvershootDisabled;
  }
  if (program.phaseKind == offline::MotionPhaseKind::AttackerStage ||
      program.phaseKind == offline::MotionPhaseKind::AttackerFinal) {
    const std::size_t expectedCoordinateDrags =
        kCaptureLaneMotionDiagnostic &&
                program.phaseKind == offline::MotionPhaseKind::AttackerFinal
            ? 2
            : 0;
    const bool overshootEnabled =
        coordinateDrags == expectedCoordinateDrags &&
        boardOvershoots == 1 &&
        program.primitives[program.primitives.size() - 3].finalBoardDrop;
    if (program.phaseKind == offline::MotionPhaseKind::AttackerStage) {
      attackerStageOvershootEnabled = overshootEnabled;
    } else {
      attackerOvershootEnabled = overshootEnabled;
    }
    return overshootEnabled;
  }
  return false;
}

CaptureMotionDiagnosticResult runRealCaptureMotionExecution(
    offline::OfflineReadOnlyRuntime& runtime,
    const std::string& previewAfterFen) {
  CaptureMotionDiagnosticResult diagnostic;
  diagnostic.homeSucceeded = true;
  const auto transaction = runtime.coordinator().pendingMotionTransaction();
  const bool directPlanMatches = transaction &&
      transaction->selectedMove == "d5e4" &&
      transaction->motion.strategy ==
          offline::MotionStrategy::CaptureDirectAfterRemoval &&
      transaction->motion.phases.size() == 2 &&
      transaction->motion.phases[0].kind ==
          offline::MotionPhaseKind::CapturedRemoval &&
      transaction->motion.phases[1].kind ==
          offline::MotionPhaseKind::AttackerFinal;
  const bool stagedPlanMatches = transaction &&
      transaction->selectedMove == "e2d1" &&
      transaction->motion.strategy ==
          offline::MotionStrategy::CaptureStageFirstBoard &&
      transaction->motion.stagingSquare == "e1" &&
      transaction->motion.phases.size() == 3 &&
      transaction->motion.phases[0].kind ==
          offline::MotionPhaseKind::AttackerStage &&
      transaction->motion.phases[1].kind ==
          offline::MotionPhaseKind::CapturedRemoval &&
      transaction->motion.phases[2].kind ==
          offline::MotionPhaseKind::AttackerFinal;
  const bool captureLanePlanMatches = transaction &&
      transaction->selectedMove == "d5e3" &&
      transaction->motion.strategy ==
          offline::MotionStrategy::CaptureDirectAfterRemoval &&
      transaction->motion.routeCost == 1952.0 &&
      transaction->motion.phases.size() == 2 &&
      transaction->motion.phases[0].kind ==
          offline::MotionPhaseKind::CapturedRemoval &&
      transaction->motion.phases[0].graveyard &&
      transaction->motion.phases[0].graveyard->mode ==
          offline::ExternalRouteMode::GraveyardBoardPath &&
      transaction->motion.phases[0].graveyard->routeCost == 652.0 &&
      transaction->motion.phases[1].kind ==
          offline::MotionPhaseKind::AttackerFinal &&
      transaction->motion.phases[1].transfer &&
      transaction->motion.phases[1].transfer->mode ==
          offline::ExternalRouteMode::Lane &&
      transaction->motion.phases[1].transfer->routeCost == 1300.0;
  const bool enPassantPlanMatches = transaction &&
      transaction->selectedMove == "d4e3" &&
      transaction->motion.move.enPassant &&
      transaction->motion.move.capturedSquare == "e4" &&
      transaction->motion.strategy ==
          offline::MotionStrategy::CaptureDirectAfterRemoval &&
      transaction->motion.routeCost == 568.5 &&
      transaction->motion.phases.size() == 2 &&
      transaction->motion.phases[0].kind ==
          offline::MotionPhaseKind::CapturedRemoval &&
      transaction->motion.phases[0].from == "e4" &&
      transaction->motion.phases[0].graveyard &&
      transaction->motion.phases[0].graveyard->mode ==
          offline::ExternalRouteMode::GraveyardBoardPath &&
      transaction->motion.phases[0].graveyard->routeCost == 554.5 &&
      transaction->motion.phases[1].kind ==
          offline::MotionPhaseKind::AttackerFinal &&
      transaction->motion.phases[1].from == "d4" &&
      transaction->motion.phases[1].to == "e3" &&
      transaction->motion.phases[1].transfer &&
      transaction->motion.phases[1].transfer->mode ==
          offline::ExternalRouteMode::BoardDirect &&
      transaction->motion.phases[1].transfer->routeCost == 14.0;
  const char* expectedSlot = kCaptureLaneMotionDiagnostic ? "Z2" : "I4";
  const bool fixturePlanMatches = kStagedCaptureMotionDiagnostic
      ? stagedPlanMatches
      : (kCaptureLaneMotionDiagnostic
             ? captureLanePlanMatches
             : (kEnPassantMotionDiagnostic ? enPassantPlanMatches
                                            : directPlanMatches));
  if (!transaction || transaction->graveyardSlotKey != expectedSlot ||
      !fixturePlanMatches) {
    diagnostic.error = kStagedCaptureMotionDiagnostic
        ? "The opponent plan is not the controlled staged e2d1/I4 capture."
        : (kCaptureLaneMotionDiagnostic
               ? "The opponent plan is not the controlled d5e3/Z2 lane capture."
               : (kEnPassantMotionDiagnostic
                      ? "The opponent plan is not the controlled d4e3/I4 en passant capture."
                      : "The opponent plan is not the controlled d5e4/I4 capture."));
    return diagnostic;
  }
  diagnostic.selectedMove = transaction->selectedMove;
  diagnostic.graveyardSlot = transaction->graveyardSlotKey;

  offline::OfflinePhaseExecutionAdapter adapter(runtime);
  auto update = adapter.begin();
  emitExecutionUpdate(update);
  if (update.state != offline::OfflinePhaseExecutionState::PhaseReady ||
      !update.request) {
    diagnostic.error = "The phase adapter did not issue the first capture phase.";
    return diagnostic;
  }

  std::uint32_t hardwareRequestId = 20;
  bool stageCompiled = false;
  bool removalCompiled = false;
  bool attackerCompiled = false;
  for (std::size_t guard = 0; guard < 8; ++guard) {
    if ((adapter.state() != offline::OfflinePhaseExecutionState::PhaseReady &&
         adapter.state() != offline::OfflinePhaseExecutionState::RetryReady) ||
        !adapter.currentRequest()) {
      break;
    }

    const auto request = *adapter.currentRequest();
    const offline::CaptureMotionProgram program =
        offline::OfflineCaptureMotionCompiler{}.compile(request);
    emitCaptureProgram(program);
    bool graveyardOvershootDisabled = false;
    bool attackerStageOvershootEnabled = false;
    bool attackerOvershootEnabled = false;
    const bool orderValid = validateCapturePrimitiveOrder(
        program,
        graveyardOvershootDisabled,
        attackerStageOvershootEnabled,
        attackerOvershootEnabled);
    if (program.success() &&
        request.phase.kind == offline::MotionPhaseKind::AttackerStage) {
      stageCompiled = true;
    }
    if (program.success() &&
        request.phase.kind == offline::MotionPhaseKind::CapturedRemoval) {
      removalCompiled = true;
    }
    if (program.success() &&
        request.phase.kind == offline::MotionPhaseKind::AttackerFinal) {
      attackerCompiled = true;
    }
    diagnostic.programsCompiled = removalCompiled && attackerCompiled &&
        (!kStagedCaptureMotionDiagnostic || stageCompiled);
    diagnostic.primitiveOrderValid = orderValid;
    diagnostic.graveyardOvershootDisabled =
        diagnostic.graveyardOvershootDisabled || graveyardOvershootDisabled;
    diagnostic.attackerStageOvershootEnabled =
        diagnostic.attackerStageOvershootEnabled ||
        attackerStageOvershootEnabled;
    diagnostic.attackerOvershootEnabled =
        diagnostic.attackerOvershootEnabled || attackerOvershootEnabled;
    if (!program.success() || !orderValid) {
      diagnostic.error = program.blockedReason.c_str();
      return diagnostic;
    }
    if (!offline::captureMotionAttemptAllowed(request.token)) {
      diagnostic.retryExhausted = true;
      diagnostic.error = "The capture phase retry limit was exhausted.";
      return diagnostic;
    }

    update = adapter.takeCurrentRequest();
    emitExecutionUpdate(update);
    if (update.state != offline::OfflinePhaseExecutionState::AwaitingReport) {
      diagnostic.error = "The adapter did not accept the capture hardware request.";
      return diagnostic;
    }

    const std::uint32_t requestId = hardwareRequestId++;
    if (!queueOfflineCaptureProgram(requestId, program)) {
      diagnostic.error = "Could not queue the capture hardware program.";
      return diagnostic;
    }
    OfflineCaptureHardwareResult hardware;
    if (!waitForCaptureHardwareResult(requestId, 120000, hardware)) {
      abortOfflineCaptureMotionHardware();
      diagnostic.error = "Capture hardware execution timed out after 120 seconds.";
      return diagnostic;
    }
    emitCaptureHardwareResult(
        hardware,
        request.phase.kind == offline::MotionPhaseKind::AttackerStage
            ? "attacker-stage"
            : (request.phase.kind == offline::MotionPhaseKind::CapturedRemoval
                   ? "captured-removal"
                   : "attacker-final"));
    diagnostic.motorActivity = diagnostic.motorActivity || hardware.motorActivity;
    diagnostic.magnetEverHigh = diagnostic.magnetEverHigh || hardware.magnetEverHigh;
    diagnostic.magnetLow = hardware.magnetLow;
    diagnostic.actualOccupancy = occupancyHex(hardware.observedOccupancy);

    offline::OfflinePhaseExecutionReport report;
    report.token = request.token;
    report.success = hardware.success;
    report.occupancy = hardware.observedOccupancy;
    emitPhaseReport(report, hardware.success ? "real-success" : "real-failure");
    update = adapter.submitReport(report);
    emitExecutionUpdate(update);

    if (hardware.success) {
      diagnostic.verifiedPhaseCount++;
      if (request.phase.kind == offline::MotionPhaseKind::CapturedRemoval) {
        const auto active = runtime.coordinator().pendingMotionTransaction();
        diagnostic.graveyardTransitionObserved = active &&
            active->graveyardState == offline::GraveyardSlotState::Occupied &&
            active->graveyardSlotKey == expectedSlot;
      } else if (request.phase.kind == offline::MotionPhaseKind::AttackerFinal) {
        diagnostic.expectedOccupancy = occupancyHex(program.expectedAfter);
        diagnostic.finalOccupancyMatched =
            hardware.observedOccupancy == program.expectedAfter;
      }
    } else if (hardware.observedOccupancy == program.expectedBefore &&
               request.token.attempt == 1 &&
               update.state == offline::OfflinePhaseExecutionState::RetryReady) {
      diagnostic.retryObserved = true;
      continue;
    } else if (update.state ==
               offline::OfflinePhaseExecutionState::RecoveryRequired) {
      diagnostic.recoveryRequired = true;
      diagnostic.error = hardware.error;
      return diagnostic;
    }

    if (adapter.state() == offline::OfflinePhaseExecutionState::Complete ||
        adapter.state() == offline::OfflinePhaseExecutionState::GameOver) {
      diagnostic.committedFen = runtime.coordinator().physical().game().fen();
      diagnostic.opponentMoveCommitted =
          diagnostic.committedFen == previewAfterFen;
      diagnostic.programsCompiled = removalCompiled && attackerCompiled &&
          (!kStagedCaptureMotionDiagnostic || stageCompiled);
      return diagnostic;
    }
  }

  if (diagnostic.error.length() == 0) {
    diagnostic.error = "Capture execution stopped before the move committed.";
  }
  return diagnostic;
}

void emitCaptureSummary(
    const CaptureMotionDiagnosticResult& diagnostic,
    std::uint32_t searchSensorScans,
    std::uint32_t searchHeartbeatAttempts,
    std::uint32_t searchElapsedMs) {
  const std::size_t internalFree =
      heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t largestInternal =
      heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  const std::size_t stackHeadroom = uxTaskGetStackHighWaterMark(nullptr);

  emitCheck("bounded-home", diagnostic.homeSucceeded);
  emitCheck("capture-programs-compiled", diagnostic.programsCompiled);
  emitCheck("ordered-primitives", diagnostic.primitiveOrderValid);
  emitCheck("graveyard-no-overshoot", diagnostic.graveyardOvershootDisabled);
  if (kStagedCaptureMotionDiagnostic) {
    emitCheck(
        "attacker-stage-overshoot",
        diagnostic.attackerStageOvershootEnabled);
  }
  emitCheck("attacker-final-overshoot", diagnostic.attackerOvershootEnabled);
  emitCheck("graveyard-pending-to-occupied", diagnostic.graveyardTransitionObserved);
  emitCheck(
      kStagedCaptureMotionDiagnostic ? "three-phases-verified"
                                     : "two-phases-verified",
      diagnostic.verifiedPhaseCount ==
          (kStagedCaptureMotionDiagnostic ? 3U : 2U));
  emitCheck("real-motor-activity", diagnostic.motorActivity);
  emitCheck("magnet-activated-for-drag", diagnostic.magnetEverHigh);
  emitCheck("magnet-low", diagnostic.magnetLow && offlineRuntimeMagnetIsLow());
  emitCheck("final-occupancy", diagnostic.finalOccupancyMatched);
  emitCheck("opponent-move-committed", diagnostic.opponentMoveCommitted);
  emitCheck("retry-limit", !diagnostic.retryExhausted);
  emitCheck("no-unresolved-recovery", !diagnostic.recoveryRequired);
  emitCheck("internal-heap-threshold", internalFree >= kMinimumInternalHeapBytes);
  emitCheck(
      "largest-internal-block-threshold",
      largestInternal >= kMinimumLargestInternalBlockBytes);
  emitCheck("psram-threshold", psramFree >= kMinimumFreePsramBytes);
  emitCheck("stack-threshold", stackHeadroom >= kMinimumStackHeadroomBytes);
  emitCheck(
      "sensor-loop-progress",
      searchSensorScans > 0 && offlineRuntimeSensorMaxGapMs < kMaximumSensorGapMs);
  emitCheck(
      "heartbeat-progress",
      kCaptureLaneMotionDiagnostic || kEnPassantMotionDiagnostic ||
          searchHeartbeatAttempts >= 2);
  emitCheck(
      "search-deadline",
      searchElapsedMs <= 3000U + kSearchOverrunAllowanceMs);

  DynamicJsonDocument document(2560);
  document["type"] = "summary";
  document["pass"] = overallPass;
  document["homeSucceeded"] = diagnostic.homeSucceeded;
  document["realMotionEnabled"] = true;
  document["motorActivity"] = diagnostic.motorActivity;
  document["magnetEverHigh"] = diagnostic.magnetEverHigh;
  document["magnetLow"] = diagnostic.magnetLow && offlineRuntimeMagnetIsLow();
  document["commandConsumptionBlocked"] = true;
  document["programsCompiled"] = diagnostic.programsCompiled;
  document["orderedPrimitives"] = diagnostic.primitiveOrderValid;
  document["graveyardTransitionObserved"] =
      diagnostic.graveyardTransitionObserved;
  document["graveyardOvershootDisabled"] =
      diagnostic.graveyardOvershootDisabled;
  document["attackerStageOvershootEnabled"] =
      diagnostic.attackerStageOvershootEnabled;
  document["attackerOvershootEnabled"] = diagnostic.attackerOvershootEnabled;
  document["verifiedPhaseCount"] = diagnostic.verifiedPhaseCount;
  document["retryObserved"] = diagnostic.retryObserved;
  document["retryExhausted"] = diagnostic.retryExhausted;
  document["recoveryRequired"] = diagnostic.recoveryRequired;
  document["finalOccupancyMatched"] = diagnostic.finalOccupancyMatched;
  document["opponentMoveCommitted"] = diagnostic.opponentMoveCommitted;
  document["selectedMove"] = diagnostic.selectedMove.c_str();
  document["graveyardSlot"] = diagnostic.graveyardSlot.c_str();
  document["committedFen"] = diagnostic.committedFen.c_str();
  document["actualOccupancy"] = diagnostic.actualOccupancy.c_str();
  document["expectedOccupancy"] = diagnostic.expectedOccupancy.c_str();
  if (diagnostic.error.length() > 0) document["error"] = diagnostic.error;
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

#if ENABLE_OFFLINE_CASTLING_MOTION_DIAGNOSTICS

struct CastlingMotionDiagnosticResult {
  bool homeSucceeded = false;
  bool programsCompiled = false;
  bool primitiveOrderValid = false;
  bool kingOvershootEnabled = false;
  bool rookOvershootEnabled = false;
  bool retryObserved = false;
  bool retryExhausted = false;
  bool recoveryRequired = false;
  bool opponentMoveCommitted = false;
  bool finalOccupancyMatched = false;
  bool motorActivity = false;
  bool magnetEverHigh = false;
  bool magnetLow = true;
  std::size_t verifiedPhaseCount = 0;
  std::string selectedMove;
  std::string committedFen;
  std::string actualOccupancy;
  std::string expectedOccupancy;
  String error;
};

bool validateCastlingPrimitiveOrder(
    const offline::CaptureMotionProgram& program,
    bool& finalOvershootEnabled) {
  if (!program.success() || program.primitives.size() < 5 ||
      program.primitives.front().kind !=
          offline::CaptureMotionPrimitiveKind::TravelBoard ||
      program.primitives[1].kind !=
          offline::CaptureMotionPrimitiveKind::Pickup ||
      program.primitives[program.primitives.size() - 2].kind !=
          offline::CaptureMotionPrimitiveKind::Drop ||
      program.primitives.back().kind !=
          offline::CaptureMotionPrimitiveKind::Verify) {
    return false;
  }

  std::size_t boardOvershoots = 0;
  std::size_t lastDragIndex = 0;
  for (std::size_t index = 2; index + 2 < program.primitives.size(); ++index) {
    const auto& primitive = program.primitives[index];
    if (primitive.kind != offline::CaptureMotionPrimitiveKind::DragBoard &&
        primitive.kind != offline::CaptureMotionPrimitiveKind::DragCoordinate) {
      return false;
    }
    if (primitive.finalBoardDrop) boardOvershoots++;
    lastDragIndex = index;
  }
  finalOvershootEnabled = boardOvershoots == 1 &&
      program.primitives[lastDragIndex].kind ==
          offline::CaptureMotionPrimitiveKind::DragBoard &&
      program.primitives[lastDragIndex].finalBoardDrop &&
      program.primitives[lastDragIndex].targetRawIndex == program.targetRawIndex;
  return finalOvershootEnabled && program.graveyardSlotKey.empty() &&
      (program.phaseKind == offline::MotionPhaseKind::CastleKing ||
       program.phaseKind == offline::MotionPhaseKind::CastleRook);
}

CastlingMotionDiagnosticResult runRealCastlingMotionExecution(
    offline::OfflineReadOnlyRuntime& runtime,
    const std::string& previewAfterFen) {
  CastlingMotionDiagnosticResult diagnostic;
  diagnostic.homeSucceeded = true;
  const auto transaction = runtime.coordinator().pendingMotionTransaction();
  const bool fixturePlanMatches = transaction &&
      transaction->selectedMove == "e8g8" &&
      transaction->motion.strategy == offline::MotionStrategy::CastleBoard &&
      transaction->motion.routeCost == 68.0 &&
      transaction->motion.phases.size() == 2 &&
      transaction->motion.phases[0].kind ==
          offline::MotionPhaseKind::CastleKing &&
      transaction->motion.phases[0].from == "e8" &&
      transaction->motion.phases[0].to == "g8" &&
      transaction->motion.phases[0].transfer &&
      transaction->motion.phases[0].transfer->mode ==
          offline::ExternalRouteMode::BoardLine &&
      transaction->motion.phases[0].transfer->routeCost == 20.0 &&
      transaction->motion.phases[1].kind ==
          offline::MotionPhaseKind::CastleRook &&
      transaction->motion.phases[1].from == "h8" &&
      transaction->motion.phases[1].to == "f8" &&
      transaction->motion.phases[1].transfer &&
      transaction->motion.phases[1].transfer->mode ==
          offline::ExternalRouteMode::BoardBuffered &&
      transaction->motion.phases[1].transfer->routeCost == 48.0 &&
      transaction->graveyardSlotKey.empty();
  if (!fixturePlanMatches) {
    diagnostic.error =
        "The opponent plan is not the controlled e8g8 castle-board transaction.";
    return diagnostic;
  }
  diagnostic.selectedMove = transaction->selectedMove;

  offline::OfflinePhaseExecutionAdapter adapter(runtime);
  auto update = adapter.begin();
  emitExecutionUpdate(update);
  if (update.state != offline::OfflinePhaseExecutionState::PhaseReady ||
      !update.request ||
      update.request->phase.kind != offline::MotionPhaseKind::CastleKing) {
    diagnostic.error = "The phase adapter did not issue CastleKing first.";
    return diagnostic;
  }

  std::uint32_t hardwareRequestId = 40;
  bool kingCompiled = false;
  bool rookCompiled = false;
  for (std::size_t guard = 0; guard < 6; ++guard) {
    if ((adapter.state() != offline::OfflinePhaseExecutionState::PhaseReady &&
         adapter.state() != offline::OfflinePhaseExecutionState::RetryReady) ||
        !adapter.currentRequest()) {
      break;
    }

    const auto request = *adapter.currentRequest();
    const offline::CaptureMotionProgram program =
        offline::OfflineCastlingMotionCompiler{}.compile(request);
    emitCaptureProgram(program, "castling-program");
    bool phaseOvershootEnabled = false;
    const bool orderValid =
        validateCastlingPrimitiveOrder(program, phaseOvershootEnabled);
    if (request.phase.kind == offline::MotionPhaseKind::CastleKing &&
        program.success()) {
      kingCompiled = true;
      diagnostic.kingOvershootEnabled = phaseOvershootEnabled;
    } else if (request.phase.kind == offline::MotionPhaseKind::CastleRook &&
               program.success()) {
      rookCompiled = true;
      diagnostic.rookOvershootEnabled = phaseOvershootEnabled;
    }
    diagnostic.programsCompiled = kingCompiled && rookCompiled;
    diagnostic.primitiveOrderValid =
        diagnostic.primitiveOrderValid || orderValid;
    if (!program.success() || !orderValid) {
      diagnostic.error = program.blockedReason.c_str();
      return diagnostic;
    }
    if (!offline::castlingMotionAttemptAllowed(request.token)) {
      diagnostic.retryExhausted = true;
      diagnostic.error = "The castling phase retry limit was exhausted.";
      return diagnostic;
    }

    update = adapter.takeCurrentRequest();
    emitExecutionUpdate(update);
    if (update.state != offline::OfflinePhaseExecutionState::AwaitingReport) {
      diagnostic.error = "The adapter did not accept the castling hardware request.";
      return diagnostic;
    }

    const std::uint32_t requestId = hardwareRequestId++;
    if (!queueOfflineCaptureProgram(requestId, program)) {
      diagnostic.error = "Could not queue the castling hardware program.";
      return diagnostic;
    }
    OfflineCaptureHardwareResult hardware;
    if (!waitForCaptureHardwareResult(requestId, 120000, hardware)) {
      abortOfflineCaptureMotionHardware();
      diagnostic.error = "Castling hardware execution timed out after 120 seconds.";
      return diagnostic;
    }
    emitCaptureHardwareResult(
        hardware,
        request.phase.kind == offline::MotionPhaseKind::CastleKing
            ? "castle-king"
            : "castle-rook");
    diagnostic.motorActivity = diagnostic.motorActivity || hardware.motorActivity;
    diagnostic.magnetEverHigh = diagnostic.magnetEverHigh || hardware.magnetEverHigh;
    diagnostic.magnetLow = hardware.magnetLow;
    diagnostic.actualOccupancy = occupancyHex(hardware.observedOccupancy);

    const offline::OfflinePhaseExecutionReport report{
        request.token, hardware.success, hardware.observedOccupancy};
    emitPhaseReport(report, hardware.success ? "real-success" : "real-failure");
    update = adapter.submitReport(report);
    emitExecutionUpdate(update);

    if (hardware.success) {
      diagnostic.verifiedPhaseCount++;
      if (request.phase.kind == offline::MotionPhaseKind::CastleRook) {
        diagnostic.expectedOccupancy = occupancyHex(program.expectedAfter);
        diagnostic.finalOccupancyMatched =
            hardware.observedOccupancy == program.expectedAfter;
      }
    } else if (hardware.observedOccupancy == program.expectedBefore &&
               request.token.attempt == 1 &&
               update.state == offline::OfflinePhaseExecutionState::RetryReady) {
      diagnostic.retryObserved = true;
      continue;
    } else if (update.state ==
               offline::OfflinePhaseExecutionState::RecoveryRequired) {
      diagnostic.recoveryRequired = true;
      diagnostic.error = hardware.error;
      return diagnostic;
    }

    if (adapter.state() == offline::OfflinePhaseExecutionState::Complete ||
        adapter.state() == offline::OfflinePhaseExecutionState::GameOver) {
      diagnostic.committedFen = runtime.coordinator().physical().game().fen();
      diagnostic.opponentMoveCommitted =
          diagnostic.committedFen == previewAfterFen;
      diagnostic.programsCompiled = kingCompiled && rookCompiled;
      return diagnostic;
    }
  }

  if (diagnostic.error.length() == 0) {
    diagnostic.error = "Castling execution stopped before the move committed.";
  }
  return diagnostic;
}

void emitCastlingSummary(
    const CastlingMotionDiagnosticResult& diagnostic,
    std::uint32_t searchSensorScans,
    std::uint32_t searchHeartbeatAttempts,
    std::uint32_t searchElapsedMs) {
  const std::size_t internalFree =
      heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t largestInternal =
      heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  const std::size_t stackHeadroom = uxTaskGetStackHighWaterMark(nullptr);

  emitCheck("bounded-home", diagnostic.homeSucceeded);
  emitCheck("castling-programs-compiled", diagnostic.programsCompiled);
  emitCheck("ordered-primitives", diagnostic.primitiveOrderValid);
  emitCheck("king-final-overshoot", diagnostic.kingOvershootEnabled);
  emitCheck("rook-final-overshoot", diagnostic.rookOvershootEnabled);
  emitCheck("two-phases-verified", diagnostic.verifiedPhaseCount == 2U);
  emitCheck("real-motor-activity", diagnostic.motorActivity);
  emitCheck("magnet-activated-for-drag", diagnostic.magnetEverHigh);
  emitCheck("magnet-low", diagnostic.magnetLow && offlineRuntimeMagnetIsLow());
  emitCheck("final-occupancy", diagnostic.finalOccupancyMatched);
  emitCheck("opponent-move-committed", diagnostic.opponentMoveCommitted);
  emitCheck("retry-limit", !diagnostic.retryExhausted);
  emitCheck("no-unresolved-recovery", !diagnostic.recoveryRequired);
  emitCheck("internal-heap-threshold", internalFree >= kMinimumInternalHeapBytes);
  emitCheck(
      "largest-internal-block-threshold",
      largestInternal >= kMinimumLargestInternalBlockBytes);
  emitCheck("psram-threshold", psramFree >= kMinimumFreePsramBytes);
  emitCheck("stack-threshold", stackHeadroom >= kMinimumStackHeadroomBytes);
  emitCheck(
      "sensor-loop-progress",
      offlineRuntimeSensorScanCount > 0 &&
          offlineRuntimeSensorMaxGapMs < kMaximumSensorGapMs);
  emitCheck("heartbeat-progress", ownershipDiagnosticHeartbeatAttempts > 0);
  emitCheck(
      "search-deadline",
      searchElapsedMs <= 3000U + kSearchOverrunAllowanceMs);

  DynamicJsonDocument document(2560);
  document["type"] = "summary";
  document["pass"] = overallPass;
  document["homeSucceeded"] = diagnostic.homeSucceeded;
  document["realMotionEnabled"] = true;
  document["motorActivity"] = diagnostic.motorActivity;
  document["magnetEverHigh"] = diagnostic.magnetEverHigh;
  document["magnetLow"] = diagnostic.magnetLow && offlineRuntimeMagnetIsLow();
  document["commandConsumptionBlocked"] = true;
  document["programsCompiled"] = diagnostic.programsCompiled;
  document["orderedPrimitives"] = diagnostic.primitiveOrderValid;
  document["kingOvershootEnabled"] = diagnostic.kingOvershootEnabled;
  document["rookOvershootEnabled"] = diagnostic.rookOvershootEnabled;
  document["verifiedPhaseCount"] = diagnostic.verifiedPhaseCount;
  document["retryObserved"] = diagnostic.retryObserved;
  document["retryExhausted"] = diagnostic.retryExhausted;
  document["recoveryRequired"] = diagnostic.recoveryRequired;
  document["finalOccupancyMatched"] = diagnostic.finalOccupancyMatched;
  document["opponentMoveCommitted"] = diagnostic.opponentMoveCommitted;
  document["selectedMove"] = diagnostic.selectedMove.c_str();
  document["committedFen"] = diagnostic.committedFen.c_str();
  document["actualOccupancy"] = diagnostic.actualOccupancy.c_str();
  document["expectedOccupancy"] = diagnostic.expectedOccupancy.c_str();
  if (diagnostic.error.length() > 0) document["error"] = diagnostic.error;
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

#endif

#if ENABLE_OFFLINE_PROMOTION_MOTION_DIAGNOSTICS

constexpr std::uint32_t kPromotionReplacementTimeoutMs = 180000;

struct PromotionMotionDiagnosticResult {
  bool homeSucceeded = false;
  bool programCompiled = false;
  bool primitiveOrderValid = false;
  bool finalOvershootEnabled = false;
  bool retryObserved = false;
  bool retryExhausted = false;
  bool recoveryRequired = false;
  bool replacementTimedOut = false;
  bool pawnPlacementVerified = false;
  bool liftObserved = false;
  bool replacementObserved = false;
  bool identityConfirmed = false;
  bool opponentMoveCommitted = false;
  bool finalOccupancyMatched = false;
  bool noMotionDuringReplacement = false;
  bool motorActivity = false;
  bool magnetEverHigh = false;
  bool magnetLow = true;
  std::size_t verifiedPhaseCount = 0;
  std::string selectedMove;
  std::string committedFen;
  std::string actualOccupancy;
  std::string expectedOccupancy;
  String error;
};

bool validatePromotionPrimitiveOrder(
    const offline::CaptureMotionProgram& program,
    bool& finalOvershootEnabled) {
  if (!program.success() ||
      program.phaseKind != offline::MotionPhaseKind::QuietTransfer ||
      program.moveUci != "a2a1q" || program.from != "a2" ||
      program.to != "a1" || !program.graveyardSlotKey.empty() ||
      program.primitives.size() != 5 ||
      program.primitives[0].kind !=
          offline::CaptureMotionPrimitiveKind::TravelBoard ||
      program.primitives[1].kind !=
          offline::CaptureMotionPrimitiveKind::Pickup ||
      program.primitives[2].kind !=
          offline::CaptureMotionPrimitiveKind::DragBoard ||
      program.primitives[3].kind !=
          offline::CaptureMotionPrimitiveKind::Drop ||
      program.primitives[4].kind !=
          offline::CaptureMotionPrimitiveKind::Verify) {
    return false;
  }
  finalOvershootEnabled = program.primitives[2].finalBoardDrop &&
      program.primitives[2].targetRawIndex == offline::squareToRawIndex("a1");
  return finalOvershootEnabled;
}

void emitPromotionReplacementUpdate(
    const offline::PromotionReplacementUpdate& update,
    const offline::Occupancy& occupancy) {
  DynamicJsonDocument document(1536);
  document["type"] = "promotion-replacement";
  document["state"] = offline::promotionReplacementStateName(update.state);
  document["event"] = offline::promotionReplacementEventName(update.event);
  document["square"] = "a1";
  document["piece"] = "queen";
  document["promotion"] = "q";
  document["occupancy"] = occupancyHex(occupancy).c_str();
  document["message"] = update.message.c_str();
  if (!update.differenceFromEmpty.empty()) {
    addDifference(
        document.createNestedObject("differenceFromEmpty"),
        update.differenceFromEmpty);
  }
  if (!update.differenceFromExpected.empty()) {
    addDifference(
        document.createNestedObject("differenceFromExpected"),
        update.differenceFromExpected);
  }
  emitDocument(document);
}

PromotionMotionDiagnosticResult runRealPromotionMotionExecution(
    offline::OfflineReadOnlyRuntime& runtime,
    const std::string& previewAfterFen) {
  PromotionMotionDiagnosticResult diagnostic;
  diagnostic.homeSucceeded = true;
  const auto transaction = runtime.coordinator().pendingMotionTransaction();
  const bool fixturePlanMatches = transaction &&
      transaction->selectedMove == "a2a1q" &&
      transaction->motion.move.promotion == "q" &&
      transaction->motion.strategy == offline::MotionStrategy::Quiet &&
      transaction->motion.routeCost == 0.0 &&
      transaction->motion.phases.size() == 1 &&
      transaction->motion.phases[0].kind ==
          offline::MotionPhaseKind::QuietTransfer &&
      transaction->motion.phases[0].from == "a2" &&
      transaction->motion.phases[0].to == "a1" &&
      transaction->motion.phases[0].transfer &&
      transaction->motion.phases[0].transfer->mode ==
          offline::ExternalRouteMode::Direct &&
      transaction->motion.phases[0].transfer->routeCost == 0.0 &&
      transaction->graveyardSlotKey.empty();
  if (!fixturePlanMatches) {
    diagnostic.error =
        "The opponent plan is not the controlled a2a1q direct promotion.";
    return diagnostic;
  }
  diagnostic.selectedMove = transaction->selectedMove;

  offline::OfflinePhaseExecutionAdapter adapter(runtime);
  auto update = adapter.begin();
  emitExecutionUpdate(update);
  std::uint32_t hardwareRequestId = 50;
  offline::Occupancy expectedPromotionOccupancy{};

  for (std::size_t guard = 0; guard < 3; ++guard) {
    if ((adapter.state() != offline::OfflinePhaseExecutionState::PhaseReady &&
         adapter.state() != offline::OfflinePhaseExecutionState::RetryReady) ||
        !adapter.currentRequest()) {
      break;
    }
    const auto request = *adapter.currentRequest();
    const auto program =
        offline::OfflinePromotionMotionCompiler{}.compile(request);
    emitCaptureProgram(program, "promotion-program");
    bool overshoot = false;
    const bool orderValid = validatePromotionPrimitiveOrder(program, overshoot);
    diagnostic.programCompiled = program.success();
    diagnostic.primitiveOrderValid = orderValid;
    diagnostic.finalOvershootEnabled = overshoot;
    if (!program.success() || !orderValid) {
      diagnostic.error = program.blockedReason.c_str();
      return diagnostic;
    }
    if (!offline::promotionMotionAttemptAllowed(request.token)) {
      diagnostic.retryExhausted = true;
      diagnostic.error = "The promotion motion retry limit was exhausted.";
      return diagnostic;
    }

    update = adapter.takeCurrentRequest();
    emitExecutionUpdate(update);
    if (update.state != offline::OfflinePhaseExecutionState::AwaitingReport) {
      diagnostic.error = "The adapter did not accept the promotion hardware request.";
      return diagnostic;
    }

    const std::uint32_t requestId = hardwareRequestId++;
    if (!queueOfflineCaptureProgram(requestId, program)) {
      diagnostic.error = "Could not queue the promotion hardware program.";
      return diagnostic;
    }
    OfflineCaptureHardwareResult hardware;
    if (!waitForCaptureHardwareResult(requestId, 120000, hardware)) {
      abortOfflineCaptureMotionHardware();
      diagnostic.error = "Promotion hardware execution timed out after 120 seconds.";
      return diagnostic;
    }
    emitCaptureHardwareResult(hardware, "promotion-pawn");
    diagnostic.motorActivity = diagnostic.motorActivity || hardware.motorActivity;
    diagnostic.magnetEverHigh = diagnostic.magnetEverHigh || hardware.magnetEverHigh;
    diagnostic.magnetLow = hardware.magnetLow;
    diagnostic.actualOccupancy = occupancyHex(hardware.observedOccupancy);

    const offline::OfflinePhaseExecutionReport report{
        request.token, hardware.success, hardware.observedOccupancy};
    emitPhaseReport(report, hardware.success ? "real-success" : "real-failure");
    update = adapter.submitReport(report);
    emitExecutionUpdate(update);

    if (hardware.success) {
      diagnostic.verifiedPhaseCount = 1;
      diagnostic.pawnPlacementVerified =
          hardware.observedOccupancy == program.expectedAfter;
      diagnostic.finalOccupancyMatched = diagnostic.pawnPlacementVerified;
      diagnostic.expectedOccupancy = occupancyHex(program.expectedAfter);
      expectedPromotionOccupancy = program.expectedAfter;
      break;
    }
    if (hardware.observedOccupancy == program.expectedBefore &&
        request.token.attempt == 1 &&
        update.state == offline::OfflinePhaseExecutionState::RetryReady) {
      diagnostic.retryObserved = true;
      continue;
    }
    if (update.state == offline::OfflinePhaseExecutionState::RecoveryRequired) {
      diagnostic.recoveryRequired = true;
      diagnostic.error = hardware.error;
      return diagnostic;
    }
  }

  if (!diagnostic.pawnPlacementVerified ||
      adapter.state() != offline::OfflinePhaseExecutionState::PromotionPending) {
    diagnostic.error =
        "Pawn placement did not reach promotion replacement pending state.";
    return diagnostic;
  }

  const long replacementMotorA = motorA.currentPosition();
  const long replacementMotorB = motorB.currentPosition();
  offline::OfflinePromotionReplacementGate replacement;
  auto replacementUpdate = replacement.arm(
      "a1", 'q', expectedPromotionOccupancy);
  emitPromotionReplacementUpdate(replacementUpdate, expectedPromotionOccupancy);
  DynamicJsonDocument prompt(512);
  prompt["type"] = "promotion-required";
  prompt["color"] = "black";
  prompt["piece"] = "queen";
  prompt["promotion"] = "q";
  prompt["square"] = "a1";
  prompt["message"] =
      "Replace the Black pawn on a1 with a Black queen.";
  emitDocument(prompt);

  std::uint32_t consumedRevision = 0;
  const std::uint32_t replacementStartedAt = millis();
  while (millis() - replacementStartedAt < kPromotionReplacementTimeoutMs) {
    offline::Occupancy occupancy;
    std::uint32_t revision = 0;
    std::uint32_t changedAtMs = 0;
    if (!copySnapshot(occupancy, revision, changedAtMs) ||
        revision == consumedRevision) {
      vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
      continue;
    }
    (void)changedAtMs;
    consumedRevision = revision;
    replacementUpdate = replacement.processSnapshot(occupancy);
    emitPromotionReplacementUpdate(replacementUpdate, occupancy);

    if (replacementUpdate.event ==
            offline::PromotionReplacementEvent::PawnLifted ||
        replacementUpdate.event ==
            offline::PromotionReplacementEvent::ReplacementReady ||
        replacementUpdate.event ==
            offline::PromotionReplacementEvent::RecoveryRequired ||
        adapter.state() == offline::OfflinePhaseExecutionState::RecoveryRequired) {
      update = adapter.processPromotionSnapshot(occupancy);
      emitExecutionUpdate(update);
    }

    diagnostic.liftObserved = replacement.liftObserved();
    diagnostic.recoveryRequired =
        replacement.state() == offline::PromotionReplacementState::SyncWarning ||
        adapter.state() == offline::OfflinePhaseExecutionState::RecoveryRequired;

    if (replacement.state() ==
            offline::PromotionReplacementState::ReadyToConfirm &&
        adapter.state() == offline::OfflinePhaseExecutionState::PromotionPending) {
      const auto gateConfirmation = replacement.confirm('q', occupancy);
      emitPromotionReplacementUpdate(gateConfirmation, occupancy);
      update = adapter.confirmPromotion('q', occupancy);
      emitExecutionUpdate(update);
      diagnostic.replacementObserved = true;
      diagnostic.identityConfirmed =
          gateConfirmation.state ==
              offline::PromotionReplacementState::Complete;
      diagnostic.recoveryRequired = false;
      diagnostic.actualOccupancy = occupancyHex(occupancy);
      diagnostic.finalOccupancyMatched =
          occupancy == expectedPromotionOccupancy;
      if (adapter.state() == offline::OfflinePhaseExecutionState::Complete ||
          adapter.state() == offline::OfflinePhaseExecutionState::GameOver) {
        diagnostic.committedFen =
            runtime.coordinator().physical().game().fen();
        diagnostic.opponentMoveCommitted =
            diagnostic.committedFen == previewAfterFen;
        break;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(kLoopDelayMs));
  }

  diagnostic.noMotionDuringReplacement =
      motorA.currentPosition() == replacementMotorA &&
      motorB.currentPosition() == replacementMotorB;
  diagnostic.magnetLow = offlineRuntimeMagnetIsLow();
  if (!diagnostic.opponentMoveCommitted) {
    diagnostic.replacementTimedOut =
        millis() - replacementStartedAt >= kPromotionReplacementTimeoutMs;
    if (diagnostic.error.length() == 0) {
      diagnostic.error = diagnostic.replacementTimedOut
          ? "Promotion replacement timed out after 180 seconds."
          : "Promotion replacement did not commit.";
    }
  }
  return diagnostic;
}

void emitPromotionSummary(
    const PromotionMotionDiagnosticResult& diagnostic,
    std::uint32_t searchSensorScans,
    std::uint32_t searchHeartbeatAttempts,
    std::uint32_t searchElapsedMs) {
  const std::size_t internalFree =
      heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t largestInternal =
      heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  const std::size_t stackHeadroom = uxTaskGetStackHighWaterMark(nullptr);

  emitCheck("bounded-home", diagnostic.homeSucceeded);
  emitCheck("promotion-program-compiled", diagnostic.programCompiled);
  emitCheck("ordered-primitives", diagnostic.primitiveOrderValid);
  emitCheck("final-board-overshoot", diagnostic.finalOvershootEnabled);
  emitCheck("pawn-placement-verified", diagnostic.pawnPlacementVerified);
  emitCheck("replacement-lift-observed", diagnostic.liftObserved);
  emitCheck("replacement-reoccupied", diagnostic.replacementObserved);
  emitCheck("promotion-identity-confirmed", diagnostic.identityConfirmed);
  emitCheck("no-motion-during-replacement", diagnostic.noMotionDuringReplacement);
  emitCheck("real-motor-activity", diagnostic.motorActivity);
  emitCheck("magnet-activated-for-drag", diagnostic.magnetEverHigh);
  emitCheck("magnet-low", diagnostic.magnetLow && offlineRuntimeMagnetIsLow());
  emitCheck("final-occupancy", diagnostic.finalOccupancyMatched);
  emitCheck("opponent-move-committed", diagnostic.opponentMoveCommitted);
  emitCheck("retry-limit", !diagnostic.retryExhausted);
  emitCheck("replacement-timeout", !diagnostic.replacementTimedOut);
  emitCheck("no-unresolved-recovery", !diagnostic.recoveryRequired);
  emitCheck("internal-heap-threshold", internalFree >= kMinimumInternalHeapBytes);
  emitCheck(
      "largest-internal-block-threshold",
      largestInternal >= kMinimumLargestInternalBlockBytes);
  emitCheck("psram-threshold", psramFree >= kMinimumFreePsramBytes);
  emitCheck("stack-threshold", stackHeadroom >= kMinimumStackHeadroomBytes);
  emitCheck(
      "sensor-loop-progress",
      offlineRuntimeSensorScanCount > 0 &&
          offlineRuntimeSensorMaxGapMs < kMaximumSensorGapMs);
  emitCheck("heartbeat-progress", ownershipDiagnosticHeartbeatAttempts > 0);
  emitCheck(
      "search-deadline",
      searchElapsedMs <= 3000U + kSearchOverrunAllowanceMs);

  DynamicJsonDocument document(2560);
  document["type"] = "summary";
  document["pass"] = overallPass;
  document["homeSucceeded"] = diagnostic.homeSucceeded;
  document["realMotionEnabled"] = true;
  document["motorActivity"] = diagnostic.motorActivity;
  document["magnetEverHigh"] = diagnostic.magnetEverHigh;
  document["magnetLow"] = diagnostic.magnetLow && offlineRuntimeMagnetIsLow();
  document["commandConsumptionBlocked"] = true;
  document["programCompiled"] = diagnostic.programCompiled;
  document["orderedPrimitives"] = diagnostic.primitiveOrderValid;
  document["finalOvershootEnabled"] = diagnostic.finalOvershootEnabled;
  document["verifiedPhaseCount"] = diagnostic.verifiedPhaseCount;
  document["retryObserved"] = diagnostic.retryObserved;
  document["retryExhausted"] = diagnostic.retryExhausted;
  document["recoveryRequired"] = diagnostic.recoveryRequired;
  document["replacementTimedOut"] = diagnostic.replacementTimedOut;
  document["pawnPlacementVerified"] = diagnostic.pawnPlacementVerified;
  document["liftObserved"] = diagnostic.liftObserved;
  document["replacementObserved"] = diagnostic.replacementObserved;
  document["identityConfirmed"] = diagnostic.identityConfirmed;
  document["noMotionDuringReplacement"] =
      diagnostic.noMotionDuringReplacement;
  document["finalOccupancyMatched"] = diagnostic.finalOccupancyMatched;
  document["opponentMoveCommitted"] = diagnostic.opponentMoveCommitted;
  document["selectedMove"] = diagnostic.selectedMove.c_str();
  document["requestedPromotion"] = "q";
  document["requestedPiece"] = "queen";
  document["promotionSquare"] = "a1";
  document["committedFen"] = diagnostic.committedFen.c_str();
  document["actualOccupancy"] = diagnostic.actualOccupancy.c_str();
  document["expectedOccupancy"] = diagnostic.expectedOccupancy.c_str();
  if (diagnostic.error.length() > 0) document["error"] = diagnostic.error;
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

#endif

#if ENABLE_OFFLINE_UNIFIED_TURN_DIAGNOSTICS
#include "offline_unified_turn_diagnostic.inc"
#endif

#endif

#if ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS

struct LaneMotionDiagnosticResult {
  bool homeSucceeded = false;
  bool programCompiled = false;
  bool primitiveOrderValid = false;
  bool sameSideLane = false;
  bool finalOvershootOnly = false;
  bool noGraveyardState = false;
  bool retryObserved = false;
  bool retryExhausted = false;
  bool recoveryRequired = false;
  bool opponentMoveCommitted = false;
  bool finalOccupancyMatched = false;
  bool motorActivity = false;
  bool magnetEverHigh = false;
  bool magnetLow = true;
  std::size_t verifiedPhaseCount = 0;
  std::string selectedMove;
  std::string routeMode;
  std::string committedFen;
  std::string actualOccupancy;
  std::string expectedOccupancy;
  String error;
};

void emitLaneHardwareResult(
    const OfflineLaneHardwareResult& result,
    const char* stage) {
  DynamicJsonDocument document(1536);
  document["type"] = "hardware-result";
  document["stage"] = stage;
  document["requestId"] = result.requestId;
  document["success"] = result.success;
  document["homed"] = result.homed;
  document["motorActivity"] = result.motorActivity;
  document["magnetEverHigh"] = result.magnetEverHigh;
  document["magnetLow"] = result.magnetLow;
  document["motorA"] = result.motorAPosition;
  document["motorB"] = result.motorBPosition;
  document["x"] = result.x;
  document["y"] = result.y;
  document["occupancy"] = occupancyHex(result.observedOccupancy).c_str();
  if (result.error.length() > 0) document["error"] = result.error;
  emitDocument(document);
}

void emitLaneProgram(const offline::LaneMotionProgram& program) {
  DynamicJsonDocument document(8192);
  document["type"] = "lane-program";
  document["status"] = offline::laneMotionCompileStatusName(program.status);
  document["phaseKind"] = offline::motionPhaseKindName(program.phaseKind);
  document["move"] = program.moveUci.c_str();
  document["from"] = program.from.c_str();
  document["to"] = program.to.c_str();
  document["routeMode"] = offline::externalRouteModeName(program.routeMode);
  document["routeCost"] = program.routeCost;
  document["expectedBefore"] = occupancyHex(program.expectedBefore).c_str();
  document["expectedAfter"] = occupancyHex(program.expectedAfter).c_str();
  document["graveyardSlot"] = program.graveyardSlotKey.c_str();
  addStrings(document.createNestedArray("rawPath"), program.rawPathSquares);
  addStrings(document.createNestedArray("compressedPath"), program.compressedPathSquares);
  addRouteTargets(document.createNestedArray("targets"), program.routeTargets);
  JsonArray primitives = document.createNestedArray("primitives");
  for (const auto& value : program.primitives) {
    JsonObject primitive = primitives.createNestedObject();
    primitive["kind"] = offline::laneMotionPrimitiveKindName(value.kind);
    primitive["sourceRawIndex"] = value.sourceRawIndex;
    primitive["targetRawIndex"] = value.targetRawIndex;
    primitive["x"] = value.targetX;
    primitive["y"] = value.targetY;
    primitive["finalBoardDrop"] = value.finalBoardDrop;
  }
  if (!program.blockedReason.empty()) {
    document["blockedReason"] = program.blockedReason.c_str();
  }
  emitDocument(document);
}

bool waitForLaneHardwareResult(
    std::uint32_t requestId,
    std::uint32_t timeoutMs,
    OfflineLaneHardwareResult& result) {
  const std::uint32_t startedAt = millis();
  while (millis() - startedAt < timeoutMs) {
    if (takeOfflineLaneHardwareResult(requestId, result)) return true;
    vTaskDelay(pdMS_TO_TICKS(10));
  }
  return false;
}

bool runLaneHomeGate(LaneMotionDiagnosticResult& diagnostic) {
  constexpr std::uint32_t kHomeRequestId = 1;
  if (!queueOfflineLaneHome(kHomeRequestId)) {
    diagnostic.error = "Could not queue bounded lane diagnostic homing.";
    return false;
  }
  OfflineLaneHardwareResult hardware;
  if (!waitForLaneHardwareResult(kHomeRequestId, 50000, hardware)) {
    abortOfflineLaneMotionHardware();
    diagnostic.error = "Bounded lane diagnostic homing timed out.";
    return false;
  }
  emitLaneHardwareResult(hardware, "home");
  diagnostic.homeSucceeded = hardware.success && hardware.homed;
  diagnostic.motorActivity = hardware.motorActivity;
  diagnostic.magnetEverHigh = hardware.magnetEverHigh;
  diagnostic.magnetLow = hardware.magnetLow;
  if (!diagnostic.homeSucceeded) diagnostic.error = hardware.error;
  return diagnostic.homeSucceeded;
}

bool validateLaneProgram(
    const offline::LaneMotionProgram& program,
    bool& sameSideLane,
    bool& finalOvershootOnly) {
  const std::size_t expectedBoardDrags = kLaneBoardFixture ? 5U : 1U;
  if (!program.success() || program.primitives.size() != expectedBoardDrags + 6U ||
      program.primitives[0].kind !=
          offline::LaneMotionPrimitiveKind::TravelBoard ||
      program.primitives[1].kind != offline::LaneMotionPrimitiveKind::Pickup ||
      program.primitives[2].kind !=
          offline::LaneMotionPrimitiveKind::DragCoordinate ||
      program.primitives[3].kind !=
          offline::LaneMotionPrimitiveKind::DragCoordinate ||
      program.primitives[program.primitives.size() - 2].kind !=
          offline::LaneMotionPrimitiveKind::Drop ||
      program.primitives.back().kind !=
          offline::LaneMotionPrimitiveKind::Verify) {
    return false;
  }
  for (std::size_t index = 0; index < expectedBoardDrags; ++index) {
    if (program.primitives[index + 4].kind !=
        offline::LaneMotionPrimitiveKind::DragBoard) return false;
  }

  std::size_t overshoots = 0;
  for (const auto& primitive : program.primitives) {
    if (primitive.finalBoardDrop) ++overshoots;
  }
  const auto& finalDrag = program.primitives[3 + expectedBoardDrags];
  finalOvershootOnly = overshoots == 1 && finalDrag.finalBoardDrop &&
      finalDrag.targetRawIndex == offline::squareToRawIndex("e3");

  if (program.routeTargets.size() < 3 ||
      program.routeTargets[0].type != offline::ExternalTargetType::Coordinate ||
      program.routeTargets[1].type != offline::ExternalTargetType::Coordinate) {
    return false;
  }
  sameSideLane = program.routeTargets[0].lane == 'Z' &&
      program.routeTargets[1].lane == 'Z' &&
      program.routeTargets[0].label == "Z5" &&
      program.routeTargets[1].label == "Z3" &&
      program.routeTargets[0].x == 13300 &&
      program.routeTargets[0].y == 34450 &&
      program.routeTargets[1].x == 21300 &&
      program.routeTargets[1].y == 34450;
  return sameSideLane && finalOvershootOnly;
}

LaneMotionDiagnosticResult runRealLaneMotionExecution(
    offline::OfflineReadOnlyRuntime& runtime,
    const std::string& previewAfterFen) {
  LaneMotionDiagnosticResult diagnostic;
  diagnostic.homeSucceeded = true;
  const auto transaction = runtime.coordinator().pendingMotionTransaction();
  const offline::ExternalRouteMode expectedMode = kLaneBoardFixture
      ? offline::ExternalRouteMode::LaneBoard
      : offline::ExternalRouteMode::Lane;
  const int expectedCost = kLaneBoardFixture ? 1366 : 1300;
  if (!transaction || transaction->selectedMove != "d5e3" ||
      transaction->motion.strategy != offline::MotionStrategy::Quiet ||
      transaction->motion.phases.size() != 1 ||
      !transaction->motion.phases[0].transfer ||
      transaction->motion.phases[0].transfer->mode != expectedMode ||
      transaction->motion.phases[0].transfer->routeCost != expectedCost ||
      !transaction->graveyardSlotKey.empty() ||
      transaction->graveyardState != offline::GraveyardSlotState::Free) {
    diagnostic.error = "The opponent plan is not the controlled d5e3 lane fixture.";
    return diagnostic;
  }
  diagnostic.selectedMove = transaction->selectedMove;
  diagnostic.routeMode = offline::externalRouteModeName(expectedMode);
  diagnostic.noGraveyardState = true;

  offline::OfflinePhaseExecutionAdapter adapter(runtime);
  auto update = adapter.begin();
  emitExecutionUpdate(update);
  if (update.state != offline::OfflinePhaseExecutionState::PhaseReady ||
      !update.request) {
    diagnostic.error = "The phase adapter did not issue the lane phase.";
    return diagnostic;
  }

  std::uint32_t hardwareRequestId = 30;
  for (std::size_t guard = 0; guard < 3; ++guard) {
    if ((adapter.state() != offline::OfflinePhaseExecutionState::PhaseReady &&
         adapter.state() != offline::OfflinePhaseExecutionState::RetryReady) ||
        !adapter.currentRequest()) {
      break;
    }
    const auto request = *adapter.currentRequest();
    const offline::LaneMotionProgram program =
        offline::OfflineLaneMotionCompiler{}.compile(request);
    emitLaneProgram(program);
    diagnostic.programCompiled = program.success();
    diagnostic.primitiveOrderValid = validateLaneProgram(
        program, diagnostic.sameSideLane, diagnostic.finalOvershootOnly);
    diagnostic.expectedOccupancy = occupancyHex(program.expectedAfter);
    if (!program.success() || !diagnostic.primitiveOrderValid) {
      diagnostic.error = program.blockedReason.empty()
          ? "The lane primitive sequence did not match the fixture."
          : program.blockedReason.c_str();
      return diagnostic;
    }
    if (!offline::laneMotionAttemptAllowed(request.token)) {
      diagnostic.retryExhausted = true;
      diagnostic.error = "The lane phase retry limit was exhausted.";
      return diagnostic;
    }

    update = adapter.takeCurrentRequest();
    emitExecutionUpdate(update);
    if (update.state != offline::OfflinePhaseExecutionState::AwaitingReport) {
      diagnostic.error = "The adapter did not accept the lane hardware request.";
      return diagnostic;
    }
    const std::uint32_t requestId = hardwareRequestId++;
    if (!queueOfflineLaneProgram(requestId, program)) {
      diagnostic.error = "Could not queue the lane hardware program.";
      return diagnostic;
    }
    OfflineLaneHardwareResult hardware;
    if (!waitForLaneHardwareResult(requestId, 150000, hardware)) {
      abortOfflineLaneMotionHardware();
      diagnostic.error = "Lane hardware execution timed out after 150 seconds.";
      return diagnostic;
    }
    emitLaneHardwareResult(hardware, "lane-transfer");
    diagnostic.motorActivity = diagnostic.motorActivity || hardware.motorActivity;
    diagnostic.magnetEverHigh = diagnostic.magnetEverHigh || hardware.magnetEverHigh;
    diagnostic.magnetLow = hardware.magnetLow;
    diagnostic.actualOccupancy = occupancyHex(hardware.observedOccupancy);

    offline::OfflinePhaseExecutionReport report;
    report.token = request.token;
    report.success = hardware.success;
    report.occupancy = hardware.observedOccupancy;
    emitPhaseReport(report, hardware.success ? "real-success" : "real-failure");
    update = adapter.submitReport(report);
    emitExecutionUpdate(update);

    if (hardware.success) {
      diagnostic.verifiedPhaseCount = 1;
      diagnostic.finalOccupancyMatched =
          hardware.observedOccupancy == program.expectedAfter;
    } else if (hardware.observedOccupancy == program.expectedBefore &&
               request.token.attempt == 1 &&
               update.state == offline::OfflinePhaseExecutionState::RetryReady) {
      diagnostic.retryObserved = true;
      continue;
    } else if (update.state ==
               offline::OfflinePhaseExecutionState::RecoveryRequired) {
      diagnostic.recoveryRequired = true;
      diagnostic.error = hardware.error;
      return diagnostic;
    }

    if (adapter.state() == offline::OfflinePhaseExecutionState::Complete ||
        adapter.state() == offline::OfflinePhaseExecutionState::GameOver) {
      diagnostic.committedFen = runtime.coordinator().physical().game().fen();
      diagnostic.opponentMoveCommitted =
          diagnostic.committedFen == previewAfterFen &&
          runtime.coordinator().physical().game().status().outcome ==
              offline::GameOutcome::Checkmate;
      return diagnostic;
    }
  }
  if (diagnostic.error.length() == 0) {
    diagnostic.error = "Lane execution stopped before the move committed.";
  }
  return diagnostic;
}

void emitLaneSummary(
    const LaneMotionDiagnosticResult& diagnostic,
    std::uint32_t searchSensorScans,
    std::uint32_t searchHeartbeatAttempts,
    std::uint32_t searchElapsedMs) {
  const std::size_t internalFree =
      heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t largestInternal =
      heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const std::size_t psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  const std::size_t stackHeadroom = uxTaskGetStackHighWaterMark(nullptr);

  emitCheck("bounded-home", diagnostic.homeSucceeded);
  emitCheck("lane-program-compiled", diagnostic.programCompiled);
  emitCheck("ordered-primitives", diagnostic.primitiveOrderValid);
  emitCheck("same-side-lane", diagnostic.sameSideLane);
  emitCheck("final-board-only-overshoot", diagnostic.finalOvershootOnly);
  emitCheck("no-graveyard-state", diagnostic.noGraveyardState);
  emitCheck("one-phase-verified", diagnostic.verifiedPhaseCount == 1);
  emitCheck("real-motor-activity", diagnostic.motorActivity);
  emitCheck("magnet-activated-for-drag", diagnostic.magnetEverHigh);
  emitCheck("magnet-low", diagnostic.magnetLow && offlineRuntimeMagnetIsLow());
  emitCheck("final-occupancy", diagnostic.finalOccupancyMatched);
  emitCheck("opponent-move-committed", diagnostic.opponentMoveCommitted);
  emitCheck("retry-limit", !diagnostic.retryExhausted);
  emitCheck("no-unresolved-recovery", !diagnostic.recoveryRequired);
  emitCheck("internal-heap-threshold", internalFree >= kMinimumInternalHeapBytes);
  emitCheck(
      "largest-internal-block-threshold",
      largestInternal >= kMinimumLargestInternalBlockBytes);
  emitCheck("psram-threshold", psramFree >= kMinimumFreePsramBytes);
  emitCheck("stack-threshold", stackHeadroom >= kMinimumStackHeadroomBytes);
  emitCheck(
      "sensor-loop-progress",
      searchSensorScans > 0 && offlineRuntimeSensorMaxGapMs < kMaximumSensorGapMs);
  emitCheck(
      "search-deadline",
      searchElapsedMs <= 3000U + kSearchOverrunAllowanceMs);

  DynamicJsonDocument document(2560);
  document["type"] = "summary";
  document["pass"] = overallPass;
  document["fixture"] = kLaneBoardFixture ? "LaneBoard" : "DirectLane";
  document["homeSucceeded"] = diagnostic.homeSucceeded;
  document["realMotionEnabled"] = true;
  document["motorActivity"] = diagnostic.motorActivity;
  document["magnetEverHigh"] = diagnostic.magnetEverHigh;
  document["magnetLow"] = diagnostic.magnetLow && offlineRuntimeMagnetIsLow();
  document["commandConsumptionBlocked"] = true;
  document["programCompiled"] = diagnostic.programCompiled;
  document["orderedPrimitives"] = diagnostic.primitiveOrderValid;
  document["sameSideLane"] = diagnostic.sameSideLane;
  document["finalOvershootOnly"] = diagnostic.finalOvershootOnly;
  document["noGraveyardState"] = diagnostic.noGraveyardState;
  document["verifiedPhaseCount"] = diagnostic.verifiedPhaseCount;
  document["retryObserved"] = diagnostic.retryObserved;
  document["retryExhausted"] = diagnostic.retryExhausted;
  document["recoveryRequired"] = diagnostic.recoveryRequired;
  document["finalOccupancyMatched"] = diagnostic.finalOccupancyMatched;
  document["opponentMoveCommitted"] = diagnostic.opponentMoveCommitted;
  document["selectedMove"] = diagnostic.selectedMove.c_str();
  document["routeMode"] = diagnostic.routeMode.c_str();
  document["committedFen"] = diagnostic.committedFen.c_str();
  document["actualOccupancy"] = diagnostic.actualOccupancy.c_str();
  document["expectedOccupancy"] = diagnostic.expectedOccupancy.c_str();
  if (diagnostic.error.length() > 0) document["error"] = diagnostic.error;
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

#endif

#endif

void emitSummary(
    bool planFrozen,
    bool opponentMoveCommitted,
    bool retryObserved,
    bool orderedPhases,
    bool realBoardUnchanged,
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

  if (kPhaseExecutionDiagnostic) {
    emitCheck("controlled-first-phase-retry", retryObserved);
    emitCheck("ordered-phase-completion", orderedPhases);
    emitCheck("opponent-move-committed", opponentMoveCommitted);
    emitCheck("real-board-unchanged", realBoardUnchanged);
  } else {
    emitCheck("motion-plan-frozen", planFrozen);
  }
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
  document["opponentMoveCommitted"] = opponentMoveCommitted;
  document["planFrozen"] = planFrozen;
  document["firstPhaseRetryObserved"] = retryObserved;
  document["orderedPhases"] = orderedPhases;
  document["realBoardUnchanged"] = realBoardUnchanged;
  document["commandConsumptionBlocked"] = true;
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
  start["motorsLocked"] =
      !(kQuietMotionDiagnostic || kCaptureMotionDiagnostic ||
        kLaneMotionDiagnostic);
  start["realMotionEnabled"] =
      kQuietMotionDiagnostic || kCaptureMotionDiagnostic ||
      kLaneMotionDiagnostic;
  start["magnetLow"] = offlineRuntimeMagnetIsLow();
  start["core"] = xPortGetCoreID();
  start["priority"] = uxTaskPriorityGet(nullptr);
  start["setupStableMs"] = 500;
  start["humanColor"] = "white";
  start["searchTimeMs"] = 3000;
  start["maxDepth"] = 12;
  if (kUnifiedTurnDiagnostic) {
    start["fixture"] = "standard-three-turn";
    start["targetTurns"] = 3;
  } else if (kStagedCaptureMotionDiagnostic) {
    start["fixture"] = "staged-e2d1-i4";
  } else if (kCaptureLaneMotionDiagnostic) {
    start["fixture"] = "capture-e3-z2-d5-z5-z3-e3";
  } else if (kEnPassantMotionDiagnostic) {
    start["fixture"] = "en-passant-e2e4-e4-i4-d4e3";
  } else if (kCastlingMotionDiagnostic) {
    start["fixture"] = "castle-a2a3-e8g8";
  } else if (kPromotionMotionDiagnostic) {
    start["fixture"] = "promotion-e1f2-a2a1q";
  } else if (kLaneMotionDiagnostic) {
    start["fixture"] = kLaneBoardFixture ? "LaneBoard" : "DirectLane";
  }
  emitDocument(start);

  emitCheck("psram-found", psramFound());
  if (!psramFound()) {
    emitSummary(
        false, false, false, false, false, 0, 0, 0, initialMotorA, initialMotorB);
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
    emitSummary(
        false, false, false, false, false, 0, 0, 0, initialMotorA, initialMotorB);
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
#if ENABLE_OFFLINE_UNIFIED_TURN_DIAGNOSTICS
  config.initialFen =
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
#elif ENABLE_OFFLINE_PROMOTION_MOTION_DIAGNOSTICS
  config.initialFen = "4k3/8/8/8/8/8/p7/4K3 w - - 0 1";
#elif ENABLE_OFFLINE_CASTLING_MOTION_DIAGNOSTICS
  config.initialFen =
      "4k2r/8/8/8/8/8/P3P1P1/4RKR1 w k - 0 1";
#elif ENABLE_OFFLINE_EN_PASSANT_MOTION_DIAGNOSTICS
  config.initialFen =
      "k7/3N4/1K6/8/3p4/3P4/4P3/8 w - - 0 1";
#elif ENABLE_OFFLINE_CAPTURE_LANE_MOTION_DIAGNOSTICS
  config.initialFen =
      "k7/8/8/3n4/pppppppp/4P3/4NN1R/4BKR1 w - - 0 1";
#elif ENABLE_OFFLINE_STAGED_CAPTURE_MOTION_DIAGNOSTICS
  config.initialFen = "k7/8/8/8/8/8/1NPPbP2/2B2n1K w - - 0 1";
#elif ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS
  config.initialFen = "k7/8/8/3p4/8/8/4R3/4K3 w - - 0 1";
#elif ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
#if OFFLINE_LANE_MOTION_FIXTURE == 1
  config.initialFen =
      "k7/8/8/3n4/pppppppp/2p3p1/4NN1R/4BKR1 w - - 0 1";
#else
  config.initialFen =
      "k7/8/8/3n4/pppppppp/8/4NN1R/4BKR1 w - - 0 1";
#endif
#endif
  std::unique_ptr<offline::OfflineReadOnlyRuntime> runtime(
      new (std::nothrow) offline::OfflineReadOnlyRuntime(config));
  emitCheck("runtime-allocation", runtime != nullptr);
  if (!runtime) {
    emitSummary(
        false, false, false, false, false, 0, 0, 0, initialMotorA, initialMotorB);
    vTaskDelete(nullptr);
    return;
  }

#if ENABLE_OFFLINE_UNIFIED_TURN_DIAGNOSTICS
  CaptureMotionDiagnosticResult unifiedHomeDiagnostic;
  if (!runCaptureHomeGate(unifiedHomeDiagnostic)) {
    UnifiedTurnDiagnosticResult unifiedDiagnostic;
    unifiedDiagnostic.homeSucceeded = false;
    unifiedDiagnostic.magnetLow = offlineRuntimeMagnetIsLow();
    unifiedDiagnostic.error = unifiedHomeDiagnostic.error;
    emitUnifiedSummary(unifiedDiagnostic);
    summaryEmitted = true;
    vTaskDelete(nullptr);
    return;
  }
#elif ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS
  QuietMotionDiagnosticResult quietDiagnostic;
  if (!runQuietHomeGate(quietDiagnostic)) {
    quietDiagnostic.magnetLow = offlineRuntimeMagnetIsLow();
    emitQuietSummary(quietDiagnostic, 0, 0, 0);
    summaryEmitted = true;
    vTaskDelete(nullptr);
    return;
  }
#elif ENABLE_OFFLINE_PROMOTION_MOTION_DIAGNOSTICS
  CaptureMotionDiagnosticResult promotionHomeDiagnostic;
  if (!runCaptureHomeGate(promotionHomeDiagnostic)) {
    PromotionMotionDiagnosticResult promotionDiagnostic;
    promotionDiagnostic.homeSucceeded = false;
    promotionDiagnostic.magnetLow = offlineRuntimeMagnetIsLow();
    promotionDiagnostic.error = promotionHomeDiagnostic.error;
    emitPromotionSummary(promotionDiagnostic, 0, 0, 0);
    summaryEmitted = true;
    vTaskDelete(nullptr);
    return;
  }
#elif ENABLE_OFFLINE_CASTLING_MOTION_DIAGNOSTICS
  CaptureMotionDiagnosticResult castlingHomeDiagnostic;
  if (!runCaptureHomeGate(castlingHomeDiagnostic)) {
    CastlingMotionDiagnosticResult castlingDiagnostic;
    castlingDiagnostic.homeSucceeded = false;
    castlingDiagnostic.magnetLow = offlineRuntimeMagnetIsLow();
    castlingDiagnostic.error = castlingHomeDiagnostic.error;
    emitCastlingSummary(castlingDiagnostic, 0, 0, 0);
    summaryEmitted = true;
    vTaskDelete(nullptr);
    return;
  }
#elif ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS
  CaptureMotionDiagnosticResult captureDiagnostic;
  if (!runCaptureHomeGate(captureDiagnostic)) {
    captureDiagnostic.magnetLow = offlineRuntimeMagnetIsLow();
    emitCaptureSummary(captureDiagnostic, 0, 0, 0);
    summaryEmitted = true;
    vTaskDelete(nullptr);
    return;
  }
#elif ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
  LaneMotionDiagnosticResult laneDiagnostic;
  if (!runLaneHomeGate(laneDiagnostic)) {
    laneDiagnostic.magnetLow = offlineRuntimeMagnetIsLow();
    emitLaneSummary(laneDiagnostic, 0, 0, 0);
    summaryEmitted = true;
    vTaskDelete(nullptr);
    return;
  }
#endif

  offline::OfflineEngine engine;
  std::uint32_t consumedRevision = 0;
  std::uint32_t searchedGeneration = 0;
  std::uint32_t searchSensorScans = 0;
  std::uint32_t searchHeartbeatAttempts = 0;
  std::uint32_t searchElapsedMs = 0;
#if ENABLE_OFFLINE_UNIFIED_TURN_DIAGNOSTICS
  bool initialTurnReadyEmitted = false;
#endif

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

#if ENABLE_OFFLINE_UNIFIED_TURN_DIAGNOSTICS
    if (!initialTurnReadyEmitted &&
        runtime->phase() == offline::OfflineRuntimePhase::HumanTurn) {
      emitUnifiedTurnReady(*runtime, 1);
      initialTurnReadyEmitted = true;
    }
#endif

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
#if ENABLE_OFFLINE_UNIFIED_TURN_DIAGNOSTICS
      UnifiedTurnDiagnosticResult execution;
      execution.homeSucceeded = unifiedHomeDiagnostic.homeSucceeded;
      if (planFrozen) {
        execution = runUnifiedThreeTurns(
            *runtime,
            engine,
            searchSensorScans,
            searchHeartbeatAttempts,
            searchElapsedMs,
            consumedRevision);
        execution.homeSucceeded = unifiedHomeDiagnostic.homeSucceeded;
      } else {
        execution.error =
            "The first unified opponent plan was not frozen before execution.";
      }
      emitUnifiedSummary(execution);
#elif ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS
      const auto state = runtime->coordinator().currentState();
      const auto transaction = runtime->coordinator().pendingMotionTransaction();
      PhaseExecutionDiagnosticResult execution;
      if (planFrozen && state.opponentPlan && transaction) {
        execution = runSimulatedPhaseExecution(
            *runtime, occupancy, state.opponentPlan->afterFen);
      }
      emitSummary(
          false,
          execution.committed,
          execution.firstPhaseRetryObserved,
          execution.orderedPhases,
          execution.realBoardUnchanged,
          searchSensorScans,
          searchHeartbeatAttempts,
          searchElapsedMs,
          initialMotorA,
          initialMotorB);
#elif ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS
      const auto state = runtime->coordinator().currentState();
      const auto transaction = runtime->coordinator().pendingMotionTransaction();
      QuietMotionDiagnosticResult execution;
      execution.homeSucceeded = quietDiagnostic.homeSucceeded;
      if (planFrozen && state.opponentPlan && transaction) {
        execution = runRealQuietMotionExecution(
            *runtime, state.opponentPlan->afterFen);
      } else {
        execution.error = "The opponent plan was not frozen before hardware execution.";
      }
      emitQuietSummary(
          execution,
          searchSensorScans,
          searchHeartbeatAttempts,
          searchElapsedMs);
#elif ENABLE_OFFLINE_PROMOTION_MOTION_DIAGNOSTICS
      const auto state = runtime->coordinator().currentState();
      const auto transaction = runtime->coordinator().pendingMotionTransaction();
      PromotionMotionDiagnosticResult execution;
      execution.homeSucceeded = promotionHomeDiagnostic.homeSucceeded;
      if (planFrozen && state.opponentPlan && transaction) {
        execution = runRealPromotionMotionExecution(
            *runtime, state.opponentPlan->afterFen);
      } else {
        execution.error =
            "The controlled promotion plan was not frozen before execution.";
      }
      emitPromotionSummary(
          execution,
          searchSensorScans,
          searchHeartbeatAttempts,
          searchElapsedMs);
#elif ENABLE_OFFLINE_CASTLING_MOTION_DIAGNOSTICS
      const auto state = runtime->coordinator().currentState();
      const auto transaction = runtime->coordinator().pendingMotionTransaction();
      CastlingMotionDiagnosticResult execution;
      execution.homeSucceeded = castlingHomeDiagnostic.homeSucceeded;
      if (planFrozen && state.opponentPlan && transaction) {
        execution = runRealCastlingMotionExecution(
            *runtime, state.opponentPlan->afterFen);
      } else {
        execution.error =
            "The controlled castling plan was not frozen before execution.";
      }
      emitCastlingSummary(
          execution,
          searchSensorScans,
          searchHeartbeatAttempts,
          searchElapsedMs);
#elif ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS
      update = offline::OfflineRuntimeUpdate{};
      bool capturePlanReady = false;
      std::string capturePreviewAfterFen;
      {
        const auto state = runtime->coordinator().currentState();
        const auto transaction = runtime->coordinator().pendingMotionTransaction();
        capturePlanReady = planFrozen && state.opponentPlan && transaction;
        if (state.opponentPlan) {
          capturePreviewAfterFen = state.opponentPlan->afterFen;
        }
      }
      CaptureMotionDiagnosticResult execution;
      execution.homeSucceeded = captureDiagnostic.homeSucceeded;
      if (capturePlanReady) {
        execution = runRealCaptureMotionExecution(
            *runtime, capturePreviewAfterFen);
      } else {
        execution.error =
            "The controlled capture plan was not frozen before execution.";
      }
      emitCaptureSummary(
          execution,
          searchSensorScans,
          searchHeartbeatAttempts,
          searchElapsedMs);
#elif ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS
      const auto state = runtime->coordinator().currentState();
      const auto transaction = runtime->coordinator().pendingMotionTransaction();
      LaneMotionDiagnosticResult execution;
      execution.homeSucceeded = laneDiagnostic.homeSucceeded;
      if (planFrozen && state.opponentPlan && transaction) {
        execution = runRealLaneMotionExecution(
            *runtime, state.opponentPlan->afterFen);
      } else {
        execution.error =
            "The controlled lane plan was not frozen before execution.";
      }
      emitLaneSummary(
          execution,
          searchSensorScans,
          searchHeartbeatAttempts,
          searchElapsedMs);
#else
      emitSummary(
          planFrozen,
          false,
          false,
          true,
          true,
          searchSensorScans,
          searchHeartbeatAttempts,
          searchElapsedMs,
          initialMotorA,
          initialMotorB);
#endif
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
    StaticJsonDocument<192> document;
    document["type"] = "summary";
    document["pass"] = false;
    document["error"] = "task-create-failed";
    emitDocument(document);
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
