#include "../offline_core/offline_lane_motion.h"

#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::ExternalRouteMode;
using offline::ExternalTargetType;
using offline::GraveyardSlotState;
using offline::HumanColor;
using offline::LaneMotionCompileStatus;
using offline::LaneMotionPrimitiveKind;
using offline::MotionPhaseKind;
using offline::MotionPlanningContext;
using offline::MotionStrategy;
using offline::Occupancy;
using offline::OfflineEngine;
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

constexpr const char* kDirectInitialFen =
    "k7/8/8/3n4/pppppppp/8/4NN1R/4BKR1 w - - 0 1";
constexpr const char* kDirectPostHumanFen =
    "k7/8/8/3n4/pppppppp/8/4NNR1/4BKR1 b - - 1 1";
constexpr const char* kDirectFinalFen =
    "k7/8/8/8/pppppppp/4n3/4NNR1/4BKR1 w - - 2 2";
constexpr const char* kLaneBoardInitialFen =
    "k7/8/8/3n4/pppppppp/2p3p1/4NN1R/4BKR1 w - - 0 1";
constexpr const char* kLaneBoardPostHumanFen =
    "k7/8/8/3n4/pppppppp/2p3p1/4NNR1/4BKR1 b - - 1 1";
constexpr const char* kLaneBoardFinalFen =
    "k7/8/8/8/pppppppp/2p1n1p1/4NNR1/4BKR1 w - - 2 2";

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void setSquare(Occupancy& occupancy, const std::string& square, bool occupied) {
  const int index = offline::squareToRawIndex(square);
  require(index >= 0, "Invalid test square: " + square);
  occupancy[static_cast<std::size_t>(index)] = occupied;
}

struct LaneFixture {
  const char* name;
  const char* initialFen;
  const char* postHumanFen;
  const char* finalFen;
  ExternalRouteMode mode;
  int routeCost;
  std::vector<std::string> rawPath;
  std::vector<std::string> compressedPath;
  std::vector<std::string> boardTargets;
};

const LaneFixture kDirectFixture{
    "direct-lane",
    kDirectInitialFen,
    kDirectPostHumanFen,
    kDirectFinalFen,
    ExternalRouteMode::Lane,
    1300,
    {"d5", "e3"},
    {"d5", "e3"},
    {"e3"}};

const LaneFixture kLaneBoardFixture{
    "lane-board",
    kLaneBoardInitialFen,
    kLaneBoardPostHumanFen,
    kLaneBoardFinalFen,
    ExternalRouteMode::LaneBoard,
    1366,
    {"d5", "a3", "a2", "b1", "c1", "d2", "e3"},
    {"d5", "a3", "a2", "b1", "c1", "e3"},
    {"a3", "a2", "b1", "c1", "e3"}};

OfflinePhaseExecutionRequest requestFor(const LaneFixture& fixture) {
  OfflineGame game;
  require(game.loadFen(fixture.postHumanFen),
          std::string(fixture.name) + ": post-human FEN did not load.");
  MotionPlanningContext context;
  context.slots = offline::defaultExternalSlots();
  const auto plan = OfflineMotionPlanner{}.planMove(game, "d5e3", context);
  require(plan.success() && plan.strategy == MotionStrategy::Quiet &&
              plan.phases.size() == 1,
          std::string(fixture.name) + ": quiet motion plan changed.");
  OfflinePhaseExecutionRequest request;
  request.token = {51, 0, 1};
  request.move = plan.move;
  request.phase = plan.phases.front();
  return request;
}

void requireKinds(
    const offline::LaneMotionProgram& program,
    const std::vector<LaneMotionPrimitiveKind>& kinds,
    const std::string& context) {
  require(program.primitives.size() == kinds.size(),
          context + ": primitive count differs.");
  for (std::size_t index = 0; index < kinds.size(); ++index) {
    require(program.primitives[index].kind == kinds[index],
            context + ": primitive kind differs at index " +
                std::to_string(index) + '.');
  }
}

