const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  physicalPlanner: {
    DEFAULT_GRAVEYARD_SLOTS,
    normalizeGraveyardSlots,
    withPhysicalPlanningContext,
    buildBoardTransferPlan,
    planCapturedPieceRemoval
  },
  physicalBoardTest: {
    physicalSession,
    squareToIndex
  }
} = require('../server');

const root = path.resolve(__dirname, '..', '..');
const outputDir = path.join(root, 'tmp', 'offline-external-route');
const executablePath = path.join(outputDir, 'offline_external_route_host.exe');
const fixturePath = path.join(outputDir, 'external-route-fixtures.tsv');
const allSlotKeys = DEFAULT_GRAVEYARD_SLOTS.map((slot) => slot.label.toUpperCase());

const slots = (...labels) => DEFAULT_GRAVEYARD_SLOTS.filter((slot) => labels.includes(slot.label));
const fixtures = [
  { kind: 'T', id: 'board-preferred', fen: '7k/8/8/8/8/8/8/R3K3 w - - 0 1', from: 'a1', to: 'a8' },
  { kind: 'T', id: 'direct-pawn-passthrough', fen: '7k/8/8/8/8/8/4P3/4K3 w - - 0 1', from: 'e2', to: 'e4', directWhenClear: true },
  { kind: 'T', id: 'forced-z-lane', fen: '7k/8/8/8/8/8/8/R3K3 w - - 0 1', from: 'a1', to: 'a8', forceLane: true },
  { kind: 'T', id: 'forced-i-lane', fen: '7k/8/8/8/8/8/8/4K2R w - - 0 1', from: 'h1', to: 'h8', forceLane: true },
  { kind: 'T', id: 'board-blocked-lane-fallback', fen: '7k/8/8/8/pppppppp/8/1R6/K7 w - - 0 1', from: 'b2', to: 'g7' },
  { kind: 'T', id: 'opposite-lane-fallback', fen: '7k/8/8/8/2pR4/8/8/K7 w - - 0 1', from: 'd4', to: 'd6', forceLane: true },
  {
    kind: 'T', id: 'same-side-pair-required',
    fen: 'k7/8/8/3n4/pppppppp/2p5/4NNR1/4BKR1 b - - 1 1',
    from: 'd5', to: 'e3', forceLane: true
  },
  { kind: 'T', id: 'occupied-source-slot', fen: '7k/8/8/8/8/8/8/R3K3 w - - 0 1', from: 'a1', to: 'a8', forceLane: true, occupied: ['Z1'] },
  {
    kind: 'T', id: 'lane-board-reentry',
    fen: 'rn1q2kr/ppp2ppp/4p3/3p1b2/3PnP2/P1P1Q3/1BP1P1PP/R3KBNR b - - 5 8',
    from: 'h8', to: 'f8', forceLane: true
  },
  {
    kind: 'T', id: 'lane-board-sensed-entry',
    fen: 'rn1q2kr/ppp2ppp/4p3/3p1b2/3PnP2/P1P1Q3/1BP1P1PP/R3KBNR b - - 5 8',
    from: 'h8', to: 'f8', forceLane: true, sensed: ['h6']
  },
  {
    kind: 'T', id: 'occupied-lane-transit',
    fen: 'rn1q2kr/ppp2ppp/4p3/3p1b2/3PnP2/P1P1Q3/1BP1P1PP/R3KBNR b - - 5 8',
    from: 'h8', to: 'f8', forceLane: true, occupied: ['I7']
  },
  { kind: 'T', id: 'preferred-lane-override', fen: '7k/R7/8/8/8/8/8/K7 w - - 0 1', from: 'a7', to: 'a2', forceLane: true, preferred: 'I' },
  { kind: 'T', id: 'repeat-lane-a', fen: '7k/8/8/8/8/8/8/R3K3 w - - 0 1', from: 'a1', to: 'a8', forceLane: true },
  { kind: 'T', id: 'repeat-lane-b', fen: '7k/8/8/8/8/8/8/R3K3 w - - 0 1', from: 'a1', to: 'a8', forceLane: true },
  { kind: 'T', id: 'all-slots-occupied', fen: '7k/8/8/8/8/8/8/R3K3 w - - 0 1', from: 'a1', to: 'a8', forceLane: true, occupied: allSlotKeys },
  { kind: 'T', id: 'malformed-lane-slots', fen: '7k/8/8/8/8/8/8/R3K3 w - - 0 1', from: 'a1', to: 'a8', forceLane: true, slots: [{ label: 'X1', x: 1, y: 2 }] },
  {
    kind: 'G', id: 'graveyard-default-middle',
    fen: 'rnbqkbnr/ppp1pppp/8/3p4/4PP2/8/PPPP2PP/RNBQKBNR b KQkq - 0 2',
    from: 'e4', ignored: ['e4', 'd5']
  },
  {
    kind: 'G', id: 'graveyard-z4-occupied',
    fen: 'rnbqkbnr/ppp1pppp/8/3p4/4PP2/8/PPPP2PP/RNBQKBNR b KQkq - 0 2',
    from: 'e4', ignored: ['e4', 'd5'], occupied: ['Z4']
  },
  {
    kind: 'G', id: 'graveyard-edge-direct',
    fen: '7k/8/8/8/P7/8/8/K7 w - - 0 1',
    from: 'a4', ignored: ['a4'], slots: slots('Z4')
  },
  {
    kind: 'G', id: 'graveyard-route-beats-order',
    fen: '3rk1n1/ppp2p2/2np2p1/7r/4N2R/2P1K3/PP6/8 b - - 0 22',
    from: 'h4', ignored: ['h4', 'h5'], slots: slots('I8', 'Z1', 'Z3', 'Z8')
  },
  {
    kind: 'G', id: 'graveyard-sensed-obstruction',
    fen: '7k/8/8/8/3P4/8/8/K7 w - - 0 1',
    from: 'd4', ignored: ['d4'], sensed: ['c3'], slots: slots('Z3', 'Z4', 'I4')
  },
  {
    kind: 'G', id: 'graveyard-full',
    fen: '7k/8/8/8/3P4/8/8/K7 w - - 0 1',
    from: 'd4', ignored: ['d4'], occupied: allSlotKeys
  },
  {
    kind: 'G', id: 'graveyard-malformed',
    fen: '7k/8/8/8/3P4/8/8/K7 w - - 0 1',
    from: 'd4', ignored: ['d4'], slots: [{ label: 'Holding', x: 100, y: 200 }]
  }
];

