process.env.PHYSICAL_LOG_DISABLE = '1';
process.env.MENTOR_FAKE_TEXT = '1';
process.env.MENTOR_FAKE_LIVE = '1';
const fs = require('fs'), os = require('os'), path = require('path');
const assert = require('assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-autonomous-browser-'));
process.env.MENTOR_DB_PATH = path.join(temp, 'test.sqlite');
const { server, mentorFeature, autonomous, exhibition, physicalBoardTest: board } = require('../server');
const { loadPlaywright } = require('./playwright-runtime');
let lastPage;
let browser, timer, base, queued = [], working = false, acknowledge = true, capable = true;
let occupancy = board.occupancyFromGame(board.physicalSession.game);
let applied, ledCommands = [];
async function request(route, body) {
  const r = await fetch(base + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { code: r.status, data: await r.json() };
}
async function heartbeat() {
  while (working) await new Promise(resolve => setTimeout(resolve, 10));
  working = true;
  try {
    const poll = (await request('/api/physical/poll')).data;
    applied = poll.exhibition;
    ledCommands.push(...poll.commands.filter(c => c.type === 'led'));
    queued.push(...poll.commands.filter(c => c.autonomous));
    if (acknowledge && queued.length) {
      const command = queued.shift();
      const p = autonomous.pending;
      if(command.type==='autonomous-reconcile') {
        occupancy=autonomous.reconciliation.expected.slice();
        await request('/api/physical/job-result',{id:command.id,success:true,magnetOn:false,occupancy});
      } else if (p?.id === command.id) {
        occupancy = p.home ? autonomous.expected.slice() : (p.direction === 'play' ? p.operation.after : p.operation.before).slice();
        await request('/api/physical/job-result', { id: command.id, success: true, magnetOn: false, occupancy });
      }
    }
    await request('/api/physical/snapshot', { occupancy, boardRuntime: {
      exhibitionSupported: true, musicSpectrumSupported: true, concurrentSpectrumSupported: capable,
      controlledTakeoverSupported: capable, placementRecoverySupported: capable, acknowledgedHomingSupported: capable,
      motionBusy: false, motionPending: false, magnetOn: false,
      exhibitionEnabled: applied.enabled, exhibitionRevision: applied.revision,
      exhibitionServerInstanceId: applied.serverInstanceId } });
  } finally { working = false; }
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await heartbeat(); timer = setInterval(() => heartbeat().catch(console.error), 100);
  browser = await loadPlaywright().chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    occupancy=board.occupancyFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    await heartbeat();
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(); lastPage = page; const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    const panel = page.getByRole('region', { name: 'Autonomous exhibition', exact: true });
    const waitState = async state => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await request('/api/exhibition/autonomous/status')).data.autonomous.state === state) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw Error(`Timed out waiting for ${state}; got ${autonomous.state}`);
    };
    const confirm = panel.getByRole('checkbox').first();
    assert.equal(await panel.getByRole('button', { name: 'Start Autonomous Game', exact: true }).isDisabled(), true);
    await confirm.check();
    capable = false; await heartbeat();
    await panel.getByRole('button', { name: 'Start Autonomous Game', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'updated firmware' }).waitFor();
    capable = true; await heartbeat();
    await panel.getByRole('button', { name: 'Start Autonomous Game', exact: true }).click();
    await waitState('playing');
    acknowledge = false;
    await panel.getByRole('button', { name: 'Pause Autonomous Game', exact: true }).click();
    acknowledge = true; await waitState('paused'); acknowledge = false;
    const conflict = await request('/api/physical/start', { humanColor: 'white' });
    assert.equal(conflict.code, 400);
    assert.match(conflict.data.error, /autonomous/);
    assert.equal((await request('/api/command', { type: 'home' })).code, 409);
    await panel.getByRole('button', { name: 'Resume Autonomous Game', exact: true }).click();
    await waitState('playing');
    await panel.getByRole('button', { name: 'Restore & Exit', exact: true }).click();
    acknowledge = true; await waitState('available');
    assert.equal(exhibition.desired.enabled, false, 'Autonomous controls must not change independent lighting settings.');
    await confirm.check();
    await panel.getByRole('button', { name: 'Start Autonomous Game', exact: true }).click();
    await waitState('playing'); acknowledge = false;
    await panel.getByRole('button', { name: 'Manual Takeover', exact: true }).click();
    acknowledge = true; await waitState('manual_ready');
    await panel.getByText('Manual reset ready.', { exact: false }).waitFor();
    occupancy = board.occupancyFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    await heartbeat();
    assert.equal(autonomous.state, 'manual_ready');
    // A failed exhibition can home before the operator restores the pieces.
    occupancy[board.squareToIndex('a2')] = false;
    occupancy[board.squareToIndex('a3')] = true;
    autonomous.hold('Simulated placement failure.');
    await heartbeat();
    const resetHome = panel.getByRole('button', { name: 'Home for Manual Reset', exact: true });
    await resetHome.waitFor();
    assert.equal(await resetHome.isDisabled(), true);
    await panel.getByRole('checkbox').first().check();
    acknowledge = false;
    await resetHome.click(); await waitState('takeover_homing');
    assert.equal(exhibition.desired.enabled, false);
    assert.notEqual(autonomous.state, 'manual_ready');
    acknowledge = true; await waitState('manual_ready');
    ledCommands = []; await heartbeat(); await heartbeat();
    const calibration = ledCommands.find(c => c.mode === 'calibration');
    assert.ok(calibration, 'Successful reset homing must enable setup guidance.');
    const missing = calibration.squares.find(s => s.index === board.squareToIndex('a2'));
    assert.deepEqual(missing.color, { r: 255, g: 32, b: 32 });
    occupancy = board.occupancyFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    await heartbeat();

    await panel.getByRole('checkbox').first().check();
    await panel.getByRole('button',{name:'Start Autonomous Game',exact:true}).click();
    await waitState('playing');acknowledge=false;
    const failed=autonomous.pending;
    occupancy=autonomous.expected.slice();
    queued=queued.filter(c=>c.id!==failed.id);
    await request('/api/physical/job-result',{id:failed.id,success:false,magnetOn:false,
      error:'Drop verification failed after nudge attempts.',occupancy});
    await waitState('recovery');await heartbeat();
    await panel.getByText('Robot stopped; correction is available.',{exact:true}).waitFor();
    assert.ok(applied.recoverySquares.length>0 && applied.recoverySquares.length<64);
    occupancy=failed.operation.after.slice();
    acknowledge=true;
    await waitState('playing');
    await panel.getByRole('button',{name:'Pause Autonomous Game',exact:true}).click();
    await waitState('paused');
    await panel.getByRole('button',{name:'Manual Takeover',exact:true}).click();
    await waitState('manual_ready');
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(temp, `autonomous-${viewport.width}.png`) });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Autonomous browser: startup confirmation, capability gating, pause/resume, ownership conflicts, restore-and-exit, and takeover availability passed at both desktop sizes.');
}
main().catch(async e => { console.error(e); console.error('Controller:', { ...autonomous.status(), tokens: undefined, expectedOccupancy: undefined }); if (lastPage) { console.error(await lastPage.locator('.autonomous-panel').innerText()); await lastPage.screenshot({ path: path.join(temp, 'failure.png') }); } process.exitCode = 1; }).finally(async () => {
  clearInterval(timer);
  while (working) await new Promise(r => setTimeout(r, 20));
  if (browser) await browser.close();
  await mentorFeature.close(); await new Promise(resolve => server.listening ? server.close(resolve) : resolve());
  console.log(`Browser evidence: ${temp}`);
});
