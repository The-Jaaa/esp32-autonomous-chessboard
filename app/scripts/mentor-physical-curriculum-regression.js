const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Chess } = require('chess.js');
const { MentorStore, STANDARD_FEN } = require('../mentor/store');
const { MentorActivityService } = require('../mentor/activity-service');

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

(async () => {
  await verifyGuidedPhysicalFallback();
  await verifyStockfishPolicyAndColorChecks();
  console.log('Mentor physical curriculum guided-game regressions passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
