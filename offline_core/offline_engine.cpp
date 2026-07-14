#include "offline_engine.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <utility>

namespace offline {
namespace {

constexpr int kInfinity = 31000;
constexpr int kMateScore = 30000;
constexpr int kMateThreshold = 29000;
constexpr int kMaximumPly = 64;
constexpr int kQuiescenceDepth = 8;
constexpr std::size_t kTranspositionEntries = 4096;
constexpr std::uint64_t kTimeCheckMask = 63;

constexpr std::array<std::int8_t, 64> kPawnSquareTable = {
     0,  0,   0,   0,   0,   0,  0,  0,
     5, 10,  10, -20, -20,  10, 10,  5,
     5, -5, -10,   0,   0, -10, -5,  5,
     0,  0,   0,  20,  20,   0,  0,  0,
     5,  5,  10,  25,  25,  10,  5,  5,
    10, 10,  20,  30,  30,  20, 10, 10,
    50, 50,  50,  50,  50,  50, 50, 50,
     0,  0,   0,   0,   0,   0,  0,  0};

enum class Bound : std::uint8_t { Empty, Exact, Lower, Upper };

struct TranspositionEntry {
  std::uint64_t key = 0;
  std::int16_t score = 0;
  std::uint16_t move = 0;
  std::int8_t depth = -1;
  Bound bound = Bound::Empty;
  std::uint8_t generation = 0;
  std::uint8_t padding = 0;
};

static_assert(sizeof(TranspositionEntry) == 16, "Transposition entry must remain 16 bytes.");
static_assert(sizeof(TranspositionEntry) * kTranspositionEntries == 64 * 1024,
              "Transposition table must remain capped at 64 KiB.");

struct RootIteration {
  bool completed = false;
  chess::Move bestMove = chess::Move::NO_MOVE;
  int bestScore = -kInfinity;
  std::vector<RootMoveScore> candidates;
  std::vector<std::string> principalVariation;
};

int pieceValue(chess::PieceType type) {
  switch (type.internal()) {
    case chess::PieceType::underlying::PAWN: return 100;
    case chess::PieceType::underlying::KNIGHT: return 320;
    case chess::PieceType::underlying::BISHOP: return 330;
    case chess::PieceType::underlying::ROOK: return 500;
    case chess::PieceType::underlying::QUEEN: return 900;
    case chess::PieceType::underlying::KING:
    case chess::PieceType::underlying::NONE:
    default: return 0;
  }
}

int mateDistance(int score) {
  if (score >= kMateThreshold) return (kMateScore - score + 1) / 2;
  if (score <= -kMateThreshold) return -((kMateScore + score + 1) / 2);
  return 0;
}

std::uint32_t uciLexicalKey(const chess::Move move) {
  const int fromFile = static_cast<int>(move.from().file());
  const int fromRank = static_cast<int>(move.from().rank());
  const int toFile = static_cast<int>(move.to().file());
  const int toRank = static_cast<int>(move.to().rank());
  int promotionOrder = 0;
  if (move.typeOf() == chess::Move::PROMOTION) {
    switch (move.promotionType().internal()) {
      case chess::PieceType::underlying::BISHOP: promotionOrder = 1; break;
      case chess::PieceType::underlying::KNIGHT: promotionOrder = 2; break;
      case chess::PieceType::underlying::QUEEN: promotionOrder = 3; break;
      case chess::PieceType::underlying::ROOK: promotionOrder = 4; break;
      default: break;
    }
  }
  return static_cast<std::uint32_t>(((((fromFile * 8 + fromRank) * 8 + toFile) * 8 + toRank) * 5) +
                                    promotionOrder);
}

GameOutcome mapOutcome(chess::GameResultReason reason) {
  switch (reason) {
    case chess::GameResultReason::CHECKMATE: return GameOutcome::Checkmate;
    case chess::GameResultReason::STALEMATE: return GameOutcome::Stalemate;
    case chess::GameResultReason::INSUFFICIENT_MATERIAL: return GameOutcome::InsufficientMaterial;
    case chess::GameResultReason::FIFTY_MOVE_RULE: return GameOutcome::FiftyMoveDraw;
    case chess::GameResultReason::THREEFOLD_REPETITION: return GameOutcome::ThreefoldRepetition;
    case chess::GameResultReason::NONE:
    default: return GameOutcome::Ongoing;
  }
}

bool isSearchDraw(const chess::Board& board) {
  if (board.isInsufficientMaterial() || board.isRepetition(1)) return true;
  if (!board.isHalfMoveDraw()) return false;
  return board.getHalfMoveDrawType().first != chess::GameResultReason::CHECKMATE;
}

int centerBonus(const chess::Square square) {
  const int fileDistance = std::abs(static_cast<int>(square.file()) * 2 - 7);
  const int rankDistance = std::abs(static_cast<int>(square.rank()) * 2 - 7);
  return 14 - fileDistance - rankDistance;
}

int colorPositionScore(const chess::Board& board, chess::Color color, bool endgame) {
  int score = 0;
  int bishops = 0;

  for (int index = 0; index < 64; ++index) {
    const chess::Square square(index);
    const chess::Piece piece = board.at(square);
    if (piece == chess::Piece::NONE || piece.color() != color) continue;

    const chess::PieceType type = piece.type();
    const int file = static_cast<int>(square.file());
    const int rank = static_cast<int>(square.rank());
    const int relativeRank = color == chess::Color::WHITE ? rank : 7 - rank;
    const int center = centerBonus(square);
    score += pieceValue(type);

    switch (type.internal()) {
      case chess::PieceType::underlying::PAWN:
        score += kPawnSquareTable[static_cast<std::size_t>(file + relativeRank * 8)];
        break;
      case chess::PieceType::underlying::KNIGHT:
        score += center * 4;
        score += static_cast<int>((chess::attacks::knight(square) & ~board.us(color)).count()) * 4;
        break;
      case chess::PieceType::underlying::BISHOP:
        score += center * 3;
        score += static_cast<int>((chess::attacks::bishop(square, board.occ()) & ~board.us(color)).count()) * 3;
        ++bishops;
        break;
      case chess::PieceType::underlying::ROOK:
        if (relativeRank == 6) score += 20;
        score += static_cast<int>((chess::attacks::rook(square, board.occ()) & ~board.us(color)).count()) * 2;
        break;
      case chess::PieceType::underlying::QUEEN:
        score += center;
        score += static_cast<int>((chess::attacks::queen(square, board.occ()) & ~board.us(color)).count());
        break;
      case chess::PieceType::underlying::KING: {
        if (endgame) {
          score += center * 3;
          break;
        }
        const bool onBackRank = relativeRank == 0;
        if (onBackRank && (file == 2 || file == 6)) score += 35;
        score -= center * 2;

        const int shieldRank = color == chess::Color::WHITE ? rank + 1 : rank - 1;
        if (shieldRank >= 0 && shieldRank < 8) {
          for (int shieldFile = std::max(0, file - 1); shieldFile <= std::min(7, file + 1); ++shieldFile) {
            const chess::Piece shield = board.at(chess::Square(shieldFile + shieldRank * 8));
            if (shield != chess::Piece::NONE && shield.color() == color && shield.type() == chess::PieceType::PAWN) {
              score += 10;
            }
          }
        }
        break;
      }
      case chess::PieceType::underlying::NONE:
      default:
        break;
    }
  }

  if (bishops >= 2) score += 30;
  return score;
}

int evaluate(const chess::Board& board) {
  int nonPawnMaterial = 0;
  for (const chess::PieceType type : {chess::PieceType(chess::PieceType::KNIGHT),
                                      chess::PieceType(chess::PieceType::BISHOP),
                                      chess::PieceType(chess::PieceType::ROOK),
                                      chess::PieceType(chess::PieceType::QUEEN)}) {
    nonPawnMaterial += pieceValue(type) * static_cast<int>(board.pieces(type).count());
  }
  const bool endgame = nonPawnMaterial <= 2600;
  const int whiteScore = colorPositionScore(board, chess::Color::WHITE, endgame);
  const int blackScore = colorPositionScore(board, chess::Color::BLACK, endgame);
  const int whitePerspective = whiteScore - blackScore;
  return board.sideToMove() == chess::Color::WHITE ? whitePerspective : -whitePerspective;
}

int scoreToTable(int score, int ply) {
  if (score >= kMateThreshold) return score + ply;
  if (score <= -kMateThreshold) return score - ply;
  return score;
}

int scoreFromTable(int score, int ply) {
  if (score >= kMateThreshold) return score - ply;
  if (score <= -kMateThreshold) return score + ply;
  return score;
}

struct SearchContext {
  explicit SearchContext(const SearchLimits& requested)
      : limits(requested), start(std::chrono::steady_clock::now()), deadline(start) {
    if (limits.maxDepth < 1) limits.maxDepth = 1;
    if (limits.maxDepth >= kMaximumPly) limits.maxDepth = kMaximumPly - 1;
    if (limits.timeLimitMs > 0) deadline = start + std::chrono::milliseconds(limits.timeLimitMs);
  }

