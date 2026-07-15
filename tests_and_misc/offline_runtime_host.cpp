#include "../offline_core/offline_runtime.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {

using offline::OfflineOwnershipManager;
using offline::OfflineReadOnlyRuntime;
using offline::OfflineRuntimeConfig;
using offline::OfflineRuntimeEvent;
using offline::OfflineRuntimePhase;
using offline::Occupancy;
using offline::OwnershipDecision;
using offline::OwnershipState;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

OfflineRuntimeConfig runtimeConfig(std::string initialFen = {}) {
  OfflineRuntimeConfig config;
  config.initialFen = std::move(initialFen);
  config.setupStableMs = 500;
  config.coordinator.humanColor = offline::HumanColor::White;
  config.coordinator.searchLimits.timeLimitMs = 0;
  config.coordinator.searchLimits.maxNodes = 2000;
  config.coordinator.searchLimits.maxDepth = 12;
  config.coordinator.externalSlots = offline::defaultExternalSlots();
  return config;
}

OwnershipDecision enterOffline(OfflineOwnershipManager& manager, std::uint32_t now = 10000) {
  const auto decision = manager.tick(now);
  require(decision.state == OwnershipState::OfflineIdle && decision.allowOfflineControl,
          "The ownership fixture did not enter offline idle.");
  return decision;
}

void armRuntime(
    OfflineReadOnlyRuntime& runtime,
    OfflineOwnershipManager& manager,
    const Occupancy& setup,
    std::uint32_t startedAt = 10000) {
  auto update = runtime.applyOwnershipDecision(startedAt, enterOffline(manager, startedAt), setup);
  require(update.phase == OfflineRuntimePhase::WaitingForSetup &&
              update.event == OfflineRuntimeEvent::SetupStabilizing,
          "An exact setup must begin the stability hold.");
  update = runtime.applyOwnershipDecision(
      startedAt + 499, manager.tick(startedAt + 499, runtime.ownershipSafety(setup)), setup);
  require(update.phase == OfflineRuntimePhase::WaitingForSetup,
          "The setup gate armed before 500 ms elapsed.");
  update = runtime.applyOwnershipDecision(
      startedAt + 500, manager.tick(startedAt + 500, runtime.ownershipSafety(setup)), setup);
  require(update.phase == OfflineRuntimePhase::HumanTurn &&
              update.event == OfflineRuntimeEvent::SessionArmed,
          "The exact setup did not arm after 500 ms.");
}

offline::OfflineRuntimeUpdate makeHumanMove(
    OfflineReadOnlyRuntime& runtime,
    Occupancy& occupancy,
    const std::string& from,
    const std::string& to,
    std::uint32_t& now) {
  const int fromIndex = offline::squareToRawIndex(from);
  const int toIndex = offline::squareToRawIndex(to);
  require(fromIndex >= 0 && toIndex >= 0, "Move fixture used an invalid square.");

  occupancy[static_cast<std::size_t>(fromIndex)] = false;
  const auto lifted = runtime.processStableSnapshot(++now, occupancy);
  require(lifted.phase == OfflineRuntimePhase::HumanTurn,
          "A legal source lift did not remain in the human turn.");

  occupancy[static_cast<std::size_t>(toIndex)] = true;
  return runtime.processStableSnapshot(++now, occupancy);
}

offline::SearchResult searchPending(const OfflineReadOnlyRuntime& runtime) {
  const auto request = runtime.pendingEngineRequest();
  require(request.has_value(), "The runtime did not expose its split-phase engine request.");
  return offline::OfflineEngine{}.searchFen(request->fen, request->limits);
}

