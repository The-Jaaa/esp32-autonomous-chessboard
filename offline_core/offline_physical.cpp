#include "offline_physical.h"

#include <algorithm>
#include <cctype>
#include <set>
#include <sstream>
#include <utility>

namespace offline {
namespace {

constexpr std::array<std::string_view, 64> kRawIndexToSquare = {
    "h8", "h7", "h6", "h5", "h4", "h3", "h2", "h1",
    "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8",
    "f8", "f7", "f6", "f5", "f4", "f3", "f2", "f1",
    "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8",
    "d8", "d7", "d6", "d5", "d4", "d3", "d2", "d1",
    "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8",
    "b8", "b7", "b6", "b5", "b4", "b3", "b2", "b1",
    "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"};

bool sameSquares(const std::vector<std::string>& actual, std::initializer_list<std::string> expected) {
  std::vector<std::string> sortedExpected(expected);
  std::vector<std::string> sortedActual(actual);
  std::sort(sortedExpected.begin(), sortedExpected.end());
  std::sort(sortedActual.begin(), sortedActual.end());
  return sortedActual == sortedExpected;
}

bool isWhitePiece(const std::string& piece) {
  return !piece.empty() && std::isupper(static_cast<unsigned char>(piece[0])) != 0;
}

bool isPromotionMove(const MoveInfo& move) {
  return !move.promotion.empty();
}

bool isSamePhysicalMove(const MoveInfo& left, const MoveInfo& right) {
  return left.from == right.from && left.to == right.to && left.capture == right.capture &&
         left.capturedSquare == right.capturedSquare && left.castling == right.castling;
}

void addUnique(std::vector<std::string>& values, const std::string& value) {
  if (std::find(values.begin(), values.end(), value) == values.end()) values.push_back(value);
}

Highlight makeHighlight(const std::string& square, HighlightRole role) {
  return {square, squareToRawIndex(square), role};
}

}  // namespace

int squareToRawIndex(std::string_view square) {
  if (square.size() != 2) return -1;
  for (std::size_t index = 0; index < kRawIndexToSquare.size(); ++index) {
    if (kRawIndexToSquare[index] == square) return static_cast<int>(index);
  }
  return -1;
}

std::string rawIndexToSquare(std::size_t rawIndex) {
  if (rawIndex >= kRawIndexToSquare.size()) return {};
  return std::string(kRawIndexToSquare[rawIndex]);
}

Occupancy occupancyFromFen(std::string_view fen) {
  Occupancy occupancy{};
  const std::size_t separator = fen.find(' ');
  const std::string_view placement = fen.substr(0, separator);
  int rank = 8;
  int file = 0;
  bool valid = true;

  for (const char token : placement) {
    if (token == '/') {
      if (file != 8 || rank <= 1) {
        valid = false;
        break;
      }
      --rank;
      file = 0;
      continue;
    }
    if (token >= '1' && token <= '8') {
      file += token - '0';
      if (file > 8) valid = false;
      continue;
    }
    if (std::string_view("prnbqkPRNBQK").find(token) == std::string_view::npos || file >= 8) {
      valid = false;
      break;
    }
    const std::string square{static_cast<char>('a' + file), static_cast<char>('0' + rank)};
    const int rawIndex = squareToRawIndex(square);
    if (rawIndex < 0) {
      valid = false;
      break;
    }
    occupancy[static_cast<std::size_t>(rawIndex)] = true;
    ++file;
  }

  if (!valid || rank != 1 || file != 8) occupancy.fill(false);
  return occupancy;
}

OccupancyDiff compareOccupancy(const Occupancy& expected, const Occupancy& actual) {
  OccupancyDiff diff;
  for (std::size_t index = 0; index < expected.size(); ++index) {
    if (expected[index] && !actual[index]) diff.missing.push_back(rawIndexToSquare(index));
    if (!expected[index] && actual[index]) diff.extra.push_back(rawIndexToSquare(index));
  }
  std::sort(diff.missing.begin(), diff.missing.end());
  std::sort(diff.extra.begin(), diff.extra.end());
  return diff;
}

const char* physicalPhaseName(PhysicalPhase phase) {
  switch (phase) {
    case PhysicalPhase::Ready: return "ready";
    case PhysicalPhase::WaitingForOpponent: return "waiting_for_opponent";
    case PhysicalPhase::PieceLifted: return "piece_lifted";
    case PhysicalPhase::CapturePending: return "capture_pending";
    case PhysicalPhase::CastlePendingRook: return "castle_pending_rook";
    case PhysicalPhase::PromotionPending: return "promotion_pending";
    case PhysicalPhase::SyncWarning: return "sync_warning";
    default: return "unknown";
  }
}

const char* physicalEventName(PhysicalEvent event) {
  switch (event) {
    case PhysicalEvent::None: return "none";
    case PhysicalEvent::PieceLifted: return "piece_lifted";
    case PhysicalEvent::MoveCancelled: return "move_cancelled";
    case PhysicalEvent::CaptureTargetRemoved: return "capture_target_removed";
    case PhysicalEvent::RookRequired: return "rook_required";
    case PhysicalEvent::PromotionChoiceRequired: return "promotion_choice_required";
    case PhysicalEvent::InvalidPromotionChoice: return "invalid_promotion_choice";
    case PhysicalEvent::MoveAccepted: return "move_accepted";
    case PhysicalEvent::RestoreRequired: return "restore_required";
    default: return "unknown";
  }
}

OfflinePhysicalController::OfflinePhysicalController(HumanColor humanColor) : humanColor_(humanColor) {
  committedOccupancy_ = occupancyFromFen(game_.fen());
  refreshTurnPhase();
}

bool OfflinePhysicalController::loadFen(std::string_view fen) {
  if (!game_.loadFen(fen)) return false;
  committedOccupancy_ = occupancyFromFen(game_.fen());
  resetInteraction();
  hasLastSnapshot_ = false;
  refreshTurnPhase();
  return true;
}

void OfflinePhysicalController::reset() {
  game_.reset();
  committedOccupancy_ = occupancyFromFen(game_.fen());
  resetInteraction();
  hasLastSnapshot_ = false;
  refreshTurnPhase();
}

void OfflinePhysicalController::resetInteraction() {
  source_.clear();
  sourceMoves_.clear();
  pendingMoves_.clear();
  pendingCastle_.reset();
  hasPendingPromotionOccupancy_ = false;
}

void OfflinePhysicalController::refreshTurnPhase() {
  const bool whiteTurn = game_.sideToMove() == 'w';
  const bool humanIsWhite = humanColor_ == HumanColor::White;
  phase_ = whiteTurn == humanIsWhite ? PhysicalPhase::Ready : PhysicalPhase::WaitingForOpponent;
}

std::vector<MoveInfo> OfflinePhysicalController::legalMovesFrom(const std::string& source) const {
  std::vector<MoveInfo> moves;
  for (const std::string& uci : game_.legalMovesUci()) {
    if (uci.substr(0, 2) != source) continue;
    MoveInfo move;
    if (game_.describeLegalMove(uci, move)) moves.push_back(std::move(move));
  }
  return moves;
}

SnapshotResult OfflinePhysicalController::resultFor(
    const Occupancy& occupancy, PhysicalEvent event, std::string message) const {
  SnapshotResult result;
  result.phase = phase_;
  result.event = event;
  result.diff = compareOccupancy(committedOccupancy_, occupancy);
  result.message = std::move(message);

  if (phase_ == PhysicalPhase::SyncWarning) {
    for (const std::string& square : result.diff.missing) result.highlights.push_back(makeHighlight(square, HighlightRole::Missing));
    for (const std::string& square : result.diff.extra) result.highlights.push_back(makeHighlight(square, HighlightRole::Extra));
    return result;
  }

  if (!source_.empty()) result.highlights.push_back(makeHighlight(source_, HighlightRole::Source));
  if (phase_ == PhysicalPhase::PieceLifted) {
    for (const MoveInfo& move : sourceMoves_) {
      addUnique(result.legalTargets, move.to);
      const HighlightRole role = move.castling || isPromotionMove(move)
                                     ? HighlightRole::SpecialTarget
                                     : (move.capture ? HighlightRole::CaptureTarget : HighlightRole::QuietTarget);
      const auto duplicate = std::find_if(result.highlights.begin(), result.highlights.end(), [&](const Highlight& item) {
        return item.square == move.to;
      });
      if (duplicate == result.highlights.end()) result.highlights.push_back(makeHighlight(move.to, role));
    }
    std::sort(result.legalTargets.begin(), result.legalTargets.end());
  } else if (phase_ == PhysicalPhase::CapturePending && !pendingMoves_.empty()) {
    result.legalTargets.push_back(pendingMoves_.front().to);
    result.highlights.push_back(makeHighlight(pendingMoves_.front().to, HighlightRole::CaptureTarget));
  } else if (phase_ == PhysicalPhase::CastlePendingRook && pendingCastle_) {
    result.highlights.push_back(makeHighlight(pendingCastle_->rookFrom, HighlightRole::RookSource));
    result.highlights.push_back(makeHighlight(pendingCastle_->rookTo, HighlightRole::RookTarget));
  } else if (phase_ == PhysicalPhase::PromotionPending && !pendingMoves_.empty()) {
    result.highlights.push_back(makeHighlight(pendingMoves_.front().to, HighlightRole::SpecialTarget));
  }
  return result;
}

SnapshotResult OfflinePhysicalController::enterSyncWarning(const Occupancy& occupancy, std::string message) {
  phase_ = PhysicalPhase::SyncWarning;
  resetInteraction();
  return resultFor(occupancy, PhysicalEvent::RestoreRequired, std::move(message));
}

SnapshotResult OfflinePhysicalController::acceptMove(const std::string& uci, const Occupancy& occupancy) {
  MoveInfo accepted;
  if (!game_.applyUci(uci, accepted)) {
    return enterSyncWarning(occupancy, "The inferred move is no longer legal; restore the committed position.");
  }

  committedOccupancy_ = occupancyFromFen(game_.fen());
  if (committedOccupancy_ != occupancy) {
    game_.undo();
    committedOccupancy_ = occupancyFromFen(game_.fen());
    return enterSyncWarning(occupancy, "The completed occupancy does not match the inferred legal move.");
  }

  resetInteraction();
  refreshTurnPhase();
  SnapshotResult result = resultFor(occupancy, PhysicalEvent::MoveAccepted, "Physical move accepted.");
  result.acceptedMove = std::move(accepted);
  return result;
}

SnapshotResult OfflinePhysicalController::beginPromotion(
    const std::vector<MoveInfo>& moves, const Occupancy& occupancy) {
  pendingMoves_ = moves;
  pendingPromotionOccupancy_ = occupancy;
  hasPendingPromotionOccupancy_ = true;
  phase_ = PhysicalPhase::PromotionPending;
  return resultFor(occupancy, PhysicalEvent::PromotionChoiceRequired, "Choose promotion piece: q, r, b, or n.");
}

SnapshotResult OfflinePhysicalController::processSnapshot(const Occupancy& occupancy) {
  if (hasLastSnapshot_ && occupancy == lastSnapshot_) {
    return resultFor(occupancy, PhysicalEvent::None);
  }
  lastSnapshot_ = occupancy;
  hasLastSnapshot_ = true;

  const OccupancyDiff diff = compareOccupancy(committedOccupancy_, occupancy);
  if (phase_ == PhysicalPhase::SyncWarning) {
    if (diff.empty()) {
      resetInteraction();
      refreshTurnPhase();
      return resultFor(occupancy, PhysicalEvent::MoveCancelled, "Committed position restored.");
    }
    return resultFor(occupancy, PhysicalEvent::RestoreRequired, "Restore all missing and extra squares.");
  }

  if (phase_ == PhysicalPhase::PromotionPending) {
    if (hasPendingPromotionOccupancy_ && occupancy == pendingPromotionOccupancy_) {
      return resultFor(occupancy, PhysicalEvent::None);
    }
    if (diff.empty()) {
      resetInteraction();
      refreshTurnPhase();
      return resultFor(occupancy, PhysicalEvent::MoveCancelled, "Promotion move cancelled.");
    }
    return enterSyncWarning(occupancy, "Board changed while waiting for a promotion choice.");
  }

  if (phase_ == PhysicalPhase::WaitingForOpponent) {
    if (diff.empty()) return resultFor(occupancy, PhysicalEvent::None);
    return enterSyncWarning(occupancy, "A physical move is not allowed while waiting for the opponent.");
  }

  if (phase_ == PhysicalPhase::Ready) {
    if (diff.empty()) return resultFor(occupancy, PhysicalEvent::None);
    if (diff.missing.size() != 1 || !diff.extra.empty()) {
      return enterSyncWarning(occupancy, "Lift exactly one movable human piece.");
    }

    const std::string source = diff.missing.front();
    const std::string piece = game_.pieceAt(source);
    const bool humanIsWhite = humanColor_ == HumanColor::White;
    if (piece.empty() || isWhitePiece(piece) != humanIsWhite) {
      return enterSyncWarning(occupancy, "The lifted square is not a human-controlled piece.");
    }

    std::vector<MoveInfo> moves = legalMovesFrom(source);
    if (moves.empty()) {
      return enterSyncWarning(occupancy, "The lifted piece has no legal moves.");
    }

    source_ = source;
    sourceMoves_ = std::move(moves);
    phase_ = PhysicalPhase::PieceLifted;
    return resultFor(occupancy, PhysicalEvent::PieceLifted, "Piece lifted; legal targets are armed.");
  }

  if (phase_ == PhysicalPhase::PieceLifted) {
    if (diff.empty()) {
      resetInteraction();
      refreshTurnPhase();
      return resultFor(occupancy, PhysicalEvent::MoveCancelled, "Piece returned to its source square.");
    }

    for (const MoveInfo& move : sourceMoves_) {
      if (!move.capture) continue;
      if (sameSquares(diff.missing, {source_, move.capturedSquare}) && diff.extra.empty()) {
        pendingMoves_.clear();
        for (const MoveInfo& candidate : sourceMoves_) {
          if (candidate.capture && isSamePhysicalMove(candidate, move)) pendingMoves_.push_back(candidate);
        }
        phase_ = PhysicalPhase::CapturePending;
        return resultFor(occupancy, PhysicalEvent::CaptureTargetRemoved, "Captured piece removed; place the attacker.");
      }
    }

    for (const MoveInfo& move : sourceMoves_) {
      if (move.capture) continue;
      if (!sameSquares(diff.missing, {source_}) || !sameSquares(diff.extra, {move.to})) continue;
      if (move.castling) {
        pendingCastle_ = move;
        phase_ = PhysicalPhase::CastlePendingRook;
        return resultFor(occupancy, PhysicalEvent::RookRequired, "King placed; move the castling rook.");
      }
      if (isPromotionMove(move)) {
        std::vector<MoveInfo> promotionMoves;
        for (const MoveInfo& candidate : sourceMoves_) {
          if (candidate.to == move.to && isPromotionMove(candidate)) promotionMoves.push_back(candidate);
        }
        return beginPromotion(promotionMoves, occupancy);
      }
      return acceptMove(move.uci, occupancy);
    }

    return enterSyncWarning(occupancy, "The piece was placed on an illegal or ambiguous destination.");
  }

  if (phase_ == PhysicalPhase::CapturePending) {
    if (diff.empty()) {
      resetInteraction();
      refreshTurnPhase();
      return resultFor(occupancy, PhysicalEvent::MoveCancelled, "Capture cancelled and original position restored.");
    }
    if (pendingMoves_.empty()) return enterSyncWarning(occupancy, "Capture state has no legal move metadata.");

    const MoveInfo& move = pendingMoves_.front();
    if (sameSquares(diff.missing, {source_}) && diff.extra.empty() && !move.enPassant) {
      if (isPromotionMove(move)) return beginPromotion(pendingMoves_, occupancy);
      return acceptMove(move.uci, occupancy);
    }
    if (sameSquares(diff.missing, {source_, move.capturedSquare}) && sameSquares(diff.extra, {move.to})) {
      if (isPromotionMove(move)) return beginPromotion(pendingMoves_, occupancy);
      return acceptMove(move.uci, occupancy);
    }
    if (sameSquares(diff.missing, {source_, move.capturedSquare}) && diff.extra.empty()) {
      return resultFor(occupancy, PhysicalEvent::None);
    }
    if (sameSquares(diff.missing, {source_}) && diff.extra.empty()) {
      phase_ = PhysicalPhase::PieceLifted;
      pendingMoves_.clear();
      return resultFor(occupancy, PhysicalEvent::PieceLifted, "Capture target restored; choose a legal move.");
    }
    return enterSyncWarning(occupancy, "Incomplete capture sequence; restore the committed position.");
  }

  if (phase_ == PhysicalPhase::CastlePendingRook) {
    if (diff.empty()) {
      resetInteraction();
      refreshTurnPhase();
      return resultFor(occupancy, PhysicalEvent::MoveCancelled, "Castling cancelled and original position restored.");
    }
    if (!pendingCastle_) return enterSyncWarning(occupancy, "Castling state has no legal move metadata.");
    const MoveInfo& move = *pendingCastle_;
    if (sameSquares(diff.missing, {source_}) && sameSquares(diff.extra, {move.to})) {
      return resultFor(occupancy, PhysicalEvent::None, "Move the rook to complete castling.");
    }
    if (sameSquares(diff.missing, {source_, move.rookFrom}) && sameSquares(diff.extra, {move.to})) {
      return resultFor(occupancy, PhysicalEvent::RookRequired, "Rook lifted; place it on the highlighted square.");
    }
    if (sameSquares(diff.missing, {source_, move.rookFrom}) && sameSquares(diff.extra, {move.to, move.rookTo})) {
      return acceptMove(move.uci, occupancy);
    }
    return enterSyncWarning(occupancy, "Castling pieces do not match the required final squares.");
  }

  return enterSyncWarning(occupancy, "Unhandled physical controller state.");
}

SnapshotResult OfflinePhysicalController::confirmPromotion(char promotionPiece) {
  const char normalized = static_cast<char>(std::tolower(static_cast<unsigned char>(promotionPiece)));
  const Occupancy& occupancy = hasPendingPromotionOccupancy_ ? pendingPromotionOccupancy_ : committedOccupancy_;
  if (phase_ != PhysicalPhase::PromotionPending || !hasPendingPromotionOccupancy_) {
    return resultFor(occupancy, PhysicalEvent::InvalidPromotionChoice, "No promotion is waiting for a choice.");
  }
  if (normalized != 'q' && normalized != 'r' && normalized != 'b' && normalized != 'n') {
    return resultFor(occupancy, PhysicalEvent::InvalidPromotionChoice, "Promotion must be q, r, b, or n.");
  }
  for (const MoveInfo& move : pendingMoves_) {
    if (!move.promotion.empty() && move.promotion[0] == normalized) return acceptMove(move.uci, occupancy);
  }
  return resultFor(occupancy, PhysicalEvent::InvalidPromotionChoice, "That promotion choice is not legal here.");
}

bool OfflinePhysicalController::previewOpponentMove(
    std::string_view uci, OpponentMovePreview& result) const {
  if (phase_ != PhysicalPhase::WaitingForOpponent) return false;

  OfflineGame previewGame = game_;

  MoveInfo move;
  if (!previewGame.applyUci(uci, move)) return false;

  OpponentMovePreview preview;
  preview.move = std::move(move);
  preview.beforeFen = game_.fen();
  preview.afterFen = previewGame.fen();
  preview.expectedOccupancy = occupancyFromFen(preview.afterFen);
  preview.expectedStatus = previewGame.status();
  result = std::move(preview);
  return true;
}

bool OfflinePhysicalController::commitVerifiedOpponentMove(
    std::string_view uci, const Occupancy& verifiedOccupancy, MoveInfo& result) {
  OpponentMovePreview preview;
  if (!previewOpponentMove(uci, preview)) return false;
  if (verifiedOccupancy != preview.expectedOccupancy) return false;

  MoveInfo accepted;
  if (!game_.applyUci(uci, accepted)) return false;
  if (game_.fen() != preview.afterFen) {
    game_.undo();
    return false;
  }

  committedOccupancy_ = preview.expectedOccupancy;
  resetInteraction();
  refreshTurnPhase();
  lastSnapshot_ = verifiedOccupancy;
  hasLastSnapshot_ = true;
  result = std::move(accepted);
  return true;
}

}  // namespace offline
