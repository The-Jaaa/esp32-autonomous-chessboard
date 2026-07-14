#include "../offline_core/offline_coordinator.h"

#include <algorithm>
#include <cctype>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::EngineSearchRequest;
using offline::GraveyardSlotState;
using offline::HumanColor;
using offline::MotionPhaseKind;
using offline::Occupancy;
using offline::OfflineCoordinatorConfig;
using offline::OfflineTurnCoordinator;
using offline::OfflineTurnEvent;
using offline::OfflineTurnPhase;
using offline::OfflineTurnResult;
using offline::OpponentPhaseReport;
using offline::RootMoveScore;
using offline::SearchResult;
using offline::SearchStopReason;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

OfflineCoordinatorConfig configForHuman(HumanColor color) {
  OfflineCoordinatorConfig config;
  config.humanColor = color;
  config.searchLimits.timeLimitMs = 0;
  config.searchLimits.maxDepth = 2;
  return config;
}

SearchResult syntheticSearch(
    const std::string& bestMove,
    int score = 100,
    int mateIn = 0,
    std::vector<RootMoveScore> ranked = {}) {
  SearchResult result;
  result.bestMove = bestMove;
  result.score = score;
  result.mateIn = mateIn;
  result.completedDepth = 4;
  result.stopReason = SearchStopReason::DepthLimit;
  result.outcome = offline::GameOutcome::Ongoing;
  result.rankedRootMoves = std::move(ranked);
  return result;
}

OfflineTurnResult submit(
    OfflineTurnCoordinator& coordinator,
    const SearchResult& search,
    const Occupancy* sensed = nullptr) {
  const std::optional<EngineSearchRequest> request = coordinator.pendingEngineRequest();
  require(request.has_value(), "Engine request is missing.");
  return sensed
             ? coordinator.submitEngineResult(request->generation, search, *sensed)
             : coordinator.submitEngineResult(request->generation, search);
}

OfflineTurnResult stageSingle(
    OfflineTurnCoordinator& coordinator,
    const std::string& uci,
    int score = 100,
    int mateIn = 0) {
  OfflineTurnResult result = submit(coordinator, syntheticSearch(uci, score, mateIn));
  require(result.phase == OfflineTurnPhase::OpponentMoveReady && result.opponentPlan &&
              result.motionTransaction,
          uci + ": move did not stage: " + result.message);
  return result;
}

OfflineTurnResult executeAllPhases(OfflineTurnCoordinator& coordinator) {
  OfflineTurnResult state = coordinator.beginOpponentExecution();
  require(state.phase == OfflineTurnPhase::OpponentMoveExecuting && state.motionTransaction,
          "Motion execution did not start.");
  const std::string authoritativeFen = coordinator.physical().game().fen();
  while (state.phase == OfflineTurnPhase::OpponentMoveExecuting) {
    const auto transaction = state.motionTransaction;
    require(transaction && transaction->currentPhase < transaction->motion.phases.size(),
            "Current motion phase is missing.");
    const std::size_t index = transaction->currentPhase;
    const Occupancy expected = transaction->motion.phases[index].expectedAfter;
    state = coordinator.completeOpponentPhase(
        {transaction->transactionId, index, true, expected});
    if (state.phase == OfflineTurnPhase::OpponentMoveExecuting) {
      require(coordinator.physical().game().fen() == authoritativeFen,
              "Intermediate phase changed the authoritative rules position.");
    }
  }
  return state;
}

bool containsKey(const std::vector<std::string>& keys, const std::string& key) {
  return std::find(keys.begin(), keys.end(), key) != keys.end();
}

Occupancy withoutSquare(Occupancy occupancy, const std::string& square) {
  occupancy[static_cast<std::size_t>(offline::squareToRawIndex(square))] = false;
  return occupancy;
}