  SearchLimits limits;
  std::chrono::steady_clock::time_point start;
  std::chrono::steady_clock::time_point deadline;
  std::uint64_t nodes = 0;
  bool aborted = false;
  SearchStopReason abortReason = SearchStopReason::DepthLimit;
  std::uint8_t generation = 1;
  std::array<TranspositionEntry, kTranspositionEntries> table{};
  std::array<chess::Movelist, kMaximumPly> moveLists{};
  std::array<std::array<std::uint16_t, 2>, kMaximumPly> killers{};
  std::array<std::array<std::array<std::int16_t, 64>, 64>, 2> history{};
  std::array<std::array<std::uint16_t, kMaximumPly>, kMaximumPly> principalVariation{};
  std::array<int, kMaximumPly> principalVariationLength{};

  bool shouldStop(bool forceClockCheck = false) {
    if (aborted) return true;
    if (limits.maxNodes > 0 && nodes >= limits.maxNodes) {
      aborted = true;
      abortReason = SearchStopReason::NodeLimit;
      return true;
    }
    if (limits.timeLimitMs > 0 && (forceClockCheck || (nodes & kTimeCheckMask) == 0) &&
        std::chrono::steady_clock::now() >= deadline) {
      aborted = true;
      abortReason = SearchStopReason::TimeLimit;
      return true;
    }
    return false;
  }

