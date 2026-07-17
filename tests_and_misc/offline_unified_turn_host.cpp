#include "../offline_core/offline_castling_motion.h"
#include "../offline_core/offline_lane_motion.h"
#include "../offline_core/offline_promotion_motion.h"
#include "../offline_core/offline_quiet_motion.h"
#include "../offline_core/offline_unified_motion.h"

#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

using offline::CaptureMotionProgram;
using offline::GraveyardSlotState;
using offline::HumanColor;
using offline::MotionPhaseKind;
using offline::MotionPlanningContext;
using offline::Occupancy;
using offline::OfflineGame;
using offline::OfflinePhaseExecutionAdapter;
using offline::OfflinePhaseExecutionEvent;
using offline::OfflinePhaseExecutionReport;
using offline::OfflinePhaseExecutionRequest;
using offline::OfflinePhaseExecutionState;
using offline::OfflineReadOnlyRuntime;
using offline::OfflineRuntimeConfig;
using offline::OfflineRuntimePhase;
using offline::OfflineUnifiedMotionCompiler;
using offline::OwnershipDecision;
using offline::OwnershipState;
using offline::RootMoveScore;
using offline::SearchResult;
using offline::SearchStopReason;
using offline::UnifiedMotionCompilerKind;
using offline::UnifiedMotionProgram;

constexpr const char* kStartFen =
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void setSquare(Occupancy& occupancy, const std::string& square, bool occupied) {
  const int index = offline::squareToRawIndex(square);
  require(index >= 0, "Invalid test square: " + square);
  occupancy[static_cast<std::size_t>(index)] = occupied;
}

bool sameProgram(const CaptureMotionProgram& left, const CaptureMotionProgram& right) {
  return left.status == right.status && left.token == right.token &&
         left.phaseKind == right.phaseKind && left.moveUci == right.moveUci &&
         left.from == right.from && left.to == right.to &&
         left.sourceRawIndex == right.sourceRawIndex &&
         left.targetRawIndex == right.targetRawIndex &&
         left.routeMode == right.routeMode && left.routeCost == right.routeCost &&
         left.rawPathSquares == right.rawPathSquares &&
         left.compressedPathSquares == right.compressedPathSquares &&
         left.routeTargets.size() == right.routeTargets.size() &&
         left.graveyardSlotKey == right.graveyardSlotKey &&
         left.graveyardLabel == right.graveyardLabel &&
         left.graveyardX == right.graveyardX &&
         left.graveyardY == right.graveyardY &&
         left.primitives == right.primitives &&
         left.expectedBefore == right.expectedBefore &&
         left.expectedAfter == right.expectedAfter &&
         left.blockedReason == right.blockedReason;
}

void requireQuietParity(
    const CaptureMotionProgram& normalized,
    const offline::QuietMotionProgram& source,
    const std::string& context) {
  require(
      normalized.sourceRawIndex == source.sourceRawIndex &&
          normalized.targetRawIndex == source.targetRawIndex &&
          normalized.routeMode == source.routeMode &&
          normalized.routeCost == source.routeCost &&
          normalized.rawPathSquares == source.rawPathSquares &&
          normalized.compressedPathSquares == source.compressedPathSquares &&
          normalized.primitives.size() == source.primitives.size(),
      context + ": normalized quiet metadata changed.");
  for (std::size_t index = 0; index < source.primitives.size(); ++index) {
    const auto& actual = normalized.primitives[index];
    const auto& expected = source.primitives[index];
    const std::vector<offline::CaptureMotionPrimitiveKind> kinds = {
        offline::CaptureMotionPrimitiveKind::TravelBoard,
        offline::CaptureMotionPrimitiveKind::Pickup,
        offline::CaptureMotionPrimitiveKind::DragBoard,
        offline::CaptureMotionPrimitiveKind::Drop,
        offline::CaptureMotionPrimitiveKind::Verify};
    require(
        actual.kind == kinds[static_cast<std::size_t>(expected.kind)] &&
            actual.sourceRawIndex == expected.sourceRawIndex &&
            actual.targetRawIndex == expected.targetRawIndex &&
            actual.finalBoardDrop == expected.finalBoardDrop,
        context + ": normalized quiet primitive changed.");
  }
}

