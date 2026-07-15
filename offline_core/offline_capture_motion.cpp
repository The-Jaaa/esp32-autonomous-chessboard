#include "offline_capture_motion.h"

#include "offline_quiet_motion.h"

#include <cmath>
#include <cstddef>
#include <utility>

namespace offline {
namespace {

CaptureMotionProgram reject(
    const OfflinePhaseExecutionRequest& request,
    CaptureMotionCompileStatus status,
    std::string reason) {
  CaptureMotionProgram program;
  program.status = status;
  program.token = request.token;
  program.phaseKind = request.phase.kind;
  program.moveUci = request.move.uci;
  program.from = request.phase.from;
  program.to = request.phase.to;
  program.graveyardSlotKey = request.graveyardSlotKey;
  program.expectedBefore = request.phase.expectedBefore;
  program.expectedAfter = request.phase.expectedAfter;
  program.blockedReason = std::move(reason);
  return program;
}

bool validSquare(const std::string& square) {
  return square.size() == 2 && square[0] >= 'a' && square[0] <= 'h' &&
         square[1] >= '1' && square[1] <= '8';
}

bool boardOnlyMode(ExternalRouteMode mode) {
  switch (mode) {
    case ExternalRouteMode::Direct:
    case ExternalRouteMode::BoardDirect:
    case ExternalRouteMode::BoardLine:
    case ExternalRouteMode::BoardBuffered:
    case ExternalRouteMode::BoardRelaxed:
      return true;
    case ExternalRouteMode::Lane:
    case ExternalRouteMode::LaneBoard:
    case ExternalRouteMode::GraveyardDirect:
    case ExternalRouteMode::GraveyardBoardPath:
      return false;
  }
  return false;
}

bool graveyardMode(ExternalRouteMode mode) {
  return mode == ExternalRouteMode::GraveyardDirect ||
         mode == ExternalRouteMode::GraveyardBoardPath;
}

bool exactRemovalTransition(
    const Occupancy& before,
    const Occupancy& after,
    int source) {
  if (source < 0 || !before[static_cast<std::size_t>(source)]) return false;
  Occupancy expected = before;
  expected[static_cast<std::size_t>(source)] = false;
  return expected == after;
}

bool pathSquaresValidAndClear(
    const std::vector<std::string>& path,
    const std::string& source,
    const Occupancy& occupancy) {
  if (path.empty() || path.front() != source) return false;
  for (std::size_t index = 0; index < path.size(); ++index) {
    const int rawIndex = squareToRawIndex(path[index]);
    if (!validSquare(path[index]) || rawIndex < 0) return false;
    if (index > 0 && occupancy[static_cast<std::size_t>(rawIndex)]) return false;
  }
  return true;
}

bool compressedTargetsMatch(
    const GraveyardRouteCandidate& graveyard,
    const std::string& source) {
  if (graveyard.compressedPathSquares.empty() ||
      graveyard.compressedPathSquares.front() != source ||
      graveyard.targets.empty()) {
    return false;
  }

  const ExternalRouteTarget& finalTarget = graveyard.targets.back();
  if (finalTarget.type != ExternalTargetType::Coordinate ||
      !std::isfinite(finalTarget.x) || !std::isfinite(finalTarget.y) ||
      finalTarget.label != graveyard.slot.label ||
      finalTarget.lane != graveyard.slot.lane ||
      finalTarget.rank != graveyard.slot.rank ||
      finalTarget.x != graveyard.slot.x || finalTarget.y != graveyard.slot.y) {
    return false;
  }

  if (graveyard.targets.size() != graveyard.compressedPathSquares.size()) {
    return false;
  }
  for (std::size_t index = 0; index + 1 < graveyard.targets.size(); ++index) {
    const ExternalRouteTarget& target = graveyard.targets[index];
    const std::string& expectedSquare = graveyard.compressedPathSquares[index + 1];
    if (target.type != ExternalTargetType::Square ||
        target.square != expectedSquare ||
        target.rawIndex != squareToRawIndex(expectedSquare)) {
      return false;
    }
  }
  return true;
}

CaptureMotionPrimitive primitive(
    CaptureMotionPrimitiveKind kind,
    int sourceRawIndex = -1,
    int targetRawIndex = -1,
    double targetX = 0.0,
    double targetY = 0.0,
    bool finalBoardDrop = false) {
  CaptureMotionPrimitive result;
  result.kind = kind;
  result.sourceRawIndex = sourceRawIndex;
  result.targetRawIndex = targetRawIndex;
  result.targetX = targetX;
  result.targetY = targetY;
  result.finalBoardDrop = finalBoardDrop;
  return result;
}

CaptureMotionPrimitive convertQuietPrimitive(
    const QuietMotionPrimitive& quiet) {
  CaptureMotionPrimitiveKind kind = CaptureMotionPrimitiveKind::TravelBoard;
  switch (quiet.kind) {
    case QuietMotionPrimitiveKind::Travel:
      kind = CaptureMotionPrimitiveKind::TravelBoard;
      break;
    case QuietMotionPrimitiveKind::Pickup:
      kind = CaptureMotionPrimitiveKind::Pickup;
      break;
    case QuietMotionPrimitiveKind::Drag:
      kind = CaptureMotionPrimitiveKind::DragBoard;
      break;
    case QuietMotionPrimitiveKind::Drop:
      kind = CaptureMotionPrimitiveKind::Drop;
      break;
    case QuietMotionPrimitiveKind::Verify:
      kind = CaptureMotionPrimitiveKind::Verify;
      break;
  }
  return primitive(
      kind,
      quiet.sourceRawIndex,
      quiet.targetRawIndex,
      0.0,
      0.0,
      quiet.finalBoardDrop);
}

CaptureMotionProgram compileAttackerFinal(
    const OfflinePhaseExecutionRequest& request) {
  if (!request.move.capture || request.move.castling || request.move.enPassant ||
      !request.move.promotion.empty() ||
      request.move.uci != request.move.from + request.move.to ||
      request.move.from != request.phase.from ||
      request.move.to != request.phase.to ||
      request.move.capturedSquare != request.phase.to) {
    return reject(
        request,
        CaptureMotionCompileStatus::UnsupportedMove,
        "AttackerFinal must describe one ordinary non-promotion capture.");
  }
  if (request.graveyardSlotKey.empty() ||
      request.graveyardState != GraveyardSlotState::Occupied ||
      request.phase.graveyard || !request.phase.transfer ||
      !boardOnlyMode(request.phase.transfer->mode)) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidGraveyard,
        "AttackerFinal requires an occupied graveyard slot and a board-only route.");
  }

