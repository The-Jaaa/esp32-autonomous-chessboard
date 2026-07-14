#include "../offline_core/offline_coordinator.h"

#include <iostream>
#include <stdexcept>
#include <string>

namespace {

using offline::EngineSearchRequest;
using offline::HumanColor;
using offline::Occupancy;
using offline::OfflineCoordinatorConfig;
using offline::OfflineEngine;
using offline::OfflineTurnCoordinator;
using offline::OfflineTurnEvent;
using offline::OfflineTurnPhase;
using offline::OfflineTurnResult;
using offline::SearchLimits;
using offline::SearchResult;
using offline::SearchStopReason;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void place(Occupancy& occupancy, const std::string& square, bool occupied) {
  const int index = offline::squareToRawIndex(square);
  require(index >= 0, "Invalid test square: " + square);
  occupancy[static_cast<std::size_t>(index)] = occupied;
}

SearchResult syntheticSearch(const std::string& move) {
  SearchResult result;
  result.bestMove = move;
  result.completedDepth = 2;
  result.stopReason = SearchStopReason::DepthLimit;
  result.outcome = offline::GameOutcome::Ongoing;
  return result;
}

OfflineTurnResult submitMove(OfflineTurnCoordinator& coordinator, const std::string& move) {
  const std::optional<EngineSearchRequest> request = coordinator.pendingEngineRequest();
  require(request.has_value(), move + ": engine request is missing.");
  return coordinator.submitEngineResult(request->generation, syntheticSearch(move));
}

OfflineTurnResult performQuietHumanMove(
    OfflineTurnCoordinator& coordinator, const std::string& from, const std::string& to) {
  Occupancy board = coordinator.physical().committedOccupancy();
  place(board, from, false);
  OfflineTurnResult lifted = coordinator.processHumanSnapshot(board);
  require(lifted.phase == OfflineTurnPhase::HumanTurn,
          from + to + ": lifting should remain in the human turn.");
  place(board, to, true);
  return coordinator.processHumanSnapshot(board);
}

OfflineTurnResult executeStagedMove(OfflineTurnCoordinator& coordinator) {
  const OfflineTurnResult before = coordinator.currentState();
  OfflineTurnResult started = coordinator.beginOpponentExecution();
  require(started.phase == OfflineTurnPhase::OpponentMoveExecuting,
          std::string("Staged opponent move did not start execution: phase=") +
              offline::offlineTurnPhaseName(started.phase) + " preferred=" +
              (before.motionTransaction ? before.motionTransaction->preferredMove : "none") +
              " reason=" +
              (before.motionTransaction && !before.motionTransaction->rejectedCandidates.empty()
                   ? before.motionTransaction->rejectedCandidates.front().reason
                   : "none") +
              " message=" + started.message);
  require(started.opponentPlan.has_value(), "Started execution is missing its move plan.");
  return coordinator.completeOpponentExecution(started.opponentPlan->expectedOccupancy);
}

void verifyWhiteAndBlackTurnCycles() {
  OfflineCoordinatorConfig whiteConfig;
  whiteConfig.searchLimits.timeLimitMs = 0;
  whiteConfig.searchLimits.maxDepth = 2;
  OfflineTurnCoordinator white(whiteConfig);
  require(white.phase() == OfflineTurnPhase::HumanTurn, "Human White must start the game.");

  OfflineTurnResult human = performQuietHumanMove(white, "e2", "e4");
  require(human.phase == OfflineTurnPhase::EngineSearchNeeded &&
              human.event == OfflineTurnEvent::HumanMoveAccepted,
          "Accepted human move must request engine search.");
  require(human.acceptedMove && human.acceptedMove->uci == "e2e4",
          "Human accepted-move metadata is missing.");

  const EngineSearchRequest request = *white.pendingEngineRequest();
  OfflineEngine engine;
  const SearchResult searched = engine.searchFen(request.fen, request.limits);
  require(searched.hasMove(), "Split-phase engine search must produce a move.");
  const std::string beforeEngineMove = white.physical().game().fen();
  OfflineTurnResult staged = white.submitEngineResult(request.generation, searched);
  require(staged.phase == OfflineTurnPhase::OpponentMoveReady && staged.opponentPlan,
          "Legal engine result must stage an opponent move.");
  require(white.physical().game().fen() == beforeEngineMove,
          "Staging must not modify the authoritative game.");

  OfflineTurnResult completed = executeStagedMove(white);
  require(completed.phase == OfflineTurnPhase::HumanTurn &&
              completed.event == OfflineTurnEvent::OpponentMoveVerified,
          "Verified opponent move must return control to Human White.");
  require(white.physical().game().fen() != beforeEngineMove,
          "Verified opponent move must update the authoritative game.");

  OfflineCoordinatorConfig blackConfig;
  blackConfig.humanColor = HumanColor::Black;
  OfflineTurnCoordinator black(blackConfig);
  require(black.phase() == OfflineTurnPhase::EngineSearchNeeded,
          "Human Black must wait for the opening engine move.");
  staged = submitMove(black, "e2e4");
  require(staged.phase == OfflineTurnPhase::OpponentMoveReady,
          "Opening White move must stage for Human Black.");
  completed = executeStagedMove(black);
  require(completed.phase == OfflineTurnPhase::HumanTurn &&
              black.physical().game().sideToMove() == 'b',
          "Verified opening move must expose Human Black's turn.");
}

void verifySearchGenerationAndValidation() {
  OfflineCoordinatorConfig config;
  config.humanColor = HumanColor::Black;
  OfflineTurnCoordinator coordinator(config);
  const EngineSearchRequest original = *coordinator.pendingEngineRequest();

  OfflineTurnResult result = coordinator.submitEngineResult(
      original.generation + 1, syntheticSearch("e2e4"));
  require(result.event == OfflineTurnEvent::EngineResultRejected &&
              coordinator.pendingEngineRequest()->generation == original.generation,
          "Stale search result must not replace the active request.");

  result = coordinator.submitEngineResult(original.generation, syntheticSearch("e2e5"));
  require(result.event == OfflineTurnEvent::EngineResultRejected &&
              result.phase == OfflineTurnPhase::EngineSearchNeeded,
          "Illegal engine move must be rejected without changing phase authority.");
  const EngineSearchRequest replacement = *coordinator.pendingEngineRequest();
  require(replacement.generation > original.generation && replacement.fen == original.fen,
          "Rejected current result must issue a fresh generation for the same FEN.");

  SearchResult empty;
  empty.stopReason = SearchStopReason::TerminalPosition;
  result = coordinator.submitEngineResult(replacement.generation, empty);
  require(result.event == OfflineTurnEvent::EngineResultRejected &&
              coordinator.pendingEngineRequest()->generation > replacement.generation,
          "Empty terminal result for an ongoing position must request another search.");
}

void verifyOpponentSpecialMove(
    const std::string& fen, const std::string& uci,
    bool capture, bool castling, bool enPassant) {
  OfflineTurnCoordinator coordinator;
  require(coordinator.loadFen(fen), uci + ": fixture FEN must load.");
  require(coordinator.phase() == OfflineTurnPhase::EngineSearchNeeded,
          uci + ": opponent-to-move fixture must request search.");

  const std::string before = coordinator.physical().game().fen();
  OfflineTurnResult staged = submitMove(coordinator, uci);
  require(staged.opponentPlan && staged.opponentPlan->move.capture == capture &&
              staged.opponentPlan->move.castling == castling &&
              staged.opponentPlan->move.enPassant == enPassant,
          uci + ": staged special-move metadata is incorrect.");
  require(coordinator.physical().game().fen() == before,
          uci + ": preview must leave FEN unchanged.");

  OfflineTurnResult completed = executeStagedMove(coordinator);
  require(completed.event == OfflineTurnEvent::OpponentMoveVerified && completed.acceptedMove &&
              completed.acceptedMove->uci == uci,
          uci + ": verified special move did not commit.");
  require(coordinator.physical().game().fen() == staged.opponentPlan->afterFen,
          uci + ": committed FEN differs from preview.");
}

void verifyCapturesCastlingAndEnPassant() {
  verifyOpponentSpecialMove(
      "4k3/8/8/3p4/4P3/8/8/4K3 b - - 0 1", "d5e4", true, false, false);
  verifyOpponentSpecialMove(
      "8/8/8/8/3pP3/8/8/4K2k b - e3 0 1", "d4e3", true, false, true);
  verifyOpponentSpecialMove(
      "r3k2r/8/8/8/8/8/8/R3K2R b kq - 0 1", "e8g8", false, true, false);
  verifyOpponentSpecialMove(
      "r3k2r/8/8/8/8/8/8/R3K2R b kq - 0 1", "e8c8", false, true, false);
}

void verifyPromotions() {
  OfflineTurnCoordinator humanPromotion;
  require(humanPromotion.loadFen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1"),
          "Human promotion fixture must load.");
  Occupancy board = humanPromotion.physical().committedOccupancy();
  place(board, "a7", false);
  humanPromotion.processHumanSnapshot(board);
  place(board, "a8", true);
  OfflineTurnResult result = humanPromotion.processHumanSnapshot(board);
  require(result.phase == OfflineTurnPhase::HumanPromotionPending,
          "Human promotion must wait for a piece choice.");
  result = humanPromotion.confirmHumanPromotion('q');
  require(result.phase == OfflineTurnPhase::EngineSearchNeeded && result.acceptedMove &&
              result.acceptedMove->uci == "a7a8q",
          "Confirmed human promotion must commit and request an engine move.");

  OfflineTurnCoordinator opponentPromotion;
  require(opponentPromotion.loadFen("7k/8/8/8/8/8/p6P/4K3 b - - 0 1"),
          "Opponent promotion fixture must load.");
  const std::string before = opponentPromotion.physical().game().fen();
  result = submitMove(opponentPromotion, "a2a1n");
  require(result.phase == OfflineTurnPhase::OpponentMoveReady && result.opponentPlan &&
              result.opponentPlan->move.uci == "a2a1n" &&
              result.opponentPlan->move.promotion == "n",
          "Opponent promotion must stage through normal motion planning.");
  require(opponentPromotion.physical().game().fen() == before,
          "Staged opponent promotion must leave the authoritative game unchanged.");

  const Occupancy expected = result.opponentPlan->expectedOccupancy;
  result = executeStagedMove(opponentPromotion);
  require(result.phase == OfflineTurnPhase::OpponentPromotionPending &&
              result.event == OfflineTurnEvent::OpponentPromotionRequired &&
              opponentPromotion.physical().game().fen() == before,
          "Verified promotion motion must wait for physical piece replacement.");

  Occupancy replacing = expected;
  place(replacing, "a1", false);
  result = opponentPromotion.processOpponentPromotionSnapshot(replacing);
  require(result.phase == OfflineTurnPhase::OpponentPromotionPending &&
              result.event == OfflineTurnEvent::OpponentPromotionReplacementInProgress &&
              opponentPromotion.physical().game().fen() == before,
          "An empty promotion square must represent replacement in progress.");

  Occupancy disturbed = replacing;
  place(disturbed, "h2", false);
  result = opponentPromotion.processOpponentPromotionSnapshot(disturbed);
  require(result.phase == OfflineTurnPhase::SyncWarning &&
              result.event == OfflineTurnEvent::RestoreRequired &&
              opponentPromotion.physical().game().fen() == before,
          "An unrelated promotion disturbance must enter recoverable SyncWarning.");
  result = opponentPromotion.processRecoverySnapshot(expected);
  require(result.phase == OfflineTurnPhase::OpponentPromotionPending &&
              result.event == OfflineTurnEvent::OpponentPromotionConfirmationReady,
          "Restoring promotion occupancy must return to identity confirmation.");

  result = opponentPromotion.confirmOpponentPromotion('q', expected);
  require(result.event == OfflineTurnEvent::PromotionConfirmationRejected,
          "A promotion identity different from the engine move must be rejected.");
  require(opponentPromotion.physical().game().fen() == before,
          "Rejected promotion identity must not commit the move.");

  result = opponentPromotion.confirmOpponentPromotion('N', expected);
  require(result.event == OfflineTurnEvent::OpponentMoveVerified && result.acceptedMove &&
              result.acceptedMove->uci == "a2a1n" &&
              opponentPromotion.physical().game().fen() == result.opponentPlan->afterFen,
          "Matching promotion identity and occupancy must commit the exact move.");
  result = opponentPromotion.confirmOpponentPromotion('n', expected);
  require(result.event == OfflineTurnEvent::None,
          "Duplicate promotion confirmation must be idempotently ignored.");
}

void verifyExecutionRecoveryAndIdempotency() {
  OfflineCoordinatorConfig config;
  config.humanColor = HumanColor::Black;
  OfflineTurnCoordinator coordinator(config);
  OfflineTurnResult staged = submitMove(coordinator, "e2e4");
  const std::string beforeFen = coordinator.physical().game().fen();
  const Occupancy before = staged.opponentPlan->beforeOccupancy;
  const Occupancy after = staged.opponentPlan->expectedOccupancy;

  coordinator.beginOpponentExecution();
  Occupancy ambiguous = before;
  place(ambiguous, "e2", false);
  OfflineTurnResult result = coordinator.completeOpponentExecution(ambiguous);
  require(result.phase == OfflineTurnPhase::SyncWarning &&
              result.event == OfflineTurnEvent::RestoreRequired &&
              coordinator.physical().game().fen() == beforeFen,
          "Ambiguous opponent occupancy must warn without committing.");
  require(!result.differenceFromBefore.empty() && !result.differenceFromExpected.empty(),
          "Sync warning must expose differences from both valid positions.");

  result = coordinator.processRecoverySnapshot(before);
  require(result.phase == OfflineTurnPhase::OpponentMoveReady &&
              result.event == OfflineTurnEvent::OpponentRetryReady &&
              result.opponentPlan->move.uci == "e2e4",
          "Restoring the pre-position must preserve the same staged move for retry.");
  coordinator.beginOpponentExecution();
  result = coordinator.completeOpponentExecution(ambiguous);
  require(result.phase == OfflineTurnPhase::SyncWarning,
          "A second ambiguous execution must warn again.");
  result = coordinator.processRecoverySnapshot(after);
  require(result.event == OfflineTurnEvent::OpponentMoveVerified &&
              result.phase == OfflineTurnPhase::HumanTurn,
          "Reaching the expected post-position during recovery must commit.");

  result = coordinator.completeOpponentExecution(after);
  require(result.event == OfflineTurnEvent::None && result.phase == OfflineTurnPhase::HumanTurn,
          "Duplicate completion report must be idempotent.");

  OfflineTurnCoordinator directRetry(config);
  staged = submitMove(directRetry, "d2d4");
  directRetry.beginOpponentExecution();
  result = directRetry.completeOpponentExecution(staged.opponentPlan->beforeOccupancy);
  require(result.phase == OfflineTurnPhase::OpponentMoveReady &&
              result.opponentPlan->move.uci == "d2d4",
          "An unchanged final board must immediately make the same move retryable.");
  result = directRetry.completeOpponentExecution(staged.opponentPlan->beforeOccupancy);
  require(result.event == OfflineTurnEvent::None &&
              result.phase == OfflineTurnPhase::OpponentMoveReady,
          "Duplicate unchanged-board completion must be idempotent.");
}

void verifyHumanWarningRecovery() {
  OfflineTurnCoordinator coordinator;
  const Occupancy original = coordinator.physical().committedOccupancy();
  Occupancy wrongLift = original;
  place(wrongLift, "a7", false);
  OfflineTurnResult result = coordinator.processHumanSnapshot(wrongLift);
  require(result.phase == OfflineTurnPhase::SyncWarning,
          "Wrong-color human lift must enter coordinator sync warning.");
  result = coordinator.processRecoverySnapshot(original);
  require(result.phase == OfflineTurnPhase::HumanTurn,
          "Restoring a human warning must reopen the human turn.");
}

void verifyGameOverTransitions() {
  const std::string mateInOne = "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1";

  OfflineTurnCoordinator humanMate;
  require(humanMate.loadFen(mateInOne), "Human mate fixture must load.");
  OfflineTurnResult result = performQuietHumanMove(humanMate, "f7", "g7");
  require(result.phase == OfflineTurnPhase::GameOver &&
              result.event == OfflineTurnEvent::GameEnded &&
              !humanMate.pendingEngineRequest().has_value(),
          "Terminal human move must end the game without requesting search.");

  OfflineCoordinatorConfig blackConfig;
  blackConfig.humanColor = HumanColor::Black;
  OfflineTurnCoordinator opponentMate(blackConfig);
  require(opponentMate.loadFen(mateInOne), "Opponent mate fixture must load.");
  result = submitMove(opponentMate, "f7g7");
  require(result.opponentPlan->expectedStatus.outcome == offline::GameOutcome::Checkmate,
          "Staged mate must expose its expected terminal status.");
  result = executeStagedMove(opponentMate);
  require(result.phase == OfflineTurnPhase::GameOver &&
              result.event == OfflineTurnEvent::GameEnded &&
              opponentMate.physical().game().status().outcome == offline::GameOutcome::Checkmate,
          "Verified opponent mate must transition to game over.");

  OfflineTurnCoordinator alreadyTerminal;
  require(alreadyTerminal.loadFen("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1"),
          "Terminal fixture must load.");
  require(alreadyTerminal.phase() == OfflineTurnPhase::GameOver &&
              !alreadyTerminal.pendingEngineRequest(),
          "Loading a terminal position must not request engine search.");

  const std::string terminalDraws[] = {
      "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
      "8/8/8/8/8/8/5k2/7K w - - 0 1",
      "8/8/8/8/8/8/5k2/R6K w - - 100 51"};
  for (const std::string& fen : terminalDraws) {
    OfflineTurnCoordinator draw;
    require(draw.loadFen(fen), "Terminal draw fixture must load.");
    require(draw.phase() == OfflineTurnPhase::GameOver &&
                !draw.pendingEngineRequest(),
            "Terminal draw must load directly into game over.");
  }

  OfflineTurnCoordinator repetition;
  require(repetition.loadFen("r3k1n1/8/8/8/8/8/8/R3K1N1 w - - 0 1"),
          "Sparse repetition fixture must load.");
  for (int cycle = 0; cycle < 2; ++cycle) {
    result = performQuietHumanMove(repetition, "g1", "f3");
    require(result.phase == OfflineTurnPhase::EngineSearchNeeded,
            "Repetition human knight move must request a reply.");
    submitMove(repetition, "g8f6");
    executeStagedMove(repetition);
    result = performQuietHumanMove(repetition, "f3", "g1");
    require(result.phase == OfflineTurnPhase::EngineSearchNeeded,
            "Repetition human return must request a reply.");
    OfflineTurnResult repetitionStaged = submitMove(repetition, "f6g8");
    if (cycle == 1) {
      require(repetitionStaged.opponentPlan->expectedStatus.outcome ==
                  offline::GameOutcome::ThreefoldRepetition,
              "Opponent preview must preserve history when forecasting repetition.");
    }
    result = executeStagedMove(repetition);
  }
  require(result.phase == OfflineTurnPhase::GameOver &&
              repetition.physical().game().status().outcome ==
                  offline::GameOutcome::ThreefoldRepetition,
          "Verified opponent move completing threefold repetition must end the game.");
}

}  // namespace

int main() {
  try {
    verifyWhiteAndBlackTurnCycles();
    verifySearchGenerationAndValidation();
    verifyCapturesCastlingAndEnPassant();
    verifyPromotions();
    verifyExecutionRecoveryAndIdempotency();
    verifyHumanWarningRecovery();
    verifyGameOverTransitions();
    std::cout << "offline turn coordinator regressions passed" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline turn coordinator regression failed: " << error.what() << std::endl;
    return 1;
  }
}
