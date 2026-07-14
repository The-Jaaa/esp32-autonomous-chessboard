#include "offline_route.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <optional>
#include <utility>

namespace offline {
namespace {

struct Direction {
  int file = 0;
  int rank = 0;
};

struct SearchNode {
  std::string square;
  std::vector<std::string> path;
  int cost = 0;
  int score = 0;
};

struct SearchPath {
  std::vector<std::string> squares;
  int cost = 0;
  BoardRouteMode mode = BoardRouteMode::BoardBuffered;
};

bool validSquare(const std::string& square) {
  return square.size() == 2 && square[0] >= 'a' && square[0] <= 'h' &&
         square[1] >= '1' && square[1] <= '8';
}

int fileIndex(const std::string& square) {
  return validSquare(square) ? square[0] - 'a' : -1;
}

int rankNumber(const std::string& square) {
  return validSquare(square) ? square[1] - '0' : -1;
}

std::string squareFromFileRank(int file, int rank) {
  if (file < 0 || file > 7 || rank < 1 || rank > 8) return {};
  return std::string{static_cast<char>('a' + file), static_cast<char>('0' + rank)};
}

int sign(int value) {
  return (value > 0) - (value < 0);
}

Direction stepDirection(const std::string& from, const std::string& to) {
  return {
      sign(fileIndex(to) - fileIndex(from)),
      sign(rankNumber(to) - rankNumber(from))};
}

bool sameDirection(const Direction& left, const Direction& right) {
  return left.file == right.file && left.rank == right.rank;
}

std::vector<std::string> compressPath(const std::vector<std::string>& squares) {
  if (squares.size() <= 2) return squares;

  std::vector<std::string> compressed{squares.front()};
  Direction previous = stepDirection(squares[0], squares[1]);
  for (std::size_t index = 2; index < squares.size(); ++index) {
    const Direction direction = stepDirection(squares[index - 1], squares[index]);
    if (!sameDirection(previous, direction)) compressed.push_back(squares[index - 1]);
    previous = direction;
  }
  compressed.push_back(squares.back());
  return compressed;
}

std::optional<std::vector<std::string>> squaresBetween(
    const std::string& from, const std::string& to) {
  const int fromFile = fileIndex(from);
  const int toFile = fileIndex(to);
  const int fromRank = rankNumber(from);
  const int toRank = rankNumber(to);
  const int fileDistance = std::abs(toFile - fromFile);
  const int rankDistance = std::abs(toRank - fromRank);
  if (fromFile != toFile && fromRank != toRank && fileDistance != rankDistance) {
    return std::nullopt;
  }

  const int df = sign(toFile - fromFile);
  const int dr = sign(toRank - fromRank);
  std::vector<std::string> squares;
  int file = fromFile;
  int rank = fromRank;
  do {
    file += df;
    rank += dr;
    squares.push_back(squareFromFileRank(file, rank));
  } while (file != toFile || rank != toRank);
  return squares;
}

bool occupied(const Occupancy& occupancy, const std::string& square) {
  const int index = squareToRawIndex(square);
  return index < 0 || occupancy[static_cast<std::size_t>(index)];
}

std::array<bool, 64> ignoredIndexes(
    const std::string& from,
    const std::string& to,
    const std::vector<std::string>& ignoredSquares) {
  std::array<bool, 64> ignored{};
  for (const std::string& square : ignoredSquares) {
    const int index = squareToRawIndex(square);
    if (index >= 0) ignored[static_cast<std::size_t>(index)] = true;
  }
  ignored[static_cast<std::size_t>(squareToRawIndex(from))] = true;
  ignored[static_cast<std::size_t>(squareToRawIndex(to))] = true;
  return ignored;
}

Occupancy planningOccupancy(
    const BoardRouteRequest& request,
    const std::array<bool, 64>& ignored) {
  Occupancy result = request.expectedOccupancy;
  if (request.sensedOccupancy) {
    for (std::size_t index = 0; index < result.size(); ++index) {
      result[index] = result[index] || (*request.sensedOccupancy)[index];
    }
  }
  for (std::size_t index = 0; index < result.size(); ++index) {
    if (ignored[index]) result[index] = false;
  }
  return result;
}

int adjacentOccupiedCount(
    const Occupancy& occupancy,
    const std::string& square,
    const std::array<bool, 64>& ignored) {
  int count = 0;
  const int file = fileIndex(square);
  const int rank = rankNumber(square);
  for (int df = -1; df <= 1; ++df) {
    for (int dr = -1; dr <= 1; ++dr) {
      if (df == 0 && dr == 0) continue;
      const std::string neighbor = squareFromFileRank(file + df, rank + dr);
      if (neighbor.empty()) continue;
      const int index = squareToRawIndex(neighbor);
      if (index >= 0 && !ignored[static_cast<std::size_t>(index)] &&
          occupied(occupancy, neighbor)) {
        ++count;
      }
    }
  }
  return count;
}

std::optional<SearchPath> clearLinePath(
    const BoardRouteRequest& request,
    const Occupancy& occupancy) {
  const std::optional<std::vector<std::string>> between = squaresBetween(request.from, request.to);
  if (!between) return std::nullopt;
  if (std::any_of(between->begin(), between->end(), [&](const std::string& square) {
        return occupied(occupancy, square);
      })) {
    return std::nullopt;
  }

  std::vector<std::string> squares{request.from};
  squares.insert(squares.end(), between->begin(), between->end());
  const Direction direction = stepDirection(request.from, request.to);
  const bool diagonal = direction.file != 0 && direction.rank != 0;
  return SearchPath{
      std::move(squares),
      static_cast<int>(between->size()) * (diagonal ? 14 : 10),
      between->size() <= 1 ? BoardRouteMode::BoardDirect : BoardRouteMode::BoardLine};
}

std::optional<SearchPath> findPath(
    const BoardRouteRequest& request,
    const Occupancy& occupancy,
    const std::array<bool, 64>& ignored,
    bool buffered) {
  std::vector<SearchNode> open;
  std::array<bool, 64> closed{};
  open.push_back({
      request.from,
      {request.from},
      0,
      std::abs(fileIndex(request.from) - fileIndex(request.to)) +
          std::abs(rankNumber(request.from) - rankNumber(request.to))});

  while (!open.empty()) {
    std::size_t currentIndex = 0;
    for (std::size_t index = 1; index < open.size(); ++index) {
      if (open[index].score < open[currentIndex].score) currentIndex = index;
    }
    SearchNode current = std::move(open[currentIndex]);
    open.erase(open.begin() + static_cast<std::ptrdiff_t>(currentIndex));

    if (current.square == request.to) {
      return SearchPath{
          std::move(current.path),
          current.cost,
          buffered ? BoardRouteMode::BoardBuffered : BoardRouteMode::BoardRelaxed};
    }

    const int currentRawIndex = squareToRawIndex(current.square);
    closed[static_cast<std::size_t>(currentRawIndex)] = true;
    const int file = fileIndex(current.square);
    const int rank = rankNumber(current.square);

    for (int df = -1; df <= 1; ++df) {
      for (int dr = -1; dr <= 1; ++dr) {
        if (df == 0 && dr == 0) continue;
        const std::string next = squareFromFileRank(file + df, rank + dr);
        if (next.empty()) continue;
        const int nextRawIndex = squareToRawIndex(next);
        if (closed[static_cast<std::size_t>(nextRawIndex)]) continue;
        if (!ignored[static_cast<std::size_t>(nextRawIndex)] && occupied(occupancy, next)) continue;

        const bool diagonal = df != 0 && dr != 0;
        const int stepCost = diagonal ? 14 : 10;
        const int bufferPenalty = buffered
                                      ? adjacentOccupiedCount(occupancy, next, ignored) * 10
                                      : 0;
        const int nextCost = current.cost + stepCost + bufferPenalty;
        const int heuristic = (
            std::abs(fileIndex(next) - fileIndex(request.to)) +
            std::abs(rankNumber(next) - rankNumber(request.to))) * 10;

        const auto existing = std::find_if(open.begin(), open.end(), [&](const SearchNode& node) {
          return node.square == next;
        });
        if (existing == open.end()) {
          std::vector<std::string> path = current.path;
          path.push_back(next);
          open.push_back({next, std::move(path), nextCost, nextCost + heuristic});
        } else if (nextCost < existing->cost) {
          existing->path = current.path;
          existing->path.push_back(next);
          existing->cost = nextCost;
          existing->score = nextCost + heuristic;
        }
      }
    }
  }
  return std::nullopt;
}

bool simplePawnPush(const MoveInfo& move) {
  if (move.piece.empty() || move.capture || move.enPassant || move.castling ||
      !move.promotion.empty()) {
    return false;
  }
  const char piece = static_cast<char>(
      std::tolower(static_cast<unsigned char>(move.piece.front())));
  const int fileDistance = std::abs(fileIndex(move.to) - fileIndex(move.from));
  const int rankDistance = std::abs(rankNumber(move.to) - rankNumber(move.from));
  return piece == 'p' && fileDistance == 0 && rankDistance >= 1 && rankDistance <= 2;
}

BoardRouteResult failure(BoardRouteStatus status, std::string reason) {
  BoardRouteResult result;
  result.status = status;
  result.blockedReason = std::move(reason);
  return result;
}

}  // namespace

const char* boardRouteStatusName(BoardRouteStatus status) {
  switch (status) {
    case BoardRouteStatus::Success: return "success";
    case BoardRouteStatus::InvalidRequest: return "invalid_request";
    case BoardRouteStatus::UnsupportedMove: return "unsupported_move";
    case BoardRouteStatus::NoBoardPath: return "no_board_path";
    default: return "unknown";
  }
}

const char* boardRouteModeName(BoardRouteMode mode) {
  switch (mode) {
    case BoardRouteMode::Direct: return "direct";
    case BoardRouteMode::BoardDirect: return "board-direct";
    case BoardRouteMode::BoardLine: return "board-line";
    case BoardRouteMode::BoardBuffered: return "board-buffered";
    case BoardRouteMode::BoardRelaxed: return "board-relaxed";
    default: return "unknown";
  }
}

BoardRouteResult OfflineBoardRoutePlanner::plan(const BoardRouteRequest& request) const {
  if (!validSquare(request.from) || !validSquare(request.to) || request.from == request.to) {
    return failure(BoardRouteStatus::InvalidRequest, "Source and target must be distinct board squares.");
  }
  for (const std::string& ignored : request.ignoredSquares) {
    if (!validSquare(ignored)) {
      return failure(BoardRouteStatus::InvalidRequest, "Ignored squares must be valid board squares.");
    }
  }

  const std::array<bool, 64> ignored = ignoredIndexes(
      request.from, request.to, request.ignoredSquares);
  const Occupancy occupancy = planningOccupancy(request, ignored);

  const std::optional<SearchPath> line = clearLinePath(request, occupancy);
  if (request.directWhenClear && line) {
    BoardRouteResult result;
    result.status = BoardRouteStatus::Success;
    result.mode = BoardRouteMode::Direct;
    result.rawPathSquares = {request.from, request.to};
    result.compressedPathSquares = result.rawPathSquares;
    return result;
  }

  std::optional<SearchPath> path = request.preferClearLine ? line : std::nullopt;
  if (!path) path = findPath(request, occupancy, ignored, true);
  if (!path) path = findPath(request, occupancy, ignored, false);
  if (!path) {
    return failure(
        BoardRouteStatus::NoBoardPath,
        "No board path from " + request.from + " to " + request.to + '.');
  }

  BoardRouteResult result;
  result.status = BoardRouteStatus::Success;
  result.mode = path->squares.size() <= 2 && path->mode != BoardRouteMode::BoardLine
                    ? BoardRouteMode::BoardDirect
                    : path->mode;
  result.cost = path->cost;
  result.rawPathSquares = std::move(path->squares);
  result.compressedPathSquares = compressPath(result.rawPathSquares);
  return result;
}

BoardRouteResult OfflineBoardRoutePlanner::planQuietMove(
    const OfflineGame& game,
    const MoveInfo& move,
    const std::optional<Occupancy>& sensedOccupancy,
    const std::vector<std::string>& ignoredSquares) const {
  if (move.capture || move.castling || move.enPassant || !move.promotion.empty()) {
    return failure(
        BoardRouteStatus::UnsupportedMove,
        "Captures, castling, en passant, and promotions require a later motion planner.");
  }

  MoveInfo legalMove;
  if (!game.describeLegalMove(move.uci, legalMove) || legalMove.from != move.from ||
      legalMove.to != move.to) {
    return failure(BoardRouteStatus::InvalidRequest, "Move is not legal in the supplied game.");
  }

  BoardRouteRequest request;
  request.from = move.from;
  request.to = move.to;
  request.expectedOccupancy = occupancyFromFen(game.fen());
  request.sensedOccupancy = sensedOccupancy;
  request.ignoredSquares = ignoredSquares;
  request.directWhenClear = simplePawnPush(move);
  return plan(request);
}

}  // namespace offline
