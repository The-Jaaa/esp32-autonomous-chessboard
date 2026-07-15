#pragma once

#include "offline_phase_execution.h"

#include <string>
#include <vector>

namespace offline {

constexpr std::uint32_t kQuietMotionMaximumAttempts = 2;

enum class QuietMotionCompileStatus {
  Success,
  InvalidPhase,
  UnsupportedMove,
  UnsupportedRoute,
  InvalidOccupancy,
  InvalidPath
};

enum class QuietMotionPrimitiveKind {
  Travel,
  Pickup,
  Drag,
  Drop,
  Verify
};

struct QuietMotionPrimitive {
  QuietMotionPrimitiveKind kind = QuietMotionPrimitiveKind::Travel;
  int sourceRawIndex = -1;
  int targetRawIndex = -1;
  bool finalBoardDrop = false;

  [[nodiscard]] bool operator==(const QuietMotionPrimitive& other) const {
    return kind == other.kind && sourceRawIndex == other.sourceRawIndex &&
           targetRawIndex == other.targetRawIndex &&
           finalBoardDrop == other.finalBoardDrop;
  }
};

struct QuietMotionProgram {
  QuietMotionCompileStatus status = QuietMotionCompileStatus::InvalidPhase;
  OfflinePhaseExecutionToken token;
  std::string moveUci;
  std::string from;
  std::string to;
  int sourceRawIndex = -1;
  int targetRawIndex = -1;
  ExternalRouteMode routeMode = ExternalRouteMode::Direct;
  int routeCost = 0;
  std::vector<std::string> rawPathSquares;
  std::vector<std::string> compressedPathSquares;
  std::vector<QuietMotionPrimitive> primitives;
  Occupancy expectedBefore{};
  Occupancy expectedAfter{};
  std::string blockedReason;

  [[nodiscard]] bool success() const {
    return status == QuietMotionCompileStatus::Success;
  }
};

class OfflineQuietMotionCompiler {
 public:
  [[nodiscard]] QuietMotionProgram compile(
      const OfflinePhaseExecutionRequest& request) const;
};

const char* quietMotionCompileStatusName(QuietMotionCompileStatus status);
const char* quietMotionPrimitiveKindName(QuietMotionPrimitiveKind kind);
bool quietMotionAttemptAllowed(const OfflinePhaseExecutionToken& token);

}  // namespace offline
