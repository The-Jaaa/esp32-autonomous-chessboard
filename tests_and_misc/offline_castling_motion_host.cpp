#include "../offline_core/offline_castling_motion.h"
#include "../offline_core/offline_engine.h"

#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::CaptureMotionPrimitiveKind;
using offline::ExternalRouteMode;
using offline::GraveyardSlotState;
using offline::HumanColor;
using offline::MotionPhaseKind;
using offline::MotionPlanningContext;
using offline::MotionStrategy;
using offline::Occupancy;
using offline::OfflineCastlingMotionCompiler;
using offline::OfflineEngine;
using offline::OfflineGame;
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
    "4k2r/8/8/8/8/8/P3P1P1/4RKR1 w k - 0 1";
constexpr const char* kPostHumanFen =
    "4k2r/8/8/8/8/P7/4P1P1/4RKR1 b k - 0 1";
constexpr const char* kFinalFen =
    "5rk1/8/8/8/8/P7/4P1P1/4RKR1 w - - 1 2";

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void setSquare(Occupancy& occupancy, const std::string& square, bool occupied) {
  const int rawIndex = offline::squareToRawIndex(square);
  require(rawIndex >= 0, "Invalid test square: " + square);
  occupancy[static_cast<std::size_t>(rawIndex)] = occupied;
}

void requireKinds(
    const offline::CaptureMotionProgram& program,
    const std::vector<CaptureMotionPrimitiveKind>& kinds,
    const std::string& context) {
  require(program.primitives.size() == kinds.size(), context + ": primitive count changed.");
  for (std::size_t index = 0; index < kinds.size(); ++index) {
    require(
        program.primitives[index].kind == kinds[index],
        context + ": primitive kind changed at " + std::to_string(index) + ".");
  }
}

struct CastlingFixture {
  offline::MotionPlan plan;
  OfflinePhaseExecutionRequest king;
  OfflinePhaseExecutionRequest rook;
};

CastlingFixture planCastle(const std::string& fen, const std::string& uci) {
  OfflineGame game;
  require(game.loadFen(fen), uci + ": castling FEN did not load.");
  MotionPlanningContext context;
  context.slots = offline::defaultExternalSlots();
  context.sensedOccupancy = offline::occupancyFromFen(fen);
  const auto plan = offline::OfflineMotionPlanner{}.planMove(game, uci, context);
  require(
      plan.success() && plan.move.castling && plan.phases.size() == 2 &&
          plan.phases[0].kind == MotionPhaseKind::CastleKing &&
          plan.phases[1].kind == MotionPhaseKind::CastleRook,
      uci + ": castling plan shape changed.");

  CastlingFixture fixture;
  fixture.plan = plan;
  fixture.king.token = {91, 0, 1};
  fixture.king.move = plan.move;
  fixture.king.phase = plan.phases[0];
  fixture.king.graveyardState = GraveyardSlotState::Free;
  fixture.rook.token = {91, 1, 1};
  fixture.rook.move = plan.move;
  fixture.rook.phase = plan.phases[1];
  fixture.rook.graveyardState = GraveyardSlotState::Free;
  return fixture;
}

void verifyControlledFixture() {
  OfflineGame game;
  require(game.loadFen(kInitialFen), "Controlled castling fixture did not load.");
  offline::MoveInfo human;
  require(
      game.applyUci("a2a3", human) && human.san == "a3" &&
          game.fen() == kPostHumanFen,
      "The controlled human move no longer produces the expected FEN.");

  SearchLimits limits;
  limits.timeLimitMs = 0;
  limits.maxNodes = 0;
  limits.maxDepth = 4;
  const auto search = OfflineEngine{}.searchFen(game.fen(), limits);
  require(
      search.bestMove == "e8g8" && search.mateIn == 1,
      "The deterministic engine no longer selects e8g8 mate.");

  const CastlingFixture fixture = planCastle(kPostHumanFen, "e8g8");
  require(
      fixture.plan.strategy == MotionStrategy::CastleBoard &&
          fixture.plan.routeCost == 68.0,
      std::string("Controlled castling strategy or total route cost changed: ") +
          offline::motionStrategyName(fixture.plan.strategy) + "/" +
          std::to_string(fixture.plan.routeCost) + ".");
  require(
      fixture.king.phase.transfer->mode == ExternalRouteMode::BoardLine &&
          fixture.king.phase.transfer->routeCost == 20 &&
          fixture.king.phase.transfer->rawPathSquares ==
              std::vector<std::string>({"e8", "f8", "g8"}) &&
          fixture.king.phase.transfer->compressedPathSquares ==
              std::vector<std::string>({"e8", "g8"}),
      "Controlled king path changed.");
  require(
      fixture.rook.phase.transfer->mode == ExternalRouteMode::BoardBuffered &&
          fixture.rook.phase.transfer->routeCost == 48 &&
          fixture.rook.phase.transfer->rawPathSquares ==
              std::vector<std::string>({"h8", "g7", "f8"}),
      "Controlled rook path no longer routes around the king.");

  OfflineGame final = game;
  offline::MoveInfo castle;
  require(
      final.applyUci("e8g8", castle) && castle.san == "O-O#" &&
          final.fen() == kFinalFen &&
          final.status().outcome == offline::GameOutcome::Checkmate,
      "Controlled castling SAN, final FEN, or checkmate status changed.");
}

