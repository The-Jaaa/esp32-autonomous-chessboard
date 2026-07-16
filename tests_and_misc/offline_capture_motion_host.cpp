#include "../offline_core/offline_capture_motion.h"

#include <cmath>
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
using offline::MotionPhaseKind;
using offline::MotionPlan;
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
    "k7/8/8/3p4/8/8/4R3/4K3 w - - 0 1";
constexpr const char* kPostHumanFen =
    "k7/8/8/3p4/4R3/8/8/4K3 b - - 1 1";
constexpr const char* kFinalFen =
    "k7/8/8/8/4p3/8/8/4K3 w - - 0 2";
constexpr const char* kStagedInitialFen =
    "k7/8/8/8/8/8/1NPPbP2/2B2n1K w - - 0 1";
constexpr const char* kStagedPostHumanFen =
    "k7/8/8/8/8/8/2PPbP2/2BN1n1K b - - 1 1";
constexpr const char* kStagedFinalFen =
    "k7/8/8/8/8/8/2PP1P2/2Bb1n1K w - - 0 2";

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

struct Fixture {
  MotionPlan plan;
  std::string slotKey;
  OfflinePhaseExecutionRequest removal;
  OfflinePhaseExecutionRequest attacker;
};

Fixture captureFixture() {
  OfflineGame game;
  require(game.loadFen(kPostHumanFen), "Capture fixture FEN did not load.");
  MotionPlanningContext context;
  context.slots = offline::defaultExternalSlots();
  const MotionPlan plan =
      OfflineMotionPlanner{}.planMove(game, "d5e4", context);
  require(plan.success(), "Capture fixture did not produce a motion plan.");
  require(plan.strategy == MotionStrategy::CaptureDirectAfterRemoval,
          "Capture fixture did not use direct-after-removal.");
  require(plan.phases.size() == 2 && plan.proposedGraveyardSlot,
          "Capture fixture must have two phases and a graveyard slot.");
  require(plan.proposedGraveyardSlot->label == "I4" &&
              plan.proposedGraveyardSlot->x == 17600 &&
              plan.proposedGraveyardSlot->y == -350,
          "Capture fixture no longer selects the calibrated I4 slot.");

  Fixture fixture;
  fixture.plan = plan;
  fixture.slotKey = offline::externalSlotKey(*plan.proposedGraveyardSlot);
  fixture.removal.token = {31, 0, 1};
  fixture.removal.move = plan.move;
  fixture.removal.phase = plan.phases[0];
  fixture.removal.graveyardSlotKey = fixture.slotKey;
  fixture.removal.graveyardState = GraveyardSlotState::Pending;
  fixture.attacker.token = {31, 1, 1};
  fixture.attacker.move = plan.move;
  fixture.attacker.phase = plan.phases[1];
  fixture.attacker.graveyardSlotKey = fixture.slotKey;
  fixture.attacker.graveyardState = GraveyardSlotState::Occupied;
  return fixture;
}

struct StagedFixture {
  MotionPlan plan;
  std::string slotKey;
  std::vector<OfflinePhaseExecutionRequest> requests;
};

StagedFixture stagedCaptureFixture() {
  OfflineGame game;
  require(game.loadFen(kStagedPostHumanFen),
          "Staged capture fixture FEN did not load.");
  MotionPlanningContext context;
  context.slots = offline::defaultExternalSlots();
  const MotionPlan plan =
      OfflineMotionPlanner{}.planMove(game, "e2d1", context);
  require(plan.success(), "Staged capture fixture did not produce a plan.");
  require(plan.strategy == MotionStrategy::CaptureStageFirstBoard,
          "Staged fixture no longer uses stage-first-board.");
  require(plan.stagingSquare == "e1" && plan.phases.size() == 3 &&
              plan.proposedGraveyardSlot,
          "Staged fixture must use e1 and three phases.");
  require(plan.proposedGraveyardSlot->label == "I4" &&
              plan.proposedGraveyardSlot->x == 17600 &&
              plan.proposedGraveyardSlot->y == -350,
          "Staged fixture no longer selects calibrated I4.");

  StagedFixture fixture;
  fixture.plan = plan;
  fixture.slotKey = offline::externalSlotKey(*plan.proposedGraveyardSlot);
  for (std::size_t index = 0; index < plan.phases.size(); ++index) {
    OfflinePhaseExecutionRequest request;
    request.token = {41, index, 1};
    request.move = plan.move;
    request.phase = plan.phases[index];
    request.graveyardSlotKey = fixture.slotKey;
    request.graveyardState = index < 2 ? GraveyardSlotState::Pending
                                       : GraveyardSlotState::Occupied;
    fixture.requests.push_back(std::move(request));
  }
  return fixture;
}

