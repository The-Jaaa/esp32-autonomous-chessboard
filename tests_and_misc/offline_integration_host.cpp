#include "../offline_core/offline_coordinator.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::EngineSearchRequest;
using offline::GameOutcome;
using offline::GameStatus;
using offline::HumanColor;
using offline::MoveInfo;
using offline::Occupancy;
using offline::OfflineCoordinatorConfig;
using offline::OfflineEngine;
using offline::OfflineGame;
using offline::OfflineTurnCoordinator;
using offline::OfflineTurnEvent;
using offline::OfflineTurnPhase;
using offline::OfflineTurnResult;
using offline::OpponentMovePlan;
using offline::SearchResult;

struct Options {
  int games = 12;
  int maxPlies = 120;
  std::uint32_t seed = 0xC0D3C0DEu;
};

struct Metrics {
  std::uint64_t games = 0;
  std::uint64_t scenarios = 0;
  std::uint64_t plies = 0;
  std::uint64_t humanMoves = 0;
  std::uint64_t engineMoves = 0;
  std::uint64_t captures = 0;
  std::uint64_t castling = 0;
  std::uint64_t enPassant = 0;
  std::uint64_t promotions = 0;
  std::uint64_t checks = 0;
  std::uint64_t terminalGames = 0;
  std::uint64_t checkmates = 0;
  std::uint64_t stalemates = 0;
  std::uint64_t insufficientDraws = 0;
  std::uint64_t fiftyMoveDraws = 0;
  std::uint64_t repetitionDraws = 0;
  std::uint64_t staleSearches = 0;
  std::uint64_t syncWarnings = 0;
  std::uint64_t preMoveRecoveries = 0;
  std::uint64_t postMoveRecoveries = 0;
  std::uint64_t humanCancellations = 0;
  std::uint64_t humanDisturbanceRecoveries = 0;
  std::uint64_t duplicateReports = 0;
  std::uint64_t opponentPromotions = 0;
  std::uint64_t engineNodes = 0;
};

struct FaultSchedule {
  bool staleSearch = false;
  bool recoverThroughPreMove = false;
  bool recoverThroughPostMove = false;
  bool cancelHumanLift = false;
  bool disturbWrongPiece = false;
  bool duplicateHumanLift = false;
  bool duplicateCompletion = false;
};

class DeterministicRandom {
 public:
  explicit DeterministicRandom(std::uint32_t seed) : state_(seed == 0 ? 1u : seed) {}

  std::uint32_t next() {
    state_ ^= state_ << 13;
    state_ ^= state_ >> 17;
    state_ ^= state_ << 5;
    return state_;
  }

  std::size_t index(std::size_t size) {
    if (size == 0) throw std::runtime_error("Cannot select from an empty move list.");
    return static_cast<std::size_t>(next()) % size;
  }

 private:
  std::uint32_t state_;
};

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void place(Occupancy& occupancy, const std::string& square, bool occupied) {
  const int index = offline::squareToRawIndex(square);
  require(index >= 0, "Invalid integration square: " + square);
  occupancy[static_cast<std::size_t>(index)] = occupied;
}

bool sameMove(const MoveInfo& left, const MoveInfo& right) {
  return left.uci == right.uci && left.san == right.san && left.from == right.from &&
         left.to == right.to && left.piece == right.piece &&
         left.capturedPiece == right.capturedPiece &&
         left.capturedSquare == right.capturedSquare &&
         left.promotion == right.promotion && left.rookFrom == right.rookFrom &&
         left.rookTo == right.rookTo && left.capture == right.capture &&
         left.castling == right.castling && left.enPassant == right.enPassant;
}

bool sameStatus(const GameStatus& left, const GameStatus& right) {
  return left.outcome == right.outcome && left.inCheck == right.inCheck;
}

