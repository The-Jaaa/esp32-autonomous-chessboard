#include "../offline_core/offline_phase_execution.h"

#include <algorithm>
#include <cctype>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::GameOutcome;
using offline::GraveyardSlotState;
using offline::HumanColor;
using offline::MotionPhaseKind;
using offline::Occupancy;
using offline::OfflinePhaseExecutionAdapter;
using offline::OfflinePhaseExecutionEvent;
using offline::OfflinePhaseExecutionReport;
using offline::OfflinePhaseExecutionState;
using offline::OfflineReadOnlyRuntime;
using offline::OfflineRuntimeConfig;
using offline::OfflineRuntimePhase;
using offline::OwnershipDecision;
using offline::OwnershipState;
using offline::RootMoveScore;
using offline::SearchResult;
using offline::SearchStopReason;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

OfflineRuntimeConfig runtimeConfig(
    const std::string& fen,
    HumanColor humanColor) {
  OfflineRuntimeConfig config;
  config.initialFen = fen;
  config.setupStableMs = 500;
  config.coordinator.humanColor = humanColor;
  config.coordinator.searchLimits.timeLimitMs = 0;
  config.coordinator.searchLimits.maxDepth = 2;
  config.coordinator.externalSlots = offline::defaultExternalSlots();
  return config;
}

OwnershipDecision offlineOwnership() {
  OwnershipDecision decision;
  decision.state = OwnershipState::OfflineIdle;
  decision.allowOfflineControl = true;
  return decision;
}

SearchResult syntheticSearch(const std::string& move, int score = 100) {
  SearchResult result;
  result.bestMove = move;
  result.score = score;
  result.completedDepth = 4;
  result.stopReason = SearchStopReason::DepthLimit;
  result.outcome = GameOutcome::Ongoing;
  result.rankedRootMoves.push_back(RootMoveScore{move, score, 0});
  return result;
}

void stageMove(OfflineReadOnlyRuntime& runtime, const std::string& move) {
  const Occupancy setup = runtime.expectedSetupOccupancy();
  runtime.applyOwnershipDecision(0, offlineOwnership(), setup);
  const auto armed = runtime.applyOwnershipDecision(500, offlineOwnership(), setup);
  require(armed.phase == OfflineRuntimePhase::EngineSearchNeeded,
          move + ": runtime did not arm on the opponent turn.");
  const auto request = runtime.pendingEngineRequest();
  require(request.has_value(), move + ": engine request is missing.");
  const auto staged = runtime.submitEngineResult(
      request->generation, syntheticSearch(move), setup);
  require(staged.phase == OfflineRuntimePhase::PlanReady &&
              staged.motionTransaction,
          move + ": motion plan did not stage: " + staged.message);
}

OfflinePhaseExecutionReport reportFor(
    const offline::OfflinePhaseExecutionRequest& request,
    bool success,
    const Occupancy& occupancy) {
  return {request.token, success, occupancy};
}

void verifyPreviewRemainsFrozen() {
  OfflineReadOnlyRuntime runtime(runtimeConfig(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      HumanColor::Black));
  stageMove(runtime, "e2e4");
  const std::string before = runtime.coordinator().physical().game().fen();
  const Occupancy expected =
      runtime.coordinator().pendingMotionTransaction()->motion.finalExpectedOccupancy;
  const auto frozen = runtime.processStableSnapshot(600, expected);
  require(frozen.phase == OfflineRuntimePhase::PlanReady && frozen.frozen &&
              runtime.coordinator().physical().game().fen() == before,
          "The accepted preview runtime must still freeze without adapter activation.");
}

