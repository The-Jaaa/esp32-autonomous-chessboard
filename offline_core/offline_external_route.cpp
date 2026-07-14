#include "offline_external_route.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <limits>
#include <set>
#include <utility>

namespace offline {
namespace {

constexpr std::array<int, 8> kMiddleOutOrder{4, 5, 3, 6, 2, 7, 1, 8};

bool validSquare(const std::string& square) {
  return square.size() == 2 && square[0] >= 'a' && square[0] <= 'h' &&
         square[1] >= '1' && square[1] <= '8';
}

std::string upper(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::toupper(character));
  });
  return value;
}

std::string trimmed(std::string value) {
  const auto first = std::find_if_not(value.begin(), value.end(), [](unsigned char character) {
    return std::isspace(character) != 0;
  });
  const auto last = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char character) {
    return std::isspace(character) != 0;
  }).base();
  return first < last ? std::string(first, last) : std::string{};
}

bool slotKeyOccupied(
    const std::vector<std::string>& occupiedKeys, const ExternalSlot& slot) {
  const std::string key = externalSlotKey(slot);
  return !key.empty() && std::any_of(
      occupiedKeys.begin(), occupiedKeys.end(), [&](const std::string& occupied) {
        return upper(occupied) == key;
      });
}

int fileIndex(const std::string& square) {
  return validSquare(square) ? square[0] - 'a' : -1;
}

int rankNumber(const std::string& square) {
  return validSquare(square) ? square[1] - '0' : 0;
}

std::string squareFromFileRank(int file, int rank) {
  if (file < 0 || file > 7 || rank < 1 || rank > 8) return {};
  return std::string{static_cast<char>('a' + file), static_cast<char>('0' + rank)};
}

char normalizedLane(char lane) {
  const char result = static_cast<char>(std::toupper(static_cast<unsigned char>(lane)));
  return result == 'Z' || result == 'I' ? result : '\0';
}

char preferredLaneForSquare(const std::string& square) {
  return fileIndex(square) <= 3 ? 'Z' : 'I';
}

int middleOutRankDistance(int rank) {
  const auto position = std::find(kMiddleOutOrder.begin(), kMiddleOutOrder.end(), rank);
  return position == kMiddleOutOrder.end()
             ? static_cast<int>(kMiddleOutOrder.size())
             : static_cast<int>(std::distance(kMiddleOutOrder.begin(), position));
}

ExternalRouteTarget squareTarget(const std::string& square) {
  ExternalRouteTarget target;
  target.type = ExternalTargetType::Square;
  target.square = square;
  target.rawIndex = squareToRawIndex(square);
  return target;
}

ExternalRouteTarget coordinateTarget(const ExternalSlot& slot, std::string role) {
  ExternalRouteTarget target;
  target.type = ExternalTargetType::Coordinate;
  target.role = std::move(role);
  target.label = slot.label;
  target.lane = slot.lane;
  target.rank = slot.rank;
  target.x = slot.x;
  target.y = slot.y;
  return target;
}

std::string targetKey(const ExternalRouteTarget& target) {
  if (target.type == ExternalTargetType::Square) return "square:" + target.square;
  if (!target.label.empty()) return "coord:" + target.label;
  return "coord:" + std::to_string(target.x) + ',' + std::to_string(target.y);
}

std::vector<ExternalRouteTarget> dedupeTargets(
    const std::vector<ExternalRouteTarget>& targets) {
  std::set<std::string> seen;
  std::vector<ExternalRouteTarget> result;
  for (const ExternalRouteTarget& target : targets) {
    if (seen.insert(targetKey(target)).second) result.push_back(target);
  }
  return result;
}

Occupancy mergedOccupancy(
    const Occupancy& expected,
    const std::optional<Occupancy>& sensed,
    const std::vector<std::string>& ignoredSquares) {
  Occupancy result = expected;
  if (sensed) {
    for (std::size_t index = 0; index < result.size(); ++index) {
      result[index] = result[index] || (*sensed)[index];
    }
  }
  for (const std::string& square : ignoredSquares) {
    const int index = squareToRawIndex(square);
    if (index >= 0) result[static_cast<std::size_t>(index)] = false;
  }
  return result;
}

