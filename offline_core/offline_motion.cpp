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

struct TransferBundle {
  bool success = false;
  std::vector<MotionPhase> phases;
  std::vector<TemporaryClearanceMetadata> clearances;
  std::string blockedReason;
};

struct RemovalBundle {
  bool success = false;
  ExternalRouteStatus status = ExternalRouteStatus::InvalidRequest;
  std::vector<MotionPhase> phases;
  std::vector<TemporaryClearanceMetadata> clearances;
  std::optional<ExternalSlot> slot;
  std::vector<GraveyardRouteCandidate> candidates;
  std::string blockedReason;
};

ExternalRouteMode mapBoardMode(BoardRouteMode mode) {
  switch (mode) {
    case BoardRouteMode::Direct: return ExternalRouteMode::Direct;
    case BoardRouteMode::BoardDirect: return ExternalRouteMode::BoardDirect;
    case BoardRouteMode::BoardLine: return ExternalRouteMode::BoardLine;
    case BoardRouteMode::BoardBuffered: return ExternalRouteMode::BoardBuffered;
    case BoardRouteMode::BoardRelaxed: return ExternalRouteMode::BoardRelaxed;
  }
  return ExternalRouteMode::BoardDirect;
}

ExternalRouteTarget squareTargetFor(const std::string& square) {
  ExternalRouteTarget target;
  target.type = ExternalTargetType::Square;
  target.role = "board";
  target.square = square;
  target.rawIndex = squareToRawIndex(square);
  target.label = square;
  return target;
}

ExternalTransferResult planBoardOnlyTransfer(
    const MotionPlanningContext& context,
    const Occupancy& expected,
    const MoveInfo& move,
    const std::string& from,
    const std::string& to,
    std::vector<std::string> ignored) {
  BoardRouteRequest request;
  request.from = from;
  request.to = to;
  request.expectedOccupancy = expected;
  request.sensedOccupancy = context.sensedOccupancy;
  request.ignoredSquares = std::move(ignored);
  request.directWhenClear = simplePawnPush(move, from, to);
  request.preferClearLine = true;
  const BoardRouteResult board = OfflineBoardRoutePlanner{}.plan(request);

  ExternalTransferResult result;
  if (!board.success()) {
    result.status = board.status == BoardRouteStatus::InvalidRequest
                        ? ExternalRouteStatus::InvalidRequest
                        : ExternalRouteStatus::NoLanePath;
    result.blockedReason = board.blockedReason;
    return result;
  }
  result.status = ExternalRouteStatus::Success;
  result.mode = mapBoardMode(board.mode);
  result.routeCost = board.cost;
  result.rawPathSquares = board.rawPathSquares;
  result.compressedPathSquares = board.compressedPathSquares;
  for (std::size_t index = 1; index < board.compressedPathSquares.size(); ++index) {
    result.targets.push_back(squareTargetFor(board.compressedPathSquares[index]));
  }
  return result;
}

std::optional<Occupancy> moveSensedOccupancy(
    const std::optional<Occupancy>& sensed,
    const std::string& from,
    const std::string& to) {
  if (!sensed) return std::nullopt;
  Occupancy adjusted = *sensed;
  setOccupied(adjusted, from, false);
  setOccupied(adjusted, to, true);
  return adjusted;
}

MoveInfo syntheticPawnMove(
    const std::string& from,
    const std::string& to,
    char color) {
  MoveInfo move;
  move.uci = from + to;
  move.from = from;
  move.to = to;
  move.piece = color == 'w' ? "P" : "p";
  return move;
}

char pieceColor(const std::string& piece) {
  if (piece.empty()) return '\0';
  return std::isupper(static_cast<unsigned char>(piece.front())) ? 'w' : 'b';
}

std::vector<std::string> temporaryPawnSquares(
    const Occupancy& occupancy,
    const std::string& square,
    char color) {
  const int file = fileIndex(square);
  const int rank = rankNumber(square);
  const int direction = color == 'w' ? 1 : -1;
  const int startingRank = color == 'w' ? 2 : 7;
  std::vector<std::string> result;
  const std::string one = squareFromFileRank(file, rank + direction);
  if (!one.empty() && !occupied(occupancy, one)) {
    result.push_back(one);
    const std::string two = squareFromFileRank(file, rank + direction * 2);
    if (rank == startingRank && !two.empty() && !occupied(occupancy, two)) {
      result.push_back(two);
    }
  }
  return result;
}