void verifyOnlineDisabledAndSetupGate() {
  OfflineReadOnlyRuntime runtime(runtimeConfig());
  const Occupancy setup = runtime.expectedSetupOccupancy();
  OfflineOwnershipManager onlineManager;
  offline::ServerHeartbeat heartbeat;
  heartbeat.success = true;
  heartbeat.protocolVersion = offline::kOfflineOwnershipProtocolVersion;
  heartbeat.serverInstanceId = "server-a";
  heartbeat.sessionGeneration = 1;
  heartbeat.safeToSwitch = true;
  const auto online = onlineManager.observeHeartbeat(0, heartbeat);
  auto update = runtime.applyOwnershipDecision(0, online, setup);
  require(update.phase == OfflineRuntimePhase::Disabled && !update.sessionActive,
          "An online-owned board must not arm the offline runtime.");

  OfflineOwnershipManager offlineManager;
  Occupancy wrong = setup;
  const int e2 = offline::squareToRawIndex("e2");
  wrong[static_cast<std::size_t>(e2)] = false;
  update = runtime.applyOwnershipDecision(10000, enterOffline(offlineManager), wrong);
  require(update.phase == OfflineRuntimePhase::WaitingForSetup &&
              update.event == OfflineRuntimeEvent::SetupMismatch &&
              update.setupDifference.missing == std::vector<std::string>{"e2"},
          "A missing starting piece was not reported exactly.");

  update = runtime.processStableSnapshot(11000, setup);
  require(update.event == OfflineRuntimeEvent::SetupStabilizing,
          "Restoring setup must restart the stability timer.");
  update = runtime.processStableSnapshot(11499, setup);
  require(update.phase == OfflineRuntimePhase::WaitingForSetup,
          "Restored setup armed too early.");
  update = runtime.processStableSnapshot(11500, setup);
  require(update.phase == OfflineRuntimePhase::HumanTurn && update.sessionActive,
          "Restored setup did not arm after the full stability interval.");

  OfflineReadOnlyRuntime invalid(runtimeConfig("not-a-fen"));
  require(invalid.phase() == OfflineRuntimePhase::Error,
          "An invalid initial FEN must fail closed.");
}

void verifyHumanCancellationAndRecovery() {
  OfflineReadOnlyRuntime runtime(runtimeConfig());
  OfflineOwnershipManager manager;
  Occupancy occupancy = runtime.expectedSetupOccupancy();
  armRuntime(runtime, manager, occupancy);

  std::uint32_t now = 10500;
  const int g1 = offline::squareToRawIndex("g1");
  occupancy[static_cast<std::size_t>(g1)] = false;
  auto update = runtime.processStableSnapshot(++now, occupancy);
  require(update.phase == OfflineRuntimePhase::HumanTurn,
          "A legal knight lift did not remain recoverable.");
  occupancy[static_cast<std::size_t>(g1)] = true;
  update = runtime.processStableSnapshot(++now, occupancy);
  require(update.phase == OfflineRuntimePhase::HumanTurn,
          "Returning a lifted piece did not cancel cleanly.");
  const std::string originalFen = update.committedFen;
  update = runtime.processStableSnapshot(++now, occupancy);
  require(update.event == OfflineRuntimeEvent::None && update.committedFen == originalFen,
          "A duplicate snapshot changed runtime state.");

  const int d2 = offline::squareToRawIndex("d2");
  const int e2 = offline::squareToRawIndex("e2");
  occupancy[static_cast<std::size_t>(d2)] = false;
  occupancy[static_cast<std::size_t>(e2)] = false;
  update = runtime.processStableSnapshot(++now, occupancy);
  require(update.phase == OfflineRuntimePhase::SyncWarning &&
              update.event == OfflineRuntimeEvent::RestoreRequired,
          "A multi-piece disturbance did not enter recoverable sync warning.");
  occupancy = runtime.coordinator().physical().committedOccupancy();
  update = runtime.processStableSnapshot(++now, occupancy);
  require(update.phase == OfflineRuntimePhase::HumanTurn,
          "Restoring a human disturbance did not recover the turn.");
}