void verifyCandidateSelectionAndPlanningGuard() {
  {
    OfflineTurnCoordinator coordinator(configForHuman(HumanColor::Black));
    SearchResult search = syntheticSearch(
        "g1f3", 100, 0, {{"g1f3", 100, 0}, {"e2e4", 98, 0}});
    OfflineTurnResult staged = submit(coordinator, search);
    require(staged.phase == OfflineTurnPhase::OpponentMoveReady &&
                staged.motionTransaction->selectedMove == "e2e4" &&
                staged.motionTransaction->usedFallback,
            "An unroutable preferred knight move must fall back to the strongest routable root.");
    require(staged.motionTransaction->fallbackReason.find("No safe route") != std::string::npos,
            "Physical fallback must retain the preferred move's rejection reason.");
  }

  {
    OfflineTurnCoordinator coordinator(configForHuman(HumanColor::Black));
    SearchResult search = syntheticSearch(
        "e2e4", 100, 0, {{"e2e4", 100, 0}, {"d2d4", 96, 0}});
    OfflineTurnResult staged = submit(coordinator, search);
    require(staged.motionTransaction->selectedMove == "d2d4",
            "Equal-cost candidates within five centipawns must use deterministic UCI order.");
  }

  {
    OfflineTurnCoordinator coordinator(configForHuman(HumanColor::Black));
    SearchResult search = syntheticSearch(
        "e2e4", 100, 0, {{"e2e4", 100, 0}, {"d2d4", 94, 0}});
    OfflineTurnResult staged = submit(coordinator, search);
    require(staged.motionTransaction->selectedMove == "e2e4",
            "A move outside the five-centipawn window must not replace the stronger move.");
  }

  {
    OfflineTurnCoordinator coordinator(configForHuman(HumanColor::Black));
    SearchResult search = syntheticSearch(
        "e2e4", 32000, 1, {{"e2e4", 32000, 1}, {"d2d4", 32000, 0}});
    OfflineTurnResult staged = submit(coordinator, search);
    require(staged.motionTransaction->selectedMove == "e2e4",
            "Route cost must not replace a mate-ranked engine move.");
  }

  {
    OfflineTurnCoordinator coordinator(configForHuman(HumanColor::Black));
    Occupancy stale = coordinator.physical().committedOccupancy();
    stale[static_cast<std::size_t>(offline::squareToRawIndex("a2"))] = false;
    OfflineTurnResult warning = submit(coordinator, syntheticSearch("e2e4"), &stale);
    require(warning.phase == OfflineTurnPhase::SyncWarning &&
                warning.event == OfflineTurnEvent::RestoreRequired &&
                !warning.differenceFromBefore.empty(),
            "Stale sensed occupancy must block motion planning with a recoverable warning.");
    OfflineTurnResult recovered = coordinator.processRecoverySnapshot(
        coordinator.physical().committedOccupancy());
    require(recovered.phase == OfflineTurnPhase::OpponentMoveReady &&
                recovered.motionTransaction->selectedMove == "e2e4",
            "Restoring committed occupancy must reuse the retained engine result.");
  }
}

void verifyQuietPhaseAndIdempotency() {
  OfflineTurnCoordinator coordinator(configForHuman(HumanColor::Black));
  OfflineTurnResult staged = stageSingle(coordinator, "e2e4");
  const std::string beforeFen = coordinator.physical().game().fen();
  OfflineTurnResult started = coordinator.beginOpponentExecution();
  const auto transaction = started.motionTransaction;
  require(transaction->motion.phases.size() == 1 &&
              transaction->motion.phases.front().kind == MotionPhaseKind::QuietTransfer,
          "Quiet move must contain one quiet-transfer phase.");

  OfflineTurnResult stale = coordinator.completeOpponentPhase(
      {transaction->transactionId + 1, 0, true,
       transaction->motion.phases.front().expectedAfter});
  require(stale.event == OfflineTurnEvent::Error &&
              coordinator.physical().game().fen() == beforeFen,
          "Stale transaction reports must be rejected without mutation.");

  OfflineTurnResult retry = coordinator.completeOpponentPhase(
      {transaction->transactionId, 0, false,
       transaction->motion.phases.front().expectedBefore});
  require(retry.event == OfflineTurnEvent::OpponentPhaseRetryReady &&
              retry.phase == OfflineTurnPhase::OpponentMoveExecuting,
          "A failed unchanged phase must remain retryable.");

  OfflineTurnResult unconfirmed = coordinator.completeOpponentPhase(
      {transaction->transactionId, 0, false,
       transaction->motion.phases.front().expectedAfter});
  require(unconfirmed.phase == OfflineTurnPhase::SyncWarning,
          "After-occupancy without a successful phase report must not commit.");
  OfflineTurnResult observed = coordinator.processRecoverySnapshot(
      transaction->motion.phases.front().expectedAfter);
  require(observed.phase == OfflineTurnPhase::SyncWarning &&
              observed.event == OfflineTurnEvent::RestoreRequired &&
              coordinator.physical().game().fen() == beforeFen,
          "Occupancy alone must not confirm a phase after hardware reported failure.");

  OfflineTurnResult completed = coordinator.completeOpponentPhase(
      {transaction->transactionId, 0, true,
       transaction->motion.phases.front().expectedAfter});
  require(completed.event == OfflineTurnEvent::OpponentMoveVerified &&
              completed.phase == OfflineTurnPhase::HumanTurn &&
              coordinator.physical().game().fen() == staged.opponentPlan->afterFen,
          "Final verified quiet phase must commit the opponent move.");

  OfflineTurnResult duplicate = coordinator.completeOpponentPhase(
      {transaction->transactionId, 0, true,
       transaction->motion.phases.front().expectedAfter});
  require(duplicate.event == OfflineTurnEvent::None,
          "Duplicate phase completion after commit must be idempotent.");
}