void verifyEngineFixture(const LaneFixture& fixture) {
  OfflineGame game;
  require(game.loadFen(fixture.initialFen),
          std::string(fixture.name) + ": initial FEN did not load.");
  offline::MoveInfo human;
  require(game.applyUci("h2g2", human) && human.san == "Rhg2" &&
              game.fen() == fixture.postHumanFen,
          std::string(fixture.name) + ": human fixture move changed.");
  SearchLimits limits;
  limits.timeLimitMs = 0;
  limits.maxNodes = 2000;
  limits.maxDepth = 12;
  const SearchResult result = OfflineEngine{}.searchFen(game.fen(), limits);
  require(result.bestMove == "d5e3" && result.mateIn == 1,
          std::string(fixture.name) + ": engine no longer selects Ne3#.");
}

void verifyCompiledFixture(const LaneFixture& fixture) {
  const auto request = requestFor(fixture);
  const auto originalRequest = request;
  const OfflineLaneMotionCompiler compiler;
  const auto first = compiler.compile(request);
  const auto second = compiler.compile(request);
  require(first.success() && first.routeMode == fixture.mode &&
              first.routeCost == fixture.routeCost,
          std::string(fixture.name) + ": route mode or cost changed.");
  require(first.rawPathSquares == fixture.rawPath &&
              first.compressedPathSquares == fixture.compressedPath,
          std::string(fixture.name) + ": route paths changed.");
  require(first.routeTargets.size() == 2 + fixture.boardTargets.size(),
          std::string(fixture.name) + ": target count changed.");
  require(first.routeTargets[0].type == ExternalTargetType::Coordinate &&
              first.routeTargets[0].label == "Z5" &&
              first.routeTargets[0].lane == 'Z' &&
              first.routeTargets[0].x == 13300 &&
              first.routeTargets[0].y == 34450 &&
              first.routeTargets[1].type == ExternalTargetType::Coordinate &&
              first.routeTargets[1].label == "Z3" &&
              first.routeTargets[1].lane == 'Z' &&
              first.routeTargets[1].x == 21300 &&
              first.routeTargets[1].y == 34450,
          std::string(fixture.name) + ": calibrated Z5/Z3 coordinates changed.");
  for (std::size_t index = 0; index < fixture.boardTargets.size(); ++index) {
    require(first.routeTargets[index + 2].square == fixture.boardTargets[index],
            std::string(fixture.name) + ": board target sequence changed.");
  }

  std::vector<LaneMotionPrimitiveKind> expectedKinds{
      LaneMotionPrimitiveKind::TravelBoard,
      LaneMotionPrimitiveKind::Pickup,
      LaneMotionPrimitiveKind::DragCoordinate,
      LaneMotionPrimitiveKind::DragCoordinate};
  expectedKinds.insert(
      expectedKinds.end(),
      fixture.boardTargets.size(),
      LaneMotionPrimitiveKind::DragBoard);
  expectedKinds.push_back(LaneMotionPrimitiveKind::Drop);
  expectedKinds.push_back(LaneMotionPrimitiveKind::Verify);
  requireKinds(first, expectedKinds, fixture.name);

  std::size_t overshoots = 0;
  for (const auto& primitive : first.primitives) {
    if (primitive.finalBoardDrop) ++overshoots;
  }
  require(overshoots == 1 && first.primitives[first.primitives.size() - 3].finalBoardDrop &&
              first.primitives[first.primitives.size() - 3].targetRawIndex ==
                  offline::squareToRawIndex("e3"),
          std::string(fixture.name) +
              ": only the final e3 board drag may overshoot.");
  require(first.primitives == second.primitives &&
              request.phase.expectedBefore == originalRequest.phase.expectedBefore &&
              request.phase.expectedAfter == originalRequest.phase.expectedAfter &&
              request.phase.transfer->targets.size() ==
                  originalRequest.phase.transfer->targets.size() &&
              request.phase.transfer->targets.front().label ==
                  originalRequest.phase.transfer->targets.front().label &&
              request.phase.transfer->targets.front().x ==
                  originalRequest.phase.transfer->targets.front().x,
          std::string(fixture.name) +
              ": compilation is not deterministic or mutated its input.");
  require(offline::squareToRawIndex("h8") == 0 &&
              offline::squareToRawIndex("a1") == 56 &&
              offline::squareToRawIndex("a8") == 63,
          "Physical square mapping changed.");
}

