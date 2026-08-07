process.env.PHYSICAL_LOG_DISABLE = '1';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');
const {
  server,
  physicalBoardTest: {
    physicalSession,
    processPhysicalSnapshot,
    startPhysicalSession,
    startPhysicalUndoTurn,
    startPhysicalRedoTurn,
    completePendingUndoRobotJob,
    beginFixedPromotion,
    selectPhysicalPromotionIdentity,
    validatePhysicalCustomFen,
    occupancyFromFen,
    squareToIndex
  }
} = require('../server');

const HUMAN_FEN = '7k/P7/8/8/8/8/8/7K w - - 0 1';
const ROBOT_FEN = 'k7/8/1Q6/8/8/K7/p7/8 b - - 0 1';

function occupancyAfter(fen, uci) {
  const game = new Chess(fen);
  const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  assert(move, `Expected ${uci} to be legal.`);
  return occupancyFromFen(game.fen());
}

async function armHumanPromotion(fen = HUMAN_FEN, from = 'a7', to = 'a8') {
  startPhysicalSession({ setupMode: 'custom', initialFen: fen, humanColor: 'white' });
  physicalSession.autoRobotReply = false;
  const initial = occupancyFromFen(fen);
  await processPhysicalSnapshot(initial, { stable: true });
  const lifted = [...initial];
  lifted[squareToIndex(from)] = false;
  await processPhysicalSnapshot(lifted, { stable: true });
  const beforePlacement = [...lifted];
  if (initial[squareToIndex(to)]) {
    beforePlacement[squareToIndex(to)] = false;
    await processPhysicalSnapshot(beforePlacement, { stable: true });
  }
  const placed = [...beforePlacement];
  placed[squareToIndex(to)] = true;
  await processPhysicalSnapshot(placed, { stable: true });
  assert.strictEqual(physicalSession.phase, 'human_promotion_awaiting_removal');
  assert.strictEqual(physicalSession.game.fen(), validatePhysicalCustomFen(fen));
  return { initial, placed };
}

async function replaceAndCommit(piece, placed) {
  const id = physicalSession.pendingPromotion.id;
  const removed = [...placed];
  removed[squareToIndex(physicalSession.pendingPromotion.to)] = false;
  await processPhysicalSnapshot(removed, {
    stable: true,
    promotionDisplay: { transactionId: id, state: 'cycle', displayedPiece: piece }
  });
  assert.strictEqual(physicalSession.pendingPromotion.removalObserved, true);
  await processPhysicalSnapshot(placed, {
    stable: true,
    promotionDisplay: { transactionId: id, state: 'cycle', displayedPiece: piece }
  });
  assert(physicalSession.pendingPromotion, 'Promotion must remain pending for the stability interval.');
  physicalSession.pendingPromotion.stableSince = Date.now() - 501;
  await processPhysicalSnapshot(placed, {
    stable: true,
    promotionDisplay: { transactionId: id, state: 'locked', displayedPiece: piece }
  });
}

async function testHumanChoices() {
  for (const piece of ['q', 'r', 'b', 'n']) {
    const { placed } = await armHumanPromotion();
    if (piece === 'q') {
      const selected = selectPhysicalPromotionIdentity({
        piece,
        transactionId: physicalSession.pendingPromotion.id,
        expectedSessionGeneration: physicalSession.sessionGeneration
      });
      assert.strictEqual(selected.success, true);
      assert.strictEqual(physicalSession.pendingPromotion.selectionSource, 'app');
      assert.strictEqual(selectPhysicalPromotionIdentity({
        piece: 'n',
        transactionId: 'stale',
        expectedSessionGeneration: physicalSession.sessionGeneration
      }).status, 409);
      physicalSession.pendingPromotion.stableSince = Date.now() - 501;
      await processPhysicalSnapshot(placed, { stable: true });
      assert(physicalSession.pendingPromotion, 'app selection must not commit before an empty-square removal is observed');
    }
    await replaceAndCommit(piece, placed);
    assert.strictEqual(physicalSession.pendingPromotion, null);
    assert.strictEqual(new Chess(physicalSession.game.fen()).get('a8').type, piece);
    assert.strictEqual(physicalSession.moveLog[0].uci, `a7a8${piece}`);
  }
}

