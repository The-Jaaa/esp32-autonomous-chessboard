#pragma once

#include "offline_route.h"

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace offline {

struct ExternalSlot {
  std::string id;
  std::string label;
  std::string key;
  double x = 0.0;
  double y = 0.0;
  char lane = '\0';
  int rank = 0;
};

enum class ExternalTargetType {
  Square,
  Coordinate
};

struct ExternalRouteTarget {
  ExternalTargetType type = ExternalTargetType::Square;
  std::string role;
  std::string square;
  int rawIndex = -1;
  std::string label;
  char lane = '\0';
  int rank = 0;
  double x = 0.0;
  double y = 0.0;
};

enum class ExternalRouteStatus {
  Success,
  InvalidRequest,
  NoLanePath,
  NoGraveyardCapacity,
  NoGraveyardPath
};

enum class ExternalRouteMode {
  Direct,
  BoardDirect,
  BoardLine,
  BoardBuffered,
  BoardRelaxed,
  Lane,
  LaneBoard,
  GraveyardDirect,
  GraveyardBoardPath
};

struct RouteFailure {
  std::string slot;
  std::string error;
};

struct ExternalTransferRequest {
  std::string from;
  std::string to;
  Occupancy expectedOccupancy{};
  std::optional<Occupancy> sensedOccupancy;
  std::vector<std::string> ignoredSquares;
  std::vector<ExternalSlot> slots;
  std::vector<std::string> occupiedSlotKeys;
  std::optional<char> preferredLane;
  bool directWhenClear = false;
  bool forceLane = false;
};

struct ExternalTransferResult {
  ExternalRouteStatus status = ExternalRouteStatus::InvalidRequest;
  ExternalRouteMode mode = ExternalRouteMode::Direct;
  int routeCost = 0;
  std::vector<std::string> rawPathSquares;
  std::vector<std::string> compressedPathSquares;
  std::vector<ExternalRouteTarget> targets;
  std::optional<ExternalSlot> sourceSlot;
  std::optional<ExternalSlot> entrySlot;
  std::vector<RouteFailure> failures;
  std::string blockedReason;

  [[nodiscard]] bool success() const { return status == ExternalRouteStatus::Success; }
};

struct GraveyardRouteRequest {
  std::string sourceSquare;
  Occupancy expectedOccupancy{};
  std::optional<Occupancy> sensedOccupancy;
  std::vector<std::string> ignoredSquares;
  std::vector<ExternalSlot> slots;
  std::vector<std::string> occupiedSlotKeys;
};

struct GraveyardRouteCandidate {
  ExternalSlot slot;
  ExternalRouteMode mode = ExternalRouteMode::GraveyardDirect;
  double routeCost = 0.0;
  double routeScore = 0.0;
  int crowdingCost = 0;
  double preferenceCost = 0.0;
  std::vector<std::string> rawPathSquares;
  std::vector<std::string> compressedPathSquares;
  std::vector<ExternalRouteTarget> targets;
};

struct GraveyardRouteResult {
  ExternalRouteStatus status = ExternalRouteStatus::InvalidRequest;
  std::optional<GraveyardRouteCandidate> selected;
  std::vector<GraveyardRouteCandidate> candidates;
  std::vector<RouteFailure> failures;
  std::string blockedReason;

  [[nodiscard]] bool success() const {
    return status == ExternalRouteStatus::Success && selected.has_value();
  }
};

class OfflineExternalRoutePlanner {
 public:
  [[nodiscard]] ExternalTransferResult planTransfer(
      const ExternalTransferRequest& request) const;

  [[nodiscard]] GraveyardRouteResult planGraveyardRemoval(
      const GraveyardRouteRequest& request) const;
};

std::vector<ExternalSlot> defaultExternalSlots();
std::vector<ExternalSlot> normalizeExternalSlots(const std::vector<ExternalSlot>& slots);
std::string externalSlotKey(const ExternalSlot& slot);
std::vector<std::string> reserveVerifiedSlot(
    const std::vector<std::string>& occupiedKeys, std::string_view slotKey);
std::vector<std::string> releaseVerifiedSlot(
    const std::vector<std::string>& occupiedKeys, std::string_view slotKey);

const char* externalRouteStatusName(ExternalRouteStatus status);
const char* externalRouteModeName(ExternalRouteMode mode);

}  // namespace offline