void verifyCaptureReservationAndRecovery() {
  OfflineTurnCoordinator coordinator;
  require(coordinator.loadFen("4k3/8/8/3p4/4P3/8/8/4K3 b - - 0 1"),
          "Capture transaction fixture must load.");
  OfflineTurnResult staged = stageSingle(coordinator, "d5e4");
  const auto initial = staged.motionTransaction;
  require(initial->motion.phases.size() == 2 &&
              initial->motion.phases[0].kind == MotionPhaseKind::CapturedRemoval &&
              initial->graveyardState == GraveyardSlotState::Pending &&
              !containsKey(coordinator.occupiedGraveyardKeys(), initial->graveyardSlotKey),
          "Selected capture must reserve its proposed graveyard slot only as pending.");
  const std::string beforeFen = coordinator.physical().game().fen();

  coordinator.beginOpponentExecution();
  OfflineTurnResult removed = coordinator.completeOpponentPhase(
      {initial->transactionId, 0, true, initial->motion.phases[0].expectedAfter});
  require(removed.event == OfflineTurnEvent::OpponentPhaseVerified &&
              removed.motionTransaction->graveyardState == GraveyardSlotState::Occupied &&
              containsKey(coordinator.occupiedGraveyardKeys(), initial->graveyardSlotKey) &&
              coordinator.physical().game().fen() == beforeFen,
          "Verified captured removal must occupy the slot without committing chess state.");

  OfflineTurnResult duplicate = coordinator.completeOpponentPhase(
      {initial->transactionId, 0, true, initial->motion.phases[0].expectedAfter});
  require(duplicate.event == OfflineTurnEvent::None,
          "Duplicate captured-removal report must not reserve the slot twice.");

  Occupancy ambiguous = initial->motion.phases[1].expectedBefore;
  ambiguous[static_cast<std::size_t>(offline::squareToRawIndex("h1"))] = true;
  OfflineTurnResult warning = coordinator.completeOpponentPhase(
      {initial->transactionId, 1, false, ambiguous});
  require(warning.phase == OfflineTurnPhase::SyncWarning,
          "Ambiguous attacker-final failure must enter sync warning.");

  OfflineTurnResult restore = coordinator.processRecoverySnapshot(
      staged.opponentPlan->beforeOccupancy);
  require(restore.event == OfflineTurnEvent::GraveyardConfirmationRequired,
          "Restoring the board after removal must still require graveyard confirmation.");
  OfflineTurnResult wrongRelease = coordinator.confirmGraveyardSlotReleased(
      initial->transactionId, "Z8", staged.opponentPlan->beforeOccupancy);
  require(wrongRelease.event == OfflineTurnEvent::Error,
          "A different graveyard key must not release the active reservation.");
  OfflineTurnResult released = coordinator.confirmGraveyardSlotReleased(
      initial->transactionId, initial->graveyardSlotKey,
      staged.opponentPlan->beforeOccupancy);
  require(released.phase == OfflineTurnPhase::OpponentMoveReady &&
              released.motionTransaction->graveyardState == GraveyardSlotState::Pending &&
              !containsKey(coordinator.occupiedGraveyardKeys(), initial->graveyardSlotKey),
          "Explicit restored-piece confirmation must return the slot to pending for retry.");

  coordinator.beginOpponentExecution();
  OfflineTurnResult completed = coordinator.completeOpponentExecution(
      staged.opponentPlan->expectedOccupancy);
  require(completed.event == OfflineTurnEvent::OpponentMoveVerified &&
              completed.motionTransaction->graveyardState == GraveyardSlotState::Occupied &&
              containsKey(coordinator.occupiedGraveyardKeys(), initial->graveyardSlotKey),
          "Atomic compatibility completion must verify all phases and occupy the slot.");
}

