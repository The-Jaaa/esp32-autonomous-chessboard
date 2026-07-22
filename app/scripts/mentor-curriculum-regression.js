const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MentorStore } = require('../mentor/store');
const { MentorChessService } = require('../mentor/chess-service');
const { MentorToolService } = require('../mentor/tool-service');
const { MentorService } = require('../mentor/service');
const { MentorActivityService } = require('../mentor/activity-service');
const { OPENINGS, PUZZLES, LESSONS, getCatalogItem } = require('../mentor/curriculum');

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-curriculum-'));
  return { directory, file: path.join(directory, 'mentor.sqlite') };
}

function createHarness({ dbPath = ':memory:' } = {}) {
  const store = new MentorStore({ dbPath });
  const chess = new MentorChessService({ store });
  const events = [];
  let activity;
  const provider = {
    async *stream({ history, executeTool }) {
      const prompt = history.at(-1)?.content || '';
      const expected = prompt.match(/requires exactly ([a-h][1-8][a-h][1-8][qrbn]?)/)?.[1];
      if (expected) await executeTool({ id: `scripted-${expected}`, name: 'play_move', args: { uci: expected } });
      yield expected ? `I played ${expected} to continue the activity.` : 'Ready.';
    }
  };
  const engineService = {
    async analyzeFen(fen) {
      const item = PUZZLES.find((candidate) => candidate.initialFen === fen);
      const move = item?.line[0] || 'e2e4';
      return {
        lines: [
          { move, score: { type: 'mate', value: 1 } },
          { move: 'a2a3', score: { type: 'cp', value: 0 } }
        ]
      };
    }
  };
  const analysis = { analyzePosition: async () => ({ bestMove: { uci: 'e7e5' } }) };
  const toolService = new MentorToolService({ store, chessService: chess, analysisService: analysis });
  activity = new MentorActivityService({
    store,
    chessService: chess,
    analysisService: analysis,
    engineService,
    emit: (conversationId, event, payload) => events.push({ conversationId, event, payload }),
    emitGlobal: (event, payload) => events.push({ conversationId: null, event, payload }),
    logger: { error: () => {} }
  });
  toolService.setActivityService(activity);
  const service = new MentorService({
    store,
    provider,
    toolService,
    activityService: activity,
    contextProvider: (conversationId) => chess.promptContext(conversationId),
    logger: { error: () => {} }
  });
  activity.setRunners({
    text: ({ conversationId, requestId, displayText, prompt }) =>
      service.submitActivityTurn(conversationId, { requestId, displayText, prompt })
  });
  return { store, chess, activity, events };
}

async function waitForIdle(activity, conversationId, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!activity.inFlight.has(conversationId)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Activity did not become idle.');
}

function commitLearner(harness, conversationId, uci, actionId) {
  const state = harness.chess.getState(conversationId);
  const active = harness.activity.validateLearnerMove(conversationId, {
    uci,
    expectedRevision: state.revision
  });
  const result = harness.chess.move(conversationId, {
    uci,
    expectedRevision: state.revision,
    actionId,
    actor: 'learner',
    activityId: active.id
  });
  harness.activity.learnerMoveCommitted(conversationId, result);
  return result;
}

function catalogRegression() {
  assert.strictEqual(OPENINGS.length, 18);
  assert.strictEqual(PUZZLES.length, 12);
  assert.strictEqual(LESSONS.length, 5);
  assert.strictEqual(new Set([...OPENINGS, ...PUZZLES, ...LESSONS].map((item) => item.id)).size, 35);
  assert(OPENINGS.every((item) => item.line.length === 10 && item.supportsPhysical));
  assert.ok(getCatalogItem('italian-game'));
}

async function openingAndScoringRegression() {
  const harness = createHarness();
  const conversation = harness.store.createConversation();
  harness.activity.startCatalogActivity(conversation.id, {
    sourceId: 'italian-game', learnerColor: 'white', expectedRevision: 0
  });
  commitLearner(harness, conversation.id, 'e2e4', 'italian-e4');
  await waitForIdle(harness.activity, conversation.id);
  assert.deepStrictEqual(harness.chess.getState(conversation.id).history.map((move) => move.uci), ['e2e4', 'e7e5']);

  const revision = harness.chess.getState(conversation.id).revision;
  assert.throws(
    () => harness.activity.validateLearnerMove(conversation.id, { uci: 'b1c3', expectedRevision: revision }),
    (error) => error.code === 'activity_incorrect_move'
  );
  assert.strictEqual(harness.chess.getState(conversation.id).revision, revision);
  const hint = harness.activity.requestHint(conversation.id);
  assert.strictEqual(hint.level, 1);
  commitLearner(harness, conversation.id, 'g1f3', 'italian-nf3');
  await waitForIdle(harness.activity, conversation.id);
  commitLearner(harness, conversation.id, 'f1c4', 'italian-bc4');
  await waitForIdle(harness.activity, conversation.id);
  commitLearner(harness, conversation.id, 'd2d3', 'italian-d3');
  await waitForIdle(harness.activity, conversation.id);
  commitLearner(harness, conversation.id, 'e1g1', 'italian-castle');
  await waitForIdle(harness.activity, conversation.id);

  assert.strictEqual(harness.activity.get(conversation.id), null);
  const completed = harness.store.listActivities(conversation.id)[0];
  assert.strictEqual(completed.status, 'complete');
  assert.strictEqual(completed.stepIndex, 10);
  const openingProgress = harness.store.listTopicProgress().find((item) => item.topic === 'openings');
  assert.strictEqual(openingProgress.mastery, 3);
  assert.strictEqual(harness.store.awardActivityProgress(completed.id, ['openings'], 10).awarded, false);
  assert.strictEqual(harness.store.listTopicProgress().find((item) => item.topic === 'openings').mastery, 3);
  harness.store.close();
}

