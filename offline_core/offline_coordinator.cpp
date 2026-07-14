#include "offline_coordinator.h"

#include <algorithm>
#include <cctype>
#include <set>
#include <utility>

namespace offline {
namespace {

bool isTerminal(const GameStatus& status) {
  return status.outcome != GameOutcome::Ongoing;
}

bool isUsableSearchResult(const SearchResult& result) {
  if (!result.hasMove()) return false;
  switch (result.stopReason) {
    case SearchStopReason::Complete:
    case SearchStopReason::TimeLimit:
    case SearchStopReason::DepthLimit:
    case SearchStopReason::NodeLimit:
      return true;
    case SearchStopReason::TerminalPosition:
    case SearchStopReason::InvalidFen:
      return false;
    default:
      return false;
  }
}

bool isPromotionChoice(char piece) {
  return piece == 'q' || piece == 'r' || piece == 'b' || piece == 'n';
}

std::string upper(std::string_view value) {
  std::string result(value);
  std::transform(result.begin(), result.end(), result.begin(), [](unsigned char character) {
    return static_cast<char>(std::toupper(character));
  });
  return result;
}

struct ScoredMotionCandidate {
  std::string uci;
  int score = 0;
  int mateIn = 0;
  MotionPlan motion;
};

std::vector<RootMoveScore> orderedRootCandidates(const SearchResult& result) {
  std::vector<RootMoveScore> candidates;
  std::set<std::string> seen;

  auto add = [&](const std::string& uci, int score, int mateIn) {
    if (uci.empty() || !seen.insert(uci).second) return;
    candidates.push_back({uci, score, mateIn});
  };

  const auto best = std::find_if(
      result.rankedRootMoves.begin(), result.rankedRootMoves.end(),
      [&](const RootMoveScore& candidate) { return candidate.uci == result.bestMove; });
  add(result.bestMove,
      best == result.rankedRootMoves.end() ? result.score : best->score,
      best == result.rankedRootMoves.end() ? result.mateIn : best->mateIn);
  for (const RootMoveScore& candidate : result.rankedRootMoves) {
    add(candidate.uci, candidate.score, candidate.mateIn);
  }
  return candidates;
}

bool routeTieEligible(
    const ScoredMotionCandidate& strongest,
    const ScoredMotionCandidate& candidate) {
  return strongest.mateIn == 0 && candidate.mateIn == 0 &&
         candidate.score >= strongest.score - 5;
}

}  // namespace

const char* offlineTurnPhaseName(OfflineTurnPhase phase) {
  switch (phase) {
    case OfflineTurnPhase::HumanTurn: return "human_turn";
    case OfflineTurnPhase::HumanPromotionPending: return "human_promotion_pending";
    case OfflineTurnPhase::EngineSearchNeeded: return "engine_search_needed";
    case OfflineTurnPhase::OpponentMoveReady: return "opponent_move_ready";
    case OfflineTurnPhase::OpponentMoveExecuting: return "opponent_move_executing";
    case OfflineTurnPhase::OpponentMotionBlocked: return "opponent_motion_blocked";
    case OfflineTurnPhase::OpponentPromotionPending: return "opponent_promotion_pending";
    case OfflineTurnPhase::GameOver: return "game_over";
    case OfflineTurnPhase::SyncWarning: return "sync_warning";
    case OfflineTurnPhase::Error: return "error";
    default: return "unknown";
  }
}

const char* offlineTurnEventName(OfflineTurnEvent event) {
  switch (event) {
    case OfflineTurnEvent::None: return "none";
    case OfflineTurnEvent::HumanSnapshotProcessed: return "human_snapshot_processed";
    case OfflineTurnEvent::HumanMoveAccepted: return "human_move_accepted";
    case OfflineTurnEvent::EngineSearchRequested: return "engine_search_requested";
    case OfflineTurnEvent::EngineResultRejected: return "engine_result_rejected";
    case OfflineTurnEvent::OpponentMoveStaged: return "opponent_move_staged";
    case OfflineTurnEvent::OpponentMotionBlocked: return "opponent_motion_blocked";
    case OfflineTurnEvent::OpponentExecutionStarted: return "opponent_execution_started";
    case OfflineTurnEvent::OpponentPhaseVerified: return "opponent_phase_verified";
    case OfflineTurnEvent::OpponentPhaseRetryReady: return "opponent_phase_retry_ready";
    case OfflineTurnEvent::GraveyardConfirmationRequired: return "graveyard_confirmation_required";
    case OfflineTurnEvent::OpponentRetryReady: return "opponent_retry_ready";
    case OfflineTurnEvent::OpponentMoveVerified: return "opponent_move_verified";
    case OfflineTurnEvent::OpponentPromotionRequired: return "opponent_promotion_required";
    case OfflineTurnEvent::PromotionConfirmationRejected: return "promotion_confirmation_rejected";
    case OfflineTurnEvent::GameEnded: return "game_ended";
    case OfflineTurnEvent::RestoreRequired: return "restore_required";
    case OfflineTurnEvent::Error: return "error";
    default: return "unknown";
  }
}

const char* graveyardSlotStateName(GraveyardSlotState state) {
  switch (state) {
    case GraveyardSlotState::Free: return "free";
    case GraveyardSlotState::Pending: return "pending";
    case GraveyardSlotState::Occupied: return "occupied";
    default: return "unknown";
  }
}

OfflineTurnCoordinator::OfflineTurnCoordinator(OfflineCoordinatorConfig config)
    : config_(std::move(config)), physical_(config_.humanColor) {
  config_.externalSlots = normalizeExternalSlots(config_.externalSlots);
  for (const std::string& key : config_.initialOccupiedGraveyardKeys) {
    occupiedGraveyardKeys_ = reserveVerifiedSlot(occupiedGraveyardKeys_, key);
  }
  initializePhase();
}

void OfflineTurnCoordinator::reset() {
  physical_.reset();
  engineRequest_.reset();
  clearOpponentTransaction();
  occupiedGraveyardKeys_.clear();
  for (const std::string& key : config_.initialOccupiedGraveyardKeys) {
    occupiedGraveyardKeys_ = reserveVerifiedSlot(occupiedGraveyardKeys_, key);
  }
  verifiedPromotionOccupancy_.reset();
  syncContext_ = SyncContext::None;
  initializePhase();
}

bool OfflineTurnCoordinator::loadFen(std::string_view fen) {
  if (!physical_.loadFen(fen)) return false;
  engineRequest_.reset();
  clearOpponentTransaction();
  occupiedGraveyardKeys_.clear();
  for (const std::string& key : config_.initialOccupiedGraveyardKeys) {
    occupiedGraveyardKeys_ = reserveVerifiedSlot(occupiedGraveyardKeys_, key);
  }
  verifiedPromotionOccupancy_.reset();
  syncContext_ = SyncContext::None;
  initializePhase();
  return true;
}

void OfflineTurnCoordinator::initializePhase() {
  if (isTerminal(physical_.game().status())) {
    phase_ = OfflineTurnPhase::GameOver;
    return;
  }
  if (physical_.phase() == PhysicalPhase::WaitingForOpponent) {
    requestEngineSearch();
    return;
  }
  phase_ = OfflineTurnPhase::HumanTurn;
}

void OfflineTurnCoordinator::requestEngineSearch() {
  clearOpponentTransaction();
  EngineSearchRequest request;
  request.generation = ++nextGeneration_;
  request.fen = physical_.game().fen();
  request.limits = config_.searchLimits;
  engineRequest_ = std::move(request);
  phase_ = OfflineTurnPhase::EngineSearchNeeded;
}

OfflineTurnResult OfflineTurnCoordinator::resultFor(
    OfflineTurnEvent event, std::string message) const {
  OfflineTurnResult result;
  result.phase = phase_;
  result.event = event;
  result.physicalPhase = physical_.phase();
  result.engineRequest = engineRequest_;
  result.opponentPlan = opponentPlan_;
  result.motionTransaction = motionTransaction_;
  result.occupiedGraveyardKeys = occupiedGraveyardKeys_;
  result.gameStatus = physical_.game().status();
  result.message = std::move(message);
  if (opponentPlan_) {
    result.differenceFromBefore = compareOccupancy(
        opponentPlan_->beforeOccupancy, physical_.committedOccupancy());
    result.differenceFromExpected = compareOccupancy(
        opponentPlan_->expectedOccupancy, physical_.committedOccupancy());
  }
  return result;
}

OfflineTurnResult OfflineTurnCoordinator::currentState() const {
  return resultFor(OfflineTurnEvent::None);
}

std::optional<EngineSearchRequest> OfflineTurnCoordinator::pendingEngineRequest() const {
  return engineRequest_;
}

void OfflineTurnCoordinator::clearOpponentTransaction() {
  opponentPlan_.reset();
  motionTransaction_.reset();
  retainedSearchResult_.reset();
  retainedSearchGeneration_ = 0;
  verifiedPromotionOccupancy_.reset();
}

void OfflineTurnCoordinator::resetTransactionForRetry() {
  if (!motionTransaction_) return;
  motionTransaction_->currentPhase = 0;
  std::fill(
      motionTransaction_->verifiedPhases.begin(),
      motionTransaction_->verifiedPhases.end(), false);
  syncContext_ = SyncContext::None;
  phase_ = OfflineTurnPhase::OpponentMoveReady;
}

OfflineTurnResult OfflineTurnCoordinator::handleHumanResult(SnapshotResult result) {
  const PhysicalPhase physicalPhase = result.phase;
  const PhysicalEvent physicalEvent = result.event;
  const std::optional<MoveInfo> acceptedMove = result.acceptedMove;
  const std::string physicalMessage = result.message;

  if (physicalPhase == PhysicalPhase::SyncWarning) {
    phase_ = OfflineTurnPhase::SyncWarning;
    syncContext_ = SyncContext::HumanMove;
  } else if (physicalPhase == PhysicalPhase::PromotionPending) {
    phase_ = OfflineTurnPhase::HumanPromotionPending;
  } else if (physicalEvent == PhysicalEvent::MoveAccepted) {
    syncContext_ = SyncContext::None;
    if (isTerminal(physical_.game().status())) {
      phase_ = OfflineTurnPhase::GameOver;
    } else {
      requestEngineSearch();
    }
  } else {
    phase_ = OfflineTurnPhase::HumanTurn;
    syncContext_ = SyncContext::None;
  }

  const OfflineTurnEvent event = physicalEvent == PhysicalEvent::MoveAccepted
                                     ? (phase_ == OfflineTurnPhase::GameOver
                                            ? OfflineTurnEvent::GameEnded
                                            : OfflineTurnEvent::HumanMoveAccepted)
                                     : (phase_ == OfflineTurnPhase::SyncWarning
                                            ? OfflineTurnEvent::RestoreRequired
                                            : OfflineTurnEvent::HumanSnapshotProcessed);
  OfflineTurnResult output = resultFor(event, physicalMessage);
  output.physicalResult = std::move(result);
  output.acceptedMove = acceptedMove;
  return output;
}

OfflineTurnResult OfflineTurnCoordinator::processHumanSnapshot(const Occupancy& occupancy) {
  if (phase_ == OfflineTurnPhase::SyncWarning && syncContext_ == SyncContext::HumanMove) {
    return handleHumanResult(physical_.processSnapshot(occupancy));
  }
  if (phase_ != OfflineTurnPhase::HumanTurn &&
      phase_ != OfflineTurnPhase::HumanPromotionPending) {
    return resultFor(OfflineTurnEvent::Error, "A human snapshot is not accepted in the current turn phase.");
  }
  return handleHumanResult(physical_.processSnapshot(occupancy));
}

OfflineTurnResult OfflineTurnCoordinator::confirmHumanPromotion(char promotionPiece) {
  if (phase_ != OfflineTurnPhase::HumanPromotionPending) {
    return resultFor(OfflineTurnEvent::PromotionConfirmationRejected,
                     "No human promotion is waiting for confirmation.");
  }
  SnapshotResult physicalResult = physical_.confirmPromotion(promotionPiece);
  const bool rejected = physicalResult.event == PhysicalEvent::InvalidPromotionChoice;
  OfflineTurnResult result = handleHumanResult(std::move(physicalResult));
  if (rejected) result.event = OfflineTurnEvent::PromotionConfirmationRejected;
  return result;
}

OfflineTurnResult OfflineTurnCoordinator::submitEngineResult(
    std::uint32_t generation, const SearchResult& searchResult) {
  return submitEngineResult(generation, searchResult, physical_.committedOccupancy());
}

OfflineTurnResult OfflineTurnCoordinator::submitEngineResult(
    std::uint32_t generation,
    const SearchResult& searchResult,
    const Occupancy& sensedOccupancy) {
  if (phase_ != OfflineTurnPhase::EngineSearchNeeded || !engineRequest_) {
    return resultFor(OfflineTurnEvent::EngineResultRejected,
                     "No engine search result is currently expected.");
  }
  if (generation != engineRequest_->generation) {
    return resultFor(OfflineTurnEvent::EngineResultRejected,
                     "Stale engine result rejected; the current request remains active.");
  }

  OpponentMovePreview preferredPreview;
  if (!isUsableSearchResult(searchResult) ||
      !physical_.previewOpponentMove(searchResult.bestMove, preferredPreview)) {
    requestEngineSearch();
    return resultFor(OfflineTurnEvent::EngineResultRejected,
                     "Engine result was empty, terminal, or illegal; a fresh search is required.");
  }

  retainedSearchResult_ = searchResult;
  retainedSearchGeneration_ = generation;
  return planOpponentMotion(generation, searchResult, sensedOccupancy);
}

OfflineTurnResult OfflineTurnCoordinator::planOpponentMotion(
    std::uint32_t generation,
    const SearchResult& searchResult,
    const Occupancy& sensedOccupancy) {
  const Occupancy& committed = physical_.committedOccupancy();
  if (sensedOccupancy != committed) {
    phase_ = OfflineTurnPhase::SyncWarning;
    syncContext_ = SyncContext::MotionPlanning;
    OfflineTurnResult result = resultFor(
        OfflineTurnEvent::RestoreRequired,
        "Robot planning paused because sensed occupancy differs from the committed board.");
    result.differenceFromBefore = compareOccupancy(committed, sensedOccupancy);
    result.differenceFromExpected = result.differenceFromBefore;
    return result;
  }

  MotionPlanningContext context;
  context.sensedOccupancy = sensedOccupancy;
  context.slots = config_.externalSlots;
  context.occupiedGraveyardKeys = occupiedGraveyardKeys_;

  OfflineMotionPlanner planner;
  std::vector<ScoredMotionCandidate> routable;
  std::vector<MotionCandidateFailure> rejected;
  const std::vector<RootMoveScore> candidates = orderedRootCandidates(searchResult);
  for (const RootMoveScore& candidate : candidates) {
    OpponentMovePreview preview;
    if (!physical_.previewOpponentMove(candidate.uci, preview)) {
      rejected.push_back({candidate.uci, candidate.score, candidate.mateIn,
                          MotionPlanStatus::InvalidMove, "Engine candidate is not legal."});
      continue;
    }
    if (!preview.move.promotion.empty()) {
      rejected.push_back({candidate.uci, candidate.score, candidate.mateIn,
                          MotionPlanStatus::UnsupportedPromotion,
                          "Opponent promotion choreography is not implemented yet."});
      continue;
    }

    MotionPlan motion = planner.planMove(physical_.game(), candidate.uci, context);
    if (!motion.success()) {
      rejected.push_back({candidate.uci, candidate.score, candidate.mateIn,
                          motion.status, motion.blockedReason});
      continue;
    }
    routable.push_back({candidate.uci, candidate.score, candidate.mateIn,
                        std::move(motion)});
  }

  if (routable.empty()) {
    MotionExecutionTransaction blocked;
    blocked.transactionId = ++nextTransactionId_;
    blocked.engineGeneration = generation;
    blocked.preferredMove = searchResult.bestMove;
    blocked.search = searchResult;
    blocked.rejectedCandidates = std::move(rejected);
    motionTransaction_ = std::move(blocked);
    opponentPlan_.reset();
    engineRequest_.reset();
    syncContext_ = SyncContext::None;
    phase_ = OfflineTurnPhase::OpponentMotionBlocked;
    return resultFor(
        OfflineTurnEvent::OpponentMotionBlocked,
        "No non-promotion engine candidate has a safe physical route.");
  }

  std::size_t selectedIndex = 0;
  const ScoredMotionCandidate& strongest = routable.front();
  for (std::size_t index = 1; index < routable.size(); ++index) {
    if (!routeTieEligible(strongest, routable[index])) break;
    const ScoredMotionCandidate& current = routable[selectedIndex];
    const ScoredMotionCandidate& candidate = routable[index];
    if (candidate.motion.routeCost < current.motion.routeCost ||
        (candidate.motion.routeCost == current.motion.routeCost && candidate.uci < current.uci)) {
      selectedIndex = index;
    }
  }
  ScoredMotionCandidate selected = std::move(routable[selectedIndex]);

  OpponentMovePreview preview;
  if (!physical_.previewOpponentMove(selected.uci, preview)) {
    phase_ = OfflineTurnPhase::Error;
    return resultFor(OfflineTurnEvent::Error,
                     "Selected routed candidate could not be previewed again.");
  }

  OpponentMovePlan plan;
  plan.search = searchResult;
  plan.move = preview.move;
  plan.beforeFen = preview.beforeFen;
  plan.afterFen = preview.afterFen;
  plan.beforeOccupancy = physical_.committedOccupancy();
  plan.expectedOccupancy = preview.expectedOccupancy;
  plan.expectedStatus = preview.expectedStatus;
  opponentPlan_ = std::move(plan);

  MotionExecutionTransaction transaction;
  transaction.transactionId = ++nextTransactionId_;
  transaction.engineGeneration = generation;
  transaction.preferredMove = searchResult.bestMove;
  transaction.selectedMove = selected.uci;
  transaction.selectedScore = selected.score;
  transaction.selectedMateIn = selected.mateIn;
  transaction.usedFallback = selected.uci != searchResult.bestMove;
  transaction.search = searchResult;
  transaction.motion = std::move(selected.motion);
  transaction.verifiedPhases.assign(transaction.motion.phases.size(), false);
  transaction.rejectedCandidates = std::move(rejected);
  if (transaction.usedFallback) {
    const auto preferredFailure = std::find_if(
        transaction.rejectedCandidates.begin(), transaction.rejectedCandidates.end(),
        [&](const MotionCandidateFailure& failure) {
          return failure.uci == searchResult.bestMove;
        });
    transaction.fallbackReason = preferredFailure == transaction.rejectedCandidates.end()
                                     ? "A near-equal move had a lower physical route cost."
                                     : preferredFailure->reason;
  }
  if (transaction.motion.proposedGraveyardSlot) {
    transaction.graveyardSlotKey = externalSlotKey(
        *transaction.motion.proposedGraveyardSlot);
    transaction.graveyardState = GraveyardSlotState::Pending;
  }
  motionTransaction_ = std::move(transaction);
  engineRequest_.reset();
  verifiedPromotionOccupancy_.reset();
  syncContext_ = SyncContext::None;
  phase_ = OfflineTurnPhase::OpponentMoveReady;
  return resultFor(
      OfflineTurnEvent::OpponentMoveStaged,
      motionTransaction_->usedFallback
          ? "Strongest routable opponent move staged with a physical-route fallback."
          : "Preferred opponent move staged for phase-by-phase physical execution.");
}

OfflineTurnResult OfflineTurnCoordinator::retryOpponentMotionPlanning(
    const Occupancy& sensedOccupancy) {
  const bool planningWarning = phase_ == OfflineTurnPhase::SyncWarning &&
                               syncContext_ == SyncContext::MotionPlanning;
  if ((!planningWarning && phase_ != OfflineTurnPhase::OpponentMotionBlocked) ||
      !retainedSearchResult_ || retainedSearchGeneration_ == 0) {
    return resultFor(OfflineTurnEvent::Error,
                     "No retained engine result is available for motion replanning.");
  }
  motionTransaction_.reset();
  opponentPlan_.reset();
  return planOpponentMotion(
      retainedSearchGeneration_, *retainedSearchResult_, sensedOccupancy);
}

OfflineTurnResult OfflineTurnCoordinator::beginOpponentExecution() {
  if (phase_ == OfflineTurnPhase::OpponentMoveExecuting && opponentPlan_ &&
      motionTransaction_) {
    return resultFor(OfflineTurnEvent::None, "Opponent move execution is already active.");
  }
  if (phase_ != OfflineTurnPhase::OpponentMoveReady || !opponentPlan_ ||
      !motionTransaction_ || motionTransaction_->motion.phases.empty()) {
    return resultFor(OfflineTurnEvent::Error, "No staged opponent move is ready to execute.");
  }
  phase_ = OfflineTurnPhase::OpponentMoveExecuting;
  return resultFor(OfflineTurnEvent::OpponentExecutionStarted, "Opponent move execution started.");
}

OfflineTurnResult OfflineTurnCoordinator::completeOpponentPhase(
    const OpponentPhaseReport& report) {
  if (!motionTransaction_ || !opponentPlan_) {
    if (report.occupancy == physical_.committedOccupancy()) {
      return resultFor(OfflineTurnEvent::None, "Duplicate phase report ignored.");
    }
    return resultFor(OfflineTurnEvent::Error, "No motion transaction is active.");
  }
  MotionExecutionTransaction& transaction = *motionTransaction_;
  if (report.transactionId != transaction.transactionId) {
    return resultFor(OfflineTurnEvent::Error, "Stale motion transaction report rejected.");
  }
  if (report.phaseIndex < transaction.currentPhase &&
      report.phaseIndex < transaction.verifiedPhases.size() &&
      transaction.verifiedPhases[report.phaseIndex] &&
      report.occupancy == transaction.motion.phases[report.phaseIndex].expectedAfter) {
    return resultFor(OfflineTurnEvent::None, "Duplicate verified phase report ignored.");
  }
  if (report.phaseIndex != transaction.currentPhase ||
      report.phaseIndex >= transaction.motion.phases.size()) {
    return resultFor(OfflineTurnEvent::Error, "Out-of-order motion phase report rejected.");
  }
  if (phase_ != OfflineTurnPhase::OpponentMoveExecuting &&
      !(phase_ == OfflineTurnPhase::SyncWarning &&
        syncContext_ == SyncContext::OpponentPhase)) {
    return resultFor(OfflineTurnEvent::Error, "Opponent phase execution is not active.");
  }

  const MotionPhase& motionPhase = transaction.motion.phases[report.phaseIndex];
  if (!report.success && report.occupancy == motionPhase.expectedBefore) {
    phase_ = OfflineTurnPhase::OpponentMoveExecuting;
    syncContext_ = SyncContext::None;
    return resultFor(
        OfflineTurnEvent::OpponentPhaseRetryReady,
        "Motion phase failed without changing occupancy; retry the same phase.");
  }
  if (!report.success || report.occupancy != motionPhase.expectedAfter) {
    phase_ = OfflineTurnPhase::SyncWarning;
    syncContext_ = SyncContext::OpponentPhase;
    OfflineTurnResult result = resultFor(
        OfflineTurnEvent::RestoreRequired,
        "Motion phase report does not match its verified before or after occupancy.");
    result.differenceFromBefore = compareOccupancy(motionPhase.expectedBefore, report.occupancy);
    result.differenceFromExpected = compareOccupancy(motionPhase.expectedAfter, report.occupancy);
    return result;
  }

  transaction.verifiedPhases[report.phaseIndex] = true;
  if (motionPhase.kind == MotionPhaseKind::CapturedRemoval &&
      transaction.graveyardState == GraveyardSlotState::Pending &&
      !transaction.graveyardSlotKey.empty()) {
    occupiedGraveyardKeys_ = reserveVerifiedSlot(
        occupiedGraveyardKeys_, transaction.graveyardSlotKey);
    transaction.graveyardState = GraveyardSlotState::Occupied;
  }
  ++transaction.currentPhase;
  syncContext_ = SyncContext::None;
  if (transaction.currentPhase == transaction.motion.phases.size()) {
    return commitOpponentMove();
  }

  phase_ = OfflineTurnPhase::OpponentMoveExecuting;
  return resultFor(
      OfflineTurnEvent::OpponentPhaseVerified,
      "Motion phase verified; the next phase is ready.");
}

OfflineTurnResult OfflineTurnCoordinator::commitOpponentMove() {
  if (!opponentPlan_) {
    phase_ = OfflineTurnPhase::Error;
    return resultFor(OfflineTurnEvent::Error, "Opponent move metadata is missing.");
  }

  const OpponentMovePlan completedPlan = *opponentPlan_;
  const std::optional<MotionExecutionTransaction> completedTransaction = motionTransaction_;
  const Occupancy& verifiedOccupancy = verifiedPromotionOccupancy_
                                           ? *verifiedPromotionOccupancy_
                                           : completedPlan.expectedOccupancy;
  MoveInfo accepted;
  if (!physical_.commitVerifiedOpponentMove(
          completedPlan.move.uci, verifiedOccupancy, accepted)) {
    phase_ = OfflineTurnPhase::Error;
    return resultFor(OfflineTurnEvent::Error, "Verified opponent move could not be committed.");
  }

  clearOpponentTransaction();
  syncContext_ = SyncContext::None;
  const bool gameOver = isTerminal(physical_.game().status());
  phase_ = gameOver ? OfflineTurnPhase::GameOver : OfflineTurnPhase::HumanTurn;
  OfflineTurnResult result = resultFor(
      gameOver ? OfflineTurnEvent::GameEnded : OfflineTurnEvent::OpponentMoveVerified,
      gameOver ? "Opponent move verified; the game is over."
               : "Opponent move verified; human turn is ready.");
  result.acceptedMove = std::move(accepted);
  result.opponentPlan = completedPlan;
  result.motionTransaction = completedTransaction;
  return result;
}

OfflineTurnResult OfflineTurnCoordinator::handleOpponentOccupancy(const Occupancy& occupancy) {
  if (!opponentPlan_ || !motionTransaction_) {
    phase_ = OfflineTurnPhase::Error;
    return resultFor(OfflineTurnEvent::Error, "Opponent execution has no staged move.");
  }

  if (occupancy == opponentPlan_->expectedOccupancy) {
    std::fill(
        motionTransaction_->verifiedPhases.begin(),
        motionTransaction_->verifiedPhases.end(), true);
    motionTransaction_->currentPhase = motionTransaction_->motion.phases.size();
    if (motionTransaction_->graveyardState == GraveyardSlotState::Pending &&
        !motionTransaction_->graveyardSlotKey.empty()) {
      occupiedGraveyardKeys_ = reserveVerifiedSlot(
          occupiedGraveyardKeys_, motionTransaction_->graveyardSlotKey);
      motionTransaction_->graveyardState = GraveyardSlotState::Occupied;
    }
    if (!opponentPlan_->move.promotion.empty()) {
      verifiedPromotionOccupancy_ = occupancy;
      syncContext_ = SyncContext::None;
      phase_ = OfflineTurnPhase::OpponentPromotionPending;
      return resultFor(OfflineTurnEvent::OpponentPromotionRequired,
                       "Replace the pawn and confirm the engine-selected promotion piece.");
    }
    return commitOpponentMove();
  }

  if (occupancy == opponentPlan_->beforeOccupancy) {
    if (motionTransaction_->graveyardState == GraveyardSlotState::Occupied) {
      syncContext_ = SyncContext::OpponentPhase;
      phase_ = OfflineTurnPhase::SyncWarning;
      return resultFor(
          OfflineTurnEvent::GraveyardConfirmationRequired,
          "The board is restored, but the robot graveyard slot must be confirmed empty.");
    }
    resetTransactionForRetry();
    syncContext_ = SyncContext::None;
    OfflineTurnResult result = resultFor(
        OfflineTurnEvent::OpponentRetryReady,
        "The pre-move position is restored; retry the same staged opponent move.");
    result.differenceFromBefore = compareOccupancy(opponentPlan_->beforeOccupancy, occupancy);
    result.differenceFromExpected = compareOccupancy(opponentPlan_->expectedOccupancy, occupancy);
    return result;
  }

  syncContext_ = SyncContext::OpponentExecution;
  phase_ = OfflineTurnPhase::SyncWarning;
  OfflineTurnResult result = resultFor(
      OfflineTurnEvent::RestoreRequired,
      "Opponent execution occupancy matches neither the pre-move nor expected position.");
  result.differenceFromBefore = compareOccupancy(opponentPlan_->beforeOccupancy, occupancy);
  result.differenceFromExpected = compareOccupancy(opponentPlan_->expectedOccupancy, occupancy);
  return result;
}

OfflineTurnResult OfflineTurnCoordinator::handlePhaseRecovery(const Occupancy& occupancy) {
  if (!opponentPlan_ || !motionTransaction_ ||
      motionTransaction_->currentPhase >= motionTransaction_->motion.phases.size()) {
    phase_ = OfflineTurnPhase::Error;
    return resultFor(OfflineTurnEvent::Error, "Motion phase recovery metadata is missing.");
  }

  if (occupancy == opponentPlan_->beforeOccupancy) {
    if (motionTransaction_->graveyardState == GraveyardSlotState::Occupied) {
      return resultFor(
          OfflineTurnEvent::GraveyardConfirmationRequired,
          "The board is restored; confirm that the captured piece was removed from its graveyard slot.");
    }
    resetTransactionForRetry();
    return resultFor(
        OfflineTurnEvent::OpponentRetryReady,
        "The complete pre-move board is restored; retry the same staged move.");
  }

  const MotionPhase& motionPhase =
      motionTransaction_->motion.phases[motionTransaction_->currentPhase];
  if (occupancy == motionPhase.expectedBefore) {
    syncContext_ = SyncContext::None;
    phase_ = OfflineTurnPhase::OpponentMoveExecuting;
    return resultFor(
        OfflineTurnEvent::OpponentPhaseRetryReady,
        "The current phase's pre-position is restored; retry that phase.");
  }
  if (occupancy == motionPhase.expectedAfter) {
    return resultFor(
        OfflineTurnEvent::RestoreRequired,
        "The phase appears complete, but a successful phase report is still required.");
  }

  OfflineTurnResult result = resultFor(
      OfflineTurnEvent::RestoreRequired,
      "Recovery occupancy matches neither checkpoint for the current phase.");
  result.differenceFromBefore = compareOccupancy(motionPhase.expectedBefore, occupancy);
  result.differenceFromExpected = compareOccupancy(motionPhase.expectedAfter, occupancy);
  return result;
}

OfflineTurnResult OfflineTurnCoordinator::completeOpponentExecution(
    const Occupancy& finalOccupancy) {
  if (phase_ == OfflineTurnPhase::SyncWarning &&
      syncContext_ == SyncContext::OpponentExecution) {
    return handleOpponentOccupancy(finalOccupancy);
  }
  if (phase_ != OfflineTurnPhase::OpponentMoveExecuting) {
    if (phase_ == OfflineTurnPhase::OpponentPromotionPending && opponentPlan_ &&
        finalOccupancy == opponentPlan_->expectedOccupancy) {
      return resultFor(OfflineTurnEvent::None, "Duplicate promotion completion report ignored.");
    }
    if (phase_ == OfflineTurnPhase::OpponentMoveReady && opponentPlan_ &&
        finalOccupancy == opponentPlan_->beforeOccupancy) {
      return resultFor(OfflineTurnEvent::None, "Duplicate unchanged-board completion report ignored.");
    }
    if (!opponentPlan_ && finalOccupancy == physical_.committedOccupancy()) {
      return resultFor(OfflineTurnEvent::None, "Duplicate completion report ignored.");
    }
    return resultFor(OfflineTurnEvent::Error, "Opponent execution is not active.");
  }
  return handleOpponentOccupancy(finalOccupancy);
}

OfflineTurnResult OfflineTurnCoordinator::processRecoverySnapshot(const Occupancy& occupancy) {
  if (phase_ != OfflineTurnPhase::SyncWarning) {
    return resultFor(OfflineTurnEvent::Error, "No synchronization warning is active.");
  }
  if (syncContext_ == SyncContext::OpponentExecution) {
    return handleOpponentOccupancy(occupancy);
  }
  if (syncContext_ == SyncContext::OpponentPhase) {
    return handlePhaseRecovery(occupancy);
  }
  if (syncContext_ == SyncContext::MotionPlanning) {
    if (occupancy != physical_.committedOccupancy()) {
      OfflineTurnResult result = resultFor(
          OfflineTurnEvent::RestoreRequired,
          "Motion planning remains paused until occupancy matches the committed board.");
      result.differenceFromBefore = compareOccupancy(
          physical_.committedOccupancy(), occupancy);
      result.differenceFromExpected = result.differenceFromBefore;
      return result;
    }
    return retryOpponentMotionPlanning(occupancy);
  }
  if (syncContext_ == SyncContext::HumanMove) {
    return handleHumanResult(physical_.processSnapshot(occupancy));
  }
  phase_ = OfflineTurnPhase::Error;
  return resultFor(OfflineTurnEvent::Error, "Synchronization warning has no recovery context.");
}

OfflineTurnResult OfflineTurnCoordinator::confirmGraveyardSlotReleased(
    std::uint32_t transactionId,
    std::string_view slotKey,
    const Occupancy& restoredOccupancy) {
  if (phase_ != OfflineTurnPhase::SyncWarning ||
      syncContext_ != SyncContext::OpponentPhase ||
      !opponentPlan_ || !motionTransaction_) {
    return resultFor(OfflineTurnEvent::Error,
                     "No captured-piece graveyard restoration is awaiting confirmation.");
  }
  if (transactionId != motionTransaction_->transactionId ||
      upper(slotKey) != upper(motionTransaction_->graveyardSlotKey)) {
    return resultFor(OfflineTurnEvent::Error,
                     "Graveyard release confirmation does not match the active transaction.");
  }
  if (motionTransaction_->graveyardState != GraveyardSlotState::Occupied ||
      restoredOccupancy != opponentPlan_->beforeOccupancy) {
    return resultFor(OfflineTurnEvent::RestoreRequired,
                     "Restore the complete pre-move board before releasing the graveyard slot.");
  }

  occupiedGraveyardKeys_ = releaseVerifiedSlot(
      occupiedGraveyardKeys_, motionTransaction_->graveyardSlotKey);
  motionTransaction_->graveyardState = GraveyardSlotState::Pending;
  resetTransactionForRetry();
  return resultFor(
      OfflineTurnEvent::OpponentRetryReady,
      "Graveyard slot release verified; retry the same staged opponent move.");
}

OfflineTurnResult OfflineTurnCoordinator::confirmOpponentPromotion(char promotionPiece) {
  if (phase_ != OfflineTurnPhase::OpponentPromotionPending ||
      !opponentPlan_ || !verifiedPromotionOccupancy_) {
    return resultFor(OfflineTurnEvent::PromotionConfirmationRejected,
                     "No opponent promotion is waiting for confirmation.");
  }

  const char normalized = static_cast<char>(
      std::tolower(static_cast<unsigned char>(promotionPiece)));
  const char expected = opponentPlan_->move.promotion.empty()
                            ? '\0'
                            : opponentPlan_->move.promotion.front();
  if (!isPromotionChoice(normalized) || normalized != expected) {
    return resultFor(OfflineTurnEvent::PromotionConfirmationRejected,
                     "Confirmed promotion piece does not match the engine move.");
  }
  return commitOpponentMove();
}

}  // namespace offline
