#include "../offline_core/offline_capture_motion.h"

#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::CaptureMotionPrimitiveKind;
using offline::ExternalRouteMode;
using offline::ExternalTargetType;
using offline::GraveyardSlotState;
using offline::HumanColor;
using offline::MotionPhaseKind;
using offline::MotionPlanningContext;
using offline::MotionStrategy;
using offline::Occupancy;
using offline::OfflineCaptureMotionCompiler;
using offline::OfflineEngine;
using offline::OfflineGame;
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
    "k7/8/8/3n4/pppppppp/4P3/4NN1R/4BKR1 w - - 0 1";
constexpr const char* kPostHumanFen =
    "k7/8/8/3n4/pppppppp/4P3/4NNR1/4BKR1 b - - 1 1";
constexpr const char* kFinalFen =
    "k7/8/8/8/pppppppp/4n3/4NNR1/4BKR1 w - - 0 2";
constexpr const char* kLaneBoardPostHumanFen =
    "k7/8/8/3n4/pppppppp/2p3p1/4NNR1/4BKR1 b - - 1 1";

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
            '.');
  }
}

struct Fixture {
  offline::MotionPlan plan;
  std::string slotKey;
  OfflinePhaseExecutionRequest removal;
  OfflinePhaseExecutionRequest attacker;
};

Fixture captureLaneFixture() {
  OfflineGame game;
  require(game.loadFen(kPostHumanFen), "Post-human fixture FEN did not load.");
  MotionPlanningContext context;
  context.slots = offline::defaultExternalSlots();
  const auto plan = OfflineMotionPlanner{}.planMove(game, "d5e3", context);
  require(plan.success(), "Capture-lane fixture did not produce a plan.");
  require(
      plan.strategy == MotionStrategy::CaptureDirectAfterRemoval &&
          plan.routeCost == 1952.0 && plan.phases.size() == 2 &&
          plan.proposedGraveyardSlot,
      "Capture-lane strategy, cost, or phase count changed.");
  require(
      plan.proposedGraveyardSlot->label == "Z2" &&
          plan.proposedGraveyardSlot->x == 24800 &&
          plan.proposedGraveyardSlot->y == 34450,
      "Capture-lane fixture no longer selects calibrated Z2.");

  Fixture fixture;
  fixture.plan = plan;
  fixture.slotKey = offline::externalSlotKey(*plan.proposedGraveyardSlot);
  fixture.removal.token = {61, 0, 1};
  fixture.removal.move = plan.move;
  fixture.removal.phase = plan.phases[0];
  fixture.removal.graveyardSlotKey = fixture.slotKey;
  fixture.removal.graveyardState = GraveyardSlotState::Pending;
  fixture.attacker.token = {61, 1, 1};
  fixture.attacker.move = plan.move;
  fixture.attacker.phase = plan.phases[1];
  fixture.attacker.graveyardSlotKey = fixture.slotKey;
  fixture.attacker.graveyardState = GraveyardSlotState::Occupied;
  return fixture;
}

