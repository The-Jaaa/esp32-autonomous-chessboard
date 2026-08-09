#include "offline_continuous.h"

#include <algorithm>
#include <limits>
#include <utility>

namespace offline {

namespace {

std::uint32_t nextGeneration(std::uint32_t current) {
  return current == std::numeric_limits<std::uint32_t>::max() ? 1U : current + 1U;
}

}  // namespace

OfflineContinuousSessionController::OfflineContinuousSessionController(
    Occupancy standardSetup,
    OfflineContinuousConfig config)
    : standardSetup_(std::move(standardSetup)), config_(config) {
  config_.resetHoldMs = std::max<std::uint32_t>(1, config_.resetHoldMs);
  config_.setupStableMs = std::max<std::uint32_t>(1, config_.setupStableMs);
}

OfflineContinuousUpdate OfflineContinuousSessionController::beginGame(
    std::uint32_t nowMs) {
  if (state_ == OfflineContinuousState::Playing) {
    return updateFor(
        OfflineContinuousEvent::None,
        "The current offline game is already active.");
  }
  if (state_ != OfflineContinuousState::Idle &&
      state_ != OfflineContinuousState::ReadyForSide) {
    state_ = OfflineContinuousState::Error;
    return updateFor(
        OfflineContinuousEvent::Error,
        "A new game can begin only after setup and side selection.");
  }
  generation_ = nextGeneration(generation_);
  state_ = OfflineContinuousState::Playing;
  stateSinceMs_ = nowMs;
  clearTerminalState();
  return updateFor(OfflineContinuousEvent::GameStarted, "Offline game started.");
}

OfflineContinuousUpdate OfflineContinuousSessionController::enterGameOver(
    std::uint32_t nowMs,
    const Occupancy& terminalOccupancy,
    std::string whiteKingSquare,
    std::string blackKingSquare) {
  if (state_ == OfflineContinuousState::GameOver &&
      terminalOccupancy == terminalOccupancy_ &&
      whiteKingSquare == whiteKingSquare_ &&
      blackKingSquare == blackKingSquare_) {
    return updateFor(
        OfflineContinuousEvent::None,
        "The terminal position is already awaiting the reset gesture.");
  }
  const int whiteKing = squareToRawIndex(whiteKingSquare);
  const int blackKing = squareToRawIndex(blackKingSquare);
  if (state_ != OfflineContinuousState::Playing || whiteKing < 0 || blackKing < 0 ||
      whiteKing == blackKing ||
      !terminalOccupancy[static_cast<std::size_t>(whiteKing)] ||
      !terminalOccupancy[static_cast<std::size_t>(blackKing)]) {
    state_ = OfflineContinuousState::Error;
    return updateFor(
        OfflineContinuousEvent::Error,
        "Game-over reset requires two distinct occupied king squares.");
  }
  terminalOccupancy_ = terminalOccupancy;
  whiteKingSquare_ = std::move(whiteKingSquare);
  blackKingSquare_ = std::move(blackKingSquare);
  state_ = OfflineContinuousState::GameOver;
  stateSinceMs_ = nowMs;
  return updateFor(OfflineContinuousEvent::GameEnded, "Offline game ended.");
}

OfflineContinuousUpdate OfflineContinuousSessionController::processSnapshot(
    std::uint32_t nowMs,
    const Occupancy& occupancy) {
  if (state_ == OfflineContinuousState::Playing ||
      state_ == OfflineContinuousState::Idle ||
      state_ == OfflineContinuousState::ReadyForSide ||
      state_ == OfflineContinuousState::Error) {
    return updateFor(OfflineContinuousEvent::None);
  }

  if (state_ == OfflineContinuousState::GameOver) {
    if (occupancy == terminalOccupancy_) {
      return updateFor(OfflineContinuousEvent::None);
    }
    if (bothKingsLifted(occupancy)) {
      state_ = OfflineContinuousState::HoldingReset;
      stateSinceMs_ = nowMs;
      return updateFor(
          OfflineContinuousEvent::ResetHoldStarted,
          "Hold both kings lifted for two seconds to start another game.");
    }
    if (onlyKingGestureSquaresChanged(occupancy)) {
      return updateFor(OfflineContinuousEvent::None);
    }
    state_ = OfflineContinuousState::SyncWarning;
    return updateFor(
        OfflineContinuousEvent::SetupMismatch,
        "Restore the terminal board before requesting another game.",
        compareOccupancy(terminalOccupancy_, occupancy));
  }

  if (state_ == OfflineContinuousState::HoldingReset) {
    if (bothKingsLifted(occupancy)) {
      if (nowMs - stateSinceMs_ >= config_.resetHoldMs) {
        state_ = OfflineContinuousState::ClearGraveyards;
        stateSinceMs_ = nowMs;
        return updateFor(
            OfflineContinuousEvent::ResetLatched,
            "Clear Z/I graveyards and restore the standard setup.",
            compareOccupancy(standardSetup_, occupancy));
      }
      return updateFor(OfflineContinuousEvent::None);
    }
    if (onlyKingGestureSquaresChanged(occupancy)) {
      state_ = OfflineContinuousState::GameOver;
      return updateFor(
          OfflineContinuousEvent::ResetCancelled,
          "The new-game gesture was released before two seconds.");
    }
    state_ = OfflineContinuousState::SyncWarning;
    return updateFor(
        OfflineContinuousEvent::SetupMismatch,
        "Restore the terminal board before trying the reset gesture again.",
        compareOccupancy(terminalOccupancy_, occupancy));
  }

  if (state_ == OfflineContinuousState::SyncWarning) {
    if (occupancy == terminalOccupancy_) {
      state_ = OfflineContinuousState::GameOver;
      return updateFor(
          OfflineContinuousEvent::Recovered,
          "The terminal board was restored.");
    }
    return updateFor(
        OfflineContinuousEvent::None,
        "Restore the terminal board before trying the reset gesture again.",
        compareOccupancy(terminalOccupancy_, occupancy));
  }

  if (state_ == OfflineContinuousState::ClearGraveyards) {
    const OccupancyDiff difference = compareOccupancy(standardSetup_, occupancy);
    if (!difference.empty()) {
      return updateFor(
          OfflineContinuousEvent::SetupMismatch,
          "Clear Z/I graveyards and restore the standard board.",
          difference);
    }
    state_ = OfflineContinuousState::SetupStabilizing;
    stateSinceMs_ = nowMs;
    return updateFor(
        OfflineContinuousEvent::SetupStabilizing,
        "Standard setup is stabilizing.");
  }

  if (state_ == OfflineContinuousState::SetupStabilizing) {
    const OccupancyDiff difference = compareOccupancy(standardSetup_, occupancy);
    if (!difference.empty()) {
      state_ = OfflineContinuousState::ClearGraveyards;
      return updateFor(
          OfflineContinuousEvent::SetupMismatch,
          "The standard setup changed before confirmation.",
          difference);
    }
    if (nowMs - stateSinceMs_ >= config_.setupStableMs) {
      state_ = OfflineContinuousState::ReadyForSide;
      return updateFor(
          OfflineContinuousEvent::SetupReady,
          "Standard setup confirmed; choose a side.");
    }
  }
  return updateFor(OfflineContinuousEvent::None);
}

OfflineContinuousUpdate OfflineContinuousSessionController::validateGeneration(
    std::uint32_t generation) const {
  if (generation != generation_) {
    return updateFor(
        OfflineContinuousEvent::StaleGenerationRejected,
        "The report belongs to an earlier offline game.");
  }
  return updateFor(OfflineContinuousEvent::None);
}

OfflineContinuousUpdate OfflineContinuousSessionController::updateFor(
    OfflineContinuousEvent event,
    std::string message,
    OccupancyDiff difference) const {
  return {state_, event, generation_, std::move(difference), std::move(message)};
}

bool OfflineContinuousSessionController::onlyKingGestureSquaresChanged(
    const Occupancy& occupancy) const {
  const OccupancyDiff difference = compareOccupancy(terminalOccupancy_, occupancy);
  if (!difference.extra.empty()) return false;
  return std::all_of(
      difference.missing.begin(),
      difference.missing.end(),
      [this](const std::string& square) {
        return square == whiteKingSquare_ || square == blackKingSquare_;
      });
}

bool OfflineContinuousSessionController::bothKingsLifted(
    const Occupancy& occupancy) const {
  const int whiteKing = squareToRawIndex(whiteKingSquare_);
  const int blackKing = squareToRawIndex(blackKingSquare_);
  return onlyKingGestureSquaresChanged(occupancy) && whiteKing >= 0 && blackKing >= 0 &&
         !occupancy[static_cast<std::size_t>(whiteKing)] &&
         !occupancy[static_cast<std::size_t>(blackKing)];
}

void OfflineContinuousSessionController::clearTerminalState() {
  terminalOccupancy_.fill(false);
  whiteKingSquare_.clear();
  blackKingSquare_.clear();
}

const char* offlineContinuousStateName(OfflineContinuousState state) {
  switch (state) {
    case OfflineContinuousState::Idle: return "idle";
    case OfflineContinuousState::Playing: return "playing";
    case OfflineContinuousState::GameOver: return "game_over";
    case OfflineContinuousState::HoldingReset: return "holding_reset";
    case OfflineContinuousState::ClearGraveyards: return "clear_graveyards";
    case OfflineContinuousState::SetupStabilizing: return "setup_stabilizing";
    case OfflineContinuousState::ReadyForSide: return "ready_for_side";
    case OfflineContinuousState::SyncWarning: return "sync_warning";
    case OfflineContinuousState::Error: return "error";
  }
  return "unknown";
}

const char* offlineContinuousEventName(OfflineContinuousEvent event) {
  switch (event) {
    case OfflineContinuousEvent::None: return "none";
    case OfflineContinuousEvent::GameStarted: return "game_started";
    case OfflineContinuousEvent::GameEnded: return "game_ended";
    case OfflineContinuousEvent::ResetHoldStarted: return "reset_hold_started";
    case OfflineContinuousEvent::ResetCancelled: return "reset_cancelled";
    case OfflineContinuousEvent::ResetLatched: return "reset_latched";
    case OfflineContinuousEvent::SetupMismatch: return "setup_mismatch";
    case OfflineContinuousEvent::SetupStabilizing: return "setup_stabilizing";
    case OfflineContinuousEvent::SetupReady: return "setup_ready";
    case OfflineContinuousEvent::Recovered: return "recovered";
    case OfflineContinuousEvent::StaleGenerationRejected: return "stale_generation_rejected";
    case OfflineContinuousEvent::Error: return "error";
  }
  return "unknown";
}

}  // namespace offline
