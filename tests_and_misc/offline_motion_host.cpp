#include "../offline_core/offline_motion.h"

#include <algorithm>
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
using offline::MotionPhase;
using offline::MotionPlanningContext;
using offline::MotionPlan;
using offline::Occupancy;
using offline::OfflineGame;
using offline::OfflineMotionPlanner;

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

std::vector<std::string> listField(const std::string& field) {
  return field.empty() || field == "-" ? std::vector<std::string>{} : split(field, ',');
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

Occupancy occupancyField(const std::string& field) {
  Occupancy occupancy{};
  for (const std::string& square : listField(field)) {
    const int index = offline::squareToRawIndex(square);
    require(index >= 0, "Invalid sensed square " + square + '.');
    occupancy[static_cast<std::size_t>(index)] = true;
  }
  return occupancy;
}

std::string occupancyToken(const Occupancy& occupancy) {
  std::string result;
  result.reserve(64);
  for (bool value : occupancy) result.push_back(value ? '1' : '0');
  return result;
}

std::string sanitized(std::string value) {
  std::replace(value.begin(), value.end(), '\t', ' ');
  std::replace(value.begin(), value.end(), '\n', ' ');
  std::replace(value.begin(), value.end(), '^', '|');
  std::replace(value.begin(), value.end(), '~', '-');
  return value;
}

std::string phaseToken(const MotionPhase& phase) {
  std::string mode = "-";
  double cost = 0.0;
  std::vector<std::string> raw;
  std::vector<std::string> compressed;
  if (phase.transfer) {
    mode = offline::externalRouteModeName(phase.transfer->mode);
    cost = phase.transfer->routeCost;
    raw = phase.transfer->rawPathSquares;
    compressed = phase.transfer->compressedPathSquares;
  } else if (phase.graveyard) {
    mode = offline::externalRouteModeName(phase.graveyard->mode);
    cost = phase.graveyard->routeCost;
    raw = phase.graveyard->rawPathSquares;
    compressed = phase.graveyard->compressedPathSquares;
  }
  return std::string(offline::motionPhaseKindName(phase.kind)) + '~' + phase.from + '~' +
         phase.to + '~' + mode + '~' + number(cost) + '~' + join(raw) + '~' +
         join(compressed) + '~' + occupancyToken(phase.expectedBefore) + '~' +
         occupancyToken(phase.expectedAfter);
}

std::string rejectedToken(const offline::RejectedMotionStrategy& rejected) {
  return std::string(offline::motionStrategyName(rejected.strategy)) + '~' +
         (rejected.stagingSquare.empty() ? "-" : rejected.stagingSquare) + '~' +
         sanitized(rejected.reason);
}

std::string candidateToken(const offline::GraveyardRouteCandidate& candidate) {
  return candidate.slot.label + '~' + number(candidate.routeScore) + '~' +
         number(candidate.routeCost) + '~' + std::to_string(candidate.crowdingCost) + '~' +
         join(candidate.compressedPathSquares);
}

void verifySuccessfulPlan(const MotionPlan& plan, const std::string& id) {
  require(!plan.phases.empty(), id + ": successful plan has no phases.");
  Occupancy expected = plan.initialOccupancy;
  for (const MotionPhase& phase : plan.phases) {
    require(phase.expectedBefore == expected, id + ": phase occupancy chain is broken.");
    require(phase.transfer.has_value() != phase.graveyard.has_value(),
            id + ": phase must contain exactly one route payload.");
    expected = phase.expectedAfter;
  }
  require(expected == plan.finalExpectedOccupancy,
          id + ": final phase occupancy differs from the legal move.");
  if (plan.move.capture) {
    require(plan.proposedGraveyardSlot.has_value(),
            id + ": capture did not propose a graveyard slot.");
  } else {
    require(!plan.proposedGraveyardSlot,
            id + ": non-capture proposed a graveyard slot.");
  }
}

void runFixture(const std::vector<std::string>& fields) {
  require(fields.size() == 7, "Motion fixture must contain 7 fields.");
  const std::string& id = fields[0];
  OfflineGame game;
  require(game.loadFen(fields[1]), id + ": invalid fixture FEN.");
  const std::string originalFen = game.fen();

  MotionPlanningContext context;
  if (fields[3] != "-") context.sensedOccupancy = occupancyField(fields[3]);
  context.slots = slotsField(fields[4]);
  context.occupiedGraveyardKeys = listField(fields[5]);
  const MotionPlanningContext originalContext = context;

  OfflineMotionPlanner planner;
  const MotionPlan plan = planner.planMove(game, fields[2], context);
  require(game.fen() == originalFen, id + ": motion planning mutated the game.");
  require(context.sensedOccupancy == originalContext.sensedOccupancy &&
              context.occupiedGraveyardKeys == originalContext.occupiedGraveyardKeys &&
              context.slots.size() == originalContext.slots.size(),
          id + ": motion planning mutated its context.");
  if (plan.success()) verifySuccessfulPlan(plan, id);
  else require(plan.phases.empty(), id + ": failed plan returned partial phases.");
  require(std::string(offline::motionPlanStatusName(plan.status)) == fields[6],
          id + ": unexpected fixture status.");

  std::vector<std::string> phases;
  for (const MotionPhase& phase : plan.phases) phases.push_back(phaseToken(phase));
  std::vector<std::string> rejected;
  for (const auto& item : plan.rejectedStrategies) rejected.push_back(rejectedToken(item));
  std::vector<std::string> graveyardCandidates;
  for (const auto& candidate : plan.graveyardCandidates) {
    graveyardCandidates.push_back(candidateToken(candidate));
  }
  std::cout << "MOTION\t" << id << '\t' << offline::motionPlanStatusName(plan.status) << '\t'
            << (plan.success() ? offline::motionStrategyName(plan.strategy) : "-") << '\t'
            << number(plan.routeCost) << '\t'
            << (plan.stagingSquare.empty() ? "-" : plan.stagingSquare) << '\t'
            << (plan.proposedGraveyardSlot ? plan.proposedGraveyardSlot->label : "-") << '\t'
            << join(graveyardCandidates, '^') << '\t'
            << join(plan.rawPathSquares) << '\t' << join(plan.compressedPathSquares) << '\t'
            << join(phases, '^') << '\t' << join(rejected, '^') << '\t'
            << occupancyToken(plan.initialOccupancy) << '\t'
            << occupancyToken(plan.finalExpectedOccupancy) << '\t'
            << sanitized(plan.blockedReason) << std::endl;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    require(argc == 2, "Usage: offline_motion_host <fixtures.tsv>");
    std::ifstream input(argv[1]);
    require(input.good(), "Could not open motion fixture file.");
    std::string line;
    int fixtures = 0;
    while (std::getline(input, line)) {
      if (line.empty()) continue;
      runFixture(split(line, '\t'));
      ++fixtures;
    }
    require(fixtures > 0, "No motion fixtures were processed.");
    std::cout << "offline motion regressions passed" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline motion regression failed: " << error.what() << std::endl;
    return 1;
  }
}