void appendRouteMetadata(MotionPlan& plan, const ExternalTransferResult& route);
void appendRouteMetadata(MotionPlan& plan, const GraveyardRouteCandidate& route);

void appendBundleMetadata(
    MotionPlan& plan,
    const std::vector<MotionPhase>& phases,
    const std::vector<TemporaryClearanceMetadata>& clearances) {
  for (const MotionPhase& phase : phases) {
    if (phase.transfer) appendRouteMetadata(plan, *phase.transfer);
    if (phase.graveyard) appendRouteMetadata(plan, *phase.graveyard);
  }
  plan.temporaryClearances.insert(
      plan.temporaryClearances.end(), clearances.begin(), clearances.end());
}

TransferBundle planBoardTransferWithClearance(
    const OfflineExternalRoutePlanner& planner,
    const OfflineGame& game,
    const MoveInfo& move,
    MotionPhaseKind phaseKind,
    const MotionPlanningContext& context,
    const Occupancy& expected,
    const std::string& from,
    const std::string& to,
    const std::vector<std::string>& ignored,
    bool allowTemporaryClearance = true);

TransferBundle planBoardTransferWithoutClearance(
    const OfflineExternalRoutePlanner& planner,
    const OfflineGame& game,
    const MoveInfo& move,
    MotionPhaseKind phaseKind,
    const MotionPlanningContext& context,
    const Occupancy& expected,
    const std::string& from,
    const std::string& to,
    const std::vector<std::string>& ignored) {
  (void)game;
  TransferBundle result;
  const ExternalTransferResult route = planTransfer(
      planner, context, expected, move, from, to, ignored);
  if (!route.success()) {
    result.blockedReason = routeFailureReason(route, from, to);
    return result;
  }

  MotionPhase phase;
  phase.kind = phaseKind;
  phase.from = from;
  phase.to = to;
  phase.expectedBefore = expected;
  phase.expectedAfter = expected;
  setOccupied(phase.expectedAfter, from, false);
  setOccupied(phase.expectedAfter, to, true);
  phase.transfer = route;
  result.phases.push_back(std::move(phase));
  result.success = true;
  return result;
}

TransferBundle planBoardOnlyPhase(
    const MoveInfo& move,
    MotionPhaseKind phaseKind,
    const MotionPlanningContext& context,
    const Occupancy& expected,
    const std::string& from,
    const std::string& to,
    const std::vector<std::string>& ignored) {
  TransferBundle result;
  const ExternalTransferResult route = planBoardOnlyTransfer(
      context, expected, move, from, to, ignored);
  if (!route.success()) {
    result.blockedReason = routeFailureReason(route, from, to);
    return result;
  }

  MotionPhase phase;
  phase.kind = phaseKind;
  phase.from = from;
  phase.to = to;
  phase.expectedBefore = expected;
  phase.expectedAfter = expected;
  setOccupied(phase.expectedAfter, from, false);
  setOccupied(phase.expectedAfter, to, true);
  phase.transfer = route;
  phase.physicalMove = move;
  result.phases.push_back(std::move(phase));
  result.success = true;
  return result;
}

