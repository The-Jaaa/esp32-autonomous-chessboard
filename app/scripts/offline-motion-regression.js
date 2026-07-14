const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Chess } = require('chess.js');
const {
  physicalPlanner: {
    DEFAULT_GRAVEYARD_SLOTS,
    withPhysicalPlanningContext,
    buildBoardTransferPlan,
    buildCaptureMotionPlan,
    buildCaptureBoardStagingFallback,
    buildCastleMotionPlan,
    findStagingSquareCandidates,
    capturedSquareForMove,
    castleRookMove,
    legalMoveMatchesUci,
    moveToUci
  },
  physicalBoardTest: {
    physicalSession,
    squareToIndex
  }
} = require('../server');

const root = path.resolve(__dirname, '..', '..');
const outputDir = path.join(root, 'tmp', 'offline-motion');
const executablePath = path.join(outputDir, 'offline_motion_host.exe');
const fixturePath = path.join(outputDir, 'motion-fixtures.tsv');
const allSlotKeys = DEFAULT_GRAVEYARD_SLOTS.map((slot) => slot.label.toUpperCase());

const allSquares = [];
for (let rank = 1; rank <= 8; rank++) {
  for (const file of 'abcdefgh') allSquares.push(`${file}${rank}`);
}

const fixtures = [
  {
    id: 'quiet-direct-pawn',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    uci: 'e2e4', status: 'success'
  },
  {
    id: 'quiet-knight-lane',
    fen: '7k/8/8/pppppppp/3N4/8/8/K7 w - - 0 1',
    uci: 'd4e6', status: 'success'
  },
  {
    id: 'quiet-sensed-route-change',
    fen: '7k/8/8/8/8/8/2N5/K7 w - - 0 1',
    uci: 'c2e3', sensed: ['d2', 'd3'], status: 'success'
  },
  {
    id: 'capture-direct-early-pawn',
    fen: 'rnbqkbnr/1ppppp1p/8/p5p1/5P2/2P3P1/PP1PP2P/RNBQKBNR b KQkq - 0 3',
    uci: 'g5f4', status: 'success', expectedStrategy: 'capture-direct-after-removal'
  },
  {
    id: 'capture-direct-lane-attacker',
    fen: '7k/8/4p3/pppppppp/3N4/8/8/K7 w - - 0 1',
    uci: 'd4e6', status: 'success',
    expectedStrategy: 'capture-direct-after-removal',
    expectedPhaseModes: ['graveyard-board-path', 'lane']
  },
  {
    id: 'capture-stage-first',
    fen: 'rnbq3r/ppppBpkp/4p2n/1P4p1/4P3/7N/P1PP1PPP/RNQ1KB1R w KQ - 1 9',
    uci: 'e7d8', status: 'success', expectedStrategy: 'capture-stage-first-board'
  },
  {
    id: 'capture-remove-first-board',
    fen: 'rnb1k2r/2p5/2q1p2p/pP1p4/1PN4b/3BPQp1/2Pn1PPP/RNB1K2R b kq - 2 16',
    uci: 'g3f2', status: 'success', expectedStrategy: 'capture-remove-first-board'
  },
  {
    id: 'capture-en-passant',
    fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1',
    uci: 'e5d6', status: 'success'
  },
  {
    id: 'capture-full-graveyard',
    fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1',
    uci: 'e5d6', occupied: allSlotKeys, status: 'no_graveyard_capacity'
  },
  {
    id: 'capture-blocked-graveyard',
    fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1',
    uci: 'e5d6', slots: [{ label: 'Holding', x: 1, y: 2 }],
    status: 'no_graveyard_path'
  },
  {
    id: 'castle-white-kingside',
    fen: '4k3/8/8/8/8/8/8/4K2R w K - 0 1',
    uci: 'e1g1', status: 'success', expectedStrategy: 'castle-board'
  },
  {
    id: 'castle-white-queenside',
    fen: '4k3/8/8/8/8/8/8/R3K3 w Q - 0 1',
    uci: 'e1c1', status: 'success', expectedStrategy: 'castle-board'
  },
  {
    id: 'castle-black-kingside',
    fen: '4k2r/8/8/8/8/8/8/4K3 b k - 0 1',
    uci: 'e8g8', status: 'success', expectedStrategy: 'castle-board'
  },
  {
    id: 'castle-black-queenside',
    fen: 'r3k3/8/8/8/8/8/8/4K3 b q - 0 1',
    uci: 'e8c8', status: 'success', expectedStrategy: 'castle-board'
  },
  {
    id: 'castle-crowded-rook-reentry',
    fen: 'rn1qk2r/ppp2ppp/4p3/3p1b2/3PnP2/P1P1Q3/1BP1P1PP/R3KBNR b kq - 4 8',
    uci: 'e8g8', status: 'success'
  },
  {
    id: 'castle-no-safe-rook-route',
    fen: '4k3/8/8/8/8/8/8/4K2R w K - 0 1',
    uci: 'e1g1',
    sensed: allSquares.filter((square) => !['e1', 'f1', 'g1', 'h1'].includes(square)),
    occupied: allSlotKeys,
    status: 'no_safe_route'
  },
  {
    id: 'promotion-rejected',
    fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1',
    uci: 'a7a8q', status: 'unsupported_promotion'
  },
  {
    id: 'illegal-move-rejected',
    fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
    uci: 'e1e8', status: 'invalid_move'
  },
  {
    id: 'deterministic-repeat-a',
    fen: 'rnbqkbnr/1ppppp1p/8/p5p1/5P2/2P3P1/PP1PP2P/RNBQKBNR b KQkq - 0 3',
    uci: 'g5f4', status: 'success'
  },
  {
    id: 'deterministic-repeat-b',
    fen: 'rnbqkbnr/1ppppp1p/8/p5p1/5P2/2P3P1/PP1PP2P/RNBQKBNR b KQkq - 0 3',
    uci: 'g5f4', status: 'success'
  }
];

