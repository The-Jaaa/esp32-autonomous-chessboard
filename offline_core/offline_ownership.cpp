#include "offline_ownership.h"

#include <algorithm>
#include <utility>

namespace offline {
namespace {

std::uint8_t incrementSaturated(std::uint8_t value) {
  return value == UINT8_MAX ? value : static_cast<std::uint8_t>(value + 1);
}

std::uint32_t elapsedSince(std::uint32_t nowMs, std::uint32_t thenMs) {
  return nowMs - thenMs;
}

}  // namespace

OfflineOwnershipManager::OfflineOwnershipManager(OwnershipConfig config)
    : config_(std::move(config)) {
  config_.failureThreshold = std::max<std::uint8_t>(1, config_.failureThreshold);
  config_.reconnectSuccessThreshold =
      std::max<std::uint8_t>(1, config_.reconnectSuccessThreshold);
  reset();
}

void OfflineOwnershipManager::reset(std::uint32_t nowMs) {
  state_ = OwnershipState::BootProbe;
  bootStartedAtMs_ = nowMs;
  lastHeartbeatAtMs_ = nowMs;
  heartbeatObserved_ = false;
  consecutiveFailures_ = 0;
  consecutiveSuccesses_ = 0;
  activeServerInstanceId_.clear();
  activeSessionGeneration_ = 0;
  candidateServerInstanceId_.clear();
  candidateSessionGeneration_ = 0;
  candidateSafeToSwitch_ = false;
  handoffRequired_ = false;
}

bool OfflineOwnershipManager::heartbeatDue(std::uint32_t nowMs) const {
  return !heartbeatObserved_ ||
         elapsedSince(nowMs, lastHeartbeatAtMs_) >= config_.heartbeatIntervalMs;
}

OwnershipDecision OfflineOwnershipManager::tick(
    std::uint32_t nowMs, const OwnershipSafety& safety) {
  if (state_ == OwnershipState::BootProbe &&
      elapsedSince(nowMs, bootStartedAtMs_) >= config_.bootProbeWindowMs) {
    state_ = OwnershipState::OfflineIdle;
    consecutiveFailures_ = 0;
    consecutiveSuccesses_ = 0;
    return decision(
        OwnershipEvent::EnteredOffline,
        safety,
        "The boot probe expired without a compatible server.");
  }

  if (state_ == OwnershipState::ReconnectPending &&
      consecutiveSuccesses_ >= config_.reconnectSuccessThreshold) {
    return evaluateReconnect(safety);
  }

  return decision(OwnershipEvent::None, safety);
}

OwnershipDecision OfflineOwnershipManager::observeHeartbeat(
    std::uint32_t nowMs,
    const ServerHeartbeat& heartbeat,
    const OwnershipSafety& safety) {
  heartbeatObserved_ = true;
  lastHeartbeatAtMs_ = nowMs;
  return validHeartbeat(heartbeat) ? handleSuccess(heartbeat, safety)
                                   : handleFailure(safety);
}

bool OfflineOwnershipManager::validHeartbeat(const ServerHeartbeat& heartbeat) const {
  return heartbeat.success &&
         heartbeat.protocolVersion == kOfflineOwnershipProtocolVersion &&
         !heartbeat.serverInstanceId.empty();
}

bool OfflineOwnershipManager::sameActiveServer(
    const ServerHeartbeat& heartbeat) const {
  return !activeServerInstanceId_.empty() &&
         heartbeat.serverInstanceId == activeServerInstanceId_ &&
         heartbeat.sessionGeneration == activeSessionGeneration_;
}

bool OfflineOwnershipManager::safeBoundary(const OwnershipSafety& safety) const {
  return safety.boardStable && !safety.motionExecuting && !safety.magnetActive;
}

void OfflineOwnershipManager::rememberCandidate(const ServerHeartbeat& heartbeat) {
  if (candidateServerInstanceId_ == heartbeat.serverInstanceId &&
      candidateSessionGeneration_ == heartbeat.sessionGeneration) {
    candidateSafeToSwitch_ = heartbeat.safeToSwitch;
    consecutiveSuccesses_ = incrementSaturated(consecutiveSuccesses_);
    return;
  }

  candidateServerInstanceId_ = heartbeat.serverInstanceId;
  candidateSessionGeneration_ = heartbeat.sessionGeneration;
  candidateSafeToSwitch_ = heartbeat.safeToSwitch;
  consecutiveSuccesses_ = 1;
}

void OfflineOwnershipManager::adoptCandidate() {
  activeServerInstanceId_ = candidateServerInstanceId_;
  activeSessionGeneration_ = candidateSessionGeneration_;
  candidateServerInstanceId_.clear();
  candidateSessionGeneration_ = 0;
  candidateSafeToSwitch_ = false;
  consecutiveSuccesses_ = 0;
  consecutiveFailures_ = 0;
  handoffRequired_ = false;
}

OwnershipDecision OfflineOwnershipManager::handleSuccess(
    const ServerHeartbeat& heartbeat, const OwnershipSafety& safety) {
  consecutiveFailures_ = 0;

  if (state_ == OwnershipState::BootProbe) {
    candidateServerInstanceId_ = heartbeat.serverInstanceId;
    candidateSessionGeneration_ = heartbeat.sessionGeneration;
    adoptCandidate();
    state_ = OwnershipState::OnlineOwned;
    return decision(
        OwnershipEvent::EnteredOnline, safety, "A compatible server answered the boot probe.");
  }

  if (state_ == OwnershipState::OnlineOwned) {
    if (!sameActiveServer(heartbeat)) {
      if (!safety.onlineGameActive && !safety.offlineGameActive &&
          safeBoundary(safety)) {
        rememberCandidate(heartbeat);
        state_ = OwnershipState::ReconnectPending;
        return decision(
            OwnershipEvent::ReconnectDetected,
            safety,
            "The idle server identity changed; another successful heartbeat is required.");
      }
      state_ = OwnershipState::RecoveryRequired;
      return decision(
          OwnershipEvent::RecoveryRequired,
          safety,
          "The active server identity or physical session generation changed.");
    }
    consecutiveSuccesses_ = 0;
    return decision(OwnershipEvent::None, safety);
  }

  if (state_ == OwnershipState::OnlinePaused) {
    if (!sameActiveServer(heartbeat)) {
      state_ = OwnershipState::RecoveryRequired;
      return decision(
          OwnershipEvent::RecoveryRequired,
          safety,
          "A paused online game cannot resume against a different server session.");
    }

    consecutiveSuccesses_ = incrementSaturated(consecutiveSuccesses_);
    if (consecutiveSuccesses_ >= config_.reconnectSuccessThreshold && safeBoundary(safety)) {
      consecutiveSuccesses_ = 0;
      state_ = OwnershipState::OnlineOwned;
      return decision(
          OwnershipEvent::OnlineResumed, safety, "The original online session is stable again.");
    }
    return decision(OwnershipEvent::None, safety);
  }

  if (state_ == OwnershipState::OfflineIdle ||
      state_ == OwnershipState::ReconnectPending) {
    rememberCandidate(heartbeat);
    if (state_ == OwnershipState::OfflineIdle) {
      state_ = OwnershipState::ReconnectPending;
      if (consecutiveSuccesses_ < config_.reconnectSuccessThreshold) {
        return decision(
            OwnershipEvent::ReconnectDetected,
            safety,
            "A server was detected; another successful heartbeat is required.");
      }
    }
    return evaluateReconnect(safety);
  }

  return decision(OwnershipEvent::None, safety);
}

OwnershipDecision OfflineOwnershipManager::handleFailure(const OwnershipSafety& safety) {
  consecutiveSuccesses_ = 0;
  consecutiveFailures_ = incrementSaturated(consecutiveFailures_);

  if (state_ == OwnershipState::BootProbe ||
      state_ == OwnershipState::OfflineIdle ||
      state_ == OwnershipState::RecoveryRequired) {
    return decision(OwnershipEvent::None, safety);
  }

  if (state_ == OwnershipState::ReconnectPending) {
    if (consecutiveFailures_ >= config_.failureThreshold) {
      state_ = OwnershipState::OfflineIdle;
      candidateServerInstanceId_.clear();
      candidateSessionGeneration_ = 0;
      candidateSafeToSwitch_ = false;
      handoffRequired_ = false;
      return decision(
          OwnershipEvent::EnteredOffline,
          safety,
          "The reconnect candidate disappeared before ownership transferred.");
    }
    return decision(OwnershipEvent::None, safety);
  }

  if (state_ == OwnershipState::OnlinePaused) {
    return decision(OwnershipEvent::None, safety);
  }

  if (state_ == OwnershipState::OnlineOwned &&
      consecutiveFailures_ >= config_.failureThreshold) {
    consecutiveSuccesses_ = 0;
    if (safety.onlineGameActive || safety.motionExecuting || safety.magnetActive ||
        !safety.boardStable) {
      state_ = OwnershipState::OnlinePaused;
      return decision(
          OwnershipEvent::OnlinePaused,
          safety,
          "The online game is paused until the original server session returns.");
    }

    state_ = OwnershipState::OfflineIdle;
    return decision(
        OwnershipEvent::EnteredOffline,
        safety,
        "The server is unavailable and no online game needs recovery.");
  }

  return decision(OwnershipEvent::None, safety);
}

OwnershipDecision OfflineOwnershipManager::evaluateReconnect(
    const OwnershipSafety& safety) {
  if (consecutiveSuccesses_ < config_.reconnectSuccessThreshold) {
    return decision(OwnershipEvent::None, safety);
  }

  if (safety.offlineGameActive) {
    if (safety.offlineAtTurnBoundary && safeBoundary(safety)) {
      const bool firstSignal = !handoffRequired_;
      handoffRequired_ = true;
      return decision(
          firstSignal ? OwnershipEvent::HandoffRequired : OwnershipEvent::None,
          safety,
          "The offline turn is complete; an authoritative state handoff is required.");
    }
    return decision(
        OwnershipEvent::None,
        safety,
        "The server is waiting for the current offline turn to finish.");
  }

  if (!safeBoundary(safety)) {
    return decision(
        OwnershipEvent::None,
        safety,
        "The server is stable, but the board has not reached a safe idle boundary.");
  }

  if (!candidateSafeToSwitch_) {
    return decision(
        OwnershipEvent::None,
        safety,
        "The server is stable, but its physical session is not safe for ownership transfer.");
  }

  adoptCandidate();
  state_ = OwnershipState::OnlineOwned;
  return decision(
      OwnershipEvent::EnteredOnline, safety, "Stable idle ownership returned online.");
}

OwnershipDecision OfflineOwnershipManager::decision(
    OwnershipEvent event,
    const OwnershipSafety& safety,
    std::string message) const {
  OwnershipDecision result;
  result.state = state_;
  result.event = event;
  result.allowOnlineTraffic = state_ == OwnershipState::OnlineOwned;
  result.allowOfflineControl =
      (state_ == OwnershipState::OfflineIdle && safeBoundary(safety)) ||
      (state_ == OwnershipState::ReconnectPending && safety.offlineGameActive &&
       !handoffRequired_);
  result.allowNewMotion = result.allowOnlineTraffic || result.allowOfflineControl;
  result.finishInFlightMotion =
      state_ == OwnershipState::OnlinePaused && safety.motionExecuting;
  result.handoffRequired = handoffRequired_;
  result.consecutiveFailures = consecutiveFailures_;
  result.consecutiveSuccesses = consecutiveSuccesses_;
  const bool reportCandidate = state_ == OwnershipState::ReconnectPending &&
                               !candidateServerInstanceId_.empty();
  result.serverInstanceId = reportCandidate || activeServerInstanceId_.empty()
                                ? candidateServerInstanceId_
                                : activeServerInstanceId_;
  result.sessionGeneration = reportCandidate || activeServerInstanceId_.empty()
                                 ? candidateSessionGeneration_
                                 : activeSessionGeneration_;
  result.message = std::move(message);
  return result;
}

const char* ownershipStateName(OwnershipState state) {
  switch (state) {
    case OwnershipState::BootProbe: return "boot_probe";
    case OwnershipState::OnlineOwned: return "online_owned";
    case OwnershipState::OnlinePaused: return "online_paused";
    case OwnershipState::OfflineIdle: return "offline_idle";
    case OwnershipState::ReconnectPending: return "reconnect_pending";
    case OwnershipState::RecoveryRequired: return "recovery_required";
  }
  return "unknown";
}

const char* ownershipEventName(OwnershipEvent event) {
  switch (event) {
    case OwnershipEvent::None: return "none";
    case OwnershipEvent::EnteredOnline: return "entered_online";
    case OwnershipEvent::EnteredOffline: return "entered_offline";
    case OwnershipEvent::OnlinePaused: return "online_paused";
    case OwnershipEvent::OnlineResumed: return "online_resumed";
    case OwnershipEvent::ReconnectDetected: return "reconnect_detected";
    case OwnershipEvent::HandoffRequired: return "handoff_required";
    case OwnershipEvent::RecoveryRequired: return "recovery_required";
  }
  return "unknown";
}

}  // namespace offline
