#include "offline_side_selection.h"

#include <utility>

namespace offline {
namespace {

std::uint32_t elapsedSince(std::uint32_t nowMs, std::uint32_t thenMs) {
  return nowMs - thenMs;
}

}  // namespace

OfflineSideSelector::OfflineSideSelector(OfflineSideSelectorConfig config)
    : config_(std::move(config)) {}

bool OfflineSideSelector::begin(
    const Occupancy& expectedSetup, std::uint32_t nowMs) {
  reset();
  if (config_.holdMs == 0 || config_.restoreStableMs == 0 ||
      squareToRawIndex(config_.whiteKingSquare) < 0 ||
      squareToRawIndex(config_.blackKingSquare) < 0 ||
      config_.whiteKingSquare == config_.blackKingSquare) {
    state_ = OfflineSideSelectionState::Error;
    return false;
  }
  const auto whiteIndex = static_cast<std::size_t>(
      squareToRawIndex(config_.whiteKingSquare));
  const auto blackIndex = static_cast<std::size_t>(
      squareToRawIndex(config_.blackKingSquare));
  if (!expectedSetup[whiteIndex] || !expectedSetup[blackIndex]) {
    state_ = OfflineSideSelectionState::Error;
    return false;
  }
  expectedSetup_ = expectedSetup;
  holdStartedMs_ = nowMs;
  state_ = OfflineSideSelectionState::AwaitingChoice;
  return true;
}

void OfflineSideSelector::reset() {
  state_ = OfflineSideSelectionState::Idle;
  expectedSetup_.fill(false);
  candidate_.reset();
  selected_.reset();
  choiceLatched_ = false;
  restoreTracking_ = false;
  holdStartedMs_ = 0;
  restoreStartedMs_ = 0;
  warningDifference_ = {};
}

bool OfflineSideSelector::isChoiceOccupancy(
    const Occupancy& occupancy, HumanColor color) const {
  Occupancy expected = expectedSetup_;
  const std::string& square = color == HumanColor::White
                                  ? config_.whiteKingSquare
                                  : config_.blackKingSquare;
  expected[static_cast<std::size_t>(squareToRawIndex(square))] = false;
  return occupancy == expected;
}

void OfflineSideSelector::enterWarning(const Occupancy& occupancy) {
  state_ = OfflineSideSelectionState::SyncWarning;
  restoreTracking_ = false;
  warningDifference_ = compareOccupancy(expectedSetup_, occupancy);
}

OfflineSideSelectionUpdate OfflineSideSelector::processSnapshot(
    std::uint32_t nowMs, const Occupancy& occupancy) {
  if (state_ == OfflineSideSelectionState::Idle ||
      state_ == OfflineSideSelectionState::Error) {
    state_ = OfflineSideSelectionState::Error;
    return updateFor(
        OfflineSideSelectionEvent::Error,
        "Side selection is not armed.");
  }
  if (state_ == OfflineSideSelectionState::Complete) {
    return updateFor(OfflineSideSelectionEvent::None);
  }

  if (state_ == OfflineSideSelectionState::SyncWarning) {
    warningDifference_ = compareOccupancy(expectedSetup_, occupancy);
    if (occupancy != expectedSetup_) {
      return updateFor(
          OfflineSideSelectionEvent::RestoreRequired,
          "Restore the complete setup before side selection continues.");
    }
    warningDifference_ = {};
    if (choiceLatched_ && candidate_) {
      state_ = OfflineSideSelectionState::RestoringSetup;
      restoreTracking_ = true;
      restoreStartedMs_ = nowMs;
    } else {
      candidate_.reset();
      state_ = OfflineSideSelectionState::AwaitingChoice;
    }
    return updateFor(
        OfflineSideSelectionEvent::Recovered,
        "Side selection recovered after exact setup restoration.");
  }

  if (state_ == OfflineSideSelectionState::AwaitingChoice) {
    if (occupancy == expectedSetup_) {
      return updateFor(
          OfflineSideSelectionEvent::None,
          "Lift one king to choose the human color.");
    }
    if (isChoiceOccupancy(occupancy, HumanColor::White) ||
        isChoiceOccupancy(occupancy, HumanColor::Black)) {
      candidate_ = isChoiceOccupancy(occupancy, HumanColor::White)
                       ? HumanColor::White
                       : HumanColor::Black;
      holdStartedMs_ = nowMs;
      state_ = OfflineSideSelectionState::HoldingChoice;
      return updateFor(
          OfflineSideSelectionEvent::ChoiceStarted,
          "Hold the selected king lifted for one second.");
    }
    enterWarning(occupancy);
    return updateFor(
        OfflineSideSelectionEvent::RestoreRequired,
        "Only one starting king may be lifted during side selection.");
  }

  if (state_ == OfflineSideSelectionState::HoldingChoice) {
    if (occupancy == expectedSetup_) {
      candidate_.reset();
      state_ = OfflineSideSelectionState::AwaitingChoice;
      return updateFor(
          OfflineSideSelectionEvent::ChoiceCancelled,
          "The king was restored before the hold completed.");
    }
    if (!candidate_ || !isChoiceOccupancy(occupancy, *candidate_)) {
      enterWarning(occupancy);
      return updateFor(
          OfflineSideSelectionEvent::RestoreRequired,
          "The board changed while the side-selection hold was active.");
    }
    if (elapsedSince(nowMs, holdStartedMs_) < config_.holdMs) {
      return updateFor(
          OfflineSideSelectionEvent::None,
          "Keep the selected king lifted.");
    }
    choiceLatched_ = true;
    state_ = OfflineSideSelectionState::RestoringSetup;
    return updateFor(
        OfflineSideSelectionEvent::ChoiceLatched,
        "The side is selected; restore the king to confirm.");
  }

  if (state_ == OfflineSideSelectionState::RestoringSetup) {
    if (candidate_ && isChoiceOccupancy(occupancy, *candidate_)) {
      restoreTracking_ = false;
      return updateFor(
          OfflineSideSelectionEvent::None,
          "Restore the selected king to its starting square.");
    }
    if (occupancy != expectedSetup_) {
      enterWarning(occupancy);
      return updateFor(
          OfflineSideSelectionEvent::RestoreRequired,
          "Restore the complete setup to confirm the selected side.");
    }
    if (!restoreTracking_) {
      restoreTracking_ = true;
      restoreStartedMs_ = nowMs;
      return updateFor(
          OfflineSideSelectionEvent::RestoreStabilizing,
          "Hold the restored setup stable.");
    }
    if (elapsedSince(nowMs, restoreStartedMs_) < config_.restoreStableMs) {
      return updateFor(
          OfflineSideSelectionEvent::None,
          "Hold the restored setup stable.");
    }
    selected_ = candidate_;
    state_ = OfflineSideSelectionState::Complete;
    return updateFor(
        OfflineSideSelectionEvent::ChoiceConfirmed,
        "The human color is confirmed.");
  }

  return updateFor(OfflineSideSelectionEvent::None);
}

OfflineSideSelectionUpdate OfflineSideSelector::currentState() const {
  return updateFor(OfflineSideSelectionEvent::None);
}

OfflineSideSelectionUpdate OfflineSideSelector::updateFor(
    OfflineSideSelectionEvent event, std::string message) const {
  OfflineSideSelectionUpdate update;
  update.state = state_;
  update.event = event;
  update.candidate = candidate_;
  update.selected = selected_;
  update.difference = warningDifference_;
  update.message = std::move(message);
  return update;
}

const char* offlineSideSelectionStateName(OfflineSideSelectionState state) {
  switch (state) {
    case OfflineSideSelectionState::Idle: return "idle";
    case OfflineSideSelectionState::AwaitingChoice: return "awaiting_choice";
    case OfflineSideSelectionState::HoldingChoice: return "holding_choice";
    case OfflineSideSelectionState::RestoringSetup: return "restoring_setup";
    case OfflineSideSelectionState::Complete: return "complete";
    case OfflineSideSelectionState::SyncWarning: return "sync_warning";
    case OfflineSideSelectionState::Error: return "error";
  }
  return "unknown";
}

const char* offlineSideSelectionEventName(OfflineSideSelectionEvent event) {
  switch (event) {
    case OfflineSideSelectionEvent::None: return "none";
    case OfflineSideSelectionEvent::Armed: return "armed";
    case OfflineSideSelectionEvent::ChoiceStarted: return "choice_started";
    case OfflineSideSelectionEvent::ChoiceCancelled: return "choice_cancelled";
    case OfflineSideSelectionEvent::ChoiceLatched: return "choice_latched";
    case OfflineSideSelectionEvent::RestoreStabilizing: return "restore_stabilizing";
    case OfflineSideSelectionEvent::ChoiceConfirmed: return "choice_confirmed";
    case OfflineSideSelectionEvent::RestoreRequired: return "restore_required";
    case OfflineSideSelectionEvent::Recovered: return "recovered";
    case OfflineSideSelectionEvent::Error: return "error";
  }
  return "unknown";
}

}  // namespace offline
