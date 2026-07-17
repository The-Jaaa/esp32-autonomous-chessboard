#include "offline_promotion_motion.h"

#include "offline_lane_motion.h"
#include "offline_quiet_motion.h"

#include <cctype>
#include <cstddef>
#include <cstdlib>
#include <utility>

namespace offline {
namespace {

bool validSquare(const std::string& square) {
  return square.size() == 2 && square[0] >= 'a' && square[0] <= 'h' &&
         square[1] >= '1' && square[1] <= '8';
}

char normalizedPromotion(char piece) {
  return static_cast<char>(
      std::tolower(static_cast<unsigned char>(piece)));
}

bool validPromotionPiece(char piece) {
  const char normalized = normalizedPromotion(piece);
  return normalized == 'q' || normalized == 'r' ||
         normalized == 'b' || normalized == 'n';
}

bool validPromotionMove(const MoveInfo& move) {
  if (move.castling || move.enPassant || move.promotion.size() != 1 ||
      move.uci.size() != 5 || !validSquare(move.from) ||
      !validSquare(move.to) || move.piece.empty() ||
      normalizedPromotion(move.piece.front()) != 'p') {
    return false;
  }
  const char promotion = move.promotion.front();
  if (!validPromotionPiece(promotion) ||
      move.uci[4] != promotion ||
      move.uci.substr(0, 4) != move.from + move.to) {
    return false;
  }
  const bool whitePromotion = move.from[1] == '7' && move.to[1] == '8';
  const bool blackPromotion = move.from[1] == '2' && move.to[1] == '1';
  if (!whitePromotion && !blackPromotion) return false;
  const int fileDelta = std::abs(move.to[0] - move.from[0]);
  if (move.capture) {
    return fileDelta == 1 && move.capturedSquare == move.to &&
           !move.capturedPiece.empty();
  }
  return fileDelta == 0 && move.capturedSquare.empty() &&
         move.capturedPiece.empty();
}

CaptureMotionProgram reject(
    const OfflinePhaseExecutionRequest& request,
    CaptureMotionCompileStatus status,
    std::string reason) {
  CaptureMotionProgram program;
  program.status = status;
  program.token = request.token;
  program.phaseKind = request.phase.kind;
  program.moveUci = request.move.uci;
  program.from = request.phase.from;
  program.to = request.phase.to;
  program.graveyardSlotKey = request.graveyardSlotKey;
  program.expectedBefore = request.phase.expectedBefore;
  program.expectedAfter = request.phase.expectedAfter;
  program.blockedReason = std::move(reason);
  return program;
}

CaptureMotionPrimitive convertQuietPrimitive(
    const QuietMotionPrimitive& quiet) {
  CaptureMotionPrimitive primitive;
  switch (quiet.kind) {
    case QuietMotionPrimitiveKind::Travel:
      primitive.kind = CaptureMotionPrimitiveKind::TravelBoard;
      break;
    case QuietMotionPrimitiveKind::Pickup:
      primitive.kind = CaptureMotionPrimitiveKind::Pickup;
      break;
    case QuietMotionPrimitiveKind::Drag:
      primitive.kind = CaptureMotionPrimitiveKind::DragBoard;
      break;
    case QuietMotionPrimitiveKind::Drop:
      primitive.kind = CaptureMotionPrimitiveKind::Drop;
      break;
    case QuietMotionPrimitiveKind::Verify:
      primitive.kind = CaptureMotionPrimitiveKind::Verify;
      break;
  }
  primitive.sourceRawIndex = quiet.sourceRawIndex;
  primitive.targetRawIndex = quiet.targetRawIndex;
  primitive.finalBoardDrop = quiet.finalBoardDrop;
  return primitive;
}

CaptureMotionPrimitive convertLanePrimitive(
    const LaneMotionPrimitive& lane) {
  CaptureMotionPrimitive primitive;
  switch (lane.kind) {
    case LaneMotionPrimitiveKind::TravelBoard:
      primitive.kind = CaptureMotionPrimitiveKind::TravelBoard;
      break;
    case LaneMotionPrimitiveKind::Pickup:
      primitive.kind = CaptureMotionPrimitiveKind::Pickup;
      break;
    case LaneMotionPrimitiveKind::DragCoordinate:
      primitive.kind = CaptureMotionPrimitiveKind::DragCoordinate;
      break;
    case LaneMotionPrimitiveKind::DragBoard:
      primitive.kind = CaptureMotionPrimitiveKind::DragBoard;
      break;
    case LaneMotionPrimitiveKind::Drop:
      primitive.kind = CaptureMotionPrimitiveKind::Drop;
      break;
    case LaneMotionPrimitiveKind::Verify:
      primitive.kind = CaptureMotionPrimitiveKind::Verify;
      break;
  }
  primitive.sourceRawIndex = lane.sourceRawIndex;
  primitive.targetRawIndex = lane.targetRawIndex;
  primitive.targetX = lane.targetX;
  primitive.targetY = lane.targetY;
  primitive.finalBoardDrop = lane.finalBoardDrop;
  return primitive;
}

CaptureMotionCompileStatus mapQuietStatus(QuietMotionCompileStatus status) {
  switch (status) {
    case QuietMotionCompileStatus::Success:
      return CaptureMotionCompileStatus::Success;
    case QuietMotionCompileStatus::InvalidPhase:
      return CaptureMotionCompileStatus::InvalidPhase;
    case QuietMotionCompileStatus::UnsupportedMove:
      return CaptureMotionCompileStatus::UnsupportedMove;
    case QuietMotionCompileStatus::UnsupportedRoute:
      return CaptureMotionCompileStatus::UnsupportedRoute;
    case QuietMotionCompileStatus::InvalidOccupancy:
      return CaptureMotionCompileStatus::InvalidOccupancy;
    case QuietMotionCompileStatus::InvalidPath:
      return CaptureMotionCompileStatus::InvalidPath;
  }
  return CaptureMotionCompileStatus::InvalidPhase;
}

CaptureMotionCompileStatus mapLaneStatus(LaneMotionCompileStatus status) {
  switch (status) {
    case LaneMotionCompileStatus::Success:
      return CaptureMotionCompileStatus::Success;
    case LaneMotionCompileStatus::InvalidPhase:
      return CaptureMotionCompileStatus::InvalidPhase;
    case LaneMotionCompileStatus::UnsupportedMove:
      return CaptureMotionCompileStatus::UnsupportedMove;
    case LaneMotionCompileStatus::UnsupportedRoute:
    case LaneMotionCompileStatus::InvalidCoordinate:
      return CaptureMotionCompileStatus::UnsupportedRoute;
    case LaneMotionCompileStatus::InvalidOccupancy:
      return CaptureMotionCompileStatus::InvalidOccupancy;
    case LaneMotionCompileStatus::InvalidPath:
      return CaptureMotionCompileStatus::InvalidPath;
    case LaneMotionCompileStatus::InvalidGraveyard:
      return CaptureMotionCompileStatus::InvalidGraveyard;
  }
  return CaptureMotionCompileStatus::InvalidPhase;
}

OfflinePhaseExecutionRequest mechanicalRequest(
    const OfflinePhaseExecutionRequest& request) {
  OfflinePhaseExecutionRequest mechanical = request;
  mechanical.move.uci = request.move.from + request.move.to;
  mechanical.move.promotion.clear();
  return mechanical;
}

CaptureMotionProgram compileQuietPromotion(
    const OfflinePhaseExecutionRequest& request) {
  if (request.phase.kind != MotionPhaseKind::QuietTransfer ||
      request.move.capture || request.phase.graveyard ||
      !request.graveyardSlotKey.empty() ||
      request.graveyardState != GraveyardSlotState::Free ||
      !request.phase.transfer) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidPhase,
        "A quiet promotion requires one graveyard-free QuietTransfer phase.");
  }

