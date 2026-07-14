#include "offline_coordinator.h"

#include <cctype>
#include <utility>

namespace offline {
namespace {

bool isTerminal(const GameStatus& status) {
  return status.outcome != GameOutcome::Ongoing;
}

bool isUsableSearchResult(const SearchResult& result) {
  if (!result.hasMove()) return false;
  switch (result.stopReason) {
    case SearchStopReason::Complete:
    case SearchStopReason::TimeLimit:
    case SearchStopReason::DepthLimit:
    case SearchStopReason::NodeLimit:
      return true;
    case SearchStopReason::TerminalPosition:
    case SearchStopReason::InvalidFen:
      return false;
    default:
      return false;
  }
}

bool isPromotionChoice(char piece) {
  return piece == 'q' || piece == 'r' || piece == 'b' || piece == 'n';
}

}  // namespace

const char* offlineTurnPhaseName(OfflineTurnPhase phase) {
  switch (phase) {
    case OfflineTurnPhase::HumanTurn: return "human_turn";
    case OfflineTurnPhase::HumanPromotionPending: return "human_promotion_pending";
    case OfflineTurnPhase::EngineSearchNeeded: return "engine_search_needed";
    case OfflineTurnPhase::OpponentMoveReady: return "opponent_move_ready";
    case OfflineTurnPhase::OpponentMoveExecuting: return "opponent_move_executing";
    case OfflineTurnPhase::OpponentPromotionPending: return "opponent_promotion_pending";
    case OfflineTurnPhase::GameOver: return "game_over";
    case OfflineTurnPhase::SyncWarning: return "sync_warning";
    case OfflineTurnPhase::Error: return "error";
    default: return "unknown";
  }
}

const char* offlineTurnEventName(OfflineTurnEvent event) {
  switch (event) {
    case OfflineTurnEvent::None: return "none";
    case OfflineTurnEvent::HumanSnapshotProcessed: return "human_snapshot_processed";
    case OfflineTurnEvent::HumanMoveAccepted: return "human_move_accepted";
    case OfflineTurnEvent::EngineSearchRequested: return "engine_search_requested";
    case OfflineTurnEvent::EngineResultRejected: return "engine_result_rejected";
    case OfflineTurnEvent::OpponentMoveStaged: return "opponent_move_staged";
    case OfflineTurnEvent::OpponentExecutionStarted: return "opponent_execution_started";
    case OfflineTurnEvent::OpponentRetryReady: return "opponent_retry_ready";
    case OfflineTurnEvent::OpponentMoveVerified: return "opponent_move_verified";
    case OfflineTurnEvent::OpponentPromotionRequired: return "opponent_promotion_required";
    case OfflineTurnEvent::PromotionConfirmationRejected: return "promotion_confirmation_rejected";
    case OfflineTurnEvent::GameEnded: return "game_ended";
    case OfflineTurnEvent::RestoreRequired: return "restore_required";
    case OfflineTurnEvent::Error: return "error";
    default: return "unknown";
  }
}

OfflineTurnCoordinator::OfflineTurnCoordinator(OfflineCoordinatorConfig config)
    : config_(std::move(config)), physical_(config_.humanColor) {
  initializePhase();
}

void OfflineTurnCoordinator::reset() {
  physical_.reset();
  engineRequest_.reset();
  opponentPlan_.reset();
  verifiedPromotionOccupancy_.reset();
  syncContext_ = SyncContext::None;
  initializePhase();
}

bool OfflineTurnCoordinator::loadFen(std::string_view fen) {
  if (!physical_.loadFen(fen)) return false;
  engineRequest_.reset();
  opponentPlan_.reset();
  verifiedPromotionOccupancy_.reset();
  syncContext_ = SyncContext::None;
  initializePhase();
  return true;
}

void OfflineTurnCoordinator::initializePhase() {
  if (isTerminal(physical_.game().status())) {
    phase_ = OfflineTurnPhase::GameOver;
    return;
  }
  if (physical_.phase() == PhysicalPhase::WaitingForOpponent) {
    requestEngineSearch();
    return;
  }
  phase_ = OfflineTurnPhase::HumanTurn;
}

void OfflineTurnCoordinator::requestEngineSearch() {
  EngineSearchRequest request;
  request.generation = ++nextGeneration_;
  request.fen = physical_.game().fen();
  request.limits = config_.searchLimits;
  engineRequest_ = std::move(request);
  phase_ = OfflineTurnPhase::EngineSearchNeeded;
}

OfflineTurnResult OfflineTurnCoordinator::resultFor(
    OfflineTurnEvent event, std::string message) const {
  OfflineTurnResult result;
  result.phase = phase_;
  result.event = event;
  result.physicalPhase = physical_.phase();
  result.engineRequest = engineRequest_;
  result.opponentPlan = opponentPlan_;
  result.gameStatus = physical_.game().status();
  result.message = std::move(message);
  if (opponentPlan_) {
    result.differenceFromBefore = compareOccupancy(
        opponentPlan_->beforeOccupancy, physical_.committedOccupancy());
    result.differenceFromExpected = compareOccupancy(
        opponentPlan_->expectedOccupancy, physical_.committedOccupancy());
  }
  return result;
}

OfflineTurnResult OfflineTurnCoordinator::currentState() const {
  return resultFor(OfflineTurnEvent::None);
}

std::optional<EngineSearchRequest> OfflineTurnCoordinator::pendingEngineRequest() const {
  return engineRequest_;
}

OfflineTurnResult OfflineTurnCoordinator::handleHumanResult(SnapshotResult result) {
  const PhysicalPhase physicalPhase = result.phase;
  const PhysicalEvent physicalEvent = result.event;
  const std::optional<MoveInfo> acceptedMove = result.acceptedMove;
  const std::string physicalMessage = result.message;

  if (physicalPhase == PhysicalPhase::SyncWarning) {
    phase_ = OfflineTurnPhase::SyncWarning;
    syncContext_ = SyncContext::HumanMove;
  } else if (physicalPhase == PhysicalPhase::PromotionPending) {
    phase_ = OfflineTurnPhase::HumanPromotionPending;
  } else if (physicalEvent == PhysicalEvent::MoveAccepted) {
    syncContext_ = SyncContext::None;
    if (isTerminal(physical_.game().status())) {
      phase_ = OfflineTurnPhase::GameOver;
    } else {
      requestEngineSearch();
    }
  } else {
    phase_ = OfflineTurnPhase::HumanTurn;
    syncContext_ = SyncContext::None;
  }

  const OfflineTurnEvent event = physicalEvent == PhysicalEvent::MoveAccepted
                                     ? (phase_ == OfflineTurnPhase::GameOver
                                            ? OfflineTurnEvent::GameEnded
                                            : OfflineTurnEvent::HumanMoveAccepted)
                                     : (phase_ == OfflineTurnPhase::SyncWarning
                                            ? OfflineTurnEvent::RestoreRequired
                                            : OfflineTurnEvent::HumanSnapshotProcessed);
  OfflineTurnResult output = resultFor(event, physicalMessage);
  output.physicalResult = std::move(result);
  output.acceptedMove = acceptedMove;
  return output;
}

OfflineTurnResult OfflineTurnCoordinator::processHumanSnapshot(const Occupancy& occupancy) {
  if (phase_ == OfflineTurnPhase::SyncWarning && syncContext_ == SyncContext::HumanMove) {
    return handleHumanResult(physical_.processSnapshot(occupancy));
  }
  if (phase_ != OfflineTurnPhase::HumanTurn &&
      phase_ != OfflineTurnPhase::HumanPromotionPending) {
    return resultFor(OfflineTurnEvent::Error, "A human snapshot is not accepted in the current turn phase.");
  }
  return handleHumanResult(physical_.processSnapshot(occupancy));
}

OfflineTurnResult OfflineTurnCoordinator::confirmHumanPromotion(char promotionPiece) {
  if (phase_ != OfflineTurnPhase::HumanPromotionPending) {
    return resultFor(OfflineTurnEvent::PromotionConfirmationRejected,
                     "No human promotion is waiting for confirmation.");
  }
  SnapshotResult physicalResult = physical_.confirmPromotion(promotionPiece);
  const bool rejected = physicalResult.event == PhysicalEvent::InvalidPromotionChoice;
  OfflineTurnResult result = handleHumanResult(std::move(physicalResult));
  if (rejected) result.event = OfflineTurnEvent::PromotionConfirmationRejected;
  return result;
}

OfflineTurnResult OfflineTurnCoordinator::submitEngineResult(
    std::uint32_t generation, const SearchResult& searchResult) {
  if (phase_ != OfflineTurnPhase::EngineSearchNeeded || !engineRequest_) {
    return resultFor(OfflineTurnEvent::EngineResultRejected,
                     "No engine search result is currently expected.");
  }
  if (generation != engineRequest_->generation) {
    return resultFor(OfflineTurnEvent::EngineResultRejected,
                     "Stale engine result rejected; the current request remains active.");
  }

  OpponentMovePreview preview;
  if (!isUsableSearchResult(searchResult) ||
      !physical_.previewOpponentMove(searchResult.bestMove, preview)) {
    requestEngineSearch();
    return resultFor(OfflineTurnEvent::EngineResultRejected,
                     "Engine result was empty, terminal, or illegal; a fresh search is required.");
  }

  OpponentMovePlan plan;
  plan.search = searchResult;
  plan.move = preview.move;
  plan.beforeFen = preview.beforeFen;
  plan.afterFen = preview.afterFen;
  plan.beforeOccupancy = physical_.committedOccupancy();
  plan.expectedOccupancy = preview.expectedOccupancy;
  plan.expectedStatus = preview.expectedStatus;
  opponentPlan_ = std::move(plan);
  engineRequest_.reset();
  verifiedPromotionOccupancy_.reset();
  syncContext_ = SyncContext::None;
  phase_ = OfflineTurnPhase::OpponentMoveReady;
  return resultFor(OfflineTurnEvent::OpponentMoveStaged, "Opponent move staged for physical execution.");
}

OfflineTurnResult OfflineTurnCoordinator::beginOpponentExecution() {
  if (phase_ == OfflineTurnPhase::OpponentMoveExecuting && opponentPlan_) {
    return resultFor(OfflineTurnEvent::None, "Opponent move execution is already active.");
  }
  if (phase_ != OfflineTurnPhase::OpponentMoveReady || !opponentPlan_) {
    return resultFor(OfflineTurnEvent::Error, "No staged opponent move is ready to execute.");
  }
  phase_ = OfflineTurnPhase::OpponentMoveExecuting;
  return resultFor(OfflineTurnEvent::OpponentExecutionStarted, "Opponent move execution started.");
}

OfflineTurnResult OfflineTurnCoordinator::commitOpponentMove() {
  if (!opponentPlan_) {
    phase_ = OfflineTurnPhase::Error;
    return resultFor(OfflineTurnEvent::Error, "Opponent move metadata is missing.");
  }

  const OpponentMovePlan completedPlan = *opponentPlan_;
  const Occupancy& verifiedOccupancy = verifiedPromotionOccupancy_
                                           ? *verifiedPromotionOccupancy_
                                           : completedPlan.expectedOccupancy;
  MoveInfo accepted;
  if (!physical_.commitVerifiedOpponentMove(
          completedPlan.move.uci, verifiedOccupancy, accepted)) {
    phase_ = OfflineTurnPhase::Error;
    return resultFor(OfflineTurnEvent::Error, "Verified opponent move could not be committed.");
  }

  opponentPlan_.reset();
  verifiedPromotionOccupancy_.reset();
  syncContext_ = SyncContext::None;
  const bool gameOver = isTerminal(physical_.game().status());
  phase_ = gameOver ? OfflineTurnPhase::GameOver : OfflineTurnPhase::HumanTurn;
  OfflineTurnResult result = resultFor(
      gameOver ? OfflineTurnEvent::GameEnded : OfflineTurnEvent::OpponentMoveVerified,
      gameOver ? "Opponent move verified; the game is over."
               : "Opponent move verified; human turn is ready.");
  result.acceptedMove = std::move(accepted);
  result.opponentPlan = completedPlan;
  return result;
}

OfflineTurnResult OfflineTurnCoordinator::handleOpponentOccupancy(const Occupancy& occupancy) {
  if (!opponentPlan_) {
    phase_ = OfflineTurnPhase::Error;
    return resultFor(OfflineTurnEvent::Error, "Opponent execution has no staged move.");
  }

  if (occupancy == opponentPlan_->expectedOccupancy) {
    if (!opponentPlan_->move.promotion.empty()) {
      verifiedPromotionOccupancy_ = occupancy;
      syncContext_ = SyncContext::None;
      phase_ = OfflineTurnPhase::OpponentPromotionPending;
      return resultFor(OfflineTurnEvent::OpponentPromotionRequired,
                       "Replace the pawn and confirm the engine-selected promotion piece.");
    }
    return commitOpponentMove();
  }

  if (occupancy == opponentPlan_->beforeOccupancy) {
    syncContext_ = SyncContext::None;
    phase_ = OfflineTurnPhase::OpponentMoveReady;
    OfflineTurnResult result = resultFor(
        OfflineTurnEvent::OpponentRetryReady,
        "The pre-move position is restored; retry the same staged opponent move.");
    result.differenceFromBefore = compareOccupancy(opponentPlan_->beforeOccupancy, occupancy);
    result.differenceFromExpected = compareOccupancy(opponentPlan_->expectedOccupancy, occupancy);
    return result;
  }

  syncContext_ = SyncContext::OpponentExecution;
  phase_ = OfflineTurnPhase::SyncWarning;
  OfflineTurnResult result = resultFor(
      OfflineTurnEvent::RestoreRequired,
      "Opponent execution occupancy matches neither the pre-move nor expected position.");
  result.differenceFromBefore = compareOccupancy(opponentPlan_->beforeOccupancy, occupancy);
  result.differenceFromExpected = compareOccupancy(opponentPlan_->expectedOccupancy, occupancy);
  return result;
}

OfflineTurnResult OfflineTurnCoordinator::completeOpponentExecution(
    const Occupancy& finalOccupancy) {
  if (phase_ == OfflineTurnPhase::SyncWarning &&
      syncContext_ == SyncContext::OpponentExecution) {
    return handleOpponentOccupancy(finalOccupancy);
  }
  if (phase_ != OfflineTurnPhase::OpponentMoveExecuting) {
    if (phase_ == OfflineTurnPhase::OpponentPromotionPending && opponentPlan_ &&
        finalOccupancy == opponentPlan_->expectedOccupancy) {
      return resultFor(OfflineTurnEvent::None, "Duplicate promotion completion report ignored.");
    }
    if (phase_ == OfflineTurnPhase::OpponentMoveReady && opponentPlan_ &&
        finalOccupancy == opponentPlan_->beforeOccupancy) {
      return resultFor(OfflineTurnEvent::None, "Duplicate unchanged-board completion report ignored.");
    }
    if (!opponentPlan_ && finalOccupancy == physical_.committedOccupancy()) {
      return resultFor(OfflineTurnEvent::None, "Duplicate completion report ignored.");
    }
    return resultFor(OfflineTurnEvent::Error, "Opponent execution is not active.");
  }
  return handleOpponentOccupancy(finalOccupancy);
}

OfflineTurnResult OfflineTurnCoordinator::processRecoverySnapshot(const Occupancy& occupancy) {
  if (phase_ != OfflineTurnPhase::SyncWarning) {
    return resultFor(OfflineTurnEvent::Error, "No synchronization warning is active.");
  }
  if (syncContext_ == SyncContext::OpponentExecution) {
    return handleOpponentOccupancy(occupancy);
  }
  if (syncContext_ == SyncContext::HumanMove) {
    return handleHumanResult(physical_.processSnapshot(occupancy));
  }
  phase_ = OfflineTurnPhase::Error;
  return resultFor(OfflineTurnEvent::Error, "Synchronization warning has no recovery context.");
}

OfflineTurnResult OfflineTurnCoordinator::confirmOpponentPromotion(char promotionPiece) {
  if (phase_ != OfflineTurnPhase::OpponentPromotionPending ||
      !opponentPlan_ || !verifiedPromotionOccupancy_) {
    return resultFor(OfflineTurnEvent::PromotionConfirmationRejected,
                     "No opponent promotion is waiting for confirmation.");
  }

  const char normalized = static_cast<char>(
      std::tolower(static_cast<unsigned char>(promotionPiece)));
  const char expected = opponentPlan_->move.promotion.empty()
                            ? '\0'
                            : opponentPlan_->move.promotion.front();
  if (!isPromotionChoice(normalized) || normalized != expected) {
    return resultFor(OfflineTurnEvent::PromotionConfirmationRejected,
                     "Confirmed promotion piece does not match the engine move.");
  }
  return commitOpponentMove();
}

}  // namespace offline