void verifyProgramCompilation() {
  const CastlingFixture fixture = planCastle(kPostHumanFen, "e8g8");
  const OfflineCastlingMotionCompiler compiler;
  const auto king = compiler.compile(fixture.king);
  const auto rook = compiler.compile(fixture.rook);

  require(
      king.success() && king.phaseKind == MotionPhaseKind::CastleKing &&
          king.routeMode == ExternalRouteMode::BoardLine && king.routeCost == 20 &&
          king.from == "e8" && king.to == "g8",
      "King phase compilation changed.");
  requireKinds(
      king,
      {CaptureMotionPrimitiveKind::TravelBoard,
       CaptureMotionPrimitiveKind::Pickup,
       CaptureMotionPrimitiveKind::DragBoard,
       CaptureMotionPrimitiveKind::Drop,
       CaptureMotionPrimitiveKind::Verify},
      "castle king");
  require(
      king.primitives[2].finalBoardDrop &&
          king.primitives[2].targetRawIndex == offline::squareToRawIndex("g8"),
      "King final board placement must receive the only phase overshoot.");

  require(
      rook.success() && rook.phaseKind == MotionPhaseKind::CastleRook &&
          rook.routeMode == ExternalRouteMode::BoardBuffered && rook.routeCost == 48 &&
          rook.from == "h8" && rook.to == "f8",
      "Rook phase compilation changed.");
  requireKinds(
      rook,
      {CaptureMotionPrimitiveKind::TravelBoard,
       CaptureMotionPrimitiveKind::Pickup,
       CaptureMotionPrimitiveKind::DragBoard,
       CaptureMotionPrimitiveKind::DragBoard,
       CaptureMotionPrimitiveKind::Drop,
       CaptureMotionPrimitiveKind::Verify},
      "castle rook");
  require(
      !rook.primitives[2].finalBoardDrop && rook.primitives[3].finalBoardDrop &&
          rook.primitives[3].targetRawIndex == offline::squareToRawIndex("f8"),
      "Only the rook's final board waypoint may receive overshoot.");
  require(
      king.primitives == compiler.compile(fixture.king).primitives &&
          rook.primitives == compiler.compile(fixture.rook).primitives,
      "Castling compilation is not deterministic.");
}

void verifyAllCastlingDirections() {
  struct Direction {
    const char* fen;
    const char* uci;
  };
  const std::vector<Direction> directions = {
      {"4k3/8/8/8/8/8/8/4K2R w K - 0 1", "e1g1"},
      {"4k3/8/8/8/8/8/8/R3K3 w Q - 0 1", "e1c1"},
      {"4k2r/8/8/8/8/8/8/4K3 b k - 0 1", "e8g8"},
      {"r3k3/8/8/8/8/8/8/4K3 b q - 0 1", "e8c8"},
  };
  for (const Direction& direction : directions) {
    const CastlingFixture fixture = planCastle(direction.fen, direction.uci);
    require(
        OfflineCastlingMotionCompiler{}.compile(fixture.king).success() &&
            OfflineCastlingMotionCompiler{}.compile(fixture.rook).success(),
        std::string(direction.uci) + ": a castling direction failed compilation.");
  }
}

OfflinePhaseExecutionRequest forcedLaneRequest(
    const CastlingFixture& fixture,
    const OfflinePhaseExecutionRequest& source,
    bool addReentryBlocker) {
  OfflinePhaseExecutionRequest request = source;
  Occupancy before = source.phase.expectedBefore;
  Occupancy after = source.phase.expectedAfter;
  if (addReentryBlocker) {
    setSquare(before, "f7", true);
    setSquare(after, "f7", true);
  }
  offline::ExternalTransferRequest route;
  route.from = source.phase.from;
  route.to = source.phase.to;
  route.expectedOccupancy = before;
  route.ignoredSquares = {source.phase.from, source.phase.to};
  route.slots = offline::defaultExternalSlots();
  route.forceLane = true;
  request.phase.expectedBefore = before;
  request.phase.expectedAfter = after;
  request.phase.transfer = offline::OfflineExternalRoutePlanner{}.planTransfer(route);
  request.phase.graveyard.reset();
  require(request.phase.transfer->success(), "Forced castling lane route failed.");
  (void)fixture;
  return request;
}

