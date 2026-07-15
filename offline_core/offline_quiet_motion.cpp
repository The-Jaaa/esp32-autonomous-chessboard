#include "offline_quiet_motion.h"

#include <cstddef>
#include <cstdlib>
#include <utility>

namespace offline {
namespace {

QuietMotionProgram reject(
    const OfflinePhaseExecutionRequest& request,
    QuietMotionCompileStatus status,
    std::string reason) {
  QuietMotionProgram program;
  program.status = status;
  program.token = request.token;
  program.moveUci = request.move.uci;
  program.from = request.phase.from;
  program.to = request.phase.to;
  program.expectedBefore = request.phase.expectedBefore;
  program.expectedAfter = request.phase.expectedAfter;
  program.blockedReason = std::move(reason);
  return program;
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

bool validSquare(const std::string& square) {
  return square.size() == 2 && square[0] >= 'a' && square[0] <= 'h' &&
         square[1] >= '1' && square[1] <= '8';
}

bool pathMatchesEndpoints(
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

bool clearRawPath(
    const std::vector<std::string>& path,
    const Occupancy& occupancy) {
  for (std::size_t index = 1; index < path.size(); ++index) {
    const int rawIndex = squareToRawIndex(path[index]);
    if (rawIndex < 0 || occupancy[static_cast<std::size_t>(rawIndex)]) return false;
  }
  return true;
}

std::vector<std::string> expandCompressedPath(
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

bool safeBoardPath(
    const ExternalTransferResult& transfer,
    const MoveInfo& move,
    const Occupancy& occupancy) {
  if (transfer.mode == ExternalRouteMode::Direct) {
    if (move.piece.empty() ||
        (move.piece.front() != 'p' && move.piece.front() != 'P') ||
        fileIndex(move.from) != fileIndex(move.to)) {
      return false;
    }
    const int fromRank = rankIndex(move.from);
    const int toRank = rankIndex(move.to);
    const int distance = std::abs(toRank - fromRank);
    if (distance < 1 || distance > 2) return false;
    if (distance == 2) {
      const int middleRank = (fromRank + toRank) / 2;
      const std::string middle{
          move.from.front(), static_cast<char>('1' + middleRank)};
      const int middleRaw = squareToRawIndex(middle);
      if (middleRaw < 0 || occupancy[static_cast<std::size_t>(middleRaw)]) return false;
    }
    return clearRawPath(transfer.rawPathSquares, occupancy);
  }
  return expandCompressedPath(transfer.compressedPathSquares) ==
             transfer.rawPathSquares &&
         clearRawPath(transfer.rawPathSquares, occupancy);
}

bool exactQuietOccupancyTransition(
    const Occupancy& before,
    const Occupancy& after,
    int source,
    int target) {
  if (source < 0 || target < 0 || source == target) return false;
  if (!before[static_cast<std::size_t>(source)] ||
      before[static_cast<std::size_t>(target)]) {
    return false;
  }
  Occupancy expected = before;
  expected[static_cast<std::size_t>(source)] = false;
  expected[static_cast<std::size_t>(target)] = true;
  return expected == after;
}

QuietMotionPrimitive primitive(
    QuietMotionPrimitiveKind kind,
    int source,
    int target,
    bool finalBoardDrop = false) {
  QuietMotionPrimitive result;
  result.kind = kind;
  result.sourceRawIndex = source;
  result.targetRawIndex = target;
  result.finalBoardDrop = finalBoardDrop;
  return result;
}

}  // namespace

QuietMotionProgram OfflineQuietMotionCompiler::compile(
    const OfflinePhaseExecutionRequest& request) const {
  if (request.phase.kind != MotionPhaseKind::QuietTransfer ||
      request.phase.graveyard || !request.graveyardSlotKey.empty() ||
      request.graveyardState != GraveyardSlotState::Free) {
    return reject(
        request,
        QuietMotionCompileStatus::InvalidPhase,
        "Only a graveyard-free QuietTransfer phase can be compiled.");
  }

  if (request.move.uci != request.phase.from + request.phase.to ||
      request.move.from != request.phase.from ||
      request.move.to != request.phase.to || request.move.capture ||
      request.move.castling || request.move.enPassant ||
      !request.move.promotion.empty()) {
    return reject(
        request,
        QuietMotionCompileStatus::UnsupportedMove,
        "The phase does not describe one ordinary quiet chess move.");
  }

  if (!validSquare(request.phase.from) || !validSquare(request.phase.to) ||
      request.phase.from == request.phase.to) {
    return reject(
        request,
        QuietMotionCompileStatus::InvalidPhase,
        "Source and destination must be distinct board squares.");
  }

  if (!request.phase.transfer || !request.phase.transfer->success()) {
    return reject(
        request,
        QuietMotionCompileStatus::InvalidPhase,
        "The quiet phase has no successful transfer route.");
  }
  const ExternalTransferResult& transfer = *request.phase.transfer;
  if (!boardOnlyMode(transfer.mode)) {
    return reject(
        request,
        QuietMotionCompileStatus::UnsupportedRoute,
        "The transfer leaves the 8x8 board.");
  }

  const int source = squareToRawIndex(request.phase.from);
  const int target = squareToRawIndex(request.phase.to);
  if (!exactQuietOccupancyTransition(
          request.phase.expectedBefore,
          request.phase.expectedAfter,
          source,
          target)) {
    return reject(
        request,
        QuietMotionCompileStatus::InvalidOccupancy,
        "The phase occupancy is not an exact quiet source-to-target transition.");
  }

  if (!pathMatchesEndpoints(
          transfer.rawPathSquares, request.phase.from, request.phase.to) ||
      !pathMatchesEndpoints(
          transfer.compressedPathSquares, request.phase.from, request.phase.to)) {
    return reject(
        request,
        QuietMotionCompileStatus::InvalidPath,
        "The board route does not start and finish on the phase squares.");
  }
  if (!safeBoardPath(transfer, request.move, request.phase.expectedBefore)) {
    return reject(
        request,
        QuietMotionCompileStatus::InvalidPath,
        "The route is not a clear, reconstructable board-only path.");
  }

  if (transfer.targets.size() + 1 != transfer.compressedPathSquares.size()) {
    return reject(
        request,
        QuietMotionCompileStatus::InvalidPath,
        "Compressed waypoints and route targets do not have matching lengths.");
  }
  for (std::size_t index = 0; index < transfer.targets.size(); ++index) {
    const ExternalRouteTarget& routeTarget = transfer.targets[index];
    const std::string& expectedSquare = transfer.compressedPathSquares[index + 1];
    if (routeTarget.type != ExternalTargetType::Square ||
        routeTarget.square != expectedSquare ||
        routeTarget.rawIndex != squareToRawIndex(expectedSquare)) {
      return reject(
          request,
          QuietMotionCompileStatus::InvalidPath,
          "Every compressed waypoint must be a matching board-square target.");
    }
  }

  QuietMotionProgram program;
  program.status = QuietMotionCompileStatus::Success;
  program.token = request.token;
  program.moveUci = request.move.uci;
  program.from = request.phase.from;
  program.to = request.phase.to;
  program.sourceRawIndex = source;
  program.targetRawIndex = target;
  program.routeMode = transfer.mode;
  program.routeCost = transfer.routeCost;
  program.rawPathSquares = transfer.rawPathSquares;
  program.compressedPathSquares = transfer.compressedPathSquares;
  program.expectedBefore = request.phase.expectedBefore;
  program.expectedAfter = request.phase.expectedAfter;
  program.primitives.push_back(
      primitive(QuietMotionPrimitiveKind::Travel, -1, source));
  program.primitives.push_back(
      primitive(QuietMotionPrimitiveKind::Pickup, source, -1));
  int dragSource = source;
  for (std::size_t index = 0; index < transfer.targets.size(); ++index) {
    const bool finalTarget = index + 1 == transfer.targets.size();
    const int dragTarget = transfer.targets[index].rawIndex;
    program.primitives.push_back(primitive(
        QuietMotionPrimitiveKind::Drag,
        dragSource,
        dragTarget,
        finalTarget));
    dragSource = dragTarget;
  }
  program.primitives.push_back(
      primitive(QuietMotionPrimitiveKind::Drop, -1, target));
  program.primitives.push_back(
      primitive(QuietMotionPrimitiveKind::Verify, source, target));
  return program;
}

const char* quietMotionCompileStatusName(QuietMotionCompileStatus status) {
  switch (status) {
    case QuietMotionCompileStatus::Success:
      return "success";
    case QuietMotionCompileStatus::InvalidPhase:
      return "invalid_phase";
    case QuietMotionCompileStatus::UnsupportedMove:
      return "unsupported_move";
    case QuietMotionCompileStatus::UnsupportedRoute:
      return "unsupported_route";
    case QuietMotionCompileStatus::InvalidOccupancy:
      return "invalid_occupancy";
    case QuietMotionCompileStatus::InvalidPath:
      return "invalid_path";
  }
  return "invalid_phase";
}

const char* quietMotionPrimitiveKindName(QuietMotionPrimitiveKind kind) {
  switch (kind) {
    case QuietMotionPrimitiveKind::Travel:
      return "travel";
    case QuietMotionPrimitiveKind::Pickup:
      return "pickup";
    case QuietMotionPrimitiveKind::Drag:
      return "drag";
    case QuietMotionPrimitiveKind::Drop:
      return "drop";
    case QuietMotionPrimitiveKind::Verify:
      return "verify";
  }
  return "travel";
}

bool quietMotionAttemptAllowed(const OfflinePhaseExecutionToken& token) {
  return token.attempt >= 1 && token.attempt <= kQuietMotionMaximumAttempts;
}

}  // namespace offline
