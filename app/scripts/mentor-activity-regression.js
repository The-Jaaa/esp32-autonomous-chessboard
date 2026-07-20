const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MentorStore } = require('../mentor/store');
const { MentorChessService } = require('../mentor/chess-service');
const { MentorToolService } = require('../mentor/tool-service');
const { MentorService } = require('../mentor/service');
const { MentorActivityService } = require('../mentor/activity-service');

function temporaryDatabase(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `mentor-activity-${name}-`));
  return { directory, file: path.join(directory, 'mentor.sqlite') };
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function analysisResult(chess, conversationId) {
  const state = chess.getState(conversationId);
  const blackToMove = state.turn === 'b';
  const lines = blackToMove
    ? [
      { rank: 1, move: 'e7e5', moveSan: 'e5', score: { type: 'cp', value: 10, perspective: 'white' } },
      { rank: 2, move: 'c7c5', moveSan: 'c5', score: { type: 'cp', value: 25, perspective: 'white' } },
      { rank: 3, move: 'c7c6', moveSan: 'c6', score: { type: 'cp', value: 85, perspective: 'white' } }
    ]
    : [
      { rank: 1, move: 'e2e4', moveSan: 'e4', score: { type: 'cp', value: 20, perspective: 'white' } },
      { rank: 2, move: 'd2d4', moveSan: 'd4', score: { type: 'cp', value: 5, perspective: 'white' } },
      { rank: 3, move: 'g1f3', moveSan: 'Nf3', score: { type: 'cp', value: -70, perspective: 'white' } }
    ];
  return {
    kind: 'position_analysis',
    analyzedFen: state.fen,
    analyzedRevision: state.revision,
    mode: 'quick',
    score: lines[0].score,
    bestMove: { uci: lines[0].move, san: lines[0].moveSan },
    lines,
    telemetry: { elapsedMs: 1 }
  };
}