void verifySpecialMovePhases(
    HumanColor humanColor,
    const std::string& fen,
    const std::string& uci,
    const std::vector<MotionPhaseKind>& expectedKinds) {
  OfflineTurnCoordinator coordinator(configForHuman(humanColor));
  require(coordinator.loadFen(fen), uci + ": special-move fixture must load.");
  OfflineTurnResult staged = stageSingle(coordinator, uci);
  std::vector<MotionPhaseKind> actual;
  for (const auto& phase : staged.motionTransaction->motion.phases) actual.push_back(phase.kind);
  require(actual == expectedKinds, uci + ": motion phase order is incorrect.");
  const std::string before = coordinator.physical().game().fen();
  OfflineTurnResult completed = executeAllPhases(coordinator);
  require((completed.phase == OfflineTurnPhase::HumanTurn ||
           completed.phase == OfflineTurnPhase::GameOver) &&
              completed.acceptedMove && completed.acceptedMove->uci == uci &&
              coordinator.physical().game().fen() != before,
          uci + ": verified phase sequence did not commit.");
}

void verifyCapturesEnPassantAndCastling() {
  verifySpecialMovePhases(
      HumanColor::Black,
      "rnbq3r/ppppBpkp/4p2n/1P4p1/4P3/7N/P1PP1PPP/RNQ1KB1R w KQ - 1 9",
      "e7d8",
      {MotionPhaseKind::AttackerStage, MotionPhaseKind::CapturedRemoval,
       MotionPhaseKind::AttackerFinal});
  verifySpecialMovePhases(
      HumanColor::Black,
      "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
      "e5d6",
      {MotionPhaseKind::CapturedRemoval, MotionPhaseKind::AttackerFinal});
  verifySpecialMovePhases(
      HumanColor::Black,
      "4k3/8/8/8/8/8/8/4K2R w K - 0 1",
      "e1g1",
      {MotionPhaseKind::CastleKing, MotionPhaseKind::CastleRook});
  verifySpecialMovePhases(
      HumanColor::Black,
      "4k3/8/8/8/8/8/8/R3K3 w Q - 0 1",
      "e1c1",
      {MotionPhaseKind::CastleKing, MotionPhaseKind::CastleRook});
  verifySpecialMovePhases(
      HumanColor::White,
      "4k2r/8/8/8/8/8/8/4K3 b k - 0 1",
      "e8g8",
      {MotionPhaseKind::CastleKing, MotionPhaseKind::CastleRook});
  verifySpecialMovePhases(
      HumanColor::White,
      "r3k3/8/8/8/8/8/8/4K3 b q - 0 1",
      "e8c8",
      {MotionPhaseKind::CastleKing, MotionPhaseKind::CastleRook});
}