void recordMove(const MoveInfo& move, bool humanMove, Metrics& metrics) {
  ++metrics.plies;
  if (humanMove) {
    ++metrics.humanMoves;
  } else {
    ++metrics.engineMoves;
  }
  if (move.capture) ++metrics.captures;
  if (move.castling) ++metrics.castling;
  if (move.enPassant) ++metrics.enPassant;
  if (!move.promotion.empty()) ++metrics.promotions;
  if (move.san.find('+') != std::string::npos || move.san.find('#') != std::string::npos) {
    ++metrics.checks;
  }
}

void recordOutcome(GameOutcome outcome, Metrics& metrics) {
  if (outcome == GameOutcome::Ongoing) return;
  ++metrics.terminalGames;
  switch (outcome) {
    case GameOutcome::Checkmate: ++metrics.checkmates; break;
    case GameOutcome::Stalemate: ++metrics.stalemates; break;
    case GameOutcome::InsufficientMaterial: ++metrics.insufficientDraws; break;
    case GameOutcome::FiftyMoveDraw: ++metrics.fiftyMoveDraws; break;
    case GameOutcome::ThreefoldRepetition: ++metrics.repetitionDraws; break;
    case GameOutcome::Ongoing: break;
  }
}

void requireSynchronized(
    const OfflineTurnCoordinator& coordinator, const OfflineGame& oracle,
    const std::string& context) {
  require(coordinator.physical().game().fen() == oracle.fen(),
          context + ": coordinator FEN differs from oracle.");
  require(coordinator.physical().game().sideToMove() == oracle.sideToMove(),
          context + ": side to move differs from oracle.");
  require(sameStatus(coordinator.physical().game().status(), oracle.status()),
          context + ": game status differs from oracle.");
  require(coordinator.physical().committedOccupancy() == offline::occupancyFromFen(oracle.fen()),
          context + ": committed occupancy differs from oracle FEN.");
  require(coordinator.phase() != OfflineTurnPhase::Error,
          context + ": coordinator entered Error.");
  require(coordinator.phase() != OfflineTurnPhase::SyncWarning,
          context + ": coordinator retained an unresolved SyncWarning.");
}

MoveInfo applyOracleMove(OfflineGame& oracle, const MoveInfo& accepted, const std::string& context) {
  MoveInfo oracleMove;
  require(oracle.applyUci(accepted.uci, oracleMove),
          context + ": oracle rejected committed move " + accepted.uci + '.');
  require(sameMove(accepted, oracleMove),
          context + ": accepted move metadata differs from oracle for " + accepted.uci + '.');
  return oracleMove;
}

std::string opponentOccupiedSquare(const OfflineGame& game, HumanColor humanColor) {
  const bool humanWhite = humanColor == HumanColor::White;
  for (const std::string& square : game.occupiedSquares()) {
    const std::string piece = game.pieceAt(square);
    if (piece.empty()) continue;
    const bool pieceWhite = piece.front() >= 'A' && piece.front() <= 'Z';
    if (pieceWhite != humanWhite) return square;
  }
  return {};
}

MoveInfo describeMove(const OfflineGame& game, const std::string& uci) {
  MoveInfo move;
  require(game.describeLegalMove(uci, move), "Move is not legal in oracle: " + uci);
  return move;
}

