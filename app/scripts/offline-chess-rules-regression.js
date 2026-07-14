const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Chess } = require('chess.js');

const root = path.resolve(__dirname, '..', '..');
const outputDir = path.join(root, 'tmp', 'offline-chess-rules');
const fixturePath = path.join(outputDir, 'legal-move-parity.tsv');
const executablePath = path.join(outputDir, 'offline_chess_rules_host.exe');

const corpus = [
  ['start', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'],
  ['opening', 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2'],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['en-passant', '8/8/8/3pP3/8/8/8/4K2k w - d6 0 1'],
  ['promotion', '4k3/P7/8/8/8/8/8/4K3 w - - 0 1'],
  ['middlegame', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 1'],
  ['checkmate', '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1'],
  ['stalemate', '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'],
  ['endgame', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1']
];

function legalUci(fen) {
  const game = new Chess(fen);
  return game.moves({ verbose: true })
    .map((move) => `${move.from}${move.to}${move.promotion || ''}`)
    .sort();
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
  fixturePath,
  corpus.map(([label, fen]) => `${label}\t${fen}\t${legalUci(fen).join(',')}`).join('\n') + '\n',
  'utf8'
);

const compiler = process.env.CXX || 'g++';
const compile = spawnSync(compiler, [
  '-std=c++17',
  '-O2',
  '-Wall',
  '-Wextra',
  '-Wpedantic',
  '-Wno-unused-but-set-variable',
  path.join(root, 'offline_core', 'offline_game.cpp'),
  path.join(root, 'tests_and_misc', 'offline_chess_rules_host.cpp'),
  '-o',
  executablePath
], { encoding: 'utf8' });

if (compile.stdout) process.stdout.write(compile.stdout);
if (compile.stderr) process.stderr.write(compile.stderr);
assert.strictEqual(compile.status, 0, `Host C++ compilation failed with status ${compile.status}.`);

const run = spawnSync(executablePath, [fixturePath], { encoding: 'utf8' });
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
assert.strictEqual(run.status, 0, `Host C++ regressions failed with status ${run.status}.`);

console.log(JSON.stringify({
  success: true,
  compiler,
  parityPositions: corpus.length,
  firmwareLinked: false
}, null, 2));