async function puzzleAndRecommendationRegression() {
  const harness = createHarness();
  const conversation = harness.store.createConversation();
  harness.activity.startCatalogActivity(conversation.id, {
    sourceId: 'back-rank-mate', expectedRevision: 0
  });
  commitLearner(harness, conversation.id, 'e1e8', 'puzzle-mate');
  const completed = harness.store.listActivities(conversation.id)[0];
  assert.strictEqual(completed.status, 'complete');
  assert.strictEqual(harness.store.listTopicProgress().find((item) => item.topic === 'mate_patterns').mastery, 10);

  const updated = harness.activity.updateProfile({
    skillBand: 'Intermediate', goals: ['Improve tactics', 'Learn openings']
  });
  assert.strictEqual(updated.profile.skillBand, 'Intermediate');
  assert.deepStrictEqual(updated.profile.goals, ['Improve tactics', 'Learn openings']);
  assert.ok(updated.recommendations.length > 0);
  harness.store.close();
}

async function generatedFallbackAndPersistenceRegression() {
  const temp = temporaryDatabase();
  let harness = createHarness({ dbPath: temp.file });
  const conversation = harness.store.createConversation();
  const activity = await harness.activity.startActivity(conversation.id, {
    type: 'puzzle',
    expectedRevision: 0,
    proposal: {
      type: 'puzzle', title: 'Broken puzzle', goal: 'Invalid', topic: 'forks',
      initialFen: 'not a fen', line: ['a1a9']
    }
  });
  assert.strictEqual(activity.type, 'puzzle');
  assert.notStrictEqual(activity.sourceId, 'generated');
  harness.activity.end(conversation.id);
  harness.activity.updateProfile({ skillBand: 'Advanced', goals: ['Calculation'] });
  harness.store.close();

  harness = createHarness({ dbPath: temp.file });
  assert.strictEqual(harness.store.getLearnerProfile().skillBand, 'Advanced');
  assert.deepStrictEqual(harness.store.getLearnerProfile().goals, ['Calculation']);
  harness.store.close();
  fs.rmSync(temp.directory, { recursive: true, force: true });
}

async function blackOpeningRegression() {
  const harness = createHarness();
  const conversation = harness.store.createConversation();
  harness.activity.startCatalogActivity(conversation.id, {
    sourceId: 'french-defense', learnerColor: 'black', expectedRevision: 0
  });
  await waitForIdle(harness.activity, conversation.id);
  assert.deepStrictEqual(harness.chess.getState(conversation.id).history.map((move) => move.uci), ['e2e4']);
  assert.strictEqual(harness.activity.get(conversation.id).phase, 'learner_turn');
  commitLearner(harness, conversation.id, 'e7e6', 'french-e6');
  await waitForIdle(harness.activity, conversation.id);
  assert.deepStrictEqual(harness.chess.getState(conversation.id).history.map((move) => move.uci), ['e2e4', 'e7e6', 'd2d4']);
  harness.store.close();
}

async function everyCatalogActivityRegression() {
  for (const item of [...OPENINGS, ...PUZZLES, ...LESSONS]) {
    const harness = createHarness();
    const conversation = harness.store.createConversation();
    harness.activity.startCatalogActivity(conversation.id, {
      sourceId: item.id,
      learnerColor: item.fixedLearnerColor || 'white',
      expectedRevision: 0
    });
    let guard = 0;
    while (harness.activity.get(conversation.id) && guard < 30) {
      guard += 1;
      const active = harness.activity.get(conversation.id);
      if (active.phase === 'mentor_turn' || active.phase === 'mentor_thinking') {
        harness.activity.scheduleMentorTurn(conversation.id, 'catalog_regression');
        await waitForIdle(harness.activity, conversation.id);
        continue;
      }
      assert.strictEqual(active.phase, 'learner_turn', `${item.id} entered ${active.phase}`);
      commitLearner(harness, conversation.id, active.config.line[active.stepIndex], `${item.id}:${active.stepIndex}`);
      await waitForIdle(harness.activity, conversation.id);
    }
    assert.ok(guard < 30, `${item.id} did not complete`);
    assert.strictEqual(harness.store.listActivities(conversation.id)[0].status, 'complete', `${item.id} did not complete`);
    harness.store.close();
  }
}

async function main() {
  catalogRegression();
  await openingAndScoringRegression();
  await puzzleAndRecommendationRegression();
  await generatedFallbackAndPersistenceRegression();
  await blackOpeningRegression();
  await everyCatalogActivityRegression();
  console.log('Mentor curriculum and learner progress regressions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
