#include "../offline_core/offline_capture_motion.h"
#include "../offline_core/offline_lane_motion.h"

#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::CaptureMotionCompileStatus;
using offline::CaptureMotionPrimitiveKind;
using offline::ExternalRouteMode;
using offline::GraveyardSlotState;
using offline::HumanColor;
using offline::MotionPhase;
using offline::MotionPhaseKind;
using offline::MotionPlanningContext;
using offline::MotionStrategy;
using offline::Occupancy;
using offline::OfflineCaptureMotionCompiler;
using offline::OfflineEngine;
using offline::OfflineExternalRoutePlanner;
using offline::OfflineGame;
using offline::OfflineLaneMotionCompiler;
using offline::OfflineMotionPlanner;
using offline::OfflinePhaseExecutionAdapter;
using offline::OfflinePhaseExecutionReport;
using offline::OfflinePhaseExecutionRequest;
using offline::OfflinePhaseExecutionState;
using offline::OfflineReadOnlyRuntime;
using offline::OfflineRuntimeConfig;
using offline::OfflineRuntimePhase;
using offline::OwnershipDecision;
using offline::OwnershipState;
using offline::RootMoveScore;
using offline::SearchLimits;
using offline::SearchResult;
using offline::SearchStopReason;

constexpr const char* kInitialFen =
    "k7/3N4/1K6/8/3p4/3P4/4P3/8 w - - 0 1";
constexpr const char* kPostHumanFen =
    "k7/3N4/1K6/8/3pP3/3P4/8/8 b - e3 0 1";
constexpr const char* kFinalFen =
    "k7/3N4/1K6/8/8/3Pp3/8/8 w - - 0 2";

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void setSquare(
    Occupancy& occupancy,
    const std::string& square,
    bool occupied) {
  const int index = offline::squareToRawIndex(square);
  require(index >= 0, "Invalid test square: " + square);
  occupancy[static_cast<std::size_t>(index)] = occupied;
}

void requireKinds(
    const offline::CaptureMotionProgram& program,
    const std::vector<CaptureMotionPrimitiveKind>& kinds,
    const std::string& context) {
  require(
      program.primitives.size() == kinds.size(),
      context + ": primitive count differs.");
  for (std::size_t index = 0; index < kinds.size(); ++index) {
    require(
        program.primitives[index].kind == kinds[index],
        context + ": primitive kind differs at " + std::to_string(index) +
            ".");
  }
}

struct Fixture {
  offline::MotionPlan plan;
  std::string slotKey;
  OfflinePhaseExecutionRequest removal;
  OfflinePhaseExecutionRequest attacker;
};

Fixture enPassantFixture() {
  OfflineGame game;
  require(game.loadFen(kPostHumanFen), "Post-human en passant FEN did not load.");
  MotionPlanningContext context;
  context.slots = offline::defaultExternalSlots();
  context.sensedOccupancy = offline::occupancyFromFen(kPostHumanFen);
  const auto plan = OfflineMotionPlanner{}.planMove(game, "d4e3", context);
  require(
      plan.success() &&
          plan.strategy == MotionStrategy::CaptureDirectAfterRemoval &&
          plan.routeCost == 568.5 && plan.phases.size() == 2 &&
          plan.proposedGraveyardSlot,
      "En passant strategy, cost, or phase count changed.");
  require(
      plan.move.enPassant && plan.move.capture &&
          plan.move.from == "d4" && plan.move.to == "e3" &&
          plan.move.capturedSquare == "e4" &&
          plan.proposedGraveyardSlot->label == "I4" &&
          plan.proposedGraveyardSlot->x == 17600 &&
          plan.proposedGraveyardSlot->y == -350,
      "En passant metadata or calibrated I4 selection changed.");

  Fixture fixture;
  fixture.plan = plan;
  fixture.slotKey = offline::externalSlotKey(*plan.proposedGraveyardSlot);
  fixture.removal.token = {71, 0, 1};
  fixture.removal.move = plan.move;
  fixture.removal.phase = plan.phases[0];
  fixture.removal.graveyardSlotKey = fixture.slotKey;
  fixture.removal.graveyardState = GraveyardSlotState::Pending;
  fixture.attacker.token = {71, 1, 1};
  fixture.attacker.move = plan.move;
  fixture.attacker.phase = plan.phases[1];
  fixture.attacker.graveyardSlotKey = fixture.slotKey;
  fixture.attacker.graveyardState = GraveyardSlotState::Occupied;
  return fixture;
}