const normalizedDefaults = normalizeGraveyardSlots([]);
assert.strictEqual(normalizedDefaults.length, 16, 'Online default external slot count must remain 16.');
assert.deepStrictEqual(
  [normalizedDefaults[0].label, normalizedDefaults[0].x, normalizedDefaults[0].y],
  ['Z1', 29300, 34450],
  'Online Z1 coordinates changed.'
);
assert.deepStrictEqual(
  [normalizedDefaults[15].label, normalizedDefaults[15].x, normalizedDefaults[15].y],
  ['I1', 29600, -350],
  'Online I1 coordinates changed.'
);
assert.deepStrictEqual(
  normalizeGraveyardSlots([{ label: 'Captured 3', x: 1, y: 2 }])
    .map(({ label, lane, rank }) => ({ label, lane, rank })),
  [{ label: 'Z3', lane: 'Z', rank: 3 }],
  'Online Captured alias normalization changed.'
);
assert.deepStrictEqual(
  normalizeGraveyardSlots([{ label: ' i 6 ', x: 1, y: 2 }])
    .map(({ lane, rank }) => ({ lane, rank })),
  [{ lane: 'I', rank: 6 }],
  'Online whitespace lane normalization changed.'
);

function encodeSlots(input) {
  if (!input) return 'DEFAULT';
  return input.map((slot) => `${slot.label}:${slot.x}:${slot.y}`).join('|');
}

function fixtureLine(fixture) {
  return [
    fixture.kind,
    fixture.id,
    fixture.fen,
    fixture.from,
    fixture.to || '-',
    (fixture.sensed || []).join(',') || '-',
    (fixture.ignored || []).join(',') || '-',
    encodeSlots(fixture.slots),
    (fixture.occupied || []).join(',') || '-',
    fixture.forceLane ? '1' : '0',
    fixture.preferred || '-',
    fixture.directWhenClear ? '1' : '0'
  ].join('\t');
}

