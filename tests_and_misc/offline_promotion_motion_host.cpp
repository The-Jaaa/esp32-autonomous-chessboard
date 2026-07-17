#include "../offline_core/offline_engine.h"
#include "../offline_core/offline_promotion_motion.h"

#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::CaptureMotionPrimitiveKind;
using offline::ExternalRouteMode;
using offline::GraveyardSlotState;
using offline::HumanColor;
using offline::MotionPhaseKind;
using offline::MotionPlanningContext;
using offline::Occupancy;
using offline::OfflineEngine;
using offline::OfflineGame;
using offline::OfflinePhaseExecutionAdapter;
using offline::OfflinePhaseExecutionReport;
using offline::OfflinePhaseExecutionRequest;
using offline::OfflinePhaseExecutionState;
using offline::OfflinePromotionMotionCompiler;
using offline::OfflinePromotionReplacementGate;
using offline::OfflineReadOnlyRuntime;
using offline::OfflineRuntimeConfig;
using offline::OfflineRuntimePhase;
using offline::OwnershipDecision;
using offline::OwnershipState;
using offline::PromotionReplacementEvent;
using offline::PromotionReplacementState;
using offline::RootMoveScore;
using offline::SearchResult;
using offline::SearchStopReason;

constexpr const char* kInitialFen =
    "4k3/8/8/8/8/8/p7/4K3 w - - 0 1";
constexpr const char* kPostHumanFen =
    "4k3/8/8/8/8/8/p4K2/8 b - - 1 1";
constexpr const char* kFinalFen =
    "4k3/8/8/8/8/8/5K2/q7 w - - 0 2";

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void setSquare(Occupancy& occupancy, const std::string& square, bool occupied) {
  const int rawIndex = offline::squareToRawIndex(square);
  require(rawIndex >= 0, "Invalid test square: " + square);
  occupancy[static_cast<std::size_t>(rawIndex)] = occupied;
}

std::size_t finalBoardOvershoots(const offline::CaptureMotionProgram& program) {
  return static_cast<std::size_t>(std::count_if(
      program.primitives.begin(),
      program.primitives.end(),
      [](const offline::CaptureMotionPrimitive& primitive) {
        return primitive.finalBoardDrop;
      }));
}

struct PlannedPromotion {
  offline::MotionPlan plan;
  std::vector<OfflinePhaseExecutionRequest> requests;
};

PlannedPromotion planPromotion(const std::string& fen, const std::string& uci) {
  OfflineGame game;
  require(game.loadFen(fen), uci + ": promotion FEN did not load.");
  MotionPlanningContext context;
  context.slots = offline::defaultExternalSlots();
  PlannedPromotion fixture;
  fixture.plan = offline::OfflineMotionPlanner{}.planMove(game, uci, context);
  require(fixture.plan.success(), uci + ": promotion motion planning failed.");
  for (std::size_t index = 0; index < fixture.plan.phases.size(); ++index) {
    OfflinePhaseExecutionRequest request;
    request.token = {1, index, 1};
    request.move = fixture.plan.move;
    request.phase = fixture.plan.phases[index];
    if (fixture.plan.proposedGraveyardSlot) {
      request.graveyardSlotKey =
          offline::externalSlotKey(*fixture.plan.proposedGraveyardSlot);
      request.graveyardState =
          request.phase.kind == MotionPhaseKind::AttackerFinal
              ? GraveyardSlotState::Occupied
              : GraveyardSlotState::Pending;
    }
    fixture.requests.push_back(std::move(request));
  }
  return fixture;
}