function encodeSlots(slots) {
  if (!slots) return 'DEFAULT';
  return slots.map((slot) => `${slot.label}:${slot.x}:${slot.y}`).join('|');
}

function fixtureLine(fixture) {
  return [
    fixture.id,
    fixture.fen,
    fixture.uci,
    (fixture.sensed || []).join(',') || '-',
    encodeSlots(fixture.slots),
    (fixture.occupied || []).join(',') || '-',
    fixture.status
  ].join('\t');
}

function occupancyForSquares(squares = []) {
  const occupancy = Array(64).fill(false);
  for (const square of squares) {
    const index = squareToIndex(square);
    assert(Number.isInteger(index), `Invalid square ${square}.`);
    occupancy[index] = true;
  }
  return occupancy;
}

function occupancyFromGame(game) {
  const occupied = [];
  for (const square of allSquares) {
    if (game.get(square)) occupied.push(square);
  }
  return occupancyForSquares(occupied);
}

function occupancyToken(occupancy) {
  return occupancy.map((value) => value ? '1' : '0').join('');
}

function number(value) {
  return String(Number(value));
}

function candidateToken(candidate) {
  return [
    candidate.slot,
    number(candidate.routeScore),
    number(candidate.routeCost),
    String(candidate.crowdingCost),
    (candidate.pathSquares || []).join(',')
  ].join('~');
}

function withFixtureContext(fixture, callback) {
  const previousOccupancy = physicalSession.occupancy.slice();
  return withPhysicalPlanningContext(fixture.fen, fixture.slots || [], (game) => {
    physicalSession.active = Boolean(fixture.sensed?.length);
    physicalSession.occupancy = occupancyForSquares(fixture.sensed || []);
    physicalSession.robotGraveyardOccupied = [...(fixture.occupied || [])];
    try {
      return callback(game);
    } finally {
      physicalSession.occupancy = previousOccupancy;
    }
  });
}

