const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  physicalPlanner: {
    withPhysicalPlanningContext,
    buildBoardTransferPlan,
    legalMoveMatchesUci
  },
  physicalBoardTest: {
    physicalSession,
    squareToIndex
  }
} = require('../server');

const root = path.resolve(__dirname, '..', '..');
const outputDir = path.join(root, 'tmp', 'offline-route');
const executablePath = path.join(outputDir, 'offline_route_host.exe');
const fixturePath = path.join(outputDir, 'route-fixtures.tsv');

const fixtures = [
  { id: 'pawn-e7e6', fen: 'rnbqkbnr/pppppppp/8/8/5P2/8/PPPPP1PP/RNBQKBNR b KQkq - 0 1', uci: 'e7e6' },
  { id: 'pawn-e7e5', fen: 'rnbqkbnr/pppppppp/8/8/5P2/8/PPPPP1PP/RNBQKBNR b KQkq - 0 1', uci: 'e7e5' },
  { id: 'pawn-b7b6', fen: 'rnbqkbnr/pppppppp/8/8/5P2/8/PPPPP1PP/RNBQKBNR b KQkq - 0 1', uci: 'b7b6' },
  { id: 'rook-a8a7', fen: 'rnbqkbnr/2p1pppp/p7/1p1p4/3QP3/2P5/PP1P1PPP/RNB1KBNR b KQkq - 1 4', uci: 'a8a7' },
  { id: 'rook-a7a8', fen: '1nbqkbnr/r1p1ppp1/p6p/1p1p4/1P1QP3/B1P5/P2P1PPP/RN2KBNR b KQk - 1 6', uci: 'a7a8' },
  { id: 'queen-d8d7', fen: 'rnbqkbnr/4ppp1/p1B5/3p3p/1P1QP3/B1P2N2/P2P1PPP/RN2K2R b KQk - 0 9', uci: 'd8d7' },
  { id: 'knight-g8h6', fen: 'k1B3n1/8/6P1/1RB5/P2PpP2/4P3/P1P4P/4K2R b K - 8 36', uci: 'g8h6' },
  { id: 'knight-g8f6', fen: 'k1B3n1/8/6P1/1RB5/P2PpP2/4P3/P1P4P/4K2R b K - 8 36', uci: 'g8f6' },
  { id: 'knight-g8e7', fen: 'k1B3n1/8/6P1/1RB5/P2PpP2/4P3/P1P4P/4K2R b K - 8 36', uci: 'g8e7' },
  { id: 'rook-a1a8-line', fen: '7k/8/8/8/8/8/8/R3K3 w - - 0 1', uci: 'a1a8' },
  { id: 'diagonal-corner', fen: '4k3/8/8/8/8/1p6/1Qp5/4K3 w - - 0 1', uci: 'b2c3' },
  { id: 'blocked-knight', fen: 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1', uci: 'b8a6' },
  { id: 'sensed-obstruction', fen: '7k/8/8/8/8/8/8/R3K3 w - - 0 1', uci: 'a1a8', sensed: ['a4'] },
  { id: 'ignored-sensed-obstruction', fen: '7k/8/8/8/8/8/8/R3K3 w - - 0 1', uci: 'a1a8', sensed: ['a4'], ignored: ['a4'] },
  { id: 'repeat-a', fen: 'k1B3n1/8/6P1/1RB5/P2PpP2/4P3/P1P4P/4K2R b K - 8 36', uci: 'g8f6' },
  { id: 'repeat-b', fen: 'k1B3n1/8/6P1/1RB5/P2PpP2/4P3/P1P4P/4K2R b K - 8 36', uci: 'g8f6' }
];

function occupancyForSquares(squares = []) {
  const occupancy = Array(64).fill(false);
  for (const square of squares) {
    const index = squareToIndex(square);
    assert(Number.isInteger(index), `Invalid sensed fixture square ${square}.`);
    occupancy[index] = true;
  }
  return occupancy;
}

function bits(occupancy) {
  return occupancy.map((value) => value ? '1' : '0').join('');
}

function jsRoute(fixture) {
  const previousOccupancy = physicalSession.occupancy.slice();
  try {
    return withPhysicalPlanningContext(fixture.fen, [], (game) => {
      const move = game.moves({ verbose: true })
        .find((candidate) => legalMoveMatchesUci(candidate, fixture.uci));
      assert(move, `${fixture.id}: JavaScript fixture move must be legal.`);
      physicalSession.active = Boolean(fixture.sensed?.length);
      physicalSession.occupancy = occupancyForSquares(fixture.sensed);
      try {
        const result = buildBoardTransferPlan(game, move, move.from, move.to, {
          ignoredSquares: fixture.ignored || []
        });
        return {
          status: 'success',
          mode: result.routeMode,
          cost: result.routeCost,
          raw: result.rawPathSquares || result.pathSquares || [],
          compressed: result.compressedPathSquares || result.pathSquares || []
        };
      } catch (error) {
        assert.match(error.message, /No safe route|No board path|lane path is blocked/);
        return { status: 'no_board_path', mode: '-', cost: 0, raw: [], compressed: [] };
      }
    });
  } finally {
    physicalSession.occupancy = previousOccupancy;
  }
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(fixturePath, fixtures.map((fixture) => [
  fixture.id,
  fixture.fen,
  fixture.uci,
  fixture.sensed?.length ? bits(occupancyForSquares(fixture.sensed)) : '-',
  (fixture.ignored || []).join(',')
].join('\t')).join('\n') + '\n');

const compiler = process.env.CXX || 'g++';
const compile = spawnSync(compiler, [
  '-std=c++17',
  '-O2',
  '-Wall',
  '-Wextra',
  '-Wpedantic',
  '-Wno-unused-but-set-variable',
  path.join(root, 'offline_core', 'offline_game.cpp'),
  path.join(root, 'offline_core', 'offline_physical.cpp'),
  path.join(root, 'offline_core', 'offline_route.cpp'),
  path.join(root, 'tests_and_misc', 'offline_route_host.cpp'),
  '-o',
  executablePath
], { encoding: 'utf8' });

if (compile.stdout) process.stdout.write(compile.stdout);
if (compile.stderr) process.stderr.write(compile.stderr);
assert.strictEqual(compile.status, 0, `Host C++ compilation failed with status ${compile.status}.`);

const run = spawnSync(executablePath, [fixturePath], { encoding: 'utf8', timeout: 30000 });
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
assert.strictEqual(run.error, undefined, `Host route regressions failed to run: ${run.error?.message}`);
assert.strictEqual(run.status, 0, `Host route regressions failed with status ${run.status}.`);

const cppRoutes = new Map();
for (const line of run.stdout.split(/\r?\n/)) {
  if (!line.startsWith('ROUTE\t')) continue;
  const [, id, status, mode, cost, raw, compressed] = line.split('\t');
  cppRoutes.set(id, {
    status,
    mode,
    cost: Number(cost),
    raw: raw ? raw.split(',') : [],
    compressed: compressed ? compressed.split(',') : []
  });
}

for (const fixture of fixtures) {
  assert(cppRoutes.has(fixture.id), `${fixture.id}: C++ route result is missing.`);
  assert.deepStrictEqual(cppRoutes.get(fixture.id), jsRoute(fixture),
    `${fixture.id}: C++ route differs from JavaScript reference.`);
}
assert.deepStrictEqual(cppRoutes.get('repeat-a'), cppRoutes.get('repeat-b'),
  'Repeated fixture must produce the same route metadata.');

console.log(JSON.stringify({
  success: true,
  compiler,
  parityFixtures: fixtures.length,
  randomizedSafetyCases: 256,
  diagonalCornerMovement: 'allowed',
  lanesIncluded: false,
  firmwareLinked: false
}, null, 2));