OfflineTurnResult simulateHumanMove(
    OfflineTurnCoordinator& coordinator, OfflineGame& oracle, const std::string& uci,
    FaultSchedule& faults, Metrics& metrics, const std::string& context) {
  require(coordinator.phase() == OfflineTurnPhase::HumanTurn,
          context + ": human move did not begin in HumanTurn.");
  const MoveInfo move = describeMove(oracle, uci);
  const Occupancy committed = coordinator.physical().committedOccupancy();

  if (faults.disturbWrongPiece) {
    const std::string disturbedSquare = opponentOccupiedSquare(
        oracle, coordinator.physical().humanColor());
    require(!disturbedSquare.empty(), context + ": no opponent piece available for disturbance.");
    Occupancy disturbed = committed;
    place(disturbed, disturbedSquare, false);
    OfflineTurnResult warning = coordinator.processHumanSnapshot(disturbed);
    require(warning.phase == OfflineTurnPhase::SyncWarning &&
                warning.event == OfflineTurnEvent::RestoreRequired,
            context + ": wrong-piece disturbance did not enter SyncWarning.");
    ++metrics.syncWarnings;
    OfflineTurnResult restored = coordinator.processRecoverySnapshot(committed);
    require(restored.phase == OfflineTurnPhase::HumanTurn,
            context + ": wrong-piece restoration did not reopen HumanTurn.");
    ++metrics.humanDisturbanceRecoveries;
    faults.disturbWrongPiece = false;
  }

  if (faults.cancelHumanLift) {
    Occupancy cancelled = committed;
    place(cancelled, move.from, false);
    coordinator.processHumanSnapshot(cancelled);
    OfflineTurnResult returned = coordinator.processHumanSnapshot(committed);
    require(returned.phase == OfflineTurnPhase::HumanTurn &&
                coordinator.physical().game().fen() == oracle.fen(),
            context + ": cancelled lift changed authoritative state.");
    ++metrics.humanCancellations;
    faults.cancelHumanLift = false;
  }

  Occupancy board = committed;
  place(board, move.from, false);
  OfflineTurnResult result = coordinator.processHumanSnapshot(board);
  require(result.phase == OfflineTurnPhase::HumanTurn,
          context + ": piece lift unexpectedly left HumanTurn.");

  if (faults.duplicateHumanLift) {
    const std::string beforeDuplicate = coordinator.physical().game().fen();
    OfflineTurnResult duplicate = coordinator.processHumanSnapshot(board);
    require(duplicate.phase == OfflineTurnPhase::HumanTurn &&
                coordinator.physical().game().fen() == beforeDuplicate,
            context + ": duplicate lift snapshot changed state.");
    ++metrics.duplicateReports;
    faults.duplicateHumanLift = false;
  }

  if (move.capture) {
    place(board, move.capturedSquare, false);
    result = coordinator.processHumanSnapshot(board);
    require(result.phase == OfflineTurnPhase::HumanTurn,
            context + ": captured-piece removal unexpectedly left HumanTurn.");
  }

  place(board, move.to, true);
  result = coordinator.processHumanSnapshot(board);

  if (move.castling) {
    require(result.phase == OfflineTurnPhase::HumanTurn,
            context + ": king placement did not wait for castling rook.");
    place(board, move.rookFrom, false);
    result = coordinator.processHumanSnapshot(board);
    require(result.phase == OfflineTurnPhase::HumanTurn,
            context + ": rook lift did not remain in castling workflow.");
    place(board, move.rookTo, true);
    result = coordinator.processHumanSnapshot(board);
  }

  if (!move.promotion.empty()) {
    require(result.phase == OfflineTurnPhase::HumanPromotionPending,
            context + ": promotion placement did not request identity confirmation.");
    result = coordinator.confirmHumanPromotion(move.promotion.front());
  }

  require(result.acceptedMove.has_value(), context + ": accepted human move metadata is missing.");
  require(result.event == OfflineTurnEvent::HumanMoveAccepted ||
              result.event == OfflineTurnEvent::GameEnded,
          context + ": human move ended with unexpected event.");
  applyOracleMove(oracle, *result.acceptedMove, context);
  recordMove(*result.acceptedMove, true, metrics);
  requireSynchronized(coordinator, oracle, context + " after human commit");
  return result;
}

