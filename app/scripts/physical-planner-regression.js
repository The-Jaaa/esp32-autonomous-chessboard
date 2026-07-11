const assert = require('assert');
const { Chess } = require('chess.js');
const {
  physicalPlanner: {
    PHYSICAL_START_FEN,
    DEFAULT_Z_GRAVEYARD_SLOTS,
    DEFAULT_GRAVEYARD_SLOTS,
    withPhysicalPlanningContext,
    buildRobotMoveCommand,
    summarizeMotionPlan,
    legalMoveMatchesUci,
    moveToUci
  }
} = require('../server');

function planMove(fen, uci, graveyardSlots = DEFAULT_Z_GRAVEYARD_SLOTS) {
  return withPhysicalPlanningContext(fen, graveyardSlots, (game) => {
    const move = game.moves({ verbose: true })
      .find((candidate) => legalMoveMatchesUci(candidate, uci));
    assert(move, `${uci} must be legal in ${fen}`);
    return summarizeMotionPlan(buildRobotMoveCommand(move));
  });
}

function planAll(fen, graveyardSlots = DEFAULT_Z_GRAVEYARD_SLOTS) {
  return withPhysicalPlanningContext(fen, graveyardSlots, (game) => game.moves({ verbose: true })
    .filter((move) => !move.promotion || move.promotion === 'q')
    .map((move) => {
      try {
        return {
          move: moveToUci(move),
          san: move.san,
          success: true,
          command: summarizeMotionPlan(buildRobotMoveCommand(move))
        };
      } catch (err) {
        return {
          move: moveToUci(move),
          san: move.san,
          success: false,
          error: err.message
        };
      }
    }));
}

function routeTargets(summary) {
  return summary.plan
    .filter((step) => step.action === 'drag')
    .map((step) => step.to?.square || step.to?.label || `${step.to?.x},${step.to?.y}`);
}

function assertDirect(fen, uci) {
  const plan = planMove(fen, uci);
  assert.strictEqual(plan.routeMode, 'direct', `${uci} should be direct`);
  assert.deepStrictEqual(routeTargets(plan), [uci.slice(2, 4)], `${uci} should drag only to target square`);
}

function assertOneStepRoute(fen, uci) {
  const plan = planMove(fen, uci);
  assert(['direct', 'board-direct'].includes(plan.routeMode), `${uci} should be a one-step route`);
  assert.deepStrictEqual(routeTargets(plan), [uci.slice(2, 4)], `${uci} should drag only to target square`);
}

function assertBoardPath(fen, uci, expectedTargets) {
  const plan = planMove(fen, uci);
  assert(
    ['board-buffered', 'board-relaxed', 'board-direct', 'board-line'].includes(plan.routeMode),
    `${uci} should use a board path, got ${plan.routeMode}`
  );
  assert.deepStrictEqual(routeTargets(plan), expectedTargets, `${uci} should use the expected board waypoints`);
  assert(Number.isFinite(plan.routeCost), `${uci} should include route cost metadata`);
  assert.deepStrictEqual(plan.compressedPathSquares, [uci.slice(0, 2), ...expectedTargets], `${uci} should include compressed path metadata`);
  assert(Array.isArray(plan.rawPathSquares) && plan.rawPathSquares[0] === uci.slice(0, 2), `${uci} should include raw path metadata`);
}

function assertBlocked(fen, uci) {
  assert.throws(
    () => planMove(fen, uci),
    /No safe route|No safe capture route|No clear/,
    `${uci} should be blocked, not lane-routed through occupied pieces`
  );
}

function assertNoBlockedLaneLabels(plans) {
  for (const result of plans.filter((item) => item.success)) {
    const targets = routeTargets(result.command);
    const laneLabels = targets.filter((target) => /^[ZI][1-8]$/i.test(target));
    if (laneLabels.length > 0) {
      assert(
        result.command.routeMode !== 'direct',
        `${result.move} cannot be direct while using lane labels ${laneLabels.join(', ')}`
      );
    }
  }
}

function assertCaptureDirectAfterRemoval(fen, uci, expectedGraveyardPattern = /^[ZI][1-8]$/) {
  const plan = planMove(fen, uci);
  assert.strictEqual(plan.routeMode, 'capture-direct-after-removal', `${uci} should avoid staging when direct-after-removal is safe`);
  assert(routeTargets(plan).some((target) => expectedGraveyardPattern.test(target)), `${uci} should use a configured graveyard slot`);
  assert.strictEqual(plan.plan[0].action, 'led-capture-start', `${uci} should start with capture highlighting`);
  assert.strictEqual(plan.plan[2].to.square, uci.slice(2, 4), `${uci} should remove captured piece before moving attacker`);
  assert(plan.capturePreview, `${uci} should include capture preview metadata`);
  assert.strictEqual(plan.captureStrategy, 'capture-direct-after-removal', `${uci} should expose direct capture strategy metadata`);
  assert(Number.isFinite(plan.routeCost), `${uci} should include route cost metadata`);
}