void verifyFixtureAndEngine() {
  OfflineGame game;
  require(game.loadFen(kInitialFen), "Initial en passant FEN did not load.");
  offline::MoveInfo human;
  require(
      game.applyUci("e2e4", human) && human.san == "e4" &&
          game.fen() == kPostHumanFen,
      "Human two-square pawn move no longer creates the expected FEN.");
  require(
      game.legalMovesUci() == std::vector<std::string>({"d4e3"}),
      "Black no longer has exactly one legal en passant reply.");

  SearchLimits limits;
  limits.timeLimitMs = 0;
  limits.maxNodes = 2000;
  limits.maxDepth = 12;
  const auto result = OfflineEngine{}.searchFen(game.fen(), limits);
  require(
      result.bestMove == "d4e3" && result.rankedRootMoves.size() == 1,
      "Engine no longer selects the only legal en passant move.");

  OfflineGame final = game;
  offline::MoveInfo move;
  require(
      final.applyUci("d4e3", move) && move.san == "dxe3" &&
          move.enPassant && move.capturedSquare == "e4" &&
          final.fen() == kFinalFen,
      "En passant SAN, captured square, or final FEN changed.");
}

void verifyProgramCompilation() {
  const Fixture fixture = enPassantFixture();
  const OfflineCaptureMotionCompiler compiler;
  const auto removal = compiler.compile(fixture.removal);
  const auto attacker = compiler.compile(fixture.attacker);

  require(
      removal.success() &&
          removal.routeMode == ExternalRouteMode::GraveyardBoardPath &&
          removal.routeCost == 554.5 && removal.from == "e4" &&
          removal.to == "I4" && removal.graveyardSlotKey == "I4" &&
          removal.graveyardX == 17600 && removal.graveyardY == -350,
      "En passant removal metadata changed.");
  require(
      removal.rawPathSquares ==
              std::vector<std::string>({"e4", "f4", "g4", "h4"}) &&
          removal.compressedPathSquares ==
              std::vector<std::string>({"e4", "h4"}),
      "En passant victim route changed.");
  requireKinds(
      removal,
      {CaptureMotionPrimitiveKind::TravelBoard,
       CaptureMotionPrimitiveKind::Pickup,
       CaptureMotionPrimitiveKind::DragBoard,
       CaptureMotionPrimitiveKind::DragCoordinate,
       CaptureMotionPrimitiveKind::Drop,
       CaptureMotionPrimitiveKind::Verify},
      "en passant removal");
  for (const auto& primitive : removal.primitives) {
    require(
        !primitive.finalBoardDrop,
        "The en passant graveyard drop incorrectly enables overshoot.");
  }

  require(
      attacker.success() &&
          attacker.routeMode == ExternalRouteMode::BoardDirect &&
          attacker.routeCost == 14.0 && attacker.from == "d4" &&
          attacker.to == "e3",
      "En passant attacker metadata changed.");
  requireKinds(
      attacker,
      {CaptureMotionPrimitiveKind::TravelBoard,
       CaptureMotionPrimitiveKind::Pickup,
       CaptureMotionPrimitiveKind::DragBoard,
       CaptureMotionPrimitiveKind::Drop,
       CaptureMotionPrimitiveKind::Verify},
      "en passant attacker");
  require(
      attacker.primitives[2].finalBoardDrop &&
          attacker.primitives[2].targetRawIndex ==
              offline::squareToRawIndex("e3"),
      "The final e3 pawn drop must be the only overshoot.");
  require(
      removal.primitives == compiler.compile(fixture.removal).primitives &&
          attacker.primitives == compiler.compile(fixture.attacker).primitives,
      "En passant compilation is not deterministic.");
}

offline::ExternalTransferResult forcedLaneTransfer(
    const Occupancy& occupancy,
    bool laneBoard) {
  Occupancy routed = occupancy;
  if (laneBoard) setSquare(routed, "g3", true);
  offline::ExternalTransferRequest request;
  request.from = "d4";
  request.to = "e3";
  request.expectedOccupancy = routed;
  request.ignoredSquares = {"d4", "e3", "e4"};
  request.slots = offline::defaultExternalSlots();
  request.forceLane = true;
  return OfflineExternalRoutePlanner{}.planTransfer(request);
}

