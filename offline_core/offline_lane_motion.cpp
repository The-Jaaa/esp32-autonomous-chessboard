#include "offline_lane_motion.h"

#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <utility>

namespace offline {
namespace {

LaneMotionProgram reject(
    const OfflinePhaseExecutionRequest& request,
    LaneMotionCompileStatus status,
    std::string reason) {
  LaneMotionProgram program;
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

bool exactTransfer(
    const Occupancy& before,
    const Occupancy& after,
    int source,
    int target) {
  if (source < 0 || target < 0 || source == target ||
      !before[static_cast<std::size_t>(source)] ||
      before[static_cast<std::size_t>(target)]) {
    return false;
  }
  Occupancy expected = before;
  expected[static_cast<std::size_t>(source)] = false;
  expected[static_cast<std::size_t>(target)] = true;
  return expected == after;
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

LaneMotionCompileStatus validatePhaseMove(
    const OfflinePhaseExecutionRequest& request,
    std::string& reason) {
  if (request.move.castling || !request.move.promotion.empty()) {
    reason = "Castling and promotion lane motion are deferred.";
    return LaneMotionCompileStatus::UnsupportedMove;
  }

  switch (request.phase.kind) {
    case MotionPhaseKind::QuietTransfer:
      if (request.move.capture || request.move.enPassant ||
          request.move.uci != request.phase.from + request.phase.to ||
          request.move.from != request.phase.from || request.move.to != request.phase.to) {
        reason = "Quiet lane motion must describe one ordinary quiet chess move.";
        return LaneMotionCompileStatus::UnsupportedMove;
      }
      if (!request.graveyardSlotKey.empty() ||
          request.graveyardState != GraveyardSlotState::Free) {
        reason = "Quiet lane motion cannot own a graveyard slot.";
        return LaneMotionCompileStatus::InvalidGraveyard;
      }
      return LaneMotionCompileStatus::Success;
    case MotionPhaseKind::AttackerStage:
      if (!supportedCapture(request.move) ||
          request.phase.from != request.move.from ||
          request.phase.to == request.move.to || request.phase.to == request.move.capturedSquare) {
        reason = "AttackerStage must move a supported attacker to a distinct staging square.";
        return LaneMotionCompileStatus::UnsupportedMove;
      }
      if (request.graveyardSlotKey.empty() ||
          request.graveyardState != GraveyardSlotState::Pending) {
        reason = "AttackerStage requires its capture slot to remain pending.";
        return LaneMotionCompileStatus::InvalidGraveyard;
      }
      return LaneMotionCompileStatus::Success;
    case MotionPhaseKind::AttackerFinal:
      if (!supportedCapture(request.move) ||
          request.phase.to != request.move.to ||
          request.phase.from == request.phase.to) {
        reason = "AttackerFinal must finish one supported capture.";
        return LaneMotionCompileStatus::UnsupportedMove;
      }
      if (request.graveyardSlotKey.empty() ||
          request.graveyardState != GraveyardSlotState::Occupied) {
        reason = "AttackerFinal requires an occupied capture slot.";
        return LaneMotionCompileStatus::InvalidGraveyard;
      }
      return LaneMotionCompileStatus::Success;
    case MotionPhaseKind::CapturedRemoval:
    case MotionPhaseKind::CastleKing:
    case MotionPhaseKind::CastleRook:
    case MotionPhaseKind::TemporaryClearanceStage:
    case MotionPhaseKind::TemporaryClearanceRestore:
      reason = "Only quiet and supported attacker transfer phases support lane motion.";
      return LaneMotionCompileStatus::InvalidPhase;
  }
  reason = "The lane phase kind is invalid.";
  return LaneMotionCompileStatus::InvalidPhase;
}

bool pathEndpointsMatch(
    const std::vector<std::string>& path,
    const std::string& from,
    const std::string& to) {
  if (path.size() < 2 || path.front() != from || path.back() != to) return false;
  for (const std::string& square : path) {
    if (!validSquare(square) || squareToRawIndex(square) < 0) return false;
  }
  return true;
}

int fileIndex(const std::string& square) {
  return validSquare(square) ? square[0] - 'a' : -1;
}

int rankIndex(const std::string& square) {
  return validSquare(square) ? square[1] - '1' : -1;
}

std::vector<std::string> expandCompressedBoardPath(
    const std::vector<std::string>& compressed) {
  if (compressed.empty()) return {};
  std::vector<std::string> expanded{compressed.front()};
  for (std::size_t index = 1; index < compressed.size(); ++index) {
    int file = fileIndex(compressed[index - 1]);
    int rank = rankIndex(compressed[index - 1]);
    const int targetFile = fileIndex(compressed[index]);
    const int targetRank = rankIndex(compressed[index]);
    const int fileDelta = targetFile - file;
    const int rankDelta = targetRank - rank;
    const int fileStep = (fileDelta > 0) - (fileDelta < 0);
    const int rankStep = (rankDelta > 0) - (rankDelta < 0);
    if ((fileDelta != 0 && rankDelta != 0 &&
         std::abs(fileDelta) != std::abs(rankDelta)) ||
        (fileDelta == 0 && rankDelta == 0)) {
      return {};
    }
    while (file != targetFile || rank != targetRank) {
      file += fileStep;
      rank += rankStep;
      expanded.push_back(
          std::string{static_cast<char>('a' + file), static_cast<char>('1' + rank)});
    }
  }
  return expanded;
}

LaneMotionPrimitive primitive(
    LaneMotionPrimitiveKind kind,
    int source = -1,
    int target = -1,
    double x = 0.0,
    double y = 0.0,
    bool finalBoardDrop = false) {
  LaneMotionPrimitive result;
  result.kind = kind;
  result.sourceRawIndex = source;
  result.targetRawIndex = target;
  result.targetX = x;
  result.targetY = y;
  result.finalBoardDrop = finalBoardDrop;
  return result;
}

}  // namespace

LaneMotionProgram OfflineLaneMotionCompiler::compile(
    const OfflinePhaseExecutionRequest& request) const {
  if (request.phase.graveyard || !request.phase.transfer ||
      !request.phase.transfer->success()) {
    return reject(
        request,
        LaneMotionCompileStatus::InvalidPhase,
        "Lane motion requires one successful transfer route.");
  }
  const ExternalTransferResult& transfer = *request.phase.transfer;
  if (transfer.mode != ExternalRouteMode::Lane &&
      transfer.mode != ExternalRouteMode::LaneBoard) {
    return reject(
        request,
        LaneMotionCompileStatus::UnsupportedRoute,
        "The transfer is not a Lane or LaneBoard route.");
  }

  std::string moveReason;
  const LaneMotionCompileStatus moveStatus = validatePhaseMove(request, moveReason);
  if (moveStatus != LaneMotionCompileStatus::Success) {
    return reject(request, moveStatus, std::move(moveReason));
  }
  if (!validSquare(request.phase.from) || !validSquare(request.phase.to) ||
      request.phase.from == request.phase.to) {
    return reject(
        request,
        LaneMotionCompileStatus::InvalidPhase,
        "Source and destination must be distinct board squares.");
  }

  const int source = squareToRawIndex(request.phase.from);
  const int target = squareToRawIndex(request.phase.to);
  if (!exactTransfer(
          request.phase.expectedBefore, request.phase.expectedAfter, source, target)) {
    return reject(
        request,
        LaneMotionCompileStatus::InvalidOccupancy,
        "Lane occupancy must move exactly one piece from source to destination.");
  }
  if (!pathEndpointsMatch(
          transfer.rawPathSquares, request.phase.from, request.phase.to) ||
      !pathEndpointsMatch(
          transfer.compressedPathSquares, request.phase.from, request.phase.to)) {
    return reject(
        request,
        LaneMotionCompileStatus::InvalidPath,
        "Lane route paths do not match the phase endpoints.");
  }

  bool sawCoordinate = false;
  bool sawBoardTarget = false;
  char lane = '\0';
  std::vector<std::string> boardTargets;
  for (const ExternalRouteTarget& routeTarget : transfer.targets) {
    if (routeTarget.type == ExternalTargetType::Coordinate) {
      if (sawBoardTarget || !std::isfinite(routeTarget.x) ||
          !std::isfinite(routeTarget.y) || routeTarget.role != "lane" ||
          (routeTarget.lane != 'Z' && routeTarget.lane != 'I') ||
          routeTarget.rank < 1 || routeTarget.rank > 8) {
        return reject(
            request,
            std::isfinite(routeTarget.x) && std::isfinite(routeTarget.y)
                ? LaneMotionCompileStatus::InvalidPath
                : LaneMotionCompileStatus::InvalidCoordinate,
            "Lane coordinates must be finite, ordered, and carry valid lane metadata.");
      }
      if (lane != '\0' && routeTarget.lane != lane) {
        return reject(
            request,
            LaneMotionCompileStatus::UnsupportedRoute,
            "A lane segment cannot cross directly between Z and I.");
      }
      lane = routeTarget.lane;
      sawCoordinate = true;
      continue;
    }

    sawBoardTarget = true;
    if (!validSquare(routeTarget.square) ||
        routeTarget.rawIndex != squareToRawIndex(routeTarget.square)) {
      return reject(
          request,
          LaneMotionCompileStatus::InvalidPath,
          "Every lane re-entry target must be a matching board square.");
    }
    const int rawIndex = routeTarget.rawIndex;
    if (request.phase.expectedBefore[static_cast<std::size_t>(rawIndex)] &&
        rawIndex != target) {
      return reject(
          request,
          LaneMotionCompileStatus::InvalidPath,
          "A lane re-entry waypoint is occupied.");
    }
    boardTargets.push_back(routeTarget.square);
  }

  if (!sawCoordinate || boardTargets.empty() || boardTargets.back() != request.phase.to) {
    return reject(
        request,
        LaneMotionCompileStatus::InvalidPath,
        "Lane targets must contain external coordinates followed by the destination.");
  }
  const std::vector<std::string> expectedBoardTargets(
      transfer.compressedPathSquares.begin() + 1,
      transfer.compressedPathSquares.end());
  if (boardTargets != expectedBoardTargets) {
    return reject(
        request,
        LaneMotionCompileStatus::InvalidPath,
        "Board targets do not match the compressed lane re-entry path.");
  }
  if (transfer.mode == ExternalRouteMode::Lane) {
    if (transfer.rawPathSquares != std::vector<std::string>{request.phase.from, request.phase.to} ||
        transfer.compressedPathSquares != transfer.rawPathSquares || boardTargets.size() != 1) {
      return reject(
          request,
          LaneMotionCompileStatus::InvalidPath,
          "Direct Lane motion must re-enter only at its destination.");
    }
  } else {
    const std::vector<std::string> rawBoardPath(
        transfer.rawPathSquares.begin() + 1, transfer.rawPathSquares.end());
    if (expandCompressedBoardPath(boardTargets) != rawBoardPath) {
      return reject(
          request,
          LaneMotionCompileStatus::InvalidPath,
          "LaneBoard waypoints do not reconstruct the board re-entry path.");
    }
    for (const std::string& square : rawBoardPath) {
      const int rawIndex = squareToRawIndex(square);
      if (rawIndex < 0 ||
          request.phase.expectedBefore[static_cast<std::size_t>(rawIndex)]) {
        return reject(
            request,
            LaneMotionCompileStatus::InvalidPath,
            "LaneBoard re-entry crosses an occupied board square.");
      }
    }
  }

  LaneMotionProgram program;
  program.status = LaneMotionCompileStatus::Success;
  program.token = request.token;
  program.phaseKind = request.phase.kind;
  program.moveUci = request.move.uci;
  program.from = request.phase.from;
  program.to = request.phase.to;
  program.sourceRawIndex = source;
  program.targetRawIndex = target;
  program.routeMode = transfer.mode;
  program.routeCost = transfer.routeCost;
  program.rawPathSquares = transfer.rawPathSquares;
  program.compressedPathSquares = transfer.compressedPathSquares;
  program.routeTargets = transfer.targets;
  program.graveyardSlotKey = request.graveyardSlotKey;
  program.expectedBefore = request.phase.expectedBefore;
  program.expectedAfter = request.phase.expectedAfter;
  program.primitives.push_back(
      primitive(LaneMotionPrimitiveKind::TravelBoard, -1, source));
  program.primitives.push_back(
      primitive(LaneMotionPrimitiveKind::Pickup, source));

  int dragSource = source;
  for (std::size_t index = 0; index < transfer.targets.size(); ++index) {
    const ExternalRouteTarget& routeTarget = transfer.targets[index];
    const bool finalTarget = index + 1 == transfer.targets.size();
    if (routeTarget.type == ExternalTargetType::Coordinate) {
      program.primitives.push_back(primitive(
          LaneMotionPrimitiveKind::DragCoordinate,
          dragSource,
          -1,
          routeTarget.x,
          routeTarget.y));
      dragSource = -1;
    } else {
      program.primitives.push_back(primitive(
          LaneMotionPrimitiveKind::DragBoard,
          dragSource,
          routeTarget.rawIndex,
          0.0,
          0.0,
          finalTarget));
      dragSource = routeTarget.rawIndex;
    }
  }
  program.primitives.push_back(
      primitive(LaneMotionPrimitiveKind::Drop, -1, target));
  program.primitives.push_back(
      primitive(LaneMotionPrimitiveKind::Verify, source, target));
  return program;
}

const char* laneMotionCompileStatusName(LaneMotionCompileStatus status) {
  switch (status) {
    case LaneMotionCompileStatus::Success: return "success";
    case LaneMotionCompileStatus::InvalidPhase: return "invalid_phase";
    case LaneMotionCompileStatus::UnsupportedMove: return "unsupported_move";
    case LaneMotionCompileStatus::UnsupportedRoute: return "unsupported_route";
    case LaneMotionCompileStatus::InvalidOccupancy: return "invalid_occupancy";
    case LaneMotionCompileStatus::InvalidPath: return "invalid_path";
    case LaneMotionCompileStatus::InvalidCoordinate: return "invalid_coordinate";
    case LaneMotionCompileStatus::InvalidGraveyard: return "invalid_graveyard";
  }
  return "invalid_phase";
}

const char* laneMotionPrimitiveKindName(LaneMotionPrimitiveKind kind) {
  switch (kind) {
    case LaneMotionPrimitiveKind::TravelBoard: return "travel-board";
    case LaneMotionPrimitiveKind::Pickup: return "pickup";
    case LaneMotionPrimitiveKind::DragCoordinate: return "drag-coordinate";
    case LaneMotionPrimitiveKind::DragBoard: return "drag-board";
    case LaneMotionPrimitiveKind::Drop: return "drop";
    case LaneMotionPrimitiveKind::Verify: return "verify";
  }
  return "travel-board";
}

bool laneMotionAttemptAllowed(const OfflinePhaseExecutionToken& token) {
  return token.attempt >= 1 && token.attempt <= kLaneMotionMaximumAttempts;
}

}  // namespace offline
