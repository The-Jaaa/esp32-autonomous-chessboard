process.env.PHYSICAL_LOG_DISABLE = '1';
process.env.MENTOR_FAKE_TEXT = '1';
process.env.MENTOR_FAKE_LIVE = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-exhibition-'));
process.env.MENTOR_DB_PATH = path.join(temporary, 'test.sqlite');
const assert = require('assert/strict');
const { ExhibitionService } = require('../exhibition-service');
const { server, mentorFeature, exhibition, physicalBoardTest: board } = require('../server');

const idle = { exhibitionSupported: true, motionBusy: false, motionPending: false, magnetOn: false,
  exhibitionEnabled: false, exhibitionRevision: 0, exhibitionServerInstanceId: '' };

function unitChecks() {
  let now = 10000;
  const state = { active: false, pending: false };
  const controller = new ExhibitionService({ board: () => state, emit: () => {}, now: () => now });
  assert.throws(() => controller.change({ enabled: true }));
  controller.report(idle);
  assert.equal(controller.change({ enabled: true }).state, 'starting');
  const revision = controller.desired.revision;
  controller.change({ enabled: true });
  assert.equal(controller.desired.revision, revision, 'Duplicate starts must not restart the animation.');
  controller.report({ ...idle, exhibitionEnabled: true, exhibitionRevision: revision,
    exhibitionServerInstanceId: controller.desired.serverInstanceId });
  assert.equal(controller.status().state, 'running');
  now += 5001;
  assert.equal(controller.status().state, 'disconnected');
  controller.stop();
  assert.equal(controller.ownsBoard(), true, 'A disconnected Stop must not release reported ownership.');
  controller.report({ ...idle, exhibitionRevision: controller.desired.revision,
    exhibitionServerInstanceId: controller.desired.serverInstanceId });
  assert.equal(controller.ownsBoard(), false);
  const stoppedRevision = controller.desired.revision;
  controller.stop();
  assert.equal(controller.desired.revision, stoppedRevision);
  for (const settings of [{ enabled: 'yes' }, { enabled: false, pattern: 'bogus' },
    { enabled: false, brightnessPercent: 101 }, { enabled: false, brightnessPercent: 10.5 },
    { enabled: false, speed: 'instant' }]) assert.throws(() => controller.change(settings), { statusCode: 400 });
  for (const runtime of [{ ...idle, motionBusy: true }, { ...idle, motionPending: true }, { ...idle, magnetOn: true }]) {
    controller.report(runtime);
    assert.throws(() => controller.change({ enabled: true }));
  }
  controller.report({ exhibitionSupported: false });
  assert.throws(() => controller.change({ enabled: true }), { code: 'exhibition_unsupported' });
  controller.report(idle);
  assert.throws(() => controller.change({ enabled: true, pattern: 'music' }), { code: 'music_unsupported' });
  controller.report({ ...idle, musicBeatSupported: true });
  assert.equal(controller.status().spectrumSupported, false);
  assert.throws(() => controller.change({ enabled: true, pattern: 'music' }), { code: 'music_unsupported' });
  controller.report({ ...idle, musicSpectrumSupported: true });
  assert.equal(controller.status().spectrumSupported, true);
  controller.change({ enabled: true, pattern: 'music', brightnessPercent: 35 });
  assert.equal(controller.desired.pattern, 'music');
  assert.equal(controller.desired.brightnessPercent, 35);
  controller.stop();
  controller.change({ enabled: false, pattern: 'auto' });
  state.active = true;
  assert.throws(() => controller.change({ enabled: true }));
  state.active = false;
  state.pending = true;
  assert.throws(() => controller.change({ enabled: true }));
  const restarted = new ExhibitionService({ board: () => state, emit: () => {}, now: () => now });
  assert.equal(restarted.desired.enabled, false);
  assert.notEqual(restarted.desired.serverInstanceId, controller.desired.serverInstanceId);
  restarted.report({ ...idle, exhibitionEnabled: true, exhibitionRevision: revision,
    exhibitionServerInstanceId: controller.desired.serverInstanceId });
  assert.equal(restarted.status().state, 'stopping', 'A restarted backend reconciles surviving animations to off.');
  assert.equal(restarted.ownsBoard(), true);
}