OfflineTurnResult simulateOpponentMove(
    OfflineTurnCoordinator& coordinator, OfflineGame& oracle, OfflineEngine& engine,
    FaultSchedule& faults, Metrics& metrics, const std::string& context) {
  require(coordinator.phase() == OfflineTurnPhase::EngineSearchNeeded,
          context + ": opponent move did not begin with an engine request.");
  const std::optional<EngineSearchRequest> request = coordinator.pendingEngineRequest();
  require(request.has_value(), context + ": engine request metadata is missing.");
  require(request->fen == oracle.fen(), context + ": engine request FEN differs from oracle.");

  const SearchResult search = engine.searchFen(request->fen, request->limits);
  require(search.hasMove(), context + ": engine did not return a move for an ongoing game.");
  metrics.engineNodes += search.nodes;

  if (faults.staleSearch) {
    OfflineTurnResult stale = coordinator.submitEngineResult(request->generation + 1, search);
    require(stale.event == OfflineTurnEvent::EngineResultRejected &&
                coordinator.pendingEngineRequest()->generation == request->generation &&
                coordinator.physical().game().fen() == oracle.fen(),
            context + ": stale engine result changed the active request or game.");
    ++metrics.staleSearches;
    faults.staleSearch = false;
  }

  const std::string beforeStage = coordinator.physical().game().fen();
  OfflineTurnResult staged = coordinator.submitEngineResult(request->generation, search);
  if (staged.phase == OfflineTurnPhase::OpponentMotionBlocked) {
    require(staged.motionTransaction && staged.opponentPlan == std::nullopt &&
                !staged.motionTransaction->rejectedCandidates.empty() &&
                coordinator.physical().game().fen() == oracle.fen(),
            context + ": motion-blocked engine result changed authoritative state.");
    return staged;
  }
  require(staged.phase == OfflineTurnPhase::OpponentMoveReady && staged.opponentPlan,
          context + ": legal engine result did not stage an opponent move; phase=" +
              offline::offlineTurnPhaseName(staged.phase) + " fen=" + request->fen +
              " best=" + search.bestMove + " rejected=" +
              (staged.motionTransaction
                   ? std::to_string(staged.motionTransaction->rejectedCandidates.size())
                   : "none") +
              " first_reason=" +
              (staged.motionTransaction &&
                       !staged.motionTransaction->rejectedCandidates.empty()
                   ? staged.motionTransaction->rejectedCandidates.front().reason
                   : "none"));
  const OpponentMovePlan plan = *staged.opponentPlan;
  require(plan.beforeFen == oracle.fen() && beforeStage == oracle.fen(),
          context + ": staged plan has the wrong pre-move FEN.");
  require(coordinator.physical().game().fen() == beforeStage,
          context + ": staging mutated the authoritative game.");

  OfflineGame preview = oracle;
  MoveInfo previewMove;
  require(preview.applyUci(plan.move.uci, previewMove),
          context + ": oracle rejected staged opponent move.");
  require(sameMove(plan.move, previewMove) && plan.afterFen == preview.fen() &&
              plan.expectedOccupancy == offline::occupancyFromFen(preview.fen()) &&
              sameStatus(plan.expectedStatus, preview.status()),
          context + ": staged plan differs from independent preview.");

  OfflineTurnResult result = coordinator.beginOpponentExecution();
  require(result.phase == OfflineTurnPhase::OpponentMoveExecuting,
          context + ": staged opponent move did not begin execution.");

  const bool canInjectPartial = !plan.move.capture && !plan.move.castling &&
                                plan.move.promotion.empty();
  if (canInjectPartial && (faults.recoverThroughPreMove || faults.recoverThroughPostMove)) {
    Occupancy partial = plan.beforeOccupancy;
    place(partial, plan.move.from, false);
    result = coordinator.completeOpponentExecution(partial);
    require(result.phase == OfflineTurnPhase::SyncWarning &&
                result.event == OfflineTurnEvent::RestoreRequired &&
                coordinator.physical().game().fen() == beforeStage,
            context + ": partial opponent occupancy did not enter transactional SyncWarning.");
    ++metrics.syncWarnings;

    if (faults.recoverThroughPreMove) {
      result = coordinator.processRecoverySnapshot(plan.beforeOccupancy);
      require(result.phase == OfflineTurnPhase::OpponentMoveReady && result.opponentPlan &&
                  result.opponentPlan->move.uci == plan.move.uci,
              context + ": pre-move recovery did not preserve the staged move.");
      ++metrics.preMoveRecoveries;
      faults.recoverThroughPreMove = false;
      result = coordinator.beginOpponentExecution();
      require(result.phase == OfflineTurnPhase::OpponentMoveExecuting,
              context + ": recovered staged move did not restart.");
      result = coordinator.completeOpponentExecution(plan.expectedOccupancy);
    } else {
      result = coordinator.processRecoverySnapshot(plan.expectedOccupancy);
      ++metrics.postMoveRecoveries;
      faults.recoverThroughPostMove = false;
    }
  } else {
    result = coordinator.completeOpponentExecution(plan.expectedOccupancy);
  }

  if (!plan.move.promotion.empty()) {
    require(result.phase == OfflineTurnPhase::OpponentPromotionPending,
            context + ": opponent promotion did not wait for identity confirmation.");
    Occupancy replacing = plan.expectedOccupancy;
    place(replacing, plan.move.to, false);
    result = coordinator.processOpponentPromotionSnapshot(replacing);
    require(result.phase == OfflineTurnPhase::OpponentPromotionPending &&
                result.event == OfflineTurnEvent::OpponentPromotionReplacementInProgress,
            context + ": lifted promotion pawn was not treated as replacement in progress.");
    result = coordinator.processOpponentPromotionSnapshot(plan.expectedOccupancy);
    require(result.phase == OfflineTurnPhase::OpponentPromotionPending &&
                result.event == OfflineTurnEvent::OpponentPromotionConfirmationReady,
            context + ": replaced promotion piece was not ready for confirmation.");
    result = coordinator.confirmOpponentPromotion(
        plan.move.promotion.front(), plan.expectedOccupancy);
    ++metrics.opponentPromotions;
  }

  require(result.acceptedMove.has_value(), context + ": accepted opponent move metadata is missing.");
  require(result.event == OfflineTurnEvent::OpponentMoveVerified ||
              result.event == OfflineTurnEvent::GameEnded,
          context + ": opponent move ended with unexpected event.");
  applyOracleMove(oracle, *result.acceptedMove, context);
  recordMove(*result.acceptedMove, false, metrics);
  requireSynchronized(coordinator, oracle, context + " after opponent commit");

  if (faults.duplicateCompletion) {
    OfflineTurnResult duplicate = coordinator.completeOpponentExecution(plan.expectedOccupancy);
    require(duplicate.event == OfflineTurnEvent::None &&
                coordinator.physical().game().fen() == oracle.fen(),
            context + ": duplicate opponent completion changed state.");
    ++metrics.duplicateReports;
    faults.duplicateCompletion = false;
  }
  return result;
}

