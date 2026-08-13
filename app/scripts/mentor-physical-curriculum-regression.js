const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Chess } = require('chess.js');
const { MentorStore, STANDARD_FEN } = require('../mentor/store');
const { MentorActivityService } = require('../mentor/activity-service');
const { MentorToolService } = require('../mentor/tool-service');
const { getCatalogItem, listCatalog } = require('../mentor/curriculum');

function physicalState(game, revision, humanColor = 'white', history = []) {
  return {
    sourceKey: 'physical:server-test:9',
    fen: game.fen(),
    revision,
    turn: game.turn(),
    legalMoves: game.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion || ''}`).sort(),
    history,
    gameStatus: {
      isGameOver: game.isGameOver(),
      checkmate: game.isCheckmate(),
      draw: game.isDraw()
    },
    physical: {
      humanColor,
      robotColor: humanColor === 'white' ? 'black' : 'white',
      serverInstanceId: 'server-test',
      sessionGeneration: 9,
      phase: 'ready',
      board: { ready: true },
      robotBusy: false,
      pendingRobotJob: null,
      pendingUndo: null,
      pendingRedo: null,
      pendingPromotion: null
    }
  };
}

function verifyNaturalVoiceActivityConsent() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-voice-consent-'));
  const store = new MentorStore({ dbPath: path.join(tempDir, 'mentor.sqlite') });
  const service = new MentorActivityService({ store, chessService: {}, analysisService: {}, emit: () => {} });
  try {
    for (const [index, text] of [
      'Uh yes, a Mentor game and I want to play as White against you.',
      'The physical board and yes, let us do it.',
      'I want to play a physical game against you as White.'
    ].entries()) {
      const conversation = store.createConversation();
      const requestId = `natural-consent-${index}`;
      store.createMessagePair(conversation.id, { requestId, text });
      assert.strictEqual(service.assertExplicitStartConsent(conversation.id, requestId), true);
    }
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyPhysicalMoveRequiresActiveMentorTurn() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-physical-move-guard-'));
  const store = new MentorStore({ dbPath: path.join(tempDir, 'mentor.sqlite') });
  const service = new MentorActivityService({ store, chessService: {}, analysisService: {}, emit: () => {} });
  const conversation = store.createConversation();
  try {
    await assert.rejects(
      service.playPhysicalMove(conversation.id, 'post-opening-request', 'a2a4'),
      (error) => error.code === 'physical_mentor_move_unavailable'
        && !/reading ['\"]type['\"]/.test(error.message)
    );
    assert.throws(
      () => service.validateTool(conversation.id, 'post-opening-request', 'play_physical_move', { uci: 'a2a4' }),
      (error) => error.code === 'physical_mentor_move_unavailable'
    );
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyPhysicalAnalysisSurvivesStatusRevisionChurn() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-physical-analysis-revision-'));
  const store = new MentorStore({ dbPath: path.join(tempDir, 'mentor.sqlite') });
  const game = new Chess(STANDARD_FEN);
  let revision = 1;
  let history = [];
  const queued = [];
  let service;
  const coordinator = {
    isAttached: () => true,
    requirePracticeStartState: () => physicalState(game, revision),
    requireCurrentPhysicalState: () => physicalState(game, revision, 'white', history),
    syncPhysicalActivity: () => {},
    announcePhysicalPractice: () => null,
    playPhysicalMove: async (_conversationId, options) => {
      queued.push(options);
      return { success: true, verified: true };
    }
  };
  service = new MentorActivityService({ store, chessService: {}, analysisService: {}, emit: () => {} });
  service.setPhysicalCoordinator(coordinator);
  const conversation = store.createConversation();

  try {
    let activity = service.startPhysicalPractice(conversation.id, {
      learnerColor: 'white', opponentMode: 'mentor', expectedRevision: revision
    });
    game.move('e4');
    history = [{ side: 'human', uci: 'e2e4', move: 'e2e4', san: 'e4' }];
    revision = 2;
    const requestId = `physical-activity:${activity.id}:2:2:0`;
    activity = store.updateActivity(activity.id, {
      phase: 'mentor_thinking',
      boardRevision: revision,
      pendingRequestId: requestId,
      generation: activity.generation + 1
    });
    const pair = store.createMessagePair(conversation.id, {
      requestId,
      text: 'Mentor is choosing a physical reply.',
      kind: 'activity'
    });
    const analysis = store.createToolCall({
      conversationId: conversation.id,
      requestId,
      assistantMessageId: pair.assistantMessage.id,
      providerCallId: 'analysis-before-status-churn',
      ordinal: 1,
      name: 'analyze_position'
    }).toolCall;
    store.updateToolCall(analysis.id, {
      status: 'complete',
      result: {
        sourceKey: 'physical:server-test:9',
        analyzedFen: game.fen(),
        analyzedRevision: revision,
        lines: [
          { move: 'g8f6', score: { type: 'cp', value: 25, perspective: 'white' } },
          { move: 'e7e6', score: { type: 'cp', value: 26, perspective: 'white' } }
        ]
      }
    });

    await assert.rejects(
      service.playPhysicalMove(conversation.id, requestId, 'g8f6', {
        strategicPlan: 'Develop and contest the center.'
      }),
      (error) => error.code === 'practice_learner_move_analysis_required'
    );

    const moveAnalysis = store.createToolCall({
      conversationId: conversation.id,
      requestId,
      assistantMessageId: pair.assistantMessage.id,
      providerCallId: 'learner-move-analysis',
      ordinal: 2,
      name: 'analyze_move'
    }).toolCall;
    store.updateToolCall(moveAnalysis.id, {
      status: 'complete',
      result: {
        sourceKey: 'physical:server-test:9',
        analyzedFen: game.fen(),
        analyzedRevision: revision,
        move: { uci: 'e2e4', san: 'e4', color: 'w' },
        classification: 'good',
        centipawnLoss: 20
      }
    });

    revision = 5;
    await service.playPhysicalMove(conversation.id, requestId, 'g8f6', {
      strategicPlan: 'Develop and contest the center.'
    });
    assert.strictEqual(queued.length, 1);
    assert.strictEqual(queued[0].expectedRevision, 5, 'execution uses the latest physical status revision');
    assert.strictEqual(store.getActiveActivity(conversation.id).boardRevision, 5);
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyMoveDuringNarrationQueuesNextTurn() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-physical-narration-queue-'));
  const store = new MentorStore({ dbPath: path.join(tempDir, 'mentor.sqlite') });
  const game = new Chess(STANDARD_FEN);
  const service = new MentorActivityService({ store, chessService: {}, analysisService: {}, emit: () => {} });
  service.setPhysicalCoordinator({
    isAttached: () => true,
    requirePracticeStartState: () => physicalState(game, 1),
    syncPhysicalActivity: () => {},
    announcePhysicalPractice: () => null
  });
  const conversation = store.createConversation();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  service.executePhysicalMentorTurn = async (_conversationId, reason) => {
    calls.push(reason);
    if (calls.length === 1) await firstGate;
  };

  try {
    const activity = service.startPhysicalPractice(conversation.id, {
      learnerColor: 'white', opponentMode: 'mentor', expectedRevision: 1
    });
    store.updateActivity(activity.id, { phase: 'mentor_turn' });
    const first = service.schedulePhysicalMentorTurn(conversation.id, 'current_narration');
    service.schedulePhysicalMentorTurn(conversation.id, 'learner_moved_during_narration');
    assert.strictEqual(calls.length, 1);
    releaseFirst();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(calls, ['current_narration', 'learner_moved_during_narration']);
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyStrandedMentorTurnRecoversWhenLiveReturns() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-physical-turn-recovery-'));
  const store = new MentorStore({ dbPath: path.join(tempDir, 'mentor.sqlite') });
  const game = new Chess(STANDARD_FEN);
  game.move('e4');
  let service;
  let runnerCalls = 0;
  const coordinator = {
    isAttached: () => true,
    requirePracticeStartState: () => physicalState(new Chess(STANDARD_FEN), 1),
    requireCurrentPhysicalState: () => physicalState(game, 4),
    syncPhysicalActivity: () => {},
    announcePhysicalPractice: () => null
  };
  service = new MentorActivityService({ store, chessService: {}, analysisService: {}, emit: () => {} });
  service.setPhysicalCoordinator(coordinator);
  service.setRunners({
    isLiveActive: () => true,
    live: () => {
      runnerCalls += 1;
      return { completion: Promise.resolve({ status: 'cancelled' }) };
    }
  });
  const conversation = store.createConversation();

  try {
    let activity = service.startPhysicalPractice(conversation.id, {
      learnerColor: 'white', opponentMode: 'mentor', expectedRevision: 1
    });
    activity = store.updateActivity(activity.id, {
      phase: 'mentor_thinking',
      boardRevision: 2,
      pendingRequestId: 'orphaned-provider-turn'
    });
    service.resumeStrandedPhysicalMentorTurn(conversation.id);
    await service.physicalInFlight.get(conversation.id);
    const recovered = service.get(conversation.id);
    assert.strictEqual(runnerCalls, 1);
    assert.strictEqual(recovered.status, 'paused');
    assert(recovered.events.some((event) => event.type === 'physical_mentor_turn_recovered'));
    assert(recovered.events.some((event) => event.type === 'paused'
      && event.payload.reason === 'response_stopped'));
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyGuidedPhysicalFallback() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-physical-curriculum-'));
  const store = new MentorStore({ dbPath: path.join(tempDir, 'mentor.sqlite') });
  const game = new Chess(STANDARD_FEN);
  let revision = 1;
  let service;
  let runnerCalls = 0;
  const played = [];
  const policies = [];
  const coordinator = {
    isAttached: () => true,
    requirePracticeStartState: (_conversationId, expectedRevision) => {
      assert.strictEqual(expectedRevision, revision);
      return physicalState(game, revision);
    },
    requireCurrentPhysicalState: () => physicalState(game, revision),
    syncPhysicalActivity: (activity) => policies.push(service.getPhysicalPolicy(activity.conversationId)),
    announcePhysicalPractice: () => null,
    analyzePosition: async () => ({ bestMove: { uci: 'e7e5' } }),
    playPhysicalMove: async (_conversationId, options) => {
      played.push(options);
      const move = game.move({ from: options.uci.slice(0, 2), to: options.uci.slice(2, 4), promotion: options.uci[4] });
      assert(move);
      revision += 1;
      service.physicalMoveCommitted(conversation.id, {
        side: 'engine',
        uci: options.uci,
        san: move.san,
        revision,
        moveId: `robot-${revision}`,
        gameStatus: physicalState(game, revision).gameStatus
      });
      return { success: true, verified: true, move: options.uci };
    }
  };
  service = new MentorActivityService({
    store,
    chessService: {},
    analysisService: {},
    emit: () => {},
    emitGlobal: () => {}
  });
  service.setPhysicalCoordinator(coordinator);
  service.setRunners({
    isLiveActive: () => false,
    text: () => {
      runnerCalls += 1;
      return { completion: Promise.resolve({ status: 'complete' }) };
    }
  });
  const conversation = store.createConversation();

  try {
    let activity = service.startPhysicalPractice(conversation.id, {
      learnerColor: 'white',
      opponentMode: 'mentor',
      expectedRevision: revision,
      requestId: 'start-guided'
    });
    assert.strictEqual(activity.phase, 'learner_turn');
    assert.strictEqual(activity.config.opponentMode, 'mentor');
    assert.strictEqual(service.getPhysicalPolicy(conversation.id).expectedActor, 'learner');

    const learner = game.move('e4');
    revision += 1;
    service.physicalMoveCommitted(conversation.id, {
      side: 'human',
      uci: 'e2e4',
      san: learner.san,
      revision,
      moveId: 'human-2',
      gameStatus: physicalState(game, revision).gameStatus
    });
    await service.physicalInFlight.get(conversation.id);

    activity = service.get(conversation.id);
    assert.strictEqual(runnerCalls, 2, 'Gemini receives one normal and one corrective turn');
    assert.strictEqual(played.length, 1, 'fallback executes exactly one physical move');
    assert.strictEqual(played[0].uci, 'e7e5');
    assert.strictEqual(played[0].fallback, true);
    assert.strictEqual(activity.phase, 'learner_turn');
    assert.strictEqual(activity.state.fallbackMoves, 1);
    assert.strictEqual(game.fen(), new Chess().move('e4') && (() => { const expected = new Chess(); expected.move('e4'); expected.move('e5'); return expected.fen(); })());
    assert(policies.some((policy) => policy.opponentMode === 'mentor' && policy.expectedActor === 'mentor'));
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyStockfishPolicyAndColorChecks() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-physical-stockfish-'));
  const store = new MentorStore({ dbPath: path.join(tempDir, 'mentor.sqlite') });
  const game = new Chess(STANDARD_FEN);
  let service;
  const started = [];
  const coordinator = {
    isAttached: () => true,
    requirePracticeStartState: () => physicalState(game, 4, 'black'),
    syncPhysicalActivity: () => {},
    announcePhysicalPractice: () => {},
    startStockfishTurn: (_conversationId, activity) => started.push(activity.id)
  };
  service = new MentorActivityService({ store, chessService: {}, analysisService: {}, emit: () => {} });
  service.setPhysicalCoordinator(coordinator);
  const conversation = store.createConversation();
  try {
    const activity = service.startPhysicalPractice(conversation.id, {
      learnerColor: 'black', opponentMode: 'stockfish', expectedRevision: 4
    });
    assert.strictEqual(activity.phase, 'mentor_turn');
    assert.strictEqual(activity.mentorColor, 'white');
    assert.deepStrictEqual(started, [activity.id]);
    assert.throws(() => service.startPhysicalPractice(store.createConversation().id, {
      learnerColor: 'white', opponentMode: 'mentor', expectedRevision: 4
    }), (error) => error.code === 'physical_activity_color_mismatch');
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function verifyBothColorOpeningsAndPhysicalPuzzle() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-physical-catalog-'));
  const store = new MentorStore({ dbPath: path.join(tempDir, 'mentor.sqlite') });
  let service;
  const scriptedStarts = [];
  let currentColor = 'black';
  let currentRevision = 20;
  let currentFen = STANDARD_FEN;
  const coordinator = {
    isAttached: () => true,
    requireOpeningStartState: () => ({
      ...physicalState(new Chess(STANDARD_FEN), currentRevision, currentColor),
      history: []
    }),
    requireCurrentPhysicalState: () => physicalState(new Chess(currentFen), currentRevision, currentColor),
    syncPhysicalActivity: () => {},
    announcePhysicalOpening: () => {},
    announcePhysicalPuzzleSetup: () => {},
    startScriptedTurn: (_conversationId, activity) => scriptedStarts.push(activity.config.line[activity.stepIndex]),
    preparePhysicalPuzzle: (_conversationId, { fen, learnerColor }) => {
      currentFen = fen;
      currentColor = learnerColor;
      currentRevision += 1;
      return physicalState(new Chess(fen), currentRevision, learnerColor);
    },
    confirmPhysicalPuzzleSetup: () => physicalState(new Chess(currentFen), currentRevision, currentColor)
  };
  service = new MentorActivityService({ store, chessService: {}, analysisService: {}, emit: () => {}, emitGlobal: () => {} });
  service.setPhysicalCoordinator(coordinator);
  try {
    const openings = listCatalog('opening_drill');
    assert.strictEqual(openings.length, 18);
    const puzzles = listCatalog('puzzle');
    assert.strictEqual(puzzles.length, 12);
    assert.strictEqual(puzzles.filter((item) => item.difficultyBand === 'beginner').length, 4);
    assert.strictEqual(puzzles.filter((item) => item.difficultyBand === 'intermediate').length, 4);
    assert.strictEqual(puzzles.filter((item) => item.difficultyBand === 'advanced').length, 4);
    assert(puzzles.every((item) => item.supportsPhysical));
    for (const opening of openings) {
      const conversation = store.createConversation();
      const activity = service.startPhysicalOpening(conversation.id, {
        type: 'opening_drill',
        sourceId: opening.id,
        learnerColor: 'black',
        expectedRevision: currentRevision
      });
      assert.strictEqual(activity.phase, 'mentor_turn', `${opening.id} should begin with the robot for Human Black`);
      assert.strictEqual(service.getPhysicalPolicy(conversation.id).expectedActor, 'mentor');
      const item = getCatalogItem(opening.id);
      const lineGame = new Chess(item.initialFen);
      item.line.forEach((uci, index) => {
        const move = lineGame.move({
          from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]
        });
        service.physicalMoveCommitted(conversation.id, {
          side: index % 2 === 0 ? 'engine' : 'human',
          uci,
          san: move.san,
          revision: currentRevision + index + 1,
          moveId: `${opening.id}-${index}`,
          gameStatus: { checkmate: lineGame.isCheckmate(), draw: lineGame.isDraw() }
        });
      });
      assert.strictEqual(service.get(conversation.id).state.pauseReason, 'line_complete');
      service.end(conversation.id);
    }
    assert.strictEqual(scriptedStarts.length, 18);
    assert(scriptedStarts.every((uci) => typeof uci === 'string' && uci.length >= 4));

    currentColor = 'white';
    currentFen = STANDARD_FEN;
    const puzzleConversation = store.createConversation();
    let activity = service.startPhysicalPuzzle(puzzleConversation.id, {
      sourceId: 'back-rank-mate',
      expectedRevision: currentRevision,
      requestId: 'start-puzzle'
    });
    assert.strictEqual(activity.phase, 'paused');
    assert.strictEqual(activity.state.pauseReason, 'puzzle_setup');
    assert.strictEqual(activity.config.difficultyBand, 'beginner');
    assert.deepStrictEqual(activity.config.setupChecklist, [
      { square: 'e1', color: 'white', piece: 'rook' },
      { square: 'f7', color: 'black', piece: 'pawn' },
      { square: 'g1', color: 'white', piece: 'king' },
      { square: 'g2', color: 'white', piece: 'pawn' },
      { square: 'g7', color: 'black', piece: 'pawn' },
      { square: 'g8', color: 'black', piece: 'king' },
      { square: 'h2', color: 'white', piece: 'pawn' },
      { square: 'h7', color: 'black', piece: 'pawn' }
    ]);
    activity = service.confirmPhysicalSetup(puzzleConversation.id);
    assert.strictEqual(activity.phase, 'learner_turn');
    assert.throws(
      () => service.validatePhysicalLearnerMove(puzzleConversation.id, 'e1e2'),
      (error) => error.code === 'activity_incorrect_move'
    );
    const puzzle = getCatalogItem('back-rank-mate');
    const puzzleGame = new Chess(puzzle.initialFen);
    const solution = puzzleGame.move({ from: 'e1', to: 'e8' });
    service.physicalMoveCommitted(puzzleConversation.id, {
      side: 'human', uci: 'e1e8', san: solution.san, revision: currentRevision + 1,
      moveId: 'puzzle-solution', gameStatus: { checkmate: true, draw: false }
    });
    assert.strictEqual(service.get(puzzleConversation.id), null, 'completed puzzle no longer occupies the active slot');
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyVoiceFirstPhysicalOrchestration() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-voice-physical-'));
  const store = new MentorStore({ dbPath: path.join(tempDir, 'mentor.sqlite') });
  const conversation = store.createConversation();
  const pair = store.createMessagePair(conversation.id, {
    requestId: 'voice-opening-black',
    text: 'Teach me the Italian Game as Black.'
  });
  let attached = false;
  let defaults = { humanColor: 'white', difficultyLevel: 3 };
  const ensured = [];
  const starts = [];
  const physicalState = {
    source: 'physical',
    fen: STANDARD_FEN,
    pgn: '',
    turnName: 'White',
    revision: 7,
    orientation: 'black',
    gameStatus: { status: 'ongoing', resultText: 'Game in progress', isGameOver: false },
    history: [],
    legalMoves: [],
    annotations: { highlights: [], arrows: [] },
    physical: { humanColor: 'black', robotColor: 'white' }
  };
  const physicalObserver = {
    isAttached: () => attached,
    allowedTool: () => true,
    getState: () => physicalState,
    ensureVoiceActivityBoard: (_conversationId, options) => {
      ensured.push(options);
      attached = true;
    }
  };
  const activityService = {
    current: null,
    mergePhysicalActivityIntent: (_conversationId, options) => options,
    normalizePhysicalActivityRequest: (options) => options,
    completePhysicalActivityIntent: () => null,
    assertExplicitStartConsent: () => true,
    validateTool: () => true,
    startActivity: async (_conversationId, options) => {
      starts.push(options);
      activityService.current = {
        id: 'physical-opening',
        type: options.type,
        status: 'active',
        learnerColor: options.learnerColor,
        sourceId: options.sourceId,
        config: { boardSource: 'physical', opponentMode: options.opponentMode }
      };
      return activityService.current;
    },
    get: () => activityService.current
  };
  const gameSettingsService = {
    get: () => ({ defaults }),
    updateFromMentor: (_conversationId, patch) => {
      defaults = { ...defaults, ...patch };
      return { defaults };
    }
  };
  const service = new MentorToolService({
    store,
    chessService: { getState: () => { throw new Error('Virtual state must not be used.'); } },
    activityService,
    physicalObserver,
    gameSettingsService
  });

  try {
    const voiceTools = service.declarations(conversation.id, { voiceFirstPhysical: true })
      .map((tool) => tool.name);
    assert(voiceTools.includes('start_activity'));
    assert(!voiceTools.includes('start_physical_game'));
    assert(!voiceTools.includes('attach_physical_game'));
    assert(!voiceTools.includes('play_move'));
    assert(!voiceTools.includes('set_orientation'));

    const result = await service.execute({
      conversationId: conversation.id,
      requestId: 'voice-opening-black',
      assistantMessageId: pair.assistantMessage.id,
      ordinal: 1,
      call: {
        id: 'provider-opening-black',
        name: 'start_activity',
        args: { type: 'opening_drill', sourceId: 'italian-game', learnerColor: 'black' }
      },
      channel: 'live-physical'
    });
    assert(result.response.output);
    assert.deepStrictEqual(ensured, [{
      requestId: 'voice-opening-black',
      learnerColor: 'black',
      activityRequest: {
        type: 'opening_drill',
        opponentMode: 'mentor',
        learnerColor: 'black',
        sourceId: 'italian-game',
        proposal: null
      }
    }]);
    assert.strictEqual(defaults.humanColor, 'black');
    assert.strictEqual(starts.length, 1);
    assert.strictEqual(starts[0].learnerColor, 'black');
    assert.strictEqual(starts[0].expectedRevision, 7);
    assert.strictEqual(starts[0].sourceId, 'italian-game');

    const duplicatePair = store.createMessagePair(conversation.id, {
      requestId: 'voice-opening-black-duplicate',
      text: 'Start the Italian Game again.'
    });
    const duplicate = await service.execute({
      conversationId: conversation.id,
      requestId: 'voice-opening-black-duplicate',
      assistantMessageId: duplicatePair.assistantMessage.id,
      ordinal: 1,
      call: {
        id: 'provider-opening-black-duplicate',
        name: 'start_activity',
        args: { type: 'opening_drill', sourceId: 'italian-game', learnerColor: 'black' }
      },
      channel: 'live-physical'
    });
    assert.strictEqual(duplicate.response.output.alreadyActive, true);
    assert.strictEqual(starts.length, 1, 'matching duplicate activity start does not restart the game');

    const attachedVoiceTools = service.declarations(conversation.id, { voiceFirstPhysical: true })
      .map((tool) => tool.name);
    assert(attachedVoiceTools.includes('play_physical_move'));
    assert(!attachedVoiceTools.includes('start_physical_game'));
    assert(!attachedVoiceTools.includes('attach_physical_game'));

    const stalePair = store.createMessagePair(conversation.id, {
      requestId: 'voice-stale-start',
      text: 'Start another physical game directly.'
    });
    const staleLowLevelCall = await service.execute({
      conversationId: conversation.id,
      requestId: 'voice-stale-start',
      assistantMessageId: stalePair.assistantMessage.id,
      ordinal: 1,
      call: { id: 'provider-stale-start', name: 'start_physical_game', args: {} },
      channel: 'live-physical'
    });
    assert.strictEqual(staleLowLevelCall.response.error.code, 'voice_activity_start_required');
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

(async () => {
  verifyNaturalVoiceActivityConsent();
  await verifyPhysicalMoveRequiresActiveMentorTurn();
  await verifyGuidedPhysicalFallback();
  await verifyPhysicalAnalysisSurvivesStatusRevisionChurn();
  await verifyMoveDuringNarrationQueuesNextTurn();
  await verifyStrandedMentorTurnRecoversWhenLiveReturns();
  await verifyStockfishPolicyAndColorChecks();
  verifyBothColorOpeningsAndPhysicalPuzzle();
  await verifyVoiceFirstPhysicalOrchestration();
  console.log('Mentor physical curriculum guided-game regressions passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
