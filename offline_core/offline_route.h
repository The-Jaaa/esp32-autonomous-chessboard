#pragma once

#include "offline_physical.h"

#include <optional>
#include <string>
#include <vector>

namespace offline {

enum class BoardRouteStatus {
  Success,
  InvalidRequest,
  UnsupportedMove,
  NoBoardPath
};

enum class BoardRouteMode {
  Direct,
  BoardDirect,
  BoardLine,
  BoardBuffered,
  BoardRelaxed
};

struct BoardRouteRequest {
  std::string from;
  std::string to;
  Occupancy expectedOccupancy{};
  std::optional<Occupancy> sensedOccupancy;
  std::vector<std::string> ignoredSquares;
  bool directWhenClear = false;
  bool preferClearLine = true;
};

struct BoardRouteResult {
  BoardRouteStatus status = BoardRouteStatus::InvalidRequest;
  BoardRouteMode mode = BoardRouteMode::BoardDirect;
  int cost = 0;
  std::vector<std::string> rawPathSquares;
  std::vector<std::string> compressedPathSquares;
  std::string blockedReason;

  [[nodiscard]] bool success() const { return status == BoardRouteStatus::Success; }
};

class OfflineBoardRoutePlanner {
 public:
  [[nodiscard]] BoardRouteResult plan(const BoardRouteRequest& request) const;

  [[nodiscard]] BoardRouteResult planQuietMove(
      const OfflineGame& game,
      const MoveInfo& move,
      const std::optional<Occupancy>& sensedOccupancy = std::nullopt,
      const std::vector<std::string>& ignoredSquares = {}) const;
};

const char* boardRouteStatusName(BoardRouteStatus status);
const char* boardRouteModeName(BoardRouteMode mode);

}  // namespace offline
