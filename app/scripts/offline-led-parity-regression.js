const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const outputDir = path.join(root, 'tmp', 'offline-led-parity');
const executablePath = path.join(outputDir, 'offline_led_parity_host.exe');
fs.mkdirSync(outputDir, { recursive: true });

const sources = [
  path.join(root, 'offline_core', 'offline_game.cpp'),
  path.join(root, 'offline_core', 'offline_physical.cpp'),
  path.join(root, 'offline_core', 'offline_led.cpp'),
  path.join(root, 'tests_and_misc', 'offline_led_parity_host.cpp')
];

const compile = spawnSync('g++', [
  '-std=c++17', '-O2', '-Wall', '-Wextra', '-pedantic',
  '-I', path.join(root, 'offline_core'),
  ...sources, '-o', executablePath
], { cwd: root, encoding: 'utf8' });

if (compile.status !== 0) {
  process.stderr.write(compile.stdout || '');
  process.stderr.write(compile.stderr || '');
  process.exit(compile.status || 1);
}

const run = spawnSync(executablePath, [], { cwd: root, encoding: 'utf8' });
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
assert.strictEqual(run.status, 0, 'LED parity host regressions failed.');
console.log(JSON.stringify({
  success: true,
  matrixPixels: 256,
  orientation: 'fixed-sideways',
  palette: 'online-physical-led-colors',
  deterministic: true
}, null, 2));