void requireLaneParity(
    const CaptureMotionProgram& normalized,
    const offline::LaneMotionProgram& source,
    const std::string& context) {
  require(
      normalized.sourceRawIndex == source.sourceRawIndex &&
          normalized.targetRawIndex == source.targetRawIndex &&
          normalized.routeMode == source.routeMode &&
          normalized.routeCost == source.routeCost &&
          normalized.rawPathSquares == source.rawPathSquares &&
          normalized.compressedPathSquares == source.compressedPathSquares &&
          normalized.routeTargets.size() == source.routeTargets.size() &&
          normalized.primitives.size() == source.primitives.size(),
      context + ": normalized lane metadata changed.");
  for (std::size_t index = 0; index < source.primitives.size(); ++index) {
    const auto& actual = normalized.primitives[index];
    const auto& expected = source.primitives[index];
    const std::vector<offline::CaptureMotionPrimitiveKind> kinds = {
        offline::CaptureMotionPrimitiveKind::TravelBoard,
        offline::CaptureMotionPrimitiveKind::Pickup,
        offline::CaptureMotionPrimitiveKind::DragCoordinate,
        offline::CaptureMotionPrimitiveKind::DragBoard,
        offline::CaptureMotionPrimitiveKind::Drop,
        offline::CaptureMotionPrimitiveKind::Verify};
    require(
        actual.kind == kinds[static_cast<std::size_t>(expected.kind)] &&
            actual.sourceRawIndex == expected.sourceRawIndex &&
            actual.targetRawIndex == expected.targetRawIndex &&
            actual.targetX == expected.targetX &&
            actual.targetY == expected.targetY &&
            actual.finalBoardDrop == expected.finalBoardDrop,
        context + ": normalized lane primitive changed.");
  }
}

struct PlannedMove {
  offline::MotionPlan plan;
  std::vector<OfflinePhaseExecutionRequest> requests;
};

PlannedMove planRequests(const std::string& fen, const std::string& uci) {
  OfflineGame game;
  require(game.loadFen(fen), uci + ": FEN did not load.");
  MotionPlanningContext context;
  context.slots = offline::defaultExternalSlots();
  context.sensedOccupancy = offline::occupancyFromFen(fen);
  PlannedMove fixture;
  fixture.plan = offline::OfflineMotionPlanner{}.planMove(game, uci, context);
  require(fixture.plan.success(), uci + ": motion planning failed.");
  const std::string slotKey = fixture.plan.proposedGraveyardSlot
                                  ? offline::externalSlotKey(
                                        *fixture.plan.proposedGraveyardSlot)
                                  : std::string{};
  bool capturedRemoved = false;
  for (std::size_t index = 0; index < fixture.plan.phases.size(); ++index) {
    OfflinePhaseExecutionRequest request;
    request.token = {100, index, 1};
    request.move = fixture.plan.move;
    request.phase = fixture.plan.phases[index];
    request.graveyardSlotKey = slotKey;
    if (!slotKey.empty()) {
      request.graveyardState = capturedRemoved ? GraveyardSlotState::Occupied
                                               : GraveyardSlotState::Pending;
    }
    fixture.requests.push_back(request);
    if (request.phase.kind == MotionPhaseKind::CapturedRemoval) {
      capturedRemoved = true;
    }
  }
  return fixture;
}