function expectedPhases(game, move, plan) {
  let occupancy = occupancyFromGame(game);
  const phases = [];
  const addTransfer = (kind, from, to) => {
    const before = occupancyToken(occupancy);
    occupancy[squareToIndex(from)] = false;
    occupancy[squareToIndex(to)] = true;
    phases.push({ kind, from, to, before, after: occupancyToken(occupancy) });
  };
  const addRemoval = (square) => {
    const before = occupancyToken(occupancy);
    occupancy[squareToIndex(square)] = false;
    phases.push({
      kind: 'captured-removal', from: square, to: plan.graveyardSlot.label,
      before, after: occupancyToken(occupancy)
    });
  };

  if (!move.captured && !move.flags.includes('k') && !move.flags.includes('q')) {
    addTransfer('quiet-transfer', move.from, move.to);
  } else if (move.flags.includes('k') || move.flags.includes('q')) {
    const rook = castleRookMove(move);
    addTransfer('castle-king', move.from, move.to);
    addTransfer('castle-rook', rook.from, rook.to);
  } else if (plan.captureStrategy === 'capture-stage-first-board' ||
             plan.captureStrategy === 'capture-board-staging') {
    const stageSquares = plan.capturePreview.stageSquares || [];
    const staging = stageSquares[stageSquares.length - 1];
    addTransfer('attacker-stage', move.from, staging);
    addRemoval(capturedSquareForMove(move));
    addTransfer('attacker-final', staging, move.to);
  } else {
    addRemoval(capturedSquareForMove(move));
    addTransfer('attacker-final', move.from, move.to);
  }
  return phases;
}

function jsPlan(fixture) {
  return withFixtureContext(fixture, (game) => {
    const move = game.moves({ verbose: true }).find((candidate) =>
      legalMoveMatchesUci(candidate, fixture.uci));
    if (!move) return { status: 'invalid_move' };
    if (move.promotion) return { status: 'unsupported_promotion' };

    let plan;
    try {
      if (move.flags.includes('k') || move.flags.includes('q')) {
        plan = buildCastleMotionPlan(game, move);
      } else if (move.captured) {
        const capturedSquare = capturedSquareForMove(move);
        const staging = findStagingSquareCandidates(game, move)?.[0] || null;
        plan = buildCaptureMotionPlan(game, move, capturedSquare, staging);
      } else {
        plan = buildBoardTransferPlan(game, move, move.from, move.to);
      }
    } catch (error) {
      const allOccupied = DEFAULT_GRAVEYARD_SLOTS.every((slot) =>
        (fixture.occupied || []).some((key) => key.toUpperCase() === slot.label.toUpperCase()));
      return {
        status: move.captured && allOccupied
          ? 'no_graveyard_capacity'
          : (move.captured && fixture.status === 'no_graveyard_path'
            ? 'no_graveyard_path'
            : 'no_safe_route'),
        blockedReason: error.message
      };
    }

    const after = new Chess(game.fen());
    assert(after.move(move), `${fixture.id}: JavaScript oracle could not apply ${fixture.uci}.`);
    return {
      status: 'success',
      strategy: move.captured
        ? plan.captureStrategy
        : (move.flags.includes('k') || move.flags.includes('q') ? plan.routeMode : 'quiet'),
      routeMode: plan.routeMode,
      cost: Number(plan.routeCost || 0),
      staging: plan.capturePreview?.stageSquares?.at(-1) || '-',
      graveyard: plan.graveyardSlot?.label || '-',
      candidates: (plan.graveyardRouteCandidates || []).map(candidateToken),
      raw: plan.rawPathSquares || [],
      compressed: plan.compressedPathSquares || [],
      phases: expectedPhases(game, move, plan),
      rejected: (plan.captureStrategyRejected || []).map((item) => ({
        strategy: item.strategy,
        staging: item.stagingSquare || '-',
        reason: item.error
      })),
      initial: occupancyToken(occupancyFromGame(game)),
      final: occupancyToken(occupancyFromGame(after))
    };
  });
}

