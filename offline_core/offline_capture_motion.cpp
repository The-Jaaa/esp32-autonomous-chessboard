#include "offline_capture_motion.h"

#include "offline_lane_motion.h"
#include "offline_quiet_motion.h"

#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdlib>
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

CaptureMotionPrimitive convertLanePrimitive(
    const LaneMotionPrimitive& lane) {
  CaptureMotionPrimitiveKind kind = CaptureMotionPrimitiveKind::TravelBoard;
  switch (lane.kind) {
    case LaneMotionPrimitiveKind::TravelBoard:
      kind = CaptureMotionPrimitiveKind::TravelBoard;
      break;
    case LaneMotionPrimitiveKind::Pickup:
      kind = CaptureMotionPrimitiveKind::Pickup;
      break;
    case LaneMotionPrimitiveKind::DragCoordinate:
      kind = CaptureMotionPrimitiveKind::DragCoordinate;
      break;
    case LaneMotionPrimitiveKind::DragBoard:
      kind = CaptureMotionPrimitiveKind::DragBoard;
      break;
    case LaneMotionPrimitiveKind::Drop:
      kind = CaptureMotionPrimitiveKind::Drop;
      break;
    case LaneMotionPrimitiveKind::Verify:
      kind = CaptureMotionPrimitiveKind::Verify;
      break;
  }
  return primitive(
      kind,
      lane.sourceRawIndex,
      lane.targetRawIndex,
      lane.targetX,
      lane.targetY,
      lane.finalBoardDrop);
}

bool supportedCapture(const MoveInfo& move) {
  if (!move.capture || move.castling || !move.promotion.empty() ||
      move.uci != move.from + move.to || !validSquare(move.from) ||
      !validSquare(move.to) || !validSquare(move.capturedSquare)) {
    return false;
  }
  if (!move.enPassant) return move.capturedSquare == move.to;
  if (move.piece.empty() ||
      std::tolower(static_cast<unsigned char>(move.piece.front())) != 'p') {
    return false;
  }
  return move.capturedSquare != move.to &&
         move.capturedSquare.front() == move.to.front() &&
         move.capturedSquare.back() == move.from.back() &&
         std::abs(move.to.front() - move.from.front()) == 1 &&
         std::abs(move.to.back() - move.from.back()) == 1;
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

CaptureMotionProgram compileAttackerLaneTransfer(
    const OfflinePhaseExecutionRequest& request) {
  const LaneMotionProgram lane = OfflineLaneMotionCompiler{}.compile(request);
  if (!lane.success()) {
    return reject(request, mapLaneStatus(lane.status), lane.blockedReason);
  }

  CaptureMotionProgram program;
  program.status = CaptureMotionCompileStatus::Success;
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
  for (const LaneMotionPrimitive& item : lane.primitives) {
    program.primitives.push_back(convertLanePrimitive(item));
  }
  return program;
}

CaptureMotionProgram compileAttackerTransfer(
    const OfflinePhaseExecutionRequest& request) {
  if (request.phase.graveyard || !request.phase.transfer) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidPhase,
        "The attacker phase requires one transfer route.");
  }
  if (request.phase.transfer->mode == ExternalRouteMode::Lane ||
      request.phase.transfer->mode == ExternalRouteMode::LaneBoard) {
    return compileAttackerLaneTransfer(request);
  }
  if (!boardOnlyMode(request.phase.transfer->mode)) {
    return reject(
        request,
        CaptureMotionCompileStatus::UnsupportedRoute,
        "The attacker phase route is not a supported board or lane transfer.");
  }

  OfflinePhaseExecutionRequest quietRequest = request;
  quietRequest.phase.kind = MotionPhaseKind::QuietTransfer;
  quietRequest.move.uci = request.phase.from + request.phase.to;
  quietRequest.move.from = request.phase.from;
  quietRequest.move.to = request.phase.to;
  quietRequest.move.capture = false;
  quietRequest.move.castling = false;
  quietRequest.move.enPassant = false;
  quietRequest.move.promotion.clear();
  quietRequest.move.capturedPiece.clear();
  quietRequest.move.capturedSquare.clear();
  quietRequest.move.rookFrom.clear();
  quietRequest.move.rookTo.clear();
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
    } else if (quiet.status == QuietMotionCompileStatus::InvalidPhase) {
      status = CaptureMotionCompileStatus::InvalidPhase;
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
  program.routeTargets = request.phase.transfer->targets;
  program.graveyardSlotKey = request.graveyardSlotKey;
  program.expectedBefore = request.phase.expectedBefore;
  program.expectedAfter = request.phase.expectedAfter;
  for (const QuietMotionPrimitive& item : quiet.primitives) {
    program.primitives.push_back(convertQuietPrimitive(item));
  }
  return program;
}

CaptureMotionProgram compileAttackerStage(
    const OfflinePhaseExecutionRequest& request) {
  if (!supportedCapture(request.move) ||
      request.phase.from != request.move.from ||
      request.phase.to == request.move.to ||
      request.phase.to == request.move.capturedSquare) {
    return reject(
        request,
        CaptureMotionCompileStatus::UnsupportedMove,
        "AttackerStage must move a supported capture attacker to a distinct staging square.");
  }
  if (request.graveyardSlotKey.empty() ||
      request.graveyardState != GraveyardSlotState::Pending) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidGraveyard,
        "AttackerStage requires the capture graveyard slot to remain pending.");
  }
  return compileAttackerTransfer(request);
}

CaptureMotionProgram compileAttackerFinal(
    const OfflinePhaseExecutionRequest& request) {
  if (!supportedCapture(request.move) ||
      request.move.to != request.phase.to ||
      request.phase.from == request.phase.to) {
    return reject(
        request,
        CaptureMotionCompileStatus::UnsupportedMove,
        "AttackerFinal must describe one supported non-promotion capture.");
  }
  if (request.graveyardSlotKey.empty() ||
      request.graveyardState != GraveyardSlotState::Occupied) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidGraveyard,
        "AttackerFinal requires an occupied graveyard slot.");
  }
  return compileAttackerTransfer(request);
}

CaptureMotionProgram compileCapturedRemoval(
    const OfflinePhaseExecutionRequest& request) {
  if (!supportedCapture(request.move) ||
      request.move.capturedSquare != request.phase.from) {
    return reject(
        request,
        CaptureMotionCompileStatus::UnsupportedMove,
        "CapturedRemoval must remove the victim from the move's captured square.");
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
  program.routeTargets = graveyard.targets;
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
    case MotionPhaseKind::AttackerStage:
      return compileAttackerStage(request);
    case MotionPhaseKind::QuietTransfer:
    case MotionPhaseKind::CastleKing:
    case MotionPhaseKind::CastleRook:
    case MotionPhaseKind::TemporaryClearanceStage:
    case MotionPhaseKind::TemporaryClearanceRestore:
      return reject(
          request,
          CaptureMotionCompileStatus::InvalidPhase,
          "Only staged or final capture attacker phases and captured removal are supported.");
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