function assertCapturedRemovalAvoidsAttackerSource() {
  const beforeLoggedRookCapture = '3rk1n1/ppp2p2/2np2p1/7r/4N2R/2P1K3/PP6/8 b - - 0 22';
  const remainingSlots = [
    { label: 'I8', x: 1500, y: -350 },
    { label: 'Z1', x: 29300, y: 34450 },
    { label: 'Z3', x: 21300, y: 34450 },
    { label: 'Z8', x: 1300, y: 34450 }
  ];
  const plan = planMove(beforeLoggedRookCapture, 'h5h4', remainingSlots);
  const capturedRemovalTargets = plan.plan
    .filter((step) => step.phase === 'captured-removal' && step.action === 'drag')
    .map((step) => step.to?.square || step.to?.label);

  assert.strictEqual(plan.captureStrategy, 'capture-direct-after-removal', 'adjacent rook capture should still remove the captured piece first');
  assert(!capturedRemovalTargets.includes('h5'), 'captured piece removal must not drag through the attacker source square h5');
  assert.notStrictEqual(plan.capturePreview?.graveyardLabel, 'I8', 'I8 route is unsafe here because the direct h-file route crosses h5');
}

function assertRobotCastlingRookAvoidsCastledKing() {
  const beforeLoggedCastle = 'rn1qk2r/ppp2ppp/4p3/3p1b2/3PnP2/P1P1Q3/1BP1P1PP/R3KBNR b KQkq - 4 8';
  const plan = planMove(beforeLoggedCastle, 'e8g8', DEFAULT_GRAVEYARD_SLOTS);
  const rookDragTargets = plan.plan
    .filter((step) => step.phase === 'castle-rook' && step.action === 'drag')
    .map((step) => step.to?.square || step.to?.label);

  assert.strictEqual(plan.routeMode, 'castle-lane-board', 'crowded black castling should use lane-board rook routing');
  assert(!rookDragTargets.includes('g8'), 'castling rook must not drag through the king on g8');
  assert(!rookDragTargets.includes('h7'), 'castling rook must not re-enter on occupied h7 pawn square');
  assert(rookDragTargets.includes('I8'), 'castling rook should exit through its same-rank I8 lane slot');
  assert(rookDragTargets.includes('I6'), 'castling rook should travel along the I lane before re-entering');
  assert(rookDragTargets.includes('h6'), 'castling rook should re-enter on a clear h-file square');
  assert.strictEqual(rookDragTargets[rookDragTargets.length - 1], 'f8', 'castling rook should finish on f8');
}

function assertCaptureStagedFirst(fen, uci) {
  const plan = planMove(fen, uci);
  assert.strictEqual(plan.routeMode, 'capture-stage-first-board', `${uci} should stage attacker only when direct capture is unsafe`);
  assert(plan.captureStrategyRejected.some((item) => item.strategy === 'capture-direct-after-removal'), `${uci} should explain why direct capture was rejected`);
}

function assertCaptureGraveyardOrder(fen, uci) {
  withPhysicalPlanningContext(fen, DEFAULT_Z_GRAVEYARD_SLOTS, (game) => {
    const move = game.moves({ verbose: true })
      .find((candidate) => legalMoveMatchesUci(candidate, uci));
    assert(move, `${uci} must be legal in ${fen}`);

    const first = summarizeMotionPlan(buildRobotMoveCommand(move));
    const second = summarizeMotionPlan(buildRobotMoveCommand(move));
    assert(routeTargets(first).includes('Z4'), 'first robot capture should reserve Z4');
    assert(routeTargets(second).includes('Z5'), 'second robot capture should reserve Z5');
  });
}

function assertGraveyardFullRejects(fen, uci) {
  const oneSlot = [{ label: 'Z4', x: 17300, y: 34450 }];
  withPhysicalPlanningContext(fen, oneSlot, (game) => {
    const move = game.moves({ verbose: true })
      .find((candidate) => legalMoveMatchesUci(candidate, uci));
    assert(move, `${uci} must be legal in ${fen}`);
    buildRobotMoveCommand(move);
    assert.throws(
      () => buildRobotMoveCommand(move),
      /No clear graveyard route|No robot graveyard slot/,
      'a full robot graveyard should reject another capture'
    );
  });
}