void requireKinds(
    const offline::CaptureMotionProgram& program,
    const std::vector<CaptureMotionPrimitiveKind>& kinds,
    const std::string& context) {
  require(program.primitives.size() == kinds.size(),
          context + ": primitive count differs.");
  for (std::size_t index = 0; index < kinds.size(); ++index) {
    require(program.primitives[index].kind == kinds[index],
            context + ": primitive kind differs at " +
                std::to_string(index) + '.');
  }
}

void verifyFixtureEngineAndPlan() {
  OfflineGame game;
  require(game.loadFen(kInitialFen), "Initial fixture FEN did not load.");
  offline::MoveInfo human;
  require(game.applyUci("e2e4", human) && human.san == "Re4" &&
              game.fen() == kPostHumanFen,
          "Human fixture move no longer produces Re4.");

  OfflineEngine engine;
  SearchLimits limits;
  limits.timeLimitMs = 0;
  limits.maxDepth = 2;
  const SearchResult result = engine.searchFen(game.fen(), limits);
  require(result.bestMove == "d5e4",
          "The deterministic fixture engine response is no longer d5e4.");

  const Fixture fixture = captureFixture();
  require(fixture.plan.phases[0].kind == MotionPhaseKind::CapturedRemoval &&
              fixture.plan.phases[0].from == "e4" &&
              fixture.plan.phases[0].to == "I4" &&
              fixture.plan.phases[1].kind == MotionPhaseKind::AttackerFinal &&
              fixture.plan.phases[1].from == "d5" &&
              fixture.plan.phases[1].to == "e4",
          "The controlled capture phases changed.");
  require(fixture.plan.phases[0].graveyard &&
              fixture.plan.phases[0].graveyard->mode ==
                  ExternalRouteMode::GraveyardBoardPath &&
              fixture.plan.phases[0].graveyard->compressedPathSquares ==
                  std::vector<std::string>({"e4", "h4"}),
          "The expected e4-h4-I4 removal route changed.");
}

void verifyCapturedRemovalCompilation() {
  const Fixture fixture = captureFixture();
  const OfflineCaptureMotionCompiler compiler;
  const auto first = compiler.compile(fixture.removal);
  const auto second = compiler.compile(fixture.removal);
  require(first.success(), "Captured removal did not compile.");
  require(first.phaseKind == MotionPhaseKind::CapturedRemoval &&
              first.routeMode == ExternalRouteMode::GraveyardBoardPath &&
              first.from == "e4" && first.to == "I4" &&
              first.graveyardSlotKey == fixture.slotKey &&
              first.graveyardLabel == "I4" && first.graveyardX == 17600 &&
              first.graveyardY == -350,
          "Captured-removal metadata differs from the controlled route.");
  require(first.rawPathSquares ==
              std::vector<std::string>({"e4", "f4", "g4", "h4"}) &&
              first.compressedPathSquares ==
                  std::vector<std::string>({"e4", "h4"}),
          "Captured-removal path metadata changed.");
  requireKinds(
      first,
      {CaptureMotionPrimitiveKind::TravelBoard,
       CaptureMotionPrimitiveKind::Pickup,
       CaptureMotionPrimitiveKind::DragBoard,
       CaptureMotionPrimitiveKind::DragCoordinate,
       CaptureMotionPrimitiveKind::Drop,
       CaptureMotionPrimitiveKind::Verify},
      "captured removal");
  require(first.primitives[2].targetRawIndex ==
              offline::squareToRawIndex("h4") &&
              first.primitives[3].targetX == 17600 &&
              first.primitives[3].targetY == -350,
          "Captured-removal primitive targets changed.");
  for (const auto& primitive : first.primitives) {
    require(!primitive.finalBoardDrop,
            "A graveyard removal primitive incorrectly enables board overshoot.");
  }
  require(first.primitives == second.primitives &&
              first.expectedBefore == fixture.removal.phase.expectedBefore &&
              first.expectedAfter == fixture.removal.phase.expectedAfter,
          "Captured-removal compilation is not deterministic or immutable.");
}

