#pragma once

#include "offline_physical.h"

#include <cstdint>
#include <optional>
#include <string>

namespace offline {

enum class OfflineSideSelectionState {
  Idle,
  AwaitingChoice,
  HoldingChoice,
  RestoringSetup,
  Complete,
  SyncWarning,
  Error
};

enum class OfflineSideSelectionEvent {
  None,
  Armed,
  ChoiceStarted,
  ChoiceCancelled,
  ChoiceLatched,
  RestoreStabilizing,
  ChoiceConfirmed,
  RestoreRequired,
  Recovered,
  Error
};

struct OfflineSideSelectorConfig {
  std::uint32_t holdMs = 1000;
  std::uint32_t restoreStableMs = 500;
  std::string whiteKingSquare = "e1";
  std::string blackKingSquare = "e8";
};

struct OfflineSideSelectionUpdate {
  OfflineSideSelectionState state = OfflineSideSelectionState::Idle;
  OfflineSideSelectionEvent event = OfflineSideSelectionEvent::None;
  std::optional<HumanColor> candidate;
  std::optional<HumanColor> selected;
  OccupancyDiff difference;
  std::string message;
};

class OfflineSideSelector {
 public:
  explicit OfflineSideSelector(OfflineSideSelectorConfig config = {});

  bool begin(const Occupancy& expectedSetup, std::uint32_t nowMs = 0);
  void reset();
  OfflineSideSelectionUpdate processSnapshot(
      std::uint32_t nowMs, const Occupancy& occupancy);

  [[nodiscard]] OfflineSideSelectionUpdate currentState() const;
  [[nodiscard]] OfflineSideSelectionState state() const { return state_; }
  [[nodiscard]] std::optional<HumanColor> selectedColor() const {
    return selected_;
  }

 private:
  [[nodiscard]] bool isChoiceOccupancy(
      const Occupancy& occupancy, HumanColor color) const;
  void enterWarning(const Occupancy& occupancy);
  OfflineSideSelectionUpdate updateFor(
      OfflineSideSelectionEvent event, std::string message = {}) const;

  OfflineSideSelectorConfig config_;
  OfflineSideSelectionState state_ = OfflineSideSelectionState::Idle;
  Occupancy expectedSetup_{};
  std::optional<HumanColor> candidate_;
  std::optional<HumanColor> selected_;
  bool choiceLatched_ = false;
  bool restoreTracking_ = false;
  std::uint32_t holdStartedMs_ = 0;
  std::uint32_t restoreStartedMs_ = 0;
  OccupancyDiff warningDifference_;
};

const char* offlineSideSelectionStateName(OfflineSideSelectionState state);
const char* offlineSideSelectionEventName(OfflineSideSelectionEvent event);

}  // namespace offline