  OfflinePhaseExecutionRequest mechanical = mechanicalRequest(request);
  CaptureMotionProgram program;
  if (request.phase.transfer->mode == ExternalRouteMode::Lane ||
      request.phase.transfer->mode == ExternalRouteMode::LaneBoard) {
    const LaneMotionProgram lane = OfflineLaneMotionCompiler{}.compile(mechanical);
    if (!lane.success()) {
      return reject(request, mapLaneStatus(lane.status), lane.blockedReason);
    }
    program.status = CaptureMotionCompileStatus::Success;
    program.token = request.token;
    program.phaseKind = request.phase.kind;
    program.from = request.phase.from;
    program.to = request.phase.to;
    program.sourceRawIndex = lane.sourceRawIndex;
    program.targetRawIndex = lane.targetRawIndex;
    program.routeMode = lane.routeMode;
    program.routeCost = lane.routeCost;
    program.rawPathSquares = lane.rawPathSquares;
    program.compressedPathSquares = lane.compressedPathSquares;
    program.routeTargets = lane.routeTargets;
    program.expectedBefore = lane.expectedBefore;
    program.expectedAfter = lane.expectedAfter;
    for (const LaneMotionPrimitive& primitive : lane.primitives) {
      program.primitives.push_back(convertLanePrimitive(primitive));
    }
  } else {
    const QuietMotionProgram quiet = OfflineQuietMotionCompiler{}.compile(mechanical);
    if (!quiet.success()) {
      return reject(request, mapQuietStatus(quiet.status), quiet.blockedReason);
    }
    program.status = CaptureMotionCompileStatus::Success;
    program.token = request.token;
    program.phaseKind = request.phase.kind;
    program.from = request.phase.from;
    program.to = request.phase.to;
    program.sourceRawIndex = quiet.sourceRawIndex;
    program.targetRawIndex = quiet.targetRawIndex;
    program.routeMode = quiet.routeMode;
    program.routeCost = quiet.routeCost;
    program.rawPathSquares = quiet.rawPathSquares;
    program.compressedPathSquares = quiet.compressedPathSquares;
    program.routeTargets = request.phase.transfer->targets;
    program.expectedBefore = quiet.expectedBefore;
    program.expectedAfter = quiet.expectedAfter;
    for (const QuietMotionPrimitive& primitive : quiet.primitives) {
      program.primitives.push_back(convertQuietPrimitive(primitive));
    }
  }
  program.moveUci = request.move.uci;
  return program;
}

}  // namespace

