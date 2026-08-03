const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Chess } = require('chess.js');
const { MentorStore } = require('../mentor/store');
const { MentorChessService } = require('../mentor/chess-service');
const { MentorAnalysisService } = require('../mentor/analysis-service');
const { MentorPhysicalObserverService } = require('../mentor/physical-observer-service');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function snapshot(overrides = {}) {
  const fen = overrides.fen || START_FEN;
  const game = new Chess(fen);
  return {
    serverInstanceId: 'intent-server',
    sessionGeneration: 0,
    stateRevision: 0,
    active: false,
    phase: 'idle',
    setupMode: 'full',
    statusText: 'Physical board idle.',
    fen,
    pgn: game.pgn(),
    gameStatus: {
      inCheck: game.isCheck(),
      checkmate: game.isCheckmate(),
      draw: game.isDraw(),
      resultText: null
    },
    physicalMoveLog: [],
    board: { ready: true, missingSquares: [], extraSquares: [] },
    calibration: { ready: true, missingSquares: [], extraSquares: [] },
    robotBusy: false,
    pendingRobotJob: null,
    pendingUndo: null,
    pendingRedo: null,
    robotGraveyardOccupied: [],
    lastSnapshotAt: Date.now(),
    lastMove: null,
    ...overrides
  };
}

function engineResult(fen) {
  const game = new Chess(fen);
  const move = game.moves({ verbose: true })[0];
  return {
    score: { type: 'cp', value: 0, perspective: 'white' },
    wdl: { white: 300, draw: 400, black: 300 },
    bestMove: move ? { uci: `${move.from}${move.to}${move.promotion || ''}`, san: move.san } : null,
    lines: [],
    telemetry: { elapsedMs: 1, depth: 1, nodes: 1 }
  };
}

function moveRecord(move, side, beforeFen, afterFen, index) {
  return {
    id: `move-${index}`,
    side,
    color: side === 'human' ? 'w' : 'b',
    uci: `${move.from}${move.to}${move.promotion || ''}`,
    san: move.san,
    from: move.from,
    to: move.to,
    piece: move.piece,
    promotion: move.promotion || null,
    beforeFen,
    afterFen,
    createdAt: index,
    verified: true
  };
}

async function wait(milliseconds = 35) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-intent-coaching-'));
  const dbPath = path.join(tempDir, 'mentor.sqlite');
  const store = new MentorStore({ dbPath });
  const chessService = new MentorChessService({ store });
  const analysisService = new MentorAnalysisService({
    chessService,
    engineService: { analyzeFen: async (fen) => engineResult(fen) }
  });
  const emitted = [];
  let current = snapshot();
  let starts = 0;
  const observer = new MentorPhysicalObserverService({
    store,
    chessService,
    analysisService,
    coachingDelayMs: 10,
    emit: (conversationId, event, payload) => emitted.push({ conversationId, event, payload })
  });
  observer.setDependencies({
    textService: { hasActiveConversation: () => true },
    liveService: {
      isConversationActive: () => false,
      requestContextReconnect: () => null,
      notifyPhysicalBoardUpdated: () => true,
      requestPhysicalTurn: () => null
    },
    activityService: { get: () => null, setPhysicalCoordinator: () => {} }
  });
  observer.setAdapter({
    getSnapshot: () => current,
    getGameStatus: () => ({ ...current, sensorFresh: true, sensorAgeMs: 5 }),
    startDefaultGame: () => {
      starts += 1;
      current = snapshot({ active: true, phase: 'setup', sessionGeneration: 1, statusText: 'Calibrating.' });
      observer.handleSnapshot(current, 'physical-status');
      return { success: true, state: current };
    }
  });

  const conversation = store.createConversation();
  store.createMessagePair(conversation.id, {
    requestId: 'ambiguous-game',
    text: "Let's play a game"
  });
  assert.throws(
    () => observer.startPhysicalGame(conversation.id, { requestId: 'ambiguous-game' }),
    (error) => error.code === 'physical_game_choice_required'
  );
  assert.strictEqual(starts, 0);

  store.createMessagePair(conversation.id, {
    requestId: 'physical-game',
    text: 'Start a physical game'
  });
  const started = observer.startPhysicalGame(conversation.id, { requestId: 'physical-game' });
  assert.strictEqual(started.started, true);
  assert.strictEqual(starts, 1);
  assert.strictEqual(store.getPhysicalBinding(conversation.id).coachingMode, 'selective');
  assert.strictEqual(observer.startPhysicalGame(conversation.id, { requestId: 'physical-game' }).duplicate, true);
  assert.strictEqual(starts, 1, 'duplicate request must not start a second physical session');

  current = snapshot({
    active: true,
    phase: 'piece_lifted',
    sessionGeneration: 1,
    stateRevision: 1,
    board: { ready: false, missingSquares: ['e2'], extraSquares: [] },
    selectedSource: 'e2'
  });
  const messageCountBeforeLift = store.listMessages(conversation.id).length;
  observer.handleSnapshot(current, 'physical-board');
  await wait();
  assert.strictEqual(store.listMessages(conversation.id).length, messageCountBeforeLift, 'ordinary lifts must remain silent');

  const game = new Chess(START_FEN);
  const records = [];
  const sequence = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6'];
  for (let index = 0; index < sequence.length; index += 1) {
    const beforeFen = game.fen();
    const uci = sequence[index];
    const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    records.push(moveRecord(move, index % 2 === 0 ? 'human' : 'engine', beforeFen, game.fen(), index + 1));
    if (index % 2 === 1) {
      current = snapshot({
        active: true,
        phase: 'ready',
        sessionGeneration: 1,
        stateRevision: index + 2,
        fen: game.fen(),
        pgn: game.pgn(),
        physicalMoveLog: [...records],
        side: 'engine',
        move: records.at(-1).uci,
        san: records.at(-1).san,
        verified: true,
        lastMove: { ...records.at(-1), at: index + 10 }
      });
      observer.handleSnapshot(current, 'physical-move');
      await wait(60);
    }
  }

  const coachingMessages = store.listMessages(conversation.id)
    .filter((message) => message.requestId?.startsWith('physical-coaching:'));
  assert.strictEqual(coachingMessages.length, 2, 'three complete turns should create one coaching pair');
  assert.match(coachingMessages[1].content, /Strategic checkpoint/i);
  const binding = store.getPhysicalBinding(conversation.id);
  assert.strictEqual(binding.lastCoachingTrigger, 'strategic_summary');
  assert.strictEqual(binding.fullTurnsSinceSummary, 0);
  assert(emitted.some((entry) => entry.event === 'mentor-physical-coaching-updated'));

  observer.setCoaching(conversation.id, 'off');
  assert.strictEqual(store.getPhysicalBinding(conversation.id).coachingMode, 'off');
  store.close();
  const reopened = new MentorStore({ dbPath });
  assert.strictEqual(reopened.getPhysicalBinding(conversation.id).coachingMode, 'off');
  assert.strictEqual(reopened.getPhysicalAction(conversation.id, 'physical-game').status, 'complete');
  reopened.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('Mentor physical intent and selective coaching regressions passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
