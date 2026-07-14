#include "../offline_core/offline_physical.h"

#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using offline::HumanColor;
using offline::Occupancy;
using offline::OfflinePhysicalController;
using offline::PhysicalEvent;
using offline::PhysicalPhase;
using offline::SnapshotResult;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

bool contains(const std::vector<std::string>& values, const std::string& value) {
  return std::find(values.begin(), values.end(), value) != values.end();
}

void place(Occupancy& occupancy, const std::string& square, bool occupied) {
  const int index = offline::squareToRawIndex(square);
  require(index >= 0, "Invalid test square: " + square);
  occupancy[static_cast<std::size_t>(index)] = occupied;
}

SnapshotResult snapshot(OfflinePhysicalController& controller, const Occupancy& occupancy) {
  return controller.processSnapshot(occupancy);
}

void requireAccepted(const SnapshotResult& result, const std::string& uci) {
  require(result.event == PhysicalEvent::MoveAccepted, uci + ": move was not accepted.");
  require(result.acceptedMove.has_value(), uci + ": accepted move metadata is missing.");
  require(result.acceptedMove->uci == uci, uci + ": accepted UCI metadata is incorrect.");
}

void verifyMappingAndOccupancy() {
  for (int block = 0; block < 8; ++block) {
    const char file = static_cast<char>('h' - block);
    for (int offset = 0; offset < 8; ++offset) {
      const int rank = block % 2 == 0 ? 8 - offset : 1 + offset;
      const int index = block * 8 + offset;
      const std::string square{file, static_cast<char>('0' + rank)};
      require(offline::rawIndexToSquare(index) == square, "Raw index mapping mismatch at " + std::to_string(index));
      require(offline::squareToRawIndex(square) == index, "Square mapping mismatch at " + square);
    }
  }
  require(offline::rawIndexToSquare(64).empty(), "Out-of-range raw index must be rejected.");
  require(offline::squareToRawIndex("i1") == -1, "Off-board square must be rejected.");

  OfflinePhysicalController controller;
  const Occupancy& start = controller.committedOccupancy();
  int occupied = 0;
  for (int index = 0; index < 64; ++index) {
    const std::string square = offline::rawIndexToSquare(index);
    const bool expected = square[1] == '1' || square[1] == '2' || square[1] == '7' || square[1] == '8';
    require(start[static_cast<std::size_t>(index)] == expected, "Starting occupancy mismatch at " + square);
    if (start[static_cast<std::size_t>(index)]) ++occupied;
  }
  require(occupied == 32, "Starting occupancy must contain 32 pieces.");
}

void verifyQuietMovesAndColors() {
  OfflinePhysicalController white(HumanColor::White);
  Occupancy board = white.committedOccupancy();
  require(white.phase() == PhysicalPhase::Ready, "White controller must start ready.");

  place(board, "e2", false);
  SnapshotResult result = snapshot(white, board);
  require(result.phase == PhysicalPhase::PieceLifted && result.event == PhysicalEvent::PieceLifted,
          "White e2 lift must arm a move.");
  require(contains(result.legalTargets, "e3") && contains(result.legalTargets, "e4"),
          "White pawn legal targets are incomplete.");
  result = snapshot(white, board);
  require(result.event == PhysicalEvent::None && result.phase == PhysicalPhase::PieceLifted,
          "Duplicate lift snapshot must be idempotent.");

  place(board, "e2", true);
  result = snapshot(white, board);
  require(result.event == PhysicalEvent::MoveCancelled && result.phase == PhysicalPhase::Ready,
          "Returning a lifted piece must cancel cleanly.");

  place(board, "e2", false);
  snapshot(white, board);
  place(board, "e4", true);
  result = snapshot(white, board);
  requireAccepted(result, "e2e4");
  require(result.phase == PhysicalPhase::WaitingForOpponent, "Accepted human move must wait for opponent.");
  require(white.game().fen() == "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
          "e2e4 resulting FEN is incorrect.");
  result = snapshot(white, board);
  require(result.event == PhysicalEvent::None && !result.acceptedMove,
          "Final move snapshot must not commit twice.");

  OfflinePhysicalController black(HumanColor::Black);
  require(black.phase() == PhysicalPhase::WaitingForOpponent, "Black controller must wait in the starting position.");
  Occupancy waiting = black.committedOccupancy();
  place(waiting, "e2", false);
  result = snapshot(black, waiting);
  require(result.phase == PhysicalPhase::SyncWarning && result.event == PhysicalEvent::RestoreRequired,
          "Movement while waiting for the opponent must warn.");
  place(waiting, "e2", true);
  require(snapshot(black, waiting).phase == PhysicalPhase::WaitingForOpponent,
          "Restoring the board must return Black to waiting.");

  require(black.loadFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"),
          "Black-to-move FEN must load.");
  board = black.committedOccupancy();
  place(board, "e7", false);
  result = snapshot(black, board);
  require(result.phase == PhysicalPhase::PieceLifted && contains(result.legalTargets, "e5"),
          "Black e7 lift must arm e5.");
  place(board, "e5", true);
  requireAccepted(snapshot(black, board), "e7e5");

  OfflinePhysicalController wrongColor(HumanColor::White);
  board = wrongColor.committedOccupancy();
  place(board, "e7", false);
  result = snapshot(wrongColor, board);
  require(result.phase == PhysicalPhase::SyncWarning, "Lifting an opponent piece must warn.");
  place(board, "e7", true);
  require(snapshot(wrongColor, board).phase == PhysicalPhase::Ready, "Wrong-color warning must clear on restore.");
}