void verifyControlledFixture() {
  OfflineEngine engine;
  offline::SearchLimits limits;
  limits.timeLimitMs = 0;
  limits.maxNodes = 50000;
  limits.maxDepth = 12;
  const auto search = engine.searchFen(kPostHumanFen, limits);
  require(
      search.bestMove == "a2a1q",
      "The deterministic engine no longer selects a2a1q.");

  const PlannedPromotion fixture = planPromotion(kPostHumanFen, "a2a1q");
  require(
      fixture.plan.strategy == offline::MotionStrategy::Quiet &&
          fixture.plan.routeCost == 0.0 && fixture.plan.phases.size() == 1 &&
          fixture.plan.phases.front().transfer &&
          fixture.plan.phases.front().transfer->mode == ExternalRouteMode::Direct &&
          fixture.plan.rawPathSquares == std::vector<std::string>({"a2", "a1"}),
      "Controlled promotion route or cost changed.");
  const auto program = OfflinePromotionMotionCompiler{}.compile(
      fixture.requests.front());
  require(
      program.success() && program.moveUci == "a2a1q" &&
          program.routeMode == ExternalRouteMode::Direct &&
          finalBoardOvershoots(program) == 1 &&
          program.primitives.size() == 5 &&
          program.primitives[2].kind == CaptureMotionPrimitiveKind::DragBoard &&
          program.primitives[2].targetRawIndex == offline::squareToRawIndex("a1"),
      "Controlled promotion primitive program changed.");

  OfflineGame final;
  offline::MoveInfo move;
  require(
      final.loadFen(kPostHumanFen) && final.applyUci("a2a1q", move) &&
          move.san == "a1=Q" && final.fen() == kFinalFen,
      "Controlled promotion SAN or final FEN changed.");
}

void verifyAllPiecesAndColors() {
  const OfflinePromotionMotionCompiler compiler;
  for (const char piece : std::string("qrbn")) {
    for (const auto& entry : std::vector<std::pair<std::string, std::string>>{
             {"4k3/P7/8/8/8/8/8/4K3 w - - 0 1",
              std::string("a7a8") + piece},
             {"4k3/8/8/8/8/8/p7/4K3 b - - 0 1",
              std::string("a2a1") + piece}}) {
      const PlannedPromotion fixture = planPromotion(entry.first, entry.second);
      require(fixture.requests.size() == 1, entry.second + ": quiet phase count changed.");
      const auto program = compiler.compile(fixture.requests.front());
      require(
          program.success() && program.moveUci == entry.second &&
              finalBoardOvershoots(program) == 1,
          entry.second + ": quiet promotion compilation failed.");
    }

    for (const auto& entry : std::vector<std::pair<std::string, std::string>>{
             {"1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1",
              std::string("a7b8") + piece},
             {"4k3/8/8/8/8/8/p7/1R2K3 b - - 0 1",
              std::string("a2b1") + piece}}) {
      const PlannedPromotion fixture = planPromotion(entry.first, entry.second);
      require(fixture.requests.size() >= 2, entry.second + ": capture phases missing.");
      for (const auto& request : fixture.requests) {
        const auto program = compiler.compile(request);
        require(program.success(), entry.second + ": capture phase compilation failed.");
        if (request.phase.kind == MotionPhaseKind::CapturedRemoval) {
          require(
              finalBoardOvershoots(program) == 0,
              entry.second + ": graveyard removal received overshoot.");
        }
        if (request.phase.kind == MotionPhaseKind::AttackerFinal) {
          require(
              finalBoardOvershoots(program) == 1,
              entry.second + ": final promoted pawn drop lacks overshoot.");
        }
      }
    }
  }
}

OfflinePhaseExecutionRequest forcedRoute(
    const OfflinePhaseExecutionRequest& source,
    const std::vector<offline::ExternalSlot>& slots) {
  OfflinePhaseExecutionRequest request = source;
  offline::ExternalTransferRequest route;
  route.from = source.phase.from;
  route.to = source.phase.to;
  route.expectedOccupancy = source.phase.expectedBefore;
  route.ignoredSquares = {source.phase.from, source.phase.to};
  route.slots = slots;
  route.forceLane = true;
  request.phase.transfer = offline::OfflineExternalRoutePlanner{}.planTransfer(route);
  require(request.phase.transfer->success(), "Forced promotion lane route failed.");
  return request;
}