async function testCapturePromotion() {
  const fen = '1r5k/P7/8/8/8/8/8/7K w - - 0 1';
  const { placed } = await armHumanPromotion(fen, 'a7', 'b8');
  await replaceAndCommit('r', placed);
  assert.strictEqual(physicalSession.moveLog[0].uci, 'a7b8r');
  assert.strictEqual(physicalSession.moveLog[0].capturedPiece, 'r');
}

async function testRobotPromotion() {
  startPhysicalSession({ setupMode: 'custom', initialFen: ROBOT_FEN, humanColor: 'white' });
  physicalSession.autoRobotReply = false;
  physicalSession.phase = 'robot_busy';
  physicalSession.occupancy = occupancyFromFen(ROBOT_FEN);
  const move = physicalSession.game.moves({ verbose: true }).find((candidate) => candidate.from === 'a2' && candidate.to === 'a1' && candidate.promotion === 'q');
  physicalSession.pendingRobotJob = {
    id: 'robot-promotion-test',
    kind: 'move',
    uci: 'a2a1q',
    san: move.san,
    preMoveFen: ROBOT_FEN,
    command: {},
    applied: false
  };
  const placed = occupancyAfter(ROBOT_FEN, 'a2a1q');
  const started = beginFixedPromotion({ actor: 'robot', operation: 'move', move, occupancy: placed, pendingJob: physicalSession.pendingRobotJob });
  assert.strictEqual(started.success, true);
  assert.strictEqual(physicalSession.game.fen(), ROBOT_FEN);
  await replaceAndCommit('q', placed);
  assert.strictEqual(physicalSession.game.fen(), 'k7/8/1Q6/8/8/K7/8/q7 w - - 0 2');
  assert.strictEqual(physicalSession.moveLog[0].uci, 'a2a1q');
}

async function testPromotionUndoRedo() {
  const { initial, placed } = await armHumanPromotion();
  await replaceAndCommit('n', placed);
  assert.strictEqual(startPhysicalUndoTurn().success, true);
  assert.strictEqual(physicalSession.pendingPromotion.operation, 'undo');
  const undoPromotionId = physicalSession.pendingPromotion.id;
  const removed = [...placed];
  removed[squareToIndex('a8')] = false;
  await processPhysicalSnapshot(removed, { stable: true, promotionDisplay: { transactionId: undoPromotionId, displayedPiece: 'p' } });
  await processPhysicalSnapshot(placed, { stable: true, promotionDisplay: { transactionId: undoPromotionId, displayedPiece: 'p' } });
  physicalSession.pendingPromotion.stableSince = Date.now() - 501;
  await processPhysicalSnapshot(placed, { stable: true, promotionDisplay: { transactionId: undoPromotionId, displayedPiece: 'p' } });
  assert.strictEqual(physicalSession.phase, 'undo_robot_busy');
  const undoResult = completePendingUndoRobotJob(initial);
  assert.strictEqual(undoResult.success, true);
  assert.strictEqual(physicalSession.game.fen(), HUMAN_FEN);

  assert.strictEqual(startPhysicalRedoTurn().success, true);
  const redoMove = physicalSession.game.moves({ verbose: true }).find((candidate) => candidate.from === 'a7' && candidate.to === 'a8' && candidate.promotion === 'n');
  const redoStarted = beginFixedPromotion({
    actor: 'redo',
    operation: 'redo',
    move: redoMove,
    occupancy: placed,
    pendingJob: physicalSession.pendingRobotJob,
    entry: physicalSession.pendingRobotJob.redo.entry
  });
  assert.strictEqual(redoStarted.success, true);
  const redoId = physicalSession.pendingPromotion.id;
  await processPhysicalSnapshot(removed, { stable: true, promotionDisplay: { transactionId: redoId, displayedPiece: 'n' } });
  await processPhysicalSnapshot(placed, { stable: true, promotionDisplay: { transactionId: redoId, displayedPiece: 'n' } });
  physicalSession.pendingPromotion.stableSince = Date.now() - 501;
  await processPhysicalSnapshot(placed, { stable: true, promotionDisplay: { transactionId: redoId, displayedPiece: 'n' } });
  assert.strictEqual(physicalSession.pendingPromotion, null);
  assert.strictEqual(physicalSession.game.get('a8').type, 'n');
}

