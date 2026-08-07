const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Chess } = require('chess.js');
const { MentorStore, STANDARD_FEN } = require('../mentor/store');
const { MentorActivityService } = require('../mentor/activity-service');
const { MentorToolService } = require('../mentor/tool-service');
const { getCatalogItem, listCatalog } = require('../mentor/curriculum');

function physicalState(game, revision, humanColor = 'white') {
  return {
    fen: game.fen(),
    revision,
    turn: game.turn(),
    legalMoves: game.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion || ''}`).sort(),
    history: [],
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
    assertExplicitStartConsent: () => true,
    validateTool: () => true,
    startActivity: async (_conversationId, options) => {
      starts.push(options);
      return { id: 'physical-opening', config: { boardSource: 'physical' } };
    }
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
    assert(voiceTools.includes('start_physical_game'));
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
    assert.deepStrictEqual(ensured, [{ requestId: 'voice-opening-black', learnerColor: 'black' }]);
    assert.strictEqual(defaults.humanColor, 'black');
    assert.strictEqual(starts.length, 1);
    assert.strictEqual(starts[0].learnerColor, 'black');
    assert.strictEqual(starts[0].expectedRevision, 7);
    assert.strictEqual(starts[0].sourceId, 'italian-game');
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

(async () => {
  await verifyGuidedPhysicalFallback();
  await verifyStockfishPolicyAndColorChecks();
  verifyBothColorOpeningsAndPhysicalPuzzle();
  await verifyVoiceFirstPhysicalOrchestration();
  console.log('Mentor physical curriculum guided-game regressions passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
