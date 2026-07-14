#include "offline_game.h"

#include <algorithm>
#include <utility>

namespace offline {
namespace {

std::string squareName(chess::Square square) {
  return static_cast<std::string>(square);
}

std::string pieceName(chess::Piece piece) {
  if (piece == chess::Piece::NONE) return {};
  return static_cast<std::string>(piece);
}

GameOutcome mapOutcome(chess::GameResultReason reason) {
  switch (reason) {
    case chess::GameResultReason::CHECKMATE:
      return GameOutcome::Checkmate;
    case chess::GameResultReason::STALEMATE:
      return GameOutcome::Stalemate;
    case chess::GameResultReason::INSUFFICIENT_MATERIAL:
      return GameOutcome::InsufficientMaterial;
    case chess::GameResultReason::FIFTY_MOVE_RULE:
      return GameOutcome::FiftyMoveDraw;
    case chess::GameResultReason::THREEFOLD_REPETITION:
      return GameOutcome::ThreefoldRepetition;
    case chess::GameResultReason::NONE:
    default:
      return GameOutcome::Ongoing;
  }
}

}  // namespace

OfflineGame::OfflineGame() = default;

bool OfflineGame::loadFen(std::string_view fen) {
  chess::Board candidate;
  if (!candidate.setFen(fen)) return false;
  board_ = candidate;
  history_.clear();
  return true;
}

void OfflineGame::reset() {
  board_ = chess::Board();
  history_.clear();
}

std::string OfflineGame::fen() const {
  return board_.getFen();
}

char OfflineGame::sideToMove() const {
  return board_.sideToMove() == chess::Color::WHITE ? 'w' : 'b';
}

std::vector<std::string> OfflineGame::legalMovesUci() const {
  chess::Movelist legal;
  chess::movegen::legalmoves(legal, board_);

  std::vector<std::string> moves;
  moves.reserve(legal.size());
  for (const chess::Move move : legal) moves.push_back(chess::uci::moveToUci(move));
  std::sort(moves.begin(), moves.end());
  return moves;
}

bool OfflineGame::inCheck() const {
  return board_.inCheck();
}

GameStatus OfflineGame::status() const {
  return {mapOutcome(board_.isGameOver().first), board_.inCheck()};
}

bool OfflineGame::applyUci(std::string_view uci, MoveInfo& result) {
  const chess::Move requested = chess::uci::uciToMove(board_, uci);
  if (requested == chess::Move::NO_MOVE) return false;

  chess::Movelist legal;
  chess::movegen::legalmoves(legal, board_);
  const auto found = std::find(legal.begin(), legal.end(), requested);
  if (found == legal.end()) return false;

  const chess::Move move = *found;
  const std::string normalizedUci = chess::uci::moveToUci(move);
  MoveInfo next;
  next.uci = normalizedUci;
  next.san = chess::uci::moveToSan(board_, move);
  next.from = normalizedUci.substr(0, 2);
  next.to = normalizedUci.substr(2, 2);
  next.piece = pieceName(board_.at(move.from()));
  next.capture = board_.isCapture(move);
  next.castling = move.typeOf() == chess::Move::CASTLING;
  next.enPassant = move.typeOf() == chess::Move::ENPASSANT;

  if (next.capture) {
    next.capturedPiece = pieceName(board_.getCapturing<chess::Piece>(move));
    next.capturedSquare = next.enPassant ? squareName(move.to().ep_square()) : next.to;
  }

  if (move.typeOf() == chess::Move::PROMOTION) {
    next.promotion = normalizedUci.substr(4, 1);
  }

  if (next.castling) {
    next.rookFrom = squareName(move.to());
    const char rank = next.from[1];
    next.rookTo = std::string{next.to[0] == 'g' ? 'f' : 'd', rank};
  }

  history_.push_back(move);
  board_.makeMove(move);
  result = std::move(next);
  return true;
}

bool OfflineGame::undo() {
  if (history_.empty()) return false;
  board_.unmakeMove(history_.back());
  history_.pop_back();
  return true;
}

const char* outcomeName(GameOutcome outcome) {
  switch (outcome) {
    case GameOutcome::Checkmate:
      return "checkmate";
    case GameOutcome::Stalemate:
      return "stalemate";
    case GameOutcome::InsufficientMaterial:
      return "insufficient_material";
    case GameOutcome::FiftyMoveDraw:
      return "fifty_move_draw";
    case GameOutcome::ThreefoldRepetition:
      return "threefold_repetition";
    case GameOutcome::Ongoing:
    default:
      return "ongoing";
  }
}

}  // namespace offline
