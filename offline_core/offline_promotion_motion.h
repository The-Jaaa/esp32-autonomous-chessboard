#pragma once

#include "offline_capture_motion.h"

#include <cstdint>
#include <string>

namespace offline {

constexpr std::uint32_t kPromotionMotionMaximumAttempts = 2;

class OfflinePromotionMotionCompiler {
 public:
  [[nodiscard]] CaptureMotionProgram compile(
      const OfflinePhaseExecutionRequest& request) const;
};

bool promotionMotionAttemptAllowed(const OfflinePhaseExecutionToken& token);

enum class PromotionReplacementState {
  Idle,
  WaitingForLift,
  WaitingForReplacement,
  ReadyToConfirm,
  SyncWarning,
  Complete,
  Error
};

enum class PromotionReplacementEvent {
  None,
  Armed,
  PawnLifted,
  ReplacementReady,
  RecoveryRequired,
  Confirmed,
  ConfirmationRejected,
  Error
};

struct PromotionReplacementUpdate {
  PromotionReplacementState state = PromotionReplacementState::Idle;
  PromotionReplacementEvent event = PromotionReplacementEvent::None;
  OccupancyDiff differenceFromEmpty;
  OccupancyDiff differenceFromExpected;
  std::string message;
};

class OfflinePromotionReplacementGate {
 public:
  PromotionReplacementUpdate arm(
      std::string targetSquare,
      char promotionPiece,
      const Occupancy& expectedOccupancy);
  PromotionReplacementUpdate processSnapshot(const Occupancy& occupancy);
  PromotionReplacementUpdate confirm(
      char promotionPiece,
      const Occupancy& occupancy);

  [[nodiscard]] PromotionReplacementState state() const { return state_; }
  [[nodiscard]] bool liftObserved() const { return liftObserved_; }
  [[nodiscard]] char promotionPiece() const { return promotionPiece_; }
  [[nodiscard]] const std::string& targetSquare() const { return targetSquare_; }

 private:
  PromotionReplacementUpdate updateFor(
      PromotionReplacementEvent event,
      std::string message = {}) const;

  PromotionReplacementState state_ = PromotionReplacementState::Idle;
  std::string targetSquare_;
  char promotionPiece_ = '\0';
  Occupancy expectedOccupancy_{};
  Occupancy emptyTargetOccupancy_{};
  bool liftObserved_ = false;
};

const char* promotionReplacementStateName(PromotionReplacementState state);
const char* promotionReplacementEventName(PromotionReplacementEvent event);

}  // namespace offline
