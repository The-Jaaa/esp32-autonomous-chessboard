const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const outputDir = path.join(root, 'tmp', 'offline-engine');
const executablePath = path.join(outputDir, 'offline_engine_host.exe');

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
  path.join(root, 'offline_core', 'offline_engine.cpp'),
  path.join(root, 'tests_and_misc', 'offline_engine_host.cpp'),
  '-o',
  executablePath
], { encoding: 'utf8' });

if (compile.stdout) process.stdout.write(compile.stdout);
if (compile.stderr) process.stderr.write(compile.stderr);
assert.strictEqual(compile.status, 0, `Host C++ compilation failed with status ${compile.status}.`);

const run = spawnSync(executablePath, [], { encoding: 'utf8', timeout: 30000 });
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
assert.strictEqual(run.error, undefined, `Host engine regressions failed to run: ${run.error?.message}`);
assert.strictEqual(run.status, 0, `Host engine regressions failed with status ${run.status}.`);

console.log(JSON.stringify({
  success: true,
  compiler,
  deterministic: true,
  openingBook: false,
  firmwareLinked: false
}, null, 2));