FaultSchedule scheduleForGame(int gameIndex) {
  FaultSchedule schedule;
  schedule.staleSearch = gameIndex == 0;
  schedule.recoverThroughPreMove = gameIndex == 1;
  schedule.recoverThroughPostMove = gameIndex == 2;
  schedule.cancelHumanLift = gameIndex == 3;
  schedule.disturbWrongPiece = gameIndex == 4;
  schedule.duplicateHumanLift = gameIndex == 5;
  schedule.duplicateCompletion = gameIndex == 6;
  return schedule;
}

void runGame(
    int gameIndex, const Options& options, OfflineEngine& engine, Metrics& metrics) {
  OfflineCoordinatorConfig config;
  config.humanColor = gameIndex % 2 == 0 ? HumanColor::White : HumanColor::Black;
  config.searchLimits.timeLimitMs = 0;
  config.searchLimits.maxNodes = 2000;
  config.searchLimits.maxDepth = 12;

  OfflineTurnCoordinator coordinator(config);
  OfflineGame oracle;
  DeterministicRandom random(options.seed ^
                             (0x9E3779B9u * static_cast<std::uint32_t>(gameIndex + 1)));
  FaultSchedule faults = scheduleForGame(gameIndex);
  ++metrics.games;

  int gamePlies = 0;
  while (gamePlies < options.maxPlies) {
    if (coordinator.phase() == OfflineTurnPhase::GameOver) {
      recordOutcome(coordinator.physical().game().status().outcome, metrics);
      break;
    }

    const std::string context = "game " + std::to_string(gameIndex) +
                                " ply " + std::to_string(gamePlies + 1);
    if (coordinator.phase() == OfflineTurnPhase::HumanTurn) {
      const std::vector<std::string> legal = oracle.legalMovesUci();
      require(!legal.empty(), context + ": HumanTurn has no legal oracle moves.");
      const std::string uci = legal[random.index(legal.size())];
      simulateHumanMove(coordinator, oracle, uci, faults, metrics, context);
    } else if (coordinator.phase() == OfflineTurnPhase::EngineSearchNeeded) {
      const OfflineTurnResult opponent = simulateOpponentMove(
          coordinator, oracle, engine, faults, metrics, context);
      if (opponent.phase == OfflineTurnPhase::OpponentMotionBlocked) break;
    } else {
      throw std::runtime_error(
          context + ": simulator encountered unfinished phase " +
          offline::offlineTurnPhaseName(coordinator.phase()) + '.');
    }
    ++gamePlies;
  }

  requireSynchronized(coordinator, oracle, "game " + std::to_string(gameIndex) + " final");
  require(coordinator.phase() == OfflineTurnPhase::HumanTurn ||
              coordinator.phase() == OfflineTurnPhase::EngineSearchNeeded ||
              coordinator.phase() == OfflineTurnPhase::OpponentMotionBlocked ||
              coordinator.phase() == OfflineTurnPhase::GameOver,
          "Game ended its ply budget in an unstable transaction phase.");
}