function run() {
  const afterF4 = 'rnbqkbnr/pppppppp/8/8/5P2/8/PPPPP1PP/RNBQKBNR b KQkq - 0 1';

  assertDirect(afterF4, 'e7e6');
  assertDirect(afterF4, 'e7e5');
  assertDirect(afterF4, 'b7b6');
  assertBlocked(afterF4, 'g8h6');

  const afterQd4 = 'rnbqkbnr/2p1pppp/p7/1p1p4/3QP3/2P5/PP1P1PPP/RNB1KBNR b KQkq - 1 4';
  assertOneStepRoute(afterQd4, 'a8a7');

  const afterBa3 = '1nbqkbnr/r1p1ppp1/p6p/1p1p4/1P1QP3/B1P5/P2P1PPP/RN2KBNR b KQk - 1 6';
  assertOneStepRoute(afterBa3, 'a7a8');

  const afterBxc6 = 'rnbqkbnr/4ppp1/p1B5/3p3p/1P1QP3/B1P2N2/P2P1PPP/RN2K2R b KQk - 0 9';
  assertOneStepRoute(afterBxc6, 'd8d7');

  const finalLoggedPosition = 'k1B3n1/8/6P1/1RB5/P2PpP2/4P3/P1P4P/4K2R b K - 8 36';
  assertBoardPath(finalLoggedPosition, 'g8h6', ['h7', 'h6']);
  assertBoardPath(finalLoggedPosition, 'g8f6', ['f7', 'f6']);
  assertBoardPath(finalLoggedPosition, 'g8e7', ['f8', 'e7']);

  const clearRookLane = '7k/8/8/8/8/8/8/R3K3 w - - 0 1';
  assertBoardPath(clearRookLane, 'a1a8', ['a8']);

  const allowedDiagonalCorner = '4k3/8/8/8/8/1p6/1Qp5/4K3 w - - 0 1';
  assertBoardPath(allowedDiagonalCorner, 'b2c3', ['c3']);
  assertRobotCastlingRookAvoidsCastledKing();

  const beforePawnCapture = 'rnbqkbnr/ppp1pppp/8/3p4/4PP2/8/PPPP2PP/RNBQKBNR b KQkq - 0 2';
  assertCaptureDirectAfterRemoval(beforePawnCapture, 'd5e4');
  assertCaptureGraveyardOrder(beforePawnCapture, 'd5e4');
  assertGraveyardFullRejects(beforePawnCapture, 'd5e4');

  const beforeQueenCapture = 'rnbqkbnr/ppp1pppp/8/8/4pP2/5Q2/PPPP2PP/RNB1KBNR b KQkq - 1 3';
  assertCaptureDirectAfterRemoval(beforeQueenCapture, 'e4f3');
  assertCapturedRemovalAvoidsAttackerSource();

  const promotionPosition = '4k3/6P1/8/8/8/8/8/4K3 w - - 0 1';
  const promotionPlans = planAll(promotionPosition);
  assert.strictEqual(
    promotionPlans.filter((result) => result.move.startsWith('g7g8') && result.success).length,
    0,
    'physical planner should omit all promotion moves'
  );

  const openingBlack = new Chess(PHYSICAL_START_FEN);
  openingBlack.move('a3');
  const openingPlans = planAll(openingBlack.fen());
  const pawnPlans = openingPlans.filter((item) => /^[a-h]7[a-h][56]$/.test(item.move));
  assert.strictEqual(pawnPlans.length, 16, 'black should have 16 opening pawn replies');
  for (const result of pawnPlans) {
    assert.strictEqual(result.success, true, `${result.move} should be routable`);
    assert.strictEqual(result.command.routeMode, 'direct', `${result.move} should be direct`);
  }

  const knightPlans = openingPlans.filter((item) => /^(b8|g8)/.test(item.move));
  assert.strictEqual(knightPlans.length, 4, 'black should have 4 opening knight replies');
  for (const result of knightPlans) {
    assert.strictEqual(result.success, false, `${result.move} should be blocked until an exit path is clear`);
  }

  assertNoBlockedLaneLabels(openingPlans);

  console.log(JSON.stringify({
    success: true,
    checked: {
      afterF4: ['e7e6 direct', 'e7e5 direct', 'b7b6 direct', 'g8h6 blocked while boxed in'],
      shortQuietMoves: ['a8a7 direct', 'a7a8 direct', 'd8d7 direct'],
      finalLoggedKnightReplies: ['g8h6 board path', 'g8f6 board path', 'g8e7 board path'],
      clearRookLane: 'a1a8 compressed board-line path',
      diagonalCornerCutting: 'b2c3 diagonal corner movement allowed',
      castlingRookSafety: 'e8g8 rook routes through I lane and avoids occupied g8/h7',
      capturedRemovalSafety: 'h5xh4 removal does not route through h5 attacker source',
      efficientCaptures: ['d5e4 direct-after-removal', 'e4f3 direct-after-removal'],
      graveyardOrder: ['Z4 first', 'Z5 second', 'full graveyard rejects'],
      promotionsDisabled: true,
      openingPawnReplies: pawnPlans.length,
      openingKnightRepliesBlocked: knightPlans.length
    }
  }, null, 2));
}

run();
