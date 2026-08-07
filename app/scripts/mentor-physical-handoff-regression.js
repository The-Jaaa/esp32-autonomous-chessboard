const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Chess } = require('chess.js');
const { MentorStore, STANDARD_FEN } = require('../mentor/store');
const { MentorActivityService } = require('../mentor/activity-service');
const { MentorPhysicalObserverService } = require('../mentor/physical-observer-service');
const { MentorToolService } = require('../mentor/tool-service');
const { GameSettingsService } = require('../game-settings-service');

function makeSnapshot(overrides = {}) {
  const game = new Chess(overrides.fen || STANDARD_FEN);
  return {
    serverInstanceId: 'handoff-server',
    sessionGeneration: 4,
    stateRevision: 10,
    active: true,
    phase: 'ready',
    setupMode: 'full',
    statusText: 'Ready.',
    fen: game.fen(),
    pgn: game.pgn(),
    humanColor: 'white',
    robotColor: 'black',
    configuredLevel: 2,
    activeSearchLevel: null,
    difficultyPending: false,
    physicalMoveLog: [],
    board: { ready: true, missingSquares: [], extraSquares: [] },
    robotGraveyardOccupied: [],
    selectedSource: null,
    robotBusy: false,
    pendingRobotJob: null,
    pendingUndo: null,
    pendingRedo: null,
    pendingPromotion: null,
    lastSnapshotAt: Date.now(),
    ...overrides
  };
}

function createHarness(dbPath) {
  const store = new MentorStore({ dbPath });
  let snapshot = makeSnapshot();
  const emitted = [];
  const stopped = [];
  const scripted = [];
  const gameStarts = [];
  let gameEnds = 0;
  let defaultHumanColor = 'white';
  let observer;
  const adapter = {
    getSnapshot: () => snapshot,
    getGameStatus: () => ({ sensorFresh: true, sensorAgeMs: 1 }),
    startDefaultGame: (options = {}) => {
      gameStarts.push(options);
      snapshot = makeSnapshot({
        sessionGeneration: snapshot.sessionGeneration + 1,
        stateRevision: snapshot.stateRevision + 1,
        humanColor: defaultHumanColor,
        robotColor: defaultHumanColor === 'white' ? 'black' : 'white'
      });
      observer.handleSnapshot(snapshot, 'physical-status');
      return { success: true };
    },
    endGame: () => {
      gameEnds += 1;
      snapshot = makeSnapshot({ active: false, phase: 'idle', stateRevision: snapshot.stateRevision + 1 });
      observer.handleSnapshot(snapshot, 'physical-status');
      return { success: true };
    },
    setOpeningDrill: () => {},
    resolveOpeningDrill: () => ({ success: true }),
    startActivityScriptedTurn: (request) => {
      scripted.push(request);
      return { success: true };
    }
  };
  observer = new MentorPhysicalObserverService({
    store,
    chessService: { getState: () => ({ orientation: 'white' }) },
    analysisService: {},
    emit: (conversationId, event, payload) => emitted.push({ conversationId, event, payload })
  });
  const activityService = new MentorActivityService({
    store,
    chessService: {},
    analysisService: {},
    emit: (conversationId, event, payload) => emitted.push({ conversationId, event, payload })
  });
  observer.setDependencies({
    textService: { hasActiveConversation: () => false },
    liveService: {
      isConversationActive: () => false,
      requestContextReconnect: () => true,
      requestPhysicalTurn: () => null,
      stopConversation: async (conversationId, reason) => stopped.push({ conversationId, reason })
    },
    activityService
  });
  observer.setAdapter(adapter);
  return {
    store,
    observer,
    activityService,
    emitted,
    stopped,
    scripted,
    gameStarts,
    gameEnds: () => gameEnds,
    snapshot: () => snapshot,
    setSnapshot: (next) => {
      snapshot = next;
      observer.handleSnapshot(snapshot, 'physical-status');
    },
    setDefaultHumanColor: (color) => { defaultHumanColor = color; }
  };
}