function occupancyForSquares(squares = []) {
  const occupancy = Array(64).fill(false);
  for (const square of squares) {
    const index = squareToIndex(square);
    assert(Number.isInteger(index), `Invalid sensed fixture square ${square}.`);
    occupancy[index] = true;
  }
  return occupancy;
}

function number(value) {
  return String(Number(value));
}

function targetToken(target) {
  if (target.type === 'square') return `S:${target.square}`;
  return `C:${target.role}:${target.label}:${target.lane || '-'}:${target.rank || 0}:${number(target.x)}:${number(target.y)}`;
}

function targetsToken(targets = []) {
  return targets.map(targetToken).join(',');
}

function candidateToken(candidate) {
  return [
    candidate.slot.label,
    candidate.routeMode,
    number(candidate.routeCost),
    number(candidate.routeScore),
    String(candidate.crowdingCost),
    number(candidate.preferenceCost),
    (candidate.rawPathSquares || []).join(','),
    (candidate.compressedPathSquares || []).join(','),
    targetsToken(candidate.targets)
  ].join('~');
}

function candidateSummaryToken(candidate) {
  return [
    candidate.slot,
    number(candidate.routeCost),
    number(candidate.routeScore),
    String(candidate.crowdingCost),
    (candidate.pathSquares || []).join(',')
  ].join('~');
}

function failureToken(failure) {
  return `${failure.slot}~${failure.error}`;
}

function withFixtureContext(fixture, callback) {
  const previousOccupancy = physicalSession.occupancy.slice();
  return withPhysicalPlanningContext(fixture.fen, fixture.slots || [], (game) => {
    physicalSession.active = Boolean(fixture.sensed?.length);
    physicalSession.occupancy = occupancyForSquares(fixture.sensed);
    physicalSession.robotGraveyardOccupied = [...(fixture.occupied || [])];
    try {
      return callback(game);
    } finally {
      physicalSession.occupancy = previousOccupancy;
    }
  });
}

function jsTransfer(fixture) {
  return withFixtureContext(fixture, (game) => {
    const move = {
      from: fixture.from,
      to: fixture.to,
      piece: fixture.directWhenClear ? 'p' : 'n',
      flags: ''
    };
    try {
      const result = buildBoardTransferPlan(game, move, fixture.from, fixture.to, {
        forceLane: Boolean(fixture.forceLane),
        preferredLane: fixture.preferred,
        ignoredSquares: fixture.ignored || []
      });
      const targets = result.steps
        .filter((step) => step.action === 'drag')
        .map((step) => step.to);
      return {
        status: 'success',
        mode: result.routeMode,
        cost: result.routeCost,
        raw: result.rawPathSquares || [],
        compressed: result.compressedPathSquares || [],
        targets: targetsToken(targets)
      };
    } catch (error) {
      return { status: 'no_lane_path', error: error.message };
    }
  });
}

