const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const outputDir = path.join(root, 'tmp', 'offline-temporary-clearance');
const executablePath = path.join(outputDir, 'offline_temporary_clearance_host.exe');
fs.mkdirSync(outputDir, { recursive: true });

const sources = [
  path.join(root, 'offline_core', 'offline_game.cpp'),
  path.join(root, 'offline_core', 'offline_physical.cpp'),
  path.join(root, 'offline_core', 'offline_route.cpp'),
  path.join(root, 'offline_core', 'offline_external_route.cpp'),
  path.join(root, 'offline_core', 'offline_motion.cpp'),
  path.join(root, 'tests_and_misc', 'offline_temporary_clearance_host.cpp')
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
assert.strictEqual(run.status, 0, 'Temporary-clearance host regressions failed.');
console.log(JSON.stringify({
  success: true,
  cases: ['g1f3:h2-h4', 'g8f6:h7-h5', 'b1c3:a2-a4', 'e2e4:no-clearance'],
  logicalStateUnchanged: true,
  deterministic: true
}, null, 2));
