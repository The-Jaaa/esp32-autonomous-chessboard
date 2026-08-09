#pragma once

#include "offline_physical.h"

#include <cstdint>
#include <optional>
#include <string>

namespace offline {

enum class HumanPromotionSelectionState {
  Idle,
  AwaitingRemoval,
  Cycling,
  ConfirmingPlacement,
  Complete,
  Cancelled,
  SyncWarning,
  Error
};

enum class HumanPromotionSelectionEvent {
  None,
  PawnRemovalObserved,
  ChoiceChanged,
  ChoiceLatched,
  PlacementRemoved,
  ConfirmationReady,
  Cancelled,
  RestoreRequired,
  Recovered,
  Error
};

struct HumanPromotionSelectorConfig {
  std::uint32_t choicePeriodMs = 2500;
  std::uint32_t placementStableMs = 500;
};

struct HumanPromotionSelectionUpdate {
  HumanPromotionSelectionState state = HumanPromotionSelectionState::Idle;
  HumanPromotionSelectionEvent event = HumanPromotionSelectionEvent::None;
  char displayedChoice = 0;
  std::optional<char> confirmedChoice;
  OccupancyDiff difference;
  std::string message;
};

class OfflineHumanPromotionSelector {
 public:
  explicit OfflineHumanPromotionSelector(HumanPromotionSelectorConfig config = {});

  bool begin(const HumanPromotionRequest& request, std::uint32_t nowMs);
  void reset();
  HumanPromotionSelectionUpdate processSnapshot(
      std::uint32_t nowMs, const Occupancy& occupancy);
  HumanPromotionSelectionUpdate tick(std::uint32_t nowMs);

  [[nodiscard]] HumanPromotionSelectionUpdate currentState() const;
  [[nodiscard]] HumanPromotionSelectionState state() const { return state_; }
  [[nodiscard]] char displayedChoice() const;
  [[nodiscard]] const std::optional<HumanPromotionRequest>& request() const {
    return request_;
  }

 private:
  void refreshChoice(std::uint32_t nowMs);
  void enterSyncWarning(
      const Occupancy& occupancy, HumanPromotionSelectionState resumeState);
  HumanPromotionSelectionUpdate updateFor(
      HumanPromotionSelectionEvent event, std::string message = {}) const;

  HumanPromotionSelectorConfig config_;
  std::optional<HumanPromotionRequest> request_;
  HumanPromotionSelectionState state_ = HumanPromotionSelectionState::Idle;
  HumanPromotionSelectionState resumeState_ = HumanPromotionSelectionState::Cycling;
  Occupancy replacementEmptyOccupancy_{};
  Occupancy lastOccupancy_{};
  bool hasLastOccupancy_ = false;
  std::size_t choiceIndex_ = 0;
  std::uint32_t choiceStartedMs_ = 0;
  std::uint32_t placementStartedMs_ = 0;
  std::optional<char> confirmedChoice_;
  OccupancyDiff warningDifference_;
};

const char* humanPromotionSelectionStateName(HumanPromotionSelectionState state);
const char* humanPromotionSelectionEventName(HumanPromotionSelectionEvent event);

}  // namespace offline