CaptureMotionProgram OfflinePromotionMotionCompiler::compile(
    const OfflinePhaseExecutionRequest& request) const {
  if (!validPromotionMove(request.move)) {
    return reject(
        request,
        CaptureMotionCompileStatus::UnsupportedMove,
        "The request does not describe a legal-shaped Q/R/B/N pawn promotion.");
  }
  if (request.move.from != request.phase.from &&
      request.phase.kind != MotionPhaseKind::CapturedRemoval &&
      request.phase.kind != MotionPhaseKind::AttackerFinal) {
    return reject(
        request,
        CaptureMotionCompileStatus::InvalidPhase,
        "The promotion phase source does not match the selected pawn.");
  }

  if (!request.move.capture) return compileQuietPromotion(request);
  OfflinePhaseExecutionRequest mechanical = mechanicalRequest(request);
  CaptureMotionProgram program = OfflineCaptureMotionCompiler{}.compile(mechanical);
  if (program.success()) program.moveUci = request.move.uci;
  return program;
}

bool promotionMotionAttemptAllowed(const OfflinePhaseExecutionToken& token) {
  return token.attempt >= 1 && token.attempt <= kPromotionMotionMaximumAttempts;
}

PromotionReplacementUpdate OfflinePromotionReplacementGate::updateFor(
    PromotionReplacementEvent event,
    std::string message) const {
  PromotionReplacementUpdate update;
  update.state = state_;
  update.event = event;
  update.message = std::move(message);
  return update;
}

PromotionReplacementUpdate OfflinePromotionReplacementGate::arm(
    std::string targetSquare,
    char promotionPiece,
    const Occupancy& expectedOccupancy) {
  const int targetIndex = squareToRawIndex(targetSquare);
  const char normalized = normalizedPromotion(promotionPiece);
  if (targetIndex < 0 || !validPromotionPiece(normalized) ||
      !expectedOccupancy[static_cast<std::size_t>(targetIndex)]) {
    state_ = PromotionReplacementState::Error;
    return updateFor(
        PromotionReplacementEvent::Error,
        "Promotion replacement requires an occupied valid target and Q/R/B/N identity.");
  }
  targetSquare_ = std::move(targetSquare);
  promotionPiece_ = normalized;
  expectedOccupancy_ = expectedOccupancy;
  emptyTargetOccupancy_ = expectedOccupancy;
  emptyTargetOccupancy_[static_cast<std::size_t>(targetIndex)] = false;
  liftObserved_ = false;
  state_ = PromotionReplacementState::WaitingForLift;
  return updateFor(
      PromotionReplacementEvent::Armed,
      "Lift the promoted pawn, then place the requested replacement piece.");
}