async function verifyOwnershipHandoff(dbPath) {
  const harness = createHarness(dbPath);
  const { store, observer, activityService } = harness;
  const owner = store.createConversation({ title: 'Current guided game' });
  const requester = store.createConversation({ title: 'New lesson' });
  observer.attach(owner.id, {
    serverInstanceId: 'handoff-server',
    sessionGeneration: 4,
    coachingMode: 'off'
  });
  const ownerActivity = activityService.startPhysicalPractice(owner.id, {
    learnerColor: 'white',
    opponentMode: 'stockfish',
    expectedRevision: 10
  });

  const conflict = observer.ensureVoiceActivityBoard(requester.id, {
    requestId: 'request-opening',
    learnerColor: 'black',
    activityRequest: {
      type: 'opening_drill',
      learnerColor: 'black',
      sourceId: 'italian-game'
    }
  });
  assert.strictEqual(conflict.handoffRequired, true);
  assert.strictEqual(conflict.owner.activityId, ownerActivity.id);
  assert.strictEqual(store.getActivePhysicalBinding().conversationId, owner.id);
  assert.strictEqual(store.getActiveActivity(owner.id).id, ownerActivity.id);

  const reopened = new MentorStore({ dbPath });
  const persisted = reopened.getPendingPhysicalHandoff(requester.id);
  assert.strictEqual(persisted.id, conflict.handoff.id, 'pending handoff survives restart');
  reopened.close();

  const toolService = new MentorToolService({
    store,
    chessService: { getState: () => ({ fen: STANDARD_FEN, revision: 0, legalMoves: [] }) },
    activityService,
    physicalObserver: observer
  });
  const continued = await toolService.runTool('resolve_physical_board_handoff', { action: 'continue_existing' }, {
    conversationId: requester.id,
    requestId: 'continue-choice',
    channel: 'live-physical',
    onProgress: () => {}
  });
  assert.strictEqual(continued.navigateToConversationId, owner.id);
  assert.strictEqual(store.getActivePhysicalBinding().conversationId, owner.id);
  const continuedDuplicate = await observer.resolvePhysicalBoardHandoff(requester.id, {
    handoffId: conflict.handoff.id,
    action: 'continue_existing',
    requestId: 'continue-choice-duplicate'
  });
  assert.strictEqual(continuedDuplicate.duplicate, true);

  const secondConflict = observer.ensureVoiceActivityBoard(requester.id, {
    requestId: 'request-opening-again',
    learnerColor: 'black',
    activityRequest: {
      type: 'opening_drill',
      learnerColor: 'black',
      proposal: {
        type: 'opening_drill',
        title: 'Italian Game Practice',
        initialFen: STANDARD_FEN,
        line: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5']
      }
    }
  });
  assert.strictEqual(secondConflict.handoffRequired, true);
  harness.setDefaultHumanColor('black');
  const transferred = await observer.resolvePhysicalBoardHandoff(requester.id, {
    handoffId: secondConflict.handoff.id,
    action: 'end_and_start',
    requestId: 'confirm-transfer'
  });
  assert.strictEqual(transferred.activity.sourceId, 'italian-game');
  assert.strictEqual(transferred.activity.learnerColor, 'black');
  assert.strictEqual(store.getActivePhysicalBinding().conversationId, requester.id);
  assert.strictEqual(store.getActiveActivity(owner.id), null);
  assert.strictEqual(harness.scripted.length, 1);
  assert.strictEqual(harness.scripted[0].uci, 'e2e4', 'Human Black opening begins with reviewed White move');
  assert(harness.stopped.some((entry) => entry.conversationId === owner.id));
  assert.strictEqual(harness.gameStarts.at(-1)?.allowActiveReplacement, true,
    'confirmed handoff must replace the prior active physical session');

  const duplicate = await observer.resolvePhysicalBoardHandoff(requester.id, {
    handoffId: secondConflict.handoff.id,
    action: 'end_and_start',
    requestId: 'confirm-transfer-duplicate'
  });
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(harness.scripted.length, 1, 'duplicate transfer cannot queue the opener twice');
  store.close();
}

