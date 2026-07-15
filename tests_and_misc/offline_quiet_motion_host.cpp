#include "../offline_core/offline_quiet_motion.h"

#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::ExternalRouteMode;
using offline::ExternalTargetType;
using offline::GraveyardSlotState;
using offline::HumanColor;
using offline::MotionPlanningContext;
using offline::MotionPhaseKind;
using offline::Occupancy;
using offline::OfflineGame;
using offline::OfflineMotionPlanner;
using offline::OfflinePhaseExecutionAdapter;
using offline::OfflinePhaseExecutionReport;
using offline::OfflinePhaseExecutionRequest;
using offline::OfflinePhaseExecutionState;
using offline::OfflineQuietMotionCompiler;
using offline::OfflineReadOnlyRuntime;
using offline::OfflineRuntimeConfig;
using offline::OfflineRuntimePhase;
using offline::OwnershipDecision;
using offline::OwnershipState;
using offline::QuietMotionCompileStatus;
using offline::QuietMotionPrimitiveKind;
using offline::RootMoveScore;
using offline::SearchResult;
using offline::SearchStopReason;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

OfflinePhaseExecutionRequest requestFor(
    const std::string& fen,
    const std::string& uci,
    const std::optional<Occupancy>& sensed = std::nullopt) {
  OfflineGame game;
  require(game.loadFen(fen), uci + ": test FEN did not load.");
  offline::MoveInfo move;
  require(game.describeLegalMove(uci, move), uci + ": test move is not legal.");
  MotionPlanningContext context;
  context.sensedOccupancy = sensed;
  context.slots = offline::defaultExternalSlots();
  const auto plan = OfflineMotionPlanner{}.planMove(game, uci, context);
  require(plan.success(), uci + ": motion plan failed: " + plan.blockedReason);
  require(plan.phases.size() == 1, uci + ": expected one quiet phase.");

  OfflinePhaseExecutionRequest request;
  request.token = {17, 0, 1};
  request.move = plan.move;
  request.phase = plan.phases.front();
  return request;
}

void requirePrimitiveKinds(
    const offline::QuietMotionProgram& program,
    const std::vector<QuietMotionPrimitiveKind>& kinds,
    const std::string& context) {
  require(program.primitives.size() == kinds.size(),
          context + ": primitive count differs.");
  for (std::size_t index = 0; index < kinds.size(); ++index) {
    require(program.primitives[index].kind == kinds[index],
            context + ": primitive kind differs at index " +
                std::to_string(index) + '.');
  }
}

void verifyDirectPawnAndMapping() {
  const auto request = requestFor(
      "rnbqkbnr/pppppppp/8/8/5P2/8/PPPPP1PP/RNBQKBNR b KQkq - 0 1",
      "e7e5");
  const auto program = OfflineQuietMotionCompiler{}.compile(request);
  require(program.success(), "A direct two-square pawn move did not compile.");
  require(program.routeMode == ExternalRouteMode::Direct &&
              program.compressedPathSquares == std::vector<std::string>({"e7", "e5"}),
          "Direct pawn routing metadata changed.");
  requirePrimitiveKinds(
      program,
      {QuietMotionPrimitiveKind::Travel,
       QuietMotionPrimitiveKind::Pickup,
       QuietMotionPrimitiveKind::Drag,
       QuietMotionPrimitiveKind::Drop,
       QuietMotionPrimitiveKind::Verify},
      "direct pawn");
  require(program.primitives[2].finalBoardDrop,
          "The final direct drag must receive board-drop overshoot.");
  require(program.sourceRawIndex == offline::squareToRawIndex("e7") &&
              program.targetRawIndex == offline::squareToRawIndex("e5") &&
              offline::squareToRawIndex("h8") == 0 &&
              offline::squareToRawIndex("a1") == 56 &&
              offline::squareToRawIndex("a8") == 63,
          "Physical square mapping changed.");
}

void verifyCompressedBoardLine() {
  const auto request = requestFor(
      "7k/8/8/8/8/8/8/R3K3 w - - 0 1", "a1a8");
  const auto program = OfflineQuietMotionCompiler{}.compile(request);
  require(program.success() && program.routeMode == ExternalRouteMode::BoardLine,
          "A clear rook board line did not compile.");
  require(program.rawPathSquares.size() == 8 &&
              program.compressedPathSquares ==
                  std::vector<std::string>({"a1", "a8"}),
          "The long clear line was not compressed to one drag.");
  require(program.primitives.size() == 5 && program.primitives[2].finalBoardDrop,
          "The compressed line should contain one final drag primitive.");
}