bool occupied(const Occupancy& occupancy, const std::string& square) {
  const int index = squareToRawIndex(square);
  return index < 0 || occupancy[static_cast<std::size_t>(index)];
}

std::vector<std::string> lanePathSquares(const std::string& square, char lane) {
  const int direction = lane == 'Z' ? -1 : 1;
  std::vector<std::string> squares;
  for (int file = fileIndex(square) + direction; file >= 0 && file <= 7; file += direction) {
    squares.push_back(squareFromFileRank(file, rankNumber(square)));
  }
  return squares;
}

bool lanePathClear(
    const Occupancy& expected,
    const std::string& square,
    char lane,
    const std::vector<std::string>& ignoredSquares) {
  const std::set<std::string> ignored(ignoredSquares.begin(), ignoredSquares.end());
  const std::vector<std::string> path = lanePathSquares(square, lane);
  return std::all_of(
      path.begin(), path.end(),
      [&](const std::string& pathSquare) {
        return ignored.count(pathSquare) > 0 || !occupied(expected, pathSquare);
      });
}

std::vector<ExternalSlot> freeLaneSlots(
    const std::vector<ExternalSlot>& slots,
    const std::vector<std::string>& occupiedKeys,
    char lane) {
  std::vector<ExternalSlot> result;
  std::copy_if(slots.begin(), slots.end(), std::back_inserter(result), [&](const ExternalSlot& slot) {
    return slot.lane == lane && !slotKeyOccupied(occupiedKeys, slot);
  });
  std::stable_sort(result.begin(), result.end(), [](const ExternalSlot& left, const ExternalSlot& right) {
    return left.rank < right.rank;
  });
  return result;
}

std::vector<ExternalSlot> sortedLaneCandidates(
    const std::vector<ExternalSlot>& slots,
    const std::vector<std::string>& occupiedKeys,
    const std::string& square,
    char preferredLane) {
  const int rank = rankNumber(square);
  std::vector<ExternalSlot> candidates = freeLaneSlots(slots, occupiedKeys, preferredLane);
  const std::vector<ExternalSlot> opposite = freeLaneSlots(
      slots, occupiedKeys, preferredLane == 'Z' ? 'I' : 'Z');
  candidates.insert(candidates.end(), opposite.begin(), opposite.end());
  std::stable_sort(candidates.begin(), candidates.end(), [&](const ExternalSlot& left, const ExternalSlot& right) {
    const int leftDistance = std::abs((left.rank != 0 ? left.rank : rank) - rank);
    const int rightDistance = std::abs((right.rank != 0 ? right.rank : rank) - rank);
    if (leftDistance != rightDistance) return leftDistance < rightDistance;
    if (left.lane == preferredLane && right.lane != preferredLane) return true;
    if (left.lane != preferredLane && right.lane == preferredLane) return false;
    return left.label < right.label;
  });
  return candidates;
}

std::optional<ExternalSlot> chooseClearLaneSlot(
    const Occupancy& expected,
    const std::vector<ExternalSlot>& slots,
    const std::vector<std::string>& occupiedKeys,
    const std::string& square,
    char preferredLane,
    const std::vector<std::string>& ignoredSquares) {
  const std::vector<ExternalSlot> candidates = sortedLaneCandidates(
      slots, occupiedKeys, square, preferredLane);
  const auto selected = std::find_if(candidates.begin(), candidates.end(), [&](const ExternalSlot& slot) {
    return lanePathClear(expected, square, slot.lane, ignoredSquares);
  });
  return selected == candidates.end() ? std::nullopt : std::optional<ExternalSlot>(*selected);
}

bool laneTransitClear(
    const std::vector<ExternalSlot>& slots,
    const std::vector<std::string>& occupiedKeys,
    const ExternalSlot& from,
    const ExternalSlot& to) {
  if (from.lane == '\0' || from.lane != to.lane || from.rank == 0 || to.rank == 0) return false;
  const int minimum = std::min(from.rank, to.rank);
  const int maximum = std::max(from.rank, to.rank);
  return std::all_of(slots.begin(), slots.end(), [&](const ExternalSlot& slot) {
    if (slot.lane != from.lane || !slotKeyOccupied(occupiedKeys, slot)) return true;
    return slot.rank == 0 || slot.rank <= minimum || slot.rank >= maximum;
  });
}