function verifyManualActivityEndReleasesBoard(dbPath) {
  const harness = createHarness(dbPath);
  const { store, observer, activityService } = harness;
  const conversation = store.createConversation({ title: 'End this game' });
  observer.attach(conversation.id, {
    serverInstanceId: 'handoff-server',
    sessionGeneration: 4,
    coachingMode: 'off'
  });
  activityService.startPhysicalPractice(conversation.id, {
    learnerColor: 'white',
    opponentMode: 'stockfish',
    expectedRevision: 10
  });

  const ended = activityService.end(conversation.id);
  assert.strictEqual(ended.status, 'cancelled');
  assert.strictEqual(harness.gameEnds(), 1, 'End game must terminate the underlying physical session');
  assert.strictEqual(harness.snapshot().active, false);
  assert.strictEqual(store.getActivePhysicalBinding(), null, 'ended board must be available to another conversation');
  store.close();
}

async function verifyBusyAndStaleHandoffs(dbPath) {
  const harness = createHarness(dbPath);
  const { store, observer, activityService } = harness;
  const owner = store.createConversation();
  const requester = store.createConversation();
  observer.attach(owner.id, { serverInstanceId: 'handoff-server', sessionGeneration: 4, coachingMode: 'off' });
  activityService.startPhysicalPractice(owner.id, {
    learnerColor: 'white', opponentMode: 'mentor', expectedRevision: 10
  });
  const conflict = observer.ensureVoiceActivityBoard(requester.id, {
    requestId: 'busy-request', learnerColor: 'white',
    activityRequest: { type: 'practice_game', opponentMode: 'mentor', learnerColor: 'white' }
  });
  harness.setSnapshot(makeSnapshot({ robotBusy: true }));
  await assert.rejects(
    observer.resolvePhysicalBoardHandoff(requester.id, {
      handoffId: conflict.handoff.id, action: 'end_and_start'
    }),
    (error) => error.code === 'physical_handoff_busy'
  );
  assert.strictEqual(store.getActivePhysicalBinding().conversationId, owner.id);
  harness.setSnapshot(makeSnapshot({ stateRevision: 11 }));
  await assert.rejects(
    observer.resolvePhysicalBoardHandoff(requester.id, {
      handoffId: conflict.handoff.id, action: 'end_and_start'
    }),
    (error) => error.code === 'physical_handoff_stale'
  );
  assert.strictEqual(store.getPhysicalHandoff(conflict.handoff.id).status, 'failed');
  store.close();
}