void requireUnified(
    const OfflinePhaseExecutionRequest& request,
    UnifiedMotionCompilerKind compiler,
    const std::string& context) {
  const auto original = request;
  const UnifiedMotionProgram first = OfflineUnifiedMotionCompiler{}.compile(request);
  const UnifiedMotionProgram second = OfflineUnifiedMotionCompiler{}.compile(request);
  require(first.success(), context + ": unified compilation failed: " + first.blockedReason);
  require(first.compiler == compiler && first.sourceStatus == "success",
          context + ": wrong compiler selected.");
  require(sameProgram(first.program, second.program),
          context + ": unified compilation is not deterministic.");
  require(request.token == original.token && request.move.uci == original.move.uci &&
              request.phase.expectedBefore == original.phase.expectedBefore &&
              request.phase.expectedAfter == original.phase.expectedAfter,
          context + ": unified compilation mutated its input.");

  CaptureMotionProgram expected;
  switch (compiler) {
    case UnifiedMotionCompilerKind::Capture:
      expected = offline::OfflineCaptureMotionCompiler{}.compile(request);
      require(sameProgram(first.program, expected),
              context + ": capture normalization changed compiler output.");
      break;
    case UnifiedMotionCompilerKind::Castling:
      expected = offline::OfflineCastlingMotionCompiler{}.compile(request);
      require(sameProgram(first.program, expected),
              context + ": castling normalization changed compiler output.");
      break;
    case UnifiedMotionCompilerKind::Promotion:
      expected = offline::OfflinePromotionMotionCompiler{}.compile(request);
      require(sameProgram(first.program, expected),
              context + ": promotion normalization changed compiler output.");
      break;
    case UnifiedMotionCompilerKind::Quiet:
      requireQuietParity(
          first.program,
          offline::OfflineQuietMotionCompiler{}.compile(request),
          context);
      break;
    case UnifiedMotionCompilerKind::Lane:
      requireLaneParity(
          first.program,
          offline::OfflineLaneMotionCompiler{}.compile(request),
          context);
      break;
  }
}

void verifyDispatcherFamilies() {
  const auto quiet = planRequests(
      "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", "e2e4");
  requireUnified(quiet.requests.front(), UnifiedMotionCompilerKind::Quiet, "quiet");

  const auto lane = planRequests(
      "k7/8/8/3n4/pppppppp/8/4NNR1/4BKR1 b - - 1 1", "d5e3");
  require(
      lane.requests.front().phase.transfer &&
          lane.requests.front().phase.transfer->mode == offline::ExternalRouteMode::Lane,
      "Lane fixture no longer selects a direct lane route.");
  requireUnified(lane.requests.front(), UnifiedMotionCompilerKind::Lane, "lane");

  const auto laneBoard = planRequests(
      "k7/8/8/3n4/pppppppp/2p3p1/4NNR1/4BKR1 b - - 1 1", "d5e3");
  require(
      laneBoard.requests.front().phase.transfer &&
          laneBoard.requests.front().phase.transfer->mode ==
              offline::ExternalRouteMode::LaneBoard,
      "LaneBoard fixture no longer selects a lane-board route.");
  requireUnified(
      laneBoard.requests.front(), UnifiedMotionCompilerKind::Lane, "lane-board");

  for (const PlannedMove& capture : {
           planRequests("k7/8/8/3p4/4R3/8/8/4K3 b - - 1 1", "d5e4"),
           planRequests("k7/8/8/8/8/8/2PPbP2/2BN1n1K b - - 1 1", "e2d1"),
           planRequests("k7/3N4/1K6/8/3pP3/3P4/8/8 b - e3 0 1", "d4e3")}) {
    for (const auto& request : capture.requests) {
      requireUnified(request, UnifiedMotionCompilerKind::Capture, request.move.uci);
    }
  }

  const std::vector<std::pair<std::string, std::string>> castles = {
      {"4k3/8/8/8/8/8/8/4K2R w K - 0 1", "e1g1"},
      {"4k3/8/8/8/8/8/8/R3K3 w Q - 0 1", "e1c1"},
      {"4k2r/8/8/8/8/8/8/4K3 b k - 0 1", "e8g8"},
      {"r3k3/8/8/8/8/8/8/4K3 b q - 0 1", "e8c8"}};
  for (const auto& [fen, uci] : castles) {
    const PlannedMove castle = planRequests(fen, uci);
    for (const auto& request : castle.requests) {
      requireUnified(request, UnifiedMotionCompilerKind::Castling, uci);
    }
  }

  for (const char piece : std::string("qrbn")) {
    const std::string uci = std::string("a7a8") + piece;
    const PlannedMove promotion = planRequests(
        "4k3/P7/8/8/8/8/8/4K3 w - - 0 1", uci);
    requireUnified(
        promotion.requests.front(), UnifiedMotionCompilerKind::Promotion, uci);
  }
  const PlannedMove capturePromotion = planRequests(
      "1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7b8q");
  for (const auto& request : capturePromotion.requests) {
    requireUnified(request, UnifiedMotionCompilerKind::Promotion, "a7b8q");
  }
}

