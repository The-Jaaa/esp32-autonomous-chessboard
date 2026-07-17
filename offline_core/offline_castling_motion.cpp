#include "offline_castling_motion.h"

#include "offline_lane_motion.h"
#include "offline_quiet_motion.h"

#include <cctype>
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

CaptureMotionPrimitive convertLanePrimitive(
    const LaneMotionPrimitive& primitive) {
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

OfflinePhaseExecutionRequest asQuietTransfer(
    const OfflinePhaseExecutionRequest& request) {
  OfflinePhaseExecutionRequest quiet = request;
  quiet.phase.kind = MotionPhaseKind::QuietTransfer;
  quiet.move.uci = request.phase.from + request.phase.to;
  quiet.move.from = request.phase.from;
  quiet.move.to = request.phase.to;
  quiet.move.capture = false;
  quiet.move.castling = false;
  quiet.move.enPassant = false;
  quiet.move.promotion.clear();
  quiet.move.capturedPiece.clear();
  quiet.move.capturedSquare.clear();
  quiet.move.rookFrom.clear();
  quiet.move.rookTo.clear();
  quiet.graveyardSlotKey.clear();
  quiet.graveyardState = GraveyardSlotState::Free;
  return quiet;
}

CaptureMotionProgram baseProgram(
    const OfflinePhaseExecutionRequest& request) {
  CaptureMotionProgram program;
  program.status = CaptureMotionCompileStatus::Success;
  program.token = request.token;
  program.phaseKind = request.phase.kind;
  program.moveUci = request.move.uci;
  program.from = request.phase.from;
  program.to = request.phase.to;
  program.expectedBefore = request.phase.expectedBefore;
  program.expectedAfter = request.phase.expectedAfter;
  return program;
}

CaptureMotionProgram compileBoard(
    const OfflinePhaseExecutionRequest& request) {
  const QuietMotionProgram quiet =
      OfflineQuietMotionCompiler{}.compile(asQuietTransfer(request));
  if (!quiet.success()) {
    return reject(request, mapQuietStatus(quiet.status), quiet.blockedReason);
  }

  CaptureMotionProgram program = baseProgram(request);
  program.sourceRawIndex = quiet.sourceRawIndex;
  program.targetRawIndex = quiet.targetRawIndex;
  program.routeMode = quiet.routeMode;
  program.routeCost = quiet.routeCost;
  program.rawPathSquares = quiet.rawPathSquares;
  program.compressedPathSquares = quiet.compressedPathSquares;
  program.routeTargets = request.phase.transfer->targets;
  for (const QuietMotionPrimitive& primitive : quiet.primitives) {
    program.primitives.push_back(convertQuietPrimitive(primitive));
  }
  return program;
}

CaptureMotionProgram compileLane(
    const OfflinePhaseExecutionRequest& request) {
  const LaneMotionProgram lane =
      OfflineLaneMotionCompiler{}.compile(asQuietTransfer(request));
  if (!lane.success()) {
    return reject(request, mapLaneStatus(lane.status), lane.blockedReason);
  }

  CaptureMotionProgram program = baseProgram(request);
  program.sourceRawIndex = lane.sourceRawIndex;
  program.targetRawIndex = lane.targetRawIndex;
  program.routeMode = lane.routeMode;
  program.routeCost = lane.routeCost;
  program.rawPathSquares = lane.rawPathSquares;
  program.compressedPathSquares = lane.compressedPathSquares;
  program.routeTargets = lane.routeTargets;
  for (const LaneMotionPrimitive& primitive : lane.primitives) {
    program.primitives.push_back(convertLanePrimitive(primitive));
  }
  return program;
}

bool supportedCastlingMove(const MoveInfo& move) {
  if (!move.castling || move.capture || move.enPassant ||
      !move.promotion.empty() || move.uci != move.from + move.to ||
      !validSquare(move.from) || !validSquare(move.to) ||
      !validSquare(move.rookFrom) || !validSquare(move.rookTo) ||
      move.piece.empty() ||
      std::tolower(static_cast<unsigned char>(move.piece.front())) != 'k') {
    return false;
  }
  const int rank = move.from[1] - '0';
  const bool kingSide = move.from[0] == 'e' && move.to[0] == 'g' &&
                        move.rookFrom[0] == 'h' && move.rookTo[0] == 'f';
  const bool queenSide = move.from[0] == 'e' && move.to[0] == 'c' &&
                         move.rookFrom[0] == 'a' && move.rookTo[0] == 'd';
  return (rank == 1 || rank == 8) && move.to[1] == move.from[1] &&
         move.rookFrom[1] == move.from[1] &&
         move.rookTo[1] == move.from[1] && (kingSide || queenSide);
}

}  // namespace

CaptureMotionProgram OfflineCastlingMotionCompiler::compile(
    const OfflinePhaseExecutionRequest& request) const {
  if (!supportedCastlingMove(request.move)) {
    return reject(
        request,
        CaptureMotionCompileStatus::UnsupportedMove,
        "Castling motion requires complete legal king and rook metadata.");
  }
  if (request.phase.kind != MotionPhaseKind::CastleKing &&
      request.phase.kind != MotionPhaseKind::CastleRook) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidPhase,
        "Only CastleKing and CastleRook phases are supported.");
  }
  const bool kingPhase = request.phase.kind == MotionPhaseKind::CastleKing;
  const std::size_t requiredPhaseIndex = kingPhase ? 0U : 1U;
  const std::string& expectedFrom = kingPhase ? request.move.from : request.move.rookFrom;
  const std::string& expectedTo = kingPhase ? request.move.to : request.move.rookTo;
  if (request.token.phaseIndex != requiredPhaseIndex ||
      request.phase.from != expectedFrom || request.phase.to != expectedTo) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidPhase,
        kingPhase
            ? "CastleKing must be phase zero and move the castling king."
            : "CastleRook must be phase one and move the castling rook.");
  }
  if (!request.graveyardSlotKey.empty() ||
      request.graveyardState != GraveyardSlotState::Free) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidGraveyard,
        "Castling cannot reserve or occupy a graveyard slot.");
  }
  if (request.phase.graveyard || !request.phase.transfer ||
      !request.phase.transfer->success()) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidPhase,
        "A castling phase requires one successful transfer route.");
  }

  const ExternalRouteMode mode = request.phase.transfer->mode;
  if (mode == ExternalRouteMode::Lane || mode == ExternalRouteMode::LaneBoard) {
    return compileLane(request);
  }
  if (boardOnlyMode(mode)) return compileBoard(request);
  return reject(
      request,
      CaptureMotionCompileStatus::UnsupportedRoute,
      "Castling supports board, Lane, and LaneBoard routes only.");
}

bool castlingMotionAttemptAllowed(const OfflinePhaseExecutionToken& token) {
  return token.attempt >= 1 && token.attempt <= kCastlingMotionMaximumAttempts;
}

}  // namespace offline
