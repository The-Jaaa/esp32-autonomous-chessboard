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
  let defaultHumanColor = 'white';
  let observer;
  const adapter = {
    getSnapshot: () => snapshot,
    getGameStatus: () => ({ sensorFresh: true, sensorAgeMs: 1 }),
    startDefaultGame: () => {
      snapshot = makeSnapshot({
        sessionGeneration: snapshot.sessionGeneration + 1,
        stateRevision: snapshot.stateRevision + 1,
        humanColor: defaultHumanColor,
        robotColor: defaultHumanColor === 'white' ? 'black' : 'white'
      });
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

  const continued = await observer.resolvePhysicalBoardHandoff(requester.id, {
    handoffId: conflict.handoff.id,
    action: 'continue_existing',
    requestId: 'continue-choice'
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

  const duplicate = await observer.resolvePhysicalBoardHandoff(requester.id, {
    handoffId: secondConflict.handoff.id,
    action: 'end_and_start',
    requestId: 'confirm-transfer-duplicate'
  });
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(harness.scripted.length, 1, 'duplicate transfer cannot queue the opener twice');
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
    chessService: {},
    activityService,
    physicalObserver: observer,
    gameSettingsService: settings
  });
  const declaration = toolService.declarations(conversation.id, { voiceFirstPhysical: true })
    .find((tool) => tool.name === 'start_activity');
  assert.deepStrictEqual(declaration.parametersJsonSchema.properties.type.enum, [
    'practice_game', 'opening_drill', 'puzzle'
  ]);
  assert.strictEqual(declaration.parametersJsonSchema.properties.proposal, undefined);
  assert(declaration.parametersJsonSchema.properties.sourceId.enum.includes('italian-game'));

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