TransferBundle planBoardTransferWithClearance(
    const OfflineExternalRoutePlanner& planner,
    const OfflineGame& game,
    const MoveInfo& move,
    MotionPhaseKind phaseKind,
    const MotionPlanningContext& context,
    const Occupancy& expected,
    const std::string& from,
    const std::string& to,
    const std::vector<std::string>& ignored,
    bool allowTemporaryClearance) {
  TransferBundle direct = planBoardTransferWithoutClearance(
      planner, game, move, phaseKind, context, expected, from, to, ignored);
  if (direct.success || !allowTemporaryClearance) return direct;

  std::vector<std::string> reservedValues{from, to};
  reservedValues.insert(reservedValues.end(), ignored.begin(), ignored.end());
  const std::set<std::string> reserved(
      reservedValues.begin(), reservedValues.end());
  char movingColor = pieceColor(game.pieceAt(from));
  if (movingColor == '\0') movingColor = pieceColor(move.piece);
  if (movingColor == '\0') return direct;

  const std::string corner =
      (from == "b1" || to == "b1" || from == "b8" || to == "b8") ? "b" :
      (from == "g1" || to == "g1" || from == "g8" || to == "g8") ? "g" : "";
  const std::string preferredPawn = corner.empty()
      ? std::string{}
      : std::string{corner == "b" ? 'a' : 'h', movingColor == 'w' ? '2' : '7'};
  std::vector<TemporaryClearanceRejectedCandidate> rejected;
  struct Candidate {
    std::string pawnFrom;
    std::string pawnTemp;
    TransferBundle stage;
    TransferBundle primary;
    TransferBundle restore;
    TemporaryClearanceCandidateScore score;
  };
  std::vector<Candidate> candidates;

  for (const std::string& pawnFrom : game.occupiedSquares()) {
    if (reserved.count(pawnFrom) ||
        !samePieceType(game.pieceAt(pawnFrom), 'p') ||
        pieceColor(game.pieceAt(pawnFrom)) != movingColor) {
      continue;
    }
    for (const std::string& pawnTemp : temporaryPawnSquares(expected, pawnFrom, movingColor)) {
      if (reserved.count(pawnTemp)) continue;
      const MoveInfo pawnMove = syntheticPawnMove(pawnFrom, pawnTemp, movingColor);
      const TransferBundle stage = planBoardOnlyPhase(
          pawnMove, MotionPhaseKind::TemporaryClearanceStage, context, expected,
          pawnFrom, pawnTemp, {from, to});
      if (!stage.success) {
        rejected.push_back({pawnFrom, pawnTemp, stage.blockedReason});
        continue;
      }
      const Occupancy afterStage = stage.phases.back().expectedAfter;
      MotionPlanningContext stagedContext = context;
      stagedContext.sensedOccupancy = moveSensedOccupancy(
          context.sensedOccupancy, pawnFrom, pawnTemp);
      const TransferBundle primary = planBoardTransferWithClearance(
          planner, game, move, phaseKind, stagedContext, afterStage, from, to,
          ignored, false);
      if (!primary.success) {
        rejected.push_back({pawnFrom, pawnTemp, primary.blockedReason});
        continue;
      }
      const Occupancy afterPrimary = primary.phases.back().expectedAfter;
      const TransferBundle restore = planBoardOnlyPhase(
          syntheticPawnMove(pawnTemp, pawnFrom, movingColor),
          MotionPhaseKind::TemporaryClearanceRestore, stagedContext,
          afterPrimary, pawnTemp, pawnFrom, {from, to});
      if (!restore.success) {
        rejected.push_back({pawnFrom, pawnTemp, restore.blockedReason});
        continue;
      }
      const double totalCost = [&]() {
        double total = 0.0;
        for (const MotionPhase& phase : stage.phases) {
          if (phase.transfer) total += phase.transfer->routeCost;
        }
        for (const MotionPhase& phase : primary.phases) {
          if (phase.transfer) total += phase.transfer->routeCost;
        }
        for (const MotionPhase& phase : restore.phases) {
          if (phase.transfer) total += phase.transfer->routeCost;
        }
        return total;
      }();
      Candidate candidate;
      candidate.pawnFrom = pawnFrom;
      candidate.pawnTemp = pawnTemp;
      candidate.stage = stage;
      candidate.primary = primary;
      candidate.restore = restore;
      candidate.score = {pawnFrom, pawnTemp, totalCost, pawnFrom == preferredPawn};
      candidates.push_back(std::move(candidate));
    }
  }

  if (candidates.empty()) {
    direct.blockedReason += " No valid temporary pawn clearance was found.";
    return direct;
  }
  std::stable_sort(candidates.begin(), candidates.end(), [](const Candidate& left, const Candidate& right) {
    if (left.score.preferred != right.score.preferred) {
      return left.score.preferred;
    }
    if (std::abs(left.score.totalCost - right.score.totalCost) > 0.001) {
      return left.score.totalCost < right.score.totalCost;
    }
    return left.pawnFrom != right.pawnFrom
               ? left.pawnFrom < right.pawnFrom
               : left.pawnTemp < right.pawnTemp;
  });

  TransferBundle selected;
  const Candidate& best = candidates.front();
  selected.success = true;
  selected.phases.insert(selected.phases.end(), best.stage.phases.begin(), best.stage.phases.end());
  selected.phases.insert(selected.phases.end(), best.primary.phases.begin(), best.primary.phases.end());
  selected.phases.insert(selected.phases.end(), best.restore.phases.begin(), best.restore.phases.end());
  TemporaryClearanceMetadata metadata;
  metadata.pawnFrom = best.pawnFrom;
  metadata.pawnTemp = best.pawnTemp;
  metadata.movingColor = movingColor;
  metadata.originalPhase = motionPhaseKindName(phaseKind);
  metadata.originalBlockedReason = direct.blockedReason;
  for (const Candidate& candidate : candidates) metadata.candidateScores.push_back(candidate.score);
  metadata.rejectedCandidates = std::move(rejected);
  selected.clearances.push_back(std::move(metadata));
  return selected;
}