void verifyFixtureAndEngine() {
  OfflineGame game;
  require(game.loadFen(kInitialFen), "Initial fixture FEN did not load.");
  offline::MoveInfo human;
  require(
      game.applyUci("h2g2", human) && human.san == "Rhg2" &&
          game.fen() == kPostHumanFen,
      "Human fixture move no longer produces Rhg2.");

  SearchLimits limits;
  limits.timeLimitMs = 0;
  limits.maxNodes = 2000;
  limits.maxDepth = 12;
  const auto result = OfflineEngine{}.searchFen(game.fen(), limits);
  require(
      result.bestMove == "d5e3" && result.mateIn == 1,
      "Engine no longer selects deterministic Nxe3#.");

  const Fixture fixture = captureLaneFixture();
  const auto& removal = fixture.plan.phases[0];
  const auto& attacker = fixture.plan.phases[1];
  require(
      removal.kind == MotionPhaseKind::CapturedRemoval &&
          removal.from == "e3" && removal.to == "Z2" &&
          removal.graveyard &&
          removal.graveyard->mode ==
              ExternalRouteMode::GraveyardBoardPath &&
          removal.graveyard->routeCost == 652.0 &&
          removal.graveyard->rawPathSquares ==
              std::vector<std::string>({"e3", "d2", "c2", "b2", "a2"}) &&
          removal.graveyard->compressedPathSquares ==
              std::vector<std::string>({"e3", "d2", "a2"}),
      "Captured-removal route changed.");
  require(
      attacker.kind == MotionPhaseKind::AttackerFinal &&
          attacker.from == "d5" && attacker.to == "e3" &&
          attacker.transfer &&
          attacker.transfer->mode == ExternalRouteMode::Lane &&
          attacker.transfer->routeCost == 1300.0 &&
          attacker.transfer->rawPathSquares ==
              std::vector<std::string>({"d5", "e3"}) &&
          attacker.transfer->compressedPathSquares ==
              std::vector<std::string>({"d5", "e3"}),
      "Lane-routed attacker phase changed.");

  OfflineGame final = game;
  offline::MoveInfo move;
  require(
      final.applyUci("d5e3", move) && move.san == "Nxe3#" &&
          final.fen() == kFinalFen &&
          final.status().outcome == offline::GameOutcome::Checkmate,
      "Expected checkmate result changed.");
}

void verifyCapturedRemovalCompilation() {
  const Fixture fixture = captureLaneFixture();
  const OfflineCaptureMotionCompiler compiler;
  const auto first = compiler.compile(fixture.removal);
  const auto second = compiler.compile(fixture.removal);
  require(
      first.success() &&
          first.routeMode == ExternalRouteMode::GraveyardBoardPath &&
          first.routeCost == 652.0 && first.from == "e3" &&
          first.to == "Z2" && first.graveyardSlotKey == "Z2" &&
          first.graveyardX == 24800 && first.graveyardY == 34450,
      "Captured-removal metadata changed.");
  require(
      first.rawPathSquares ==
              std::vector<std::string>({"e3", "d2", "c2", "b2", "a2"}) &&
          first.compressedPathSquares ==
              std::vector<std::string>({"e3", "d2", "a2"}),
      "Captured-removal path metadata changed.");
  require(
      first.routeTargets.size() == 3 &&
          first.routeTargets[0].type == ExternalTargetType::Square &&
          first.routeTargets[0].square == "d2" &&
          first.routeTargets[1].type == ExternalTargetType::Square &&
          first.routeTargets[1].square == "a2" &&
          first.routeTargets[2].type == ExternalTargetType::Coordinate &&
          first.routeTargets[2].label == "Z2" &&
          first.routeTargets[2].x == 24800 &&
          first.routeTargets[2].y == 34450,
      "Captured-removal route targets changed.");
  requireKinds(
      first,
      {CaptureMotionPrimitiveKind::TravelBoard,
       CaptureMotionPrimitiveKind::Pickup,
       CaptureMotionPrimitiveKind::DragBoard,
       CaptureMotionPrimitiveKind::DragBoard,
       CaptureMotionPrimitiveKind::DragCoordinate,
       CaptureMotionPrimitiveKind::Drop,
       CaptureMotionPrimitiveKind::Verify},
      "captured removal");
  for (const auto& item : first.primitives) {
    require(
        !item.finalBoardDrop,
        "Graveyard removal incorrectly enables board overshoot.");
  }
  require(
      first.primitives == second.primitives &&
          first.routeTargets.size() == second.routeTargets.size() &&
          fixture.removal.phase.expectedBefore == first.expectedBefore &&
          fixture.removal.phase.expectedAfter == first.expectedAfter,
      "Captured-removal compilation is not deterministic or immutable.");
}