  bool touchNode() {
    ++nodes;
    return !shouldStop();
  }

  TranspositionEntry& tableEntry(std::uint64_t key) {
    return table[static_cast<std::size_t>(key) & (kTranspositionEntries - 1)];
  }
};

void updatePrincipalVariation(SearchContext& context, int ply, chess::Move move) {
  context.principalVariation[ply][ply] = move.move();
  const int childLength = ply + 1 < kMaximumPly ? context.principalVariationLength[ply + 1] : ply + 1;
  for (int next = ply + 1; next < childLength && next < kMaximumPly; ++next) {
    context.principalVariation[ply][next] = context.principalVariation[ply + 1][next];
  }
  context.principalVariationLength[ply] = std::max(ply + 1, childLength);
}

int moveOrderingScore(const SearchContext& context, const chess::Board& board, chess::Move move,
                      std::uint16_t tableMove, int ply) {
  if (move.move() == tableMove && tableMove != 0) return 30000;

  int score = 0;
  if (move.typeOf() == chess::Move::PROMOTION) score += 21000 + pieceValue(move.promotionType());
  if (board.isCapture(move)) {
    const int victim = pieceValue(board.getCapturing<chess::PieceType>(move));
    const int attacker = pieceValue(board.at<chess::PieceType>(move.from()));
    score += 15000 + victim * 8 - attacker;
  } else if (ply < kMaximumPly) {
    if (context.killers[ply][0] == move.move()) score += 12000;
    else if (context.killers[ply][1] == move.move()) score += 11000;
    const int color = static_cast<int>(board.sideToMove());
    score += context.history[color][move.from().index()][move.to().index()];
  }
  return std::min(score, 29999);
}

void orderMoves(SearchContext& context, const chess::Board& board, chess::Movelist& moves,
                std::uint16_t tableMove, int ply) {
  for (chess::Move& move : moves) {
    move.setScore(static_cast<std::int16_t>(moveOrderingScore(context, board, move, tableMove, ply)));
  }
  std::sort(moves.begin(), moves.end(), [](const chess::Move left, const chess::Move right) {
    if (left.score() != right.score()) return left.score() > right.score();
    return uciLexicalKey(left) < uciLexicalKey(right);
  });
}

void recordQuietCutoff(SearchContext& context, const chess::Board& board, chess::Move move, int depth, int ply) {
  if (ply < kMaximumPly) {
    if (context.killers[ply][0] != move.move()) {
      context.killers[ply][1] = context.killers[ply][0];
      context.killers[ply][0] = move.move();
    }
  }
  const int color = static_cast<int>(board.sideToMove());
  std::int16_t& value = context.history[color][move.from().index()][move.to().index()];
  value = static_cast<std::int16_t>(std::min(10000, static_cast<int>(value) + depth * depth));
}

int quiescence(SearchContext& context, chess::Board& board, int alpha, int beta, int ply, int remainingDepth);

int negamax(SearchContext& context, chess::Board& board, int depth, int alpha, int beta, int ply) {
  context.principalVariationLength[ply] = ply;
  if (depth <= 0) return quiescence(context, board, alpha, beta, ply, kQuiescenceDepth);
  if (ply >= kMaximumPly - 1) return evaluate(board);
  if (!context.touchNode()) return 0;
  if (isSearchDraw(board)) return 0;

  const int originalAlpha = alpha;
  const std::uint64_t key = board.hash();
  std::uint16_t tableMove = 0;
  if (context.limits.useTranspositionTable) {
    const TranspositionEntry& entry = context.tableEntry(key);
    if (entry.bound != Bound::Empty && entry.key == key) {
      tableMove = entry.move;
      if (entry.depth >= depth) {
        const int tableScore = scoreFromTable(entry.score, ply);
        if (entry.bound == Bound::Exact) {
          if (entry.move != 0) {
            if (ply + 1 < kMaximumPly) context.principalVariationLength[ply + 1] = ply + 1;
            updatePrincipalVariation(context, ply, chess::Move(entry.move));
          }
          return tableScore;
        }
        if (entry.bound == Bound::Lower) alpha = std::max(alpha, tableScore);
        else if (entry.bound == Bound::Upper) beta = std::min(beta, tableScore);
        if (alpha >= beta) return tableScore;
      }
    }
  }

  chess::Movelist& moves = context.moveLists[ply];
  chess::movegen::legalmoves(moves, board);
  if (moves.empty()) return board.inCheck() ? -kMateScore + ply : 0;
  orderMoves(context, board, moves, tableMove, ply);

  int bestScore = -kInfinity;
  chess::Move bestMove = chess::Move::NO_MOVE;
  for (const chess::Move move : moves) {
    if (context.shouldStop()) return 0;
    const bool quiet = !board.isCapture(move) && move.typeOf() != chess::Move::PROMOTION;
    board.makeMove(move);
    const int score = -negamax(context, board, depth - 1, -beta, -alpha, ply + 1);
    board.unmakeMove(move);
    if (context.aborted) return 0;

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
      updatePrincipalVariation(context, ply, move);
    }
    alpha = std::max(alpha, score);
    if (alpha >= beta) {
      if (quiet) recordQuietCutoff(context, board, move, depth, ply);
      break;
    }
  }