void verifyAttackerFinalCompilation() {
  const Fixture fixture = captureFixture();
  const auto program =
      OfflineCaptureMotionCompiler{}.compile(fixture.attacker);
  require(program.success(), "Attacker final did not compile.");
  require(program.phaseKind == MotionPhaseKind::AttackerFinal &&
              program.routeMode == ExternalRouteMode::BoardDirect &&
              program.from == "d5" && program.to == "e4" &&
              program.graveyardSlotKey == fixture.slotKey,
          "Attacker-final metadata changed.");
  requireKinds(
      program,
      {CaptureMotionPrimitiveKind::TravelBoard,
       CaptureMotionPrimitiveKind::Pickup,
       CaptureMotionPrimitiveKind::DragBoard,
       CaptureMotionPrimitiveKind::Drop,
       CaptureMotionPrimitiveKind::Verify},
      "attacker final");
  require(program.primitives[2].finalBoardDrop,
          "The attacker final board drag must receive overshoot.");
  std::size_t overshoots = 0;
  for (const auto& primitive : program.primitives) {
    if (primitive.finalBoardDrop) ++overshoots;
  }
  require(overshoots == 1,
          "Exactly one attacker-final primitive must overshoot.");
}

void verifyStagedFixtureEngineAndPlan() {
  OfflineGame game;
  require(game.loadFen(kStagedInitialFen),
          "Staged initial fixture FEN did not load.");
  offline::MoveInfo human;
  require(game.applyUci("b2d1", human) && human.san == "Nd1" &&
              game.fen() == kStagedPostHumanFen,
          "Human staged-fixture move no longer produces Nd1.");

  SearchLimits limits;
  limits.timeLimitMs = 0;
  limits.maxNodes = 46000;
  limits.maxDepth = 12;
  const SearchResult result = OfflineEngine{}.searchFen(game.fen(), limits);
  require(result.bestMove == "e2d1",
          "The deterministic staged-fixture response is no longer e2d1.");

  const StagedFixture fixture = stagedCaptureFixture();
  require(fixture.plan.routeCost == 696.5 &&
              fixture.plan.phases[0].kind == MotionPhaseKind::AttackerStage &&
              fixture.plan.phases[0].from == "e2" &&
              fixture.plan.phases[0].to == "e1" &&
              fixture.plan.phases[1].kind == MotionPhaseKind::CapturedRemoval &&
              fixture.plan.phases[1].from == "d1" &&
              fixture.plan.phases[1].to == "I4" &&
              fixture.plan.phases[2].kind == MotionPhaseKind::AttackerFinal &&
              fixture.plan.phases[2].from == "e1" &&
              fixture.plan.phases[2].to == "d1",
          "The controlled staged-capture phases changed.");
  require(fixture.plan.phases[1].graveyard &&
              fixture.plan.phases[1].graveyard->rawPathSquares ==
                  std::vector<std::string>({"d1", "e2", "f3", "g4", "h4"}) &&
              fixture.plan.phases[1].graveyard->compressedPathSquares ==
                  std::vector<std::string>({"d1", "g4", "h4"}),
          "The staged d1-I4 removal route changed.");
}