void verifyLaneRoutes() {
  const PlannedPromotion quiet = planPromotion(
      "4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8q");
  auto lane = forcedRoute(quiet.requests.front(), offline::defaultExternalSlots());
  require(
      lane.phase.transfer->mode == ExternalRouteMode::Lane &&
          OfflinePromotionMotionCompiler{}.compile(lane).success(),
      "Quiet promotion Lane route was rejected.");

  std::vector<offline::ExternalSlot> limited;
  for (const auto& slot : offline::defaultExternalSlots()) {
    if (slot.label == "I7") limited.push_back(slot);
  }
  auto laneBoard = forcedRoute(quiet.requests.front(), limited);
  const auto laneBoardProgram =
      OfflinePromotionMotionCompiler{}.compile(laneBoard);
  require(
      laneBoard.phase.transfer->mode == ExternalRouteMode::LaneBoard &&
          laneBoardProgram.success(),
      "Quiet promotion LaneBoard route was rejected: " +
          laneBoardProgram.blockedReason);

  const PlannedPromotion capture = planPromotion(
      "1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7b8n");
  auto final = capture.requests.back();
  final = forcedRoute(final, offline::defaultExternalSlots());
  require(
      (final.phase.transfer->mode == ExternalRouteMode::Lane ||
       final.phase.transfer->mode == ExternalRouteMode::LaneBoard) &&
          OfflinePromotionMotionCompiler{}.compile(final).success(),
      "Capture-promotion attacker lane route was rejected.");
}

void verifyMalformedRequestsRejected() {
  const PlannedPromotion fixture = planPromotion(kPostHumanFen, "a2a1q");
  const OfflinePromotionMotionCompiler compiler;
  auto request = fixture.requests.front();

  request.move.promotion = "x";
  request.move.uci = "a2a1x";
  require(!compiler.compile(request).success(), "Invalid promotion identity was accepted.");
  request = fixture.requests.front();
  request.move.piece = "n";
  require(!compiler.compile(request).success(), "A non-pawn promotion was accepted.");
  request = fixture.requests.front();
  request.move.from = "a3";
  request.move.uci = "a3a1q";
  require(!compiler.compile(request).success(), "Wrong-rank promotion was accepted.");
  request = fixture.requests.front();
  request.move.enPassant = true;
  require(!compiler.compile(request).success(), "En passant promotion was accepted.");
  request = fixture.requests.front();
  request.phase.expectedAfter = request.phase.expectedBefore;
  require(!compiler.compile(request).success(), "Unchanged occupancy was accepted.");
}

void verifyReplacementGate() {
  const Occupancy expected = offline::occupancyFromFen(kFinalFen);
  Occupancy empty = expected;
  setSquare(empty, "a1", false);
  OfflinePromotionReplacementGate gate;
  auto update = gate.arm("a1", 'Q', expected);
  require(
      update.state == PromotionReplacementState::WaitingForLift &&
          update.event == PromotionReplacementEvent::Armed,
      "Replacement gate did not arm.");
  update = gate.processSnapshot(expected);
  require(
      update.state == PromotionReplacementState::WaitingForLift &&
          !gate.liftObserved(),
      "Occupied target incorrectly bypassed the required lift.");
  require(
      gate.confirm('q', expected).event ==
          PromotionReplacementEvent::ConfirmationRejected,
      "Confirmation before lift was accepted.");
  update = gate.processSnapshot(empty);
  require(
      update.event == PromotionReplacementEvent::PawnLifted &&
          gate.liftObserved(),
      "Pawn lift was not observed.");
  require(
      gate.processSnapshot(empty).state ==
          PromotionReplacementState::WaitingForReplacement,
      "Duplicate empty snapshot changed replacement state.");
  Occupancy disturbed = empty;
  setSquare(disturbed, "e8", false);
  update = gate.processSnapshot(disturbed);
  require(
      update.state == PromotionReplacementState::SyncWarning &&
          update.event == PromotionReplacementEvent::RecoveryRequired &&
          !update.differenceFromExpected.empty(),
      "Unrelated disturbance did not enter SyncWarning.");
  require(
      gate.processSnapshot(empty).state ==
          PromotionReplacementState::WaitingForReplacement,
      "Empty-target recovery did not resume replacement.");
  update = gate.processSnapshot(expected);
  require(
      update.state == PromotionReplacementState::ReadyToConfirm &&
          update.event == PromotionReplacementEvent::ReplacementReady,
      "Reoccupied target did not become confirmation-ready.");
  require(
      gate.confirm('r', expected).event ==
          PromotionReplacementEvent::ConfirmationRejected,
      "Wrong replacement identity was accepted.");
  require(
      gate.confirm('q', expected).state == PromotionReplacementState::Complete,
      "Matching replacement confirmation did not complete.");
}

