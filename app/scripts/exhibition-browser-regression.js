process.env.PHYSICAL_LOG_DISABLE = '1';
process.env.MENTOR_FAKE_TEXT = '1';
process.env.MENTOR_FAKE_LIVE = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-exhibition-browser-'));
process.env.MENTOR_DB_PATH = path.join(temporary, 'test.sqlite');
const { loadPlaywright } = require('./playwright-runtime');
const { server, mentorFeature, exhibition, physicalBoardTest: board } = require('../server');

let firmwareConnected = true, acknowledge = true, supported = true, spectrumSupported = true;
let applied = { enabled: false, revision: 0, serverInstanceId: '' };
function heartbeat() {
  if (!firmwareConnected) return;
  // Simulated connected firmware continues reporting sensors while UI checks run.
  board.physicalSession.lastSnapshotAt = Date.now();
  if (acknowledge) applied = { ...exhibition.desired };
  exhibition.report({ musicSpectrumSupported: spectrumSupported, exhibitionSupported: supported, motionBusy: false, motionPending: false, magnetOn: false,
    exhibitionEnabled: applied.enabled, exhibitionRevision: applied.revision,
    exhibitionServerInstanceId: applied.serverInstanceId });
}
let browser, timer;
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await loadPlaywright().chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true
  });
  heartbeat();
  timer = setInterval(heartbeat, 250);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const panel = page.getByRole('region', { name: 'Exhibition', exact: true });
    const showState = text => panel.getByRole('status').filter({ hasText: `Light show: ${text}` }).waitFor();
    await showState('off');
    acknowledge = false;
    await panel.getByRole('button', { name: 'Start Light Show' }).click();
    await showState('starting');
    assert.equal(await page.getByRole('button', { name: 'Home Gantry', exact: true }).isDisabled(), true);
    acknowledge = true;
    await showState('running');
    await panel.getByLabel('Light-show pattern').selectOption('sweep');
    await panel.getByLabel('Light-show speed').selectOption('fast');
    await panel.getByLabel('Light-show brightness').fill('40');
    await page.waitForFunction(async () => (await fetch('/api/exhibition/status').then(r => r.json())).desired.brightnessPercent === 40);
    assert.equal(exhibition.desired.pattern, 'sweep');
    assert.equal(exhibition.desired.speed, 'fast');
    await panel.getByLabel('Light-show pattern').selectOption('music');
    await panel.getByText('Play music through', { exact: false }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Light-show pattern"]').disabled);
    assert.equal(await panel.getByLabel('Light-show speed').isDisabled(), true);
    await panel.getByLabel('Light-show brightness').fill('35');
    await page.waitForFunction(async () => (await fetch('/api/exhibition/status').then(r => r.json())).desired.brightnessPercent === 35);
    await panel.getByLabel('Light-show pattern').selectOption('sweep');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Light-show speed"]').disabled);
    spectrumSupported = false;
    heartbeat();
    await panel.getByText('Update board firmware to enable Spectrum.', { exact: true }).waitFor();
    assert.equal(await panel.locator('option[value="music"]').evaluate(option => option.disabled), true);
    spectrumSupported = true;
    heartbeat();
    const observer = await context.newPage();
    await observer.goto(base);
    await observer.getByRole('button', { name: 'Stop Light Show' }).waitFor();
    await page.reload();
    await showState('running');
    firmwareConnected = false;
    await panel.getByRole('status').filter({ hasText: 'disconnected' }).waitFor({ timeout: 10000 });
    await panel.getByRole('button', { name: 'Stop Light Show' }).click();
    assert.equal(applied.enabled, true, 'Offline Stop must not claim to have stopped the board.');
    firmwareConnected = true;
    await showState('off');
    await observer.getByRole('button', { name: 'Start Light Show' }).waitFor();
    await panel.getByRole('button', { name: 'Start Light Show' }).click();
    await showState('running');
    await page.getByRole('button', { name: 'Start Physical Game', exact: true }).click();
    await showState('off');
    assert.equal(board.physicalSession.active, true);
    board.physicalSession.commands = [];
    await board.processPhysicalSnapshot(board.occupancyFromGame(board.physicalSession.game));
    board.physicalSession.commands = [];
    await page.getByRole('button', { name: 'End Physical Game', exact: true }).click();
    await page.getByText('Pieces stay where they are;', { exact: false }).waitFor();
    const endResponse = page.waitForResponse(response => response.url().endsWith('/api/physical/end'));
    await page.getByRole('button', { name: 'Confirm End Game' }).click();
    const ended = await endResponse;
    assert.equal(ended.status(), 200, JSON.stringify(await ended.json()));
    assert.equal(board.physicalSession.active, false);
    await panel.getByRole('button', { name: 'Start Light Show' }).waitFor();
    await page.waitForFunction(async () => !(await fetch('/api/physical/status').then(r => r.json())).state.active);
    board.physicalSession.commands = [];
    supported = false;
    heartbeat();
    await panel.getByText('Update board firmware', { exact: false }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Start Light Show' }).isDisabled(), true);
    supported = true;
    heartbeat();
    await showState('off');
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(temporary, `exhibition-${viewport.width}.png`) });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Exhibition desktop browser regressions passed at 1440x900 and 1920x1080.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearInterval(timer);
  if (browser) await browser.close();
  await mentorFeature.close();
  await new Promise(resolve => server.listening ? server.close(resolve) : resolve());
  // Screenshots remain available for inspection; no real board was connected.
  console.log(`Browser evidence: ${temporary}`);
});