void verifyLaneAttackerCompilation() {
  const Fixture fixture = captureLaneFixture();
  const OfflineCaptureMotionCompiler compiler;
  const auto first = compiler.compile(fixture.attacker);
  const auto second = compiler.compile(fixture.attacker);
  require(
      first.success() && first.phaseKind == MotionPhaseKind::AttackerFinal &&
          first.routeMode == ExternalRouteMode::Lane &&
          first.routeCost == 1300.0 && first.from == "d5" &&
          first.to == "e3",
      "Lane attacker metadata changed.");
  require(
      first.routeTargets.size() == 3 &&
          first.routeTargets[0].type == ExternalTargetType::Coordinate &&
          first.routeTargets[0].label == "Z5" &&
          first.routeTargets[0].x == 13300 &&
          first.routeTargets[0].y == 34450 &&
          first.routeTargets[1].type == ExternalTargetType::Coordinate &&
          first.routeTargets[1].label == "Z3" &&
          first.routeTargets[1].x == 21300 &&
          first.routeTargets[1].y == 34450 &&
          first.routeTargets[2].type == ExternalTargetType::Square &&
          first.routeTargets[2].square == "e3",
      "Lane attacker targets changed.");
  requireKinds(
      first,
      {CaptureMotionPrimitiveKind::TravelBoard,
       CaptureMotionPrimitiveKind::Pickup,
       CaptureMotionPrimitiveKind::DragCoordinate,
       CaptureMotionPrimitiveKind::DragCoordinate,
       CaptureMotionPrimitiveKind::DragBoard,
       CaptureMotionPrimitiveKind::Drop,
       CaptureMotionPrimitiveKind::Verify},
      "lane attacker final");
  std::size_t overshoots = 0;
  for (const auto& item : first.primitives) {
    if (item.finalBoardDrop) ++overshoots;
  }
  require(
      overshoots == 1 && first.primitives[4].finalBoardDrop &&
          first.primitives[4].targetRawIndex ==
              offline::squareToRawIndex("e3"),
      "Only the final e3 board drag may overshoot.");
  require(
      first.primitives == second.primitives &&
          first.expectedBefore == fixture.attacker.phase.expectedBefore &&
          first.expectedAfter == fixture.attacker.phase.expectedAfter,
      "Lane attacker compilation is not deterministic or immutable.");
}

OfflinePhaseExecutionRequest laneBoardAttackerFinal() {
  OfflineGame game;
  require(
      game.loadFen(kLaneBoardPostHumanFen),
      "LaneBoard compatibility FEN did not load.");
  MotionPlanningContext context;
  context.slots = offline::defaultExternalSlots();
  const auto plan = OfflineMotionPlanner{}.planMove(game, "d5e3", context);
  require(
      plan.success() && plan.phases.size() == 1 &&
          plan.phases[0].transfer &&
          plan.phases[0].transfer->mode == ExternalRouteMode::LaneBoard,
      "LaneBoard compatibility route changed.");
  OfflinePhaseExecutionRequest request;
  request.token = {62, 2, 1};
  request.move = plan.move;
  request.move.capture = true;
  request.move.capturedPiece = "p";
  request.move.capturedSquare = "e3";
  request.phase = plan.phases[0];
  request.phase.kind = MotionPhaseKind::AttackerFinal;
  request.graveyardSlotKey = "Z2";
  request.graveyardState = GraveyardSlotState::Occupied;
  return request;
}