OfflineRuntimeConfig runtimeConfig() {
  OfflineRuntimeConfig config;
  config.initialFen = kInitialFen;
  config.coordinator.humanColor = HumanColor::White;
  config.coordinator.searchLimits.timeLimitMs = 0;
  config.coordinator.searchLimits.maxNodes = 2000;
  config.coordinator.searchLimits.maxDepth = 12;
  config.coordinator.externalSlots = offline::defaultExternalSlots();
  return config;
}

OwnershipDecision offlineOwnership() {
  OwnershipDecision decision;
  decision.state = OwnershipState::OfflineIdle;
  decision.allowOfflineControl = true;
  return decision;
}

SearchResult promotionSearch() {
  SearchResult result;
  result.bestMove = "a2a1q";
  result.score = 936;
  result.completedDepth = 7;
  result.nodes = 50000;
  result.stopReason = SearchStopReason::NodeLimit;
  result.rankedRootMoves.push_back(RootMoveScore{"a2a1q", 936, 0});
  return result;
}

struct RuntimeFixture {
  OfflineReadOnlyRuntime runtime{runtimeConfig()};
  Occupancy postHuman{};
};

void armRuntime(RuntimeFixture& fixture) {
  const Occupancy setup = fixture.runtime.expectedSetupOccupancy();
  fixture.runtime.applyOwnershipDecision(0, offlineOwnership(), setup);
  auto update = fixture.runtime.applyOwnershipDecision(500, offlineOwnership(), setup);
  require(update.phase == OfflineRuntimePhase::HumanTurn, "Promotion runtime did not arm.");
  Occupancy lifted = setup;
  setSquare(lifted, "e1", false);
  fixture.runtime.processStableSnapshot(510, lifted);
  fixture.postHuman = lifted;
  setSquare(fixture.postHuman, "f2", true);
  update = fixture.runtime.processStableSnapshot(520, fixture.postHuman);
  require(
      update.phase == OfflineRuntimePhase::EngineSearchNeeded &&
          update.acceptedMove && update.acceptedMove->uci == "e1f2",
      "Physical e1f2 was not accepted.");
  const auto searchRequest = fixture.runtime.pendingEngineRequest();
  require(searchRequest.has_value(), "Promotion engine request is missing.");
  update = fixture.runtime.submitEngineResult(
      searchRequest->generation, promotionSearch(), fixture.postHuman);
  require(
      update.phase == OfflineRuntimePhase::PlanReady &&
          update.motionTransaction &&
          update.motionTransaction->selectedMove == "a2a1q" &&
          fixture.runtime.coordinator().physical().game().fen() == kPostHumanFen,
      "Promotion transaction was not staged without committing.");
}

OfflinePhaseExecutionReport reportFor(
    const OfflinePhaseExecutionRequest& request,
    bool success,
    const Occupancy& occupancy) {
  return {request.token, success, occupancy};
}