void verifyMultiSegmentBoardRoute() {
  const auto request = requestFor(
      "k1B3n1/8/6P1/1RB5/P2PpP2/4P3/P1P4P/4K2R b K - 8 36",
      "g8f6");
  const auto first = OfflineQuietMotionCompiler{}.compile(request);
  const auto second = OfflineQuietMotionCompiler{}.compile(request);
  require(first.success() && first.routeMode == ExternalRouteMode::BoardBuffered,
          "A buffered knight transfer did not compile.");
  require(first.compressedPathSquares ==
              std::vector<std::string>({"g8", "f7", "f6"}),
          "Buffered route waypoints changed.");
  requirePrimitiveKinds(
      first,
      {QuietMotionPrimitiveKind::Travel,
       QuietMotionPrimitiveKind::Pickup,
       QuietMotionPrimitiveKind::Drag,
       QuietMotionPrimitiveKind::Drag,
       QuietMotionPrimitiveKind::Drop,
       QuietMotionPrimitiveKind::Verify},
      "buffered route");
  require(!first.primitives[2].finalBoardDrop &&
              first.primitives[3].finalBoardDrop,
          "Only the final routed drag may overshoot.");
  require(first.primitives[2].sourceRawIndex == offline::squareToRawIndex("g8") &&
              first.primitives[2].targetRawIndex == offline::squareToRawIndex("f7") &&
              first.primitives[3].sourceRawIndex == offline::squareToRawIndex("f7") &&
              first.primitives[3].targetRawIndex == offline::squareToRawIndex("f6"),
          "Compressed drag primitives do not form contiguous segments.");
  require(first.primitives == second.primitives &&
              first.expectedBefore == request.phase.expectedBefore &&
              first.expectedAfter == request.phase.expectedAfter,
          "Repeated compilation was not deterministic or mutated occupancy.");
}

void verifyRejections() {
  const auto valid = requestFor(
      "rnbqkbnr/pppppppp/8/8/5P2/8/PPPPP1PP/RNBQKBNR b KQkq - 0 1",
      "e7e6");
  const OfflineQuietMotionCompiler compiler;

  auto request = valid;
  request.move.capture = true;
  require(compiler.compile(request).status == QuietMotionCompileStatus::UnsupportedMove,
          "Capture metadata was accepted.");
  request = valid;
  request.move.castling = true;
  require(compiler.compile(request).status == QuietMotionCompileStatus::UnsupportedMove,
          "Castling metadata was accepted.");
  request = valid;
  request.move.enPassant = true;
  require(compiler.compile(request).status == QuietMotionCompileStatus::UnsupportedMove,
          "En-passant metadata was accepted.");
  request = valid;
  request.move.promotion = "q";
  require(compiler.compile(request).status == QuietMotionCompileStatus::UnsupportedMove,
          "Promotion metadata was accepted.");

  request = valid;
  request.phase.kind = MotionPhaseKind::CastleKing;
  require(compiler.compile(request).status == QuietMotionCompileStatus::InvalidPhase,
          "A non-quiet phase was accepted.");
  request = valid;
  request.graveyardSlotKey = "Z4";
  request.graveyardState = GraveyardSlotState::Pending;
  require(compiler.compile(request).status == QuietMotionCompileStatus::InvalidPhase,
          "A graveyard transaction was accepted.");

  request = valid;
  request.phase.transfer->mode = ExternalRouteMode::Lane;
  request.phase.transfer->targets.front().type = ExternalTargetType::Coordinate;
  require(compiler.compile(request).status == QuietMotionCompileStatus::UnsupportedRoute,
          "A lane route was accepted.");

  request = valid;
  request.phase.expectedAfter = request.phase.expectedBefore;
  require(compiler.compile(request).status == QuietMotionCompileStatus::InvalidOccupancy,
          "An unchanged occupancy transition was accepted.");
  request = valid;
  request.phase.expectedBefore[static_cast<std::size_t>(
      offline::squareToRawIndex(request.phase.to))] = true;
  require(compiler.compile(request).status == QuietMotionCompileStatus::InvalidOccupancy,
          "An occupied quiet destination was accepted.");

  request = valid;
  request.phase.transfer.reset();
  require(compiler.compile(request).status == QuietMotionCompileStatus::InvalidPhase,
          "A missing transfer was accepted.");
  request = valid;
  request.phase.transfer->targets.front().rawIndex = 64;
  require(compiler.compile(request).status == QuietMotionCompileStatus::InvalidPath,
          "A malformed board target was accepted.");
  request = valid;
  request.phase.transfer->compressedPathSquares.back() = "a1";
  require(compiler.compile(request).status == QuietMotionCompileStatus::InvalidPath,
          "A route ending on the wrong square was accepted.");

  request = valid;
  request.phase.transfer->mode = ExternalRouteMode::BoardBuffered;
  request.phase.transfer->rawPathSquares = {"e7", "d7", "e6"};
  request.phase.transfer->compressedPathSquares = request.phase.transfer->rawPathSquares;
  request.phase.transfer->targets.clear();
  for (const std::string& square : std::vector<std::string>{"d7", "e6"}) {
    offline::ExternalRouteTarget routeTarget;
    routeTarget.type = ExternalTargetType::Square;
    routeTarget.square = square;
    routeTarget.rawIndex = offline::squareToRawIndex(square);
    request.phase.transfer->targets.push_back(routeTarget);
  }
  require(compiler.compile(request).status == QuietMotionCompileStatus::InvalidPath,
          "A board route through an occupied square was accepted.");
}