std::string laneExitSquare(const ExternalSlot& slot) {
  if ((slot.lane != 'Z' && slot.lane != 'I') || slot.rank < 1 || slot.rank > 8) return {};
  return std::string{slot.lane == 'Z' ? 'a' : 'h', static_cast<char>('0' + slot.rank)};
}

ExternalRouteMode mapBoardMode(BoardRouteMode mode) {
  switch (mode) {
    case BoardRouteMode::Direct: return ExternalRouteMode::Direct;
    case BoardRouteMode::BoardDirect: return ExternalRouteMode::BoardDirect;
    case BoardRouteMode::BoardLine: return ExternalRouteMode::BoardLine;
    case BoardRouteMode::BoardBuffered: return ExternalRouteMode::BoardBuffered;
    case BoardRouteMode::BoardRelaxed: return ExternalRouteMode::BoardRelaxed;
    default: return ExternalRouteMode::BoardDirect;
  }
}

ExternalTransferResult boardTransfer(const ExternalTransferRequest& request) {
  BoardRouteRequest board;
  board.from = request.from;
  board.to = request.to;
  board.expectedOccupancy = request.expectedOccupancy;
  board.sensedOccupancy = request.sensedOccupancy;
  board.ignoredSquares = request.ignoredSquares;
  board.directWhenClear = request.directWhenClear;
  const BoardRouteResult route = OfflineBoardRoutePlanner{}.plan(board);

  ExternalTransferResult result;
  if (!route.success()) {
    result.status = route.status == BoardRouteStatus::InvalidRequest
                        ? ExternalRouteStatus::InvalidRequest
                        : ExternalRouteStatus::NoLanePath;
    result.blockedReason = route.blockedReason;
    return result;
  }
  result.status = ExternalRouteStatus::Success;
  result.mode = mapBoardMode(route.mode);
  result.routeCost = route.cost;
  result.rawPathSquares = route.rawPathSquares;
  result.compressedPathSquares = route.compressedPathSquares;
  for (std::size_t index = 1; index < route.compressedPathSquares.size(); ++index) {
    result.targets.push_back(squareTarget(route.compressedPathSquares[index]));
  }
  return result;
}

BoardRouteResult aStarBoardPath(
    const std::string& from,
    const std::string& to,
    const Occupancy& expected,
    const std::optional<Occupancy>& sensed,
    const std::vector<std::string>& ignoredSquares) {
  if (from == to && validSquare(from)) {
    BoardRouteResult result;
    result.status = BoardRouteStatus::Success;
    result.mode = BoardRouteMode::BoardDirect;
    result.rawPathSquares = {from};
    result.compressedPathSquares = result.rawPathSquares;
    return result;
  }
  BoardRouteRequest request;
  request.from = from;
  request.to = to;
  request.expectedOccupancy = expected;
  request.sensedOccupancy = sensed;
  request.ignoredSquares = ignoredSquares;
  request.preferClearLine = false;
  return OfflineBoardRoutePlanner{}.plan(request);
}

int adjacentOccupiedCount(
    const Occupancy& occupancy,
    const std::string& square,
    const std::vector<std::string>& ignoredSquares) {
  const std::set<std::string> ignored(ignoredSquares.begin(), ignoredSquares.end());
  int count = 0;
  for (int df = -1; df <= 1; ++df) {
    for (int dr = -1; dr <= 1; ++dr) {
      if (df == 0 && dr == 0) continue;
      const std::string neighbor = squareFromFileRank(
          fileIndex(square) + df, rankNumber(square) + dr);
      if (!neighbor.empty() && ignored.count(neighbor) == 0 && occupied(occupancy, neighbor)) {
        ++count;
      }
    }
  }
  return count;
}