void verifyTransactionAndRetry() {
  RuntimeFixture fixture;
  armRuntime(fixture);
  OfflinePhaseExecutionAdapter adapter(fixture.runtime);
  auto update = adapter.begin();
  require(update.request.has_value(), "Promotion phase was not issued.");
  auto request = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(reportFor(request, false, request.phase.expectedBefore));
  require(
      update.state == OfflinePhaseExecutionState::RetryReady && update.request &&
          update.request->token.attempt == 2 &&
          offline::promotionMotionAttemptAllowed(update.request->token),
      "Unchanged promotion motion did not retry once.");
  request = *update.request;
  adapter.takeCurrentRequest();
  update = adapter.submitReport(reportFor(request, true, request.phase.expectedAfter));
  require(
      update.state == OfflinePhaseExecutionState::PromotionPending &&
          fixture.runtime.coordinator().physical().game().fen() == kPostHumanFen,
      "Verified pawn motion did not wait for replacement with immutable FEN.");

  const Occupancy expected = request.phase.expectedAfter;
  Occupancy empty = expected;
  setSquare(empty, "a1", false);
  OfflinePromotionReplacementGate gate;
  gate.arm("a1", 'q', expected);
  require(
      gate.processSnapshot(expected).state ==
          PromotionReplacementState::WaitingForLift,
      "Promotion committed before lift in the transaction gate.");
  gate.processSnapshot(empty);
  update = adapter.processPromotionSnapshot(empty);
  require(
      update.event == offline::OfflinePhaseExecutionEvent::PromotionReplacementInProgress,
      "Adapter did not accept the empty promotion square.");
  gate.processSnapshot(expected);
  update = adapter.processPromotionSnapshot(expected);
  require(
      update.event == offline::OfflinePhaseExecutionEvent::PromotionConfirmationReady,
      "Adapter did not become promotion-confirmation ready.");
  require(
      adapter.confirmPromotion('r', expected).event ==
          offline::OfflinePhaseExecutionEvent::PromotionConfirmationRejected,
      "Wrong identity committed the promotion.");
  gate.confirm('q', expected);
  update = adapter.confirmPromotion('q', expected);
  require(
      update.state == OfflinePhaseExecutionState::Complete &&
          fixture.runtime.coordinator().physical().game().fen() == kFinalFen,
      "Matching replacement did not commit the final promotion FEN.");

  RuntimeFixture exhaustedFixture;
  armRuntime(exhaustedFixture);
  OfflinePhaseExecutionAdapter exhausted(exhaustedFixture.runtime);
  update = exhausted.begin();
  request = *update.request;
  exhausted.takeCurrentRequest();
  update = exhausted.submitReport(reportFor(request, false, request.phase.expectedBefore));
  request = *update.request;
  exhausted.takeCurrentRequest();
  update = exhausted.submitReport(reportFor(request, false, request.phase.expectedBefore));
  require(
      update.request && update.request->token.attempt == 3 &&
          !offline::promotionMotionAttemptAllowed(update.request->token),
      "A third promotion-motion attempt was not blocked.");
}

void verifyAmbiguousMotionRecovery() {
  RuntimeFixture fixture;
  armRuntime(fixture);
  OfflinePhaseExecutionAdapter adapter(fixture.runtime);
  auto update = adapter.begin();
  const auto request = *update.request;
  adapter.takeCurrentRequest();
  Occupancy ambiguous = request.phase.expectedBefore;
  setSquare(ambiguous, "a2", false);
  update = adapter.submitReport(reportFor(request, false, ambiguous));
  require(
      update.state == OfflinePhaseExecutionState::RecoveryRequired &&
          fixture.runtime.coordinator().physical().game().fen() == kPostHumanFen,
      "Ambiguous promotion motion did not freeze with immutable FEN.");
}

}  // namespace

int main() {
  try {
    verifyControlledFixture();
    verifyAllPiecesAndColors();
    verifyLaneRoutes();
    verifyMalformedRequestsRejected();
    verifyReplacementGate();
    verifyTransactionAndRetry();
    verifyAmbiguousMotionRecovery();
    std::cout << "offline promotion motion regressions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline promotion motion regression failed: "
              << error.what() << '\n';
    return 1;
  }
}
