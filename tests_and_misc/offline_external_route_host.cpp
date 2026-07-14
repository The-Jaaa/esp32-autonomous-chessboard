#include "../offline_core/offline_external_route.h"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::ExternalRouteTarget;
using offline::ExternalSlot;
using offline::ExternalTargetType;
using offline::ExternalTransferRequest;
using offline::GraveyardRouteCandidate;
using offline::GraveyardRouteRequest;
using offline::Occupancy;
using offline::OfflineExternalRoutePlanner;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

std::vector<std::string> split(const std::string& value, char delimiter) {
  std::vector<std::string> result;
  std::stringstream stream(value);
  std::string part;
  while (std::getline(stream, part, delimiter)) result.push_back(part);
  if (!value.empty() && value.back() == delimiter) result.emplace_back();
  return result;
}

std::string join(const std::vector<std::string>& values, char delimiter = ',') {
  std::ostringstream result;
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (index > 0) result << delimiter;
    result << values[index];
  }
  return result.str();
}

std::string number(double value) {
  std::ostringstream result;
  result << std::setprecision(15) << value;
  return result.str();
}

Occupancy sensedOccupancy(const std::string& squares) {
  Occupancy result{};
  if (squares == "-" || squares.empty()) return result;
  for (const std::string& square : split(squares, ',')) {
    const int index = offline::squareToRawIndex(square);
    require(index >= 0, "Invalid sensed square " + square + '.');
    result[static_cast<std::size_t>(index)] = true;
  }
  return result;
}

std::vector<std::string> listField(const std::string& field) {
  return field == "-" || field.empty() ? std::vector<std::string>{} : split(field, ',');
}

std::vector<ExternalSlot> slotsField(const std::string& field) {
  if (field == "DEFAULT") return {};
  std::vector<ExternalSlot> slots;
  for (const std::string& encoded : split(field, '|')) {
    const std::vector<std::string> parts = split(encoded, ':');
    require(parts.size() == 3, "Slot fixture must be label:x:y.");
    ExternalSlot slot;
    slot.label = parts[0];
    slot.x = std::stod(parts[1]);
    slot.y = std::stod(parts[2]);
    slots.push_back(std::move(slot));
  }
  return slots;
}

std::string targetToken(const ExternalRouteTarget& target) {
  if (target.type == ExternalTargetType::Square) return "S:" + target.square;
  return "C:" + target.role + ':' + target.label + ':' +
         (target.lane == '\0' ? "-" : std::string(1, target.lane)) + ':' +
         std::to_string(target.rank) + ':' + number(target.x) + ':' + number(target.y);
}

std::string targetsToken(const std::vector<ExternalRouteTarget>& targets) {
  std::vector<std::string> encoded;
  std::transform(targets.begin(), targets.end(), std::back_inserter(encoded), targetToken);
  return join(encoded);
}

std::string failuresToken(const std::vector<offline::RouteFailure>& failures) {
  std::vector<std::string> encoded;
  for (const auto& failure : failures) encoded.push_back(failure.slot + '~' + failure.error);
  return join(encoded, '^');
}

std::string candidateToken(const GraveyardRouteCandidate& candidate) {
  return candidate.slot.label + '~' + offline::externalRouteModeName(candidate.mode) + '~' +
         number(candidate.routeCost) + '~' + number(candidate.routeScore) + '~' +
         std::to_string(candidate.crowdingCost) + '~' + number(candidate.preferenceCost) + '~' +
         join(candidate.rawPathSquares) + '~' + join(candidate.compressedPathSquares) + '~' +
         targetsToken(candidate.targets);
}

std::string candidateSummaryToken(const GraveyardRouteCandidate& candidate) {
  return candidate.slot.label + '~' + number(candidate.routeCost) + '~' +
         number(candidate.routeScore) + '~' + std::to_string(candidate.crowdingCost) + '~' +
         join(candidate.compressedPathSquares);
}