void verifyLaneCompilation() {
  const CastlingFixture fixture = planCastle(kPostHumanFen, "e8g8");
  auto lane = forcedLaneRequest(fixture, fixture.king, false);
  require(
      lane.phase.transfer->mode == ExternalRouteMode::Lane &&
          OfflineCastlingMotionCompiler{}.compile(lane).success(),
      "Valid direct Lane castling phase was rejected.");

  const std::string crowdedFen =
      "rn1qk2r/ppp2ppp/4p3/3p1b2/3PnP2/P1P1Q3/1BP1P1PP/R3KBNR b kq - 4 8";
  const CastlingFixture crowded = planCastle(crowdedFen, "e8g8");
  const bool hasLaneBoard =
      crowded.king.phase.transfer->mode == ExternalRouteMode::LaneBoard ||
      crowded.rook.phase.transfer->mode == ExternalRouteMode::LaneBoard;
  require(hasLaneBoard, "Crowded castle no longer exercises LaneBoard routing.");
  require(
      OfflineCastlingMotionCompiler{}.compile(crowded.king).success() &&
          OfflineCastlingMotionCompiler{}.compile(crowded.rook).success(),
      "Crowded LaneBoard castling phases were rejected.");
}

void verifyMalformedRequestsRejected() {
  const CastlingFixture fixture = planCastle(kPostHumanFen, "e8g8");
  const OfflineCastlingMotionCompiler compiler;

  auto request = fixture.king;
  request.move.castling = false;
  require(
      compiler.compile(request).status ==
          offline::CaptureMotionCompileStatus::UnsupportedMove,
      "A non-castling move was accepted.");

  request = fixture.king;
  request.move.rookTo = "e8";
  require(!compiler.compile(request).success(), "Malformed rook metadata was accepted.");

  request = fixture.rook;
  request.token.phaseIndex = 0;
  require(
      compiler.compile(request).status ==
          offline::CaptureMotionCompileStatus::InvalidPhase,
      "The rook was accepted before the king phase.");

  request = fixture.king;
  request.phase.expectedAfter = request.phase.expectedBefore;
  require(
      compiler.compile(request).status ==
          offline::CaptureMotionCompileStatus::InvalidOccupancy,
      "An unchanged king occupancy transition was accepted.");

  request = fixture.king;
  request.graveyardSlotKey = "I4";
  request.graveyardState = GraveyardSlotState::Pending;
  require(
      compiler.compile(request).status ==
          offline::CaptureMotionCompileStatus::InvalidGraveyard,
      "Castling was allowed to own a graveyard slot.");
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

SearchResult castleSearch() {
  SearchResult result;
  result.bestMove = "e8g8";
  result.score = 29999;
  result.mateIn = 1;
  result.completedDepth = 1;
  result.nodes = 17;
  result.stopReason = SearchStopReason::Complete;
  result.rankedRootMoves.push_back(RootMoveScore{"e8g8", 29999, 1});
  return result;
}

struct RuntimeFixture {
  OfflineReadOnlyRuntime runtime{runtimeConfig()};
  Occupancy postHuman{};
};

void armRuntime(RuntimeFixture& fixture) {
  const Occupancy setup = fixture.runtime.expectedSetupOccupancy();
  fixture.runtime.applyOwnershipDecision(0, offlineOwnership(), setup);
  auto update = fixture.runtime.applyOwnershipDecision(500, offlineOwnership(), setup);
  require(update.phase == OfflineRuntimePhase::HumanTurn, "Castling runtime did not arm.");

  Occupancy lifted = setup;
  setSquare(lifted, "a2", false);
  fixture.runtime.processStableSnapshot(510, lifted);
  fixture.postHuman = lifted;
  setSquare(fixture.postHuman, "a3", true);
  update = fixture.runtime.processStableSnapshot(520, fixture.postHuman);
  require(
      update.phase == OfflineRuntimePhase::EngineSearchNeeded &&
          update.acceptedMove && update.acceptedMove->uci == "a2a3",
      "Physical a2a3 was not accepted.");

  const auto request = fixture.runtime.pendingEngineRequest();
  require(request.has_value(), "Castling runtime has no engine request.");
  update = fixture.runtime.submitEngineResult(
      request->generation, castleSearch(), fixture.postHuman);
  require(
      update.phase == OfflineRuntimePhase::PlanReady &&
          update.motionTransaction &&
          update.motionTransaction->selectedMove == "e8g8" &&
          update.motionTransaction->motion.strategy == MotionStrategy::CastleBoard &&
          update.motionTransaction->motion.routeCost == 68.0 &&
          fixture.runtime.coordinator().physical().game().fen() == kPostHumanFen,
      "Runtime did not stage the controlled castling transaction.");
}

OfflinePhaseExecutionReport reportFor(
    const OfflinePhaseExecutionRequest& request,
    bool success,
    const Occupancy& occupancy) {
  return OfflinePhaseExecutionReport{request.token, success, occupancy};
}

void verifyTransactionalExecutionAndRetries() {
  RuntimeFixture fixture;
  armRuntime(fixture);
  OfflinePhaseExecutionAdapter adapter(fixture.runtime);
  auto update = adapter.begin();
  require(
      update.state == OfflinePhaseExecutionState::PhaseReady && update.request &&
          update.request->phase.kind == MotionPhaseKind::CastleKing,
      "Castle king was not issued first.");

  auto king = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(reportFor(king, false, king.phase.expectedBefore));
  require(
      update.state == OfflinePhaseExecutionState::RetryReady && update.request &&
          update.request->token.phaseIndex == 0 &&
          update.request->token.attempt == 2 &&
          offline::castlingMotionAttemptAllowed(update.request->token),
      "Unchanged king failure did not retry only the king.");
  king = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(reportFor(king, true, king.phase.expectedAfter));
  require(
      update.state == OfflinePhaseExecutionState::PhaseReady && update.request &&
          update.request->phase.kind == MotionPhaseKind::CastleRook &&
          update.request->token.phaseIndex == 1 &&
          fixture.runtime.coordinator().physical().game().fen() == kPostHumanFen,
      "Verified king did not advance to the rook without committing chess state.");

  auto rook = *update.request;
  const auto staleKing = adapter.submitReport(reportFor(king, true, king.phase.expectedAfter));
  require(
      staleKing.state == OfflinePhaseExecutionState::PhaseReady &&
          staleKing.request && staleKing.request->token.phaseIndex == 1,
      "Duplicate king report incorrectly restarted castling.");
  adapter.takeCurrentRequest();
  update = adapter.submitReport(reportFor(rook, false, rook.phase.expectedBefore));
  require(
      update.state == OfflinePhaseExecutionState::RetryReady && update.request &&
          update.request->token.phaseIndex == 1 &&
          update.request->token.attempt == 2,
      "Unchanged rook failure did not retry only the rook.");
  rook = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(reportFor(rook, true, rook.phase.expectedAfter));
  require(
      update.state == OfflinePhaseExecutionState::GameOver &&
          fixture.runtime.coordinator().physical().game().fen() == kFinalFen,
      "Two verified castling phases did not commit checkmate.");

  RuntimeFixture exhaustedFixture;
  armRuntime(exhaustedFixture);
  OfflinePhaseExecutionAdapter exhausted(exhaustedFixture.runtime);
  update = exhausted.begin();
  king = *update.request;
  exhausted.takeCurrentRequest();
  update = exhausted.submitReport(reportFor(king, false, king.phase.expectedBefore));
  king = *update.request;
  exhausted.takeCurrentRequest();
  update = exhausted.submitReport(reportFor(king, false, king.phase.expectedBefore));
  require(
      update.request && update.request->token.attempt == 3 &&
          !offline::castlingMotionAttemptAllowed(update.request->token),
      "A third automatic king attempt was not blocked.");
}

void verifyAmbiguousOccupancyRecovery() {
  RuntimeFixture fixture;
  armRuntime(fixture);
  OfflinePhaseExecutionAdapter adapter(fixture.runtime);
  auto update = adapter.begin();
  auto king = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(reportFor(king, true, king.phase.expectedAfter));
  auto rook = *update.request;
  adapter.takeCurrentRequest();
  Occupancy ambiguous = rook.phase.expectedBefore;
  setSquare(ambiguous, "e2", false);
  update = adapter.submitReport(reportFor(rook, false, ambiguous));
  require(
      update.state == OfflinePhaseExecutionState::RecoveryRequired &&
          fixture.runtime.coordinator().physical().game().fen() == kPostHumanFen,
      "Ambiguous rook occupancy did not freeze with immutable chess state.");
}

}  // namespace

int main() {
  try {
    verifyControlledFixture();
    verifyProgramCompilation();
    verifyAllCastlingDirections();
    verifyLaneCompilation();
    verifyMalformedRequestsRejected();
    verifyTransactionalExecutionAndRetries();
    verifyAmbiguousOccupancyRecovery();
    std::cout << "offline castling motion regressions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline castling motion regression failed: "
              << error.what() << '\n';
    return 1;
  }
}