std::vector<ExternalSlot> sortedRobotGraveyardSlots(
    const std::vector<ExternalSlot>& slots) {
  std::vector<ExternalSlot> result = slots;
  std::stable_sort(result.begin(), result.end(), [](const ExternalSlot& left, const ExternalSlot& right) {
    const char leftLane = left.lane == '\0' ? 'Z' : left.lane;
    const char rightLane = right.lane == '\0' ? 'Z' : right.lane;
    if (leftLane != rightLane) return leftLane == 'Z';
    const int distance = middleOutRankDistance(left.rank) - middleOutRankDistance(right.rank);
    if (distance != 0) return distance < 0;
    return left.label < right.label;
  });
  return result;
}

}  // namespace

std::vector<ExternalSlot> defaultExternalSlots() {
  return normalizeExternalSlots({
      {"", "Z1", "", 29300, 34450}, {"", "Z2", "", 24800, 34450},
      {"", "Z3", "", 21300, 34450}, {"", "Z4", "", 17300, 34450},
      {"", "Z5", "", 13300, 34450}, {"", "Z6", "", 9300, 34450},
      {"", "Z7", "", 5300, 34450}, {"", "Z8", "", 1300, 34450},
      {"", "I8", "", 1500, -350}, {"", "I7", "", 5500, -350},
      {"", "I6", "", 9500, -350}, {"", "I5", "", 13700, -350},
      {"", "I4", "", 17600, -350}, {"", "I3", "", 21600, -350},
      {"", "I2", "", 25600, -350}, {"", "I1", "", 29600, -350}});
}

std::vector<ExternalSlot> normalizeExternalSlots(const std::vector<ExternalSlot>& slots) {
  if (slots.empty()) return defaultExternalSlots();
  std::vector<ExternalSlot> result;
  result.reserve(slots.size());
  for (std::size_t index = 0; index < slots.size(); ++index) {
    ExternalSlot slot = slots[index];
    if (!std::isfinite(slot.x) || !std::isfinite(slot.y)) continue;
    slot.label = trimmed(slot.label.empty()
                             ? "Graveyard " + std::to_string(index + 1)
                             : slot.label);
    const std::string labelUpper = upper(slot.label);
    if (labelUpper.rfind("CAPTURED", 0) == 0) {
      std::string suffix = trimmed(slot.label.substr(8));
      if (suffix.size() == 1 && suffix[0] >= '1' && suffix[0] <= '8') {
        slot.label = "Z" + suffix;
      }
    }
    const std::string normalizedLabel = upper(slot.label);
    const std::string laneRank = normalizedLabel.empty()
                                     ? std::string{}
                                     : trimmed(normalizedLabel.substr(1));
    if (!normalizedLabel.empty() &&
        (normalizedLabel[0] == 'Z' || normalizedLabel[0] == 'I') &&
        laneRank.size() == 1 && laneRank[0] >= '1' && laneRank[0] <= '8') {
      slot.lane = normalizedLabel[0];
      slot.rank = laneRank[0] - '0';
    } else {
      slot.lane = '\0';
      slot.rank = 0;
    }
    if (slot.id.empty()) slot.id = "graveyard-" + std::to_string(index + 1);
    slot.key = upper(slot.label.empty() ? slot.id : slot.label);
    result.push_back(std::move(slot));
  }
  return result;
}

std::string externalSlotKey(const ExternalSlot& slot) {
  if (!slot.key.empty()) return upper(slot.key);
  if (!slot.label.empty()) return upper(slot.label);
  return upper(slot.id);
}

std::vector<std::string> reserveVerifiedSlot(
    const std::vector<std::string>& occupiedKeys, std::string_view slotKey) {
  std::vector<std::string> result = occupiedKeys;
  const std::string key = upper(std::string(slotKey));
  if (!key.empty() && std::none_of(result.begin(), result.end(), [&](const std::string& item) {
        return upper(item) == key;
      })) {
    result.push_back(key);
  }
  return result;
}

std::vector<std::string> releaseVerifiedSlot(
    const std::vector<std::string>& occupiedKeys, std::string_view slotKey) {
  const std::string key = upper(std::string(slotKey));
  if (key.empty()) return occupiedKeys;
  std::vector<std::string> result;
  std::copy_if(occupiedKeys.begin(), occupiedKeys.end(), std::back_inserter(result),
               [&](const std::string& item) { return upper(item) != key; });
  return result;
}