void verifyAttackerLaneCompatibility() {
  const OfflineCaptureMotionCompiler compiler;
  const Fixture fixture = captureLaneFixture();

  auto stage = fixture.attacker;
  stage.token = {62, 0, 1};
  stage.move.uci = "d5f3";
  stage.move.to = "f3";
  stage.move.capturedSquare = "f3";
  stage.phase.kind = MotionPhaseKind::AttackerStage;
  stage.phase.to = "e3";
  stage.graveyardState = GraveyardSlotState::Pending;
  const auto stageProgram = compiler.compile(stage);
  require(
      stageProgram.success() &&
          stageProgram.phaseKind == MotionPhaseKind::AttackerStage &&
          stageProgram.routeMode == ExternalRouteMode::Lane,
      "Valid lane-routed attacker staging was rejected.");

  const auto final = laneBoardAttackerFinal();
  const auto finalProgram = compiler.compile(final);
  require(
      finalProgram.success() &&
          finalProgram.phaseKind == MotionPhaseKind::AttackerFinal &&
          finalProgram.routeMode == ExternalRouteMode::LaneBoard &&
          finalProgram.compressedPathSquares ==
              std::vector<std::string>(
                  {"d5", "a3", "a2", "b1", "c1", "e3"}),
      "Valid LaneBoard attacker final was rejected.");

  auto malformed = fixture.attacker;
  malformed.phase.transfer->targets[1].lane = 'I';
  require(
      !compiler.compile(malformed).success(),
      "A mixed Z/I attacker lane route was accepted.");

  malformed = final;
  setSquare(malformed.phase.expectedBefore, "a2", true);
  setSquare(malformed.phase.expectedAfter, "a2", true);
  require(
      !compiler.compile(malformed).success(),
      "An occupied LaneBoard re-entry path was accepted.");
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

SearchResult captureLaneSearch() {
  SearchResult result;
  result.bestMove = "d5e3";
  result.score = 29999;
  result.mateIn = 1;
  result.completedDepth = 1;
  result.nodes = 575;
  result.stopReason = SearchStopReason::Complete;
  result.rankedRootMoves.push_back(RootMoveScore{"d5e3", 29999, 1});
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
      "Capture-lane runtime did not arm.");

  Occupancy lifted = setup;
  setSquare(lifted, "h2", false);
  fixture.runtime.processStableSnapshot(510, lifted);
  fixture.postHuman = lifted;
  setSquare(fixture.postHuman, "g2", true);
  update = fixture.runtime.processStableSnapshot(520, fixture.postHuman);
  require(
      update.phase == OfflineRuntimePhase::EngineSearchNeeded &&
          update.acceptedMove && update.acceptedMove->uci == "h2g2",
      "Physical Rhg2 was not accepted.");

  const auto search = fixture.runtime.pendingEngineRequest();
  require(search.has_value(), "Capture-lane runtime has no engine request.");
  update = fixture.runtime.submitEngineResult(
      search->generation, captureLaneSearch(), fixture.postHuman);
  require(
      update.phase == OfflineRuntimePhase::PlanReady &&
          update.motionTransaction &&
          update.motionTransaction->selectedMove == "d5e3" &&
          update.motionTransaction->motion.strategy ==
              MotionStrategy::CaptureDirectAfterRemoval &&
          update.motionTransaction->motion.routeCost == 1952.0 &&
          update.motionTransaction->motion.phases.size() == 2 &&
          fixture.runtime.coordinator().physical().game().fen() ==
              kPostHumanFen,
      "Runtime did not stage the exact capture-lane transaction.");
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
          update.request->graveyardState == GraveyardSlotState::Pending,
      "Pending captured removal was not issued first.");

  auto request = *update.request;
  const auto originalFen =
      fixture.runtime.coordinator().physical().game().fen();
  const auto outOfOrderToken = offline::OfflinePhaseExecutionToken{
      request.token.transactionId, request.token.phaseIndex + 1, 1};
  const auto outOfOrder = adapter.submitReport(
      OfflinePhaseExecutionReport{
          outOfOrderToken, true, request.phase.expectedAfter});
  require(
      outOfOrder.state == OfflinePhaseExecutionState::PhaseReady &&
          fixture.runtime.coordinator().physical().game().fen() == originalFen,
      "An out-of-order report changed transaction state.");

  adapter.takeCurrentRequest();
  const OfflinePhaseExecutionReport removalReport{
      request.token, true, request.phase.expectedAfter};
  update = adapter.submitReport(removalReport);
  require(
      update.state == OfflinePhaseExecutionState::PhaseReady &&
          update.request &&
          update.request->phase.kind == MotionPhaseKind::AttackerFinal &&
          update.request->graveyardState == GraveyardSlotState::Occupied &&
          fixture.runtime.coordinator().physical().game().fen() ==
              kPostHumanFen,
      "Z2 was not occupied transactionally before attacker motion.");
  const auto duplicate = adapter.submitReport(removalReport);
  require(
      duplicate.state == OfflinePhaseExecutionState::PhaseReady &&
          duplicate.request &&
          duplicate.request->phase.kind == MotionPhaseKind::AttackerFinal,
      "Duplicate removal report advanced twice.");

  request = *update.request;
  require(
      OfflineCaptureMotionCompiler{}.compile(request).success(),
      "Issued lane attacker phase did not compile.");
  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, true, request.phase.expectedAfter});
  require(
      (update.state == OfflinePhaseExecutionState::Complete ||
       update.state == OfflinePhaseExecutionState::GameOver) &&
          fixture.runtime.coordinator().physical().game().fen() == kFinalFen &&
          fixture.runtime.coordinator()
                  .physical()
                  .game()
                  .status()
                  .outcome == offline::GameOutcome::Checkmate,
      "Final attacker verification did not commit the checkmate FEN.");
}