async function main() {
  unitChecks();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, body) {
    const response = await fetch(base + route, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { code: response.status, data: await response.json() };
  }
  async function report(runtime = {}) {
    return request('/api/physical/snapshot', { occupancy: board.occupancyFromGame(board.physicalSession.game),
      boardRuntime: { ...idle, ...runtime } });
  }
  const before = board.serializePhysicalState();
  await report();
  board.physicalSession.commands.push({ type: 'home', id: 'queued-diagnostic' });
  assert.equal((await request('/api/exhibition/light-show', { enabled: true })).code, 409);
  board.physicalSession.commands = [{ type: 'led', mode: 'celebrate-draw', id: 'obsolete-led' }];
  assert.equal((await request('/api/exhibition/light-show', { enabled: true })).code, 200);
  assert.equal(board.physicalSession.commands.length, 0, 'Starting a show must issue no movement commands.');
  assert.equal(board.physicalSession.game.fen(), before.fen);
  assert.deepEqual(board.physicalSession.moveLog, []);
  const poll = (await request('/api/physical/poll')).data;
  assert.equal(poll.exhibition.enabled, true);
  assert.equal((await request('/api/physical/poll')).data.exhibition.revision, poll.exhibition.revision,
    'Polling again must retain unacknowledged desired state.');
  await report({ exhibitionEnabled: true, exhibitionRevision: poll.exhibition.revision,
    exhibitionServerInstanceId: poll.exhibition.serverInstanceId });
  assert.equal((await request('/api/exhibition/status')).data.state, 'running');
  assert.equal((await request('/api/command', { type: 'home' })).code, 409);
  assert.equal((await request('/api/led-calibration', { pixelNumber: 1 })).code, 409);
  assert.equal((await request('/api/exhibition/light-show', {
    enabled: true, pattern: 'sweep', speed: 'fast', brightnessPercent: 45
  })).data.desired.pattern, 'sweep');

  board.startPhysicalSession();
  const startup = (await request('/api/physical/poll')).data;
  assert.equal(startup.exhibition.enabled, false);
  assert.ok(startup.commands.some(command => command.type === 'home'));
  assert.equal((await request('/api/exhibition/light-show', { enabled: true })).code, 409);
  await report({ exhibitionServerInstanceId: exhibition.desired.serverInstanceId,
    exhibitionRevision: exhibition.desired.revision });
  board.physicalSession.commands = [];
  let current = board.serializePhysicalState();
  assert.equal(current.phase, 'ready');
  for (const san of ['e4', 'e5']) {
    const move = board.physicalSession.game.move(san);
    board.physicalSession.moveLog.push({ ...move, uci: move.from + move.to,
      side: move.color === 'w' ? 'human' : 'robot', verified: true });
  }
  await report();
  current = board.serializePhysicalState();
  const history = [...current.history];
  const endBody = () => ({ expectedSessionGeneration: current.sessionGeneration, expectedRevision: current.stateRevision });
  assert.equal((await request('/api/physical/end', { ...endBody(), expectedRevision: -1 })).code, 409);
  board.physicalSession.phase = 'robot_busy';
  assert.equal((await request('/api/physical/end', endBody())).code, 409);
  board.physicalSession.phase = 'ready';
  await report({ magnetOn: true });
  current = board.serializePhysicalState();
  assert.equal((await request('/api/physical/end', endBody())).code, 409);
  await report();
  current = board.serializePhysicalState();
  const originalAvailability = mentorFeature.physicalObserver.availability;
  mentorFeature.physicalObserver.availability = () => ({ boundConversationId: 'owner-chat' });
  assert.equal((await request('/api/physical/end', endBody())).data.code, 'mentor_owned_game');
  mentorFeature.physicalObserver.availability = originalAvailability;
  board.physicalSession.occupancy[0] = !board.physicalSession.occupancy[0];
  assert.equal((await request('/api/physical/end', endBody())).code, 409);
  board.physicalSession.occupancy = board.occupancyFromGame(board.physicalSession.game);
  board.physicalSession.lastSnapshotAt = Date.now() - 6000;
  assert.equal((await request('/api/physical/end', endBody())).code, 409);
  await report();
  current = board.serializePhysicalState();
  const ended = await request('/api/physical/end', endBody());
  assert.equal(ended.code, 200);
  assert.equal(ended.data.state.active, false);
  assert.equal(ended.data.state.fen, current.fen);
  assert.deepEqual(ended.data.state.history, history);
  assert.equal(ended.data.state.physicalMoveLog.length, 2);
  board.physicalSession.commands = [];
  assert.equal((await request('/api/exhibition/light-show', { enabled: true })).code, 200);
  const unsupported = await request('/api/physical/snapshot', { occupancy: Array(64).fill(false) });
  assert.equal(unsupported.code, 200);
  assert.equal((await request('/api/exhibition/status')).data.state, 'unsupported');
  console.log('Exhibition controller, physical protocol, ownership, and End regressions passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await mentorFeature.close();
  await new Promise(resolve => server.listening ? server.close(resolve) : resolve());
  fs.rmSync(temporary, { recursive: true, force: true });
});