function parsePhase(token) {
  const fields = token.split('~');
  return {
    kind: fields[0], from: fields[1], to: fields[2], mode: fields[3],
    cost: Number(fields[4]), raw: fields[5] ? fields[5].split(',') : [],
    compressed: fields[6] ? fields[6].split(',') : [],
    before: fields[7], after: fields[8]
  };
}

function parseRejected(token) {
  const fields = token.split('~');
  return { strategy: fields[0], staging: fields[1], reason: fields.slice(2).join('~') };
}

function rejectionReasonClass(reason = '') {
  if (reason.includes('No robot graveyard slot is available')) return 'graveyard-capacity';
  if (reason.includes('No clear graveyard route')) return 'graveyard-route';
  if (reason.includes('No safe route')) return 'transfer-route';
  return 'other';
}

function verifyDeepFallbackRegression() {
  const slot = DEFAULT_GRAVEYARD_SLOTS[0];
  const transfer = (from, to, phase) => ({
    routeMode: 'board-direct', routeCost: 10,
    pathSquares: [from, to], rawPathSquares: [from, to],
    compressedPathSquares: [from, to],
    steps: [
      { action: 'travel', phase }, { action: 'pickup', phase },
      { action: 'drag', phase, to: { type: 'square', square: to, index: squareToIndex(to) } },
      { action: 'drop', phase }, { action: 'verify', phase }
    ]
  });
  const removal = {
    slot, routeMode: 'graveyard-direct', routeCost: 510, routeScore: 10,
    pathSquares: ['d5', 'a5'], rawPathSquares: ['d5', 'a5'],
    compressedPathSquares: ['d5', 'a5'], targets: [], candidates: []
  };
  withPhysicalPlanningContext(
    '4k3/8/8/3p4/2B5/8/8/4K3 w - - 0 1',
    DEFAULT_GRAVEYARD_SLOTS,
    () => {
      const result = buildCaptureBoardStagingFallback(
        { from: 'c4', to: 'd5' }, 'd5',
        transfer('c4', 'c5', 'attacker-stage'), removal,
        transfer('c5', 'd5', 'attacker-final'), []
      );
      assert.strictEqual(result.captureStrategy, 'capture-board-staging');
      assert.strictEqual(result.graveyardSlot.label, slot.label);
      assert(physicalSession.robotGraveyardOccupied.includes(slot.label.toUpperCase()),
        'Deep capture fallback must reserve the selected online slot.');
    }
  );
}

verifyDeepFallbackRegression();
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(fixturePath, `${fixtures.map(fixtureLine).join('\n')}\n`);

const compiler = process.env.CXX || 'g++';
const compile = spawnSync(compiler, [
  '-std=c++17', '-O2', '-Wall', '-Wextra', '-Wpedantic', '-Wno-unused-but-set-variable',
  path.join(root, 'offline_core', 'offline_game.cpp'),
  path.join(root, 'offline_core', 'offline_physical.cpp'),
  path.join(root, 'offline_core', 'offline_route.cpp'),
  path.join(root, 'offline_core', 'offline_external_route.cpp'),
  path.join(root, 'offline_core', 'offline_motion.cpp'),
  path.join(root, 'tests_and_misc', 'offline_motion_host.cpp'),
  '-o', executablePath
], { encoding: 'utf8' });
if (compile.stdout) process.stdout.write(compile.stdout);
if (compile.stderr) process.stderr.write(compile.stderr);
assert.strictEqual(compile.status, 0, `Host C++ compilation failed with status ${compile.status}.`);

const run = spawnSync(executablePath, [fixturePath], { encoding: 'utf8', timeout: 30000 });
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
assert.strictEqual(run.error, undefined, `Host motion regressions failed to run: ${run.error?.message}`);
assert.strictEqual(run.status, 0, `Host motion regressions failed with status ${run.status}.`);

