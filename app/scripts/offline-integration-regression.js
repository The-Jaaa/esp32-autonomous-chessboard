const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const soak = process.argv.includes('--soak');
const mode = soak ? 'soak' : 'quick';
const outputDir = path.join(root, 'tmp', 'offline-integration');
const executablePath = path.join(outputDir, 'offline_integration_host.exe');

fs.mkdirSync(outputDir, { recursive: true });

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
  path.join(root, 'offline_core', 'offline_engine.cpp'),
  path.join(root, 'offline_core', 'offline_route.cpp'),
  path.join(root, 'offline_core', 'offline_external_route.cpp'),
  path.join(root, 'offline_core', 'offline_motion.cpp'),
  path.join(root, 'offline_core', 'offline_coordinator.cpp'),
  path.join(root, 'tests_and_misc', 'offline_integration_host.cpp'),
  '-o',
  executablePath
], { encoding: 'utf8' });

if (compile.stdout) process.stdout.write(compile.stdout);
if (compile.stderr) process.stderr.write(compile.stderr);
assert.strictEqual(compile.status, 0, `Host C++ compilation failed with status ${compile.status}.`);

const simulationArgs = soak
  ? ['--games', '100', '--max-plies', '200', '--seed', '0x51A7E5ED']
  : ['--games', '12', '--max-plies', '120', '--seed', '0xC0D3C0DE'];
const run = spawnSync(executablePath, simulationArgs, {
  encoding: 'utf8',
  timeout: soak ? 120000 : 60000
});
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
assert.strictEqual(run.error, undefined, `Host integration ${mode} failed to run: ${run.error?.message}`);
assert.strictEqual(run.status, 0, `Host integration ${mode} failed with status ${run.status}.`);

console.log(JSON.stringify({
  success: true,
  mode,
  compiler,
  games: soak ? 100 : 12,
  maxPlies: soak ? 200 : 120,
  deterministic: true,
  firmwareLinked: false
}, null, 2));