void verifyDispatcherRejections() {
  auto request = planRequests(
      "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", "e2e4").requests.front();
  request.phase.transfer.reset();
  auto result = OfflineUnifiedMotionCompiler{}.compile(request);
  require(!result.success() &&
              result.status == offline::UnifiedMotionCompileStatus::UnsupportedRequest,
          "A quiet phase without route metadata was accepted.");

  request = planRequests(
      "k7/8/8/3p4/4R3/8/8/4K3 b - - 1 1", "d5e4").requests.back();
  request.phase.kind = MotionPhaseKind::QuietTransfer;
  result = OfflineUnifiedMotionCompiler{}.compile(request);
  require(!result.success() &&
              result.status == offline::UnifiedMotionCompileStatus::UnsupportedRequest,
          "A capture disguised as QuietTransfer was accepted.");
  require(offline::unifiedMotionAttemptAllowed({1, 0, 1}) &&
              offline::unifiedMotionAttemptAllowed({1, 0, 2}) &&
              !offline::unifiedMotionAttemptAllowed({1, 0, 0}) &&
              !offline::unifiedMotionAttemptAllowed({1, 0, 3}),
          "Unified motion attempt limits changed.");
}

OfflineRuntimeConfig runtimeConfig(HumanColor human) {
  OfflineRuntimeConfig config;
  config.initialFen = kStartFen;
  config.coordinator.humanColor = human;
  config.coordinator.searchLimits.timeLimitMs = 0;
  config.coordinator.searchLimits.maxNodes = 2000;
  config.coordinator.searchLimits.maxDepth = 12;
  config.coordinator.externalSlots = offline::defaultExternalSlots();
  return config;
}

OwnershipDecision offlineOwnership() {
  OwnershipDecision decision;
  decision.state = OwnershipState::OfflineIdle;
  decision.allowOfflineControl = true;
  return decision;
}

SearchResult selectedMove(const std::string& uci) {
  SearchResult result;
  result.bestMove = uci;
  result.score = 20;
  result.completedDepth = 2;
  result.nodes = 100;
  result.stopReason = SearchStopReason::DepthLimit;
  result.rankedRootMoves.push_back(RootMoveScore{uci, 20, 0});
  return result;
}

void arm(OfflineReadOnlyRuntime& runtime) {
  const Occupancy setup = runtime.expectedSetupOccupancy();
  runtime.applyOwnershipDecision(0, offlineOwnership(), setup);
  const auto update = runtime.applyOwnershipDecision(500, offlineOwnership(), setup);
  require(update.phase == OfflineRuntimePhase::HumanTurn ||
              update.phase == OfflineRuntimePhase::EngineSearchNeeded,
          "Runtime did not arm at its configured first turn.");
}

void applyQuietHumanMove(
    OfflineReadOnlyRuntime& runtime,
    Occupancy& occupancy,
    const std::string& uci,
    std::uint32_t nowMs) {
  Occupancy lifted = occupancy;
  setSquare(lifted, uci.substr(0, 2), false);
  runtime.processStableSnapshot(nowMs, lifted);
  Occupancy placed = lifted;
  setSquare(placed, uci.substr(2, 2), true);
  const auto update = runtime.processStableSnapshot(nowMs + 1, placed);
  require(update.phase == OfflineRuntimePhase::EngineSearchNeeded &&
              update.acceptedMove && update.acceptedMove->uci == uci,
          uci + ": human move was not accepted.");
  occupancy = placed;
}

