#pragma once

#include "offline_game.h"

#include <array>
#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace offline {

using Occupancy = std::array<bool, 64>;

enum class HumanColor { White, Black };

enum class PhysicalPhase {
  Ready,
  WaitingForOpponent,
  PieceLifted,
  CapturePending,
  CastlePendingRook,
  PromotionPending,
  SyncWarning
};

enum class PhysicalEvent {
  None,
  PieceLifted,
  MoveCancelled,
  CaptureTargetRemoved,
  RookRequired,
  PromotionChoiceRequired,
  InvalidPromotionChoice,
  MoveAccepted,
  RestoreRequired
};

enum class HighlightRole {
  Source,
  QuietTarget,
  CaptureTarget,
  SpecialTarget,
  RookSource,
  RookTarget,
  Missing,
  Extra
};

struct OccupancyDiff {
  std::vector<std::string> missing;
  std::vector<std::string> extra;

  [[nodiscard]] bool empty() const { return missing.empty() && extra.empty(); }
};

struct Highlight {
  std::string square;
  int rawIndex = -1;
  HighlightRole role = HighlightRole::Source;
};

struct SnapshotResult {
  PhysicalPhase phase = PhysicalPhase::Ready;
  PhysicalEvent event = PhysicalEvent::None;
  std::vector<std::string> legalTargets;
  std::vector<Highlight> highlights;
  OccupancyDiff diff;
  std::optional<MoveInfo> acceptedMove;
  std::string message;
};

int squareToRawIndex(std::string_view square);
std::string rawIndexToSquare(std::size_t rawIndex);
Occupancy occupancyFromFen(std::string_view fen);
OccupancyDiff compareOccupancy(const Occupancy& expected, const Occupancy& actual);

const char* physicalPhaseName(PhysicalPhase phase);
const char* physicalEventName(PhysicalEvent event);

class OfflinePhysicalController {
 public:
  explicit OfflinePhysicalController(HumanColor humanColor = HumanColor::White);

  bool loadFen(std::string_view fen);
  void reset();

  SnapshotResult processSnapshot(const Occupancy& occupancy);
  SnapshotResult confirmPromotion(char promotionPiece);

  [[nodiscard]] HumanColor humanColor() const { return humanColor_; }
  [[nodiscard]] PhysicalPhase phase() const { return phase_; }
  [[nodiscard]] const OfflineGame& game() const { return game_; }
  [[nodiscard]] const Occupancy& committedOccupancy() const { return committedOccupancy_; }

 private:
  SnapshotResult resultFor(const Occupancy& occupancy, PhysicalEvent event, std::string message = {}) const;
  SnapshotResult enterSyncWarning(const Occupancy& occupancy, std::string message);
  SnapshotResult acceptMove(const std::string& uci, const Occupancy& occupancy);
  SnapshotResult beginPromotion(const std::vector<MoveInfo>& moves, const Occupancy& occupancy);
  void resetInteraction();
  void refreshTurnPhase();
  std::vector<MoveInfo> legalMovesFrom(const std::string& source) const;

  HumanColor humanColor_;
  OfflineGame game_;
  Occupancy committedOccupancy_{};
  PhysicalPhase phase_ = PhysicalPhase::Ready;
  std::string source_;
  std::vector<MoveInfo> sourceMoves_;
  std::vector<MoveInfo> pendingMoves_;
  std::optional<MoveInfo> pendingCastle_;
  Occupancy pendingPromotionOccupancy_{};
  bool hasPendingPromotionOccupancy_ = false;
  Occupancy lastSnapshot_{};
  bool hasLastSnapshot_ = false;
};

}  // namespace offline