void verifyStagedCompilation() {
  const StagedFixture fixture = stagedCaptureFixture();
  const OfflineCaptureMotionCompiler compiler;
  const auto stage = compiler.compile(fixture.requests[0]);
  const auto removal = compiler.compile(fixture.requests[1]);
  const auto final = compiler.compile(fixture.requests[2]);

  require(stage.success() && stage.phaseKind == MotionPhaseKind::AttackerStage &&
              stage.from == "e2" && stage.to == "e1" &&
              stage.routeMode == ExternalRouteMode::BoardDirect,
          "Attacker staging did not compile as a board transfer.");
  requireKinds(
      stage,
      {CaptureMotionPrimitiveKind::TravelBoard,
       CaptureMotionPrimitiveKind::Pickup,
       CaptureMotionPrimitiveKind::DragBoard,
       CaptureMotionPrimitiveKind::Drop,
       CaptureMotionPrimitiveKind::Verify},
      "attacker stage");
  require(stage.primitives[2].finalBoardDrop,
          "The staging board drop must receive overshoot.");

  require(removal.success() && removal.from == "d1" && removal.to == "I4" &&
              removal.rawPathSquares ==
                  std::vector<std::string>({"d1", "e2", "f3", "g4", "h4"}) &&
              removal.compressedPathSquares ==
                  std::vector<std::string>({"d1", "g4", "h4"}),
          "Staged captured-removal compilation changed.");
  requireKinds(
      removal,
      {CaptureMotionPrimitiveKind::TravelBoard,
       CaptureMotionPrimitiveKind::Pickup,
       CaptureMotionPrimitiveKind::DragBoard,
       CaptureMotionPrimitiveKind::DragBoard,
       CaptureMotionPrimitiveKind::DragCoordinate,
       CaptureMotionPrimitiveKind::Drop,
       CaptureMotionPrimitiveKind::Verify},
      "staged captured removal");
  for (const auto& primitive : removal.primitives) {
    require(!primitive.finalBoardDrop,
            "The staged graveyard route incorrectly enables overshoot.");
  }

  require(final.success() && final.phaseKind == MotionPhaseKind::AttackerFinal &&
              final.from == "e1" && final.to == "d1" &&
              final.routeMode == ExternalRouteMode::BoardDirect,
          "Staged attacker final did not compile from e1.");
  require(final.primitives[2].finalBoardDrop,
          "The staged final board drop must receive overshoot.");
  require(stage.primitives == compiler.compile(fixture.requests[0]).primitives &&
              final.primitives == compiler.compile(fixture.requests[2]).primitives,
          "Staged phase compilation is not deterministic.");
}

