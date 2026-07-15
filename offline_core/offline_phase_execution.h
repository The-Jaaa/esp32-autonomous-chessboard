#pragma once

#include "offline_runtime.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace offline {

enum class OfflinePhaseExecutionState {
  Idle,
  PhaseReady,
  AwaitingReport,
  RetryReady,
  RecoveryRequired,
  PromotionPending,
  Complete,
  GameOver,
  Error
};

enum class OfflinePhaseExecutionEvent {
  None,
  ExecutionStarted,
  PhaseRequestIssued,
  PhaseVerified,
  PhaseRetryReady,
  StaleReportRejected,
  DuplicateReportIgnored,
  RecoveryRequired,
  GraveyardReleaseRequired,
  PromotionRequired,
  PromotionReplacementInProgress,
  PromotionConfirmationReady,
  PromotionConfirmationRejected,
  MoveCommitted,
  GameEnded,
  Error
};

struct OfflinePhaseExecutionToken {
  std::uint32_t transactionId = 0;
  std::size_t phaseIndex = 0;
  std::uint32_t attempt = 0;

  [[nodiscard]] bool operator==(const OfflinePhaseExecutionToken& other) const {
    return transactionId == other.transactionId &&
           phaseIndex == other.phaseIndex && attempt == other.attempt;
  }
  [[nodiscard]] bool operator!=(const OfflinePhaseExecutionToken& other) const {
    return !(*this == other);
  }
};

struct OfflinePhaseExecutionRequest {
  OfflinePhaseExecutionToken token;
  MoveInfo move;
  MotionPhase phase;
  std::string graveyardSlotKey;
  GraveyardSlotState graveyardState = GraveyardSlotState::Free;
};

struct OfflinePhaseExecutionReport {
  OfflinePhaseExecutionToken token;
  bool success = false;
  Occupancy occupancy{};
};

struct OfflinePhaseExecutionUpdate {
  OfflinePhaseExecutionState state = OfflinePhaseExecutionState::Idle;
  OfflinePhaseExecutionEvent event = OfflinePhaseExecutionEvent::None;
  std::optional<OfflinePhaseExecutionRequest> request;
  std::optional<OfflineTurnResult> coordinatorResult;
  OccupancyDiff differenceFromBefore;
  OccupancyDiff differenceFromExpected;
  std::string message;
};

class OfflinePhaseExecutionAdapter {
 public:
  explicit OfflinePhaseExecutionAdapter(OfflineReadOnlyRuntime& runtime);

  OfflinePhaseExecutionUpdate begin();
  OfflinePhaseExecutionUpdate takeCurrentRequest();
  OfflinePhaseExecutionUpdate submitReport(const OfflinePhaseExecutionReport& report);
  OfflinePhaseExecutionUpdate processRecoverySnapshot(const Occupancy& occupancy);
  OfflinePhaseExecutionUpdate confirmGraveyardSlotReleased(
      std::string_view slotKey, const Occupancy& restoredOccupancy);
  OfflinePhaseExecutionUpdate processPromotionSnapshot(const Occupancy& occupancy);
  OfflinePhaseExecutionUpdate confirmPromotion(
      char promotionPiece, const Occupancy& occupancy);

  [[nodiscard]] OfflinePhaseExecutionUpdate currentState() const;
  [[nodiscard]] std::optional<OfflinePhaseExecutionRequest> currentRequest() const {
    return request_;
  }
  [[nodiscard]] OfflinePhaseExecutionState state() const { return state_; }

 private:
  OfflinePhaseExecutionUpdate issueCurrentPhase(
      OfflinePhaseExecutionState state,
      OfflinePhaseExecutionEvent event,
      std::string message,
      std::uint32_t attempt);
  OfflinePhaseExecutionUpdate mapCoordinatorResult(
      OfflineTurnResult result,
      OfflinePhaseExecutionEvent preferredEvent = OfflinePhaseExecutionEvent::None);
  OfflinePhaseExecutionUpdate updateFor(
      OfflinePhaseExecutionEvent event,
      std::string message = {},
      std::optional<OfflineTurnResult> result = std::nullopt) const;
  bool isDuplicateAcceptedReport(const OfflinePhaseExecutionReport& report) const;
  void setRuntimePhase(OfflineRuntimePhase phase);

  OfflineReadOnlyRuntime& runtime_;
  OfflinePhaseExecutionState state_ = OfflinePhaseExecutionState::Idle;
  std::optional<OfflinePhaseExecutionRequest> request_;
  std::vector<OfflinePhaseExecutionToken> issuedTokens_;
  std::optional<OfflinePhaseExecutionToken> lastAcceptedToken_;
  std::optional<Occupancy> lastAcceptedOccupancy_;
};

const char* offlinePhaseExecutionStateName(OfflinePhaseExecutionState state);
const char* offlinePhaseExecutionEventName(OfflinePhaseExecutionEvent event);

}  // namespace offline