void runForcedHumanScenario(
    const std::string& label, const std::string& fen, const std::string& uci,
    Metrics& metrics) {
  OfflineTurnCoordinator coordinator;
  OfflineGame oracle;
  require(coordinator.loadFen(fen) && oracle.loadFen(fen),
          label + ": scenario FEN must load in coordinator and oracle.");
  require(coordinator.phase() == OfflineTurnPhase::HumanTurn,
          label + ": forced human scenario must begin in HumanTurn.");
  FaultSchedule noFaults;
  OfflineTurnResult result = simulateHumanMove(
      coordinator, oracle, uci, noFaults, metrics, "scenario " + label);
  ++metrics.scenarios;
  if (result.phase == OfflineTurnPhase::GameOver) {
    recordOutcome(coordinator.physical().game().status().outcome, metrics);
  }
}

void runForcedOpponentPromotionScenario(
    const std::string& label, const std::string& fen, const std::string& uci,
    Metrics& metrics) {
  OfflineGame oracle;
  require(oracle.loadFen(fen), label + ": scenario oracle FEN must load.");

  OfflineCoordinatorConfig config;
  config.humanColor = oracle.sideToMove() == 'w' ? HumanColor::Black : HumanColor::White;
  OfflineTurnCoordinator coordinator(config);
  require(coordinator.loadFen(fen) &&
              coordinator.phase() == OfflineTurnPhase::EngineSearchNeeded,
          label + ": opponent promotion scenario must request engine search.");

  const std::optional<EngineSearchRequest> request = coordinator.pendingEngineRequest();
  require(request.has_value(), label + ": opponent promotion request is missing.");
  SearchResult search;
  search.bestMove = uci;
  search.score = 300;
  search.completedDepth = 2;
  search.stopReason = offline::SearchStopReason::DepthLimit;
  search.outcome = GameOutcome::Ongoing;
  search.rankedRootMoves.push_back({uci, search.score, 0});

  const std::string before = coordinator.physical().game().fen();
  OfflineTurnResult result = coordinator.submitEngineResult(request->generation, search);
  require(result.phase == OfflineTurnPhase::OpponentMoveReady && result.opponentPlan &&
              result.opponentPlan->move.uci == uci,
          label + ": opponent promotion did not stage.");
  const OpponentMovePlan plan = *result.opponentPlan;
  require(coordinator.physical().game().fen() == before,
          label + ": staging changed authoritative state.");

  result = coordinator.beginOpponentExecution();
  require(result.phase == OfflineTurnPhase::OpponentMoveExecuting,
          label + ": opponent promotion execution did not start.");
  result = coordinator.completeOpponentExecution(plan.expectedOccupancy);
  require(result.phase == OfflineTurnPhase::OpponentPromotionPending &&
              result.event == OfflineTurnEvent::OpponentPromotionRequired &&
              coordinator.physical().game().fen() == before,
          label + ": completed pawn motion did not wait for replacement.");

  Occupancy replacing = plan.expectedOccupancy;
  place(replacing, plan.move.to, false);
  result = coordinator.processOpponentPromotionSnapshot(replacing);
  require(result.event == OfflineTurnEvent::OpponentPromotionReplacementInProgress,
          label + ": target-empty snapshot did not represent replacement in progress.");
  result = coordinator.processOpponentPromotionSnapshot(plan.expectedOccupancy);
  require(result.event == OfflineTurnEvent::OpponentPromotionConfirmationReady,
          label + ": replacement occupancy did not become confirmation-ready.");
  result = coordinator.confirmOpponentPromotion(
      plan.move.promotion.front(), plan.expectedOccupancy);
  require(result.acceptedMove && result.acceptedMove->uci == uci,
          label + ": matching replacement confirmation did not commit.");

  applyOracleMove(oracle, *result.acceptedMove, "scenario " + label);
  recordMove(*result.acceptedMove, false, metrics);
  ++metrics.opponentPromotions;
  ++metrics.scenarios;
  requireSynchronized(coordinator, oracle, "scenario " + label);
  if (result.phase == OfflineTurnPhase::GameOver) {
    recordOutcome(coordinator.physical().game().status().outcome, metrics);
  }
}