void verifyRejections() {
  const Fixture fixture = captureFixture();
  const OfflineCaptureMotionCompiler compiler;

  auto request = fixture.removal;
  request.phase.kind = MotionPhaseKind::AttackerStage;
  require(compiler.compile(request).status == CaptureMotionCompileStatus::UnsupportedMove,
          "Malformed attacker staging was accepted.");
  request = fixture.removal;
  request.move.enPassant = true;
  require(compiler.compile(request).status == CaptureMotionCompileStatus::UnsupportedMove,
          "En passant was accepted.");
  request = fixture.removal;
  request.move.castling = true;
  require(compiler.compile(request).status == CaptureMotionCompileStatus::UnsupportedMove,
          "Castling was accepted.");
  request = fixture.removal;
  request.move.promotion = "q";
  require(compiler.compile(request).status == CaptureMotionCompileStatus::UnsupportedMove,
          "Promotion was accepted.");

  request = fixture.removal;
  request.graveyardState = GraveyardSlotState::Occupied;
  require(compiler.compile(request).status == CaptureMotionCompileStatus::InvalidGraveyard,
          "Removal accepted an already occupied transaction slot.");
  request = fixture.removal;
  request.graveyardSlotKey = "Z4";
  require(compiler.compile(request).status == CaptureMotionCompileStatus::InvalidGraveyard,
          "Removal accepted a mismatched graveyard key.");
  request = fixture.removal;
  request.phase.graveyard->slot.y = std::nan("");
  require(compiler.compile(request).status == CaptureMotionCompileStatus::InvalidGraveyard,
          "Removal accepted a non-finite graveyard coordinate.");
  request = fixture.removal;
  request.phase.expectedAfter = request.phase.expectedBefore;
  require(compiler.compile(request).status == CaptureMotionCompileStatus::InvalidOccupancy,
          "Removal accepted unchanged occupancy.");
  request = fixture.removal;
  request.phase.graveyard->targets.front().rawIndex = 64;
  require(compiler.compile(request).status == CaptureMotionCompileStatus::InvalidPath,
          "Removal accepted a malformed board waypoint.");

  request = fixture.attacker;
  request.graveyardState = GraveyardSlotState::Pending;
  require(compiler.compile(request).status == CaptureMotionCompileStatus::InvalidGraveyard,
          "Attacker final accepted a pending graveyard slot.");
  request = fixture.attacker;
  request.phase.transfer->mode = ExternalRouteMode::Lane;
  require(!compiler.compile(request).success(),
          "Attacker final accepted malformed lane routing.");
  request = fixture.attacker;
  request.phase.expectedAfter = request.phase.expectedBefore;
  require(compiler.compile(request).status == CaptureMotionCompileStatus::InvalidOccupancy,
          "Attacker final accepted unchanged occupancy.");

  const StagedFixture staged = stagedCaptureFixture();
  request = staged.requests[0];
  request.graveyardState = GraveyardSlotState::Occupied;
  require(compiler.compile(request).status == CaptureMotionCompileStatus::InvalidGraveyard,
          "Attacker stage accepted an occupied graveyard slot.");
  request = staged.requests[0];
  request.phase.transfer->mode = ExternalRouteMode::Lane;
  require(!compiler.compile(request).success(),
          "Attacker stage accepted malformed lane routing.");
  request = staged.requests[0];
  request.phase.expectedAfter = request.phase.expectedBefore;
  require(compiler.compile(request).status == CaptureMotionCompileStatus::InvalidOccupancy,
          "Attacker stage accepted unchanged occupancy.");
  request = staged.requests[2];
  request.move.enPassant = true;
  require(compiler.compile(request).status == CaptureMotionCompileStatus::UnsupportedMove,
          "Staged final accepted en passant.");
}

OfflineRuntimeConfig runtimeConfig() {
  OfflineRuntimeConfig config;
  config.initialFen = kInitialFen;
  config.coordinator.humanColor = HumanColor::White;
  config.coordinator.searchLimits.timeLimitMs = 0;
  config.coordinator.searchLimits.maxDepth = 2;
  config.coordinator.externalSlots = offline::defaultExternalSlots();
  return config;
}

OwnershipDecision offlineOwnership() {
  OwnershipDecision decision;
  decision.state = OwnershipState::OfflineIdle;
  decision.allowOfflineControl = true;
  return decision;
}

SearchResult captureSearch() {
  SearchResult result;
  result.bestMove = "d5e4";
  result.score = 500;
  result.completedDepth = 2;
  result.stopReason = SearchStopReason::DepthLimit;
  result.rankedRootMoves.push_back(RootMoveScore{"d5e4", 500, 0});
  return result;
}

void setSquare(Occupancy& occupancy, const std::string& square, bool occupied) {
  const int index = offline::squareToRawIndex(square);
  require(index >= 0, "Test square is invalid: " + square);
  occupancy[static_cast<std::size_t>(index)] = occupied;
}

struct RuntimeFixture {
  OfflineReadOnlyRuntime runtime{runtimeConfig()};
  Occupancy postHuman{};
};