void verifyQuietRetryAndTokens() {
  OfflineReadOnlyRuntime runtime(runtimeConfig(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      HumanColor::Black));
  stageMove(runtime, "e2e4");
  const std::string before = runtime.coordinator().physical().game().fen();
  OfflinePhaseExecutionAdapter adapter(runtime);

  auto update = adapter.begin();
  require(update.state == OfflinePhaseExecutionState::PhaseReady && update.request &&
              update.request->token.attempt == 1 &&
              runtime.phase() == OfflineRuntimePhase::OpponentExecuting,
          "Quiet execution did not issue its first phase.");
  const auto first = *update.request;
  require(first.phase.kind == MotionPhaseKind::QuietTransfer,
          "Quiet execution emitted the wrong phase kind.");

  update = adapter.takeCurrentRequest();
  require(update.state == OfflinePhaseExecutionState::AwaitingReport,
          "Taking a phase request must wait for a report.");

  auto staleToken = first.token;
  staleToken.attempt++;
  update = adapter.submitReport(
      {staleToken, true, first.phase.expectedAfter});
  require(update.event == OfflinePhaseExecutionEvent::StaleReportRejected &&
              adapter.state() == OfflinePhaseExecutionState::AwaitingReport &&
              runtime.coordinator().physical().game().fen() == before,
          "A stale attempt token changed execution state.");

  update = adapter.submitReport(
      reportFor(first, false, first.phase.expectedBefore));
  require(update.state == OfflinePhaseExecutionState::RetryReady && update.request &&
              update.request->token.phaseIndex == first.token.phaseIndex &&
              update.request->token.attempt == 2,
          "An unchanged failure did not issue a token-incremented retry.");
  const auto retry = *update.request;

  update = adapter.submitReport(
      reportFor(first, true, first.phase.expectedAfter));
  require(update.event == OfflinePhaseExecutionEvent::StaleReportRejected &&
              adapter.state() == OfflinePhaseExecutionState::RetryReady,
          "A late success from the previous attempt was not rejected.");

  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      reportFor(retry, true, retry.phase.expectedAfter));
  require(update.state == OfflinePhaseExecutionState::Complete &&
              update.event == OfflinePhaseExecutionEvent::MoveCommitted &&
              runtime.phase() == OfflineRuntimePhase::ExecutionComplete &&
              runtime.coordinator().physical().game().fen() != before,
          "The verified quiet retry did not commit exactly once.");

  update = adapter.submitReport(
      reportFor(retry, true, retry.phase.expectedAfter));
  require(update.event == OfflinePhaseExecutionEvent::DuplicateReportIgnored,
          "A duplicate accepted report was not idempotent after commit.");
}

void verifyMismatchRecovery() {
  OfflineReadOnlyRuntime runtime(runtimeConfig(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      HumanColor::Black));
  stageMove(runtime, "d2d4");
  OfflinePhaseExecutionAdapter adapter(runtime);
  auto update = adapter.begin();
  const auto request = *update.request;
  adapter.takeCurrentRequest();

  Occupancy ambiguous = request.phase.expectedBefore;
  ambiguous[static_cast<std::size_t>(offline::squareToRawIndex("a2"))] = false;
  update = adapter.submitReport(reportFor(request, false, ambiguous));
  require(update.state == OfflinePhaseExecutionState::RecoveryRequired &&
              !update.differenceFromBefore.empty(),
          "Ambiguous phase occupancy did not enter recoverable warning.");

  update = adapter.processRecoverySnapshot(request.phase.expectedBefore);
  require(update.state == OfflinePhaseExecutionState::RetryReady && update.request &&
              update.request->token.attempt == 2,
          "Restoring the phase before-state did not issue a new attempt token.");
  const auto retry = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(reportFor(retry, false, retry.phase.expectedAfter));
  require(update.state == OfflinePhaseExecutionState::RecoveryRequired,
          "A failed report at after-occupancy must still require explicit success.");
  update = adapter.processRecoverySnapshot(retry.phase.expectedAfter);
  require(update.state == OfflinePhaseExecutionState::RecoveryRequired,
          "After-occupancy alone incorrectly verified a failed phase.");
  update = adapter.submitReport(reportFor(retry, true, retry.phase.expectedAfter));
  require(update.state == OfflinePhaseExecutionState::Complete,
          "Explicit matching success did not finish recovered execution.");
}