void verifyTargets(const std::vector<ExternalRouteTarget>& targets, const std::string& context) {
  std::vector<std::string> keys;
  for (const ExternalRouteTarget& target : targets) {
    if (target.type == ExternalTargetType::Square) {
      require(offline::squareToRawIndex(target.square) == target.rawIndex && target.rawIndex >= 0,
              context + ": square target metadata is invalid.");
      keys.push_back("S:" + target.square);
    } else {
      require(std::isfinite(target.x) && std::isfinite(target.y) &&
                  (target.lane == 'Z' || target.lane == 'I') &&
                  target.rank >= 1 && target.rank <= 8,
              context + ": coordinate target metadata is invalid.");
      keys.push_back("C:" + target.label);
    }
  }
  std::sort(keys.begin(), keys.end());
  require(std::adjacent_find(keys.begin(), keys.end()) == keys.end(),
          context + ": route contains duplicate targets.");
}

void verifyDefaultsAndTransactions() {
  const std::vector<ExternalSlot> slots = offline::defaultExternalSlots();
  require(slots.size() == 16, "Default external slot count must remain 16.");
  require(slots[0].label == "Z1" && slots[0].x == 29300 && slots[0].y == 34450,
          "Z1 coordinates changed.");
  require(slots[7].label == "Z8" && slots[7].x == 1300 && slots[7].y == 34450,
          "Z8 coordinates changed.");
  require(slots[8].label == "I8" && slots[8].x == 1500 && slots[8].y == -350,
          "I8 coordinates changed.");
  require(slots[15].label == "I1" && slots[15].x == 29600 && slots[15].y == -350,
          "I1 coordinates changed.");

  ExternalSlot alias;
  alias.label = "Captured 3";
  alias.x = 1;
  alias.y = 2;
  const auto normalized = offline::normalizeExternalSlots({alias});
  require(normalized.size() == 1 && normalized[0].label == "Z3" &&
              normalized[0].lane == 'Z' && normalized[0].rank == 3,
          "Captured slot alias must normalize to Z3.");
  alias.label = " i 6 ";
  const auto spaced = offline::normalizeExternalSlots({alias});
  require(spaced.size() == 1 && spaced[0].lane == 'I' && spaced[0].rank == 6,
          "Whitespace-separated lane labels must match online normalization.");

  const std::vector<std::string> original{"z4"};
  const auto reserved = offline::reserveVerifiedSlot(original, "i5");
  require(original == std::vector<std::string>{"z4"}, "Reserve helper mutated its input.");
  require(reserved == std::vector<std::string>({"z4", "I5"}), "Verified reservation failed.");
  require(offline::reserveVerifiedSlot(reserved, "I5") == reserved,
          "Verified reservation must be idempotent.");
  require(offline::releaseVerifiedSlot(reserved, "i5") == std::vector<std::string>{"z4"},
          "Verified release failed.");
  require(offline::releaseVerifiedSlot(original, "I5") == original,
          "Verified release must be idempotent.");
  require(offline::releaseVerifiedSlot(original, "") == original,
          "Releasing an empty key must be a no-op.");

  OfflineExternalRoutePlanner planner;
  ExternalTransferRequest invalidTransfer;
  invalidTransfer.from = "a1";
  invalidTransfer.to = "a2";
  invalidTransfer.ignoredSquares = {"z9"};
  require(!planner.planTransfer(invalidTransfer).success(),
          "Invalid ignored transfer square must be rejected.");
  GraveyardRouteRequest invalidGraveyard;
  invalidGraveyard.sourceSquare = "a1";
  invalidGraveyard.ignoredSquares = {"z9"};
  require(!planner.planGraveyardRemoval(invalidGraveyard).success(),
          "Invalid ignored graveyard square must be rejected.");
}