void armRuntime(RuntimeFixture& fixture) {
  const Occupancy setup = fixture.runtime.expectedSetupOccupancy();
  fixture.runtime.applyOwnershipDecision(0, offlineOwnership(), setup);
  auto update = fixture.runtime.applyOwnershipDecision(500, offlineOwnership(), setup);
  require(update.phase == OfflineRuntimePhase::HumanTurn,
          "Capture runtime did not arm for the human.");

  Occupancy lifted = setup;
  setSquare(lifted, "e2", false);
  update = fixture.runtime.processStableSnapshot(510, lifted);
  require(update.phase == OfflineRuntimePhase::HumanTurn,
          "Rook lift did not remain in the human turn.");
  fixture.postHuman = lifted;
  setSquare(fixture.postHuman, "e4", true);
  update = fixture.runtime.processStableSnapshot(520, fixture.postHuman);
  require(update.phase == OfflineRuntimePhase::EngineSearchNeeded &&
              update.acceptedMove && update.acceptedMove->uci == "e2e4",
          "Physical Re4 was not accepted.");
  const auto searchRequest = fixture.runtime.pendingEngineRequest();
  require(searchRequest.has_value(), "Capture runtime has no engine request.");
  update = fixture.runtime.submitEngineResult(
      searchRequest->generation, captureSearch(), fixture.postHuman);
  require(update.phase == OfflineRuntimePhase::PlanReady &&
              update.motionTransaction &&
              update.motionTransaction->selectedMove == "d5e4" &&
              update.motionTransaction->motion.phases.size() == 2,
          "Capture runtime did not stage the controlled capture.");
}

void verifyTransactionalExecution() {
  RuntimeFixture fixture;
  armRuntime(fixture);
  OfflinePhaseExecutionAdapter adapter(fixture.runtime);
  auto update = adapter.begin();
  require(update.state == OfflinePhaseExecutionState::PhaseReady && update.request &&
              update.request->phase.kind == MotionPhaseKind::CapturedRemoval &&
              update.request->graveyardState == GraveyardSlotState::Pending,
          "Captured-removal phase was not issued as pending.");
  auto request = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, true, request.phase.expectedAfter});
  require(update.state == OfflinePhaseExecutionState::PhaseReady && update.request &&
              update.request->phase.kind == MotionPhaseKind::AttackerFinal &&
              update.request->graveyardState == GraveyardSlotState::Occupied &&
              fixture.runtime.coordinator().physical().game().fen() == kPostHumanFen,
          "Captured removal did not occupy I4 without committing chess state.");

  request = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, true, request.phase.expectedAfter});
  require(update.state == OfflinePhaseExecutionState::Complete &&
              fixture.runtime.coordinator().physical().game().fen() == kFinalFen,
          "Attacker final did not commit the exact capture FEN.");
}

void verifyRetryAndRecovery() {
  RuntimeFixture fixture;
  armRuntime(fixture);
  OfflinePhaseExecutionAdapter adapter(fixture.runtime);
  auto update = adapter.begin();
  auto request = *update.request;
  require(offline::captureMotionAttemptAllowed(request.token),
          "Captured removal attempt one should be allowed.");
  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, false, request.phase.expectedBefore});
  require(update.state == OfflinePhaseExecutionState::RetryReady && update.request &&
              update.request->token.attempt == 2 &&
              offline::captureMotionAttemptAllowed(update.request->token),
          "Captured removal did not issue its one retry.");
  request = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, false, request.phase.expectedBefore});
  require(update.state == OfflinePhaseExecutionState::RetryReady && update.request &&
              update.request->token.attempt == 3 &&
              !offline::captureMotionAttemptAllowed(update.request->token) &&
              fixture.runtime.coordinator().physical().game().fen() == kPostHumanFen,
          "A third captured-removal attempt was not blocked safely.");

  RuntimeFixture recoveryFixture;
  armRuntime(recoveryFixture);
  OfflinePhaseExecutionAdapter recoveryAdapter(recoveryFixture.runtime);
  update = recoveryAdapter.begin();
  request = *update.request;
  recoveryAdapter.takeCurrentRequest();
  Occupancy ambiguous = request.phase.expectedBefore;
  setSquare(ambiguous, "e1", false);
  update = recoveryAdapter.submitReport(
      OfflinePhaseExecutionReport{request.token, false, ambiguous});
  require(update.state == OfflinePhaseExecutionState::RecoveryRequired &&
              recoveryFixture.runtime.coordinator().physical().game().fen() == kPostHumanFen,
          "Ambiguous captured removal did not freeze without committing state.");
}