  if (context.limits.useTranspositionTable && !context.aborted) {
    TranspositionEntry& entry = context.tableEntry(key);
    if (entry.bound == Bound::Empty || entry.key != key || depth >= entry.depth || entry.generation != context.generation) {
      entry.key = key;
      entry.score = static_cast<std::int16_t>(scoreToTable(bestScore, ply));
      entry.move = bestMove.move();
      entry.depth = static_cast<std::int8_t>(depth);
      entry.bound = bestScore <= originalAlpha ? Bound::Upper : (bestScore >= beta ? Bound::Lower : Bound::Exact);
      entry.generation = context.generation;
    }
  }
  return bestScore;
}

int quiescence(SearchContext& context, chess::Board& board, int alpha, int beta, int ply, int remainingDepth) {
  context.principalVariationLength[ply] = ply;
  if (ply >= kMaximumPly - 1) return evaluate(board);
  if (!context.touchNode()) return 0;
  if (isSearchDraw(board)) return 0;

  const bool inCheck = board.inCheck();
  if (remainingDepth <= 0 && !inCheck) return evaluate(board);
  if (remainingDepth <= -2) return evaluate(board);

  if (!inCheck) {
    const int standing = evaluate(board);
    if (standing >= beta) return standing;
    alpha = std::max(alpha, standing);
  }

  chess::Movelist& moves = context.moveLists[ply];
  chess::movegen::legalmoves(moves, board);
  if (moves.empty()) return inCheck ? -kMateScore + ply : 0;

  if (!inCheck) {
    chess::Movelist tactical;
    for (const chess::Move move : moves) {
      if (board.isCapture(move) || move.typeOf() == chess::Move::PROMOTION) tactical.add(move);
    }
    moves = tactical;
    if (moves.empty()) return alpha;
  }

  orderMoves(context, board, moves, 0, ply);
  for (const chess::Move move : moves) {
    if (context.shouldStop()) return 0;
    board.makeMove(move);
    const int score = -quiescence(context, board, -beta, -alpha, ply + 1, remainingDepth - 1);
    board.unmakeMove(move);
    if (context.aborted) return 0;
    if (score > alpha) {
      alpha = score;
      updatePrincipalVariation(context, ply, move);
    }
    if (score >= beta) return score;
  }
  return alpha;
}

RootIteration searchRoot(SearchContext& context, chess::Board& board, int depth) {
  RootIteration iteration;
  context.principalVariationLength[0] = 0;
  if (context.shouldStop(true)) return iteration;

  const std::uint64_t key = board.hash();
  std::uint16_t tableMove = 0;
  if (context.limits.useTranspositionTable) {
    const TranspositionEntry& entry = context.tableEntry(key);
    if (entry.bound != Bound::Empty && entry.key == key) tableMove = entry.move;
  }

  chess::Movelist& moves = context.moveLists[0];
  chess::movegen::legalmoves(moves, board);
  orderMoves(context, board, moves, tableMove, 0);

  for (const chess::Move move : moves) {
    if (context.shouldStop(true)) return iteration;
    board.makeMove(move);
    const int score = -negamax(context, board, depth - 1, -kInfinity, kInfinity, 1);
    board.unmakeMove(move);
    if (context.aborted) return iteration;

    iteration.candidates.push_back({chess::uci::moveToUci(move), score, mateDistance(score)});
    if (score > iteration.bestScore ||
        (score == iteration.bestScore &&
         (iteration.bestMove == chess::Move::NO_MOVE || uciLexicalKey(move) < uciLexicalKey(iteration.bestMove)))) {
      iteration.bestScore = score;
      iteration.bestMove = move;
      updatePrincipalVariation(context, 0, move);
    }
  }

  std::sort(iteration.candidates.begin(), iteration.candidates.end(), [](const RootMoveScore& left,
                                                                         const RootMoveScore& right) {
    if (left.score != right.score) return left.score > right.score;
    return left.uci < right.uci;
  });
  iteration.completed = true;
  for (int ply = 0; ply < context.principalVariationLength[0]; ++ply) {
    const std::uint16_t encoded = context.principalVariation[0][ply];
    if (encoded == 0) break;
    iteration.principalVariation.push_back(chess::uci::moveToUci(chess::Move(encoded)));
  }

  if (context.limits.useTranspositionTable) {
    TranspositionEntry& entry = context.tableEntry(key);
    entry.key = key;
    entry.score = static_cast<std::int16_t>(scoreToTable(iteration.bestScore, 0));
    entry.move = iteration.bestMove.move();
    entry.depth = static_cast<std::int8_t>(depth);
    entry.bound = Bound::Exact;
    entry.generation = context.generation;
  }
  return iteration;
}

std::vector<std::string> fallbackMoves(const chess::Movelist& legal) {
  std::vector<std::string> moves;
  moves.reserve(legal.size());
  for (const chess::Move move : legal) moves.push_back(chess::uci::moveToUci(move));
  std::sort(moves.begin(), moves.end());
  return moves;
}

}  // namespace