void stageEngineMove(
    OfflineReadOnlyRuntime& runtime,
    const Occupancy& occupancy,
    const std::string& uci) {
  const auto request = runtime.pendingEngineRequest();
  require(request.has_value(), uci + ": engine request missing.");
  const auto update = runtime.submitEngineResult(
      request->generation, selectedMove(uci), occupancy);
  require(update.phase == OfflineRuntimePhase::PlanReady &&
              update.motionTransaction &&
              update.motionTransaction->selectedMove == uci,
          uci + ": engine move was not staged.");
}

Occupancy executeStagedMove(
    OfflineReadOnlyRuntime& runtime,
    OfflinePhaseExecutionAdapter& adapter,
    bool retryFirstPhase = false) {
  const std::string beforeFen = runtime.coordinator().physical().game().fen();
  auto update = adapter.begin();
  require(update.request.has_value(), "Execution did not issue its first phase.");
  bool retryInjected = false;
  while (adapter.state() == OfflinePhaseExecutionState::PhaseReady ||
         adapter.state() == OfflinePhaseExecutionState::RetryReady) {
    const OfflinePhaseExecutionRequest request = *adapter.currentRequest();
    const UnifiedMotionProgram program = OfflineUnifiedMotionCompiler{}.compile(request);
    require(program.success() && offline::unifiedMotionAttemptAllowed(request.token),
            "A staged phase did not compile through the unified dispatcher.");
    adapter.takeCurrentRequest();
    if (retryFirstPhase && !retryInjected) {
      retryInjected = true;
      update = adapter.submitReport(
          OfflinePhaseExecutionReport{request.token, false, request.phase.expectedBefore});
      require(update.state == OfflinePhaseExecutionState::RetryReady &&
                  update.request && update.request->token.attempt == 2,
              "Exact-before failure did not issue attempt two.");
      continue;
    }
    require(runtime.coordinator().physical().game().fen() == beforeFen,
            "Chess state changed before the final verified phase.");
    update = adapter.submitReport(
        OfflinePhaseExecutionReport{request.token, true, request.phase.expectedAfter});
  }
  require(adapter.state() == OfflinePhaseExecutionState::Complete,
          "Opponent move did not complete.");
  return runtime.coordinator().physical().committedOccupancy();
}

void verifyThreeWhiteTurnsAndBoundary() {
  OfflineReadOnlyRuntime runtime(runtimeConfig(HumanColor::White));
  arm(runtime);
  OfflinePhaseExecutionAdapter adapter(runtime);
  Occupancy occupancy = runtime.expectedSetupOccupancy();
  const std::vector<std::pair<std::string, std::string>> turns = {
      {"g1f3", "e7e5"}, {"b1c3", "d7d5"}, {"a2a3", "c7c5"}};
  std::uint32_t nowMs = 600;
  for (std::size_t index = 0; index < turns.size(); ++index) {
    applyQuietHumanMove(runtime, occupancy, turns[index].first, nowMs);
    stageEngineMove(runtime, occupancy, turns[index].second);
    occupancy = executeStagedMove(runtime, adapter, index == 0);

    if (index == 0) {
      Occupancy mismatch = occupancy;
      setSquare(mismatch, turns[index].second.substr(2, 2), false);
      const auto blocked = adapter.openNextHumanTurn(mismatch);
      require(blocked.event == OfflinePhaseExecutionEvent::TurnBoundaryBlocked &&
                  adapter.state() == OfflinePhaseExecutionState::Complete &&
                  runtime.phase() == OfflineRuntimePhase::ExecutionComplete &&
                  !blocked.differenceFromExpected.empty(),
              "Mismatched turn boundary was not kept frozen.");
    }

    auto opened = adapter.openNextHumanTurn(occupancy);
    require(opened.event == OfflinePhaseExecutionEvent::HumanTurnOpened &&
                adapter.state() == OfflinePhaseExecutionState::Idle &&
                runtime.phase() == OfflineRuntimePhase::HumanTurn,
            "Verified turn boundary did not reopen HumanTurn.");
    opened = adapter.openNextHumanTurn(occupancy);
    require(opened.event == OfflinePhaseExecutionEvent::None,
            "Duplicate turn-boundary acknowledgement was not idempotent.");
    nowMs += 100;
  }
}