OfflineRuntimeConfig stagedRuntimeConfig() {
  OfflineRuntimeConfig config;
  config.initialFen = kStagedInitialFen;
  config.coordinator.humanColor = HumanColor::White;
  config.coordinator.searchLimits.timeLimitMs = 0;
  config.coordinator.searchLimits.maxNodes = 46000;
  config.coordinator.searchLimits.maxDepth = 12;
  config.coordinator.externalSlots = offline::defaultExternalSlots();
  return config;
}

SearchResult stagedCaptureSearch() {
  SearchResult result;
  result.bestMove = "e2d1";
  result.score = 27;
  result.completedDepth = 5;
  result.nodes = 46000;
  result.stopReason = SearchStopReason::NodeLimit;
  result.rankedRootMoves.push_back(RootMoveScore{"e2d1", 27, 0});
  return result;
}

struct StagedRuntimeFixture {
  OfflineReadOnlyRuntime runtime{stagedRuntimeConfig()};
  Occupancy postHuman{};
};

void armStagedRuntime(StagedRuntimeFixture& fixture) {
  const Occupancy setup = fixture.runtime.expectedSetupOccupancy();
  fixture.runtime.applyOwnershipDecision(0, offlineOwnership(), setup);
  auto update = fixture.runtime.applyOwnershipDecision(500, offlineOwnership(), setup);
  require(update.phase == OfflineRuntimePhase::HumanTurn,
          "Staged runtime did not arm for the human.");

  Occupancy lifted = setup;
  setSquare(lifted, "b2", false);
  update = fixture.runtime.processStableSnapshot(510, lifted);
  require(update.phase == OfflineRuntimePhase::HumanTurn,
          "Staged knight lift did not remain in the human turn.");
  fixture.postHuman = lifted;
  setSquare(fixture.postHuman, "d1", true);
  update = fixture.runtime.processStableSnapshot(520, fixture.postHuman);
  require(update.phase == OfflineRuntimePhase::EngineSearchNeeded &&
              update.acceptedMove && update.acceptedMove->uci == "b2d1",
          "Physical Nd1 was not accepted.");
  const auto searchRequest = fixture.runtime.pendingEngineRequest();
  require(searchRequest.has_value(), "Staged runtime has no engine request.");
  update = fixture.runtime.submitEngineResult(
      searchRequest->generation, stagedCaptureSearch(), fixture.postHuman);
  require(update.phase == OfflineRuntimePhase::PlanReady &&
              update.motionTransaction &&
              update.motionTransaction->selectedMove == "e2d1" &&
              update.motionTransaction->motion.strategy ==
                  MotionStrategy::CaptureStageFirstBoard &&
              update.motionTransaction->motion.phases.size() == 3,
          "Runtime did not stage the controlled three-phase capture.");
}

void verifyStagedTransactionalExecution() {
  StagedRuntimeFixture fixture;
  armStagedRuntime(fixture);
  OfflinePhaseExecutionAdapter adapter(fixture.runtime);
  auto update = adapter.begin();
  require(update.state == OfflinePhaseExecutionState::PhaseReady &&
              update.request &&
              update.request->phase.kind == MotionPhaseKind::AttackerStage &&
              update.request->graveyardState == GraveyardSlotState::Pending,
          "Attacker-stage phase was not issued first.");

  auto request = *update.request;
  adapter.takeCurrentRequest();
  const OfflinePhaseExecutionReport stageReport{
      request.token, true, request.phase.expectedAfter};
  update = adapter.submitReport(stageReport);
  require(update.state == OfflinePhaseExecutionState::PhaseReady &&
              update.request &&
              update.request->phase.kind == MotionPhaseKind::CapturedRemoval &&
              update.request->graveyardState == GraveyardSlotState::Pending &&
              fixture.runtime.coordinator().physical().game().fen() ==
                  kStagedPostHumanFen,
          "Staging did not advance to pending captured removal.");
  const auto duplicate = adapter.submitReport(stageReport);
  require(duplicate.state == OfflinePhaseExecutionState::PhaseReady &&
              duplicate.request &&
              duplicate.request->phase.kind == MotionPhaseKind::CapturedRemoval,
          "Duplicate staging report changed the active phase.");

  request = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, true, request.phase.expectedAfter});
  require(update.state == OfflinePhaseExecutionState::PhaseReady &&
              update.request &&
              update.request->phase.kind == MotionPhaseKind::AttackerFinal &&
              update.request->graveyardState == GraveyardSlotState::Occupied &&
              fixture.runtime.coordinator().physical().game().fen() ==
                  kStagedPostHumanFen,
          "Removal did not occupy I4 before attacker final.");

  request = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      OfflinePhaseExecutionReport{
          request.token, true, request.phase.expectedAfter});
  require(update.state == OfflinePhaseExecutionState::Complete &&
              fixture.runtime.coordinator().physical().game().fen() ==
                  kStagedFinalFen,
          "Staged attacker final did not commit the exact FEN.");
}

