#include "offline_human_promotion.h"

#include <algorithm>
#include <cctype>
#include <utility>

namespace offline {
namespace {

std::uint32_t elapsedSince(std::uint32_t nowMs, std::uint32_t thenMs) {
  return nowMs - thenMs;
}

}  // namespace

OfflineHumanPromotionSelector::OfflineHumanPromotionSelector(
    HumanPromotionSelectorConfig config)
    : config_(config) {}

bool OfflineHumanPromotionSelector::begin(
    const HumanPromotionRequest& request, std::uint32_t nowMs) {
  reset();
  const int targetIndex = squareToRawIndex(request.target);
  if (config_.choicePeriodMs == 0 || config_.placementStableMs == 0 ||
      squareToRawIndex(request.source) < 0 || targetIndex < 0 ||
      !request.completedPawnOccupancy[static_cast<std::size_t>(targetIndex)]) {
    state_ = HumanPromotionSelectionState::Error;
    return false;
  }

  HumanPromotionRequest normalized = request;
  normalized.legalChoices.clear();
  constexpr char kChoiceOrder[] = {'q', 'r', 'b', 'n'};
  for (const char choice : kChoiceOrder) {
    const auto found = std::find_if(
        request.legalChoices.begin(), request.legalChoices.end(),
        [choice](char candidate) {
          return static_cast<char>(std::tolower(
                     static_cast<unsigned char>(candidate))) == choice;
        });
    if (found != request.legalChoices.end()) {
      normalized.legalChoices.push_back(choice);
    }
  }
  if (normalized.legalChoices.empty()) {
    state_ = HumanPromotionSelectionState::Error;
    return false;
  }

  request_ = std::move(normalized);
  replacementEmptyOccupancy_ = request_->completedPawnOccupancy;
  replacementEmptyOccupancy_[static_cast<std::size_t>(targetIndex)] = false;
  state_ = HumanPromotionSelectionState::AwaitingRemoval;
  choiceStartedMs_ = nowMs;
  lastOccupancy_ = request_->completedPawnOccupancy;
  hasLastOccupancy_ = true;
  return true;
}

void OfflineHumanPromotionSelector::reset() {
  request_.reset();
  state_ = HumanPromotionSelectionState::Idle;
  resumeState_ = HumanPromotionSelectionState::Cycling;
  replacementEmptyOccupancy_.fill(false);
  lastOccupancy_.fill(false);
  hasLastOccupancy_ = false;
  choiceIndex_ = 0;
  choiceStartedMs_ = 0;
  placementStartedMs_ = 0;
  confirmedChoice_.reset();
  warningDifference_ = {};
}

char OfflineHumanPromotionSelector::displayedChoice() const {
  if (!request_ || request_->legalChoices.empty()) return 0;
  return request_->legalChoices[choiceIndex_ % request_->legalChoices.size()];
}

void OfflineHumanPromotionSelector::refreshChoice(std::uint32_t nowMs) {
  if (!request_ || request_->legalChoices.empty() ||
      state_ != HumanPromotionSelectionState::Cycling) {
    return;
  }
  const std::uint32_t periods =
      elapsedSince(nowMs, choiceStartedMs_) / config_.choicePeriodMs;
  if (periods == 0) return;
  choiceIndex_ = (choiceIndex_ + periods) % request_->legalChoices.size();
  choiceStartedMs_ += periods * config_.choicePeriodMs;
}

void OfflineHumanPromotionSelector::enterSyncWarning(
    const Occupancy& occupancy, HumanPromotionSelectionState resumeState) {
  resumeState_ = resumeState;
  state_ = HumanPromotionSelectionState::SyncWarning;
  warningDifference_ = compareOccupancy(replacementEmptyOccupancy_, occupancy);
}

HumanPromotionSelectionUpdate OfflineHumanPromotionSelector::processSnapshot(
    std::uint32_t nowMs, const Occupancy& occupancy) {
  if (!request_) {
    state_ = HumanPromotionSelectionState::Error;
    return updateFor(
        HumanPromotionSelectionEvent::Error,
        "No human promotion request is armed.");
  }

  if (occupancy == request_->committedOccupancy) {
    state_ = HumanPromotionSelectionState::Cancelled;
    confirmedChoice_.reset();
    lastOccupancy_ = occupancy;
    hasLastOccupancy_ = true;
    return updateFor(
        HumanPromotionSelectionEvent::Cancelled,
        "The complete pre-promotion position was restored.");
  }

  if (state_ == HumanPromotionSelectionState::Complete ||
      state_ == HumanPromotionSelectionState::Cancelled ||
      state_ == HumanPromotionSelectionState::Error) {
    return updateFor(HumanPromotionSelectionEvent::None);
  }

  if (state_ == HumanPromotionSelectionState::SyncWarning) {
    if (occupancy == replacementEmptyOccupancy_) {
      state_ = HumanPromotionSelectionState::Cycling;
      choiceStartedMs_ = nowMs;
      warningDifference_ = {};
      lastOccupancy_ = occupancy;
      hasLastOccupancy_ = true;
      return updateFor(
          HumanPromotionSelectionEvent::Recovered,
          "Promotion selection recovered at the same displayed choice.");
    }
    if (resumeState_ == HumanPromotionSelectionState::ConfirmingPlacement &&
        occupancy == request_->completedPawnOccupancy) {
      state_ = HumanPromotionSelectionState::ConfirmingPlacement;
      placementStartedMs_ = nowMs;
      warningDifference_ = {};
      lastOccupancy_ = occupancy;
      hasLastOccupancy_ = true;
      return updateFor(
          HumanPromotionSelectionEvent::Recovered,
          "Promotion placement recovered and stability timing restarted.");
    }
    warningDifference_ = compareOccupancy(replacementEmptyOccupancy_, occupancy);
    return updateFor(
        HumanPromotionSelectionEvent::RestoreRequired,
        "Restore every unrelated square before promotion selection resumes.");
  }

  if (state_ == HumanPromotionSelectionState::AwaitingRemoval) {
    if (occupancy == request_->completedPawnOccupancy) {
      return updateFor(
          HumanPromotionSelectionEvent::None,
          "Remove the pawn from the promotion square.");
    }
    if (occupancy == replacementEmptyOccupancy_) {
      state_ = HumanPromotionSelectionState::Cycling;
      choiceIndex_ = 0;
      choiceStartedMs_ = nowMs;
      lastOccupancy_ = occupancy;
      hasLastOccupancy_ = true;
      return updateFor(
          HumanPromotionSelectionEvent::PawnRemovalObserved,
          "Pawn removal observed; promotion choices are cycling.");
    }
    enterSyncWarning(occupancy, HumanPromotionSelectionState::AwaitingRemoval);
    return updateFor(
        HumanPromotionSelectionEvent::RestoreRequired,
        "Only the promotion square may change during replacement.");
  }

  if (state_ == HumanPromotionSelectionState::Cycling) {
    const char before = displayedChoice();
    refreshChoice(nowMs);
    const bool choiceChanged = before != displayedChoice();
    if (occupancy == replacementEmptyOccupancy_) {
      lastOccupancy_ = occupancy;
      hasLastOccupancy_ = true;
      return updateFor(
          choiceChanged ? HumanPromotionSelectionEvent::ChoiceChanged
                        : HumanPromotionSelectionEvent::None,
          choiceChanged ? "Promotion choice advanced."
                        : "Promotion choice is active.");
    }
    if (occupancy == request_->completedPawnOccupancy) {
      state_ = HumanPromotionSelectionState::ConfirmingPlacement;
      placementStartedMs_ = nowMs;
      lastOccupancy_ = occupancy;
      hasLastOccupancy_ = true;
      return updateFor(
          HumanPromotionSelectionEvent::ChoiceLatched,
          "The displayed promotion choice was latched.");
    }
    enterSyncWarning(occupancy, HumanPromotionSelectionState::Cycling);
    return updateFor(
        HumanPromotionSelectionEvent::RestoreRequired,
        "An unrelated square changed during promotion selection.");
  }

  if (state_ == HumanPromotionSelectionState::ConfirmingPlacement) {
    if (occupancy == replacementEmptyOccupancy_) {
      state_ = HumanPromotionSelectionState::Cycling;
      choiceStartedMs_ = nowMs;
      lastOccupancy_ = occupancy;
      hasLastOccupancy_ = true;
      return updateFor(
          HumanPromotionSelectionEvent::PlacementRemoved,
          "Placement was removed; the same choice resumed.");
    }
    if (occupancy == request_->completedPawnOccupancy) {
      lastOccupancy_ = occupancy;
      hasLastOccupancy_ = true;
      if (elapsedSince(nowMs, placementStartedMs_) >= config_.placementStableMs) {
        state_ = HumanPromotionSelectionState::Complete;
        confirmedChoice_ = displayedChoice();
        return updateFor(
            HumanPromotionSelectionEvent::ConfirmationReady,
            "Promotion placement is stable and ready to commit.");
      }
      return updateFor(
          HumanPromotionSelectionEvent::None,
          "Hold the selected promotion piece stable.");
    }
    enterSyncWarning(occupancy, HumanPromotionSelectionState::ConfirmingPlacement);
    return updateFor(
        HumanPromotionSelectionEvent::RestoreRequired,
        "An unrelated square changed while confirming promotion placement.");
  }

  return updateFor(HumanPromotionSelectionEvent::None);
}

HumanPromotionSelectionUpdate OfflineHumanPromotionSelector::tick(
    std::uint32_t nowMs) {
  if (state_ == HumanPromotionSelectionState::Cycling) {
    const char before = displayedChoice();
    refreshChoice(nowMs);
    return updateFor(
        before == displayedChoice() ? HumanPromotionSelectionEvent::None
                                    : HumanPromotionSelectionEvent::ChoiceChanged,
        before == displayedChoice() ? "Promotion choice is active."
                                    : "Promotion choice advanced.");
  }
  if (state_ == HumanPromotionSelectionState::ConfirmingPlacement &&
      hasLastOccupancy_ && request_ &&
      lastOccupancy_ == request_->completedPawnOccupancy &&
      elapsedSince(nowMs, placementStartedMs_) >= config_.placementStableMs) {
    state_ = HumanPromotionSelectionState::Complete;
    confirmedChoice_ = displayedChoice();
    return updateFor(
        HumanPromotionSelectionEvent::ConfirmationReady,
        "Promotion placement is stable and ready to commit.");
  }
  return updateFor(HumanPromotionSelectionEvent::None);
}

HumanPromotionSelectionUpdate OfflineHumanPromotionSelector::currentState() const {
  return updateFor(HumanPromotionSelectionEvent::None);
}

HumanPromotionSelectionUpdate OfflineHumanPromotionSelector::updateFor(
    HumanPromotionSelectionEvent event, std::string message) const {
  HumanPromotionSelectionUpdate update;
  update.state = state_;
  update.event = event;
  update.displayedChoice = displayedChoice();
  update.confirmedChoice = confirmedChoice_;
  update.difference = warningDifference_;
  update.message = std::move(message);
  return update;
}

const char* humanPromotionSelectionStateName(HumanPromotionSelectionState state) {
  switch (state) {
    case HumanPromotionSelectionState::Idle: return "idle";
    case HumanPromotionSelectionState::AwaitingRemoval: return "awaiting_removal";
    case HumanPromotionSelectionState::Cycling: return "cycling";
    case HumanPromotionSelectionState::ConfirmingPlacement: return "confirming_placement";
    case HumanPromotionSelectionState::Complete: return "complete";
    case HumanPromotionSelectionState::Cancelled: return "cancelled";
    case HumanPromotionSelectionState::SyncWarning: return "sync_warning";
    case HumanPromotionSelectionState::Error: return "error";
  }
  return "unknown";
}

const char* humanPromotionSelectionEventName(HumanPromotionSelectionEvent event) {
  switch (event) {
    case HumanPromotionSelectionEvent::None: return "none";
    case HumanPromotionSelectionEvent::PawnRemovalObserved: return "pawn_removal_observed";
    case HumanPromotionSelectionEvent::ChoiceChanged: return "choice_changed";
    case HumanPromotionSelectionEvent::ChoiceLatched: return "choice_latched";
    case HumanPromotionSelectionEvent::PlacementRemoved: return "placement_removed";
    case HumanPromotionSelectionEvent::ConfirmationReady: return "confirmation_ready";
    case HumanPromotionSelectionEvent::Cancelled: return "cancelled";
    case HumanPromotionSelectionEvent::RestoreRequired: return "restore_required";
    case HumanPromotionSelectionEvent::Recovered: return "recovered";
    case HumanPromotionSelectionEvent::Error: return "error";
  }
  return "unknown";
}

}  // namespace offline