void executeAllPhases(
    OfflinePhaseExecutionAdapter& adapter,
    const std::vector<MotionPhaseKind>& expectedKinds) {
  auto update = adapter.begin();
  std::vector<MotionPhaseKind> actual;
  while (update.state == OfflinePhaseExecutionState::PhaseReady ||
         update.state == OfflinePhaseExecutionState::RetryReady) {
    require(update.request.has_value(), "A ready adapter state has no request.");
    const auto request = *update.request;
    actual.push_back(request.phase.kind);
    adapter.takeCurrentRequest();
    update = adapter.submitReport(
        reportFor(request, true, request.phase.expectedAfter));
  }
  require(actual == expectedKinds, "Phase execution order did not match the motion plan.");
  require(update.state == OfflinePhaseExecutionState::Complete ||
              update.state == OfflinePhaseExecutionState::GameOver ||
              update.state == OfflinePhaseExecutionState::PromotionPending,
          "Phase execution did not reach a terminal adapter state.");
}

void verifyCaptureAndGraveyardRecovery() {
  const std::string fen = "4k3/8/8/3p4/4P3/8/8/4K3 b - - 0 1";
  OfflineReadOnlyRuntime runtime(runtimeConfig(fen, HumanColor::White));
  stageMove(runtime, "d5e4");
  OfflinePhaseExecutionAdapter adapter(runtime);
  auto update = adapter.begin();
  require(update.request &&
              update.request->phase.kind == MotionPhaseKind::CapturedRemoval &&
              update.request->graveyardState == GraveyardSlotState::Pending,
          "Capture did not start with pending captured removal.");
  const auto removal = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(
      reportFor(removal, true, removal.phase.expectedAfter));
  require(update.state == OfflinePhaseExecutionState::PhaseReady && update.request &&
              update.request->graveyardState == GraveyardSlotState::Occupied,
          "Captured removal did not occupy its graveyard slot transactionally.");
  const auto attacker = *update.request;
  adapter.takeCurrentRequest();

  Occupancy ambiguous = attacker.phase.expectedBefore;
  ambiguous[static_cast<std::size_t>(offline::squareToRawIndex("h1"))] = true;
  update = adapter.submitReport(reportFor(attacker, false, ambiguous));
  require(update.state == OfflinePhaseExecutionState::RecoveryRequired,
          "Capture final mismatch did not enter recovery.");
  const Occupancy original = runtime.coordinator().currentState().opponentPlan->beforeOccupancy;
  update = adapter.processRecoverySnapshot(original);
  require(update.event == OfflinePhaseExecutionEvent::GraveyardReleaseRequired,
          "Full board restoration did not retain graveyard ownership.");
  update = adapter.confirmGraveyardSlotReleased("Z8", original);
  require(update.state == OfflinePhaseExecutionState::RecoveryRequired,
          "Wrong graveyard release key should remain recoverable.");
  update = adapter.confirmGraveyardSlotReleased(removal.graveyardSlotKey, original);
  require(update.state == OfflinePhaseExecutionState::RetryReady && update.request &&
              update.request->token.phaseIndex == 0 &&
              update.request->token.attempt == 2,
          "Verified graveyard release did not safely restart the transaction.");
}

void verifySpecialMoves() {
  struct Fixture {
    std::string fen;
    HumanColor human;
    std::string move;
    std::vector<MotionPhaseKind> phases;
  };
  const std::vector<Fixture> fixtures = {
      {"4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", HumanColor::Black, "e5d6",
       {MotionPhaseKind::CapturedRemoval, MotionPhaseKind::AttackerFinal}},
      {"4k3/8/8/8/8/8/8/4K2R w K - 0 1", HumanColor::Black, "e1g1",
       {MotionPhaseKind::CastleKing, MotionPhaseKind::CastleRook}},
      {"4k3/8/8/8/8/8/8/R3K3 w Q - 0 1", HumanColor::Black, "e1c1",
       {MotionPhaseKind::CastleKing, MotionPhaseKind::CastleRook}},
      {"4k2r/8/8/8/8/8/8/4K3 b k - 0 1", HumanColor::White, "e8g8",
       {MotionPhaseKind::CastleKing, MotionPhaseKind::CastleRook}},
      {"r3k3/8/8/8/8/8/8/4K3 b q - 0 1", HumanColor::White, "e8c8",
       {MotionPhaseKind::CastleKing, MotionPhaseKind::CastleRook}},
  };

  for (const auto& fixture : fixtures) {
    OfflineReadOnlyRuntime runtime(runtimeConfig(fixture.fen, fixture.human));
    stageMove(runtime, fixture.move);
    const std::string before = runtime.coordinator().physical().game().fen();
    OfflinePhaseExecutionAdapter adapter(runtime);
    executeAllPhases(adapter, fixture.phases);
    require(runtime.coordinator().physical().game().fen() != before,
            fixture.move + ": special move did not commit.");
  }
}