void verifyWarningsAndRecovery() {
  OfflinePhysicalController controller;
  require(controller.loadFen("4k3/8/8/8/8/8/P7/RP2K3 w - - 0 1"), "No-legal-move FEN must load.");
  Occupancy board = controller.committedOccupancy();
  place(board, "a1", false);
  SnapshotResult result = snapshot(controller, board);
  require(result.phase == PhysicalPhase::SyncWarning && result.event == PhysicalEvent::RestoreRequired,
          "A no-legal-move lift must warn.");
  require(contains(result.diff.missing, "a1"), "No-legal-move warning must identify the missing square.");
  place(board, "a1", true);
  require(snapshot(controller, board).phase == PhysicalPhase::Ready, "No-legal-move warning must recover.");

  controller.reset();
  board = controller.committedOccupancy();
  place(board, "e2", false);
  snapshot(controller, board);
  place(board, "e5", true);
  result = snapshot(controller, board);
  require(result.phase == PhysicalPhase::SyncWarning && contains(result.diff.extra, "e5"),
          "Illegal destination must enter sync warning with extra square.");
  place(board, "e5", false);
  place(board, "e2", true);
  require(snapshot(controller, board).phase == PhysicalPhase::Ready, "Illegal destination warning must recover.");

  place(board, "e2", false);
  place(board, "d2", false);
  result = snapshot(controller, board);
  require(result.phase == PhysicalPhase::SyncWarning && result.diff.missing.size() == 2,
          "Multi-piece disturbance must enter sync warning.");
  place(board, "e2", true);
  place(board, "d2", true);
  require(snapshot(controller, board).phase == PhysicalPhase::Ready, "Multi-piece warning must recover.");
}