  OfflinePhaseExecutionRequest quietRequest = request;
  quietRequest.phase.kind = MotionPhaseKind::QuietTransfer;
  quietRequest.move.capture = false;
  quietRequest.move.capturedPiece.clear();
  quietRequest.move.capturedSquare.clear();
  quietRequest.graveyardSlotKey.clear();
  quietRequest.graveyardState = GraveyardSlotState::Free;
  const QuietMotionProgram quiet = OfflineQuietMotionCompiler{}.compile(quietRequest);
  if (!quiet.success()) {
    CaptureMotionCompileStatus status = CaptureMotionCompileStatus::InvalidPath;
    if (quiet.status == QuietMotionCompileStatus::UnsupportedRoute) {
      status = CaptureMotionCompileStatus::UnsupportedRoute;
    } else if (quiet.status == QuietMotionCompileStatus::InvalidOccupancy) {
      status = CaptureMotionCompileStatus::InvalidOccupancy;
    } else if (quiet.status == QuietMotionCompileStatus::UnsupportedMove) {
      status = CaptureMotionCompileStatus::UnsupportedMove;
    }
    return reject(request, status, quiet.blockedReason);
  }

  CaptureMotionProgram program;
  program.status = CaptureMotionCompileStatus::Success;
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
  program.graveyardSlotKey = request.graveyardSlotKey;
  program.expectedBefore = request.phase.expectedBefore;
  program.expectedAfter = request.phase.expectedAfter;
  for (const QuietMotionPrimitive& item : quiet.primitives) {
    program.primitives.push_back(convertQuietPrimitive(item));
  }
  return program;
}

