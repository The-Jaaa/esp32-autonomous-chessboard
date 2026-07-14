#pragma once

#include "offline_engine.h"
#include "offline_motion.h"
#include "offline_physical.h"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace offline {

enum class OfflineTurnPhase {
  HumanTurn,
  HumanPromotionPending,
  EngineSearchNeeded,
  OpponentMoveReady,
  OpponentMoveExecuting,
  OpponentMotionBlocked,
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
  OpponentMotionBlocked,
  OpponentExecutionStarted,
  OpponentPhaseVerified,
  OpponentPhaseRetryReady,
  GraveyardConfirmationRequired,
  OpponentRetryReady,
  OpponentMoveVerified,
  OpponentPromotionRequired,
  OpponentPromotionReplacementInProgress,
  OpponentPromotionConfirmationReady,
  PromotionConfirmationRejected,
  GameEnded,
  RestoreRequired,
  Error
};

struct OfflineCoordinatorConfig {
  HumanColor humanColor = HumanColor::White;
  SearchLimits searchLimits;
  std::vector<ExternalSlot> externalSlots;
  std::vector<std::string> initialOccupiedGraveyardKeys;
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

enum class GraveyardSlotState {
  Free,
  Pending,
  Occupied
};

struct MotionCandidateFailure {
  std::string uci;
  int score = 0;
  int mateIn = 0;
  MotionPlanStatus status = MotionPlanStatus::InvalidMove;
  std::string reason;
};

struct MotionExecutionTransaction {
  std::uint32_t transactionId = 0;
  std::uint32_t engineGeneration = 0;
  std::string preferredMove;
  std::string selectedMove;
  int selectedScore = 0;
  int selectedMateIn = 0;
  bool usedFallback = false;
  std::string fallbackReason;
  SearchResult search;
  MotionPlan motion;
  std::size_t currentPhase = 0;
  std::vector<bool> verifiedPhases;
  std::string graveyardSlotKey;
  GraveyardSlotState graveyardState = GraveyardSlotState::Free;
  std::vector<MotionCandidateFailure> rejectedCandidates;
};

struct OpponentPhaseReport {
  std::uint32_t transactionId = 0;
  std::size_t phaseIndex = 0;
  bool success = false;
  Occupancy occupancy{};
};

struct OfflineTurnResult {
  OfflineTurnPhase phase = OfflineTurnPhase::HumanTurn;
  OfflineTurnEvent event = OfflineTurnEvent::None;
  PhysicalPhase physicalPhase = PhysicalPhase::Ready;
  std::optional<SnapshotResult> physicalResult;
  std::optional<EngineSearchRequest> engineRequest;
  std::optional<OpponentMovePlan> opponentPlan;
  std::optional<MotionExecutionTransaction> motionTransaction;
  std::optional<MoveInfo> acceptedMove;
  std::vector<std::string> occupiedGraveyardKeys;
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
  OfflineTurnResult submitEngineResult(
      std::uint32_t generation,
      const SearchResult& searchResult,
      const Occupancy& sensedOccupancy);
  OfflineTurnResult retryOpponentMotionPlanning(const Occupancy& sensedOccupancy);

  OfflineTurnResult beginOpponentExecution();
  OfflineTurnResult completeOpponentPhase(const OpponentPhaseReport& report);
  OfflineTurnResult completeOpponentExecution(const Occupancy& finalOccupancy);
  OfflineTurnResult processOpponentPromotionSnapshot(const Occupancy& occupancy);
  OfflineTurnResult processRecoverySnapshot(const Occupancy& occupancy);
  OfflineTurnResult confirmGraveyardSlotReleased(
      std::uint32_t transactionId,
      std::string_view slotKey,
      const Occupancy& restoredOccupancy);
  OfflineTurnResult confirmOpponentPromotion(char promotionPiece);
  OfflineTurnResult confirmOpponentPromotion(
      char promotionPiece, const Occupancy& occupancy);

  [[nodiscard]] OfflineTurnResult currentState() const;
  [[nodiscard]] OfflineTurnPhase phase() const { return phase_; }
  [[nodiscard]] const OfflinePhysicalController& physical() const { return physical_; }
  [[nodiscard]] std::optional<MotionExecutionTransaction> pendingMotionTransaction() const {
    return motionTransaction_;
  }
  [[nodiscard]] const std::vector<std::string>& occupiedGraveyardKeys() const {
    return occupiedGraveyardKeys_;
  }

 private:
  enum class SyncContext {
    None,
    HumanMove,
    MotionPlanning,
    OpponentExecution,
    OpponentPhase,
    OpponentPromotion
  };

  void initializePhase();
  void requestEngineSearch();
  OfflineTurnResult planOpponentMotion(
      std::uint32_t generation,
      const SearchResult& searchResult,
      const Occupancy& sensedOccupancy);
  OfflineTurnResult handleHumanResult(SnapshotResult result);
  OfflineTurnResult handleOpponentOccupancy(const Occupancy& occupancy);
  OfflineTurnResult handlePhaseRecovery(const Occupancy& occupancy);
  OfflineTurnResult handleOpponentPromotionSnapshot(const Occupancy& occupancy);
  OfflineTurnResult finishVerifiedOpponentMotion(const Occupancy& occupancy);
  OfflineTurnResult commitOpponentMove();
  void clearOpponentTransaction();
  void resetTransactionForRetry();
  OfflineTurnResult resultFor(OfflineTurnEvent event, std::string message = {}) const;

  OfflineCoordinatorConfig config_;
  OfflinePhysicalController physical_;
  OfflineTurnPhase phase_ = OfflineTurnPhase::HumanTurn;
  SyncContext syncContext_ = SyncContext::None;
  std::uint32_t nextGeneration_ = 0;
  std::uint32_t nextTransactionId_ = 0;
  std::optional<EngineSearchRequest> engineRequest_;
  std::optional<OpponentMovePlan> opponentPlan_;
  std::optional<MotionExecutionTransaction> motionTransaction_;
  std::optional<SearchResult> retainedSearchResult_;
  std::uint32_t retainedSearchGeneration_ = 0;
  std::vector<std::string> occupiedGraveyardKeys_;
  std::optional<Occupancy> verifiedPromotionOccupancy_;
  std::optional<char> lastConfirmedOpponentPromotion_;
  std::optional<Occupancy> lastConfirmedPromotionOccupancy_;
};

const char* offlineTurnPhaseName(OfflineTurnPhase phase);
const char* offlineTurnEventName(OfflineTurnEvent event);
const char* graveyardSlotStateName(GraveyardSlotState state);

}  // namespace offline