void verifyOrdinaryCapture() {
  const std::string fen = "4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1";
  OfflinePhysicalController controller;
  require(controller.loadFen(fen), "Capture FEN must load.");
  Occupancy board = controller.committedOccupancy();
  place(board, "e4", false);
  SnapshotResult result = snapshot(controller, board);
  require(result.phase == PhysicalPhase::PieceLifted && contains(result.legalTargets, "d5"),
          "Capture target must be armed.");
  place(board, "d5", false);
  result = snapshot(controller, board);
  require(result.phase == PhysicalPhase::CapturePending && result.event == PhysicalEvent::CaptureTargetRemoved,
          "Removing the victim must enter capture pending.");
  place(board, "d5", true);
  result = snapshot(controller, board);
  requireAccepted(result, "e4d5");
  require(result.acceptedMove->capture && result.acceptedMove->capturedSquare == "d5",
          "Capture metadata is incorrect.");

  require(controller.loadFen(fen), "Capture FEN must reload for cancellation.");
  board = controller.committedOccupancy();
  place(board, "e4", false);
  snapshot(controller, board);
  place(board, "d5", false);
  snapshot(controller, board);
  place(board, "e4", true);
  place(board, "d5", true);
  result = snapshot(controller, board);
  require(result.event == PhysicalEvent::MoveCancelled && result.phase == PhysicalPhase::Ready,
          "Restoring both capture pieces must cancel.");
  require(controller.game().fen() == fen, "Cancelled capture must not mutate the game.");

  place(board, "e4", false);
  snapshot(controller, board);
  place(board, "d5", false);
  snapshot(controller, board);
  place(board, "e4", true);
  result = snapshot(controller, board);
  require(result.phase == PhysicalPhase::SyncWarning, "Incomplete capture restoration must warn.");
  place(board, "d5", true);
  require(snapshot(controller, board).phase == PhysicalPhase::Ready,
          "Incomplete capture warning must clear after full restoration.");
}

void verifyEnPassant() {
  OfflinePhysicalController controller;
  require(controller.loadFen("8/8/8/3pP3/8/8/8/4K2k w - d6 0 1"), "En-passant FEN must load.");
  Occupancy board = controller.committedOccupancy();
  place(board, "e5", false);
  snapshot(controller, board);
  place(board, "d5", false);
  SnapshotResult result = snapshot(controller, board);
  require(result.phase == PhysicalPhase::CapturePending, "En-passant victim removal must enter capture pending.");
  place(board, "d6", true);
  result = snapshot(controller, board);
  requireAccepted(result, "e5d6");
  require(result.acceptedMove->enPassant && result.acceptedMove->capturedSquare == "d5",
          "En-passant metadata is incorrect.");
}

void performCastle(const std::string& fen, const std::string& kingFrom, const std::string& kingTo,
                   const std::string& rookFrom, const std::string& rookTo, const std::string& uci) {
  OfflinePhysicalController controller;
  require(controller.loadFen(fen), uci + ": castling FEN must load.");
  Occupancy board = controller.committedOccupancy();
  place(board, kingFrom, false);
  snapshot(controller, board);
  place(board, kingTo, true);
  SnapshotResult result = snapshot(controller, board);
  require(result.phase == PhysicalPhase::CastlePendingRook && result.event == PhysicalEvent::RookRequired,
          uci + ": king placement must wait for rook.");
  require(!result.acceptedMove, uci + ": castling must not commit before rook placement.");
  place(board, rookFrom, false);
  result = snapshot(controller, board);
  require(result.phase == PhysicalPhase::CastlePendingRook, uci + ": rook lift must remain pending.");
  place(board, rookTo, true);
  result = snapshot(controller, board);
  requireAccepted(result, uci);
  require(result.acceptedMove->castling && result.acceptedMove->rookFrom == rookFrom &&
              result.acceptedMove->rookTo == rookTo,
          uci + ": castling metadata is incorrect.");
}

void verifyCastling() {
  const std::string fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
  performCastle(fen, "e1", "g1", "h1", "f1", "e1g1");
  performCastle(fen, "e1", "c1", "a1", "d1", "e1c1");

  OfflinePhysicalController controller;
  require(controller.loadFen(fen), "Castling cancellation FEN must load.");
  Occupancy board = controller.committedOccupancy();
  place(board, "e1", false);
  snapshot(controller, board);
  place(board, "g1", true);
  require(snapshot(controller, board).phase == PhysicalPhase::CastlePendingRook,
          "Castling cancellation must first enter rook wait.");
  place(board, "g1", false);
  place(board, "e1", true);
  SnapshotResult result = snapshot(controller, board);
  require(result.phase == PhysicalPhase::Ready && result.event == PhysicalEvent::MoveCancelled,
          "Returning the king must cancel castling.");
  require(controller.game().fen() == fen, "Cancelled castling must not mutate the game.");
}