void verifyBlockedFallback() {
  {
    OfflineCoordinatorConfig config;
    for (const auto& slot : offline::defaultExternalSlots()) {
      config.initialOccupiedGraveyardKeys.push_back(offline::externalSlotKey(slot));
    }
    OfflineTurnCoordinator coordinator(config);
    require(coordinator.loadFen("4k3/8/8/3p4/4P3/8/8/4K3 b - - 0 1"),
            "Full-graveyard fallback fixture must load.");
    SearchResult search = syntheticSearch(
        "d5e4", 100, 0, {{"d5e4", 100, 0}, {"d5d4", 98, 0}});
    OfflineTurnResult staged = submit(coordinator, search);
    require(staged.phase == OfflineTurnPhase::OpponentMoveReady &&
                staged.motionTransaction->selectedMove == "d5d4" &&
                staged.motionTransaction->usedFallback,
            "A full graveyard must allow a strong routable quiet candidate fallback.");
  }

}

void verifyPromotionTransaction(
    HumanColor humanColor,
    const std::string& fen,
    const std::string& uci,
    bool capture,
    bool atomicCompletion = false) {
  OfflineTurnCoordinator coordinator(configForHuman(humanColor));
  require(coordinator.loadFen(fen), uci + ": promotion fixture must load.");
  const std::string beforeFen = coordinator.physical().game().fen();
  OfflineTurnResult staged = stageSingle(coordinator, uci);
  require(staged.motionTransaction->selectedMove == uci && staged.opponentPlan &&
              staged.opponentPlan->move.promotion == uci.substr(4, 1) &&
              staged.opponentPlan->move.capture == capture,
          uci + ": promotion move did not stage with complete metadata.");
  const auto transaction = *staged.motionTransaction;

  OfflineTurnResult pending;
  if (atomicCompletion) {
    coordinator.beginOpponentExecution();
    pending = coordinator.completeOpponentExecution(
        staged.opponentPlan->expectedOccupancy);
  } else {
    pending = executeAllPhases(coordinator);
  }
  require(pending.phase == OfflineTurnPhase::OpponentPromotionPending &&
              pending.event == OfflineTurnEvent::OpponentPromotionRequired &&
              coordinator.physical().game().fen() == beforeFen &&
              pending.motionTransaction &&
              pending.motionTransaction->currentPhase ==
                  pending.motionTransaction->motion.phases.size(),
          uci + ": verified motion must wait for replacement without committing.");
  if (capture) {
    require(pending.motionTransaction->graveyardState == GraveyardSlotState::Occupied &&
                containsKey(coordinator.occupiedGraveyardKeys(),
                            pending.motionTransaction->graveyardSlotKey),
            uci + ": capture promotion must keep its verified graveyard slot occupied.");
  }

  const auto& finalPhase = transaction.motion.phases.back();
  OfflineTurnResult duplicatePhase = coordinator.completeOpponentPhase(
      {transaction.transactionId, transaction.motion.phases.size() - 1, true,
       finalPhase.expectedAfter});
  require(duplicatePhase.event == OfflineTurnEvent::None &&
              duplicatePhase.phase == OfflineTurnPhase::OpponentPromotionPending,
          uci + ": duplicate final phase report must be idempotent.");

  const Occupancy expected = staged.opponentPlan->expectedOccupancy;
  const Occupancy targetEmpty = withoutSquare(expected, staged.opponentPlan->move.to);
  OfflineTurnResult replacing = coordinator.processOpponentPromotionSnapshot(targetEmpty);
  require(replacing.phase == OfflineTurnPhase::OpponentPromotionPending &&
              replacing.event ==
                  OfflineTurnEvent::OpponentPromotionReplacementInProgress,
          uci + ": lifting the promotion pawn must be an expected replacement state.");
  OfflineTurnResult duplicateReplacing =
      coordinator.processOpponentPromotionSnapshot(targetEmpty);
  require(duplicateReplacing.event ==
              OfflineTurnEvent::OpponentPromotionReplacementInProgress &&
              coordinator.physical().game().fen() == beforeFen,
          uci + ": duplicate replacement snapshots must remain idempotent.");

  Occupancy disturbed = targetEmpty;
  for (std::size_t index = 0; index < disturbed.size(); ++index) {
    if (disturbed[index]) {
      disturbed[index] = false;
      break;
    }
  }
  OfflineTurnResult warning = coordinator.processOpponentPromotionSnapshot(disturbed);
  require(warning.phase == OfflineTurnPhase::SyncWarning &&
              warning.event == OfflineTurnEvent::RestoreRequired &&
              !warning.differenceFromExpected.empty() &&
              coordinator.physical().game().fen() == beforeFen,
          uci + ": unrelated replacement disturbance must be recoverable.");
  replacing = coordinator.processRecoverySnapshot(targetEmpty);
  require(replacing.phase == OfflineTurnPhase::OpponentPromotionPending &&
              replacing.event ==
                  OfflineTurnEvent::OpponentPromotionReplacementInProgress,
          uci + ": promotion recovery must return to replacement pending.");

  OfflineTurnResult ready = coordinator.processOpponentPromotionSnapshot(expected);
  require(ready.phase == OfflineTurnPhase::OpponentPromotionPending &&
              ready.event == OfflineTurnEvent::OpponentPromotionConfirmationReady,
          uci + ": restored promotion occupancy must be ready for confirmation.");

  const char expectedPiece = uci[4];
  const char wrongPiece = expectedPiece == 'q' ? 'r' : 'q';
  OfflineTurnResult wrong = coordinator.confirmOpponentPromotion(wrongPiece, expected);
  require(wrong.event == OfflineTurnEvent::PromotionConfirmationRejected &&
              wrong.phase == OfflineTurnPhase::OpponentPromotionPending &&
              coordinator.physical().game().fen() == beforeFen,
          uci + ": wrong promotion identity must not commit.");
  OfflineTurnResult invalid = coordinator.confirmOpponentPromotion('x', expected);
  require(invalid.event == OfflineTurnEvent::PromotionConfirmationRejected &&
              invalid.phase == OfflineTurnPhase::OpponentPromotionPending &&
              coordinator.physical().game().fen() == beforeFen,
          uci + ": invalid promotion identity must not commit.");
  OfflineTurnResult missing = coordinator.confirmOpponentPromotion(
      expectedPiece, targetEmpty);
  require(missing.event ==
              OfflineTurnEvent::OpponentPromotionReplacementInProgress &&
              coordinator.physical().game().fen() == beforeFen,
          uci + ": confirmation while the target is empty must not commit.");

  ready = coordinator.processOpponentPromotionSnapshot(expected);
  OfflineTurnResult completed = coordinator.confirmOpponentPromotion(
      static_cast<char>(std::toupper(static_cast<unsigned char>(expectedPiece))), expected);
  require((completed.phase == OfflineTurnPhase::HumanTurn ||
           completed.phase == OfflineTurnPhase::GameOver) &&
              completed.acceptedMove && completed.acceptedMove->uci == uci &&
              coordinator.physical().game().fen() == staged.opponentPlan->afterFen,
          uci + ": matching promotion confirmation must commit the staged move.");
  OfflineTurnResult duplicate = coordinator.confirmOpponentPromotion(expectedPiece, expected);
  require(duplicate.event == OfflineTurnEvent::None,
          uci + ": duplicate promotion confirmation must be idempotent.");
}

