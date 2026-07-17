#include "offline_unified_motion.h"

#include "offline_castling_motion.h"
#include "offline_lane_motion.h"
#include "offline_promotion_motion.h"
#include "offline_quiet_motion.h"

#include <utility>

namespace offline {
namespace {

CaptureMotionCompileStatus mapQuietStatus(QuietMotionCompileStatus status) {
  switch (status) {
    case QuietMotionCompileStatus::Success:
      return CaptureMotionCompileStatus::Success;
    case QuietMotionCompileStatus::InvalidPhase:
      return CaptureMotionCompileStatus::InvalidPhase;
    case QuietMotionCompileStatus::UnsupportedMove:
      return CaptureMotionCompileStatus::UnsupportedMove;
    case QuietMotionCompileStatus::UnsupportedRoute:
      return CaptureMotionCompileStatus::UnsupportedRoute;
    case QuietMotionCompileStatus::InvalidOccupancy:
      return CaptureMotionCompileStatus::InvalidOccupancy;
    case QuietMotionCompileStatus::InvalidPath:
      return CaptureMotionCompileStatus::InvalidPath;
  }
  return CaptureMotionCompileStatus::InvalidPhase;
}

CaptureMotionCompileStatus mapLaneStatus(LaneMotionCompileStatus status) {
  switch (status) {
    case LaneMotionCompileStatus::Success:
      return CaptureMotionCompileStatus::Success;
    case LaneMotionCompileStatus::InvalidPhase:
      return CaptureMotionCompileStatus::InvalidPhase;
    case LaneMotionCompileStatus::UnsupportedMove:
      return CaptureMotionCompileStatus::UnsupportedMove;
    case LaneMotionCompileStatus::UnsupportedRoute:
    case LaneMotionCompileStatus::InvalidCoordinate:
      return CaptureMotionCompileStatus::UnsupportedRoute;
    case LaneMotionCompileStatus::InvalidOccupancy:
      return CaptureMotionCompileStatus::InvalidOccupancy;
    case LaneMotionCompileStatus::InvalidPath:
      return CaptureMotionCompileStatus::InvalidPath;
    case LaneMotionCompileStatus::InvalidGraveyard:
      return CaptureMotionCompileStatus::InvalidGraveyard;
  }
  return CaptureMotionCompileStatus::InvalidPhase;
}

CaptureMotionPrimitive convertQuietPrimitive(
    const QuietMotionPrimitive& primitive) {
  CaptureMotionPrimitive converted;
  switch (primitive.kind) {
    case QuietMotionPrimitiveKind::Travel:
      converted.kind = CaptureMotionPrimitiveKind::TravelBoard;
      break;
    case QuietMotionPrimitiveKind::Pickup:
      converted.kind = CaptureMotionPrimitiveKind::Pickup;
      break;
    case QuietMotionPrimitiveKind::Drag:
      converted.kind = CaptureMotionPrimitiveKind::DragBoard;
      break;
    case QuietMotionPrimitiveKind::Drop:
      converted.kind = CaptureMotionPrimitiveKind::Drop;
      break;
    case QuietMotionPrimitiveKind::Verify:
      converted.kind = CaptureMotionPrimitiveKind::Verify;
      break;
  }
  converted.sourceRawIndex = primitive.sourceRawIndex;
  converted.targetRawIndex = primitive.targetRawIndex;
  converted.finalBoardDrop = primitive.finalBoardDrop;
  return converted;
}

CaptureMotionPrimitive convertLanePrimitive(const LaneMotionPrimitive& primitive) {
  CaptureMotionPrimitive converted;
  switch (primitive.kind) {
    case LaneMotionPrimitiveKind::TravelBoard:
      converted.kind = CaptureMotionPrimitiveKind::TravelBoard;
      break;
    case LaneMotionPrimitiveKind::Pickup:
      converted.kind = CaptureMotionPrimitiveKind::Pickup;
      break;
    case LaneMotionPrimitiveKind::DragCoordinate:
      converted.kind = CaptureMotionPrimitiveKind::DragCoordinate;
      break;
    case LaneMotionPrimitiveKind::DragBoard:
      converted.kind = CaptureMotionPrimitiveKind::DragBoard;
      break;
    case LaneMotionPrimitiveKind::Drop:
      converted.kind = CaptureMotionPrimitiveKind::Drop;
      break;
    case LaneMotionPrimitiveKind::Verify:
      converted.kind = CaptureMotionPrimitiveKind::Verify;
      break;
  }
  converted.sourceRawIndex = primitive.sourceRawIndex;
  converted.targetRawIndex = primitive.targetRawIndex;
  converted.targetX = primitive.targetX;
  converted.targetY = primitive.targetY;
  converted.finalBoardDrop = primitive.finalBoardDrop;
  return converted;
}

CaptureMotionProgram normalizeQuiet(
    const OfflinePhaseExecutionRequest& request,
    const QuietMotionProgram& quiet) {
  CaptureMotionProgram program;
  program.status = mapQuietStatus(quiet.status);
  program.token = request.token;
  program.phaseKind = request.phase.kind;
  program.moveUci = request.move.uci;
  program.from = request.phase.from;
  program.to = request.phase.to;
  program.sourceRawIndex = quiet.sourceRawIndex;
  program.targetRawIndex = quiet.targetRawIndex;
  program.routeMode = quiet.routeMode;
  program.routeCost = quiet.routeCost;
  program.rawPathSquares = quiet.rawPathSquares;
  program.compressedPathSquares = quiet.compressedPathSquares;
  if (request.phase.transfer) program.routeTargets = request.phase.transfer->targets;
  program.graveyardSlotKey = request.graveyardSlotKey;
  program.expectedBefore = request.phase.expectedBefore;
  program.expectedAfter = request.phase.expectedAfter;
  program.blockedReason = quiet.blockedReason;
  for (const QuietMotionPrimitive& primitive : quiet.primitives) {
    program.primitives.push_back(convertQuietPrimitive(primitive));
  }
  return program;
}

CaptureMotionProgram normalizeLane(
    const OfflinePhaseExecutionRequest& request,
    const LaneMotionProgram& lane) {
  CaptureMotionProgram program;
  program.status = mapLaneStatus(lane.status);
  program.token = request.token;
  program.phaseKind = request.phase.kind;
  program.moveUci = request.move.uci;
  program.from = request.phase.from;
  program.to = request.phase.to;
  program.sourceRawIndex = lane.sourceRawIndex;
  program.targetRawIndex = lane.targetRawIndex;
  program.routeMode = lane.routeMode;
  program.routeCost = lane.routeCost;
  program.rawPathSquares = lane.rawPathSquares;
  program.compressedPathSquares = lane.compressedPathSquares;
  program.routeTargets = lane.routeTargets;
  program.graveyardSlotKey = request.graveyardSlotKey;
  program.expectedBefore = request.phase.expectedBefore;
  program.expectedAfter = request.phase.expectedAfter;
  program.blockedReason = lane.blockedReason;
  for (const LaneMotionPrimitive& primitive : lane.primitives) {
    program.primitives.push_back(convertLanePrimitive(primitive));
  }
  return program;
}

UnifiedMotionProgram finish(
    UnifiedMotionCompilerKind compiler,
    std::string sourceStatus,
    CaptureMotionProgram program) {
  UnifiedMotionProgram result;
  result.compiler = compiler;
  result.sourceStatus = std::move(sourceStatus);
  result.blockedReason = program.blockedReason;
  result.status = program.success() ? UnifiedMotionCompileStatus::Success
                                    : UnifiedMotionCompileStatus::CompileFailed;
  result.program = std::move(program);
  return result;
}

UnifiedMotionProgram unsupported(
    const OfflinePhaseExecutionRequest& request,
    std::string reason) {
  UnifiedMotionProgram result;
  result.status = UnifiedMotionCompileStatus::UnsupportedRequest;
  result.compiler = UnifiedMotionCompilerKind::Quiet;
  result.sourceStatus = "unsupported_request";
  result.blockedReason = reason;
  result.program.status = CaptureMotionCompileStatus::InvalidPhase;
  result.program.token = request.token;
  result.program.phaseKind = request.phase.kind;
  result.program.moveUci = request.move.uci;
  result.program.from = request.phase.from;
  result.program.to = request.phase.to;
  result.program.expectedBefore = request.phase.expectedBefore;
  result.program.expectedAfter = request.phase.expectedAfter;
  result.program.blockedReason = std::move(reason);
  return result;
}

}  // namespace

UnifiedMotionProgram OfflineUnifiedMotionCompiler::compile(
    const OfflinePhaseExecutionRequest& request) const {
  if (!request.move.promotion.empty()) {
    CaptureMotionProgram program = OfflinePromotionMotionCompiler{}.compile(request);
    return finish(
        UnifiedMotionCompilerKind::Promotion,
        captureMotionCompileStatusName(program.status),
        std::move(program));
  }

  switch (request.phase.kind) {
    case MotionPhaseKind::CastleKing:
    case MotionPhaseKind::CastleRook: {
      CaptureMotionProgram program = OfflineCastlingMotionCompiler{}.compile(request);
      return finish(
          UnifiedMotionCompilerKind::Castling,
          captureMotionCompileStatusName(program.status),
          std::move(program));
    }
    case MotionPhaseKind::CapturedRemoval:
    case MotionPhaseKind::AttackerStage:
    case MotionPhaseKind::AttackerFinal: {
      CaptureMotionProgram program = OfflineCaptureMotionCompiler{}.compile(request);
      return finish(
          UnifiedMotionCompilerKind::Capture,
          captureMotionCompileStatusName(program.status),
          std::move(program));
    }
    case MotionPhaseKind::QuietTransfer:
      break;
  }

  if (request.move.capture || request.move.enPassant || request.move.castling) {
    return unsupported(
        request,
        "A capture, en-passant, or castling move cannot use QuietTransfer dispatch.");
  }
  if (!request.phase.transfer) {
    return unsupported(request, "QuietTransfer requires transfer route metadata.");
  }

  const ExternalRouteMode mode = request.phase.transfer->mode;
  if (mode == ExternalRouteMode::Lane || mode == ExternalRouteMode::LaneBoard) {
    const LaneMotionProgram lane = OfflineLaneMotionCompiler{}.compile(request);
    CaptureMotionProgram program = normalizeLane(request, lane);
    return finish(
        UnifiedMotionCompilerKind::Lane,
        laneMotionCompileStatusName(lane.status),
        std::move(program));
  }

  const QuietMotionProgram quiet = OfflineQuietMotionCompiler{}.compile(request);
  CaptureMotionProgram program = normalizeQuiet(request, quiet);
  return finish(
      UnifiedMotionCompilerKind::Quiet,
      quietMotionCompileStatusName(quiet.status),
      std::move(program));
}

const char* unifiedMotionCompilerKindName(UnifiedMotionCompilerKind kind) {
  switch (kind) {
    case UnifiedMotionCompilerKind::Quiet: return "quiet";
    case UnifiedMotionCompilerKind::Lane: return "lane";
    case UnifiedMotionCompilerKind::Capture: return "capture";
    case UnifiedMotionCompilerKind::Castling: return "castling";
    case UnifiedMotionCompilerKind::Promotion: return "promotion";
  }
  return "quiet";
}

const char* unifiedMotionCompileStatusName(UnifiedMotionCompileStatus status) {
  switch (status) {
    case UnifiedMotionCompileStatus::Success: return "success";
    case UnifiedMotionCompileStatus::UnsupportedRequest: return "unsupported_request";
    case UnifiedMotionCompileStatus::CompileFailed: return "compile_failed";
  }
  return "unsupported_request";
}

bool unifiedMotionAttemptAllowed(const OfflinePhaseExecutionToken& token) {
  return token.attempt >= 1 && token.attempt <= kUnifiedMotionMaximumAttempts;
}

}  // namespace offline