offline::ExternalTransferResult forcedLaneTransfer(
    const std::string& from,
    const std::string& to,
    const Occupancy& occupancy) {
  offline::ExternalTransferRequest route;
  route.from = from;
  route.to = to;
  route.expectedOccupancy = occupancy;
  route.ignoredSquares = {from, to};
  route.slots = offline::defaultExternalSlots();
  route.forceLane = true;
  return offline::OfflineExternalRoutePlanner{}.planTransfer(route);
}

void verifyAttackerPhaseCompatibility() {
  auto stage = requestFor(kDirectFixture);
  stage.phase.kind = MotionPhaseKind::AttackerStage;
  stage.move.capture = true;
  stage.move.uci = "d5f3";
  stage.move.to = "f3";
  stage.move.capturedSquare = "f3";
  stage.graveyardSlotKey = "I4";
  stage.graveyardState = GraveyardSlotState::Pending;
  require(OfflineLaneMotionCompiler{}.compile(stage).success(),
          "A valid ordinary attacker-stage lane phase was rejected.");

  OfflinePhaseExecutionRequest final;
  final.token = {52, 2, 1};
  final.move = stage.move;
  final.move.to = "e3";
  final.move.uci = "d5e3";
  final.move.capturedSquare = "e3";
  final.phase.kind = MotionPhaseKind::AttackerFinal;
  final.phase.from = "e1";
  final.phase.to = "e3";
  setSquare(final.phase.expectedBefore, "e1", true);
  final.phase.expectedAfter = final.phase.expectedBefore;
  setSquare(final.phase.expectedAfter, "e1", false);
  setSquare(final.phase.expectedAfter, "e3", true);
  final.phase.transfer = forcedLaneTransfer(
      final.phase.from, final.phase.to, final.phase.expectedBefore);
  final.graveyardSlotKey = "I4";
  final.graveyardState = GraveyardSlotState::Occupied;
  require(final.phase.transfer->success() &&
              OfflineLaneMotionCompiler{}.compile(final).success(),
          "A valid ordinary attacker-final lane phase was rejected.");
}

void verifyRejections() {
  const OfflineLaneMotionCompiler compiler;
  const auto valid = requestFor(kDirectFixture);
  auto request = valid;
  request.phase.kind = MotionPhaseKind::CapturedRemoval;
  require(compiler.compile(request).status == LaneMotionCompileStatus::InvalidPhase,
          "Captured removal was accepted by the lane compiler.");
  request = valid;
  request.move.castling = true;
  require(compiler.compile(request).status == LaneMotionCompileStatus::UnsupportedMove,
          "Castling was accepted by the lane compiler.");
  request = valid;
  request.move.enPassant = true;
  require(compiler.compile(request).status == LaneMotionCompileStatus::UnsupportedMove,
          "En passant was accepted by the lane compiler.");
  request = valid;
  request.move.promotion = "q";
  require(compiler.compile(request).status == LaneMotionCompileStatus::UnsupportedMove,
          "Promotion was accepted by the lane compiler.");
  request = valid;
  request.phase.transfer->targets[1].lane = 'I';
  require(compiler.compile(request).status == LaneMotionCompileStatus::UnsupportedRoute,
          "A direct Z-to-I segment was accepted.");
  request = valid;
  request.phase.transfer->targets[0].x = std::nan("");
  require(compiler.compile(request).status == LaneMotionCompileStatus::InvalidCoordinate,
          "A non-finite lane coordinate was accepted.");
  request = valid;
  std::swap(request.phase.transfer->targets[1], request.phase.transfer->targets[2]);
  require(compiler.compile(request).status == LaneMotionCompileStatus::InvalidPath,
          "A coordinate after board re-entry was accepted.");
  request = valid;
  request.phase.expectedAfter = request.phase.expectedBefore;
  require(compiler.compile(request).status == LaneMotionCompileStatus::InvalidOccupancy,
          "An unchanged occupancy transition was accepted.");
  request = valid;
  request.phase.transfer->mode = ExternalRouteMode::BoardBuffered;
  require(compiler.compile(request).status == LaneMotionCompileStatus::UnsupportedRoute,
          "A board-only route was accepted by the lane compiler.");
  request = valid;
  request.phase.transfer.reset();
  require(compiler.compile(request).status == LaneMotionCompileStatus::InvalidPhase,
          "A missing transfer was accepted.");
  request = valid;
  request.phase.graveyard = offline::GraveyardRouteCandidate{};
  request.phase.transfer.reset();
  require(compiler.compile(request).status == LaneMotionCompileStatus::InvalidPhase,
          "A graveyard phase was accepted.");

  require(offline::laneMotionAttemptAllowed({1, 0, 1}) &&
              offline::laneMotionAttemptAllowed({1, 0, 2}) &&
              !offline::laneMotionAttemptAllowed({1, 0, 0}) &&
              !offline::laneMotionAttemptAllowed({1, 0, 3}),
          "The lane motion two-attempt limit changed.");
}