function jsGraveyard(fixture) {
  return withFixtureContext(fixture, (game) => {
    const result = planCapturedPieceRemoval(
      game, fixture.from, fixture.ignored || [], { reserve: false });
    if (!result.slot) {
      const normalized = normalizeGraveyardSlots(fixture.slots || []);
      const occupied = new Set((fixture.occupied || []).map((key) => key.toUpperCase()));
      const hasFree = normalized.some((slot) => !occupied.has(slot.key.toUpperCase()));
      return {
        status: hasFree ? 'no_graveyard_path' : 'no_graveyard_capacity',
        failures: (result.failures || []).map(failureToken)
      };
    }
    return {
      status: 'success',
      selected: candidateToken(result),
      candidates: (result.candidates || []).map(candidateSummaryToken),
      failures: (result.failures || []).map(failureToken)
    };
  });
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(fixturePath, fixtures.map(fixtureLine).join('\n') + '\n');

const compiler = process.env.CXX || 'g++';
const compile = spawnSync(compiler, [
  '-std=c++17', '-O2', '-Wall', '-Wextra', '-Wpedantic', '-Wno-unused-but-set-variable',
  path.join(root, 'offline_core', 'offline_game.cpp'),
  path.join(root, 'offline_core', 'offline_physical.cpp'),
  path.join(root, 'offline_core', 'offline_route.cpp'),
  path.join(root, 'offline_core', 'offline_external_route.cpp'),
  path.join(root, 'tests_and_misc', 'offline_external_route_host.cpp'),
  '-o', executablePath
], { encoding: 'utf8' });
if (compile.stdout) process.stdout.write(compile.stdout);
if (compile.stderr) process.stderr.write(compile.stderr);
assert.strictEqual(compile.status, 0, `Host C++ compilation failed with status ${compile.status}.`);

const run = spawnSync(executablePath, [fixturePath], { encoding: 'utf8', timeout: 30000 });
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
assert.strictEqual(run.error, undefined, `Host external-route regressions failed to run: ${run.error?.message}`);
assert.strictEqual(run.status, 0, `Host external-route regressions failed with status ${run.status}.`);

const results = new Map();
for (const line of run.stdout.split(/\r?\n/)) {
  const fields = line.split('\t');
  if (fields[0] === 'TRANSFER') {
    results.set(fields[1], {
      kind: 'T', status: fields[2], mode: fields[3], cost: Number(fields[4]),
      raw: fields[5] ? fields[5].split(',') : [],
      compressed: fields[6] ? fields[6].split(',') : [],
      targets: fields[7], failures: fields[8] ? fields[8].split('^') : [],
      blockedReason: fields[9] || ''
    });
  } else if (fields[0] === 'GRAVEYARD') {
    results.set(fields[1], {
      kind: 'G', status: fields[2], selected: fields[3],
      candidates: fields[4] ? fields[4].split('^') : [],
      failures: fields[5] ? fields[5].split('^') : [],
      blockedReason: fields[6] || ''
    });
  }
}

for (const fixture of fixtures) {
  const cpp = results.get(fixture.id);
  assert(cpp, `${fixture.id}: C++ result is missing.`);
  if (fixture.kind === 'T') {
    const js = jsTransfer(fixture);
    assert.strictEqual(cpp.status, js.status, `${fixture.id}: transfer status differs.`);
    if (js.status === 'success') {
      assert.deepStrictEqual(
        { mode: cpp.mode, cost: cpp.cost, raw: cpp.raw, compressed: cpp.compressed, targets: cpp.targets },
        { mode: js.mode, cost: js.cost, raw: js.raw, compressed: js.compressed, targets: js.targets },
        `${fixture.id}: transfer route differs from JavaScript.`
      );
    } else {
      assert(js.error.includes(cpp.blockedReason), `${fixture.id}: JavaScript failure omitted C++ blocked reason.`);
      for (const failure of cpp.failures) {
        const [slot, reason] = failure.split('~');
        assert(js.error.includes(`${slot}: ${reason}`), `${fixture.id}: failure detail differs.`);
      }
    }
    continue;
  }

  const js = jsGraveyard(fixture);
  assert.strictEqual(cpp.status, js.status, `${fixture.id}: graveyard status differs.`);
  if (js.status === 'success') {
    assert.strictEqual(cpp.selected, js.selected, `${fixture.id}: selected graveyard route differs.`);
    assert.deepStrictEqual(cpp.candidates, js.candidates, `${fixture.id}: candidate ranking differs.`);
  }
  assert.deepStrictEqual(cpp.failures, js.failures, `${fixture.id}: graveyard failures differ.`);
}

assert.deepStrictEqual(results.get('repeat-lane-a'), results.get('repeat-lane-b'),
  'Repeated lane planning must be deterministic.');
const sameSideRoute = results.get('same-side-pair-required');
assert.strictEqual(sameSideRoute.status, 'success',
  'The mixed-side safety fixture must retain a routable same-side fallback.');
const laneTargets = sameSideRoute.targets.split(',').filter((target) => target.startsWith('C:lane:'));
assert.strictEqual(laneTargets.length, 2,
  'A direct lane route must expose one exit and one entry coordinate.');
assert.strictEqual(laneTargets[0].split(':')[3], laneTargets[1].split(':')[3],
  'A direct lane route must never connect Z directly to I.');

console.log(JSON.stringify({
  success: true,
  compiler,
  parityFixtures: fixtures.length,
  transactionalReservation: true,
  capturesChoreographed: false,
  firmwareLinked: false
}, null, 2));
