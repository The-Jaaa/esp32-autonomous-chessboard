#pragma once

#include "offline_capture_motion.h"

#include <cstdint>
#include <string>

namespace offline {

constexpr std::uint32_t kUnifiedMotionMaximumAttempts = 2;

enum class UnifiedMotionCompilerKind {
  Quiet,
  Lane,
  Capture,
  Castling,
  Promotion
};

enum class UnifiedMotionCompileStatus {
  Success,
  UnsupportedRequest,
  CompileFailed
};

struct UnifiedMotionProgram {
  UnifiedMotionCompileStatus status = UnifiedMotionCompileStatus::UnsupportedRequest;
  UnifiedMotionCompilerKind compiler = UnifiedMotionCompilerKind::Quiet;
  std::string sourceStatus;
  CaptureMotionProgram program;
  std::string blockedReason;

  [[nodiscard]] bool success() const {
    return status == UnifiedMotionCompileStatus::Success && program.success();
  }
};

class OfflineUnifiedMotionCompiler {
 public:
  [[nodiscard]] UnifiedMotionProgram compile(
      const OfflinePhaseExecutionRequest& request) const;
};

const char* unifiedMotionCompilerKindName(UnifiedMotionCompilerKind kind);
const char* unifiedMotionCompileStatusName(UnifiedMotionCompileStatus status);
bool unifiedMotionAttemptAllowed(const OfflinePhaseExecutionToken& token);

}  // namespace offline