void verifyEnginePreviewAndFreeze() {
  OfflineReadOnlyRuntime runtime(runtimeConfig());
  OfflineOwnershipManager manager;
  Occupancy occupancy = runtime.expectedSetupOccupancy();
  armRuntime(runtime, manager, occupancy);

  std::uint32_t now = 10500;
  auto moved = makeHumanMove(runtime, occupancy, "e2", "e4", now);
  require(moved.phase == OfflineRuntimePhase::EngineSearchNeeded &&
              moved.event == OfflineRuntimeEvent::HumanMoveAccepted &&
              moved.acceptedMove.has_value() && moved.acceptedMove->uci == "e2e4",
          "The human move did not create the engine request.");
  const auto request = runtime.pendingEngineRequest();
  require(request.has_value(), "Accepted human move has no engine request.");
  const std::string humanFen = request->fen;

  const auto result = searchPending(runtime);
  require(result.hasMove(), "The deterministic test engine did not return a move.");
  auto rejected = runtime.submitEngineResult(request->generation + 1, result, occupancy);
  require(rejected.phase == OfflineRuntimePhase::EngineSearchNeeded &&
              rejected.event == OfflineRuntimeEvent::EngineResultRejected &&
              runtime.pendingEngineRequest()->generation == request->generation,
          "A stale engine generation did not leave the current request intact.");

  auto planned = runtime.submitEngineResult(request->generation, result, occupancy);
  require(planned.phase == OfflineRuntimePhase::PlanReady &&
              planned.event == OfflineRuntimeEvent::MotionPlanReady && planned.frozen &&
              planned.motionTransaction.has_value(),
          "A legal engine result did not produce a frozen motion preview.");
  const auto transaction = *planned.motionTransaction;
  require(!transaction.motion.phases.empty() && transaction.currentPhase == 0 &&
              std::none_of(transaction.verifiedPhases.begin(),
                           transaction.verifiedPhases.end(), [](bool value) { return value; }),
          "The preview unexpectedly verified or executed a motion phase.");
  require(planned.committedFen == humanFen &&
              runtime.coordinator().physical().game().fen() == humanFen &&
              runtime.coordinator().phase() == offline::OfflineTurnPhase::OpponentMoveReady,
          "Staging the engine plan mutated the authoritative chess position.");

  const Occupancy pretendExecuted = transaction.motion.finalExpectedOccupancy;
  const auto frozen = runtime.processStableSnapshot(++now, pretendExecuted);
  require(frozen.phase == OfflineRuntimePhase::PlanReady &&
              frozen.event == OfflineRuntimeEvent::FrozenSnapshotObserved &&
              frozen.committedFen == humanFen &&
              runtime.coordinator().phase() == offline::OfflineTurnPhase::OpponentMoveReady,
          "A physical post-move snapshot bypassed the read-only freeze.");
}

void verifyPlanningSyncRecovery() {
  OfflineReadOnlyRuntime runtime(runtimeConfig());
  OfflineOwnershipManager manager;
  Occupancy occupancy = runtime.expectedSetupOccupancy();
  armRuntime(runtime, manager, occupancy);

  std::uint32_t now = 10500;
  static_cast<void>(makeHumanMove(runtime, occupancy, "d2", "d4", now));
  const auto request = runtime.pendingEngineRequest();
  require(request.has_value(), "Planning recovery fixture has no engine request.");
  const auto result = searchPending(runtime);

  Occupancy disturbed = occupancy;
  const int b1 = offline::squareToRawIndex("b1");
  disturbed[static_cast<std::size_t>(b1)] = false;
  auto warning = runtime.submitEngineResult(request->generation, result, disturbed);
  require(warning.phase == OfflineRuntimePhase::SyncWarning &&
              warning.event == OfflineRuntimeEvent::RestoreRequired,
          "A stale sensed board did not pause motion planning.");

  warning = runtime.processStableSnapshot(++now, disturbed);
  require(warning.phase == OfflineRuntimePhase::SyncWarning,
          "An unresolved planning mismatch advanced unexpectedly.");
  const auto recovered = runtime.processStableSnapshot(++now, occupancy);
  require(recovered.phase == OfflineRuntimePhase::PlanReady &&
              recovered.motionTransaction.has_value(),
          "Restoring the committed board did not reuse the retained search result.");
}

