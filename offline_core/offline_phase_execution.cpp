#include "offline_phase_execution.h"

#include <utility>

namespace offline {
namespace {

bool executionFinished(OfflineTurnPhase phase) {
  return phase == OfflineTurnPhase::HumanTurn ||
         phase == OfflineTurnPhase::GameOver;
}

}  // namespace

OfflinePhaseExecutionAdapter::OfflinePhaseExecutionAdapter(
    OfflineReadOnlyRuntime& runtime)
    : runtime_(runtime) {}

void OfflinePhaseExecutionAdapter::setRuntimePhase(OfflineRuntimePhase phase) {
  runtime_.phase_ = phase;
}

OfflinePhaseExecutionUpdate OfflinePhaseExecutionAdapter::updateFor(
    OfflinePhaseExecutionEvent event,
    std::string message,
    std::optional<OfflineTurnResult> result) const {
  OfflinePhaseExecutionUpdate update;
  update.state = state_;
  update.event = event;
  update.request = request_;
  update.coordinatorResult = std::move(result);
  if (update.coordinatorResult) {
    update.differenceFromBefore = update.coordinatorResult->differenceFromBefore;
    update.differenceFromExpected = update.coordinatorResult->differenceFromExpected;
  }
  update.message = std::move(message);
  return update;
}

OfflinePhaseExecutionUpdate OfflinePhaseExecutionAdapter::issueCurrentPhase(
    OfflinePhaseExecutionState state,
    OfflinePhaseExecutionEvent event,
    std::string message,
    std::uint32_t attempt) {
  const auto transaction = runtime_.coordinator_.pendingMotionTransaction();
  if (!transaction || transaction->currentPhase >= transaction->motion.phases.size()) {
    state_ = OfflinePhaseExecutionState::Error;
    request_.reset();
    setRuntimePhase(OfflineRuntimePhase::Error);
    return updateFor(
        OfflinePhaseExecutionEvent::Error,
        "The coordinator has no current motion phase for the adapter.");
  }

  OfflinePhaseExecutionRequest request;
  request.token.transactionId = transaction->transactionId;
  request.token.phaseIndex = transaction->currentPhase;
  std::uint32_t lastAttempt = 0;
  for (const OfflinePhaseExecutionToken& token : issuedTokens_) {
    if (token.transactionId == transaction->transactionId &&
        token.phaseIndex == transaction->currentPhase &&
        token.attempt > lastAttempt) {
      lastAttempt = token.attempt;
    }
  }
  if (attempt == 0) {
    attempt = lastAttempt + 1;
  } else if (attempt <= lastAttempt) {
    attempt = lastAttempt + 1;
  }
  request.token.attempt = attempt;
  request.move = transaction->motion.move;
  request.phase = transaction->motion.phases[transaction->currentPhase];
  request.graveyardSlotKey = transaction->graveyardSlotKey;
  request.graveyardState = transaction->graveyardState;
  request_ = std::move(request);
  issuedTokens_.push_back(request_->token);
  state_ = state;
  setRuntimePhase(OfflineRuntimePhase::OpponentExecuting);
  return updateFor(event, std::move(message));
}

OfflinePhaseExecutionUpdate OfflinePhaseExecutionAdapter::begin() {
  if (state_ != OfflinePhaseExecutionState::Idle) {
    if (state_ == OfflinePhaseExecutionState::PhaseReady ||
        state_ == OfflinePhaseExecutionState::AwaitingReport ||
        state_ == OfflinePhaseExecutionState::RetryReady) {
      return updateFor(
          OfflinePhaseExecutionEvent::None,
          "Phase execution is already active.");
    }
    return updateFor(
        OfflinePhaseExecutionEvent::Error,
        "Phase execution cannot begin from the current adapter state.");
  }
  if (runtime_.phase_ != OfflineRuntimePhase::PlanReady) {
    return updateFor(
        OfflinePhaseExecutionEvent::Error,
        "The read-only runtime has no staged plan ready for execution.");
  }

  OfflineTurnResult result = runtime_.coordinator_.beginOpponentExecution();
  if (result.phase != OfflineTurnPhase::OpponentMoveExecuting) {
    state_ = OfflinePhaseExecutionState::Error;
    setRuntimePhase(OfflineRuntimePhase::Error);
    return updateFor(
        OfflinePhaseExecutionEvent::Error,
        result.message,
        std::move(result));
  }
  OfflinePhaseExecutionUpdate update = issueCurrentPhase(
      OfflinePhaseExecutionState::PhaseReady,
      OfflinePhaseExecutionEvent::ExecutionStarted,
      "Opponent phase execution started.",
      1);
  update.coordinatorResult = std::move(result);
  return update;
}

OfflinePhaseExecutionUpdate OfflinePhaseExecutionAdapter::takeCurrentRequest() {
  if ((state_ != OfflinePhaseExecutionState::PhaseReady &&
       state_ != OfflinePhaseExecutionState::RetryReady) || !request_) {
    return updateFor(
        OfflinePhaseExecutionEvent::Error,
        "No phase request is ready to be issued.");
  }
  state_ = OfflinePhaseExecutionState::AwaitingReport;
  return updateFor(
      OfflinePhaseExecutionEvent::PhaseRequestIssued,
      "The current phase request is awaiting a token-matched report.");
}

bool OfflinePhaseExecutionAdapter::isDuplicateAcceptedReport(
    const OfflinePhaseExecutionReport& report) const {
  return lastAcceptedToken_ && lastAcceptedOccupancy_ &&
         report.token == *lastAcceptedToken_ &&
         report.occupancy == *lastAcceptedOccupancy_;
}

OfflinePhaseExecutionUpdate OfflinePhaseExecutionAdapter::submitReport(
    const OfflinePhaseExecutionReport& report) {
  if (isDuplicateAcceptedReport(report)) {
    return updateFor(
        OfflinePhaseExecutionEvent::DuplicateReportIgnored,
        "Duplicate accepted phase report ignored.");
  }
  if ((state_ != OfflinePhaseExecutionState::AwaitingReport &&
       state_ != OfflinePhaseExecutionState::RecoveryRequired) ||
      !request_) {
    return updateFor(
        OfflinePhaseExecutionEvent::StaleReportRejected,
        "No phase report is expected in the current adapter state.");
  }
  if (report.token != request_->token) {
    return updateFor(
        OfflinePhaseExecutionEvent::StaleReportRejected,
        "The phase report token is stale or out of order.");
  }

  const OfflinePhaseExecutionToken acceptedToken = report.token;
  OfflineTurnResult result = runtime_.coordinator_.completeOpponentPhase(
      {report.token.transactionId,
       report.token.phaseIndex,
       report.success,
       report.occupancy});

  if (result.event == OfflineTurnEvent::OpponentPhaseRetryReady &&
      result.phase == OfflineTurnPhase::OpponentMoveExecuting) {
    return issueCurrentPhase(
        OfflinePhaseExecutionState::RetryReady,
        OfflinePhaseExecutionEvent::PhaseRetryReady,
        result.message,
        report.token.attempt + 1);
  }

  if (result.phase == OfflineTurnPhase::SyncWarning) {
    state_ = OfflinePhaseExecutionState::RecoveryRequired;
    setRuntimePhase(OfflineRuntimePhase::SyncWarning);
    return updateFor(
        result.event == OfflineTurnEvent::GraveyardConfirmationRequired
            ? OfflinePhaseExecutionEvent::GraveyardReleaseRequired
            : OfflinePhaseExecutionEvent::RecoveryRequired,
        result.message,
        std::move(result));
  }

  if (result.event == OfflineTurnEvent::Error ||
      result.phase == OfflineTurnPhase::Error) {
    state_ = OfflinePhaseExecutionState::Error;
    request_.reset();
    setRuntimePhase(OfflineRuntimePhase::Error);
    return updateFor(
        OfflinePhaseExecutionEvent::Error,
        result.message,
        std::move(result));
  }

  lastAcceptedToken_ = acceptedToken;
  lastAcceptedOccupancy_ = report.occupancy;
  return mapCoordinatorResult(
      std::move(result), OfflinePhaseExecutionEvent::PhaseVerified);
}

OfflinePhaseExecutionUpdate OfflinePhaseExecutionAdapter::mapCoordinatorResult(
    OfflineTurnResult result,
    OfflinePhaseExecutionEvent preferredEvent) {
  if (result.phase == OfflineTurnPhase::OpponentMoveExecuting) {
    OfflinePhaseExecutionUpdate update = issueCurrentPhase(
        OfflinePhaseExecutionState::PhaseReady,
        preferredEvent == OfflinePhaseExecutionEvent::None
            ? OfflinePhaseExecutionEvent::PhaseVerified
            : preferredEvent,
        result.message,
        0);
    update.coordinatorResult = std::move(result);
    return update;
  }

  if (result.phase == OfflineTurnPhase::OpponentMoveReady) {
    OfflineTurnResult started = runtime_.coordinator_.beginOpponentExecution();
    if (started.phase != OfflineTurnPhase::OpponentMoveExecuting) {
      state_ = OfflinePhaseExecutionState::Error;
      request_.reset();
      setRuntimePhase(OfflineRuntimePhase::Error);
      return updateFor(
          OfflinePhaseExecutionEvent::Error,
          started.message,
          std::move(started));
    }
    OfflinePhaseExecutionUpdate update = issueCurrentPhase(
        OfflinePhaseExecutionState::RetryReady,
        OfflinePhaseExecutionEvent::PhaseRetryReady,
        result.message,
        0);
    update.coordinatorResult = std::move(result);
    return update;
  }

  if (result.phase == OfflineTurnPhase::OpponentPromotionPending) {
    state_ = OfflinePhaseExecutionState::PromotionPending;
    request_.reset();
    setRuntimePhase(OfflineRuntimePhase::OpponentPromotionPending);
    return updateFor(
        result.event == OfflineTurnEvent::OpponentPromotionReplacementInProgress
            ? OfflinePhaseExecutionEvent::PromotionReplacementInProgress
            : (result.event == OfflineTurnEvent::OpponentPromotionConfirmationReady
                   ? OfflinePhaseExecutionEvent::PromotionConfirmationReady
                   : OfflinePhaseExecutionEvent::PromotionRequired),
        result.message,
        std::move(result));
  }

  if (executionFinished(result.phase)) {
    request_.reset();
    state_ = result.phase == OfflineTurnPhase::GameOver
                 ? OfflinePhaseExecutionState::GameOver
                 : OfflinePhaseExecutionState::Complete;
    setRuntimePhase(result.phase == OfflineTurnPhase::GameOver
                        ? OfflineRuntimePhase::GameOver
                        : OfflineRuntimePhase::ExecutionComplete);
    return updateFor(
        result.phase == OfflineTurnPhase::GameOver
            ? OfflinePhaseExecutionEvent::GameEnded
            : OfflinePhaseExecutionEvent::MoveCommitted,
        result.message,
        std::move(result));
  }

  if (result.phase == OfflineTurnPhase::SyncWarning) {
    state_ = OfflinePhaseExecutionState::RecoveryRequired;
    setRuntimePhase(OfflineRuntimePhase::SyncWarning);
    return updateFor(
        result.event == OfflineTurnEvent::GraveyardConfirmationRequired
            ? OfflinePhaseExecutionEvent::GraveyardReleaseRequired
            : OfflinePhaseExecutionEvent::RecoveryRequired,
        result.message,
        std::move(result));
  }

  state_ = OfflinePhaseExecutionState::Error;
  request_.reset();
  setRuntimePhase(OfflineRuntimePhase::Error);
  return updateFor(
      OfflinePhaseExecutionEvent::Error,
      result.message.empty() ? "Unsupported coordinator result." : result.message,
      std::move(result));
}

OfflinePhaseExecutionUpdate OfflinePhaseExecutionAdapter::processRecoverySnapshot(
    const Occupancy& occupancy) {
  if (state_ != OfflinePhaseExecutionState::RecoveryRequired) {
    return updateFor(
        OfflinePhaseExecutionEvent::Error,
        "The adapter is not waiting for recovery occupancy.");
  }
  return mapCoordinatorResult(runtime_.coordinator_.processRecoverySnapshot(occupancy));
}

OfflinePhaseExecutionUpdate OfflinePhaseExecutionAdapter::confirmGraveyardSlotReleased(
    std::string_view slotKey,
    const Occupancy& restoredOccupancy) {
  const auto transaction = runtime_.coordinator_.pendingMotionTransaction();
  if (state_ != OfflinePhaseExecutionState::RecoveryRequired || !transaction) {
    return updateFor(
        OfflinePhaseExecutionEvent::Error,
        "No graveyard release confirmation is expected.");
  }
  return mapCoordinatorResult(runtime_.coordinator_.confirmGraveyardSlotReleased(
      transaction->transactionId, slotKey, restoredOccupancy));
}

OfflinePhaseExecutionUpdate OfflinePhaseExecutionAdapter::processPromotionSnapshot(
    const Occupancy& occupancy) {
  if (state_ != OfflinePhaseExecutionState::PromotionPending &&
      state_ != OfflinePhaseExecutionState::RecoveryRequired) {
    return updateFor(
        OfflinePhaseExecutionEvent::Error,
        "No opponent promotion replacement is pending.");
  }
  OfflineTurnResult result =
      state_ == OfflinePhaseExecutionState::RecoveryRequired
          ? runtime_.coordinator_.processRecoverySnapshot(occupancy)
          : runtime_.coordinator_.processOpponentPromotionSnapshot(occupancy);
  return mapCoordinatorResult(std::move(result));
}

OfflinePhaseExecutionUpdate OfflinePhaseExecutionAdapter::confirmPromotion(
    char promotionPiece,
    const Occupancy& occupancy) {
  if (state_ != OfflinePhaseExecutionState::PromotionPending) {
    return updateFor(
        OfflinePhaseExecutionEvent::Error,
        "No opponent promotion confirmation is pending.");
  }
  OfflineTurnResult result = runtime_.coordinator_.confirmOpponentPromotion(
      promotionPiece, occupancy);
  if (result.event == OfflineTurnEvent::PromotionConfirmationRejected) {
    return updateFor(
        OfflinePhaseExecutionEvent::PromotionConfirmationRejected,
        result.message,
        std::move(result));
  }
  return mapCoordinatorResult(std::move(result));
}

OfflinePhaseExecutionUpdate OfflinePhaseExecutionAdapter::openNextHumanTurn(
    const Occupancy& occupancy) {
  const Occupancy& expected = runtime_.coordinator_.physical().committedOccupancy();
  if (state_ == OfflinePhaseExecutionState::Idle &&
      runtime_.phase_ == OfflineRuntimePhase::HumanTurn && occupancy == expected) {
    return updateFor(
        OfflinePhaseExecutionEvent::None,
        "The next human turn is already open.");
  }
  if (state_ != OfflinePhaseExecutionState::Complete ||
      runtime_.phase_ != OfflineRuntimePhase::ExecutionComplete ||
      runtime_.coordinator_.phase() != OfflineTurnPhase::HumanTurn) {
    return updateFor(
        OfflinePhaseExecutionEvent::Error,
        "The completed opponent turn is not ready to reopen for the human.");
  }
  if (occupancy != expected) {
    OfflinePhaseExecutionUpdate update = updateFor(
        OfflinePhaseExecutionEvent::TurnBoundaryBlocked,
        "The board must match the committed position before the next human turn opens.");
    update.differenceFromExpected = compareOccupancy(expected, occupancy);
    return update;
  }

  runtime_.latestOccupancy_ = occupancy;
  runtime_.lastProcessedOccupancy_ = occupancy;
  runtime_.hasLatestOccupancy_ = true;
  runtime_.hasLastProcessedOccupancy_ = true;
  runtime_.planningWarning_ = false;
  runtime_.phase_ = OfflineRuntimePhase::HumanTurn;
  state_ = OfflinePhaseExecutionState::Idle;
  request_.reset();
  issuedTokens_.clear();
  lastAcceptedToken_.reset();
  lastAcceptedOccupancy_.reset();
  return updateFor(
      OfflinePhaseExecutionEvent::HumanTurnOpened,
      "The verified opponent turn is complete and the human turn is open.");
}

OfflinePhaseExecutionUpdate OfflinePhaseExecutionAdapter::currentState() const {
  return updateFor(OfflinePhaseExecutionEvent::None);
}

const char* offlinePhaseExecutionStateName(OfflinePhaseExecutionState state) {
  switch (state) {
    case OfflinePhaseExecutionState::Idle: return "idle";
    case OfflinePhaseExecutionState::PhaseReady: return "phase_ready";
    case OfflinePhaseExecutionState::AwaitingReport: return "awaiting_report";
    case OfflinePhaseExecutionState::RetryReady: return "retry_ready";
    case OfflinePhaseExecutionState::RecoveryRequired: return "recovery_required";
    case OfflinePhaseExecutionState::PromotionPending: return "promotion_pending";
    case OfflinePhaseExecutionState::Complete: return "complete";
    case OfflinePhaseExecutionState::GameOver: return "game_over";
    case OfflinePhaseExecutionState::Error: return "error";
  }
  return "unknown";
}

const char* offlinePhaseExecutionEventName(OfflinePhaseExecutionEvent event) {
  switch (event) {
    case OfflinePhaseExecutionEvent::None: return "none";
    case OfflinePhaseExecutionEvent::ExecutionStarted: return "execution_started";
    case OfflinePhaseExecutionEvent::PhaseRequestIssued: return "phase_request_issued";
    case OfflinePhaseExecutionEvent::PhaseVerified: return "phase_verified";
    case OfflinePhaseExecutionEvent::PhaseRetryReady: return "phase_retry_ready";
    case OfflinePhaseExecutionEvent::StaleReportRejected: return "stale_report_rejected";
    case OfflinePhaseExecutionEvent::DuplicateReportIgnored: return "duplicate_report_ignored";
    case OfflinePhaseExecutionEvent::RecoveryRequired: return "recovery_required";
    case OfflinePhaseExecutionEvent::GraveyardReleaseRequired: return "graveyard_release_required";
    case OfflinePhaseExecutionEvent::PromotionRequired: return "promotion_required";
    case OfflinePhaseExecutionEvent::PromotionReplacementInProgress: return "promotion_replacement_in_progress";
    case OfflinePhaseExecutionEvent::PromotionConfirmationReady: return "promotion_confirmation_ready";
    case OfflinePhaseExecutionEvent::PromotionConfirmationRejected: return "promotion_confirmation_rejected";
    case OfflinePhaseExecutionEvent::MoveCommitted: return "move_committed";
    case OfflinePhaseExecutionEvent::HumanTurnOpened: return "human_turn_opened";
    case OfflinePhaseExecutionEvent::TurnBoundaryBlocked: return "turn_boundary_blocked";
    case OfflinePhaseExecutionEvent::GameEnded: return "game_ended";
    case OfflinePhaseExecutionEvent::Error: return "error";
  }
  return "unknown";
}

}  // namespace offline