void verifyThreeBlackTurnsAndBoundary() {
  OfflineReadOnlyRuntime runtime(runtimeConfig(HumanColor::Black));
  arm(runtime);
  Occupancy occupancy = runtime.expectedSetupOccupancy();
  OfflinePhaseExecutionAdapter adapter(runtime);

  stageEngineMove(runtime, occupancy, "e2e4");
  occupancy = executeStagedMove(runtime, adapter);
  require(
      adapter.openNextHumanTurn(occupancy).event ==
          OfflinePhaseExecutionEvent::HumanTurnOpened,
      "Human Black did not receive the verified first turn.");

  applyQuietHumanMove(runtime, occupancy, "e7e5", 600);
  stageEngineMove(runtime, occupancy, "d2d3");
  occupancy = executeStagedMove(runtime, adapter);
  require(
      adapter.openNextHumanTurn(occupancy).event ==
          OfflinePhaseExecutionEvent::HumanTurnOpened,
      "Human Black did not receive the verified second turn.");

  applyQuietHumanMove(runtime, occupancy, "d7d6", 700);
  stageEngineMove(runtime, occupancy, "c2c3");
  occupancy = executeStagedMove(runtime, adapter);
  require(
      adapter.openNextHumanTurn(occupancy).event ==
              OfflinePhaseExecutionEvent::HumanTurnOpened &&
          runtime.phase() == OfflineRuntimePhase::HumanTurn,
      "Human Black did not receive the verified third turn.");
}

bool containsKey(
    const std::vector<std::string>& values,
    const std::string& key) {
  return std::find(values.begin(), values.end(), key) != values.end();
}

void verifyGraveyardPersistsAcrossTurns() {
  OfflineRuntimeConfig config = runtimeConfig(HumanColor::White);
  config.initialFen = "k6r/8/8/8/8/8/6PP/K7 w - - 0 1";
  OfflineReadOnlyRuntime runtime(config);
  arm(runtime);
  OfflinePhaseExecutionAdapter adapter(runtime);
  Occupancy occupancy = runtime.expectedSetupOccupancy();

  applyQuietHumanMove(runtime, occupancy, "a1b1", 600);
  stageEngineMove(runtime, occupancy, "h8h2");
  const auto firstTransaction = runtime.coordinator().pendingMotionTransaction();
  require(firstTransaction && !firstTransaction->graveyardSlotKey.empty(),
          "First capture did not propose a graveyard slot.");
  const std::string firstSlot = firstTransaction->graveyardSlotKey;
  occupancy = executeStagedMove(runtime, adapter);
  require(
      containsKey(runtime.coordinator().occupiedGraveyardKeys(), firstSlot),
      "First verified capture did not retain its occupied graveyard slot.");
  require(
      adapter.openNextHumanTurn(occupancy).event ==
          OfflinePhaseExecutionEvent::HumanTurnOpened,
      "Capture boundary did not reopen.");

  applyQuietHumanMove(runtime, occupancy, "b1c1", 700);
  stageEngineMove(runtime, occupancy, "h2g2");
  const auto secondTransaction = runtime.coordinator().pendingMotionTransaction();
  require(secondTransaction && !secondTransaction->graveyardSlotKey.empty() &&
              secondTransaction->graveyardSlotKey != firstSlot &&
              containsKey(
                  runtime.coordinator().occupiedGraveyardKeys(), firstSlot),
          "Second capture reused or discarded the first occupied slot.");
  const std::string secondSlot = secondTransaction->graveyardSlotKey;
  occupancy = executeStagedMove(runtime, adapter);
  require(
      containsKey(runtime.coordinator().occupiedGraveyardKeys(), firstSlot) &&
          containsKey(runtime.coordinator().occupiedGraveyardKeys(), secondSlot),
      "Consecutive verified captures did not preserve both graveyard slots.");
}