void verifyStagedRetryAndRecovery() {
  for (std::size_t failedPhase = 0; failedPhase < 3; ++failedPhase) {
    StagedRuntimeFixture fixture;
    armStagedRuntime(fixture);
    OfflinePhaseExecutionAdapter adapter(fixture.runtime);
    auto update = adapter.begin();
    for (std::size_t phase = 0; phase < failedPhase; ++phase) {
      const auto request = *update.request;
      adapter.takeCurrentRequest();
      update = adapter.submitReport(
          OfflinePhaseExecutionReport{
              request.token, true, request.phase.expectedAfter});
    }

    auto request = *update.request;
    adapter.takeCurrentRequest();
    update = adapter.submitReport(
        OfflinePhaseExecutionReport{
            request.token, false, request.phase.expectedBefore});
    require(update.state == OfflinePhaseExecutionState::RetryReady &&
                update.request && update.request->token.attempt == 2 &&
                offline::captureMotionAttemptAllowed(update.request->token),
            "Staged phase did not issue its one allowed retry.");
    request = *update.request;
    adapter.takeCurrentRequest();
    update = adapter.submitReport(
        OfflinePhaseExecutionReport{
            request.token, false, request.phase.expectedBefore});
    require(update.state == OfflinePhaseExecutionState::RetryReady &&
                update.request && update.request->token.attempt == 3 &&
                !offline::captureMotionAttemptAllowed(update.request->token) &&
                fixture.runtime.coordinator().physical().game().fen() ==
                    kStagedPostHumanFen,
            "A third staged-phase attempt was not blocked safely.");
  }

  StagedRuntimeFixture recoveryFixture;
  armStagedRuntime(recoveryFixture);
  OfflinePhaseExecutionAdapter recoveryAdapter(recoveryFixture.runtime);
  auto update = recoveryAdapter.begin();
  const auto request = *update.request;
  recoveryAdapter.takeCurrentRequest();
  Occupancy ambiguous = request.phase.expectedBefore;
  setSquare(ambiguous, "a8", false);
  update = recoveryAdapter.submitReport(
      OfflinePhaseExecutionReport{request.token, false, ambiguous});
  require(update.state == OfflinePhaseExecutionState::RecoveryRequired &&
              recoveryFixture.runtime.coordinator().physical().game().fen() ==
                  kStagedPostHumanFen,
          "Ambiguous staging did not freeze without committing state.");
}

}  // namespace

int main() {
  try {
    verifyFixtureEngineAndPlan();
    verifyCapturedRemovalCompilation();
    verifyAttackerFinalCompilation();
    verifyStagedFixtureEngineAndPlan();
    verifyStagedCompilation();
    verifyRejections();
    verifyTransactionalExecution();
    verifyRetryAndRecovery();
    verifyStagedTransactionalExecution();
    verifyStagedRetryAndRecovery();
    std::cout << "offline capture motion compiler regressions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline capture motion compiler regression failed: "
              << error.what() << '\n';
    return 1;
  }
}
