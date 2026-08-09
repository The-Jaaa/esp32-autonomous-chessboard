#include "../offline_core/offline_motion.h"

#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::MotionPhaseKind;
using offline::MotionPlan;
using offline::MotionPlanningContext;
using offline::Occupancy;
using offline::OfflineGame;
using offline::OfflineMotionPlanner;

constexpr const char* kStandardFen =
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
constexpr const char* kAfterF4Fen =
    "rnbqkbnr/pppppppp/8/8/5P2/8/PPPPP1PP/RNBQKBNR b KQkq - 0 1";

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

MotionPlan planMove(
    const std::string& fen,
    const std::string& uci) {
  OfflineGame game;
  require(game.loadFen(fen), "Could not load test position.");
  MotionPlanningContext context;
  const std::string beforeFen = game.fen();
  const MotionPlan plan = OfflineMotionPlanner{}.planMove(game, uci, context);
  require(game.fen() == beforeFen, uci + " mutated the source game.");
  return plan;
}

void assertClearance(
    const MotionPlan& plan,
    const std::string& id,
    const std::string& pawnFrom,
    const std::string& pawnTemp,
    const std::string& primaryPhase) {
  require(plan.success(), id + " did not produce a successful route.");
  require(plan.temporaryClearances.size() == 1,
          id + " did not expose exactly one clearance decision.");
  const auto& clearance = plan.temporaryClearances.front();
  std::ostringstream scores;
  for (const auto& score : clearance.candidateScores) {
    scores << ' ' << score.pawnFrom << '-' << score.pawnTemp << '='
           << score.totalCost << (score.preferred ? "*" : "");
  }
  require(clearance.pawnFrom == pawnFrom && clearance.pawnTemp == pawnTemp,
          id + " selected " + clearance.pawnFrom + "-" + clearance.pawnTemp +
              ", expected " + pawnFrom + "-" + pawnTemp +
              ". Scores:" + scores.str());
  require(clearance.originalPhase == primaryPhase,
          id + " recorded the wrong primary phase.");
  require(plan.phases.size() == 3,
          id + " must contain stage, primary, and restore phases.");
  require(plan.phases[0].kind == MotionPhaseKind::TemporaryClearanceStage &&
              plan.phases[1].kind == MotionPhaseKind::QuietTransfer &&
              plan.phases[2].kind == MotionPhaseKind::TemporaryClearanceRestore,
          id + " phase order is not stage, primary, restore.");
  require(plan.phases[0].physicalMove.has_value() &&
              plan.phases[0].physicalMove->from == pawnFrom &&
              plan.phases[0].physicalMove->to == pawnTemp,
          id + " stage phase does not carry the pawn move.");
  require(plan.phases[2].physicalMove.has_value() &&
              plan.phases[2].physicalMove->from == pawnTemp &&
              plan.phases[2].physicalMove->to == pawnFrom,
          id + " restore phase does not carry the pawn move.");
  Occupancy expected = plan.initialOccupancy;
  for (const auto& phase : plan.phases) {
    require(phase.expectedBefore == expected,
            id + " phase occupancy chain is broken.");
    expected = phase.expectedAfter;
  }
  require(expected == plan.finalExpectedOccupancy,
          id + " clearance changed the legal final occupancy.");
}

void assertNoClearance(const MotionPlan& plan, const std::string& id) {
  require(plan.success(), id + " did not produce a successful route.");
  require(plan.temporaryClearances.empty(),
          id + " unexpectedly relocated a pawn.");
  require(plan.phases.size() == 1 &&
              plan.phases.front().kind == MotionPhaseKind::QuietTransfer,
          id + " did not use one ordinary quiet phase.");
}

}  // namespace

int main() {
  try {
    const MotionPlan whiteKingside = planMove(kStandardFen, "g1f3");
    assertClearance(whiteKingside, "g1f3", "h2", "h4", "quiet-transfer");

    OfflineGame blackGame;
    require(blackGame.loadFen(kAfterF4Fen), "Could not load black clearance position.");
    const std::string beforeBlack = blackGame.fen();
    const MotionPlan blackKingside = OfflineMotionPlanner{}.planMove(
        blackGame, "g8f6", {});
    require(blackGame.fen() == beforeBlack,
            "g8f6 mutated the source game.");
    assertClearance(blackKingside, "g8f6", "h7", "h5", "quiet-transfer");

    const MotionPlan whiteQueenside = planMove(kStandardFen, "b1c3");
    assertClearance(whiteQueenside, "b1c3", "a2", "a4", "quiet-transfer");

    const MotionPlan directPawn = planMove(kStandardFen, "e2e4");
    assertNoClearance(directPawn, "e2e4");

    const MotionPlan repeat = planMove(kStandardFen, "g1f3");
    require(repeat.phases.size() == whiteKingside.phases.size() &&
                repeat.temporaryClearances.front().pawnFrom ==
                    whiteKingside.temporaryClearances.front().pawnFrom &&
                repeat.temporaryClearances.front().pawnTemp ==
                    whiteKingside.temporaryClearances.front().pawnTemp,
            "Repeated clearance planning was not deterministic.");

    std::cout << "offline temporary-clearance regressions passed" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline temporary-clearance regression failed: "
              << error.what() << std::endl;
    return 1;
  }
}