OfflinePhaseExecutionRequest attackerRequestForRoute(
    const offline::ExternalTransferResult& transfer,
    const Occupancy& before,
    const Occupancy& after) {
  const Fixture fixture = enPassantFixture();
  auto request = fixture.attacker;
  request.phase.transfer = transfer;
  request.phase.expectedBefore = before;
  request.phase.expectedAfter = after;
  return request;
}

void verifyLaneAndStagedCompatibility() {
  const Fixture fixture = enPassantFixture();
  const Occupancy afterRemoval = fixture.attacker.phase.expectedBefore;

  const auto lane = forcedLaneTransfer(afterRemoval, false);
  require(
      lane.success() && lane.mode == ExternalRouteMode::Lane,
      "Forced en passant Lane route changed.");
  auto laneRequest = attackerRequestForRoute(
      lane, afterRemoval, fixture.attacker.phase.expectedAfter);
  require(
      OfflineLaneMotionCompiler{}.compile(laneRequest).success() &&
          OfflineCaptureMotionCompiler{}.compile(laneRequest).success(),
      "Valid en passant Lane attacker final was rejected.");

  Occupancy laneBoardBefore = afterRemoval;
  setSquare(laneBoardBefore, "g3", true);
  Occupancy laneBoardAfter = fixture.attacker.phase.expectedAfter;
  setSquare(laneBoardAfter, "g3", true);
  const auto laneBoard = forcedLaneTransfer(afterRemoval, true);
  require(
      laneBoard.success() && laneBoard.mode == ExternalRouteMode::LaneBoard,
      "Forced en passant LaneBoard route changed.");
  auto laneBoardRequest =
      attackerRequestForRoute(laneBoard, laneBoardBefore, laneBoardAfter);
  require(
      OfflineLaneMotionCompiler{}.compile(laneBoardRequest).success() &&
          OfflineCaptureMotionCompiler{}.compile(laneBoardRequest).success(),
      "Valid en passant LaneBoard attacker final was rejected.");

  OfflinePhaseExecutionRequest stage = fixture.attacker;
  stage.token = {72, 0, 1};
  stage.phase.kind = MotionPhaseKind::AttackerStage;
  stage.phase.from = "d4";
  stage.phase.to = "c4";
  stage.phase.expectedBefore = fixture.removal.phase.expectedBefore;
  stage.phase.expectedAfter = stage.phase.expectedBefore;
  setSquare(stage.phase.expectedAfter, "d4", false);
  setSquare(stage.phase.expectedAfter, "c4", true);
  offline::ExternalTransferRequest route;
  route.from = "d4";
  route.to = "c4";
  route.expectedOccupancy = stage.phase.expectedBefore;
  route.ignoredSquares = {"d4", "c4"};
  route.slots = offline::defaultExternalSlots();
  stage.phase.transfer = OfflineExternalRoutePlanner{}.planTransfer(route);
  stage.phase.graveyard.reset();
  stage.graveyardState = GraveyardSlotState::Pending;
  require(
      stage.phase.transfer->success() &&
          OfflineCaptureMotionCompiler{}.compile(stage).success(),
      "Valid staged en passant attacker phase was rejected.");
}

void verifyMalformedMetadataRejected() {
  const Fixture fixture = enPassantFixture();
  const OfflineCaptureMotionCompiler captureCompiler;
  const OfflineLaneMotionCompiler laneCompiler;

  auto request = fixture.removal;
  request.move.capturedSquare = request.move.to;
  require(
      captureCompiler.compile(request).status ==
          CaptureMotionCompileStatus::UnsupportedMove,
      "En passant with the victim on its destination was accepted.");

  request = fixture.removal;
  request.move.piece = "n";
  require(
      captureCompiler.compile(request).status ==
          CaptureMotionCompileStatus::UnsupportedMove,
      "Non-pawn en passant metadata was accepted.");

  request = fixture.attacker;
  request.move.capturedSquare = "d4";
  require(
      captureCompiler.compile(request).status ==
          CaptureMotionCompileStatus::UnsupportedMove,
      "En passant with incorrect captured-square geometry was accepted.");

  const auto lane = forcedLaneTransfer(fixture.attacker.phase.expectedBefore, false);
  request = attackerRequestForRoute(
      lane,
      fixture.attacker.phase.expectedBefore,
      fixture.attacker.phase.expectedAfter);
  request.move.to = "f3";
  request.move.uci = "d4f3";
  require(
      !laneCompiler.compile(request).success() &&
          !captureCompiler.compile(request).success(),
      "Malformed two-file en passant lane metadata was accepted.");

  request = fixture.attacker;
  request.phase.expectedAfter = request.phase.expectedBefore;
  require(
      captureCompiler.compile(request).status ==
          CaptureMotionCompileStatus::InvalidOccupancy,
      "Unchanged en passant attacker occupancy was accepted.");
}

