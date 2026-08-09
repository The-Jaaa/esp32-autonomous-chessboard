const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const outputDir = path.join(root, 'tmp', 'offline-interaction');
const executablePath = path.join(outputDir, 'offline_interaction_host.exe');
fs.mkdirSync(outputDir, { recursive: true });

const firmwareSource = fs.readFileSync(
  path.join(root, 'esp32_firmware', 'esp32_firmware.ino'),
  'utf8'
);
const interactionDiagnosticSource = fs.readFileSync(
  path.join(root, 'esp32_firmware', 'offline_interaction_diagnostic.inc'),
  'utf8'
);
assert.match(firmwareSource, /OFFLINE_HOME_MAX_SPEED\s*=\s*3000\.0f/,
  'Guarded homing must use the accepted low-speed limit approach.');
assert.match(firmwareSource,
  /executeOfflineQuietHome[\s\S]*?setOfflineHomeMotionProfile\(\)/,
  'Guarded homing must select its dedicated motion profile.');
assert.match(interactionDiagnosticSource,
  /physical\(\)\.phase\(\)\s*==\s*\n?\s*offline::PhysicalPhase::Ready/,
  'Human-ready feedback must not overwrite active piece-lift targets.');

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
  'offline_human_promotion.cpp',
  'offline_side_selection.cpp',
  'offline_led.cpp'
].map((file) => path.join(root, 'offline_core', file));

const compile = spawnSync(compiler, [
  '-std=c++17', '-O2', '-Wall', '-Wextra', '-Wpedantic',
  ...sources,
  path.join(root, 'tests_and_misc', 'offline_interaction_host.cpp'),
  '-o', executablePath
], { encoding: 'utf8' });
if (compile.stdout) process.stdout.write(compile.stdout);
if (compile.stderr) process.stderr.write(compile.stderr);
assert.strictEqual(compile.status, 0, 'Host offline interaction compilation failed.');

const run = spawnSync(executablePath, [], { encoding: 'utf8', timeout: 60000 });
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
assert.strictEqual(run.error, undefined, `Offline interaction failed to run: ${run.error?.message}`);
assert.strictEqual(run.status, 0, 'Offline interaction regressions failed.');

console.log(JSON.stringify({
  success: true,
  matrixPixels: 256,
  sideHoldMs: 1000,
  setupStableMs: 500,
  promotionChoiceMs: 2500,
  promotionStableMs: 500,
  firmwareLinked: false
}, null, 2));
