#pragma once

#include "offline_engine.h"
#include "offline_physical.h"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace offline {

enum class OfflineTurnPhase {
  HumanTurn,
  HumanPromotionPending,
  EngineSearchNeeded,
  OpponentMoveReady,
  OpponentMoveExecuting,
  OpponentPromotionPending,
  GameOver,
  SyncWarning,
  Error
};

enum class OfflineTurnEvent {
  None,
  HumanSnapshotProcessed,
  HumanMoveAccepted,
  EngineSearchRequested,
  EngineResultRejected,
  OpponentMoveStaged,
  OpponentExecutionStarted,
  OpponentRetryReady,
  OpponentMoveVerified,
  OpponentPromotionRequired,
  PromotionConfirmationRejected,
  GameEnded,
  RestoreRequired,
  Error
};

struct OfflineCoordinatorConfig {
  HumanColor humanColor = HumanColor::White;
  SearchLimits searchLimits;
};

struct EngineSearchRequest {
  std::uint32_t generation = 0;
  std::string fen;
  SearchLimits limits;
};

struct OpponentMovePlan {
  SearchResult search;
  MoveInfo move;
  std::string beforeFen;
  std::string afterFen;
  Occupancy beforeOccupancy{};
  Occupancy expectedOccupancy{};
  GameStatus expectedStatus;
};

struct OfflineTurnResult {
  OfflineTurnPhase phase = OfflineTurnPhase::HumanTurn;
  OfflineTurnEvent event = OfflineTurnEvent::None;
  PhysicalPhase physicalPhase = PhysicalPhase::Ready;
  std::optional<SnapshotResult> physicalResult;
  std::optional<EngineSearchRequest> engineRequest;
  std::optional<OpponentMovePlan> opponentPlan;
  std::optional<MoveInfo> acceptedMove;
  OccupancyDiff differenceFromBefore;
  OccupancyDiff differenceFromExpected;
  GameStatus gameStatus;
  std::string message;
};

class OfflineTurnCoordinator {
 public:
  explicit OfflineTurnCoordinator(OfflineCoordinatorConfig config = {});

  void reset();
  bool loadFen(std::string_view fen);

  OfflineTurnResult processHumanSnapshot(const Occupancy& occupancy);
  OfflineTurnResult confirmHumanPromotion(char promotionPiece);

  [[nodiscard]] std::optional<EngineSearchRequest> pendingEngineRequest() const;
  OfflineTurnResult submitEngineResult(
      std::uint32_t generation, const SearchResult& searchResult);

  OfflineTurnResult beginOpponentExecution();
  OfflineTurnResult completeOpponentExecution(const Occupancy& finalOccupancy);
  OfflineTurnResult processRecoverySnapshot(const Occupancy& occupancy);
  OfflineTurnResult confirmOpponentPromotion(char promotionPiece);

  [[nodiscard]] OfflineTurnResult currentState() const;
  [[nodiscard]] OfflineTurnPhase phase() const { return phase_; }
  [[nodiscard]] const OfflinePhysicalController& physical() const { return physical_; }

 private:
  enum class SyncContext { None, HumanMove, OpponentExecution };

  void initializePhase();
  void requestEngineSearch();
  OfflineTurnResult handleHumanResult(SnapshotResult result);
  OfflineTurnResult handleOpponentOccupancy(const Occupancy& occupancy);
  OfflineTurnResult commitOpponentMove();
  OfflineTurnResult resultFor(OfflineTurnEvent event, std::string message = {}) const;

  OfflineCoordinatorConfig config_;
  OfflinePhysicalController physical_;
  OfflineTurnPhase phase_ = OfflineTurnPhase::HumanTurn;
  SyncContext syncContext_ = SyncContext::None;
  std::uint32_t nextGeneration_ = 0;
  std::optional<EngineSearchRequest> engineRequest_;
  std::optional<OpponentMovePlan> opponentPlan_;
  std::optional<Occupancy> verifiedPromotionOccupancy_;
};

const char* offlineTurnPhaseName(OfflineTurnPhase phase);
const char* offlineTurnEventName(OfflineTurnEvent event);

}  // namespace offline