function createHarness(provider) {
  const store = new MentorStore({ dbPath: ':memory:' });
  const chess = new MentorChessService({ store });
  const boardUpdates = [];
  const events = [];
  const analysis = {
    analyzePosition: async (conversationId) => analysisResult(chess, conversationId),
    analyzeMove: async () => { throw new Error('Not needed by this regression.'); }
  };
  const emitBoardUpdate = (conversationId, result) => boardUpdates.push({ conversationId, result });
  const toolService = new MentorToolService({
    store,
    chessService: chess,
    analysisService: analysis,
    emitBoardUpdate,
    emit: (conversationId, event, payload) => events.push({ conversationId, event, payload })
  });
  const activity = new MentorActivityService({
    store,
    chessService: chess,
    analysisService: analysis,
    emitBoardUpdate,
    emit: (conversationId, event, payload) => events.push({ conversationId, event, payload }),
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
  return { store, chess, analysis, activity, toolService, service, boardUpdates, events };
}

async function waitForActivityIdle(activity, conversationId, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!activity.inFlight.has(conversationId)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the activity turn.');
}

async function guaranteedFallbackRegression() {
  const provider = {
    async *stream({ executeTool }) {
      yield 'I am checking the position. ';
      await executeTool({ id: `analysis-${Math.random()}`, name: 'analyze_position', args: { mode: 'quick' } });
      yield 'Black has several choices.';
    }
  };
  const harness = createHarness(provider);
  const conversation = harness.store.createConversation();
  const started = harness.activity.startPractice(conversation.id, {
    learnerColor: 'white',
    startFrom: 'standard',
    expectedRevision: 0
  });
  assert.strictEqual(started.phase, 'learner_turn');

  const active = harness.activity.validateLearnerMove(conversation.id, { uci: 'e2e4', expectedRevision: 0 });
  const human = harness.chess.move(conversation.id, {
    uci: 'e2e4', expectedRevision: 0, actionId: 'learner-e4', actor: 'learner', activityId: active.id
  });
  harness.activity.learnerMoveCommitted(conversation.id, human);
  await waitForActivityIdle(harness.activity, conversation.id);

  const state = harness.chess.getState(conversation.id);
  assert.deepStrictEqual(state.history.map((move) => move.uci), ['e2e4', 'e7e5']);
  const activity = harness.activity.get(conversation.id);
  assert.strictEqual(activity.phase, 'learner_turn');
  assert.strictEqual(activity.state.fallbackMoves, 1);
  assert.strictEqual(activity.events.filter((event) => event.type === 'mentor_turn_corrective').length, 1);
  assert.strictEqual(activity.events.filter((event) => event.type === 'engine_fallback_move').length, 1);
  assert.strictEqual(harness.store.listMessages(conversation.id).filter((message) => message.kind === 'activity').length, 4);
  const fallbackCard = harness.store.listToolCalls(conversation.id).find((call) => call.name === 'engine_fallback');
  assert.strictEqual(fallbackCard.status, 'complete');
  assert.strictEqual(fallbackCard.result.move.uci, 'e7e5');
  harness.store.close();
}

async function teachingMoveRegression() {
  const provider = {
    async *stream({ executeTool }) {
      await executeTool({ id: 'teaching-analysis', name: 'analyze_position', args: { mode: 'quick' } });
      const played = await executeTool({ id: 'teaching-move', name: 'play_move', args: { uci: 'c7c5' } });
      assert.ok(played.response.output.move);
      yield 'I chose a sound teaching move.';
    }
  };
  const harness = createHarness(provider);
  const conversation = harness.store.createConversation();
  harness.activity.startPractice(conversation.id, { learnerColor: 'white', expectedRevision: 0 });
  const human = harness.chess.move(conversation.id, {
    uci: 'e2e4', expectedRevision: 0, actionId: 'teaching-e4', actor: 'learner', activityId: harness.activity.get(conversation.id).id
  });
  harness.activity.learnerMoveCommitted(conversation.id, human);
  await waitForActivityIdle(harness.activity, conversation.id);
  assert.deepStrictEqual(harness.chess.getState(conversation.id).history.map((move) => move.uci), ['e2e4', 'c7c5']);
  assert.strictEqual(harness.activity.get(conversation.id).state.fallbackMoves, 0);
  harness.store.close();
}

async function blackLearnerAndDuplicateTriggerRegression() {
  let providerCalls = 0;
  const provider = {
    async *stream({ executeTool }) {
      providerCalls += 1;
      await executeTool({ id: 'white-analysis', name: 'analyze_position', args: { mode: 'quick' } });
      await executeTool({ id: 'white-move', name: 'play_move', args: { uci: 'e2e4' } });
      yield 'I opened with the king pawn. Your move.';
    }
  };
  const harness = createHarness(provider);
  const conversation = harness.store.createConversation();
  harness.activity.startPractice(conversation.id, {
    learnerColor: 'black',
    startFrom: 'standard',
    expectedRevision: 0
  });
  harness.activity.scheduleMentorTurn(conversation.id, 'duplicate_socket');
  harness.activity.scheduleMentorTurn(conversation.id, 'duplicate_socket');
  await waitForActivityIdle(harness.activity, conversation.id);

  assert.strictEqual(providerCalls, 1);
  assert.deepStrictEqual(harness.chess.getState(conversation.id).history.map((move) => move.uci), ['e2e4']);
  assert.strictEqual(harness.activity.get(conversation.id).phase, 'learner_turn');
  harness.store.close();
}

async function predictionAndPauseRegression() {
  const provider = {
    async *stream({ executeTool }) {
      await executeTool({ id: 'prediction-analysis', name: 'analyze_position', args: { mode: 'quick' } });
      await executeTool({
        id: 'prediction-request',
        name: 'request_prediction',
        args: { prompt: 'What should Black play against the center?' }
      });
      yield 'Predict Black\'s response.';
    }
  };
  const harness = createHarness(provider);
  const conversation = harness.store.createConversation();
  harness.activity.startPractice(conversation.id, { learnerColor: 'white', expectedRevision: 0 });
  const human = harness.chess.move(conversation.id, {
    uci: 'e2e4', expectedRevision: 0, actionId: 'prediction-e4', actor: 'learner', activityId: harness.activity.get(conversation.id).id
  });
  harness.activity.learnerMoveCommitted(conversation.id, human);
  await waitForActivityIdle(harness.activity, conversation.id);
  assert.strictEqual(harness.activity.get(conversation.id).phase, 'awaiting_prediction');
  assert.throws(
    () => harness.activity.validateLearnerMove(conversation.id, { uci: 'g1f3', expectedRevision: 1 }),
    (error) => error.code === 'activity_not_learner_turn'
  );
  const prepared = harness.activity.prepareConversationTurn(conversation.id, 'prediction-answer');
  assert.strictEqual(prepared.phase, 'mentor_thinking');
  assert.strictEqual(prepared.pendingRequestId, 'prediction-answer');
  harness.activity.pause(conversation.id, 'test_pause');
  assert.strictEqual(harness.activity.get(conversation.id).phase, 'paused');
  harness.activity.resume(conversation.id);
  assert.ok(['mentor_turn', 'mentor_thinking'].includes(harness.activity.get(conversation.id).phase));
  await waitForActivityIdle(harness.activity, conversation.id);
  harness.activity.end(conversation.id);
  assert.strictEqual(harness.activity.get(conversation.id), null);
  harness.store.close();
}

function restartRecoveryRegression() {
  const temp = temporaryDatabase('restart');
  let store = new MentorStore({ dbPath: temp.file });
  const chess = new MentorChessService({ store });
  const conversation = store.createConversation();
  const activity = store.createActivity({
    conversationId: conversation.id,
    type: 'practice_game',
    title: 'Practice game',
    learnerColor: 'white',
    mentorColor: 'black',
    startFen: chess.getState(conversation.id).fen,
    startRevision: 0,
    phase: 'mentor_thinking'
  });
  store.updateActivity(activity.id, { pendingRequestId: 'interrupted' });
  store.close();
  store = new MentorStore({ dbPath: temp.file });
  const recovered = store.getActiveActivity(conversation.id);
  assert.strictEqual(recovered.phase, 'mentor_turn');
  assert.strictEqual(recovered.pendingRequestId, null);
  assert.strictEqual(recovered.generation, 2);
  store.close();
  cleanup(temp.directory);
}

async function explicitConsentRegression() {
  const harness = createHarness({ async *stream() { yield 'Ready.'; } });
  const declined = harness.store.createConversation();
  harness.store.createMessagePair(declined.id, {
    requestId: 'ask-only', text: 'What is a practice game?'
  });
  await assert.rejects(
    harness.toolService.runTool('start_activity', { type: 'practice_game' }, {
      conversationId: declined.id,
      requestId: 'ask-only',
      signal: null,
      onProgress: () => {}
    }),
    (error) => error.code === 'activity_confirmation_required'
  );
  const accepted = harness.store.createConversation();
  harness.store.createMessagePair(accepted.id, {
    requestId: 'confirmed', text: 'Yes, start a practice game.'
  });
  const result = await harness.toolService.runTool('start_activity', {
    type: 'practice_game', learnerColor: 'white', startFrom: 'standard'
  }, {
    conversationId: accepted.id,
    requestId: 'confirmed',
    signal: null,
    onProgress: () => {}
  });
  assert.strictEqual(result.activity.type, 'practice_game');
  harness.store.close();
}

async function main() {
  restartRecoveryRegression();
  await explicitConsentRegression();
  await guaranteedFallbackRegression();
  await teachingMoveRegression();
  await blackLearnerAndDuplicateTriggerRegression();
  await predictionAndPauseRegression();
  console.log('Mentor activity coordinator regressions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