async function verifyDifficultyAndPhysicalDeclarations(dbPath) {
  const harness = createHarness(dbPath);
  const { store, observer, activityService } = harness;
  const conversation = store.createConversation();
  observer.attach(conversation.id, { serverInstanceId: 'handoff-server', sessionGeneration: 4, coachingMode: 'off' });
  activityService.startPhysicalPractice(conversation.id, {
    learnerColor: 'white', opponentMode: 'stockfish', expectedRevision: 10
  });
  let activeDifficulty = 2;
  const settings = new GameSettingsService({ store });
  settings.setPhysicalAdapter({
    getState: () => ({ active: true, sessionGeneration: 4, configuredLevel: activeDifficulty }),
    isConversationAttached: (id) => id === conversation.id,
    updateDifficulty: ({ difficultyLevel, expectedSessionGeneration }) => {
      assert.strictEqual(expectedSessionGeneration, 4);
      activeDifficulty = difficultyLevel;
    }
  });
  const toolService = new MentorToolService({
    store,
    chessService: { getState: () => ({ fen: STANDARD_FEN, revision: 0, legalMoves: [] }) },
    activityService,
    physicalObserver: observer,
    gameSettingsService: settings
  });
  const declaration = toolService.declarations(conversation.id, { voiceFirstPhysical: true })
    .find((tool) => tool.name === 'start_activity');
  assert.deepStrictEqual(declaration.parametersJsonSchema.properties.type.enum, [
    'practice_game', 'opening_drill'
  ]);
  assert.strictEqual(declaration.parametersJsonSchema.properties.proposal, undefined);
  assert(declaration.parametersJsonSchema.properties.sourceId.enum.includes('italian-game'));
  const handoffDeclaration = toolService.declarations(conversation.id, { voiceFirstPhysical: true })
    .find((tool) => tool.name === 'resolve_physical_board_handoff');
  assert.deepStrictEqual(Object.keys(handoffDeclaration.parametersJsonSchema.properties), ['action']);
  assert.strictEqual(handoffDeclaration.parametersJsonSchema.required.includes('handoffId'), false);

  const pair = store.createMessagePair(conversation.id, {
    requestId: 'difficulty-live', text: 'Change difficulty to level 8.'
  });
  const result = await toolService.execute({
    conversationId: conversation.id,
    requestId: 'difficulty-live',
    assistantMessageId: pair.assistantMessage.id,
    ordinal: 1,
    call: { id: 'difficulty-tool', name: 'set_game_preferences', args: { difficultyLevel: 8 } },
    channel: 'live-physical'
  });
  assert.strictEqual(result.response.output.applicability.difficultyLevel, 'next_robot_turn');
  assert.strictEqual(result.response.output.difficultyAppliedToActiveGame, true);
  assert.strictEqual(activeDifficulty, 8);
  store.close();
}

async function verifyRetainedOpeningIntent(dbPath) {
  const harness = createHarness(dbPath);
  const { store, observer, activityService } = harness;
  const conversation = store.createConversation();
  activityService.capturePhysicalActivityIntent(
    conversation.id,
    'Teach me the Italian Game.',
    'opening-name'
  );
  let intent = store.getPhysicalActivityIntent(conversation.id);
  assert.strictEqual(intent.sourceId, 'italian-game');
  assert.strictEqual(intent.learnerColor, null);
  const reopened = new MentorStore({ dbPath });
  assert.strictEqual(reopened.getPhysicalActivityIntent(conversation.id).sourceId, 'italian-game');
  reopened.close();

  activityService.capturePhysicalActivityIntent(
    conversation.id,
    "I'll play Black.",
    'opening-color'
  );
  intent = store.getPhysicalActivityIntent(conversation.id);
  assert.strictEqual(intent.sourceId, 'italian-game');
  assert.strictEqual(intent.learnerColor, 'black');

  harness.setDefaultHumanColor('black');
  const settings = new GameSettingsService({ store });
  const toolService = new MentorToolService({
    store,
    chessService: { getState: () => ({ fen: STANDARD_FEN, revision: 0, legalMoves: [] }) },
    activityService,
    physicalObserver: observer,
    gameSettingsService: settings
  });
  const pair = store.createMessagePair(conversation.id, {
    requestId: 'opening-color', text: "I'll play Black."
  });
  const result = await toolService.runTool('start_activity', { type: 'opening_drill' }, {
    conversationId: conversation.id,
    requestId: 'opening-color',
    channel: 'live-physical',
    onProgress: () => {}
  });
  assert.strictEqual(result.activity.sourceId, 'italian-game');
  assert.strictEqual(result.activity.learnerColor, 'black');
  assert.strictEqual(harness.scripted[0].uci, 'e2e4');
  assert.strictEqual(store.getPhysicalActivityIntent(conversation.id), null);
  assert.strictEqual(store.getPhysicalActivityIntent(conversation.id, { includeResolved: true }).status, 'started');
  activityService.capturePhysicalActivityIntent(conversation.id, "I'll play Black.", 'opening-color');
  assert.strictEqual(store.getPhysicalActivityIntent(conversation.id), null, 'final transcript cannot reopen a started intent');
  store.close();
}