OfflineRuntimeConfig runtimeConfig() {
  OfflineRuntimeConfig config;
  config.initialFen = kInitialFen;
  config.coordinator.humanColor = HumanColor::White;
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

SearchResult enPassantSearch() {
  SearchResult result;
  result.bestMove = "d4e3";
  result.score = -456;
  result.completedDepth = 12;
  result.nodes = 2000;
  result.stopReason = SearchStopReason::NodeLimit;
  result.rankedRootMoves.push_back(RootMoveScore{"d4e3", -456, 0});
  return result;
}

struct RuntimeFixture {
  OfflineReadOnlyRuntime runtime{runtimeConfig()};
  Occupancy postHuman{};
};

void armRuntime(RuntimeFixture& fixture) {
  const Occupancy setup = fixture.runtime.expectedSetupOccupancy();
  fixture.runtime.applyOwnershipDecision(0, offlineOwnership(), setup);
  auto update =
      fixture.runtime.applyOwnershipDecision(500, offlineOwnership(), setup);
  require(
      update.phase == OfflineRuntimePhase::HumanTurn,
      "En passant runtime did not arm.");

  Occupancy lifted = setup;
  setSquare(lifted, "e2", false);
  fixture.runtime.processStableSnapshot(510, lifted);
  fixture.postHuman = lifted;
  setSquare(fixture.postHuman, "e4", true);
  update = fixture.runtime.processStableSnapshot(520, fixture.postHuman);
  require(
      update.phase == OfflineRuntimePhase::EngineSearchNeeded &&
          update.acceptedMove && update.acceptedMove->uci == "e2e4",
      "Physical e2e4 was not accepted.");

  const auto search = fixture.runtime.pendingEngineRequest();
  require(search.has_value(), "En passant runtime has no engine request.");
  update = fixture.runtime.submitEngineResult(
      search->generation, enPassantSearch(), fixture.postHuman);
  require(
      update.phase == OfflineRuntimePhase::PlanReady &&
          update.motionTransaction &&
          update.motionTransaction->selectedMove == "d4e3" &&
          update.motionTransaction->motion.move.enPassant &&
          update.motionTransaction->motion.routeCost == 568.5 &&
          update.motionTransaction->motion.phases.size() == 2 &&
          fixture.runtime.coordinator().physical().game().fen() ==
              kPostHumanFen,
      "Runtime did not stage the exact en passant transaction.");
}

void verifyTransactionalExecution() {
  RuntimeFixture fixture;
  armRuntime(fixture);
  OfflinePhaseExecutionAdapter adapter(fixture.runtime);
  auto update = adapter.begin();
  require(
      update.state == OfflinePhaseExecutionState::PhaseReady &&
          update.request &&
          update.request->phase.kind == MotionPhaseKind::CapturedRemoval &&
          update.request->phase.from == "e4" &&
          update.request->graveyardState == GraveyardSlotState::Pending,
      "En passant victim removal was not issued first.");

  auto request = *update.request;
  const std::string originalFen =
      fixture.runtime.coordinator().physical().game().fen();
  const auto outOfOrder = adapter.submitReport(
      OfflinePhaseExecutionReport{
          {request.token.transactionId, request.token.phaseIndex + 1, 1},
          true,
          request.phase.expectedAfter});
  require(
      outOfOrder.state == OfflinePhaseExecutionState::PhaseReady &&
          fixture.runtime.coordinator().physical().game().fen() == originalFen,
      "Out-of-order en passant report changed chess state.");

  adapter.takeCurrentRequest();
  const OfflinePhaseExecutionReport removalReport{
      request.token, true, request.phase.expectedAfter};
  update = adapter.submitReport(removalReport);
  require(
      update.state == OfflinePhaseExecutionState::PhaseReady &&
          update.request &&
          update.request->phase.kind == MotionPhaseKind::AttackerFinal &&
          update.request->phase.from == "d4" &&
          update.request->phase.to == "e3" &&
          update.request->graveyardState == GraveyardSlotState::Occupied &&
          fixture.runtime.coordinator().physical().game().fen() == originalFen,
      "I4 was not occupied before the en passant attacker phase.");
  const auto duplicate = adapter.submitReport(removalReport);
  require(
      duplicate.state == OfflinePhaseExecutionState::PhaseReady &&
          duplicate.request &&
          duplicate.request->phase.kind == MotionPhaseKind::AttackerFinal,
      "Duplicate en passant removal report advanced twice.");

  request = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, true, request.phase.expectedAfter});
  require(
      update.state == OfflinePhaseExecutionState::Complete &&
          fixture.runtime.coordinator().physical().game().fen() == kFinalFen,
      "Verified en passant phases did not commit the final FEN.");
}

