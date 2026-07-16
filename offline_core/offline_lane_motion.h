#pragma once

#include "offline_phase_execution.h"

#include <cstdint>
#include <string>
#include <vector>

namespace offline {

constexpr std::uint32_t kLaneMotionMaximumAttempts = 2;

enum class LaneMotionCompileStatus {
  Success,
  InvalidPhase,
  UnsupportedMove,
  UnsupportedRoute,
  InvalidOccupancy,
  InvalidPath,
  InvalidCoordinate,
  InvalidGraveyard
};

enum class LaneMotionPrimitiveKind {
  TravelBoard,
  Pickup,
  DragCoordinate,
  DragBoard,
  Drop,
  Verify
};

struct LaneMotionPrimitive {
  LaneMotionPrimitiveKind kind = LaneMotionPrimitiveKind::TravelBoard;
  int sourceRawIndex = -1;
  int targetRawIndex = -1;
  double targetX = 0.0;
  double targetY = 0.0;
  bool finalBoardDrop = false;

  [[nodiscard]] bool operator==(const LaneMotionPrimitive& other) const {
    return kind == other.kind && sourceRawIndex == other.sourceRawIndex &&
           targetRawIndex == other.targetRawIndex && targetX == other.targetX &&
           targetY == other.targetY &&
           finalBoardDrop == other.finalBoardDrop;
  }
};

struct LaneMotionProgram {
  LaneMotionCompileStatus status = LaneMotionCompileStatus::InvalidPhase;
  OfflinePhaseExecutionToken token;
  MotionPhaseKind phaseKind = MotionPhaseKind::QuietTransfer;
  std::string moveUci;
  std::string from;
  std::string to;
  int sourceRawIndex = -1;
  int targetRawIndex = -1;
  ExternalRouteMode routeMode = ExternalRouteMode::Lane;
  int routeCost = 0;
  std::vector<std::string> rawPathSquares;
  std::vector<std::string> compressedPathSquares;
  std::vector<ExternalRouteTarget> routeTargets;
  std::string graveyardSlotKey;
  std::vector<LaneMotionPrimitive> primitives;
  Occupancy expectedBefore{};
  Occupancy expectedAfter{};
  std::string blockedReason;

  [[nodiscard]] bool success() const {
    return status == LaneMotionCompileStatus::Success;
  }
};

class OfflineLaneMotionCompiler {
 public:
  [[nodiscard]] LaneMotionProgram compile(
      const OfflinePhaseExecutionRequest& request) const;
};

const char* laneMotionCompileStatusName(LaneMotionCompileStatus status);
const char* laneMotionPrimitiveKindName(LaneMotionPrimitiveKind kind);
bool laneMotionAttemptAllowed(const OfflinePhaseExecutionToken& token);

}  // namespace offline