void verifyRetriesAndRecovery() {
  RuntimeFixture removalFixture;
  armRuntime(removalFixture);
  OfflinePhaseExecutionAdapter removalAdapter(removalFixture.runtime);
  auto update = removalAdapter.begin();
  auto request = *update.request;
  removalAdapter.takeCurrentRequest();
  Occupancy partial = request.phase.expectedAfter;
  setSquare(partial, "a8", false);
  update = removalAdapter.submitReport(
      OfflinePhaseExecutionReport{request.token, false, partial});
  require(
      update.state == OfflinePhaseExecutionState::RecoveryRequired &&
          removalFixture.runtime.coordinator().physical().game().fen() ==
              kPostHumanFen,
      "Partial captured removal did not enter recovery without a commit.");

  RuntimeFixture attackerFixture;
  armRuntime(attackerFixture);
  OfflinePhaseExecutionAdapter attackerAdapter(attackerFixture.runtime);
  update = attackerAdapter.begin();
  request = *update.request;
  attackerAdapter.takeCurrentRequest();
  update = attackerAdapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, true, request.phase.expectedAfter});
  request = *update.request;
  attackerAdapter.takeCurrentRequest();
  update = attackerAdapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, false, request.phase.expectedBefore});
  require(
      update.state == OfflinePhaseExecutionState::RetryReady &&
          update.request && update.request->token.attempt == 2 &&
          offline::captureMotionAttemptAllowed(update.request->token),
      "Unchanged attacker failure did not issue its one retry.");
  const auto stale = attackerAdapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, true, request.phase.expectedAfter});
  require(
      stale.state == OfflinePhaseExecutionState::RetryReady &&
          stale.request && stale.request->token.attempt == 2,
      "Stale attacker attempt changed retry state.");
  request = *update.request;
  attackerAdapter.takeCurrentRequest();
  update = attackerAdapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, false, request.phase.expectedBefore});
  require(
      update.state == OfflinePhaseExecutionState::RetryReady &&
          update.request && update.request->token.attempt == 3 &&
          !offline::captureMotionAttemptAllowed(update.request->token) &&
          attackerFixture.runtime.coordinator().physical().game().fen() ==
              kPostHumanFen,
      "A third attacker attempt was not blocked safely.");

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
  setSquare(stranded, "d5", false);
  setSquare(stranded, "e3", false);
  update = strandedAdapter.submitReport(
      OfflinePhaseExecutionReport{request.token, false, stranded});
  require(
      update.state == OfflinePhaseExecutionState::RecoveryRequired &&
          strandedFixture.runtime.coordinator().physical().game().fen() ==
              kPostHumanFen,
      "A stranded lane attacker did not freeze without committing state.");
}

}  // namespace

int main() {
  try {
    verifyFixtureAndEngine();
    verifyCapturedRemovalCompilation();
    verifyLaneAttackerCompilation();
    verifyAttackerLaneCompatibility();
    verifyTransactionalExecution();
    verifyRetriesAndRecovery();
    std::cout << "offline capture lane motion regressions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline capture lane motion regression failed: "
              << error.what() << '\n';
    return 1;
  }
}
