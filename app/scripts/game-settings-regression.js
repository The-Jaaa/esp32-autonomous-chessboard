process.env.PHYSICAL_LOG_DISABLE = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MentorStore } = require('../mentor/store');
const { GameSettingsService } = require('../game-settings-service');

function tempDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-settings-'));
  return { directory, file: path.join(directory, 'mentor.sqlite') };
}

function expectError(fn, code, statusCode) {
  assert.throws(fn, (error) => error.code === code && error.statusCode === statusCode);
}

function storeRegression() {
  const temp = tempDatabase();
  let store = new MentorStore({ dbPath: temp.file });
  store.migrate();
  store.migrate();
  assert.deepStrictEqual(
    (({ humanColor, difficultyLevel }) => ({ humanColor, difficultyLevel }))(store.getAppSettings()),
    { humanColor: 'white', difficultyLevel: 1 }
  );
  store.updateAppSettings({ humanColor: 'black', difficultyLevel: 12 });
  store.close();

  store = new MentorStore({ dbPath: temp.file });
  assert.strictEqual(store.getAppSettings().humanColor, 'black');
  assert.strictEqual(store.getAppSettings().difficultyLevel, 12);
  expectError(() => store.updateAppSettings({ humanColor: 'blue' }), 'invalid_human_color', 400);
  expectError(() => store.updateAppSettings({ difficultyLevel: 0 }), 'invalid_difficulty_level', 400);
  expectError(() => store.updateAppSettings({ difficultyLevel: 16 }), 'invalid_difficulty_level', 400);
  expectError(() => store.updateAppSettings({ difficultyLevel: 2.5 }), 'invalid_difficulty_level', 400);
  store.close();
  fs.rmSync(temp.directory, { recursive: true, force: true });
}

function serviceRegression() {
  const store = new MentorStore({ dbPath: ':memory:' });
  const events = [];
  let physical = {
    active: true,
    sessionGeneration: 7,
    humanColor: 'white',
    robotColor: 'black',
    configuredLevel: 1
  };
  const service = new GameSettingsService({
    store,
    emit: (event, payload) => events.push({ event, payload })
  });
  service.setPhysicalAdapter({
    getState: () => physical,
    isConversationAttached: (conversationId) => conversationId === 'attached-chat',
    updateDifficulty: ({ difficultyLevel, expectedSessionGeneration }) => {
      if (expectedSessionGeneration !== physical.sessionGeneration) {
        const error = new Error('stale');
        error.code = 'stale_physical_session';
        error.statusCode = 409;
        throw error;
      }
      physical = { ...physical, configuredLevel: difficultyLevel };
    }
  });

  expectError(() => service.updateDefaults({}), 'missing_game_setting', 400);
  const updated = service.updateDefaults({ humanColor: 'black', difficultyLevel: 5 });
  assert.strictEqual(updated.defaults.humanColor, 'black');
  assert.strictEqual(updated.defaults.difficultyLevel, 5);
  assert.strictEqual(events.at(-1).event, 'game-settings-updated');

  const detached = service.updateFromMentor('other-chat', { difficultyLevel: 8, humanColor: 'white' });
  assert.strictEqual(detached.difficultyAppliedToActiveGame, false);
  assert.strictEqual(detached.sideAppliesNextGame, true);
  assert.strictEqual(physical.configuredLevel, 1);

  const attached = service.updateFromMentor('attached-chat', { difficultyLevel: 9, humanColor: 'black' });
  assert.strictEqual(attached.difficultyAppliedToActiveGame, true);
  assert.strictEqual(attached.sideAppliesNextGame, true);
  assert.strictEqual(physical.configuredLevel, 9);
  assert.strictEqual(physical.humanColor, 'white');

  service.updateActiveDifficulty({ difficultyLevel: 10, expectedSessionGeneration: 7 });
  assert.strictEqual(physical.configuredLevel, 10);
  expectError(
    () => service.updateActiveDifficulty({ difficultyLevel: 11, expectedSessionGeneration: 6 }),
    'stale_physical_session',
    409
  );
  store.close();
}

async function endpointRegression() {
  const temp = tempDatabase();
  process.env.MENTOR_DB_PATH = temp.file;
  const { server, mentorFeature, physicalBoardTest, physicalPlanner } = require('../server');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/api/game-settings`);
    let body = await response.json();
    assert.strictEqual(body.defaults.humanColor, 'white');
    assert.strictEqual(body.defaults.difficultyLevel, 1);

    response = await fetch(`${base}/api/game-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ humanColor: 'black', difficultyLevel: 7 })
    });
    body = await response.json();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.defaults.humanColor, 'black');

    response = await fetch(`${base}/api/game-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ difficultyLevel: 99 })
    });
    body = await response.json();
    assert.strictEqual(response.status, 400);
    assert.strictEqual(body.code, 'invalid_difficulty_level');

    await physicalBoardTest.processPhysicalSnapshot(
      physicalBoardTest.occupancyFromFen(physicalPlanner.PHYSICAL_START_FEN),
      { source: 'game-settings-regression' }
    );
    const conversation = mentorFeature.store.createConversation();
    const pair = mentorFeature.store.createMessagePair(conversation.id, {
      requestId: 'mentor-start-shared-settings',
      text: 'Start a physical game.'
    });
    const toolResult = await mentorFeature.toolService.execute({
      conversationId: conversation.id,
      requestId: 'mentor-start-shared-settings',
      assistantMessageId: pair.assistantMessage.id,
      ordinal: 1,
      call: { id: 'mentor-start-shared-settings-call', name: 'start_physical_game', args: {} },
      signal: new AbortController().signal
    });
    assert.strictEqual(toolResult.toolCall.status, 'complete');
    const physicalState = physicalBoardTest.serializePhysicalState();
    assert.strictEqual(physicalState.humanColor, 'black');
    assert.strictEqual(physicalState.configuredLevel, 7);
    assert.strictEqual(physicalState.profile, 'balanced');
    const generation = physicalState.sessionGeneration;

    response = await fetch(`${base}/api/physical/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ difficultyLevel: 8, expectedSessionGeneration: generation - 1 })
    });
    body = await response.json();
    assert.strictEqual(response.status, 409);
    assert.strictEqual(body.code, 'stale_physical_session');

    response = await fetch(`${base}/api/physical/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ difficultyLevel: 8, expectedSessionGeneration: generation })
    });
    body = await response.json();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.activePhysical.configuredLevel, 8);
    assert.strictEqual(body.activePhysical.humanColor, 'black');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mentorFeature.store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
}

async function run() {
  storeRegression();
  serviceRegression();
  await endpointRegression();
  console.log('Game settings regression passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