OfflineRuntimeConfig runtimeConfig() {
  OfflineRuntimeConfig config;
  config.coordinator.humanColor = HumanColor::Black;
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

SearchResult syntheticSearch() {
  SearchResult result;
  result.bestMove = "e2e4";
  result.score = 20;
  result.completedDepth = 2;
  result.stopReason = SearchStopReason::DepthLimit;
  result.rankedRootMoves.push_back(RootMoveScore{"e2e4", 20, 0});
  return result;
}

void verifyAdapterAttemptLimit() {
  OfflineReadOnlyRuntime runtime(runtimeConfig());
  const Occupancy setup = runtime.expectedSetupOccupancy();
  runtime.applyOwnershipDecision(0, offlineOwnership(), setup);
  auto update = runtime.applyOwnershipDecision(500, offlineOwnership(), setup);
  require(update.phase == OfflineRuntimePhase::EngineSearchNeeded,
          "Retry fixture did not arm.");
  const auto engineRequest = runtime.pendingEngineRequest();
  require(engineRequest.has_value(), "Retry fixture has no engine request.");
  update = runtime.submitEngineResult(
      engineRequest->generation, syntheticSearch(), setup);
  require(update.phase == OfflineRuntimePhase::PlanReady,
          "Retry fixture did not stage a plan.");

  OfflinePhaseExecutionAdapter adapter(runtime);
  auto execution = adapter.begin();
  require(execution.request.has_value(), "Attempt one was not issued.");
  auto request = *execution.request;
  require(offline::quietMotionAttemptAllowed(request.token),
          "Attempt one should be executable.");
  adapter.takeCurrentRequest();
  execution = adapter.submitReport(
      OfflinePhaseExecutionReport{request.token, false, request.phase.expectedBefore});
  require(execution.state == OfflinePhaseExecutionState::RetryReady &&
              execution.request && execution.request->token.attempt == 2 &&
              offline::quietMotionAttemptAllowed(execution.request->token),
          "The single automatic retry was not issued.");

  request = *execution.request;
  adapter.takeCurrentRequest();
  execution = adapter.submitReport(
      OfflinePhaseExecutionReport{request.token, false, request.phase.expectedBefore});
  require(execution.state == OfflinePhaseExecutionState::RetryReady &&
              execution.request && execution.request->token.attempt == 3 &&
              !offline::quietMotionAttemptAllowed(execution.request->token) &&
              runtime.coordinator().physical().game().fen() ==
                  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
          "A third hardware attempt was not blocked without committing state.");
}

}  // namespace

int main() {
  try {
    verifyDirectPawnAndMapping();
    verifyCompressedBoardLine();
    verifyMultiSegmentBoardRoute();
    verifyRejections();
    verifyAdapterAttemptLimit();
    std::cout << "offline quiet motion compiler regressions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline quiet motion compiler regression failed: "
              << error.what() << '\n';
    return 1;
  }
}