SearchResult OfflineEngine::searchFen(std::string_view fen, const SearchLimits& requestedLimits) const {
  SearchResult result;
  chess::Board board;
  if (!board.setFen(fen)) {
    result.stopReason = SearchStopReason::InvalidFen;
    return result;
  }

  const auto gameOver = board.isGameOver();
  if (gameOver.first != chess::GameResultReason::NONE) {
    result.stopReason = SearchStopReason::TerminalPosition;
    result.outcome = mapOutcome(gameOver.first);
    return result;
  }

  chess::Movelist legal;
  chess::movegen::legalmoves(legal, board);
  const std::vector<std::string> fallback = fallbackMoves(legal);
  if (fallback.empty()) {
    result.stopReason = SearchStopReason::TerminalPosition;
    result.outcome = board.inCheck() ? GameOutcome::Checkmate : GameOutcome::Stalemate;
    return result;
  }

  auto context = std::make_unique<SearchContext>(requestedLimits);
  chess::Move completedBest = chess::Move::NO_MOVE;
  bool solved = false;
  for (int depth = 1; depth <= context->limits.maxDepth; ++depth) {
    context->generation = static_cast<std::uint8_t>(depth);
    RootIteration iteration = searchRoot(*context, board, depth);
    if (!iteration.completed) break;

    completedBest = iteration.bestMove;
    result.bestMove = chess::uci::moveToUci(completedBest);
    result.score = iteration.bestScore;
    result.mateIn = mateDistance(iteration.bestScore);
    result.completedDepth = depth;
    result.rankedRootMoves = std::move(iteration.candidates);
    result.principalVariation = std::move(iteration.principalVariation);

    if (std::abs(result.score) >= kMateThreshold) {
      solved = true;
      break;
    }
  }

  if (result.bestMove.empty()) {
    result.bestMove = fallback.front();
    result.principalVariation = {result.bestMove};
  }

  result.nodes = context->nodes;
  result.elapsedMs = static_cast<std::uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - context->start).count());
  if (context->aborted) result.stopReason = context->abortReason;
  else if (solved) result.stopReason = SearchStopReason::Complete;
  else result.stopReason = SearchStopReason::DepthLimit;
  return result;
}

const char* searchStopReasonName(SearchStopReason reason) {
  switch (reason) {
    case SearchStopReason::Complete: return "complete";
    case SearchStopReason::TimeLimit: return "time_limit";
    case SearchStopReason::DepthLimit: return "depth_limit";
    case SearchStopReason::NodeLimit: return "node_limit";
    case SearchStopReason::TerminalPosition: return "terminal_position";
    case SearchStopReason::InvalidFen: return "invalid_fen";
    default: return "unknown";
  }
}

}  // namespace offline
