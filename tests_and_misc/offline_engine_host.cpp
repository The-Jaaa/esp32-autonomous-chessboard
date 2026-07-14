#include "../offline_core/offline_engine.h"

#include <algorithm>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

offline::SearchLimits fixedDepth(int depth, bool useTable = true) {
  offline::SearchLimits limits;
  limits.timeLimitMs = 0;
  limits.maxNodes = 0;
  limits.maxDepth = depth;
  limits.useTranspositionTable = useTable;
  return limits;
}

bool containsMove(const std::vector<offline::RootMoveScore>& moves, const std::string& uci) {
  return std::any_of(moves.begin(), moves.end(), [&](const offline::RootMoveScore& move) {
    return move.uci == uci;
  });
}

void requireLegal(const std::string& fen, const offline::SearchResult& result) {
  offline::OfflineGame game;
  require(game.loadFen(fen), "Legality fixture FEN must load.");
  const std::vector<std::string> legal = game.legalMovesUci();
  require(std::find(legal.begin(), legal.end(), result.bestMove) != legal.end(),
          "Engine returned illegal move " + result.bestMove);
}

void verifyInvalidAndTerminalPositions() {
  offline::OfflineEngine engine;
  offline::SearchResult result = engine.searchFen("not a fen", fixedDepth(2));
  require(!result.hasMove() && result.stopReason == offline::SearchStopReason::InvalidFen,
          "Invalid FEN must be rejected without a move.");

  result = engine.searchFen("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1", fixedDepth(2));
  require(!result.hasMove() && result.stopReason == offline::SearchStopReason::TerminalPosition &&
              result.outcome == offline::GameOutcome::Checkmate,
          "Checkmate position must return terminal checkmate.");

  result = engine.searchFen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", fixedDepth(2));
  require(!result.hasMove() && result.outcome == offline::GameOutcome::Stalemate,
          "Stalemate position must return terminal stalemate.");

  result = engine.searchFen("8/8/8/8/8/8/5k2/7K w - - 0 1", fixedDepth(2));
  require(!result.hasMove() && result.outcome == offline::GameOutcome::InsufficientMaterial,
          "Insufficient-material position must return terminal draw.");

  result = engine.searchFen("8/8/8/8/8/8/5k2/R6K w - - 100 51", fixedDepth(2));
  require(!result.hasMove() && result.outcome == offline::GameOutcome::FiftyMoveDraw,
          "Fifty-move position must return terminal draw.");
}

void verifyLegalityAndDeterminism() {
  const std::vector<std::string> corpus = {
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
      "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
      "8/8/8/3pP3/8/8/8/4K2k w - d6 0 1",
      "4k3/P7/8/8/8/8/8/4K3 w - - 0 1",
      "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 1"};

  offline::OfflineEngine engine;
  for (const std::string& fen : corpus) {
    const offline::SearchResult first = engine.searchFen(fen, fixedDepth(3));
    const offline::SearchResult second = engine.searchFen(fen, fixedDepth(3));
    require(first.hasMove(), "Nonterminal corpus position must return a move.");
    requireLegal(fen, first);
    require(first.bestMove == second.bestMove && first.score == second.score &&
                first.completedDepth == second.completedDepth && first.principalVariation == second.principalVariation,
            "Fixed-depth search must be deterministic.");
    require(first.completedDepth == 3 && first.stopReason == offline::SearchStopReason::DepthLimit,
            "Fixed-depth search must complete its requested depth.");
    require(!first.principalVariation.empty() && first.principalVariation.front() == first.bestMove,
            "Principal variation must begin with the selected move.");
    require(!first.rankedRootMoves.empty() && first.rankedRootMoves.front().uci == first.bestMove,
            "Ranked root moves must begin with the selected move.");
  }
}

void verifyTacticsAndMateDistance() {
  offline::OfflineEngine engine;
  const std::string queenCapture = "4k3/8/8/8/3q4/8/3R4/4K3 w - - 0 1";
  offline::SearchResult result = engine.searchFen(queenCapture, fixedDepth(3));
  require(result.bestMove == "d2d4", "Engine must take an undefended queen.");

  const std::string inCheck = "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1";
  result = engine.searchFen(inCheck, fixedDepth(3));
  requireLegal(inCheck, result);

  const std::string mateInOne = "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1";
  const offline::SearchResult mateOne = engine.searchFen(mateInOne, fixedDepth(3));
  require(mateOne.hasMove() && mateOne.mateIn == 1 && mateOne.stopReason == offline::SearchStopReason::Complete,
          "Engine must identify and complete mate in one.");

  const offline::SearchResult mateAtFiftyMoveBoundary = engine.searchFen(
      "7k/5Q2/6K1/8/8/8/8/8 w - - 99 50", fixedDepth(3));
  require(mateAtFiftyMoveBoundary.mateIn == 1,
          "Checkmate must take precedence when a quiet mating move reaches the fifty-move boundary.");

  const std::string mateInTwo = "8/8/8/Q7/8/7k/8/5K2 w - - 0 1";
  const offline::SearchResult mateTwo = engine.searchFen(mateInTwo, fixedDepth(5));
  require(mateTwo.hasMove() && mateTwo.mateIn == 2 && mateTwo.stopReason == offline::SearchStopReason::Complete,
          "Engine must identify a forced mate in two.");
  require(mateOne.score > mateTwo.score, "Mate scoring must prefer the faster checkmate.");

  const std::string forcedLoss = "8/8/8/8/3K4/8/k7/6Q1 b - - 0 1";
  const offline::SearchResult losing = engine.searchFen(forcedLoss, fixedDepth(7));
  require(losing.bestMove == "a2b2" && losing.mateIn == -4,
          "Engine must choose the line that delays unavoidable checkmate.");
  require(std::any_of(losing.rankedRootMoves.begin(), losing.rankedRootMoves.end(),
                      [](const offline::RootMoveScore& move) { return move.mateIn == -3; }),
          "Forced-loss fixture must include a faster losing alternative.");
}

