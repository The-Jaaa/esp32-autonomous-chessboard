#include "../offline_core/offline_game.h"

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

bool contains(const std::vector<std::string>& values, const std::string& value) {
  return std::find(values.begin(), values.end(), value) != values.end();
}

std::uint64_t perft(chess::Board& board, int depth) {
  if (depth == 0) return 1;
  chess::Movelist moves;
  chess::movegen::legalmoves(moves, board);
  if (depth == 1) return moves.size();

  std::uint64_t nodes = 0;
  for (const chess::Move move : moves) {
    board.makeMove(move);
    nodes += perft(board, depth - 1);
    board.unmakeMove(move);
  }
  return nodes;
}

std::vector<std::string> splitMoves(const std::string& value) {
  std::vector<std::string> moves;
  std::stringstream stream(value);
  for (std::string move; std::getline(stream, move, ',');) {
    if (!move.empty()) moves.push_back(move);
  }
  std::sort(moves.begin(), moves.end());
  return moves;
}

void verifyParityFixtures(const std::string& path) {
  std::ifstream input(path);
  require(input.good(), "Unable to open legal-move parity fixture file.");

  std::string line;
  int checked = 0;
  while (std::getline(input, line)) {
    if (line.empty()) continue;
    const std::size_t firstTab = line.find('\t');
    const std::size_t secondTab = line.find('\t', firstTab + 1);
    require(firstTab != std::string::npos && secondTab != std::string::npos, "Malformed parity fixture line.");

    const std::string label = line.substr(0, firstTab);
    const std::string fen = line.substr(firstTab + 1, secondTab - firstTab - 1);
    const std::vector<std::string> expected = splitMoves(line.substr(secondTab + 1));

    offline::OfflineGame game;
    require(game.loadFen(fen), label + ": C++ rules rejected fixture FEN.");
    require(game.legalMovesUci() == expected, label + ": legal UCI moves differ from chess.js.");
    checked++;
  }
  require(checked >= 8, "Expected at least eight legal-move parity fixtures.");
}

void verifyPerft() {
  chess::Board start;
  const std::uint64_t expected[] = {1, 20, 400, 8902, 197281};
  for (int depth = 1; depth <= 4; ++depth) {
    require(perft(start, depth) == expected[depth], "Starting-position perft mismatch at depth " + std::to_string(depth));
  }

  chess::Board kiwipete("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1");
  require(perft(kiwipete, 1) == 48, "Kiwipete perft mismatch at depth 1.");
  require(perft(kiwipete, 2) == 2039, "Kiwipete perft mismatch at depth 2.");
  require(perft(kiwipete, 3) == 97862, "Kiwipete perft mismatch at depth 3.");
}

void verifyMoveApplicationAndUndo() {
  offline::OfflineGame game;
  const std::string original = game.fen();
  require(game.sideToMove() == 'w', "White must move from the starting position.");
  require(game.legalMovesUci().size() == 20, "Starting position must have 20 legal moves.");

  offline::MoveInfo move;
  require(game.applyUci("e2e4", move), "e2e4 should be legal.");
  require(move.uci == "e2e4" && move.san == "e4", "e2e4 metadata is incorrect.");
  require(move.from == "e2" && move.to == "e4" && move.piece == "P", "e2e4 source metadata is incorrect.");
  require(!move.capture && !move.castling && !move.enPassant, "e2e4 must be a quiet move.");
  require(game.sideToMove() == 'b', "Black must move after e2e4.");
  require(game.undo(), "Undo should restore e2e4.");
  require(game.fen() == original, "Undo must restore the exact starting FEN.");
  require(!game.undo(), "Undo with empty history must fail.");

  const std::string beforeIllegal = game.fen();
  require(!game.applyUci("e2e5", move), "Illegal e2e5 must be rejected.");
  require(!game.applyUci("bad", move), "Malformed UCI must be rejected.");
  require(game.fen() == beforeIllegal, "Rejected moves must not mutate the game.");
  require(!game.loadFen("not a fen"), "Malformed FEN must be rejected.");
  require(game.fen() == beforeIllegal, "Rejected FEN must not mutate the game.");

  require(game.loadFen("4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1"), "Capture FEN should load.");
  require(game.applyUci("e4d5", move), "e4d5 capture should be legal.");
  require(move.capture && !move.enPassant, "e4d5 must be an ordinary capture.");
  require(move.capturedSquare == "d5" && move.capturedPiece == "p", "Ordinary capture metadata is incorrect.");
}