void runFixture(const std::vector<std::string>& fields) {
  require(fields.size() == 12, "External route fixture must contain 12 fields.");
  const std::string& kind = fields[0];
  const std::string& id = fields[1];
  const Occupancy expected = offline::occupancyFromFen(fields[2]);
  const std::optional<Occupancy> sensed = fields[5] == "-"
                                                ? std::nullopt
                                                : std::optional<Occupancy>(sensedOccupancy(fields[5]));
  const std::vector<std::string> ignored = listField(fields[6]);
  const std::vector<ExternalSlot> slots = slotsField(fields[7]);
  const std::vector<std::string> occupied = listField(fields[8]);
  OfflineExternalRoutePlanner planner;

  if (kind == "T") {
    ExternalTransferRequest request;
    request.from = fields[3];
    request.to = fields[4];
    request.expectedOccupancy = expected;
    request.sensedOccupancy = sensed;
    request.ignoredSquares = ignored;
    request.slots = slots;
    request.occupiedSlotKeys = occupied;
    request.forceLane = fields[9] == "1";
    if (fields[10] != "-") request.preferredLane = fields[10][0];
    request.directWhenClear = fields[11] == "1";
    const ExternalTransferRequest before = request;
    const auto result = planner.planTransfer(request);
    require(request.from == before.from && request.to == before.to &&
                request.expectedOccupancy == before.expectedOccupancy &&
                request.occupiedSlotKeys == before.occupiedSlotKeys,
            id + ": transfer planning mutated its request.");
    if (result.success()) verifyTargets(result.targets, id);
    else require(result.targets.empty(), id + ": failed transfer returned partial targets.");
    std::cout << "TRANSFER\t" << id << '\t'
              << offline::externalRouteStatusName(result.status) << '\t'
              << (result.success() ? offline::externalRouteModeName(result.mode) : "-") << '\t'
              << result.routeCost << '\t' << join(result.rawPathSquares) << '\t'
              << join(result.compressedPathSquares) << '\t' << targetsToken(result.targets) << '\t'
              << failuresToken(result.failures) << '\t' << result.blockedReason << std::endl;
    return;
  }

  require(kind == "G", id + ": unknown fixture kind.");
  GraveyardRouteRequest request;
  request.sourceSquare = fields[3];
  request.expectedOccupancy = expected;
  request.sensedOccupancy = sensed;
  request.ignoredSquares = ignored;
  request.slots = slots;
  request.occupiedSlotKeys = occupied;
  const GraveyardRouteRequest before = request;
  const auto result = planner.planGraveyardRemoval(request);
  require(request.sourceSquare == before.sourceSquare &&
              request.expectedOccupancy == before.expectedOccupancy &&
              request.occupiedSlotKeys == before.occupiedSlotKeys,
          id + ": graveyard planning mutated its request.");
  for (const auto& candidate : result.candidates) verifyTargets(candidate.targets, id);
  if (!result.success()) require(!result.selected, id + ": failed graveyard plan selected a slot.");
  std::vector<std::string> candidates;
  for (const auto& candidate : result.candidates) candidates.push_back(candidateSummaryToken(candidate));
  std::cout << "GRAVEYARD\t" << id << '\t'
            << offline::externalRouteStatusName(result.status) << '\t'
            << (result.selected ? candidateToken(*result.selected) : "-") << '\t'
            << join(candidates, '^') << '\t' << failuresToken(result.failures) << '\t'
            << result.blockedReason << std::endl;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    require(argc == 2, "Usage: offline_external_route_host <fixtures.tsv>");
    verifyDefaultsAndTransactions();
    std::ifstream input(argv[1]);
    require(input.good(), "Could not open external route fixture file.");
    std::string line;
    int fixtures = 0;
    while (std::getline(input, line)) {
      if (line.empty()) continue;
      runFixture(split(line, '\t'));
      ++fixtures;
    }
    require(fixtures > 0, "No external route fixtures were processed.");
    std::cout << "offline external route regressions passed" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline external route regression failed: " << error.what() << std::endl;
    return 1;
  }
}
