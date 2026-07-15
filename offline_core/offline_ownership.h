#pragma once

#include <cstdint>
#include <string>

namespace offline {

constexpr std::uint32_t kOfflineOwnershipProtocolVersion = 1;

enum class OwnershipState {
  BootProbe,
  OnlineOwned,
  OnlinePaused,
  OfflineIdle,
  ReconnectPending,
  RecoveryRequired
};

enum class OwnershipEvent {
  None,
  EnteredOnline,
  EnteredOffline,
  OnlinePaused,
  OnlineResumed,
  ReconnectDetected,
  HandoffRequired,
  RecoveryRequired
};

struct OwnershipConfig {
  std::uint32_t bootProbeWindowMs = 10000;
  std::uint32_t heartbeatIntervalMs = 1000;
  std::uint32_t httpTimeoutMs = 1000;
  std::uint8_t failureThreshold = 3;
  std::uint8_t reconnectSuccessThreshold = 2;
};

struct ServerHeartbeat {
  bool success = false;
  std::uint32_t protocolVersion = 0;
  std::string serverInstanceId;
  std::uint32_t sessionGeneration = 0;
  bool sessionActive = false;
  bool safeToSwitch = false;
};

struct OwnershipSafety {
  bool motionExecuting = false;
  bool magnetActive = false;
  bool boardStable = true;
  bool onlineGameActive = false;
  bool offlineGameActive = false;
  bool offlineAtTurnBoundary = true;
};

struct OwnershipDecision {
  OwnershipState state = OwnershipState::BootProbe;
  OwnershipEvent event = OwnershipEvent::None;
  bool allowOnlineTraffic = false;
  bool allowOfflineControl = false;
  bool allowNewMotion = false;
  bool finishInFlightMotion = false;
  bool handoffRequired = false;
  std::uint8_t consecutiveFailures = 0;
  std::uint8_t consecutiveSuccesses = 0;
  std::string serverInstanceId;
  std::uint32_t sessionGeneration = 0;
  std::string message;
};

class OfflineOwnershipManager {
 public:
  explicit OfflineOwnershipManager(OwnershipConfig config = {});

  void reset(std::uint32_t nowMs = 0);
  [[nodiscard]] OwnershipDecision tick(
      std::uint32_t nowMs, const OwnershipSafety& safety = {});
  [[nodiscard]] OwnershipDecision observeHeartbeat(
      std::uint32_t nowMs,
      const ServerHeartbeat& heartbeat,
      const OwnershipSafety& safety = {});

  [[nodiscard]] bool heartbeatDue(std::uint32_t nowMs) const;
  [[nodiscard]] OwnershipState state() const { return state_; }
  [[nodiscard]] const OwnershipConfig& config() const { return config_; }

 private:
  [[nodiscard]] bool validHeartbeat(const ServerHeartbeat& heartbeat) const;
  [[nodiscard]] bool sameActiveServer(const ServerHeartbeat& heartbeat) const;
  [[nodiscard]] bool safeBoundary(const OwnershipSafety& safety) const;
  void rememberCandidate(const ServerHeartbeat& heartbeat);
  void adoptCandidate();
  OwnershipDecision handleSuccess(
      const ServerHeartbeat& heartbeat, const OwnershipSafety& safety);
  OwnershipDecision handleFailure(const OwnershipSafety& safety);
  OwnershipDecision evaluateReconnect(const OwnershipSafety& safety);
  [[nodiscard]] OwnershipDecision decision(
      OwnershipEvent event = OwnershipEvent::None,
      const OwnershipSafety& safety = {},
      std::string message = {}) const;

  OwnershipConfig config_;
  OwnershipState state_ = OwnershipState::BootProbe;
  std::uint32_t bootStartedAtMs_ = 0;
  std::uint32_t lastHeartbeatAtMs_ = 0;
  bool heartbeatObserved_ = false;
  std::uint8_t consecutiveFailures_ = 0;
  std::uint8_t consecutiveSuccesses_ = 0;
  std::string activeServerInstanceId_;
  std::uint32_t activeSessionGeneration_ = 0;
  std::string candidateServerInstanceId_;
  std::uint32_t candidateSessionGeneration_ = 0;
  bool candidateSafeToSwitch_ = false;
  bool handoffRequired_ = false;
};

const char* ownershipStateName(OwnershipState state);
const char* ownershipEventName(OwnershipEvent event);

}  // namespace offline