void verifyReconnectBoundaries() {
  OfflineReadOnlyRuntime boundaryRuntime(runtimeConfig());
  OfflineOwnershipManager boundaryManager;
  Occupancy setup = boundaryRuntime.expectedSetupOccupancy();
  armRuntime(boundaryRuntime, boundaryManager, setup);

  offline::ServerHeartbeat heartbeat;
  heartbeat.success = true;
  heartbeat.protocolVersion = offline::kOfflineOwnershipProtocolVersion;
  heartbeat.serverInstanceId = "server-returned";
  heartbeat.sessionGeneration = 1;
  heartbeat.safeToSwitch = true;

  auto first = boundaryManager.observeHeartbeat(
      11000, heartbeat, boundaryRuntime.ownershipSafety(setup));
  auto update = boundaryRuntime.applyOwnershipDecision(11000, first, setup);
  require(update.phase == OfflineRuntimePhase::HumanTurn,
          "One reconnect heartbeat changed ownership prematurely.");
  auto second = boundaryManager.observeHeartbeat(
      12000, heartbeat, boundaryRuntime.ownershipSafety(setup));
  update = boundaryRuntime.applyOwnershipDecision(12000, second, setup);
  require(second.handoffRequired && update.phase == OfflineRuntimePhase::HandoffPending &&
              update.event == OfflineRuntimeEvent::HandoffRequired,
          "A stable reconnect at the human boundary did not freeze for handoff.");

  OfflineReadOnlyRuntime midTurnRuntime(runtimeConfig());
  OfflineOwnershipManager midTurnManager;
  Occupancy occupancy = midTurnRuntime.expectedSetupOccupancy();
  armRuntime(midTurnRuntime, midTurnManager, occupancy);
  std::uint32_t now = 10500;
  static_cast<void>(makeHumanMove(midTurnRuntime, occupancy, "c2", "c4", now));
  first = midTurnManager.observeHeartbeat(
      11000, heartbeat, midTurnRuntime.ownershipSafety(occupancy));
  static_cast<void>(midTurnRuntime.applyOwnershipDecision(11000, first, occupancy));
  second = midTurnManager.observeHeartbeat(
      12000, heartbeat, midTurnRuntime.ownershipSafety(occupancy));
  update = midTurnRuntime.applyOwnershipDecision(12000, second, occupancy);
  require(!second.handoffRequired && update.phase == OfflineRuntimePhase::EngineSearchNeeded,
          "A reconnect interrupted an incomplete offline turn.");

  const auto request = midTurnRuntime.pendingEngineRequest();
  const auto result = searchPending(midTurnRuntime);
  update = midTurnRuntime.submitEngineResult(request->generation, result, occupancy);
  require(update.phase == OfflineRuntimePhase::PlanReady,
          "The in-progress offline turn did not reach its read-only preview.");
}

void verifyTerminalHumanMove() {
  OfflineReadOnlyRuntime runtime(
      runtimeConfig("7k/5Q2/6K1/8/8/8/8/8 w - - 0 1"));
  OfflineOwnershipManager manager;
  Occupancy occupancy = runtime.expectedSetupOccupancy();
  armRuntime(runtime, manager, occupancy);

  std::uint32_t now = 10500;
  const auto ended = makeHumanMove(runtime, occupancy, "f7", "g7", now);
  require(ended.phase == OfflineRuntimePhase::GameOver &&
              ended.event == OfflineRuntimeEvent::GameEnded &&
              ended.acceptedMove.has_value() &&
              ended.acceptedMove->san.find('#') != std::string::npos &&
              !runtime.pendingEngineRequest().has_value(),
          "A terminal human move incorrectly requested an opponent search.");
}

}  // namespace

int main() {
  try {
    verifyOnlineDisabledAndSetupGate();
    verifyHumanCancellationAndRecovery();
    verifyEnginePreviewAndFreeze();
    verifyPlanningSyncRecovery();
    verifyReconnectBoundaries();
    verifyTerminalHumanMove();
    std::cout << "offline runtime regressions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline runtime regression failed: " << error.what() << '\n';
    return 1;
  }
}
