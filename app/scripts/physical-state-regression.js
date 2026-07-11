process.env.PHYSICAL_LOG_DISABLE = '1';

const assert = require('assert');
const { Chess } = require('chess.js');
const {
  physicalBoardTest: {
    physicalSession,
    processPhysicalSnapshot,
    queueRobotReply,
    pausePendingRobotJobAfterFailure,
    startPhysicalUndoTurn,
    startPhysicalRedoTurn,
    completePendingUndoRobotJob,
    completePendingRedoRobotJob,
    serializePhysicalState,
    occupancyFromGame,
    occupancyFromFen,
    squareToIndex,
    normalizeProfile,
    clampLevel
  },
  physicalPlanner: {
    PHYSICAL_START_FEN,
    DEFAULT_Z_GRAVEYARD_SLOTS,
    buildRobotMoveCommand,
    legalMoveMatchesUci,
    normalizeGraveyardSlots
  }
} = require('../server');

function resetPhysicalSession(fen = PHYSICAL_START_FEN) {
  physicalSession.active = true;
  physicalSession.phase = 'ready';
  physicalSession.setupMode = 'full';
  physicalSession.game = new Chess(fen);
  physicalSession.occupancy = occupancyFromGame(physicalSession.game);
  physicalSession.selectedSource = null;
  physicalSession.pendingCaptureTarget = null;
  physicalSession.pendingCastleMove = null;
  physicalSession.legalTargets = [];
  physicalSession.level = clampLevel(1);
  physicalSession.profile = normalizeProfile('balanced');
  physicalSession.graveyardSlots = normalizeGraveyardSlots(DEFAULT_Z_GRAVEYARD_SLOTS);
  physicalSession.nextGraveyardSlot = 0;
  physicalSession.robotGraveyardOccupied = [];
  physicalSession.pendingRobotJob = null;
  physicalSession.moveLog = [];
  physicalSession.pendingUndo = null;
  physicalSession.redoStack = [];
  physicalSession.pendingRedo = null;
  physicalSession.autoRobotReply = false;
  physicalSession.commands = [];
  physicalSession.lastCalibrationKey = '';
  physicalSession.lastError = null;
  physicalSession.syncWarningReason = null;
  physicalSession.postRobotSettleGuard = null;
  physicalSession.statusText = 'Waiting for your move.';
  physicalSession.lastMove = null;
}

function parseUci(uci) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci.slice(4, 5) : undefined
  };
}

function capturedSquareFor(move) {
  if (!move.captured) return null;
  return move.flags?.includes('e') ? `${move.to[0]}${move.from[1]}` : move.to;
}

function castleRookFor(move) {
  if (!move.flags?.includes('k') && !move.flags?.includes('q')) return null;
  const rank = move.color === 'w' ? '1' : '8';
  return move.to[0] === 'g'
    ? { from: `h${rank}`, to: `f${rank}`, fromIndex: squareToIndex(`h${rank}`), toIndex: squareToIndex(`f${rank}`) }
    : { from: `a${rank}`, to: `d${rank}`, fromIndex: squareToIndex(`a${rank}`), toIndex: squareToIndex(`d${rank}`) };
}

function makeMoveLogEntry(side, beforeFen, uci, extra = {}) {
  const game = new Chess(beforeFen);
  const move = game.move(parseUci(uci));
  assert(move, `${uci} should be legal for move-log test`);
  const capturedSquare = capturedSquareFor(move);
  return {
    id: `test-${side}-${uci}-${Math.random()}`,
    side,
    beforeFen,
    afterFen: game.fen(),
    uci,
    san: move.san,
    color: move.color,
    piece: move.piece,
    from: move.from,
    to: move.to,
    flags: move.flags || '',
    promotion: move.promotion || null,
    capturedSquare,
    capturedPiece: move.captured || null,
    castleRookMove: castleRookFor(move),
    enPassantCapturedSquare: move.flags?.includes('e') ? capturedSquare : null,
    robotGraveyardSlot: extra.robotGraveyardSlot || null,
    robotCapturedPathSquares: extra.robotCapturedPathSquares || [],
    verified: true,
    createdAt: Date.now()
  };
}

