#pragma once

#include "offline_coordinator.h"
#include "offline_ownership.h"

#include <cstdint>
#include <optional>
#include <string>

namespace offline {

class OfflinePhaseExecutionAdapter;

enum class OfflineRuntimePhase {
  Disabled,
  WaitingForSetup,
  HumanTurn,
  HumanPromotionPending,
  EngineSearchNeeded,
  PlanReady,
  OpponentExecuting,
  OpponentPromotionPending,
  ExecutionComplete,
  SyncWarning,
  HandoffPending,
  GameOver,
  Error
};

enum class OfflineRuntimeEvent {
  None,
  WaitingForSetup,
  SetupMismatch,
  SetupStabilizing,
  SessionArmed,
  HumanSnapshotProcessed,
  HumanMoveAccepted,
  HumanPromotionRequired,
  HumanPromotionConfirmed,
  PromotionConfirmationRejected,
  EngineSearchRequested,
  EngineResultRejected,
  MotionPlanReady,
  RestoreRequired,
  HandoffRequired,
  FrozenSnapshotObserved,
  GameEnded,
  Error
};

struct OfflineRuntimeConfig {
  OfflineCoordinatorConfig coordinator;
  std::uint32_t setupStableMs = 500;
  std::string initialFen;
};

struct OfflineRuntimeUpdate {
  OfflineRuntimePhase phase = OfflineRuntimePhase::Disabled;
  OfflineRuntimeEvent event = OfflineRuntimeEvent::None;
  bool sessionActive = false;
  bool frozen = false;
  OccupancyDiff setupDifference;
  std::optional<OfflineTurnResult> coordinatorResult;
  std::optional<EngineSearchRequest> engineRequest;
  std::optional<MotionExecutionTransaction> motionTransaction;
  std::optional<MoveInfo> acceptedMove;
  std::optional<HumanPromotionRequest> humanPromotionRequest;
  GameStatus gameStatus;
  std::string committedFen;
  std::string message;
};

class OfflineReadOnlyRuntime {
 public:
  explicit OfflineReadOnlyRuntime(OfflineRuntimeConfig config = {});

  void reset(std::uint32_t nowMs = 0);
  OfflineRuntimeUpdate applyOwnershipDecision(
      std::uint32_t nowMs,
      const OwnershipDecision& decision,
      const Occupancy& occupancy);
  OfflineRuntimeUpdate processStableSnapshot(
      std::uint32_t nowMs, const Occupancy& occupancy);
  OfflineRuntimeUpdate confirmHumanPromotion(char promotionPiece);
  OfflineRuntimeUpdate submitEngineResult(
      std::uint32_t generation,
      const SearchResult& searchResult,
      const Occupancy& latestOccupancy);

  [[nodiscard]] OfflineRuntimeUpdate currentState() const;
  [[nodiscard]] std::optional<EngineSearchRequest> pendingEngineRequest() const;
  [[nodiscard]] OwnershipSafety ownershipSafety(const Occupancy& occupancy) const;
  [[nodiscard]] OfflineRuntimePhase phase() const { return phase_; }
  [[nodiscard]] bool sessionActive() const { return sessionActive_; }
  [[nodiscard]] const Occupancy& expectedSetupOccupancy() const {
    return expectedSetupOccupancy_;
  }
  [[nodiscard]] const OfflineTurnCoordinator& coordinator() const {
    return coordinator_;
  }

 private:
  friend class OfflinePhaseExecutionAdapter;

  bool resetCoordinator();
  OfflineRuntimeUpdate processSetupSnapshot(
      std::uint32_t nowMs, const Occupancy& occupancy);
  OfflineRuntimeUpdate mapCoordinatorResult(
      OfflineTurnResult result, bool planningWarning = false);
  OfflineRuntimeUpdate updateFor(
      OfflineRuntimeEvent event,
      std::string message = {},
      std::optional<OfflineTurnResult> coordinatorResult = std::nullopt) const;

  OfflineRuntimeConfig config_;
  OfflineTurnCoordinator coordinator_;
  OfflineRuntimePhase phase_ = OfflineRuntimePhase::Disabled;
  bool configurationValid_ = true;
  bool sessionActive_ = false;
  bool setupMatchTracking_ = false;
  std::uint32_t setupMatchSinceMs_ = 0;
  Occupancy expectedSetupOccupancy_{};
  Occupancy latestOccupancy_{};
  Occupancy lastProcessedOccupancy_{};
  bool hasLatestOccupancy_ = false;
  bool hasLastProcessedOccupancy_ = false;
  bool planningWarning_ = false;
};

const char* offlineRuntimePhaseName(OfflineRuntimePhase phase);
const char* offlineRuntimeEventName(OfflineRuntimeEvent event);

}  // namespace offline