OfflineRuntimeConfig runtimeConfig(const LaneFixture& fixture) {
  OfflineRuntimeConfig config;
  config.initialFen = fixture.initialFen;
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

SearchResult laneSearch() {
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
  explicit RuntimeFixture(const LaneFixture& selected)
      : definition(selected), runtime(runtimeConfig(selected)) {}
  const LaneFixture& definition;
  OfflineReadOnlyRuntime runtime;
  Occupancy postHuman{};
};

void armRuntime(RuntimeFixture& fixture) {
  const Occupancy setup = fixture.runtime.expectedSetupOccupancy();
  fixture.runtime.applyOwnershipDecision(0, offlineOwnership(), setup);
  auto update = fixture.runtime.applyOwnershipDecision(500, offlineOwnership(), setup);
  require(update.phase == OfflineRuntimePhase::HumanTurn,
          std::string(fixture.definition.name) + ": runtime did not arm.");
  Occupancy lifted = setup;
  setSquare(lifted, "h2", false);
  fixture.runtime.processStableSnapshot(510, lifted);
  fixture.postHuman = lifted;
  setSquare(fixture.postHuman, "g2", true);
  update = fixture.runtime.processStableSnapshot(520, fixture.postHuman);
  require(update.phase == OfflineRuntimePhase::EngineSearchNeeded &&
              update.acceptedMove && update.acceptedMove->uci == "h2g2",
          std::string(fixture.definition.name) + ": Rhg2 was not accepted.");
  const auto search = fixture.runtime.pendingEngineRequest();
  require(search.has_value(), "The lane fixture has no engine request.");
  update = fixture.runtime.submitEngineResult(
      search->generation, laneSearch(), fixture.postHuman);
  require(update.phase == OfflineRuntimePhase::PlanReady &&
              update.motionTransaction &&
              update.motionTransaction->selectedMove == "d5e3" &&
              update.motionTransaction->motion.phases.size() == 1 &&
              update.motionTransaction->motion.phases[0].transfer &&
              update.motionTransaction->motion.phases[0].transfer->mode ==
                  fixture.definition.mode,
          std::string(fixture.definition.name) + ": runtime plan changed.");
}

void verifyTransactionalExecution(const LaneFixture& definition) {
  RuntimeFixture fixture(definition);
  armRuntime(fixture);
  OfflinePhaseExecutionAdapter adapter(fixture.runtime);
  auto update = adapter.begin();
  require(update.state == OfflinePhaseExecutionState::PhaseReady && update.request,
          std::string(definition.name) + ": phase request was not issued.");
  const auto request = *update.request;
  require(OfflineLaneMotionCompiler{}.compile(request).success() &&
              fixture.runtime.coordinator().physical().game().fen() ==
                  definition.postHumanFen,
          std::string(definition.name) +
              ": compiling a staged move mutated chess state.");
  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      OfflinePhaseExecutionReport{request.token, true, request.phase.expectedAfter});
  require((update.state == OfflinePhaseExecutionState::GameOver ||
           update.state == OfflinePhaseExecutionState::Complete) &&
              fixture.runtime.coordinator().physical().game().fen() ==
                  definition.finalFen &&
              fixture.runtime.coordinator().physical().game().status().outcome ==
                  offline::GameOutcome::Checkmate,
          std::string(definition.name) +
              ": verified phase did not commit the checkmate FEN.");
  const auto duplicate = adapter.submitReport(
      OfflinePhaseExecutionReport{request.token, true, request.phase.expectedAfter});
  require(fixture.runtime.coordinator().physical().game().fen() == definition.finalFen &&
              (duplicate.state == OfflinePhaseExecutionState::GameOver ||
               duplicate.state == OfflinePhaseExecutionState::Complete),
          std::string(definition.name) + ": duplicate report committed twice.");
}

