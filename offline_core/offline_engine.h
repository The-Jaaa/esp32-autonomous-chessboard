#pragma once

#include "offline_game.h"

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace offline {

enum class SearchStopReason {
  Complete,
  TimeLimit,
  DepthLimit,
  NodeLimit,
  TerminalPosition,
  InvalidFen
};

struct SearchLimits {
  std::uint32_t timeLimitMs = 3000;
  std::uint64_t maxNodes = 0;
  int maxDepth = 12;
  bool useTranspositionTable = true;
};

struct RootMoveScore {
  std::string uci;
  int score = 0;
  int mateIn = 0;
};

struct SearchResult {
  std::string bestMove;
  int score = 0;
  int mateIn = 0;
  int completedDepth = 0;
  std::uint64_t nodes = 0;
  std::uint32_t elapsedMs = 0;
  std::vector<std::string> principalVariation;
  std::vector<RootMoveScore> rankedRootMoves;
  SearchStopReason stopReason = SearchStopReason::InvalidFen;
  GameOutcome outcome = GameOutcome::Ongoing;

  [[nodiscard]] bool hasMove() const { return !bestMove.empty(); }
};

class OfflineEngine {
 public:
  [[nodiscard]] SearchResult searchFen(
      std::string_view fen, const SearchLimits& limits = SearchLimits{}) const;
};

const char* searchStopReasonName(SearchStopReason reason);

}  // namespace offline
