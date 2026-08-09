const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const outputDir = path.join(root, 'tmp', 'offline-continuous');
const executablePath = path.join(outputDir, 'offline_continuous_host.exe');
fs.mkdirSync(outputDir, { recursive: true });

const compiler = process.env.CXX || 'g++';
const sources = [
  'offline_game.cpp',
  'offline_physical.cpp',
  'offline_continuous.cpp',
  'offline_led.cpp'
].map((file) => path.join(root, 'offline_core', file));

const compile = spawnSync(compiler, [
  '-std=c++17', '-O2', '-Wall', '-Wextra', '-Wpedantic',
  ...sources,
  path.join(root, 'tests_and_misc', 'offline_continuous_host.cpp'),
  '-o', executablePath
], { encoding: 'utf8' });
if (compile.stdout) process.stdout.write(compile.stdout);
if (compile.stderr) process.stderr.write(compile.stderr);
assert.strictEqual(compile.status, 0, 'Host offline continuous compilation failed.');

const run = spawnSync(executablePath, [], { encoding: 'utf8', timeout: 60000 });
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
assert.strictEqual(run.error, undefined, `Offline continuous run failed: ${run.error?.message}`);
assert.strictEqual(run.status, 0, 'Offline continuous regressions failed.');

const embeddedConfig = fs.readFileSync(
  path.join(root, 'offline_core', 'src', 'EmbeddedConfig.h'), 'utf8');
const firmware = fs.readFileSync(
  path.join(root, 'esp32_firmware', 'offline_runtime_diagnostics.cpp'), 'utf8');
const runtime = fs.readFileSync(
  path.join(root, 'esp32_firmware', 'offline_continuous_gameplay_diagnostic.inc'), 'utf8');
assert.match(embeddedConfig, /ENABLE_OFFLINE_CONTINUOUS_GAMEPLAY_DIAGNOSTICS/,
  'The continuous diagnostic compile gate is missing.');
assert.match(firmware, /runOfflineContinuousGameplayDiagnostic/,
  'The continuous diagnostic runtime is not linked from firmware.');
assert.match(runtime, /kContinuousAcceptanceTurns\s*=\s*12/,
  'The continuous runtime does not retain the twelve-turn checkpoint.');

console.log(JSON.stringify({
  success: true,
  resetHoldMs: 2000,
  setupStableMs: 500,
  fixtures: ['Standard', 'TerminalReset']
}, null, 2));