ExternalTransferResult OfflineExternalRoutePlanner::planTransfer(
    const ExternalTransferRequest& request) const {
  if (!validSquare(request.from) || !validSquare(request.to) || request.from == request.to) {
    ExternalTransferResult result;
    result.blockedReason = "Source and target must be distinct board squares.";
    return result;
  }
  if (std::any_of(request.ignoredSquares.begin(), request.ignoredSquares.end(),
                  [](const std::string& square) { return !validSquare(square); })) {
    ExternalTransferResult result;
    result.blockedReason = "Ignored squares must be valid board squares.";
    return result;
  }

  if (!request.forceLane) {
    ExternalTransferResult board = boardTransfer(request);
    if (board.success() || board.status == ExternalRouteStatus::InvalidRequest) return board;
  }

  const std::vector<ExternalSlot> slots = normalizeExternalSlots(request.slots);
  const char preferred = normalizedLane(request.preferredLane.value_or('\0')) != '\0'
                             ? normalizedLane(*request.preferredLane)
                             : preferredLaneForSquare(request.from);
  std::vector<std::string> ignored{request.from, request.to};
  ignored.insert(ignored.end(), request.ignoredSquares.begin(), request.ignoredSquares.end());

  const std::optional<ExternalSlot> source = chooseClearLaneSlot(
      request.expectedOccupancy, slots, request.occupiedSlotKeys,
      request.from, preferred, ignored);
  if (source) {
    const std::optional<ExternalSlot> target = chooseClearLaneSlot(
        request.expectedOccupancy, slots, request.occupiedSlotKeys,
        request.to, source->lane, ignored);
    if (target) {
      ExternalTransferResult result;
      result.status = ExternalRouteStatus::Success;
      result.mode = ExternalRouteMode::Lane;
      result.rawPathSquares = {request.from, request.to};
      result.compressedPathSquares = result.rawPathSquares;
      result.targets = dedupeTargets({
          coordinateTarget(*source, "lane"),
          coordinateTarget(*target, "lane"),
          squareTarget(request.to)});
      result.routeCost = 1000 + static_cast<int>(result.targets.size()) * 100;
      result.sourceSlot = source;
      result.entrySlot = target;
      return result;
    }
  }

  ExternalTransferResult result;
  result.status = ExternalRouteStatus::NoLanePath;
  result.blockedReason = "The configured Z/I lane path is blocked.";
  const int sourceRank = rankNumber(request.from);
  std::vector<ExternalSlot> sourceSlots = sortedLaneCandidates(
      slots, request.occupiedSlotKeys, request.from, preferred);
  sourceSlots.erase(std::remove_if(sourceSlots.begin(), sourceSlots.end(), [&](const ExternalSlot& slot) {
    return slot.rank != sourceRank ||
           !lanePathClear(request.expectedOccupancy, request.from, slot.lane, ignored);
  }), sourceSlots.end());

  std::vector<ExternalTransferResult> candidates;
  for (const ExternalSlot& sourceSlot : sourceSlots) {
    std::vector<ExternalSlot> entrySlots = sortedLaneCandidates(
        slots, request.occupiedSlotKeys, request.to, sourceSlot.lane);
    entrySlots.erase(std::remove_if(entrySlots.begin(), entrySlots.end(), [&](const ExternalSlot& slot) {
      return slot.lane != sourceSlot.lane ||
             !laneTransitClear(slots, request.occupiedSlotKeys, sourceSlot, slot);
    }), entrySlots.end());

    for (const ExternalSlot& entrySlot : entrySlots) {
      const std::string entrySquare = laneExitSquare(entrySlot);
      if (entrySquare.empty()) {
        result.failures.push_back({entrySlot.label, "Lane slot has no matching board edge square."});
        continue;
      }
      const Occupancy entryOccupancy = mergedOccupancy(
          request.expectedOccupancy, request.sensedOccupancy, ignored);
      if (std::find(ignored.begin(), ignored.end(), entrySquare) == ignored.end() &&
          occupied(entryOccupancy, entrySquare)) {
        result.failures.push_back({entrySlot.label, "Lane entry " + entrySquare + " is occupied."});
        continue;
      }
      if (!lanePathClear(request.expectedOccupancy, entrySquare, entrySlot.lane, ignored)) {
        result.failures.push_back({entrySlot.label, "Lane entry " + entrySquare + " is blocked."});
        continue;
      }
      const BoardRouteResult path = aStarBoardPath(
          entrySquare, request.to, request.expectedOccupancy,
          request.sensedOccupancy, ignored);
      if (!path.success()) {
        result.failures.push_back({
            entrySlot.label, "No board path from " + entrySquare + " to " + request.to + '.'});
        continue;
      }

      ExternalTransferResult candidate;
      candidate.status = ExternalRouteStatus::Success;
      candidate.mode = ExternalRouteMode::LaneBoard;
      candidate.routeCost = 1200 + std::abs(sourceSlot.rank - entrySlot.rank) * 12 + path.cost;
      candidate.rawPathSquares = {request.from};
      candidate.rawPathSquares.insert(
          candidate.rawPathSquares.end(), path.rawPathSquares.begin(), path.rawPathSquares.end());
      candidate.compressedPathSquares = {request.from};
      candidate.compressedPathSquares.insert(
          candidate.compressedPathSquares.end(),
          path.compressedPathSquares.begin(), path.compressedPathSquares.end());
      candidate.targets = {
          coordinateTarget(sourceSlot, "lane"), coordinateTarget(entrySlot, "lane"),
          squareTarget(entrySquare)};
      for (std::size_t index = 1; index < path.compressedPathSquares.size(); ++index) {
        candidate.targets.push_back(squareTarget(path.compressedPathSquares[index]));
      }
      candidate.targets = dedupeTargets(candidate.targets);
      candidate.sourceSlot = sourceSlot;
      candidate.entrySlot = entrySlot;
      candidates.push_back(std::move(candidate));
    }
  }

  if (candidates.empty()) return result;
  std::stable_sort(candidates.begin(), candidates.end(), [](const ExternalTransferResult& left,
                                                             const ExternalTransferResult& right) {
    return left.routeCost < right.routeCost;
  });
  return candidates.front();
}

