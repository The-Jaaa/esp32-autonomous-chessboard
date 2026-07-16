#pragma once

#include "offline_phase_execution.h"

#include <cstdint>
#include <string>
#include <vector>

namespace offline {

constexpr std::uint32_t kCaptureMotionMaximumAttempts = 2;

enum class CaptureMotionCompileStatus {
  Success,
  InvalidPhase,
  UnsupportedMove,
  UnsupportedRoute,
  InvalidOccupancy,
  InvalidPath,
  InvalidGraveyard
};

enum class CaptureMotionPrimitiveKind {
  TravelBoard,
  Pickup,
  DragBoard,
  DragCoordinate,
  Drop,
  Verify
};

struct CaptureMotionPrimitive {
  CaptureMotionPrimitiveKind kind = CaptureMotionPrimitiveKind::TravelBoard;
  int sourceRawIndex = -1;
  int targetRawIndex = -1;
  double targetX = 0.0;
  double targetY = 0.0;
  bool finalBoardDrop = false;

  [[nodiscard]] bool operator==(const CaptureMotionPrimitive& other) const {
    return kind == other.kind && sourceRawIndex == other.sourceRawIndex &&
           targetRawIndex == other.targetRawIndex && targetX == other.targetX &&
           targetY == other.targetY &&
           finalBoardDrop == other.finalBoardDrop;
  }
};

struct CaptureMotionProgram {
  CaptureMotionCompileStatus status = CaptureMotionCompileStatus::InvalidPhase;
  OfflinePhaseExecutionToken token;
  MotionPhaseKind phaseKind = MotionPhaseKind::CapturedRemoval;
  std::string moveUci;
  std::string from;
  std::string to;
  int sourceRawIndex = -1;
  int targetRawIndex = -1;
  ExternalRouteMode routeMode = ExternalRouteMode::Direct;
  double routeCost = 0.0;
  std::vector<std::string> rawPathSquares;
  std::vector<std::string> compressedPathSquares;
  std::vector<ExternalRouteTarget> routeTargets;
  std::string graveyardSlotKey;
  std::string graveyardLabel;
  double graveyardX = 0.0;
  double graveyardY = 0.0;
  std::vector<CaptureMotionPrimitive> primitives;
  Occupancy expectedBefore{};
  Occupancy expectedAfter{};
  std::string blockedReason;

  [[nodiscard]] bool success() const {
    return status == CaptureMotionCompileStatus::Success;
  }
};

class OfflineCaptureMotionCompiler {
 public:
  [[nodiscard]] CaptureMotionProgram compile(
      const OfflinePhaseExecutionRequest& request) const;
};

const char* captureMotionCompileStatusName(CaptureMotionCompileStatus status);
const char* captureMotionPrimitiveKindName(CaptureMotionPrimitiveKind kind);
bool captureMotionAttemptAllowed(const OfflinePhaseExecutionToken& token);

}  // namespace offline
