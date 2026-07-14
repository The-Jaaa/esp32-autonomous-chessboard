#pragma once

#include "offline_external_route.h"
#include "offline_game.h"

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace offline {

enum class MotionPlanStatus {
  Success,
  InvalidMove,
  UnsupportedPromotion,
  NoSafeRoute,
  NoGraveyardCapacity,
  NoGraveyardPath
};

enum class MotionStrategy {
  Quiet,
  CaptureDirectAfterRemoval,
  CaptureStageFirstBoard,
  CaptureRemoveFirstFallback,
  CaptureRemoveFirstLane,
  CaptureRemoveFirstBoard,
  CaptureBoardStaging,
  CastleBoard,
  CastleLane,
  CastleLaneBoard
};

enum class MotionPhaseKind {
  QuietTransfer,
  AttackerStage,
  CapturedRemoval,
  AttackerFinal,
  CastleKing,
  CastleRook
};

struct MotionPlanningContext {
  std::optional<Occupancy> sensedOccupancy;
  std::vector<ExternalSlot> slots;
  std::vector<std::string> occupiedGraveyardKeys;
};

struct RejectedMotionStrategy {
  MotionStrategy strategy = MotionStrategy::Quiet;
  std::string stagingSquare;
  std::string reason;
};

struct MotionPhase {
  MotionPhaseKind kind = MotionPhaseKind::QuietTransfer;
  std::string from;
  std::string to;
  Occupancy expectedBefore{};
  Occupancy expectedAfter{};
  std::optional<ExternalTransferResult> transfer;
  std::optional<GraveyardRouteCandidate> graveyard;
};

struct MotionPlan {
  MotionPlanStatus status = MotionPlanStatus::InvalidMove;
  MoveInfo move;
  MotionStrategy strategy = MotionStrategy::Quiet;
  std::vector<MotionPhase> phases;
  double routeCost = 0.0;
  std::vector<std::string> rawPathSquares;
  std::vector<std::string> compressedPathSquares;
  std::optional<ExternalSlot> proposedGraveyardSlot;
  std::vector<GraveyardRouteCandidate> graveyardCandidates;
  std::vector<RejectedMotionStrategy> rejectedStrategies;
  std::string stagingSquare;
  std::string blockedReason;
  Occupancy initialOccupancy{};
  Occupancy finalExpectedOccupancy{};

  [[nodiscard]] bool success() const { return status == MotionPlanStatus::Success; }
};

class OfflineMotionPlanner {
 public:
  [[nodiscard]] MotionPlan planMove(
      const OfflineGame& game,
      std::string_view uci,
      const MotionPlanningContext& context = {}) const;
};

const char* motionPlanStatusName(MotionPlanStatus status);
const char* motionStrategyName(MotionStrategy strategy);
const char* motionPhaseKindName(MotionPhaseKind kind);

}  // namespace offline