GraveyardRouteResult OfflineExternalRoutePlanner::planGraveyardRemoval(
    const GraveyardRouteRequest& request) const {
  GraveyardRouteResult result;
  if (!validSquare(request.sourceSquare)) {
    result.blockedReason = "Source must be a valid board square.";
    return result;
  }
  if (std::any_of(request.ignoredSquares.begin(), request.ignoredSquares.end(),
                  [](const std::string& square) { return !validSquare(square); })) {
    result.blockedReason = "Ignored squares must be valid board squares.";
    return result;
  }

  const std::vector<ExternalSlot> slots = sortedRobotGraveyardSlots(
      normalizeExternalSlots(request.slots));
  bool hasFreeSlot = false;
  for (const ExternalSlot& slot : slots) {
    if (slotKeyOccupied(request.occupiedSlotKeys, slot)) continue;
    hasFreeSlot = true;
    const std::string exitSquare = laneExitSquare(slot);
    if (exitSquare.empty()) {
      result.failures.push_back({slot.label, "Slot is missing lane/rank metadata."});
      continue;
    }

    std::vector<std::string> occupancyIgnored = request.ignoredSquares;
    occupancyIgnored.push_back(request.sourceSquare);
    const Occupancy exitOccupancy = mergedOccupancy(
        request.expectedOccupancy, request.sensedOccupancy, occupancyIgnored);
    if (occupied(exitOccupancy, exitSquare)) {
      result.failures.push_back({
          slot.label, "No board path from " + request.sourceSquare + " to " + exitSquare + '.'});
      continue;
    }

    const BoardRouteResult path = aStarBoardPath(
        request.sourceSquare, exitSquare, request.expectedOccupancy,
        request.sensedOccupancy, request.ignoredSquares);
    if (!path.success()) {
      result.failures.push_back({
          slot.label, "No board path from " + request.sourceSquare + " to " + exitSquare + '.'});
      continue;
    }

    const Occupancy crowdingOccupancy = mergedOccupancy(
        request.expectedOccupancy, request.sensedOccupancy, request.ignoredSquares);
    int crowding = 0;
    for (const std::string& square : path.rawPathSquares) {
      crowding += adjacentOccupiedCount(crowdingOccupancy, square, request.ignoredSquares);
    }
    const double preference = middleOutRankDistance(slot.rank) + (slot.lane == 'I' ? 0.5 : 0.0);

    GraveyardRouteCandidate candidate;
    candidate.slot = slot;
    candidate.mode = path.rawPathSquares.size() <= 2
                         ? ExternalRouteMode::GraveyardDirect
                         : ExternalRouteMode::GraveyardBoardPath;
    candidate.routeScore = path.cost + crowding * 12 + preference;
    candidate.routeCost = candidate.routeScore + 500;
    candidate.crowdingCost = crowding;
    candidate.preferenceCost = preference;
    candidate.rawPathSquares = path.rawPathSquares;
    candidate.compressedPathSquares = path.compressedPathSquares;
    for (std::size_t index = 1; index < path.compressedPathSquares.size(); ++index) {
      candidate.targets.push_back(squareTarget(path.compressedPathSquares[index]));
    }
    candidate.targets.push_back(coordinateTarget(slot, "graveyard"));
    result.candidates.push_back(std::move(candidate));
  }

  if (result.candidates.empty()) {
    result.status = hasFreeSlot
                        ? ExternalRouteStatus::NoGraveyardPath
                        : ExternalRouteStatus::NoGraveyardCapacity;
    result.blockedReason = hasFreeSlot
                               ? "No clear graveyard route was found."
                               : "No robot graveyard slot is available.";
    return result;
  }

  const std::vector<ExternalSlot> ordered = sortedRobotGraveyardSlots(slots);
  std::stable_sort(result.candidates.begin(), result.candidates.end(), [&](const GraveyardRouteCandidate& left,
                                                                          const GraveyardRouteCandidate& right) {
    const double scoreDelta = left.routeScore - right.routeScore;
    if (std::abs(scoreDelta) > 0.001) return scoreDelta < 0;
    const auto leftPosition = std::find_if(ordered.begin(), ordered.end(), [&](const ExternalSlot& slot) {
      return externalSlotKey(slot) == externalSlotKey(left.slot);
    });
    const auto rightPosition = std::find_if(ordered.begin(), ordered.end(), [&](const ExternalSlot& slot) {
      return externalSlotKey(slot) == externalSlotKey(right.slot);
    });
    return leftPosition < rightPosition;
  });
  result.status = ExternalRouteStatus::Success;
  result.selected = result.candidates.front();
  return result;
}