void requireTerminalScenario(
    const std::string& label, const std::string& fen, GameOutcome outcome,
    Metrics& metrics) {
  OfflineTurnCoordinator coordinator;
  require(coordinator.loadFen(fen), label + ": terminal FEN must load.");
  require(coordinator.phase() == OfflineTurnPhase::GameOver &&
              coordinator.physical().game().status().outcome == outcome &&
              !coordinator.pendingEngineRequest(),
          label + ": terminal position did not load directly into GameOver.");
  ++metrics.scenarios;
  recordOutcome(outcome, metrics);
}

void runForcedScenarios(Metrics& metrics) {
  runForcedHumanScenario(
      "ordinary capture", "4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1", "e4d5", metrics);
  runForcedHumanScenario(
      "en passant", "8/8/8/3pP3/8/8/8/4K2k w - d6 0 1", "e5d6", metrics);
  runForcedHumanScenario(
      "kingside castling", "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1", metrics);
  runForcedHumanScenario(
      "queenside castling", "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1c1", metrics);
  for (const char promotion : std::string("qrbn")) {
    runForcedHumanScenario(
        std::string("promotion ") + promotion,
        "4k3/P7/8/8/8/8/7p/4K3 w - - 0 1",
        std::string("a7a8") + promotion, metrics);
    runForcedOpponentPromotionScenario(
        std::string("opponent promotion ") + promotion,
        "4k3/P7/8/8/8/8/7p/4K3 w - - 0 1",
        std::string("a7a8") + promotion, metrics);
  }
  runForcedHumanScenario(
      "checkmate", "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1", "f7g7", metrics);

  requireTerminalScenario(
      "stalemate", "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
      GameOutcome::Stalemate, metrics);
  requireTerminalScenario(
      "insufficient material", "8/8/8/8/8/8/5k2/7K w - - 0 1",
      GameOutcome::InsufficientMaterial, metrics);
  requireTerminalScenario(
      "fifty-move draw", "8/8/8/8/8/8/5k2/R6K w - - 100 51",
      GameOutcome::FiftyMoveDraw, metrics);
}