void verifyPromotionTransactions() {
  {
    OfflineTurnCoordinator coordinator(configForHuman(HumanColor::Black));
    require(coordinator.loadFen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1"),
            "Promotion candidate-selection fixture must load.");
    SearchResult search = syntheticSearch(
        "a7a8n", 150, 0, {{"a7a8n", 150, 0}, {"a7a8q", 140, 0}});
    OfflineTurnResult staged = submit(coordinator, search);
    require(staged.phase == OfflineTurnPhase::OpponentMoveReady &&
                staged.motionTransaction &&
                staged.motionTransaction->selectedMove == "a7a8n",
            "The strongest routable promotion must not be replaced by another identity.");
  }

  for (const char piece : std::string("qrbn")) {
    verifyPromotionTransaction(
        HumanColor::White,
        "4k3/8/8/8/8/8/p7/4K3 b - - 0 1",
        std::string("a2a1") + piece,
        false,
        piece == 'q');
    verifyPromotionTransaction(
        HumanColor::Black,
        "4k3/P7/8/8/8/8/8/4K3 w - - 0 1",
        std::string("a7a8") + piece,
        false);
  }
  verifyPromotionTransaction(
      HumanColor::White,
      "4k3/8/8/8/8/8/p7/1R2K3 b - - 0 1",
      "a2b1n",
      true);
  verifyPromotionTransaction(
      HumanColor::Black,
      "1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1",
      "a7b8r",
      true);
}