void verifyPromotionChoice(const std::string& fen, const std::string& from, const std::string& to,
                           const std::string& captureSquare, char piece) {
  OfflinePhysicalController controller;
  require(controller.loadFen(fen), "Promotion FEN must load.");
  const std::string originalFen = controller.game().fen();
  Occupancy board = controller.committedOccupancy();
  place(board, from, false);
  snapshot(controller, board);
  if (!captureSquare.empty()) {
    place(board, captureSquare, false);
    require(snapshot(controller, board).phase == PhysicalPhase::CapturePending,
            "Capture promotion must observe victim removal.");
  }
  place(board, to, true);
  SnapshotResult result = snapshot(controller, board);
  require(result.phase == PhysicalPhase::PromotionPending && result.event == PhysicalEvent::PromotionChoiceRequired,
          "Promotion placement must wait for an explicit choice.");
  require(controller.game().fen() == originalFen, "Promotion must not commit before confirmation.");

  result = controller.confirmPromotion('x');
  require(result.phase == PhysicalPhase::PromotionPending && result.event == PhysicalEvent::InvalidPromotionChoice,
          "Invalid promotion choice must be rejected without leaving pending state.");
  require(controller.game().fen() == originalFen, "Invalid promotion choice must not mutate the game.");

  result = controller.confirmPromotion(piece);
  const std::string uci = from + to + piece;
  requireAccepted(result, uci);
  require(result.acceptedMove->promotion == std::string(1, piece), "Promotion metadata is incorrect for " + uci);
  require(!result.acceptedMove->san.empty() && result.acceptedMove->san.find('=') != std::string::npos,
          "Promotion SAN is missing for " + uci);
}

void verifyPromotions() {
  for (const char piece : std::string("qrbn")) {
    verifyPromotionChoice("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7", "a8", "", piece);
    verifyPromotionChoice("1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7", "b8", "b8", piece);
  }

  OfflinePhysicalController controller;
  SnapshotResult result = controller.confirmPromotion('q');
  require(result.event == PhysicalEvent::InvalidPromotionChoice,
          "Promotion confirmation without a pending move must be rejected.");
}

void verifyCheckmateOutcome() {
  OfflinePhysicalController checkController;
  require(checkController.loadFen("4k3/8/8/8/1Q6/8/8/4K3 w - - 0 1"), "Check-move FEN must load.");
  Occupancy checkBoard = checkController.committedOccupancy();
  place(checkBoard, "b4", false);
  snapshot(checkController, checkBoard);
  place(checkBoard, "b5", true);
  SnapshotResult checkResult = snapshot(checkController, checkBoard);
  requireAccepted(checkResult, "b4b5");
  require(checkController.game().status().inCheck &&
              checkController.game().status().outcome == offline::GameOutcome::Ongoing,
          "Accepted physical checking move must expose check without ending the game.");
  require(checkResult.acceptedMove->san.find('+') != std::string::npos, "Checking SAN must contain +.");

  OfflinePhysicalController controller;
  require(controller.loadFen("7k/5Q2/6K1/8/8/8/8/8 w - - 0 1"), "Mate-in-one FEN must load.");
  Occupancy board = controller.committedOccupancy();
  place(board, "f7", false);
  SnapshotResult lifted = snapshot(controller, board);
  require(contains(lifted.legalTargets, "g7"), "Mate-in-one target g7 must be legal.");
  place(board, "g7", true);
  SnapshotResult result = snapshot(controller, board);
  requireAccepted(result, "f7g7");
  require(controller.game().status().outcome == offline::GameOutcome::Checkmate,
          "Accepted physical move must expose checkmate outcome.");
  require(result.acceptedMove->san.find('#') != std::string::npos, "Checkmate SAN must contain #.");
}

}  // namespace

int main() {
  try {
    verifyMappingAndOccupancy();
    verifyQuietMovesAndColors();
    verifyWarningsAndRecovery();
    verifyOrdinaryCapture();
    verifyEnPassant();
    verifyCastling();
    verifyPromotions();
    verifyCheckmateOutcome();
    std::cout << "offline physical interpreter regressions passed" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline physical interpreter regression failed: " << error.what() << std::endl;
    return 1;
  }
}