const results = new Map();
for (const line of run.stdout.split(/\r?\n/)) {
  const fields = line.split('\t');
  if (fields[0] !== 'MOTION') continue;
  results.set(fields[1], {
    status: fields[2], strategy: fields[3], cost: Number(fields[4]),
    staging: fields[5], graveyard: fields[6],
    candidates: fields[7] ? fields[7].split('^') : [],
    raw: fields[8] ? fields[8].split(',') : [],
    compressed: fields[9] ? fields[9].split(',') : [],
    phases: fields[10] ? fields[10].split('^').map(parsePhase) : [],
    rejected: fields[11] ? fields[11].split('^').map(parseRejected) : [],
    initial: fields[12], final: fields[13], blockedReason: fields[14]
  });
}

for (const fixture of fixtures) {
  const cpp = results.get(fixture.id);
  assert(cpp, `${fixture.id}: C++ result is missing.`);
  const js = jsPlan(fixture);
  assert.strictEqual(cpp.status, js.status, `${fixture.id}: status differs from JavaScript.`);
  if (js.status !== 'success') continue;
  assert.strictEqual(cpp.strategy, js.strategy, `${fixture.id}: strategy differs.`);
  if (fixture.expectedStrategy) {
    assert.strictEqual(cpp.strategy, fixture.expectedStrategy,
      `${fixture.id}: did not exercise the intended strategy.`);
  }
  assert.strictEqual(cpp.cost, js.cost, `${fixture.id}: route cost differs.`);
  assert.strictEqual(cpp.staging, js.staging, `${fixture.id}: staging square differs.`);
  assert.strictEqual(cpp.graveyard, js.graveyard, `${fixture.id}: graveyard slot differs.`);
  assert.deepStrictEqual(cpp.candidates, js.candidates, `${fixture.id}: graveyard candidates differ.`);
  assert.deepStrictEqual(cpp.raw, js.raw, `${fixture.id}: raw route differs.`);
  assert.deepStrictEqual(cpp.compressed, js.compressed, `${fixture.id}: compressed route differs.`);
  assert.strictEqual(cpp.initial, js.initial, `${fixture.id}: initial occupancy differs.`);
  assert.strictEqual(cpp.final, js.final, `${fixture.id}: final occupancy differs.`);
  assert.deepStrictEqual(
    cpp.phases.map(({ kind, from, to, before, after }) => ({ kind, from, to, before, after })),
    js.phases,
    `${fixture.id}: phase occupancy progression differs.`
  );
  assert.deepStrictEqual(
    cpp.rejected.map(({ strategy, staging }) => ({ strategy, staging })),
    js.rejected.map(({ strategy, staging }) => ({ strategy, staging })),
    `${fixture.id}: rejected strategy ordering differs.`
  );
  for (let index = 0; index < cpp.rejected.length; index++) {
    assert(cpp.rejected[index].reason && js.rejected[index].reason,
      `${fixture.id}: rejected strategy reason is missing.`);
    assert.strictEqual(
      rejectionReasonClass(cpp.rejected[index].reason),
      rejectionReasonClass(js.rejected[index].reason),
      `${fixture.id}: rejected strategy reason category differs.`
    );
  }
  if (fixture.expectedPhaseModes) {
    assert.deepStrictEqual(cpp.phases.map((phase) => phase.mode), fixture.expectedPhaseModes,
      `${fixture.id}: phase route modes differ from the reference fixture.`);
  }
  if (cpp.strategy === 'quiet') {
    assert.strictEqual(cpp.phases[0].mode, js.routeMode,
      `${fixture.id}: quiet phase route mode differs.`);
  }
}

const repeatA = results.get('deterministic-repeat-a');
const repeatB = results.get('deterministic-repeat-b');
assert.deepStrictEqual(
  { ...repeatA, blockedReason: '' },
  { ...repeatB, blockedReason: '' },
  'Repeated motion planning must be deterministic.'
);

console.log(JSON.stringify({
  success: true,
  compiler,
  parityFixtures: fixtures.length,
  deepOnlineFallbackRegression: true,
  transactionalGraveyardProposal: true,
  coordinatorLinked: false,
  firmwareLinked: false
}, null, 2));