const char* externalRouteStatusName(ExternalRouteStatus status) {
  switch (status) {
    case ExternalRouteStatus::Success: return "success";
    case ExternalRouteStatus::InvalidRequest: return "invalid_request";
    case ExternalRouteStatus::NoLanePath: return "no_lane_path";
    case ExternalRouteStatus::NoGraveyardCapacity: return "no_graveyard_capacity";
    case ExternalRouteStatus::NoGraveyardPath: return "no_graveyard_path";
    default: return "unknown";
  }
}

const char* externalRouteModeName(ExternalRouteMode mode) {
  switch (mode) {
    case ExternalRouteMode::Direct: return "direct";
    case ExternalRouteMode::BoardDirect: return "board-direct";
    case ExternalRouteMode::BoardLine: return "board-line";
    case ExternalRouteMode::BoardBuffered: return "board-buffered";
    case ExternalRouteMode::BoardRelaxed: return "board-relaxed";
    case ExternalRouteMode::Lane: return "lane";
    case ExternalRouteMode::LaneBoard: return "lane-board";
    case ExternalRouteMode::GraveyardDirect: return "graveyard-direct";
    case ExternalRouteMode::GraveyardBoardPath: return "graveyard-board-path";
    default: return "unknown";
  }
}

}  // namespace offline