void verifySpecialMovesAndPromotions() {
  offline::OfflineEngine engine;
  offline::SearchResult result = engine.searchFen(
      "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", fixedDepth(2));
  require(containsMove(result.rankedRootMoves, "e1g1") && containsMove(result.rankedRootMoves, "e1c1"),
          "Root candidates must include both legal castling moves.");

  result = engine.searchFen("8/8/8/3pP3/8/8/8/4K2k w - d6 0 1", fixedDepth(2));
  require(containsMove(result.rankedRootMoves, "e5d6"), "Root candidates must include legal en passant.");

  result = engine.searchFen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", fixedDepth(3));
  require(result.bestMove == "a7a8q", "Material evaluation must prefer queen promotion.");
  require(containsMove(result.rankedRootMoves, "a7a8r") && containsMove(result.rankedRootMoves, "a7a8b") &&
              containsMove(result.rankedRootMoves, "a7a8n"),
          "Root candidates must retain all four promotion choices.");
}

void verifyTranspositionAgreement() {
  const std::string fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
  offline::OfflineEngine engine;
  const offline::SearchResult withTable = engine.searchFen(fen, fixedDepth(4, true));
  const offline::SearchResult withoutTable = engine.searchFen(fen, fixedDepth(4, false));
  require(withTable.bestMove == withoutTable.bestMove && withTable.score == withoutTable.score,
          "Transposition table must not change fixed-depth result.");
}

void verifyNodeAndTimeLimits() {
  const std::string start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  offline::OfflineEngine engine;

  offline::SearchLimits nodeLimits = fixedDepth(12);
  nodeLimits.maxNodes = 2000;
  offline::SearchResult result = engine.searchFen(start, nodeLimits);
  require(result.hasMove() && result.stopReason == offline::SearchStopReason::NodeLimit && result.nodes <= 2000,
          "Node-limited search must return a legal fallback or completed-depth move.");
  requireLegal(start, result);

  offline::SearchLimits timeLimits;
  timeLimits.timeLimitMs = 3000;
  timeLimits.maxDepth = 12;
  const auto started = std::chrono::steady_clock::now();
  result = engine.searchFen(start, timeLimits);
  const auto wallMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count();
  require(result.hasMove() && result.stopReason == offline::SearchStopReason::TimeLimit,
          "Three-second search must stop on its deadline with a move.");
  require(result.completedDepth >= 1, "Three-second search must preserve at least one completed depth.");
  require(wallMs <= 3100 && result.elapsedMs <= 3100,
          "Three-second search exceeded the 100 ms deadline tolerance.");
  requireLegal(start, result);
  std::cout << "benchmark three-second-start: move=" << result.bestMove
            << " depth=" << result.completedDepth << " nodes=" << result.nodes
            << " elapsed_ms=" << result.elapsedMs << " roots=";
  for (std::size_t index = 0; index < std::min<std::size_t>(5, result.rankedRootMoves.size()); ++index) {
    std::cout << result.rankedRootMoves[index].uci << ':' << result.rankedRootMoves[index].score << ' ';
  }
  std::cout << std::endl;
}

void reportBenchmarks() {
  const std::vector<std::pair<std::string, std::string>> corpus = {
      {"start", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"},
      {"kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"},
      {"middlegame", "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 1"}};

  offline::SearchLimits limits;
  limits.timeLimitMs = 150;
  limits.maxDepth = 12;
  offline::OfflineEngine engine;
  for (const auto& [label, fen] : corpus) {
    const offline::SearchResult result = engine.searchFen(fen, limits);
    std::cout << "benchmark " << label << ": move=" << result.bestMove
              << " depth=" << result.completedDepth << " nodes=" << result.nodes
              << " elapsed_ms=" << result.elapsedMs << " pv=";
    for (const std::string& move : result.principalVariation) std::cout << move << ' ';
    std::cout << std::endl;
  }
}

}  // namespace

int main() {
  try {
    verifyInvalidAndTerminalPositions();
    verifyLegalityAndDeterminism();
    verifyTacticsAndMateDistance();
    verifySpecialMovesAndPromotions();
    verifyTranspositionAgreement();
    verifyNodeAndTimeLimits();
    reportBenchmarks();
    std::cout << "offline engine regressions passed" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "offline engine regression failed: " << error.what() << std::endl;
    return 1;
  }
}