function testCustomFenValidation() {
  assert.strictEqual(validatePhysicalCustomFen(HUMAN_FEN), HUMAN_FEN);
  const statefulFen = 'r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1';
  assert.strictEqual(validatePhysicalCustomFen(statefulFen), statefulFen, 'turn, castling, and en-passant state must be preserved');
  assert.throws(() => validatePhysicalCustomFen('8/8/8/8/8/8/8/8 w - - 0 1'), /king/i);
  assert.throws(() => validatePhysicalCustomFen('P6k/8/8/8/8/8/8/7K w - - 0 1'), /pawns?.*(edge|rank)|edge rows/i);
}

function matrixPixelToStrip(row, column) {
  const fileIndex = Math.floor(row / 2);
  const rank = Math.floor(column / 2) + 1;
  const rawGroup = 7 - fileIndex;
  const rankOffset = rawGroup % 2 === 0 ? 8 - rank : rank - 1;
  const rawSquare = rawGroup * 8 + rankOffset;
  const offsets = [[1, 2, 0, 3], [2, 1, 3, 0], [0, 3, 1, 2], [2, 1, 3, 0], [1, 2, 0, 3], [2, 1, 3, 0], [1, 2, 0, 3], [3, 0, 2, 1]];
  return rawSquare * 4 + offsets[fileIndex][(row % 2) * 2 + (column % 2)];
}

function testFirmwareMappingAndTiming() {
  const pixels = new Set();
  for (let row = 0; row < 16; row++) {
    for (let column = 0; column < 16; column++) pixels.add(matrixPixelToStrip(row, column));
  }
  assert.strictEqual(pixels.size, 256);
  assert.deepStrictEqual([...pixels].sort((a, b) => a - b), Array.from({ length: 256 }, (_, index) => index));
  const source = fs.readFileSync(path.join(__dirname, '../../esp32_firmware/esp32_firmware.ino'), 'utf8');
  assert(source.includes('promotionLedDisplay.intervalMs = command["intervalMs"] | 2500'));
  assert(source.includes('promotionLedDisplay.targetIndex = command["targetIndex"] | -1'));
  assert(source.includes('setSquareColor(promotionLedDisplay.targetIndex, 255, 180, 40)'));
  assert(source.includes("static const char choices[4] = {'q', 'r', 'b', 'n'}"));
  assert(source.includes("case 'p': return pawn"));
  assert(source.includes('static const uint8_t queen[9] = {0x3E, 0x41, 0x41, 0x41, 0x41, 0x49, 0x45, 0x3E, 0x03}'));
  assert(source.includes('static const uint8_t rook[9] = {0x7E, 0x41, 0x41, 0x41, 0x7E, 0x48, 0x44, 0x42, 0x41}'));
  const promotionCommandStart = source.indexOf('void applyPromotionLedCommand(JsonObject command) {');
  const promotionCommand = source.slice(
    promotionCommandStart,
    source.indexOf('void servicePromotionLedDisplay', promotionCommandStart)
  );
  assert(promotionCommand.includes('activeLedAnimation = LED_ANIM_NONE'));
  const elapsed = (now, start) => (now - start) >>> 0;
  assert.strictEqual(elapsed(2499, 0) < 2500, true);
  assert.strictEqual(elapsed(2500, 0) >= 2500, true);
  assert.strictEqual(elapsed(100, 0xfffffff0), 116);
}

async function run() {
  testCustomFenValidation();
  testFirmwareMappingAndTiming();
  await testHumanChoices();
  await testCapturePromotion();
  await testRobotPromotion();
  await testPromotionUndoRedo();
  console.log('Physical promotion regressions passed.');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => server.close());