function occupancyWithSquare(fen, square, occupied) {
  const occupancy = occupancyFromFen(fen);
  occupancy[squareToIndex(square)] = occupied;
  return occupancy;
}

async function run() {
  const fen = 'rnbqkbnr/2pppppp/p7/1p6/6P1/2P5/PP1PPP1P/RNBQKBNR w KQkq - 0 3';
  resetPhysicalSession(fen);

  const lifted = occupancyFromGame(physicalSession.game);
  lifted[squareToIndex('h1')] = false;

  await processPhysicalSnapshot(lifted, { source: 'regression-test' });
  let state = serializePhysicalState();
  assert.strictEqual(state.phase, 'sync_warning', 'lifting a no-legal-move rook should be recoverable');
  assert.strictEqual(state.lastError, null, 'recoverable no-move lift should not set lastError');
  assert.strictEqual(state.syncWarningReason?.type, 'no_legal_moves_lift');
  assert.deepStrictEqual(state.board.missingSquares, ['h1']);
  assert.match(state.statusText, /no legal moves/i);

  await processPhysicalSnapshot(occupancyFromGame(physicalSession.game), { source: 'regression-test' });
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'ready', 'placing the rook back should clear the warning');
  assert.strictEqual(state.lastError, null);
  assert.strictEqual(state.syncWarningReason, null);
  assert.strictEqual(state.board.ready, true);

  const beforeCaptureFen = 'rnbqkbnr/ppp1pppp/8/3p4/4PP2/8/PPPP2PP/RNBQKBNR b KQkq - 0 2';
  resetPhysicalSession(beforeCaptureFen);
  const preCaptureOccupancy = occupancyFromGame(physicalSession.game);
  const applied = physicalSession.game.move({ from: 'd5', to: 'e4', promotion: 'q' });
  assert(applied, 'd5e4 should be legal in capture regression position');
  physicalSession.phase = 'robot_busy';
  physicalSession.pendingRobotJob = {
    id: 'robot-capture-regression',
    uci: 'd5e4',
    san: 'dxe4',
    command: { id: 'robot-capture-regression', routeMode: 'capture-stage-first-board', plan: [] },
    preMoveFen: beforeCaptureFen,
    applied: true,
    appliedMove: {
      from: applied.from,
      to: applied.to,
      promotion: applied.promotion || null,
      san: applied.san
    }
  };

  const stagedOccupancy = preCaptureOccupancy.slice();
  stagedOccupancy[squareToIndex('d5')] = false;
  stagedOccupancy[squareToIndex('e4')] = true;
  await processPhysicalSnapshot(stagedOccupancy, { source: 'regression-test' });
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'robot_busy', 'mid-capture binary occupancy match must not complete robot job');
  assert.strictEqual(state.pendingRobotJob?.move, 'd5e4', 'robot job must stay pending until job-result');

  const promotionFen = '4k3/6P1/8/8/8/8/8/4K3 w - - 0 1';
  resetPhysicalSession(promotionFen);
  const promotionLifted = occupancyFromGame(physicalSession.game);
  promotionLifted[squareToIndex('g7')] = false;
  await processPhysicalSnapshot(promotionLifted, { source: 'regression-test' });
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'sync_warning', 'lifting a pawn with only promotion moves should be recoverable');
  assert.match(state.statusText, /no legal moves/i);
  assert.strictEqual(state.syncWarningReason?.type, 'no_legal_moves_lift');

  const stalemateSetupFen = '7k/5K2/8/6Q1/8/8/8/8 w - - 0 1';
  resetPhysicalSession(stalemateSetupFen);
  const stalemateLifted = occupancyFromGame(physicalSession.game);
  stalemateLifted[squareToIndex('g5')] = false;
  await processPhysicalSnapshot(stalemateLifted, { source: 'regression-test' });
  const stalemateComplete = occupancyFromGame(physicalSession.game);
  stalemateComplete[squareToIndex('g5')] = false;
  stalemateComplete[squareToIndex('g6')] = true;
  await processPhysicalSnapshot(stalemateComplete, { source: 'regression-test' });
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'game_over', 'stalemate move should end physical game');
  assert.match(state.statusText, /stalemate/i);
  assert.match(state.statusText, /draw/i);
  assert.strictEqual(state.gameStatus.draw, true, 'gameStatus should flag draw');
  assert.strictEqual(state.gameStatus.resultText, 'Draw by stalemate.');
  assert(
    physicalSession.commands.some((command) => command.type === 'led' && command.mode === 'celebrate-stalemate'),
    'stalemate should queue a celebration LED command'
  );

  const castleFen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  resetPhysicalSession(castleFen);
  const castleLifted = occupancyFromGame(physicalSession.game);
  castleLifted[squareToIndex('e1')] = false;
  await processPhysicalSnapshot(castleLifted, { source: 'regression-test' });
  const castleKingPlaced = occupancyFromGame(physicalSession.game);
  castleKingPlaced[squareToIndex('e1')] = false;
  castleKingPlaced[squareToIndex('g1')] = true;
  await processPhysicalSnapshot(castleKingPlaced, { source: 'regression-test' });
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'castle_pending_rook', 'placing king on castling target should wait for rook');
  assert.strictEqual(state.pendingCastleMove?.move, 'e1g1', 'pending castle move should be stored');
  assert.match(state.statusText, /rook from h1 to f1/i);

  const castleComplete = occupancyFromGame(physicalSession.game);
  castleComplete[squareToIndex('e1')] = false;
  castleComplete[squareToIndex('g1')] = true;
  castleComplete[squareToIndex('h1')] = false;
  castleComplete[squareToIndex('f1')] = true;
  await processPhysicalSnapshot(castleComplete, { source: 'regression-test' });
  assert.strictEqual(physicalSession.game.history()[0], 'O-O', 'completed king+rook occupancy should commit castling');

  resetPhysicalSession(castleFen);
  const castleCancelLifted = occupancyFromGame(physicalSession.game);
  castleCancelLifted[squareToIndex('e1')] = false;
  await processPhysicalSnapshot(castleCancelLifted, { source: 'regression-test' });
  const castleCancelKingPlaced = occupancyFromGame(physicalSession.game);
  castleCancelKingPlaced[squareToIndex('e1')] = false;
  castleCancelKingPlaced[squareToIndex('g1')] = true;
  await processPhysicalSnapshot(castleCancelKingPlaced, { source: 'regression-test' });
  await processPhysicalSnapshot(occupancyFromGame(physicalSession.game), { source: 'regression-test' });
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'ready', 'returning king should cancel pending castle');
  assert.strictEqual(state.pendingCastleMove, null, 'cancelled castle should clear pending move');

  const staleFen = 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1';
  resetPhysicalSession(staleFen);
  physicalSession.autoRobotReply = true;
  const staleOccupancy = occupancyFromGame(physicalSession.game);
  staleOccupancy[squareToIndex('a7')] = false;
  physicalSession.occupancy = staleOccupancy;
  await queueRobotReply();
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'sync_warning', 'robot planning should pause when sensor occupancy is stale');
  assert.strictEqual(state.syncWarningReason?.type, 'robot_planning_stale_snapshot');
  assert.strictEqual(state.pendingRobotJob, null, 'stale snapshot should not queue a robot job');

  const settleFen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  resetPhysicalSession(settleFen);
  physicalSession.postRobotSettleGuard = { reason: 'robot_move', armedAt: Date.now() };
  const offCenterKnight = occupancyFromGame(physicalSession.game);
  offCenterKnight[squareToIndex('g1')] = false;
  await processPhysicalSnapshot(offCenterKnight, { source: 'regression-test' });
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'sync_warning', 'post-robot one-piece miss should ask for centering');
  assert.strictEqual(state.syncWarningReason?.type, 'post_robot_settle_missing');
  assert.strictEqual(state.selectedSource, null, 'post-robot one-piece miss should not become a lifted move source');
  assert.match(state.statusText, /center/i);
  await processPhysicalSnapshot(occupancyFromGame(physicalSession.game), { source: 'regression-test' });
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'ready', 'clean snapshot should clear post-robot settle warning');
  assert.strictEqual(state.postRobotSettleGuard, null, 'clean snapshot should clear post-robot settle guard');

  const robotCastleFen = 'r3k2r/8/8/8/8/8/8/R3K2R b kq - 0 1';
  resetPhysicalSession(robotCastleFen);
  const castleMove = physicalSession.game.moves({ verbose: true })
    .find((move) => legalMoveMatchesUci(move, 'e8g8'));
  assert(castleMove, 'black kingside castling should be legal in castle failure regression');
  const castleCommand = buildRobotMoveCommand(castleMove);
  const preMoveFen = physicalSession.game.fen();
  const appliedCastle = physicalSession.game.move({ from: 'e8', to: 'g8' });
  physicalSession.phase = 'robot_busy';
  physicalSession.pendingRobotJob = {
    id: 'robot-castle-failure-regression',
    uci: 'e8g8',
    san: appliedCastle.san,
    command: castleCommand,
    preMoveFen,
    applied: true,
    appliedMove: {
      from: appliedCastle.from,
      to: appliedCastle.to,
      promotion: appliedCastle.promotion || null,
      san: appliedCastle.san
    }
  };
  const failedCastleOccupancy = occupancyFromGame(new Chess(preMoveFen));
  failedCastleOccupancy[squareToIndex('e8')] = false;
  pausePendingRobotJobAfterFailure('Drop verification failed after nudge attempts during castle-king at step 4', failedCastleOccupancy);
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'sync_warning', 'partial robot castling failure should be recoverable');
  assert.match(state.statusText, /restore\/center/i);
  assert.strictEqual(state.pendingRobotJob?.move, 'e8g8', 'failed castle job should remain pending for controlled retry');
  assert(state.board.missingSquares.includes('e8'), 'failed castle warning should highlight missing king source square');

  const humanE4 = makeMoveLogEntry('human', PHYSICAL_START_FEN, 'e2e4');
  const robotE5 = makeMoveLogEntry('robot', humanE4.afterFen, 'e7e5');
  resetPhysicalSession(robotE5.afterFen);
  physicalSession.moveLog = [humanE4, robotE5];
  let undoResult = startPhysicalUndoTurn();
  assert.strictEqual(undoResult.success, true, 'undo turn should start after human+robot moves');
  assert.strictEqual(physicalSession.phase, 'undo_robot_busy');
  assert.strictEqual(physicalSession.pendingRobotJob?.kind, 'undo');
  completePendingUndoRobotJob(occupancyFromFen(robotE5.beforeFen));
  assert.strictEqual(physicalSession.phase, 'undo_robot_busy', 'full-turn undo should continue to human move after robot step');
  assert.match(physicalSession.pendingRobotJob?.san || '', /e4/);
  completePendingUndoRobotJob(occupancyFromFen(humanE4.beforeFen));
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'ready', 'full-turn undo should return to ready');
  assert.strictEqual(physicalSession.game.history().length, 0, 'full-turn undo should restore start position');
  assert.strictEqual(physicalSession.moveLog.length, 0, 'full-turn undo should remove both move-log entries');
  assert.strictEqual(state.canRedoPhysical, true, 'full-turn undo should make redo available');
  assert.strictEqual(physicalSession.redoStack.length, 1, 'full-turn undo should preserve one redo turn group');

  let redoResult = startPhysicalRedoTurn();
  assert.strictEqual(redoResult.success, true, 'redo turn should start after full-turn undo');
  assert.strictEqual(physicalSession.phase, 'redo_robot_busy');
  assert.strictEqual(physicalSession.pendingRobotJob?.kind, 'redo');
  assert.strictEqual(physicalSession.pendingRobotJob?.uci, 'e2e4');
  completePendingRedoRobotJob(occupancyFromFen(humanE4.afterFen));
  assert.strictEqual(physicalSession.phase, 'redo_robot_busy', 'redo should continue to robot reply after human move');
  assert.strictEqual(physicalSession.pendingRobotJob?.uci, 'e7e5');
  completePendingRedoRobotJob(occupancyFromFen(robotE5.afterFen));
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'ready', 'redo should return to ready');
  assert.strictEqual(physicalSession.game.fen(), robotE5.afterFen, 'redo should restore the original post-turn FEN');
  assert.strictEqual(physicalSession.moveLog.length, 2, 'redo should restore both move-log entries');
  assert.strictEqual(physicalSession.moveLog[0].side, 'human', 'redo should preserve original human move side');
  assert.strictEqual(physicalSession.moveLog[1].side, 'robot', 'redo should preserve original robot move side');
  assert.strictEqual(state.canRedoPhysical, false, 'redo stack should be empty after replaying the only undone turn');

  const humanNf3 = makeMoveLogEntry('human', PHYSICAL_START_FEN, 'g1f3');
  const robotD5 = makeMoveLogEntry('robot', humanNf3.afterFen, 'd7d5');
  resetPhysicalSession(robotD5.afterFen);
  physicalSession.moveLog = [humanNf3, robotD5];
  undoResult = startPhysicalUndoTurn();
  assert.strictEqual(undoResult.success, true, 'undo turn should start after opening knight move');
  completePendingUndoRobotJob(occupancyFromFen(robotD5.beforeFen));
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'undo_waiting_human_restore', 'blocked human knight undo should ask for manual restore');
  assert.strictEqual(state.pendingRobotJob, null, 'manual human undo restore should not leave a robot job pending');
  assert.strictEqual(state.pendingUndo?.waitingForHumanRestore?.manualMoveBack, true);
  assert(state.pendingUndo?.waitingForHumanRestore?.restoreSquares?.includes('g1'), 'manual restore should highlight the knight home square');
  await processPhysicalSnapshot(occupancyFromFen(humanNf3.beforeFen), { source: 'regression-test' });
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'ready', 'manual knight restore should complete undo');
  assert.strictEqual(physicalSession.moveLog.length, 0, 'manual knight restore should remove both move-log entries');

  const robotCaptureFen = 'rnbqkbnr/ppp1pppp/8/3p4/4PP2/8/PPPP2PP/RNBQKBNR b KQkq - 0 2';
  const graveyardSlot = normalizeGraveyardSlots(DEFAULT_Z_GRAVEYARD_SLOTS).find((slot) => slot.label === 'Z4');
  const robotCapture = makeMoveLogEntry('robot', robotCaptureFen, 'd5e4', {
    robotGraveyardSlot: graveyardSlot,
    robotCapturedPathSquares: ['e4', 'a4']
  });
  resetPhysicalSession(robotCapture.afterFen);
  physicalSession.moveLog = [robotCapture];
  physicalSession.robotGraveyardOccupied = ['Z4'];
  undoResult = startPhysicalUndoTurn();
  assert.strictEqual(undoResult.success, true, 'robot capture undo should start');
  completePendingUndoRobotJob(occupancyFromFen(robotCapture.beforeFen));
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'ready', 'robot capture undo should complete');
  assert.strictEqual(physicalSession.moveLog.length, 0);
  assert(!physicalSession.robotGraveyardOccupied.includes('Z4'), 'robot capture undo should free the restored graveyard slot');

  const humanCaptureFen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  const humanCapture = makeMoveLogEntry('human', humanCaptureFen, 'e4d5');
  resetPhysicalSession(humanCapture.afterFen);
  physicalSession.moveLog = [humanCapture];
  undoResult = startPhysicalUndoTurn();
  assert.strictEqual(undoResult.success, true, 'human capture undo should start');
  completePendingUndoRobotJob(occupancyWithSquare(humanCapture.beforeFen, humanCapture.capturedSquare, false));
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'undo_waiting_human_restore', 'human capture undo should wait for manual captured-piece restore');
  assert.strictEqual(state.pendingUndo?.waitingForHumanRestore?.restoreSquares?.[0], humanCapture.capturedSquare);
  await processPhysicalSnapshot(occupancyFromFen(humanCapture.beforeFen), { source: 'regression-test' });
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'ready', 'human captured-piece restore should complete undo');
  assert.strictEqual(physicalSession.game.fen(), humanCapture.beforeFen);
  assert.strictEqual(physicalSession.moveLog.length, 0);

  const humanG4 = makeMoveLogEntry('human', PHYSICAL_START_FEN, 'g2g4');
  const robotD5AfterG4 = makeMoveLogEntry('robot', humanG4.afterFen, 'd7d5');
  const humanH4 = makeMoveLogEntry('human', robotD5AfterG4.afterFen, 'h2h4');
  const robotBxg4 = makeMoveLogEntry('robot', humanH4.afterFen, 'c8g4', {
    robotGraveyardSlot: normalizeGraveyardSlots(DEFAULT_Z_GRAVEYARD_SLOTS).find((slot) => slot.label === 'Z5'),
    robotCapturedPathSquares: ['g4', 'h5']
  });
  resetPhysicalSession(robotBxg4.afterFen);
  physicalSession.moveLog = [humanG4, robotD5AfterG4, humanH4, robotBxg4];
  physicalSession.robotGraveyardOccupied = ['Z5'];
  undoResult = startPhysicalUndoTurn();
  assert.strictEqual(undoResult.success, true, 'undo turn should start after robot capture');
  completePendingUndoRobotJob(occupancyFromFen(robotBxg4.beforeFen));
  assert.strictEqual(physicalSession.phase, 'undo_robot_busy', 'robot capture undo should continue to human move');
  const missingRestoredCapture = occupancyFromFen(humanH4.beforeFen);
  missingRestoredCapture[squareToIndex('g4')] = false;
  completePendingUndoRobotJob(missingRestoredCapture);
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'undo_waiting_human_restore', 'residual missing square after undo should wait for board restore');
  assert.strictEqual(state.pendingRobotJob, null, 'residual undo mismatch should not keep the completed job pending for retry');
  assert.strictEqual(state.pendingUndo?.waitingForHumanRestore?.boardRestore, true);
  assert(state.pendingUndo?.waitingForHumanRestore?.restoreSquares?.includes('g4'), 'residual restore should highlight g4');
  assert.strictEqual(physicalSession.moveLog.length, 2, 'completed undo steps should be removed before waiting for board restore');
  await processPhysicalSnapshot(occupancyFromFen(humanH4.beforeFen), { source: 'regression-test' });
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'ready', 'restoring residual missing square should finish undo');
  assert.strictEqual(physicalSession.moveLog.length, 2, 'undoing the last turn should leave earlier turn entries intact');

  resetPhysicalSession(robotE5.afterFen);
  physicalSession.moveLog = [humanE4, robotE5];
  const staleUndoOccupancy = occupancyFromFen(robotE5.afterFen);
  staleUndoOccupancy[squareToIndex('e5')] = false;
  physicalSession.occupancy = staleUndoOccupancy;
  undoResult = startPhysicalUndoTurn();
  assert.strictEqual(undoResult.success, false, 'undo should reject stale board occupancy');
  state = serializePhysicalState();
  assert.strictEqual(state.phase, 'sync_warning');
  assert.strictEqual(state.syncWarningReason?.type, 'undo_stale_board');

  console.log(JSON.stringify({
    success: true,
    checked: [
      'no-legal-move rook lift enters sync_warning',
      'placing rook back returns physical board to ready',
      'mid-capture occupancy snapshot does not prematurely commit robot move',
      'promotion-only pawn lift is treated as no legal physical move',
      'stalemate is reported as draw in physical mode',
      'gameStatus and celebration LEDs are emitted for draw',
      'human castling waits for rook and commits O-O',
      'pending human castling can be cancelled by returning the king',
      'robot planning pauses when latest sensor snapshot is stale',
      'post-robot one-piece miss asks for centering instead of legal move LEDs',
      'partial robot castling failure enters recoverable sync warning',
      'physical undo turn reverses robot and human non-captures',
      'physical redo turn replays undone human and robot moves',
      'blocked human knight undo falls back to manual restore',
      'physical undo restores robot-captured piece from graveyard',
      'physical undo waits for human-captured piece restore',
      'physical undo residual mismatch waits for board restore instead of retrying completed job',
      'physical undo rejects stale board occupancy'
    ]
  }, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