void verifyPromotion() {
  for (char piece : std::string("qrbn")) {
    const std::string move = std::string("e7e8") + piece;
    OfflineReadOnlyRuntime runtime(runtimeConfig(
        "7k/4P3/8/8/8/8/8/4K3 w - - 0 1", HumanColor::Black));
    stageMove(runtime, move);
    const std::string before = runtime.coordinator().physical().game().fen();
    OfflinePhaseExecutionAdapter adapter(runtime);
    auto update = adapter.begin();
    const auto request = *update.request;
    adapter.takeCurrentRequest();
    update = adapter.submitReport(
        reportFor(request, true, request.phase.expectedAfter));
    require(update.state == OfflinePhaseExecutionState::PromotionPending &&
                runtime.phase() == OfflineRuntimePhase::OpponentPromotionPending &&
                runtime.coordinator().physical().game().fen() == before,
            move + ": promotion motion committed before identity confirmation.");

    const Occupancy expected =
        runtime.coordinator().currentState().opponentPlan->expectedOccupancy;
    Occupancy targetEmpty = expected;
    targetEmpty[static_cast<std::size_t>(offline::squareToRawIndex("e8"))] = false;
    update = adapter.processPromotionSnapshot(targetEmpty);
    require(update.event ==
                OfflinePhaseExecutionEvent::PromotionReplacementInProgress,
            move + ": target-empty replacement was not accepted.");
    update = adapter.processPromotionSnapshot(expected);
    require(update.event == OfflinePhaseExecutionEvent::PromotionConfirmationReady,
            move + ": exact promotion occupancy was not confirmation-ready.");
    update = adapter.confirmPromotion(piece == 'q' ? 'r' : 'q', expected);
    require(update.event ==
                OfflinePhaseExecutionEvent::PromotionConfirmationRejected,
            move + ": wrong promotion identity was accepted.");
    update = adapter.confirmPromotion(piece, expected);
    require(update.state == OfflinePhaseExecutionState::Complete ||
                update.state == OfflinePhaseExecutionState::GameOver,
            move + ": matching promotion identity did not commit.");
  }
}

void verifyGameOver() {
  OfflineReadOnlyRuntime runtime(runtimeConfig(
      "7k/5KQ1/8/8/8/8/8/8 w - - 0 1", HumanColor::Black));
  stageMove(runtime, "g7g8");
  OfflinePhaseExecutionAdapter adapter(runtime);
  executeAllPhases(adapter, {MotionPhaseKind::QuietTransfer});
  require(adapter.state() == OfflinePhaseExecutionState::GameOver &&
              runtime.coordinator().physical().game().status().outcome ==
                  GameOutcome::Checkmate,
          "A verified mating phase did not enter game over.");
}

}  // namespace

int main() {
  try {
    verifyPreviewRemainsFrozen();
    verifyQuietRetryAndTokens();
    verifyMismatchRecovery();
    verifyCaptureAndGraveyardRecovery();
    verifySpecialMoves();
    verifyPromotion();
    verifyGameOver();
    std::cout << "offline phase execution adapter regressions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline phase execution adapter regression failed: "
              << error.what() << '\n';
    return 1;
  }
}