Options parseOptions(int argc, char** argv) {
  Options options;
  for (int index = 1; index < argc; ++index) {
    const std::string argument = argv[index];
    auto requireValue = [&](const std::string& name) -> std::string {
      if (index + 1 >= argc) throw std::runtime_error("Missing value for " + name + '.');
      return argv[++index];
    };
    if (argument == "--games") {
      options.games = std::stoi(requireValue(argument));
    } else if (argument == "--max-plies") {
      options.maxPlies = std::stoi(requireValue(argument));
    } else if (argument == "--seed") {
      options.seed = static_cast<std::uint32_t>(
          std::stoul(requireValue(argument), nullptr, 0));
    } else {
      throw std::runtime_error("Unknown argument: " + argument);
    }
  }
  require(options.games >= 12, "Integration simulator requires at least 12 games.");
  require(options.maxPlies > 0, "Maximum plies must be positive.");
  return options;
}

void requireCoverage(const Metrics& metrics) {
  require(metrics.humanMoves > 0 && metrics.engineMoves > 0,
          "Integration run did not exercise both move owners.");
  require(metrics.captures > 0 && metrics.castling >= 2 && metrics.enPassant > 0 &&
              metrics.promotions >= 8 && metrics.opponentPromotions >= 4,
          "Forced integration scenarios did not cover every special move category.");
  require(metrics.checkmates > 0 && metrics.stalemates > 0 &&
              metrics.insufficientDraws > 0 && metrics.fiftyMoveDraws > 0,
          "Integration scenarios did not cover required terminal outcomes.");
  require(metrics.staleSearches > 0 && metrics.preMoveRecoveries > 0 &&
              metrics.postMoveRecoveries > 0 && metrics.humanCancellations > 0 &&
              metrics.humanDisturbanceRecoveries > 0 && metrics.duplicateReports >= 2,
          "Deterministic fault schedule did not exercise every recovery branch.");
}

void printMetrics(const Options& options, const Metrics& metrics, std::int64_t elapsedMs) {
  std::cout << "integration metrics {"
            << "\"seed\":" << options.seed
            << ",\"games\":" << metrics.games
            << ",\"maxPlies\":" << options.maxPlies
            << ",\"scenarios\":" << metrics.scenarios
            << ",\"plies\":" << metrics.plies
            << ",\"humanMoves\":" << metrics.humanMoves
            << ",\"engineMoves\":" << metrics.engineMoves
            << ",\"captures\":" << metrics.captures
            << ",\"castling\":" << metrics.castling
            << ",\"enPassant\":" << metrics.enPassant
            << ",\"promotions\":" << metrics.promotions
            << ",\"checks\":" << metrics.checks
            << ",\"terminalGames\":" << metrics.terminalGames
            << ",\"checkmates\":" << metrics.checkmates
            << ",\"stalemates\":" << metrics.stalemates
            << ",\"insufficientDraws\":" << metrics.insufficientDraws
            << ",\"fiftyMoveDraws\":" << metrics.fiftyMoveDraws
            << ",\"repetitionDraws\":" << metrics.repetitionDraws
            << ",\"staleSearches\":" << metrics.staleSearches
            << ",\"syncWarnings\":" << metrics.syncWarnings
            << ",\"preMoveRecoveries\":" << metrics.preMoveRecoveries
            << ",\"postMoveRecoveries\":" << metrics.postMoveRecoveries
            << ",\"humanCancellations\":" << metrics.humanCancellations
            << ",\"humanDisturbanceRecoveries\":" << metrics.humanDisturbanceRecoveries
            << ",\"duplicateReports\":" << metrics.duplicateReports
            << ",\"opponentPromotions\":" << metrics.opponentPromotions
            << ",\"engineNodes\":" << metrics.engineNodes
            << ",\"elapsedMs\":" << elapsedMs << "}" << std::endl;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const Options options = parseOptions(argc, argv);
    const auto started = std::chrono::steady_clock::now();
    Metrics metrics;
    OfflineEngine engine;

    runForcedScenarios(metrics);
    for (int game = 0; game < options.games; ++game) {
      runGame(game, options, engine, metrics);
    }
    requireCoverage(metrics);

    const auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count();
    printMetrics(options, metrics, elapsedMs);
    std::cout << "offline integration simulation passed" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline integration simulation failed: " << error.what() << std::endl;
    return 1;
  }
}
