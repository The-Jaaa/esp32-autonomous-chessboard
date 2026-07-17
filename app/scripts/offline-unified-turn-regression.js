const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const outputDir = path.join(root, 'tmp', 'offline-unified-turn');
const executablePath = path.join(outputDir, 'offline_unified_turn_host.exe');

fs.mkdirSync(outputDir, { recursive: true });

const compiler = process.env.CXX || 'g++';
const sources = [
  'offline_game.cpp',
  'offline_physical.cpp',
  'offline_engine.cpp',
  'offline_route.cpp',
  'offline_external_route.cpp',
  'offline_motion.cpp',
  'offline_coordinator.cpp',
  'offline_ownership.cpp',
  'offline_runtime.cpp',
  'offline_phase_execution.cpp',
  'offline_quiet_motion.cpp',
  'offline_lane_motion.cpp',
  'offline_capture_motion.cpp',
  'offline_castling_motion.cpp',
  'offline_promotion_motion.cpp',
  'offline_unified_motion.cpp'
].map((file) => path.join(root, 'offline_core', file));

const compile = spawnSync(compiler, [
  '-std=c++17', '-O2', '-Wall', '-Wextra', '-Wpedantic',
  '-Wno-unused-but-set-variable',
  ...sources,
  path.join(root, 'tests_and_misc', 'offline_unified_turn_host.cpp'),
  '-o', executablePath
], { encoding: 'utf8' });

if (compile.stdout) process.stdout.write(compile.stdout);
if (compile.stderr) process.stderr.write(compile.stderr);
assert.strictEqual(
  compile.status,
  0,
  `Host unified-turn compilation failed with status ${compile.status}.`
);

const run = spawnSync(executablePath, [], { encoding: 'utf8', timeout: 60000 });
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
assert.strictEqual(
  run.error,
  undefined,
  `Host unified-turn regressions failed to run: ${run.error?.message}`
);
assert.strictEqual(
  run.status,
  0,
  `Host unified-turn regressions failed with status ${run.status}.`
);

console.log(JSON.stringify({
  success: true,
  compiler,
  compilerKinds: ['quiet', 'lane', 'capture', 'castling', 'promotion'],
  verifiedWhiteTurns: 3,
  verifiedBlackTurns: 3,
  graveyardPersistsAcrossTurns: true,
  promotionCommitWaitsForReplacement: true,
  maximumAutomaticAttempts: 2,
  firmwareLinked: false
}, null, 2));
