#pragma once

#include "offline_physical.h"

#include <cstdint>
#include <string>

namespace offline {

enum class OfflineContinuousState {
  Idle,
  Playing,
  GameOver,
  HoldingReset,
  ClearGraveyards,
  SetupStabilizing,
  ReadyForSide,
  SyncWarning,
  Error
};

enum class OfflineContinuousEvent {
  None,
  GameStarted,
  GameEnded,
  ResetHoldStarted,
  ResetCancelled,
  ResetLatched,
  SetupMismatch,
  SetupStabilizing,
  SetupReady,
  Recovered,
  StaleGenerationRejected,
  Error
};

struct OfflineContinuousConfig {
  std::uint32_t resetHoldMs = 2000;
  std::uint32_t setupStableMs = 500;
};

struct OfflineContinuousUpdate {
  OfflineContinuousState state = OfflineContinuousState::Idle;
  OfflineContinuousEvent event = OfflineContinuousEvent::None;
  std::uint32_t generation = 0;
  OccupancyDiff difference;
  std::string message;
};

class OfflineContinuousSessionController {
 public:
  explicit OfflineContinuousSessionController(
      Occupancy standardSetup,
      OfflineContinuousConfig config = {});

  OfflineContinuousUpdate beginGame(std::uint32_t nowMs = 0);
  OfflineContinuousUpdate enterGameOver(
      std::uint32_t nowMs,
      const Occupancy& terminalOccupancy,
      std::string whiteKingSquare,
      std::string blackKingSquare);
  OfflineContinuousUpdate processSnapshot(
      std::uint32_t nowMs, const Occupancy& occupancy);
  OfflineContinuousUpdate validateGeneration(std::uint32_t generation) const;

  [[nodiscard]] OfflineContinuousState state() const { return state_; }
  [[nodiscard]] std::uint32_t generation() const { return generation_; }
  [[nodiscard]] const Occupancy& standardSetup() const { return standardSetup_; }

 private:
  OfflineContinuousUpdate updateFor(
      OfflineContinuousEvent event,
      std::string message = {},
      OccupancyDiff difference = {}) const;
  bool onlyKingGestureSquaresChanged(const Occupancy& occupancy) const;
  bool bothKingsLifted(const Occupancy& occupancy) const;
  void clearTerminalState();

  Occupancy standardSetup_{};
  OfflineContinuousConfig config_;
  OfflineContinuousState state_ = OfflineContinuousState::Idle;
  std::uint32_t generation_ = 0;
  Occupancy terminalOccupancy_{};
  std::string whiteKingSquare_;
  std::string blackKingSquare_;
  std::uint32_t stateSinceMs_ = 0;
};

const char* offlineContinuousStateName(OfflineContinuousState state);
const char* offlineContinuousEventName(OfflineContinuousEvent event);

}  // namespace offline
