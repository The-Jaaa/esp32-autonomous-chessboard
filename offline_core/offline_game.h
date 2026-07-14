#pragma once

#include <string>
#include <string_view>
#include <vector>

#ifndef CHESS_NO_EXCEPTIONS
#define CHESS_NO_EXCEPTIONS
#endif
#include "vendor/chess-library/chess.hpp"

namespace offline {

enum class GameOutcome {
  Ongoing,
  Checkmate,
  Stalemate,
  InsufficientMaterial,
  FiftyMoveDraw,
  ThreefoldRepetition
};

struct GameStatus {
  GameOutcome outcome = GameOutcome::Ongoing;
  bool inCheck = false;
};

struct MoveInfo {
  std::string uci;
  std::string san;
  std::string from;
  std::string to;
  std::string piece;
  std::string capturedPiece;
  std::string capturedSquare;
  std::string promotion;
  std::string rookFrom;
  std::string rookTo;
  bool capture = false;
  bool castling = false;
  bool enPassant = false;
};

class OfflineGame {
 public:
  OfflineGame();

  bool loadFen(std::string_view fen);
  void reset();

  [[nodiscard]] std::string fen() const;
  [[nodiscard]] char sideToMove() const;
  [[nodiscard]] std::vector<std::string> legalMovesUci() const;
  [[nodiscard]] std::vector<std::string> occupiedSquares() const;
  [[nodiscard]] std::string pieceAt(std::string_view square) const;
  [[nodiscard]] bool describeLegalMove(std::string_view uci, MoveInfo& result) const;
  [[nodiscard]] bool inCheck() const;
  [[nodiscard]] GameStatus status() const;

  bool applyUci(std::string_view uci, MoveInfo& result);
  bool undo();

 private:
  chess::Board board_;
  std::vector<chess::Move> history_;
};

const char* outcomeName(GameOutcome outcome);

}  // namespace offline