CaptureMotionProgram compileCapturedRemoval(
    const OfflinePhaseExecutionRequest& request) {
  if (!request.move.capture || request.move.castling || request.move.enPassant ||
      !request.move.promotion.empty() ||
      request.move.capturedSquare != request.phase.from) {
    return reject(
        request,
        CaptureMotionCompileStatus::UnsupportedMove,
        "CapturedRemoval must remove the victim of one ordinary capture.");
  }
  if (request.phase.transfer || !request.phase.graveyard ||
      request.graveyardSlotKey.empty() ||
      request.graveyardState != GraveyardSlotState::Pending) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidGraveyard,
        "CapturedRemoval requires one pending graveyard proposal.");
  }

  const GraveyardRouteCandidate& graveyard = *request.phase.graveyard;
  const std::string candidateKey = externalSlotKey(graveyard.slot);
  if (candidateKey.empty() || candidateKey != request.graveyardSlotKey ||
      request.phase.to != graveyard.slot.label ||
      !graveyardMode(graveyard.mode) || !std::isfinite(graveyard.slot.x) ||
      !std::isfinite(graveyard.slot.y)) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidGraveyard,
        "CapturedRemoval graveyard metadata does not match the pending slot.");
  }

  const int source = squareToRawIndex(request.phase.from);
  if (!exactRemovalTransition(
          request.phase.expectedBefore, request.phase.expectedAfter, source)) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidOccupancy,
        "CapturedRemoval must clear exactly the victim square.");
  }
  if (!pathSquaresValidAndClear(
          graveyard.rawPathSquares,
          request.phase.from,
          request.phase.expectedBefore) ||
      !pathSquaresValidAndClear(
          graveyard.compressedPathSquares,
          request.phase.from,
          request.phase.expectedBefore) ||
      !compressedTargetsMatch(graveyard, request.phase.from)) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidPath,
        "CapturedRemoval has a malformed, occupied, or mismatched graveyard route.");
  }

  CaptureMotionProgram program;
  program.status = CaptureMotionCompileStatus::Success;
  program.token = request.token;
  program.phaseKind = request.phase.kind;
  program.moveUci = request.move.uci;
  program.from = request.phase.from;
  program.to = request.phase.to;
  program.sourceRawIndex = source;
  program.routeMode = graveyard.mode;
  program.routeCost = graveyard.routeCost;
  program.rawPathSquares = graveyard.rawPathSquares;
  program.compressedPathSquares = graveyard.compressedPathSquares;
  program.graveyardSlotKey = request.graveyardSlotKey;
  program.graveyardLabel = graveyard.slot.label;
  program.graveyardX = graveyard.slot.x;
  program.graveyardY = graveyard.slot.y;
  program.expectedBefore = request.phase.expectedBefore;
  program.expectedAfter = request.phase.expectedAfter;
  program.primitives.push_back(primitive(
      CaptureMotionPrimitiveKind::TravelBoard, -1, source));
  program.primitives.push_back(primitive(
      CaptureMotionPrimitiveKind::Pickup, source));

  int dragSource = source;
  for (std::size_t index = 0; index + 1 < graveyard.targets.size(); ++index) {
    const int dragTarget = graveyard.targets[index].rawIndex;
    program.primitives.push_back(primitive(
        CaptureMotionPrimitiveKind::DragBoard, dragSource, dragTarget));
    dragSource = dragTarget;
  }
  program.primitives.push_back(primitive(
      CaptureMotionPrimitiveKind::DragCoordinate,
      dragSource,
      -1,
      graveyard.slot.x,
      graveyard.slot.y));
  program.primitives.push_back(primitive(CaptureMotionPrimitiveKind::Drop));
  program.primitives.push_back(primitive(
      CaptureMotionPrimitiveKind::Verify, source));
  return program;
}

}  // namespace

CaptureMotionProgram OfflineCaptureMotionCompiler::compile(
    const OfflinePhaseExecutionRequest& request) const {
  switch (request.phase.kind) {
    case MotionPhaseKind::CapturedRemoval:
      return compileCapturedRemoval(request);
    case MotionPhaseKind::AttackerFinal:
      return compileAttackerFinal(request);
    case MotionPhaseKind::QuietTransfer:
    case MotionPhaseKind::AttackerStage:
    case MotionPhaseKind::CastleKing:
    case MotionPhaseKind::CastleRook:
      return reject(
          request,
          CaptureMotionCompileStatus::InvalidPhase,
          "Only CapturedRemoval and AttackerFinal phases are supported.");
  }
  return reject(
      request,
      CaptureMotionCompileStatus::InvalidPhase,
      "The capture phase kind is invalid.");
}

const char* captureMotionCompileStatusName(CaptureMotionCompileStatus status) {
  switch (status) {
    case CaptureMotionCompileStatus::Success:
      return "success";
    case CaptureMotionCompileStatus::InvalidPhase:
      return "invalid_phase";
    case CaptureMotionCompileStatus::UnsupportedMove:
      return "unsupported_move";
    case CaptureMotionCompileStatus::UnsupportedRoute:
      return "unsupported_route";
    case CaptureMotionCompileStatus::InvalidOccupancy:
      return "invalid_occupancy";
    case CaptureMotionCompileStatus::InvalidPath:
      return "invalid_path";
    case CaptureMotionCompileStatus::InvalidGraveyard:
      return "invalid_graveyard";
  }
  return "invalid_phase";
}

const char* captureMotionPrimitiveKindName(CaptureMotionPrimitiveKind kind) {
  switch (kind) {
    case CaptureMotionPrimitiveKind::TravelBoard:
      return "travel-board";
    case CaptureMotionPrimitiveKind::Pickup:
      return "pickup";
    case CaptureMotionPrimitiveKind::DragBoard:
      return "drag-board";
    case CaptureMotionPrimitiveKind::DragCoordinate:
      return "drag-coordinate";
    case CaptureMotionPrimitiveKind::Drop:
      return "drop";
    case CaptureMotionPrimitiveKind::Verify:
      return "verify";
  }
  return "travel-board";
}

bool captureMotionAttemptAllowed(const OfflinePhaseExecutionToken& token) {
  return token.attempt >= 1 && token.attempt <= kCaptureMotionMaximumAttempts;
}

}  // namespace offline