void verifyCastling() {
  offline::OfflineGame game;
  require(game.loadFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"), "Castling FEN should load.");
  require(contains(game.legalMovesUci(), "e1g1"), "White kingside castling should be legal.");

  offline::MoveInfo castle;
  require(game.applyUci("e1g1", castle), "White kingside castling should apply.");
  require(castle.san == "O-O" && castle.castling, "Castling SAN/type metadata is incorrect.");
  require(castle.rookFrom == "h1" && castle.rookTo == "f1", "Castling rook metadata is incorrect.");

  require(game.loadFen("r3k2r/8/8/8/8/8/8/R3KB1R w KQkq - 0 1"), "Blocked castling FEN should load.");
  require(!contains(game.legalMovesUci(), "e1g1"), "A piece on f1 must block castling.");

  require(game.loadFen("r3kr1r/8/8/8/8/8/8/R3K2R w KQ - 0 1"), "Attacked castling FEN should load.");
  require(!contains(game.legalMovesUci(), "e1g1"), "Castling through attacked f1 must be illegal.");
}

void verifyEnPassant() {
  offline::OfflineGame game;
  require(game.loadFen("8/8/8/3pP3/8/8/8/4K2k w - d6 0 1"), "En-passant FEN should load.");
  offline::MoveInfo move;
  require(game.applyUci("e5d6", move), "e5d6 en passant should be legal.");
  require(move.capture && move.enPassant, "En passant must be marked as a capture.");
  require(move.capturedSquare == "d5" && move.capturedPiece == "p", "En-passant capture metadata is incorrect.");
  require(move.san.rfind("exd6", 0) == 0, "En-passant SAN is incorrect.");

  require(game.loadFen("8/8/8/3pP3/8/8/8/4K2k w - - 0 1"), "No-en-passant FEN should load.");
  require(!game.applyUci("e5d6", move), "En passant without an en-passant square must be illegal.");
}

void verifyPromotions() {
  const std::string fen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
  for (const char piece : std::string("qrbn")) {
    offline::OfflineGame game;
    require(game.loadFen(fen), "Promotion FEN should load.");
    offline::MoveInfo move;
    const std::string uci = std::string("a7a8") + piece;
    require(game.applyUci(uci, move), uci + " should be legal.");
    require(move.promotion == std::string(1, piece), uci + " promotion metadata is incorrect.");
    require(move.san.find("a8=") == 0, uci + " SAN must describe promotion.");
  }

  offline::OfflineGame game;
  require(game.loadFen(fen), "Promotion FEN should reload.");
  const std::string original = game.fen();
  offline::MoveInfo move;
  require(!game.applyUci("a7a8x", move), "Invalid promotion piece must be rejected.");
  require(game.fen() == original, "Invalid promotion must not mutate the board.");
}

void verifyGameOutcomes() {
  offline::OfflineGame game;
  require(game.loadFen("4k3/8/8/8/8/8/4r3/4K3 w - - 0 1"), "Check FEN should load.");
  require(game.inCheck() && game.status().outcome == offline::GameOutcome::Ongoing, "Check must not be treated as game over.");

  require(game.loadFen("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1"), "Checkmate FEN should load.");
  require(game.status().outcome == offline::GameOutcome::Checkmate && game.status().inCheck, "Checkmate status is incorrect.");

  require(game.loadFen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"), "Stalemate FEN should load.");
  require(game.status().outcome == offline::GameOutcome::Stalemate && !game.status().inCheck, "Stalemate status is incorrect.");

  require(game.loadFen("8/8/8/8/8/8/5k2/7K w - - 0 1"), "Insufficient-material FEN should load.");
  require(game.status().outcome == offline::GameOutcome::InsufficientMaterial, "Insufficient-material status is incorrect.");

  require(game.loadFen("8/8/8/8/8/8/5k2/R6K w - - 100 51"), "Fifty-move FEN should load.");
  require(game.status().outcome == offline::GameOutcome::FiftyMoveDraw, "Fifty-move status is incorrect.");

  game.reset();
  offline::MoveInfo move;
  const std::string repetition[] = {"g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"};
  for (const std::string& uci : repetition) require(game.applyUci(uci, move), "Repetition move failed: " + uci);
  require(game.status().outcome == offline::GameOutcome::ThreefoldRepetition, "Threefold-repetition status is incorrect.");
}

}  // namespace

int main(int argc, char** argv) {
  try {
    require(argc == 2, "Usage: offline_chess_rules_host <parity-fixtures.tsv>");
    verifyParityFixtures(argv[1]);
    verifyPerft();
    verifyMoveApplicationAndUndo();
    verifyCastling();
    verifyEnPassant();
    verifyPromotions();
    verifyGameOutcomes();
    std::cout << "offline chess rules regressions passed" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline chess rules regression failed: " << error.what() << std::endl;
    return 1;
  }
}