void verifyPromotionCommitWaitsForReplacement() {
  OfflineRuntimeConfig config = runtimeConfig(HumanColor::Black);
  config.initialFen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
  OfflineReadOnlyRuntime runtime(config);
  arm(runtime);
  const Occupancy before = runtime.expectedSetupOccupancy();
  const std::string beforeFen = runtime.coordinator().physical().game().fen();
  stageEngineMove(runtime, before, "a7a8q");

  OfflinePhaseExecutionAdapter adapter(runtime);
  auto update = adapter.begin();
  require(update.request.has_value(), "Promotion phase was not issued.");
  const auto request = *update.request;
  const auto compiled = OfflineUnifiedMotionCompiler{}.compile(request);
  require(compiled.success() &&
              compiled.compiler == UnifiedMotionCompilerKind::Promotion,
          "Promotion did not use the unified promotion compiler.");
  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      {request.token, true, request.phase.expectedAfter});
  require(
      update.state == OfflinePhaseExecutionState::PromotionPending &&
          runtime.coordinator().physical().game().fen() == beforeFen,
      "Promotion committed before physical replacement confirmation.");

  Occupancy emptyTarget = request.phase.expectedAfter;
  setSquare(emptyTarget, "a8", false);
  adapter.processPromotionSnapshot(emptyTarget);
  adapter.processPromotionSnapshot(request.phase.expectedAfter);
  require(runtime.coordinator().physical().game().fen() == beforeFen,
          "Promotion snapshots committed without identity confirmation.");
  update = adapter.confirmPromotion('q', request.phase.expectedAfter);
  require(
      update.state == OfflinePhaseExecutionState::Complete &&
          runtime.coordinator().physical().game().fen() != beforeFen,
      "Matching promotion replacement did not commit the move.");
}

void verifyGameOverCannotReopen() {
  OfflineRuntimeConfig config;
  config.initialFen = "7k/5KQ1/8/8/8/8/8/8 w - - 0 1";
  config.coordinator.humanColor = HumanColor::Black;
  config.coordinator.externalSlots = offline::defaultExternalSlots();
  OfflineReadOnlyRuntime runtime(config);
  arm(runtime);
  Occupancy occupancy = runtime.expectedSetupOccupancy();
  stageEngineMove(runtime, occupancy, "g7g8");
  OfflinePhaseExecutionAdapter adapter(runtime);
  auto update = adapter.begin();
  const auto request = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      {request.token, true, request.phase.expectedAfter});
  require(update.state == OfflinePhaseExecutionState::GameOver &&
              runtime.phase() == OfflineRuntimePhase::GameOver,
          "Mating move did not enter GameOver.");
  const auto reopened = adapter.openNextHumanTurn(request.phase.expectedAfter);
  require(reopened.event == OfflinePhaseExecutionEvent::Error &&
              adapter.state() == OfflinePhaseExecutionState::GameOver,
          "GameOver was incorrectly reopened.");
}

}  // namespace

int main() {
  try {
    verifyDispatcherFamilies();
    verifyDispatcherRejections();
    verifyThreeWhiteTurnsAndBoundary();
    verifyThreeBlackTurnsAndBoundary();
    verifyGraveyardPersistsAcrossTurns();
    verifyPromotionCommitWaitsForReplacement();
    verifyGameOverCannotReopen();
    std::cout << "offline unified turn regressions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline unified turn regression failed: " << error.what() << '\n';
    return 1;
  }
}
