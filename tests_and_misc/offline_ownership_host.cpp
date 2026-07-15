#include "../offline_core/offline_ownership.h"

#include <cstdint>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>

namespace {

using offline::OfflineOwnershipManager;
using offline::OwnershipEvent;
using offline::OwnershipSafety;
using offline::OwnershipState;
using offline::ServerHeartbeat;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

ServerHeartbeat heartbeat(
    std::string server = "server-a", std::uint32_t generation = 7) {
  return {true, offline::kOfflineOwnershipProtocolVersion, std::move(server),
          generation, false, true};
}

ServerHeartbeat failure() {
  return {};
}

void failThree(OfflineOwnershipManager& manager, std::uint32_t& now, OwnershipSafety safety = {}) {
  for (int i = 0; i < 3; ++i) {
    now += 1000;
    static_cast<void>(manager.observeHeartbeat(now, failure(), safety));
  }
}

void verifyDefaultsAndBoot() {
  OfflineOwnershipManager manager;
  require(manager.config().bootProbeWindowMs == 10000 &&
              manager.config().heartbeatIntervalMs == 1000 &&
              manager.config().httpTimeoutMs == 1000 &&
              manager.config().failureThreshold == 3 &&
              manager.config().reconnectSuccessThreshold == 2,
          "Ownership defaults changed unexpectedly.");
  require(manager.heartbeatDue(0), "The first boot heartbeat must be immediately due.");

  auto online = manager.observeHeartbeat(0, heartbeat());
  require(online.state == OwnershipState::OnlineOwned &&
              online.event == OwnershipEvent::EnteredOnline &&
              online.allowOnlineTraffic && online.allowNewMotion,
          "A valid boot heartbeat must establish online ownership.");

  manager.reset(500);
  static_cast<void>(manager.observeHeartbeat(500, failure()));
  static_cast<void>(manager.observeHeartbeat(1500, failure()));
  static_cast<void>(manager.observeHeartbeat(2500, failure()));
  require(manager.state() == OwnershipState::BootProbe,
          "Boot failures must not bypass the full probe window.");
  require(manager.tick(10499).state == OwnershipState::BootProbe,
          "Boot probe expired one millisecond early.");
  const auto offline = manager.tick(10500);
  require(offline.state == OwnershipState::OfflineIdle &&
              offline.event == OwnershipEvent::EnteredOffline &&
              offline.allowOfflineControl,
          "Boot timeout must enter stable offline idle ownership.");
}

void verifyIdleReconnectAndFlapping() {
  OfflineOwnershipManager manager;
  static_cast<void>(manager.tick(10000));

  auto detected = manager.observeHeartbeat(11000, heartbeat("server-b", 1));
  require(detected.state == OwnershipState::ReconnectPending &&
              detected.event == OwnershipEvent::ReconnectDetected &&
              !detected.allowOnlineTraffic,
          "The first reconnect heartbeat must remain pending.");

  static_cast<void>(manager.observeHeartbeat(12000, failure()));
  require(manager.state() == OwnershipState::ReconnectPending,
          "One reconnect failure must not flap back offline.");
  static_cast<void>(manager.observeHeartbeat(13000, heartbeat("server-b", 1)));
  const auto online = manager.observeHeartbeat(14000, heartbeat("server-b", 1));
  require(online.state == OwnershipState::OnlineOwned &&
              online.event == OwnershipEvent::EnteredOnline,
          "Two consecutive reconnect heartbeats must restore idle online ownership.");
}

void verifyOnlinePauseAndIdentityGuard() {
  OfflineOwnershipManager manager;
  std::uint32_t now = 0;
  static_cast<void>(manager.observeHeartbeat(now, heartbeat()));

  OwnershipSafety active;
  active.onlineGameActive = true;
  active.motionExecuting = true;
  failThree(manager, now, active);
  auto paused = manager.tick(now, active);
  require(paused.state == OwnershipState::OnlinePaused &&
              !paused.allowNewMotion && paused.finishInFlightMotion,
          "An active online game must pause while allowing its in-flight command to finish.");

  active.motionExecuting = false;
  auto first = manager.observeHeartbeat(now += 1000, heartbeat(), active);
  require(first.state == OwnershipState::OnlinePaused,
          "One successful heartbeat must not resume a paused game.");
  auto resumed = manager.observeHeartbeat(now += 1000, heartbeat(), active);
  require(resumed.state == OwnershipState::OnlineOwned &&
              resumed.event == OwnershipEvent::OnlineResumed,
          "The same stable server session must resume after two heartbeats.");

  failThree(manager, now, active);
  active.motionExecuting = false;
  const auto changed = manager.observeHeartbeat(now += 1000, heartbeat("server-new", 1), active);
  require(changed.state == OwnershipState::RecoveryRequired &&
              changed.event == OwnershipEvent::RecoveryRequired &&
              !changed.allowOnlineTraffic && !changed.allowNewMotion,
          "A changed server identity must require explicit recovery.");

  manager.reset();
  static_cast<void>(manager.observeHeartbeat(0, heartbeat()));
  now = 0;
  failThree(manager, now, active);
  const auto generationChanged =
      manager.observeHeartbeat(now += 1000, heartbeat("server-a", 8), active);
  require(generationChanged.state == OwnershipState::RecoveryRequired,
          "A changed session generation must not resume automatically.");
}

void verifyOfflineTurnBoundaryHandoff() {
  OfflineOwnershipManager manager;
  static_cast<void>(manager.tick(10000));

  OwnershipSafety offlineGame;
  offlineGame.offlineGameActive = true;
  offlineGame.offlineAtTurnBoundary = false;
  auto detected = manager.observeHeartbeat(11000, heartbeat(), offlineGame);
  require(detected.state == OwnershipState::ReconnectPending &&
              detected.allowOfflineControl,
          "An offline game must continue while reconnect confirmation is pending.");
  auto stable = manager.observeHeartbeat(12000, heartbeat(), offlineGame);
  require(stable.state == OwnershipState::ReconnectPending &&
              stable.allowOfflineControl && !stable.handoffRequired,
          "A reconnect must wait for the offline turn boundary.");

  offlineGame.motionExecuting = true;
  offlineGame.offlineAtTurnBoundary = true;
  require(!manager.tick(12500, offlineGame).handoffRequired,
          "An executing motion cannot become a handoff boundary.");
  offlineGame.motionExecuting = false;
  const auto handoff = manager.tick(13000, offlineGame);
  require(handoff.event == OwnershipEvent::HandoffRequired &&
              handoff.handoffRequired && !handoff.allowOfflineControl &&
              !handoff.allowNewMotion,
          "A stable completed offline turn must stop for authoritative handoff.");
  require(manager.tick(13500, offlineGame).event == OwnershipEvent::None,
          "The handoff event must be idempotent.");
}

void verifyIdleLossAndReconnectFailure() {
  OfflineOwnershipManager manager;
  std::uint32_t now = 0;
  static_cast<void>(manager.observeHeartbeat(now, heartbeat()));
  failThree(manager, now);
  require(manager.state() == OwnershipState::OfflineIdle,
          "An idle online owner must fall back offline after three failures.");

  static_cast<void>(manager.observeHeartbeat(now += 1000, heartbeat("candidate", 2)));
  require(manager.state() == OwnershipState::ReconnectPending,
          "A reconnect candidate must enter the pending state.");
  failThree(manager, now);
  require(manager.state() == OwnershipState::OfflineIdle,
          "A disappearing reconnect candidate must return to offline idle.");
}

void verifyIdleServerRestartWithoutObservedOutage() {
  OfflineOwnershipManager manager;
  static_cast<void>(manager.observeHeartbeat(0, heartbeat("server-old", 4)));

  const auto detected =
      manager.observeHeartbeat(1000, heartbeat("server-new", 0));
  require(detected.state == OwnershipState::ReconnectPending &&
              detected.event == OwnershipEvent::ReconnectDetected &&
              detected.serverInstanceId == "server-new" &&
              !detected.allowOnlineTraffic && !detected.allowNewMotion,
          "An idle hot restart must wait for a second heartbeat from the new server.");

  const auto adopted =
      manager.observeHeartbeat(2000, heartbeat("server-new", 0));
  require(adopted.state == OwnershipState::OnlineOwned &&
              adopted.event == OwnershipEvent::EnteredOnline &&
              adopted.serverInstanceId == "server-new" &&
              adopted.allowOnlineTraffic,
          "A stable idle board must adopt a restarted server after two heartbeats.");

  manager.reset();
  static_cast<void>(manager.observeHeartbeat(0, heartbeat("server-old", 4)));
  OwnershipSafety active;
  active.onlineGameActive = true;
  const auto rejected =
      manager.observeHeartbeat(1000, heartbeat("server-new", 0), active);
  require(rejected.state == OwnershipState::RecoveryRequired,
          "An active online game must never adopt a changed server automatically.");
}

void verifyRemoteTransitionSafetyGuard() {
  OfflineOwnershipManager manager;
  static_cast<void>(manager.tick(10000));

  ServerHeartbeat unsafe = heartbeat("busy-server", 9);
  unsafe.sessionActive = true;
  unsafe.safeToSwitch = false;
  static_cast<void>(manager.observeHeartbeat(11000, unsafe));
  const auto held = manager.observeHeartbeat(12000, unsafe);
  require(held.state == OwnershipState::ReconnectPending &&
              !held.allowOnlineTraffic && !held.allowNewMotion,
          "An unsafe remote physical session must block idle ownership transfer.");

  ServerHeartbeat safe = unsafe;
  safe.sessionActive = false;
  safe.safeToSwitch = true;
  const auto adopted = manager.observeHeartbeat(13000, safe);
  require(adopted.state == OwnershipState::OnlineOwned &&
              adopted.event == OwnershipEvent::EnteredOnline,
          "A stable reconnect candidate must transfer when the server becomes safe.");
}

void verifyTimerWraparoundAndInvalidHeartbeat() {
  const std::uint32_t start = std::numeric_limits<std::uint32_t>::max() - 500;
  OfflineOwnershipManager manager;
  manager.reset(start);
  static_cast<void>(manager.observeHeartbeat(start, failure()));
  require(!manager.heartbeatDue(start + 999),
          "Heartbeat became due too early before millis wraparound.");
  require(manager.heartbeatDue(start + 1000),
          "Heartbeat interval must remain correct across millis wraparound.");

  manager.reset(start);
  require(manager.tick(start + 9999).state == OwnershipState::BootProbe,
          "Boot timer wrapped early.");
  require(manager.tick(start + 10000).state == OwnershipState::OfflineIdle,
          "Boot timeout must work across millis wraparound.");

  manager.reset();
  ServerHeartbeat incompatible = heartbeat();
  incompatible.protocolVersion = 99;
  static_cast<void>(manager.observeHeartbeat(0, incompatible));
  require(manager.state() == OwnershipState::BootProbe,
          "An incompatible heartbeat must not establish ownership.");
}

}  // namespace

int main() {
  try {
    verifyDefaultsAndBoot();
    verifyIdleReconnectAndFlapping();
    verifyOnlinePauseAndIdentityGuard();
    verifyOfflineTurnBoundaryHandoff();
    verifyIdleLossAndReconnectFailure();
    verifyIdleServerRestartWithoutObservedOutage();
    verifyRemoteTransitionSafetyGuard();
    verifyTimerWraparoundAndInvalidHeartbeat();
    std::cout << "Offline ownership regressions passed.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Offline ownership regression failed: " << error.what() << '\n';
    return 1;
  }
}
