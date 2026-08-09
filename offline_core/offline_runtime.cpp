#include "offline_runtime.h"

#include <utility>

namespace offline {
namespace {

std::uint32_t elapsedSince(std::uint32_t nowMs, std::uint32_t thenMs) {
  return nowMs - thenMs;
}

bool isFrozenPhase(OfflineRuntimePhase phase) {
  return phase == OfflineRuntimePhase::PlanReady ||
         phase == OfflineRuntimePhase::OpponentExecuting ||
         phase == OfflineRuntimePhase::OpponentPromotionPending ||
         phase == OfflineRuntimePhase::ExecutionComplete ||
         phase == OfflineRuntimePhase::HandoffPending ||
         phase == OfflineRuntimePhase::GameOver ||
         phase == OfflineRuntimePhase::Error;
}

}  // namespace

OfflineReadOnlyRuntime::OfflineReadOnlyRuntime(OfflineRuntimeConfig config)
    : config_(std::move(config)), coordinator_(config_.coordinator) {
  reset();
}

bool OfflineReadOnlyRuntime::resetCoordinator() {
  if (config_.initialFen.empty()) {
    coordinator_.reset();
    return true;
  }
  return coordinator_.loadFen(config_.initialFen);
}

void OfflineReadOnlyRuntime::reset(std::uint32_t nowMs) {
  configurationValid_ = resetCoordinator();
  phase_ = configurationValid_ ? OfflineRuntimePhase::Disabled
                               : OfflineRuntimePhase::Error;
  sessionActive_ = false;
  setupMatchTracking_ = false;
  setupMatchSinceMs_ = nowMs;
  expectedSetupOccupancy_ = coordinator_.physical().committedOccupancy();
  latestOccupancy_.fill(false);
  lastProcessedOccupancy_.fill(false);
  hasLatestOccupancy_ = false;
  hasLastProcessedOccupancy_ = false;
  planningWarning_ = false;
}

OfflineRuntimeUpdate OfflineReadOnlyRuntime::applyOwnershipDecision(
    std::uint32_t nowMs,
    const OwnershipDecision& decision,
    const Occupancy& occupancy) {
  latestOccupancy_ = occupancy;
  hasLatestOccupancy_ = true;

  if (!configurationValid_) {
    phase_ = OfflineRuntimePhase::Error;
    return updateFor(
        OfflineRuntimeEvent::Error,
        "The read-only runtime was configured with an invalid initial FEN.");
  }

  if (decision.state == OwnershipState::RecoveryRequired) {
    phase_ = OfflineRuntimePhase::Error;
    return updateFor(
        OfflineRuntimeEvent::Error,
        "Ownership recovery is required before the offline runtime can continue.");
  }

  if (decision.handoffRequired) {
    phase_ = OfflineRuntimePhase::HandoffPending;
    return updateFor(
        OfflineRuntimeEvent::HandoffRequired,
        "The server returned at a stable boundary; state handoff is required.");
  }

  if (!decision.allowOfflineControl) {
    if (!sessionActive_) {
      phase_ = OfflineRuntimePhase::Disabled;
      setupMatchTracking_ = false;
    }
    return updateFor(
        OfflineRuntimeEvent::None,
        sessionActive_
            ? "The offline session is frozen because local ownership is unavailable."
            : "Offline ownership is not active.");
  }

  if (phase_ == OfflineRuntimePhase::Disabled) {
    phase_ = OfflineRuntimePhase::WaitingForSetup;
    setupMatchTracking_ = false;
  }

  if (phase_ == OfflineRuntimePhase::WaitingForSetup) {
    return processSetupSnapshot(nowMs, occupancy);
  }

  return updateFor(OfflineRuntimeEvent::None);
}

OfflineRuntimeUpdate OfflineReadOnlyRuntime::processSetupSnapshot(
    std::uint32_t nowMs, const Occupancy& occupancy) {
  const OccupancyDiff difference = compareOccupancy(expectedSetupOccupancy_, occupancy);
  if (!difference.empty()) {
    setupMatchTracking_ = false;
    OfflineRuntimeUpdate update = updateFor(
        OfflineRuntimeEvent::SetupMismatch,
        "The board does not match the required offline starting position.");
    update.setupDifference = difference;
    return update;
  }

  if (!setupMatchTracking_) {
    setupMatchTracking_ = true;
    setupMatchSinceMs_ = nowMs;
  }

  if (elapsedSince(nowMs, setupMatchSinceMs_) < config_.setupStableMs) {
    return updateFor(
        OfflineRuntimeEvent::SetupStabilizing,
        "The starting position matches and is being held stable.");
  }

  if (!resetCoordinator()) {
    configurationValid_ = false;
    phase_ = OfflineRuntimePhase::Error;
    return updateFor(
        OfflineRuntimeEvent::Error,
        "The configured starting position could not be loaded.");
  }

  expectedSetupOccupancy_ = coordinator_.physical().committedOccupancy();
  sessionActive_ = true;
  planningWarning_ = false;
  lastProcessedOccupancy_ = occupancy;
  hasLastProcessedOccupancy_ = true;

  switch (coordinator_.phase()) {
    case OfflineTurnPhase::HumanTurn:
      phase_ = OfflineRuntimePhase::HumanTurn;
      break;
    case OfflineTurnPhase::EngineSearchNeeded:
      phase_ = OfflineRuntimePhase::EngineSearchNeeded;
      break;
    case OfflineTurnPhase::GameOver:
      phase_ = OfflineRuntimePhase::GameOver;
      break;
    default:
      phase_ = OfflineRuntimePhase::Error;
      break;
  }

  return updateFor(
      phase_ == OfflineRuntimePhase::Error ? OfflineRuntimeEvent::Error
                                          : OfflineRuntimeEvent::SessionArmed,
      phase_ == OfflineRuntimePhase::Error
          ? "The coordinator entered an unsupported phase while arming."
          : "The read-only offline session is armed.");
}

OfflineRuntimeUpdate OfflineReadOnlyRuntime::processStableSnapshot(
    std::uint32_t nowMs, const Occupancy& occupancy) {
  latestOccupancy_ = occupancy;
  hasLatestOccupancy_ = true;

  if (phase_ == OfflineRuntimePhase::WaitingForSetup) {
    return processSetupSnapshot(nowMs, occupancy);
  }

  if (isFrozenPhase(phase_)) {
    return updateFor(
        occupancy == coordinator_.physical().committedOccupancy()
            ? OfflineRuntimeEvent::None
            : OfflineRuntimeEvent::FrozenSnapshotObserved,
        "The read-only runtime is frozen and did not process the changed board.");
  }

  if (phase_ == OfflineRuntimePhase::Disabled) {
    return updateFor(
        OfflineRuntimeEvent::None,
        "The stable snapshot was ignored because offline ownership is disabled.");
  }

  if (phase_ == OfflineRuntimePhase::EngineSearchNeeded) {
    return updateFor(
        OfflineRuntimeEvent::None,
        "The latest stable snapshot was retained while engine search is pending.");
  }

  if (phase_ == OfflineRuntimePhase::SyncWarning && planningWarning_) {
    if (occupancy != coordinator_.physical().committedOccupancy()) {
      OfflineRuntimeUpdate update = updateFor(
          OfflineRuntimeEvent::RestoreRequired,
          "Restore the committed human position before motion planning can retry.");
      update.setupDifference = compareOccupancy(
          coordinator_.physical().committedOccupancy(), occupancy);
      return update;
    }
    return mapCoordinatorResult(coordinator_.retryOpponentMotionPlanning(occupancy));
  }

  if (hasLastProcessedOccupancy_ && occupancy == lastProcessedOccupancy_) {
    return updateFor(OfflineRuntimeEvent::None, "Duplicate stable snapshot ignored.");
  }
  lastProcessedOccupancy_ = occupancy;
  hasLastProcessedOccupancy_ = true;

  if (phase_ != OfflineRuntimePhase::HumanTurn &&
      phase_ != OfflineRuntimePhase::HumanPromotionPending &&
      phase_ != OfflineRuntimePhase::SyncWarning) {
    phase_ = OfflineRuntimePhase::Error;
    return updateFor(
        OfflineRuntimeEvent::Error,
        "A stable snapshot reached an unsupported read-only runtime phase.");
  }

  return mapCoordinatorResult(coordinator_.processHumanSnapshot(occupancy));
}

OfflineRuntimeUpdate OfflineReadOnlyRuntime::confirmHumanPromotion(
    char promotionPiece) {
  if (phase_ != OfflineRuntimePhase::HumanPromotionPending) {
    return updateFor(
        OfflineRuntimeEvent::PromotionConfirmationRejected,
        "No human promotion is waiting for confirmation.");
  }
  OfflineTurnResult result = coordinator_.confirmHumanPromotion(promotionPiece);
  const bool rejected =
      result.event == OfflineTurnEvent::PromotionConfirmationRejected;
  OfflineRuntimeUpdate update = mapCoordinatorResult(std::move(result));
  update.event = rejected ? OfflineRuntimeEvent::PromotionConfirmationRejected
                          : OfflineRuntimeEvent::HumanPromotionConfirmed;
  return update;
}

OfflineRuntimeUpdate OfflineReadOnlyRuntime::submitEngineResult(
    std::uint32_t generation,
    const SearchResult& searchResult,
    const Occupancy& latestOccupancy) {
  latestOccupancy_ = latestOccupancy;
  hasLatestOccupancy_ = true;

  if (phase_ != OfflineRuntimePhase::EngineSearchNeeded) {
    return updateFor(
        OfflineRuntimeEvent::EngineResultRejected,
        "No engine search result is expected in the current runtime phase.");
  }

  OfflineTurnResult result =
      coordinator_.submitEngineResult(generation, searchResult, latestOccupancy);
  const bool planningWarning = result.phase == OfflineTurnPhase::SyncWarning;
  return mapCoordinatorResult(std::move(result), planningWarning);
}

OfflineRuntimeUpdate OfflineReadOnlyRuntime::mapCoordinatorResult(
    OfflineTurnResult result, bool planningWarning) {
  OfflineRuntimeEvent event = OfflineRuntimeEvent::HumanSnapshotProcessed;
  planningWarning_ = false;

  switch (result.phase) {
    case OfflineTurnPhase::HumanTurn:
      phase_ = OfflineRuntimePhase::HumanTurn;
      event = OfflineRuntimeEvent::HumanSnapshotProcessed;
      break;
    case OfflineTurnPhase::HumanPromotionPending:
      phase_ = OfflineRuntimePhase::HumanPromotionPending;
      event = OfflineRuntimeEvent::HumanPromotionRequired;
      break;
    case OfflineTurnPhase::EngineSearchNeeded:
      phase_ = OfflineRuntimePhase::EngineSearchNeeded;
      event = result.event == OfflineTurnEvent::EngineResultRejected
                  ? OfflineRuntimeEvent::EngineResultRejected
                  : (result.event == OfflineTurnEvent::HumanMoveAccepted
                         ? OfflineRuntimeEvent::HumanMoveAccepted
                         : OfflineRuntimeEvent::EngineSearchRequested);
      break;
    case OfflineTurnPhase::OpponentMoveReady:
      phase_ = OfflineRuntimePhase::PlanReady;
      event = OfflineRuntimeEvent::MotionPlanReady;
      break;
    case OfflineTurnPhase::SyncWarning:
      phase_ = OfflineRuntimePhase::SyncWarning;
      planningWarning_ = planningWarning;
      event = OfflineRuntimeEvent::RestoreRequired;
      break;
    case OfflineTurnPhase::GameOver:
      phase_ = OfflineRuntimePhase::GameOver;
      event = OfflineRuntimeEvent::GameEnded;
      break;
    case OfflineTurnPhase::OpponentMotionBlocked:
      phase_ = OfflineRuntimePhase::Error;
      event = OfflineRuntimeEvent::Error;
      break;
    case OfflineTurnPhase::OpponentMoveExecuting:
    case OfflineTurnPhase::OpponentPromotionPending:
    case OfflineTurnPhase::Error:
      phase_ = OfflineRuntimePhase::Error;
      event = OfflineRuntimeEvent::Error;
      break;
  }

  return updateFor(event, result.message, std::move(result));
}

OfflineRuntimeUpdate OfflineReadOnlyRuntime::updateFor(
    OfflineRuntimeEvent event,
    std::string message,
    std::optional<OfflineTurnResult> coordinatorResult) const {
  OfflineRuntimeUpdate update;
  update.phase = phase_;
  update.event = event;
  update.sessionActive = sessionActive_;
  update.frozen = isFrozenPhase(phase_);
  update.coordinatorResult = std::move(coordinatorResult);
  if (phase_ == OfflineRuntimePhase::EngineSearchNeeded) {
    update.engineRequest = coordinator_.pendingEngineRequest();
  }
  update.motionTransaction = coordinator_.pendingMotionTransaction();
  if (update.coordinatorResult && update.coordinatorResult->acceptedMove) {
    update.acceptedMove = update.coordinatorResult->acceptedMove;
  }
  update.humanPromotionRequest =
      coordinator_.physical().pendingHumanPromotionRequest();
  update.gameStatus = coordinator_.physical().game().status();
  update.committedFen = coordinator_.physical().game().fen();
  update.message = std::move(message);
  if (hasLatestOccupancy_ && phase_ == OfflineRuntimePhase::WaitingForSetup) {
    update.setupDifference = compareOccupancy(expectedSetupOccupancy_, latestOccupancy_);
  }
  return update;
}

OfflineRuntimeUpdate OfflineReadOnlyRuntime::currentState() const {
  return updateFor(OfflineRuntimeEvent::None);
}

std::optional<EngineSearchRequest> OfflineReadOnlyRuntime::pendingEngineRequest() const {
  if (phase_ != OfflineRuntimePhase::EngineSearchNeeded) {
    return std::nullopt;
  }
  return coordinator_.pendingEngineRequest();
}

OwnershipSafety OfflineReadOnlyRuntime::ownershipSafety(
    const Occupancy& occupancy) const {
  OwnershipSafety safety;
  safety.boardStable = !sessionActive_ ||
                       occupancy == coordinator_.physical().committedOccupancy();
  safety.offlineGameActive = sessionActive_;
  safety.offlineAtTurnBoundary =
      sessionActive_ && safety.boardStable &&
      (phase_ == OfflineRuntimePhase::HumanTurn ||
       phase_ == OfflineRuntimePhase::GameOver);
  return safety;
}

const char* offlineRuntimePhaseName(OfflineRuntimePhase phase) {
  switch (phase) {
    case OfflineRuntimePhase::Disabled: return "disabled";
    case OfflineRuntimePhase::WaitingForSetup: return "waiting_for_setup";
    case OfflineRuntimePhase::HumanTurn: return "human_turn";
    case OfflineRuntimePhase::HumanPromotionPending: return "human_promotion_pending";
    case OfflineRuntimePhase::EngineSearchNeeded: return "engine_search_needed";
    case OfflineRuntimePhase::PlanReady: return "plan_ready";
    case OfflineRuntimePhase::OpponentExecuting: return "opponent_executing";
    case OfflineRuntimePhase::OpponentPromotionPending: return "opponent_promotion_pending";
    case OfflineRuntimePhase::ExecutionComplete: return "execution_complete";
    case OfflineRuntimePhase::SyncWarning: return "sync_warning";
    case OfflineRuntimePhase::HandoffPending: return "handoff_pending";
    case OfflineRuntimePhase::GameOver: return "game_over";
    case OfflineRuntimePhase::Error: return "error";
  }
  return "unknown";
}

const char* offlineRuntimeEventName(OfflineRuntimeEvent event) {
  switch (event) {
    case OfflineRuntimeEvent::None: return "none";
    case OfflineRuntimeEvent::WaitingForSetup: return "waiting_for_setup";
    case OfflineRuntimeEvent::SetupMismatch: return "setup_mismatch";
    case OfflineRuntimeEvent::SetupStabilizing: return "setup_stabilizing";
    case OfflineRuntimeEvent::SessionArmed: return "session_armed";
    case OfflineRuntimeEvent::HumanSnapshotProcessed: return "human_snapshot_processed";
    case OfflineRuntimeEvent::HumanMoveAccepted: return "human_move_accepted";
    case OfflineRuntimeEvent::HumanPromotionRequired: return "human_promotion_required";
    case OfflineRuntimeEvent::HumanPromotionConfirmed: return "human_promotion_confirmed";
    case OfflineRuntimeEvent::PromotionConfirmationRejected:
      return "promotion_confirmation_rejected";
    case OfflineRuntimeEvent::EngineSearchRequested: return "engine_search_requested";
    case OfflineRuntimeEvent::EngineResultRejected: return "engine_result_rejected";
    case OfflineRuntimeEvent::MotionPlanReady: return "motion_plan_ready";
    case OfflineRuntimeEvent::RestoreRequired: return "restore_required";
    case OfflineRuntimeEvent::HandoffRequired: return "handoff_required";
    case OfflineRuntimeEvent::FrozenSnapshotObserved: return "frozen_snapshot_observed";
    case OfflineRuntimeEvent::GameEnded: return "game_ended";
    case OfflineRuntimeEvent::Error: return "error";
  }
  return "unknown";
}

}  // namespace offline