PromotionReplacementUpdate OfflinePromotionReplacementGate::processSnapshot(
    const Occupancy& occupancy) {
  if (state_ == PromotionReplacementState::Idle ||
      state_ == PromotionReplacementState::Error) {
    state_ = PromotionReplacementState::Error;
    return updateFor(
        PromotionReplacementEvent::Error,
        "Promotion replacement is not armed.");
  }
  if (state_ == PromotionReplacementState::Complete) {
    return updateFor(PromotionReplacementEvent::None);
  }

  if (occupancy == emptyTargetOccupancy_) {
    const bool firstLift = !liftObserved_;
    liftObserved_ = true;
    state_ = PromotionReplacementState::WaitingForReplacement;
    return updateFor(
        firstLift ? PromotionReplacementEvent::PawnLifted
                  : PromotionReplacementEvent::None,
        firstLift ? "Promotion pawn lifted; place the requested piece."
                  : "Waiting for the replacement piece.");
  }
  if (occupancy == expectedOccupancy_) {
    if (!liftObserved_) {
      state_ = PromotionReplacementState::WaitingForLift;
      return updateFor(
          PromotionReplacementEvent::None,
          "The pawn must be lifted before replacement can be confirmed.");
    }
    state_ = PromotionReplacementState::ReadyToConfirm;
    return updateFor(
        PromotionReplacementEvent::ReplacementReady,
        "The promotion square is reoccupied and ready for identity confirmation.");
  }

  state_ = PromotionReplacementState::SyncWarning;
  PromotionReplacementUpdate update = updateFor(
      PromotionReplacementEvent::RecoveryRequired,
      "Promotion replacement disturbed a square outside the promotion target.");
  update.differenceFromEmpty = compareOccupancy(emptyTargetOccupancy_, occupancy);
  update.differenceFromExpected = compareOccupancy(expectedOccupancy_, occupancy);
  return update;
}

PromotionReplacementUpdate OfflinePromotionReplacementGate::confirm(
    char promotionPiece,
    const Occupancy& occupancy) {
  if (state_ != PromotionReplacementState::ReadyToConfirm ||
      occupancy != expectedOccupancy_ ||
      normalizedPromotion(promotionPiece) != promotionPiece_) {
    return updateFor(
        PromotionReplacementEvent::ConfirmationRejected,
        "Promotion identity, occupancy, or replacement sequence is not ready.");
  }
  state_ = PromotionReplacementState::Complete;
  return updateFor(
      PromotionReplacementEvent::Confirmed,
      "Promotion replacement confirmed.");
}

const char* promotionReplacementStateName(PromotionReplacementState state) {
  switch (state) {
    case PromotionReplacementState::Idle: return "idle";
    case PromotionReplacementState::WaitingForLift: return "waiting_for_lift";
    case PromotionReplacementState::WaitingForReplacement: return "waiting_for_replacement";
    case PromotionReplacementState::ReadyToConfirm: return "ready_to_confirm";
    case PromotionReplacementState::SyncWarning: return "sync_warning";
    case PromotionReplacementState::Complete: return "complete";
    case PromotionReplacementState::Error: return "error";
  }
  return "error";
}

const char* promotionReplacementEventName(PromotionReplacementEvent event) {
  switch (event) {
    case PromotionReplacementEvent::None: return "none";
    case PromotionReplacementEvent::Armed: return "armed";
    case PromotionReplacementEvent::PawnLifted: return "pawn_lifted";
    case PromotionReplacementEvent::ReplacementReady: return "replacement_ready";
    case PromotionReplacementEvent::RecoveryRequired: return "recovery_required";
    case PromotionReplacementEvent::Confirmed: return "confirmed";
    case PromotionReplacementEvent::ConfirmationRejected: return "confirmation_rejected";
    case PromotionReplacementEvent::Error: return "error";
  }
  return "error";
}

}  // namespace offline
