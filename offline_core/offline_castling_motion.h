#pragma once

#include "offline_capture_motion.h"

#include <cstdint>

namespace offline {

constexpr std::uint32_t kCastlingMotionMaximumAttempts = 2;

class OfflineCastlingMotionCompiler {
 public:
  [[nodiscard]] CaptureMotionProgram compile(
      const OfflinePhaseExecutionRequest& request) const;
};

bool castlingMotionAttemptAllowed(const OfflinePhaseExecutionToken& token);

}  // namespace offline