async function verifyPhysicalPuzzleDisabled(dbPath) {
  const harness = createHarness(dbPath);
  const { store, observer, activityService } = harness;
  const conversation = store.createConversation();
  const toolService = new MentorToolService({
    store,
    chessService: { getState: () => ({ fen: STANDARD_FEN, revision: 0, legalMoves: [] }) },
    activityService,
    physicalObserver: observer
  });
  await assert.rejects(
    toolService.runTool('start_activity', { type: 'puzzle' }, {
      conversationId: conversation.id,
      requestId: 'physical-puzzle',
      channel: 'live-physical',
      onProgress: () => {}
    }),
    (error) => error.code === 'physical_puzzles_disabled'
  );
  assert.strictEqual(store.getActiveActivity(conversation.id), null);
  assert.strictEqual(store.getActivePhysicalBinding(), null);
  assert.strictEqual(harness.snapshot().sessionGeneration, 4, 'puzzle rejection does not start a physical session');
  store.close();
}

function verifyLegacyPhysicalPuzzlePaused(dbPath) {
  const harness = createHarness(dbPath);
  const { store, observer, activityService } = harness;
  const conversation = store.createConversation();
  observer.attach(conversation.id, {
    serverInstanceId: 'handoff-server',
    sessionGeneration: 4,
    coachingMode: 'off'
  });
  store.createActivity({
    conversationId: conversation.id,
    type: 'puzzle',
    title: 'Legacy physical puzzle',
    learnerColor: 'white',
    mentorColor: 'black',
    startFen: STANDARD_FEN,
    startRevision: 0,
    boardRevision: 0,
    phase: 'learner_turn',
    config: { boardSource: 'physical' },
    state: {}
  });
  const reconciled = activityService.reconcile(conversation.id);
  assert.strictEqual(reconciled.status, 'paused');
  assert.strictEqual(reconciled.state.pauseReason, 'physical_puzzles_disabled');
  assert.throws(
    () => activityService.resume(conversation.id),
    (error) => error.code === 'physical_puzzles_disabled'
  );
  const ended = activityService.end(conversation.id);
  assert.strictEqual(ended.status, 'cancelled');
  store.close();
}

function verifyHandoffExpiry(dbPath) {
  let now = 1000;
  const store = new MentorStore({ dbPath, now: () => now });
  const owner = store.createConversation();
  const requester = store.createConversation();
  const handoff = store.createPhysicalHandoff({
    requestingConversationId: requester.id,
    owningConversationId: owner.id,
    serverInstanceId: 'handoff-server',
    sessionGeneration: 4,
    stateRevision: 10,
    requestedActivity: { type: 'puzzle', sourceId: 'fork-basic' },
    expiresInMs: 500
  });
  assert.strictEqual(handoff.status, 'pending');
  now = 1500;
  assert.strictEqual(store.getPhysicalHandoff(handoff.id).status, 'expired');
  assert.strictEqual(store.getPendingPhysicalHandoff(requester.id), null);
  store.close();
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-handoff-'));
  let failed = false;
  try {
    await verifyOwnershipHandoff(path.join(tempDir, 'ownership.sqlite'));
    await verifyBusyAndStaleHandoffs(path.join(tempDir, 'safety.sqlite'));
    await verifyDifficultyAndPhysicalDeclarations(path.join(tempDir, 'difficulty.sqlite'));
    await verifyRetainedOpeningIntent(path.join(tempDir, 'opening-intent.sqlite'));
    await verifyPhysicalPuzzleDisabled(path.join(tempDir, 'puzzle-disabled.sqlite'));
    verifyManualActivityEndReleasesBoard(path.join(tempDir, 'manual-end.sqlite'));
    verifyLegacyPhysicalPuzzlePaused(path.join(tempDir, 'legacy-puzzle.sqlite'));
    verifyHandoffExpiry(path.join(tempDir, 'expiry.sqlite'));
    console.log('Mentor physical handoff regressions passed.');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (!failed) fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