void verifyPromotionOutcome(
    const std::string& fen,
    const std::string& uci,
    offline::GameOutcome expectedOutcome,
    bool expectedCheck) {
  OfflineTurnCoordinator coordinator(configForHuman(HumanColor::Black));
  require(coordinator.loadFen(fen), uci + ": promotion-outcome fixture must load.");
  const std::string beforeFen = coordinator.physical().game().fen();
  OfflineTurnResult staged = stageSingle(coordinator, uci);
  require(staged.opponentPlan &&
              staged.opponentPlan->expectedStatus.outcome == expectedOutcome &&
              staged.opponentPlan->expectedStatus.inCheck == expectedCheck,
          uci + ": staged promotion has the wrong expected game status.");

  OfflineTurnResult pending = executeAllPhases(coordinator);
  require(pending.phase == OfflineTurnPhase::OpponentPromotionPending &&
              coordinator.physical().game().fen() == beforeFen,
          uci + ": promotion outcome must remain uncommitted before confirmation.");
  const Occupancy expected = staged.opponentPlan->expectedOccupancy;
  OfflineTurnResult ready = coordinator.processOpponentPromotionSnapshot(expected);
  require(ready.event == OfflineTurnEvent::OpponentPromotionConfirmationReady,
          uci + ": promotion outcome did not become confirmation-ready.");
  OfflineTurnResult completed = coordinator.confirmOpponentPromotion(uci[4], expected);
  require(completed.acceptedMove && completed.acceptedMove->uci == uci &&
              coordinator.physical().game().status().outcome == expectedOutcome &&
              coordinator.physical().game().status().inCheck == expectedCheck,
          uci + ": confirmed promotion has the wrong committed game status.");
  const OfflineTurnPhase expectedPhase =
      expectedOutcome == offline::GameOutcome::Ongoing
          ? OfflineTurnPhase::HumanTurn
          : OfflineTurnPhase::GameOver;
  require(completed.phase == expectedPhase,
          uci + ": confirmed promotion transitioned to the wrong coordinator phase.");
}

void verifyPromotionOutcomes() {
  verifyPromotionOutcome(
      "4k3/P7/8/8/8/8/8/4K3 w - - 0 1",
      "a7a8q",
      offline::GameOutcome::Ongoing,
      true);
  verifyPromotionOutcome(
      "7k/5P2/6K1/8/8/8/8/8 w - - 0 1",
      "f7f8q",
      offline::GameOutcome::Checkmate,
      true);
  verifyPromotionOutcome(
      "8/1P6/8/8/8/8/8/5K1k w - - 0 1",
      "b7b8q",
      offline::GameOutcome::Stalemate,
      false);
}

void verifyGameOverAfterFinalPhase() {
  OfflineTurnCoordinator coordinator(configForHuman(HumanColor::Black));
  require(coordinator.loadFen("7k/5Q2/6K1/8/8/8/8/8 w - - 0 1"),
          "Mate transaction fixture must load.");
  stageSingle(coordinator, "f7g7", 32000, 1);
  OfflineTurnResult completed = executeAllPhases(coordinator);
  require(completed.phase == OfflineTurnPhase::GameOver &&
              completed.event == OfflineTurnEvent::GameEnded &&
              coordinator.physical().game().status().outcome ==
                  offline::GameOutcome::Checkmate,
          "A verified mating motion must transition directly to game over.");
}

}  // namespace

int main() {
  try {
    verifyCandidateSelectionAndPlanningGuard();
    verifyQuietPhaseAndIdempotency();
    verifyCaptureReservationAndRecovery();
    verifyCapturesEnPassantAndCastling();
    verifyBlockedFallback();
    verifyPromotionTransactions();
    verifyPromotionOutcomes();
    verifyGameOverAfterFinalPhase();
    std::cout << "offline motion execution transaction regressions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline motion execution transaction regression failed: "
              << error.what() << '\n';
    return 1;
  }
}
