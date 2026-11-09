const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-autonomous-guard-'));
try {
  const output = path.join(temporary, process.platform === 'win32' ? 'detector.exe' : 'detector');
  const source = path.resolve(__dirname, '../../firmware_tests/autonomous_guard_test.cpp');
  const compile = spawnSync(process.env.CXX || 'g++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', source, '-o', output], { encoding: 'utf8' });
  if (compile.error) throw compile.error;
  assert.equal(compile.status, 0, compile.stderr);
  const run = spawnSync(output, [], { encoding: 'utf8' });
  if (run.error) throw run.error;
  assert.equal(run.status, 0, run.stderr);
  process.stdout.write(run.stdout);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