void verifyRetriesAndRecovery() {
  RuntimeFixture retryFixture;
  armRuntime(retryFixture);
  OfflinePhaseExecutionAdapter retryAdapter(retryFixture.runtime);
  auto update = retryAdapter.begin();
  auto request = *update.request;
  retryAdapter.takeCurrentRequest();
  update = retryAdapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, false, request.phase.expectedBefore});
  require(
      update.state == OfflinePhaseExecutionState::RetryReady &&
          update.request && update.request->token.attempt == 2 &&
          offline::captureMotionAttemptAllowed(update.request->token),
      "Unchanged en passant removal failure did not issue one retry.");
  request = *update.request;
  retryAdapter.takeCurrentRequest();
  update = retryAdapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, false, request.phase.expectedBefore});
  require(
      update.state == OfflinePhaseExecutionState::RetryReady &&
          update.request && update.request->token.attempt == 3 &&
          !offline::captureMotionAttemptAllowed(update.request->token),
      "A third en passant removal attempt was not blocked.");

  RuntimeFixture partialFixture;
  armRuntime(partialFixture);
  OfflinePhaseExecutionAdapter partialAdapter(partialFixture.runtime);
  update = partialAdapter.begin();
  request = *update.request;
  partialAdapter.takeCurrentRequest();
  Occupancy partial = request.phase.expectedAfter;
  setSquare(partial, "d3", false);
  update = partialAdapter.submitReport(
      OfflinePhaseExecutionReport{request.token, false, partial});
  require(
      update.state == OfflinePhaseExecutionState::RecoveryRequired &&
          partialFixture.runtime.coordinator().physical().game().fen() ==
              kPostHumanFen,
      "Partial en passant removal did not freeze without a commit.");

  RuntimeFixture strandedFixture;
  armRuntime(strandedFixture);
  OfflinePhaseExecutionAdapter strandedAdapter(strandedFixture.runtime);
  update = strandedAdapter.begin();
  request = *update.request;
  strandedAdapter.takeCurrentRequest();
  update = strandedAdapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, true, request.phase.expectedAfter});
  request = *update.request;
  strandedAdapter.takeCurrentRequest();
  Occupancy stranded = request.phase.expectedBefore;
  setSquare(stranded, "d4", false);
  setSquare(stranded, "e3", false);
  update = strandedAdapter.submitReport(
      OfflinePhaseExecutionReport{request.token, false, stranded});
  require(
      update.state == OfflinePhaseExecutionState::RecoveryRequired &&
          strandedFixture.runtime.coordinator().physical().game().fen() ==
              kPostHumanFen,
      "A stranded en passant attacker did not freeze without committing.");
}

}  // namespace

int main() {
  try {
    verifyFixtureAndEngine();
    verifyProgramCompilation();
    verifyLaneAndStagedCompatibility();
    verifyMalformedMetadataRejected();
    verifyTransactionalExecution();
    verifyRetriesAndRecovery();
    std::cout << "offline en passant motion regressions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline en passant motion regression failed: "
              << error.what() << '\n';
    return 1;
  }
}
