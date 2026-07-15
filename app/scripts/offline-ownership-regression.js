const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const outputDir = path.join(root, 'tmp', 'offline-ownership');
const executablePath = path.join(outputDir, 'offline_ownership_host.exe');

fs.mkdirSync(outputDir, { recursive: true });

const compiler = process.env.CXX || 'g++';
const compile = spawnSync(compiler, [
  '-std=c++17', '-O2', '-Wall', '-Wextra', '-Wpedantic', '-Werror',
  path.join(root, 'offline_core', 'offline_ownership.cpp'),
  path.join(root, 'tests_and_misc', 'offline_ownership_host.cpp'),
  '-o', executablePath
], { encoding: 'utf8' });

if (compile.stdout) process.stdout.write(compile.stdout);
if (compile.stderr) process.stderr.write(compile.stderr);
assert.strictEqual(compile.status, 0,
  `Host ownership compilation failed with status ${compile.status}.`);

const run = spawnSync(executablePath, [], { encoding: 'utf8', timeout: 30000 });
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
assert.strictEqual(run.error, undefined,
  `Host ownership regressions failed to run: ${run.error?.message}`);
assert.strictEqual(run.status, 0,
  `Host ownership regressions failed with status ${run.status}.`);

async function verifyHeartbeatEndpoint() {
  process.env.PHYSICAL_LOG_DISABLE = '1';
  const {
    server,
    physicalBoardTest,
    physicalOwnershipTest
  } = require('../server');

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const beforeState = JSON.stringify(physicalBoardTest.serializePhysicalState());
    const beforeCommands = JSON.stringify(physicalBoardTest.physicalSession.commands);

    const first = await fetch(`${baseUrl}/api/physical/heartbeat`).then((response) => response.json());
    const second = await fetch(`${baseUrl}/api/physical/heartbeat`).then((response) => response.json());

    assert.strictEqual(first.success, true);
    assert.strictEqual(first.protocolVersion, physicalOwnershipTest.protocolVersion);
    assert.strictEqual(first.serverInstanceId, physicalOwnershipTest.serverInstanceId);
    assert.strictEqual(second.serverInstanceId, first.serverInstanceId,
      'Server identity changed within one process.');
    assert.strictEqual(first.sessionGeneration, 0);
    assert.strictEqual(first.sessionActive, false);
    assert.strictEqual(first.phase, 'idle');
    assert.strictEqual(first.safeToSwitch, true);
    assert.strictEqual(JSON.stringify(physicalBoardTest.serializePhysicalState()), beforeState,
      'Heartbeat mutated serialized physical state.');
    assert.strictEqual(JSON.stringify(physicalBoardTest.physicalSession.commands), beforeCommands,
      'Heartbeat consumed or queued physical commands.');

    const started = await fetch(`${baseUrl}/api/physical/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 1, profile: 'balanced', setupMode: 'full' })
    });
    assert.strictEqual(started.status, 200);

    const active = await fetch(`${baseUrl}/api/physical/heartbeat`).then((response) => response.json());
    assert.strictEqual(active.sessionGeneration, 1,
      'A new physical session did not increment its generation exactly once.');
    assert.strictEqual(active.sessionActive, true);
    assert.strictEqual(active.phase, 'setup');
    assert.strictEqual(active.safeToSwitch, false);

    const repeated = await fetch(`${baseUrl}/api/physical/heartbeat`).then((response) => response.json());
    assert.strictEqual(repeated.sessionGeneration, active.sessionGeneration,
      'A heartbeat changed the physical session generation.');

    await fetch(`${baseUrl}/api/physical/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupMode: 'full' })
    });
    const restarted = await fetch(`${baseUrl}/api/physical/heartbeat`).then((response) => response.json());
    assert.strictEqual(restarted.sessionGeneration, 2,
      'The second physical start did not create a new generation.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

verifyHeartbeatEndpoint()
  .then(() => {
    console.log(JSON.stringify({
      success: true,
      compiler,
      bootProbe: true,
      heartbeatHysteresis: true,
      pausedOnlineRecovery: true,
      idleHotRestart: true,
      remoteTransitionSafety: true,
      nextTurnHandoff: true,
      heartbeatEndpoint: true,
      firmwareLinked: false
    }, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