RemovalBundle planRemovalWithClearance(
    const OfflineExternalRoutePlanner& planner,
    const OfflineGame& game,
    const std::string& capturedSquare,
    char capturedColor,
    MotionPhaseKind phaseKind,
    const MotionPlanningContext& context,
    const Occupancy& expected,
    const std::vector<std::string>& ignored,
    bool allowTemporaryClearance = true);

RemovalBundle planRemovalWithClearance(
    const OfflineExternalRoutePlanner& planner,
    const OfflineGame& game,
    const std::string& capturedSquare,
    char capturedColor,
    MotionPhaseKind phaseKind,
    const MotionPlanningContext& context,
    const Occupancy& expected,
    const std::vector<std::string>& ignored,
    bool allowTemporaryClearance) {
  RemovalBundle result;
  const GraveyardRouteResult direct = planRemoval(
      planner, context, expected, capturedSquare, ignored);
  result.status = direct.status;
  if (direct.success()) {
    MotionPhase phase;
    phase.kind = phaseKind;
    phase.from = capturedSquare;
    phase.to = direct.selected->slot.label;
    phase.expectedBefore = expected;
    phase.expectedAfter = expected;
    setOccupied(phase.expectedAfter, capturedSquare, false);
    phase.graveyard = *direct.selected;
    result.success = true;
    result.status = ExternalRouteStatus::Success;
    result.phases.push_back(std::move(phase));
    result.slot = direct.selected->slot;
    result.candidates = direct.candidates;
    return result;
  }

  result.blockedReason = graveyardFailureReason(direct, capturedSquare);
  if (!allowTemporaryClearance ||
      direct.status == ExternalRouteStatus::NoGraveyardCapacity) {
    return result;
  }

  std::vector<std::string> reservedValues{capturedSquare};
  reservedValues.insert(reservedValues.end(), ignored.begin(), ignored.end());
  const std::set<std::string> reserved(
      reservedValues.begin(), reservedValues.end());
  struct Candidate {
    std::string pawnFrom;
    std::string pawnTemp;
    TransferBundle stage;
    GraveyardRouteResult removal;
    TransferBundle restore;
    TemporaryClearanceCandidateScore score;
  };
  std::vector<Candidate> candidates;
  std::vector<TemporaryClearanceRejectedCandidate> rejected;

  for (const std::string& pawnFrom : game.occupiedSquares()) {
    if (reserved.count(pawnFrom) ||
        !samePieceType(game.pieceAt(pawnFrom), 'p') ||
        pieceColor(game.pieceAt(pawnFrom)) != capturedColor) {
      continue;
    }
    for (const std::string& pawnTemp : temporaryPawnSquares(expected, pawnFrom, capturedColor)) {
      if (reserved.count(pawnTemp)) continue;
      const MoveInfo pawnMove = syntheticPawnMove(pawnFrom, pawnTemp, capturedColor);
      const TransferBundle stage = planBoardOnlyPhase(
          pawnMove, MotionPhaseKind::TemporaryClearanceStage, context, expected,
          pawnFrom, pawnTemp, {capturedSquare});
      if (!stage.success) {
        rejected.push_back({pawnFrom, pawnTemp, stage.blockedReason});
        continue;
      }
      const Occupancy afterStage = stage.phases.back().expectedAfter;
      MotionPlanningContext stagedContext = context;
      stagedContext.sensedOccupancy = moveSensedOccupancy(
          context.sensedOccupancy, pawnFrom, pawnTemp);
      std::vector<std::string> removalIgnored = ignored;
      removalIgnored.push_back(pawnFrom);
      removalIgnored.push_back(capturedSquare);
      const GraveyardRouteResult removal = planRemoval(
          planner, stagedContext, afterStage, capturedSquare,
          std::move(removalIgnored));
      if (!removal.success()) {
        rejected.push_back({
            pawnFrom, pawnTemp, graveyardFailureReason(removal, capturedSquare)});
        continue;
      }
      Occupancy afterRemoval = afterStage;
      setOccupied(afterRemoval, capturedSquare, false);
      const TransferBundle restore = planBoardOnlyPhase(
          syntheticPawnMove(pawnTemp, pawnFrom, capturedColor),
          MotionPhaseKind::TemporaryClearanceRestore, stagedContext,
          afterRemoval, pawnTemp, pawnFrom, {capturedSquare});
      if (!restore.success) {
        rejected.push_back({pawnFrom, pawnTemp, restore.blockedReason});
        continue;
      }
      double totalCost = removal.selected->routeCost;
      for (const MotionPhase& phase : stage.phases) {
        if (phase.transfer) totalCost += phase.transfer->routeCost;
      }
      for (const MotionPhase& phase : restore.phases) {
        if (phase.transfer) totalCost += phase.transfer->routeCost;
      }
      Candidate candidate;
      candidate.pawnFrom = pawnFrom;
      candidate.pawnTemp = pawnTemp;
      candidate.stage = stage;
      candidate.removal = removal;
      candidate.restore = restore;
      candidate.score = {pawnFrom, pawnTemp, totalCost, false};
      candidates.push_back(std::move(candidate));
    }
  }

  if (candidates.empty()) {
    result.blockedReason += " No valid temporary pawn clearance was found.";
    return result;
  }
  std::stable_sort(candidates.begin(), candidates.end(), [](const Candidate& left, const Candidate& right) {
    if (std::abs(left.score.totalCost - right.score.totalCost) > 0.001) {
      return left.score.totalCost < right.score.totalCost;
    }
    return left.pawnFrom != right.pawnFrom
               ? left.pawnFrom < right.pawnFrom
               : left.pawnTemp < right.pawnTemp;
  });

  const Candidate& best = candidates.front();
  result.success = true;
  result.slot = best.removal.selected->slot;
  result.candidates = best.removal.candidates;
  result.phases.insert(result.phases.end(), best.stage.phases.begin(), best.stage.phases.end());
  MotionPhase removal;
  removal.kind = phaseKind;
  removal.from = capturedSquare;
  removal.to = best.removal.selected->slot.label;
  removal.expectedBefore = best.stage.phases.back().expectedAfter;
  removal.expectedAfter = removal.expectedBefore;
  setOccupied(removal.expectedAfter, capturedSquare, false);
  removal.graveyard = *best.removal.selected;
  result.phases.push_back(std::move(removal));
  result.phases.insert(result.phases.end(), best.restore.phases.begin(), best.restore.phases.end());

  TemporaryClearanceMetadata metadata;
  metadata.pawnFrom = best.pawnFrom;
  metadata.pawnTemp = best.pawnTemp;
  metadata.movingColor = capturedColor;
  metadata.originalPhase = motionPhaseKindName(phaseKind);
  metadata.originalBlockedReason = result.blockedReason;
  for (const Candidate& candidate : candidates) metadata.candidateScores.push_back(candidate.score);
  metadata.rejectedCandidates = std::move(rejected);
  result.clearances.push_back(std::move(metadata));
  return result;
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
    plan.temporaryClearances.clear();
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
  const TransferBundle bundle = planBoardTransferWithClearance(
      planner, game, move, MotionPhaseKind::QuietTransfer, context,
      plan.initialOccupancy, move.from, move.to, {});
  if (!bundle.success) {
    plan.status = MotionPlanStatus::NoSafeRoute;
    plan.blockedReason = bundle.blockedReason;
    return plan;
  }
  Occupancy occupancy = plan.initialOccupancy;
  for (const MotionPhase& phase : bundle.phases) {
    plan.phases.push_back(phase);
    occupancy = phase.expectedAfter;
  }
  appendBundleMetadata(plan, bundle.phases, bundle.clearances);
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
  const char capturedColor = pieceColor(game.pieceAt(capturedSquare));
  if (capturedColor == '\0') {
    plan.status = MotionPlanStatus::NoSafeRoute;
    plan.blockedReason = "Capture metadata does not identify the captured piece.";
    return plan;
  }

  const RemovalBundle directRemoval = planRemovalWithClearance(
      planner, game, capturedSquare, capturedColor, MotionPhaseKind::CapturedRemoval,
      context, initial, {capturedSquare}, false);

  if (directRemoval.success) {
    const Occupancy afterRemoval = directRemoval.phases.back().expectedAfter;
    const TransferBundle attacker = planBoardTransferWithoutClearance(
        planner, game, move, MotionPhaseKind::AttackerFinal, context, afterRemoval,
        move.from, move.to, {capturedSquare, move.to});
    if (attacker.success) {
      plan.strategy = MotionStrategy::CaptureDirectAfterRemoval;
      plan.proposedGraveyardSlot = directRemoval.slot;
      plan.graveyardCandidates = directRemoval.candidates;
      for (const MotionPhase& phase : directRemoval.phases) plan.phases.push_back(phase);
      for (const MotionPhase& phase : attacker.phases) plan.phases.push_back(phase);
      appendBundleMetadata(plan, directRemoval.phases, directRemoval.clearances);
      appendBundleMetadata(plan, attacker.phases, attacker.clearances);
      Occupancy occupancy = plan.phases.back().expectedAfter;
      finishPlan(plan, occupancy);
      return plan;
    }
    plan.rejectedStrategies.push_back({
        MotionStrategy::CaptureDirectAfterRemoval, {}, attacker.blockedReason});
  } else {
    plan.rejectedStrategies.push_back({
        MotionStrategy::CaptureDirectAfterRemoval, {}, directRemoval.blockedReason});
  }

  const std::vector<std::string> candidates = stagingCandidates(initial, move);
  const RemovalBundle stagedRemovalForCandidates = planRemovalWithClearance(
      planner, game, capturedSquare, capturedColor, MotionPhaseKind::CapturedRemoval,
      context, initial, {move.from, capturedSquare}, false);
  const std::set<std::string> stagedRemovalPath = [&]() {
    std::set<std::string> path;
    for (const MotionPhase& phase : stagedRemovalForCandidates.phases) {
      if (phase.graveyard) {
        path.insert(phase.graveyard->rawPathSquares.begin(),
                    phase.graveyard->rawPathSquares.end());
      }
    }
    return path;
  }();
  for (const std::string& candidate : candidates) {
    if (stagedRemovalPath.count(candidate) > 0) continue;
    const TransferBundle approach = planBoardTransferWithoutClearance(
        planner, game, move, MotionPhaseKind::AttackerStage, context, initial,
        move.from, candidate, {});
    if (!approach.success) {
      plan.rejectedStrategies.push_back({
          MotionStrategy::CaptureStageFirstBoard, candidate, approach.blockedReason});
      continue;
    }
    const Occupancy afterApproach = approach.phases.back().expectedAfter;
    const RemovalBundle removal = planRemovalWithClearance(
        planner, game, capturedSquare, capturedColor, MotionPhaseKind::CapturedRemoval,
        context, afterApproach, {move.from, candidate, capturedSquare}, false);
    if (!removal.success) {
      plan.rejectedStrategies.push_back({
          MotionStrategy::CaptureStageFirstBoard, candidate, removal.blockedReason});
      continue;
    }
    const Occupancy afterRemoval = removal.phases.back().expectedAfter;
    MoveInfo stagedMove = move;
    stagedMove.from = candidate;
    stagedMove.uci = candidate + move.to + move.promotion;
    const TransferBundle final = planBoardTransferWithoutClearance(
        planner, game, stagedMove, MotionPhaseKind::AttackerFinal, context,
        afterRemoval, candidate, move.to, {move.from, capturedSquare, move.to});
    if (!final.success) {
      plan.rejectedStrategies.push_back({
          MotionStrategy::CaptureStageFirstBoard, candidate, final.blockedReason});
      continue;
    }

    plan.strategy = MotionStrategy::CaptureStageFirstBoard;
    plan.stagingSquare = candidate;
    plan.proposedGraveyardSlot = removal.slot;
    plan.graveyardCandidates = removal.candidates;
    for (const MotionPhase& phase : approach.phases) plan.phases.push_back(phase);
    for (const MotionPhase& phase : removal.phases) plan.phases.push_back(phase);
    for (const MotionPhase& phase : final.phases) plan.phases.push_back(phase);
    appendBundleMetadata(plan, approach.phases, approach.clearances);
    appendBundleMetadata(plan, removal.phases, removal.clearances);
    appendBundleMetadata(plan, final.phases, final.clearances);
    finishPlan(plan, plan.phases.back().expectedAfter);
    return plan;
  }

  RemovalBundle fallbackRemoval = directRemoval.success
      ? directRemoval
      : planRemovalWithClearance(
            planner, game, capturedSquare, capturedColor,
            MotionPhaseKind::CapturedRemoval, context, initial,
            {move.from, capturedSquare}, false);
  if (!fallbackRemoval.success &&
      fallbackRemoval.status != ExternalRouteStatus::NoGraveyardCapacity) {
    fallbackRemoval = planRemovalWithClearance(
        planner, game, capturedSquare, capturedColor,
        MotionPhaseKind::CapturedRemoval, context, initial,
        {move.from, capturedSquare}, true);
  }
  if (!fallbackRemoval.success) {
    plan.status = fallbackRemoval.status == ExternalRouteStatus::NoGraveyardCapacity
                      ? MotionPlanStatus::NoGraveyardCapacity
                      : MotionPlanStatus::NoGraveyardPath;
    plan.blockedReason = fallbackRemoval.blockedReason;
    return plan;
  }

  const Occupancy afterRemoval = fallbackRemoval.phases.back().expectedAfter;
  const TransferBundle fallbackAttacker = planBoardTransferWithoutClearance(
      planner, game, move, MotionPhaseKind::AttackerFinal, context, afterRemoval,
      move.from, move.to, {capturedSquare, move.to});
  if (fallbackAttacker.success) {
    ExternalRouteMode mode = ExternalRouteMode::BoardDirect;
    for (const MotionPhase& phase : fallbackAttacker.phases) {
      if (phase.kind == MotionPhaseKind::AttackerFinal && phase.transfer) {
        mode = phase.transfer->mode;
      }
    }
    plan.strategy = mode == ExternalRouteMode::Lane
                       ? MotionStrategy::CaptureRemoveFirstLane
                       : MotionStrategy::CaptureRemoveFirstBoard;
    plan.proposedGraveyardSlot = fallbackRemoval.slot;
    plan.graveyardCandidates = fallbackRemoval.candidates;
    for (const MotionPhase& phase : fallbackRemoval.phases) plan.phases.push_back(phase);
    for (const MotionPhase& phase : fallbackAttacker.phases) plan.phases.push_back(phase);
    appendBundleMetadata(plan, fallbackRemoval.phases, fallbackRemoval.clearances);
    appendBundleMetadata(plan, fallbackAttacker.phases, fallbackAttacker.clearances);
    finishPlan(plan, plan.phases.back().expectedAfter);
    return plan;
  }
  plan.rejectedStrategies.push_back({
      MotionStrategy::CaptureRemoveFirstFallback, {}, fallbackAttacker.blockedReason});

  if (fallbackRemoval.success) {
    const TransferBundle clearedAttacker = planBoardTransferWithClearance(
        planner, game, move, MotionPhaseKind::AttackerFinal, context, afterRemoval,
        move.from, move.to, {capturedSquare, move.to});
    if (clearedAttacker.success) {
      ExternalRouteMode mode = ExternalRouteMode::BoardDirect;
      for (const MotionPhase& phase : clearedAttacker.phases) {
        if (phase.kind == MotionPhaseKind::AttackerFinal && phase.transfer) {
          mode = phase.transfer->mode;
        }
      }
      plan.strategy = mode == ExternalRouteMode::Lane
                         ? MotionStrategy::CaptureRemoveFirstLane
                         : MotionStrategy::CaptureRemoveFirstBoard;
      plan.proposedGraveyardSlot = fallbackRemoval.slot;
      plan.graveyardCandidates = fallbackRemoval.candidates;
      for (const MotionPhase& phase : fallbackRemoval.phases) plan.phases.push_back(phase);
      for (const MotionPhase& phase : clearedAttacker.phases) plan.phases.push_back(phase);
      appendBundleMetadata(plan, fallbackRemoval.phases, fallbackRemoval.clearances);
      appendBundleMetadata(plan, clearedAttacker.phases, clearedAttacker.clearances);
      finishPlan(plan, plan.phases.back().expectedAfter);
      return plan;
    }
  }
  plan.status = MotionPlanStatus::NoSafeRoute;
  plan.blockedReason = "No safe capture route was found for " + move.uci + ".";
  return plan;
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

  const TransferBundle king = planBoardTransferWithClearance(
      planner, game, move, MotionPhaseKind::CastleKing, context,
      plan.initialOccupancy, move.from, move.to, {});
  if (!king.success) {
    plan.status = MotionPlanStatus::NoSafeRoute;
    plan.blockedReason = king.blockedReason;
    return plan;
  }
  const Occupancy afterKing = king.phases.back().expectedAfter;
  MoveInfo rookMove = move;
  rookMove.uci = move.rookFrom + move.rookTo;
  rookMove.from = move.rookFrom;
  rookMove.to = move.rookTo;
  rookMove.piece = game.pieceAt(move.rookFrom);
  rookMove.capture = false;
  rookMove.enPassant = false;
  rookMove.castling = false;
  const TransferBundle rook = planBoardTransferWithClearance(
      planner, game, rookMove, MotionPhaseKind::CastleRook, context, afterKing,
      move.rookFrom, move.rookTo, {move.from});
  if (!rook.success) {
    plan.status = MotionPlanStatus::NoSafeRoute;
    plan.blockedReason = rook.blockedReason;
    return plan;
  }

  ExternalRouteMode kingMode = ExternalRouteMode::BoardDirect;
  ExternalRouteMode rookMode = ExternalRouteMode::BoardDirect;
  for (const MotionPhase& phase : king.phases) {
    if (phase.kind == MotionPhaseKind::CastleKing && phase.transfer) kingMode = phase.transfer->mode;
  }
  for (const MotionPhase& phase : rook.phases) {
    if (phase.kind == MotionPhaseKind::CastleRook && phase.transfer) rookMode = phase.transfer->mode;
  }
  plan.strategy = kingMode == ExternalRouteMode::Lane || rookMode == ExternalRouteMode::Lane
                      ? MotionStrategy::CastleLane
                      : kingMode == ExternalRouteMode::LaneBoard || rookMode == ExternalRouteMode::LaneBoard
                            ? MotionStrategy::CastleLaneBoard
                            : MotionStrategy::CastleBoard;
  for (const MotionPhase& phase : king.phases) plan.phases.push_back(phase);
  for (const MotionPhase& phase : rook.phases) plan.phases.push_back(phase);
  appendBundleMetadata(plan, king.phases, king.clearances);
  appendBundleMetadata(plan, rook.phases, rook.clearances);
  finishPlan(plan, plan.phases.back().expectedAfter);
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
    case MotionPhaseKind::TemporaryClearanceStage: return "temporary-clearance-stage";
    case MotionPhaseKind::TemporaryClearanceRestore: return "temporary-clearance-restore";
    default: return "unknown";
  }
}

}  // namespace offline
