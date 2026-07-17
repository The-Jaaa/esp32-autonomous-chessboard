#include "offline_motion.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <set>
#include <utility>

namespace offline {
namespace {

bool validSquare(const std::string& square) {
  return square.size() == 2 && square[0] >= 'a' && square[0] <= 'h' &&
         square[1] >= '1' && square[1] <= '8';
}

int fileIndex(const std::string& square) {
  return validSquare(square) ? square[0] - 'a' : -1;
}

int rankNumber(const std::string& square) {
  return validSquare(square) ? square[1] - '0' : -1;
}

std::string squareFromFileRank(int file, int rank) {
  if (file < 0 || file > 7 || rank < 1 || rank > 8) return {};
  return std::string{static_cast<char>('a' + file), static_cast<char>('0' + rank)};
}

bool occupied(const Occupancy& occupancy, const std::string& square) {
  const int index = squareToRawIndex(square);
  return index < 0 || occupancy[static_cast<std::size_t>(index)];
}

void setOccupied(Occupancy& occupancy, const std::string& square, bool value) {
  const int index = squareToRawIndex(square);
  if (index >= 0) occupancy[static_cast<std::size_t>(index)] = value;
}

bool samePieceType(const std::string& piece, char expected) {
  if (piece.empty()) return false;
  return static_cast<char>(std::tolower(static_cast<unsigned char>(piece.front()))) == expected;
}

bool simplePawnPush(const MoveInfo& move, const std::string& from, const std::string& to) {
  return samePieceType(move.piece, 'p') && fileIndex(from) == fileIndex(to) &&
         std::abs(rankNumber(from) - rankNumber(to)) >= 1 &&
         std::abs(rankNumber(from) - rankNumber(to)) <= 2;
}

std::string routeFailureReason(
    const ExternalTransferResult& route,
    const std::string& from,
    const std::string& to) {
  std::string reason = "No safe route from " + from + " to " + to + ".";
  if (!route.blockedReason.empty()) reason += " " + route.blockedReason;
  for (const RouteFailure& failure : route.failures) {
    reason += " " + (failure.slot.empty() ? std::string("lane") : failure.slot) +
              ": " + failure.error;
  }
  return reason;
}

std::string graveyardFailureReason(
    const GraveyardRouteResult& removal,
    const std::string& capturedSquare) {
  std::string reason = "No clear graveyard route was found for captured piece on " +
                       capturedSquare + ".";
  if (!removal.failures.empty()) reason += " " + removal.failures.front().error;
  else if (!removal.blockedReason.empty()) reason += " " + removal.blockedReason;
  return reason;
}

MotionPlanStatus statusForGraveyardFailure(const GraveyardRouteResult& result) {
  return result.status == ExternalRouteStatus::NoGraveyardCapacity
             ? MotionPlanStatus::NoGraveyardCapacity
             : MotionPlanStatus::NoGraveyardPath;
}

ExternalTransferResult planTransfer(
    const OfflineExternalRoutePlanner& planner,
    const MotionPlanningContext& context,
    const Occupancy& expected,
    const MoveInfo& move,
    const std::string& from,
    const std::string& to,
    std::vector<std::string> ignored = {},
    bool forceLane = false) {
  ExternalTransferRequest request;
  request.from = from;
  request.to = to;
  request.expectedOccupancy = expected;
  request.sensedOccupancy = context.sensedOccupancy;
  request.ignoredSquares = std::move(ignored);
  request.slots = context.slots;
  request.occupiedSlotKeys = context.occupiedGraveyardKeys;
  request.directWhenClear = simplePawnPush(move, from, to);
  request.forceLane = forceLane;
  return planner.planTransfer(request);
}

GraveyardRouteResult planRemoval(
    const OfflineExternalRoutePlanner& planner,
    const MotionPlanningContext& context,
    const Occupancy& expected,
    const std::string& capturedSquare,
    std::vector<std::string> ignored) {
  GraveyardRouteRequest request;
  request.sourceSquare = capturedSquare;
  request.expectedOccupancy = expected;
  request.sensedOccupancy = context.sensedOccupancy;
  request.ignoredSquares = std::move(ignored);
  request.slots = context.slots;
  request.occupiedSlotKeys = context.occupiedGraveyardKeys;
  return planner.planGraveyardRemoval(request);
}

void appendRouteMetadata(MotionPlan& plan, const ExternalTransferResult& route) {
  plan.routeCost += route.routeCost;
  plan.rawPathSquares.insert(
      plan.rawPathSquares.end(), route.rawPathSquares.begin(), route.rawPathSquares.end());
  plan.compressedPathSquares.insert(
      plan.compressedPathSquares.end(),
      route.compressedPathSquares.begin(), route.compressedPathSquares.end());
}

void appendRouteMetadata(MotionPlan& plan, const GraveyardRouteCandidate& route) {
  plan.routeCost += route.routeCost;
  plan.rawPathSquares.insert(
      plan.rawPathSquares.end(), route.rawPathSquares.begin(), route.rawPathSquares.end());
  plan.compressedPathSquares.insert(
      plan.compressedPathSquares.end(),
      route.compressedPathSquares.begin(), route.compressedPathSquares.end());
}

void appendTransferPhase(
    MotionPlan& plan,
    MotionPhaseKind kind,
    const std::string& from,
    const std::string& to,
    const ExternalTransferResult& route,
    Occupancy& occupancy) {
  MotionPhase phase;
  phase.kind = kind;
  phase.from = from;
  phase.to = to;
  phase.expectedBefore = occupancy;
  setOccupied(occupancy, from, false);
  setOccupied(occupancy, to, true);
  phase.expectedAfter = occupancy;
  phase.transfer = route;
  plan.phases.push_back(std::move(phase));
  appendRouteMetadata(plan, route);
}

void appendRemovalPhase(
    MotionPlan& plan,
    const std::string& capturedSquare,
    const GraveyardRouteCandidate& route,
    Occupancy& occupancy) {
  MotionPhase phase;
  phase.kind = MotionPhaseKind::CapturedRemoval;
  phase.from = capturedSquare;
  phase.to = route.slot.label;
  phase.expectedBefore = occupancy;
  setOccupied(occupancy, capturedSquare, false);
  phase.expectedAfter = occupancy;
  phase.graveyard = route;
  plan.phases.push_back(std::move(phase));
  appendRouteMetadata(plan, route);
}

std::vector<std::string> stagingCandidates(
    const Occupancy& occupancy,
    const MoveInfo& move) {
  std::vector<std::pair<std::string, int>> candidates;
  const int targetFile = fileIndex(move.to);
  const int targetRank = rankNumber(move.to);
  for (int df = -1; df <= 1; ++df) {
    for (int dr = -1; dr <= 1; ++dr) {
      if (df == 0 && dr == 0) continue;
      const std::string square = squareFromFileRank(targetFile + df, targetRank + dr);
      if (square.empty() || square == move.from || square == move.to || occupied(occupancy, square)) {
        continue;
      }
      candidates.emplace_back(square, std::abs(df) + std::abs(dr));
    }
  }

  if (candidates.empty()) {
    for (int rank = 1; rank <= 8; ++rank) {
      for (int file = 0; file < 8; ++file) {
        const std::string square = squareFromFileRank(file, rank);
        if (square == move.from || square == move.to || occupied(occupancy, square)) continue;
        candidates.emplace_back(
            square, std::abs(file - targetFile) + std::abs(rank - targetRank));
      }
    }
  }

  std::stable_sort(candidates.begin(), candidates.end(), [](const auto& left, const auto& right) {
    return left.second < right.second;
  });
  std::vector<std::string> result;
  for (const auto& candidate : candidates) result.push_back(candidate.first);
  return result;
}

MotionPlan basePlan(const OfflineGame& game, const MoveInfo& move) {
  MotionPlan plan;
  plan.move = move;
  plan.initialOccupancy = occupancyFromFen(game.fen());
  OfflineGame after = game;
  MoveInfo applied;
  if (after.applyUci(move.uci, applied)) {
    plan.finalExpectedOccupancy = occupancyFromFen(after.fen());
  }
  return plan;
}

bool finishPlan(MotionPlan& plan, const Occupancy& actualFinal) {
  if (actualFinal != plan.finalExpectedOccupancy) {
    plan.status = MotionPlanStatus::NoSafeRoute;
    plan.blockedReason = "Motion phases do not reproduce the legal move occupancy.";
    plan.phases.clear();
    plan.routeCost = 0.0;
    plan.rawPathSquares.clear();
    plan.compressedPathSquares.clear();
    plan.proposedGraveyardSlot.reset();
    return false;
  }
  plan.status = MotionPlanStatus::Success;
  return true;
}

MotionPlan planQuiet(
    const OfflineExternalRoutePlanner& planner,
    const OfflineGame& game,
    const MoveInfo& move,
    const MotionPlanningContext& context) {
  MotionPlan plan = basePlan(game, move);
  plan.strategy = MotionStrategy::Quiet;
  const ExternalTransferResult route = planTransfer(
      planner, context, plan.initialOccupancy, move, move.from, move.to);
  if (!route.success()) {
    plan.status = MotionPlanStatus::NoSafeRoute;
    plan.blockedReason = routeFailureReason(route, move.from, move.to);
    return plan;
  }
  Occupancy occupancy = plan.initialOccupancy;
  appendTransferPhase(
      plan, MotionPhaseKind::QuietTransfer, move.from, move.to, route, occupancy);
  finishPlan(plan, occupancy);
  return plan;
}

MotionPlan planCapture(
    const OfflineExternalRoutePlanner& planner,
    const OfflineGame& game,
    const MoveInfo& move,
    const MotionPlanningContext& context) {
  MotionPlan plan = basePlan(game, move);
  const Occupancy initial = plan.initialOccupancy;
  const std::string capturedSquare = move.capturedSquare;
  const GraveyardRouteResult directRemoval = planRemoval(
      planner, context, initial, capturedSquare, {capturedSquare});
  const GraveyardRouteResult stagedRemoval = planRemoval(
      planner, context, initial, capturedSquare, {move.from, capturedSquare});

  if (directRemoval.success()) {
    const ExternalTransferResult attacker = planTransfer(
        planner, context, initial, move, move.from, move.to,
        {capturedSquare, move.to});
    if (attacker.success()) {
      plan.strategy = MotionStrategy::CaptureDirectAfterRemoval;
      plan.proposedGraveyardSlot = directRemoval.selected->slot;
      plan.graveyardCandidates = directRemoval.candidates;
      Occupancy occupancy = initial;
      appendRemovalPhase(plan, capturedSquare, *directRemoval.selected, occupancy);
      appendTransferPhase(
          plan, MotionPhaseKind::AttackerFinal, move.from, move.to, attacker, occupancy);
      finishPlan(plan, occupancy);
      return plan;
    }
    plan.rejectedStrategies.push_back({
        MotionStrategy::CaptureDirectAfterRemoval, {},
        routeFailureReason(attacker, move.from, move.to)});
  } else {
    plan.rejectedStrategies.push_back({
        MotionStrategy::CaptureDirectAfterRemoval, {},
        graveyardFailureReason(directRemoval, capturedSquare)});
  }

  const std::vector<std::string> candidates = stagingCandidates(initial, move);
  const std::string preferredStaging = candidates.empty() ? std::string{} : candidates.front();
  const std::vector<std::string> stagedRemovalSquares = stagedRemoval.selected
                                                              ? stagedRemoval.selected->rawPathSquares
                                                              : std::vector<std::string>{};
  const std::set<std::string> stagedRemovalPath(
      stagedRemovalSquares.begin(), stagedRemovalSquares.end());

  for (const std::string& candidate : candidates) {
    if (stagedRemovalPath.count(candidate) > 0) continue;
    const ExternalTransferResult approach = planTransfer(
        planner, context, initial, move, move.from, candidate);
    const ExternalTransferResult final = planTransfer(
        planner, context, initial, move, candidate, move.to,
        {move.from, capturedSquare, move.to});
    std::string failure;
    if (!approach.success()) failure = routeFailureReason(approach, move.from, candidate);
    else if (!final.success()) failure = routeFailureReason(final, candidate, move.to);
    else if (!stagedRemoval.success()) failure = graveyardFailureReason(stagedRemoval, capturedSquare);
    if (!failure.empty()) {
      plan.rejectedStrategies.push_back({
          MotionStrategy::CaptureStageFirstBoard, candidate, std::move(failure)});
      continue;
    }

    plan.strategy = MotionStrategy::CaptureStageFirstBoard;
    plan.stagingSquare = candidate;
    plan.proposedGraveyardSlot = stagedRemoval.selected->slot;
    plan.graveyardCandidates = stagedRemoval.candidates;
    Occupancy occupancy = initial;
    appendTransferPhase(
        plan, MotionPhaseKind::AttackerStage, move.from, candidate, approach, occupancy);
    appendRemovalPhase(plan, capturedSquare, *stagedRemoval.selected, occupancy);
    appendTransferPhase(
        plan, MotionPhaseKind::AttackerFinal, candidate, move.to, final, occupancy);
    finishPlan(plan, occupancy);
    return plan;
  }

  const GraveyardRouteResult& fallbackRemoval = directRemoval.success()
                                                    ? directRemoval
                                                    : stagedRemoval;
  if (!fallbackRemoval.success()) {
    plan.status = statusForGraveyardFailure(fallbackRemoval);
    plan.blockedReason = graveyardFailureReason(fallbackRemoval, capturedSquare);
    return plan;
  }

  const ExternalTransferResult fallbackAttacker = planTransfer(
      planner, context, initial, move, move.from, move.to,
      {capturedSquare, move.to});
  if (fallbackAttacker.success()) {
    plan.strategy = fallbackAttacker.mode == ExternalRouteMode::Lane
                        ? MotionStrategy::CaptureRemoveFirstLane
                        : MotionStrategy::CaptureRemoveFirstBoard;
    plan.proposedGraveyardSlot = fallbackRemoval.selected->slot;
    plan.graveyardCandidates = fallbackRemoval.candidates;
    Occupancy occupancy = initial;
    appendRemovalPhase(plan, capturedSquare, *fallbackRemoval.selected, occupancy);
    appendTransferPhase(
        plan, MotionPhaseKind::AttackerFinal, move.from, move.to,
        fallbackAttacker, occupancy);
    finishPlan(plan, occupancy);
    return plan;
  }
  plan.rejectedStrategies.push_back({
      MotionStrategy::CaptureRemoveFirstFallback, {},
      routeFailureReason(fallbackAttacker, move.from, move.to)});

  if (preferredStaging.empty()) {
    plan.status = MotionPlanStatus::NoSafeRoute;
    plan.blockedReason = "No safe capture route was found for " + move.uci + ".";
    return plan;
  }

  const std::vector<std::string> ignoredAfterPickup{
      move.from, move.to, capturedSquare, preferredStaging};
  const ExternalTransferResult safeStaging = planTransfer(
      planner, context, initial, move, move.from, preferredStaging, ignoredAfterPickup);
  if (!safeStaging.success()) {
    plan.status = MotionPlanStatus::NoSafeRoute;
    plan.blockedReason = routeFailureReason(safeStaging, move.from, preferredStaging);
    return plan;
  }
  const ExternalTransferResult stagingToTarget = planTransfer(
      planner, context, initial, move, preferredStaging, move.to, ignoredAfterPickup);
  if (!stagingToTarget.success()) {
    plan.status = MotionPlanStatus::NoSafeRoute;
    plan.blockedReason = routeFailureReason(stagingToTarget, preferredStaging, move.to);
    return plan;
  }

  plan.strategy = MotionStrategy::CaptureBoardStaging;
  plan.stagingSquare = preferredStaging;
  plan.proposedGraveyardSlot = fallbackRemoval.selected->slot;
  plan.graveyardCandidates = fallbackRemoval.candidates;
  Occupancy occupancy = initial;
  appendTransferPhase(
      plan, MotionPhaseKind::AttackerStage, move.from, preferredStaging,
      safeStaging, occupancy);
  appendRemovalPhase(plan, capturedSquare, *fallbackRemoval.selected, occupancy);
  appendTransferPhase(
      plan, MotionPhaseKind::AttackerFinal, preferredStaging, move.to,
      stagingToTarget, occupancy);
  finishPlan(plan, occupancy);
  return plan;
}

ExternalTransferResult planCastlePart(
    const OfflineExternalRoutePlanner& planner,
    const MotionPlanningContext& context,
    const Occupancy& expected,
    const MoveInfo& move,
    const std::string& from,
    const std::string& to,
    std::vector<std::string> ignored = {}) {
  ExternalTransferResult route = planTransfer(
      planner, context, expected, move, from, to, ignored);
  if (!route.success()) {
    route = planTransfer(
        planner, context, expected, move, from, to, std::move(ignored), true);
  }
  return route;
}

MotionPlan planCastle(
    const OfflineExternalRoutePlanner& planner,
    const OfflineGame& game,
    const MoveInfo& move,
    const MotionPlanningContext& context) {
  MotionPlan plan = basePlan(game, move);
  if (move.rookFrom.empty() || move.rookTo.empty()) {
    plan.status = MotionPlanStatus::NoSafeRoute;
    plan.blockedReason = "Castling move is missing rook metadata.";
    return plan;
  }

  const ExternalTransferResult king = planCastlePart(
      planner, context, plan.initialOccupancy, move, move.from, move.to);
  if (!king.success()) {
    plan.status = MotionPlanStatus::NoSafeRoute;
    plan.blockedReason = routeFailureReason(king, move.from, move.to);
    return plan;
  }
  Occupancy afterKing = plan.initialOccupancy;
  setOccupied(afterKing, move.from, false);
  setOccupied(afterKing, move.to, true);
  const ExternalTransferResult rook = planCastlePart(
      planner,
      context,
      afterKing,
      move,
      move.rookFrom,
      move.rookTo,
      {move.from});
  if (!rook.success()) {
    plan.status = MotionPlanStatus::NoSafeRoute;
    plan.blockedReason = routeFailureReason(rook, move.rookFrom, move.rookTo);
    return plan;
  }

  plan.strategy = king.mode == ExternalRouteMode::Lane || rook.mode == ExternalRouteMode::Lane
                      ? MotionStrategy::CastleLane
                      : rook.mode == ExternalRouteMode::LaneBoard
                            ? MotionStrategy::CastleLaneBoard
                            : MotionStrategy::CastleBoard;
  Occupancy occupancy = plan.initialOccupancy;
  appendTransferPhase(
      plan, MotionPhaseKind::CastleKing, move.from, move.to, king, occupancy);
  appendTransferPhase(
      plan, MotionPhaseKind::CastleRook, move.rookFrom, move.rookTo, rook, occupancy);
  finishPlan(plan, occupancy);
  return plan;
}

}  // namespace

MotionPlan OfflineMotionPlanner::planMove(
    const OfflineGame& game,
    std::string_view uci,
    const MotionPlanningContext& context) const {
  MoveInfo move;
  if (!game.describeLegalMove(uci, move)) {
    MotionPlan plan;
    plan.status = MotionPlanStatus::InvalidMove;
    plan.initialOccupancy = occupancyFromFen(game.fen());
    plan.finalExpectedOccupancy = plan.initialOccupancy;
    plan.blockedReason = "Move is not legal in the supplied game.";
    return plan;
  }
  OfflineExternalRoutePlanner planner;
  if (move.castling) return planCastle(planner, game, move, context);
  if (move.capture) return planCapture(planner, game, move, context);
  return planQuiet(planner, game, move, context);
}

const char* motionPlanStatusName(MotionPlanStatus status) {
  switch (status) {
    case MotionPlanStatus::Success: return "success";
    case MotionPlanStatus::InvalidMove: return "invalid_move";
    case MotionPlanStatus::UnsupportedPromotion: return "unsupported_promotion";
    case MotionPlanStatus::NoSafeRoute: return "no_safe_route";
    case MotionPlanStatus::NoGraveyardCapacity: return "no_graveyard_capacity";
    case MotionPlanStatus::NoGraveyardPath: return "no_graveyard_path";
    default: return "unknown";
  }
}

const char* motionStrategyName(MotionStrategy strategy) {
  switch (strategy) {
    case MotionStrategy::Quiet: return "quiet";
    case MotionStrategy::CaptureDirectAfterRemoval: return "capture-direct-after-removal";
    case MotionStrategy::CaptureStageFirstBoard: return "capture-stage-first-board";
    case MotionStrategy::CaptureRemoveFirstFallback: return "capture-remove-first-fallback";
    case MotionStrategy::CaptureRemoveFirstLane: return "capture-remove-first-lane";
    case MotionStrategy::CaptureRemoveFirstBoard: return "capture-remove-first-board";
    case MotionStrategy::CaptureBoardStaging: return "capture-board-staging";
    case MotionStrategy::CastleBoard: return "castle-board";
    case MotionStrategy::CastleLane: return "castle-lane";
    case MotionStrategy::CastleLaneBoard: return "castle-lane-board";
    default: return "unknown";
  }
}

const char* motionPhaseKindName(MotionPhaseKind kind) {
  switch (kind) {
    case MotionPhaseKind::QuietTransfer: return "quiet-transfer";
    case MotionPhaseKind::AttackerStage: return "attacker-stage";
    case MotionPhaseKind::CapturedRemoval: return "captured-removal";
    case MotionPhaseKind::AttackerFinal: return "attacker-final";
    case MotionPhaseKind::CastleKing: return "castle-king";
    case MotionPhaseKind::CastleRook: return "castle-rook";
    default: return "unknown";
  }
}

}  // namespace offline