void verifyRetryAndRecovery() {
  RuntimeFixture fixture(kDirectFixture);
  armRuntime(fixture);
  OfflinePhaseExecutionAdapter adapter(fixture.runtime);
  auto update = adapter.begin();
  auto request = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      OfflinePhaseExecutionReport{request.token, false, request.phase.expectedBefore});
  require(update.state == OfflinePhaseExecutionState::RetryReady && update.request &&
              update.request->token.attempt == 2 &&
              offline::laneMotionAttemptAllowed(update.request->token),
          "An unchanged lane failure did not issue its one retry.");
  const auto stale = adapter.submitReport(
      OfflinePhaseExecutionReport{request.token, true, request.phase.expectedAfter});
  require(stale.state == OfflinePhaseExecutionState::RetryReady && stale.request &&
              stale.request->token.attempt == 2,
          "A stale lane attempt changed the retry token.");

  request = *update.request;
  adapter.takeCurrentRequest();
  Occupancy ambiguous = request.phase.expectedBefore;
  setSquare(ambiguous, "d5", false);
  update = adapter.submitReport(
      OfflinePhaseExecutionReport{request.token, false, ambiguous});
  require(update.state == OfflinePhaseExecutionState::RecoveryRequired &&
              fixture.runtime.coordinator().physical().game().fen() ==
                  kDirectPostHumanFen,
          "A stranded off-board lane piece did not enter recovery safely.");

  RuntimeFixture limitFixture(kDirectFixture);
  armRuntime(limitFixture);
  OfflinePhaseExecutionAdapter limitAdapter(limitFixture.runtime);
  update = limitAdapter.begin();
  for (int attempt = 1; attempt <= 2; ++attempt) {
    request = *update.request;
    limitAdapter.takeCurrentRequest();
    update = limitAdapter.submitReport(
        OfflinePhaseExecutionReport{request.token, false, request.phase.expectedBefore});
  }
  require(update.state == OfflinePhaseExecutionState::RetryReady && update.request &&
              update.request->token.attempt == 3 &&
              !offline::laneMotionAttemptAllowed(update.request->token) &&
              limitFixture.runtime.coordinator().physical().game().fen() ==
                  kDirectPostHumanFen,
          "A third lane hardware attempt was not blocked without a commit.");
}

}  // namespace

int main() {
  try {
    verifyEngineFixture(kDirectFixture);
    verifyEngineFixture(kLaneBoardFixture);
    verifyCompiledFixture(kDirectFixture);
    verifyCompiledFixture(kLaneBoardFixture);
    verifyAttackerPhaseCompatibility();
    verifyRejections();
    verifyTransactionalExecution(kDirectFixture);
    verifyTransactionalExecution(kLaneBoardFixture);
    verifyRetryAndRecovery();
    std::cout << "offline lane motion compiler regressions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline lane motion compiler regression failed: "
              << error.what() << '\n';
    return 1;
  }
}
