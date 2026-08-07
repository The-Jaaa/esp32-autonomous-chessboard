const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Chess } = require('chess.js');
const { MentorStore } = require('../mentor/store');
const { MentorChessService } = require('../mentor/chess-service');
const { MentorAnalysisService } = require('../mentor/analysis-service');
const { MentorToolService } = require('../mentor/tool-service');
const {
  MentorPhysicalObserverService,
  guidanceFor,
  normalizeSnapshot
} = require('../mentor/physical-observer-service');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function snapshot(overrides = {}) {
  const fen = overrides.fen || START_FEN;
  const game = new Chess(fen);
  return {
    protocolVersion: 1,
    serverInstanceId: 'server-a',
    sessionGeneration: 7,
    stateRevision: 1,
    active: true,
    humanColor: 'white',
    robotColor: 'black',
    phase: 'ready',
    statusText: 'Waiting for your move.',
    fen,
    pgn: game.pgn(),
    gameStatus: {
      inCheck: game.isCheck(),
      checkmate: game.isCheckmate(),
      draw: game.isDraw(),
      resultText: game.isCheck() ? 'White is in check' : null,
      checkedKingSquare: null
    },
    physicalMoveLog: [],
    board: { ready: true, missingSquares: [], extraSquares: [] },
    calibration: { ready: true, missingSquares: [], extraSquares: [] },
    selectedSource: null,
    legalTargets: [],
    robotBusy: false,
    pendingRobotJob: null,
    pendingUndo: null,
    pendingRedo: null,
    lastSnapshotAt: Date.now(),
    lastError: null,
    syncWarningReason: null,
    lastMove: null,
    ...overrides
  };
}

function analysisResult(fen) {
  const game = new Chess(fen);
  const move = game.moves({ verbose: true })[0];
  return {
    score: { type: 'cp', value: 12, perspective: 'white' },
    wdl: { white: 350, draw: 400, black: 250 },
    bestMove: move ? { uci: `${move.from}${move.to}${move.promotion || ''}`, san: move.san } : null,
    lines: [],
    telemetry: { elapsedMs: 1, depth: 1, nodes: 1 }
  };
}

const waitForObserver = () => new Promise((resolve) => setTimeout(resolve, 25));

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-physical-'));
  const dbPath = path.join(tempDir, 'mentor.sqlite');
  let store = new MentorStore({ dbPath });
  let chessService = new MentorChessService({ store });
  const engineService = { analyzeFen: async (fen) => analysisResult(fen) };
  let analysisService = new MentorAnalysisService({ chessService, engineService });
  const emitted = [];
  const stoppedLive = [];
  const physicalTurns = [];
  let liveActive = false;
  let activePhysicalActivity = null;
  let currentSnapshot = snapshot();
  const observer = new MentorPhysicalObserverService({
    store,
    chessService,
    analysisService,
    recoverableGuidanceDelayMs: 10,
    openingGuidanceDelayMs: 10,
    emit: (conversationId, event, payload) => emitted.push({ conversationId, event, payload })
  });
  observer.setDependencies({
    textService: { hasActiveConversation: () => false },
    liveService: {
      isConversationActive: () => liveActive,
      notifyPhysicalBoardUpdated: () => true,
      requestPhysicalTurn: (conversationId, request) => {
        physicalTurns.push({ conversationId, request });
        return liveActive ? { queued: true } : null;
      },
      stopConversation: async (conversationId, reason) => stoppedLive.push({ conversationId, reason })
    },
    activityService: {
      get: () => activePhysicalActivity,
      setPhysicalCoordinator: () => {}
    }
  });
  observer.setAdapter({ getSnapshot: () => currentSnapshot });

  const first = store.createConversation();
  const second = store.createConversation();
  const virtualBefore = chessService.getState(first.id);
  const attached = observer.attach(first.id, {
    serverInstanceId: 'server-a',
    sessionGeneration: 7,
    coachingMode: 'off'
  });
  assert.strictEqual(attached.binding.status, 'active');
  assert.strictEqual(attached.state.source, 'physical');
  assert.strictEqual(attached.state.sourceKey, 'physical:server-a:7');
  assert.strictEqual(attached.state.fen, START_FEN);
  assert.strictEqual(attached.state.physical.humanColor, 'white');
  assert.strictEqual(attached.state.physical.robotColor, 'black');
  assert.match(observer.promptContext(first.id), /Human player: White/);
  assert.match(observer.promptContext(first.id), /Physical robot opponent: Black/);
  assert.throws(() => observer.attach(second.id, {
    serverInstanceId: 'server-a',
    sessionGeneration: 7
  }), (error) => error.code === 'physical_board_already_attached');

  const annotated = observer.setAnnotations(first.id, {
    expectedRevision: 1,
    highlights: [{ square: 'e4', role: 'idea' }],
    arrows: [{ from: 'e2', to: 'e4', role: 'good' }]
  });
  assert.strictEqual(annotated.state.annotations.highlights[0].square, 'e4');
  assert.strictEqual(observer.setOrientation(first.id, {
    expectedRevision: 1,
    orientation: 'black'
  }).state.orientation, 'black');

  const normalized = normalizeSnapshot(currentSnapshot, store.getPhysicalBinding(first.id));
  assert.strictEqual(normalized.legalMoves.length, 20);
  assert.deepStrictEqual(normalized.annotations.highlights, [{ square: 'e4', role: 'idea' }]);
  const metadataState = normalizeSnapshot({
    ...currentSnapshot,
    physicalMoveLog: [{
      id: 'move-1',
      side: 'human',
      beforeFen: START_FEN,
      afterFen: START_FEN,
      uci: 'e1g1',
      san: 'O-O',
      color: 'w',
      piece: 'k',
      from: 'e1',
      to: 'g1',
      flags: 'k',
      castleRookMove: { from: 'h1', to: 'f1' },
      robotCapturedPathSquares: ['h4'],
      verified: true
    }]
  }, store.getPhysicalBinding(first.id));
  assert.deepStrictEqual(metadataState.history[0].castleRookMove, { from: 'h1', to: 'f1' });
  assert.deepStrictEqual(metadataState.history[0].robotCapturedPathSquares, ['h4']);

  const positionAnalysis = await observer.analyzePosition(first.id, { mode: 'quick' });
  assert.strictEqual(positionAnalysis.analyzedSource, 'physical');
  assert.strictEqual(positionAnalysis.sourceKey, 'physical:server-a:7');
  assert.strictEqual(store.getPhysicalBinding(first.id).analyzedFen, START_FEN);
  assert.strictEqual(observer.availability().binding.conversationId, first.id);

  const movedGame = new Chess(START_FEN);
  movedGame.move('e4');
  currentSnapshot = snapshot({
    stateRevision: 2,
    fen: movedGame.fen(),
    pgn: movedGame.pgn()
  });
  observer.handleSnapshot(currentSnapshot, 'physical-move');
  assert.strictEqual(store.getPhysicalBinding(first.id).analyzedFen, null);
  assert.deepStrictEqual(store.getPhysicalBinding(first.id).annotations, { highlights: [], arrows: [] });

  const pair = store.createMessagePair(first.id, {
    requestId: 'physical-tools',
    text: 'Read the board',
    assistantStatus: 'streaming'
  });
  const toolService = new MentorToolService({
    store,
    chessService,
    analysisService,
    physicalObserver: observer,
    activityService: { validateTool: () => {}, get: () => null }
  });
  assert.deepStrictEqual(
    toolService.declarations(first.id).map((tool) => tool.name),
    [
      'set_game_preferences',
      'play_physical_move',
      'get_physical_game_status',
      'start_physical_game',
      'attach_physical_game',
      'set_physical_coaching',
      'get_board_state',
      'analyze_position',
      'analyze_move',
      'set_orientation',
      'annotate_board',
      'get_activity_state',
      'start_activity',
      'resolve_physical_board_handoff',
      'pause_activity',
      'resume_activity',
      'confirm_physical_setup',
      'request_hint',
      'end_activity',
      'resolve_opening_drill'
    ]
  );
  const readResult = await toolService.execute({
    conversationId: first.id,
    requestId: 'physical-tools',
    assistantMessageId: pair.assistantMessage.id,
    ordinal: 1,
    call: { id: 'read-physical', name: 'get_board_state', args: {} },
    signal: new AbortController().signal
  });
  assert.strictEqual(readResult.response.output.source, 'physical');
  const moveResult = await toolService.execute({
    conversationId: first.id,
    requestId: 'physical-tools',
    assistantMessageId: pair.assistantMessage.id,
    ordinal: 2,
    call: { id: 'move-physical', name: 'play_move', args: { uci: 'e2e4' } },
    signal: new AbortController().signal
  });
  assert.strictEqual(moveResult.response.error.code, 'physical_board_read_only');
  assert.strictEqual(chessService.getState(first.id).fen, virtualBefore.fen);

  currentSnapshot = snapshot({
    stateRevision: 3,
    phase: 'sync_warning',
    statusText: 'Restore or center e2.',
    board: { ready: false, missingSquares: ['e2'], extraSquares: [] },
    syncWarningReason: { type: 'missing_piece' }
  });
  observer.handleSnapshot(currentSnapshot, 'physical-board');
  await waitForObserver();
  let physicalMessages = store.listMessages(first.id).filter((message) => message.kind === 'physical');
  assert.strictEqual(physicalMessages.length, 2, 'one warning should persist one event/reply pair');
  assert.match(physicalMessages[1].content, /e2/i);
  observer.handleSnapshot(currentSnapshot, 'physical-board');
  assert.strictEqual(
    store.listMessages(first.id).filter((message) => message.kind === 'physical').length,
    2,
    'duplicate warning snapshots must not duplicate guidance'
  );
  const warningGuidance = guidanceFor(currentSnapshot);
  assert.strictEqual(warningGuidance.urgent, true);
  assert.match(warningGuidance.prompt, /Speak this exact recovery instruction now:/);
  assert.match(warningGuidance.prompt, /Do not answer an earlier learner request/);

  const promotionGuidanceA = guidanceFor(snapshot({
    stateRevision: 4,
    phase: 'robot_promotion_awaiting_replacement',
    statusText: 'Replace the Black pawn on a1 with a queen.',
    pendingPromotion: { id: 'promotion-1', actor: 'robot', color: 'b', to: 'a1', selectedPiece: 'q' }
  }));
  const promotionGuidanceB = guidanceFor(snapshot({
    stateRevision: 5,
    phase: 'robot_promotion_awaiting_replacement',
    statusText: 'Verifying Black queen on a1...',
    pendingPromotion: { id: 'promotion-1', actor: 'robot', color: 'b', to: 'a1', selectedPiece: 'q' }
  }));
  assert.strictEqual(promotionGuidanceA.urgent, false);
  assert.strictEqual(promotionGuidanceA.key, promotionGuidanceB.key, 'one promotion replacement must have one spoken prompt');
  assert.match(promotionGuidanceA.reply, /a1.*queen/i);

  const plannedCheck = guidanceFor(snapshot({
    stateRevision: 4,
    phase: 'robot_busy',
    robotBusy: true,
    pendingRobotJob: { id: 'robot-check' },
    gameStatus: { inCheck: true, checkmate: false, draw: false, resultText: 'White is in check.', checkedKingSquare: 'e1' }
  }));
  assert.strictEqual(plannedCheck, null, 'a pre-verified robot check must remain silent');
  const stableCheckA = guidanceFor(snapshot({
    stateRevision: 5,
    statusText: 'Robot move committed.',
    gameStatus: { inCheck: true, checkmate: false, draw: false, resultText: 'White is in check.', checkedKingSquare: 'e1' }
  }));
  const stableCheckB = guidanceFor(snapshot({
    stateRevision: 6,
    statusText: 'Waiting for your move.',
    gameStatus: { inCheck: true, checkmate: false, draw: false, resultText: 'White is in check.', checkedKingSquare: 'e1' }
  }));
  assert.strictEqual(stableCheckA.key, stableCheckB.key, 'one verified checking position must have one guidance identity');

  liveActive = true;
  currentSnapshot = snapshot({
    stateRevision: 4,
    phase: 'piece_lifted',
    statusText: 'Piece lifted from e2.',
    board: { ready: false, missingSquares: ['e2'], extraSquares: [] },
    selectedSource: 'e2'
  });
  observer.handleSnapshot(currentSnapshot, 'physical-board');
  assert.strictEqual(physicalTurns.length, 1, 'an intermediate legal lift must not announce recovery');
  assert.ok(store.getPhysicalBinding(first.id).lastEventKey, 'recovery marker must survive piece-lifted state');
  currentSnapshot = snapshot({ stateRevision: 5, statusText: 'Board restored. Waiting for your move.' });
  observer.handleSnapshot(currentSnapshot, 'physical-board');
  assert.strictEqual(physicalTurns.length, 2, 'warning and recovery should each be offered to Live');
  assert.match(physicalTurns[1].request.prompt, /continue the interrupted chess teaching response/i);
  observer.handleSnapshot(currentSnapshot, 'physical-board');
  assert.strictEqual(physicalTurns.length, 2, 'duplicate clean snapshots must not repeat recovery');
  activePhysicalActivity = {
    id: 'physical-opening-1',
    type: 'opening_drill',
    title: 'Italian Game',
    goal: 'Develop quickly.',
    status: 'active',
    phase: 'learner_turn',
    stepIndex: 2,
    totalSteps: 10,
    config: {
      boardSource: 'physical',
      line: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'd2d3', 'g8f6', 'e1g1', 'd7d6']
    },
    state: { pauseReason: null }
  };
  const openingGame = new Chess(START_FEN);
  openingGame.move('e4');
  openingGame.move('e5');
  currentSnapshot = snapshot({
    stateRevision: 6,
    fen: openingGame.fen(),
    pgn: openingGame.pgn(),
    side: 'engine',
    move: 'e7e5',
    san: 'e5',
    verified: true,
    lastMove: { side: 'engine', move: 'e7e5', san: 'e5', at: 1000 }
  });
  observer.handleSnapshot(currentSnapshot, 'physical-move');
  await waitForObserver();
  assert.strictEqual(physicalTurns.length, 3, 'verified scripted Black reply should offer Live guidance');
  assert.match(physicalTurns[2].request.prompt, /required next learner move is g1f3/i);
  assert.strictEqual(physicalTurns[2].request.queueKey, 'physical-opening');
  assert.strictEqual(physicalTurns[2].request.timeoutMs, 30000);
  assert.strictEqual(physicalTurns[2].request.expectedAssistantText, undefined);
  assert.match(physicalTurns[2].request.fallbackAssistantText, /next, play g1f3/i);
  assert.match(physicalTurns[2].request.prompt, /central control, development, king safety/i);
  activePhysicalActivity = null;
  liveActive = false;
  currentSnapshot = snapshot({
    stateRevision: 7,
    phase: 'sync_warning',
    statusText: 'Restore or center e2.',
    board: { ready: false, missingSquares: ['e2'], extraSquares: [] }
  });
  observer.handleSnapshot(currentSnapshot, 'physical-board');
  await waitForObserver();
  physicalMessages = store.listMessages(first.id).filter((message) => message.kind === 'physical');
  assert.strictEqual(physicalMessages.length, 4, 'a resolved warning may be announced again if it recurs');

  const beforeTransientWarning = physicalMessages.length;
  currentSnapshot = snapshot({
    stateRevision: 8,
    phase: 'sync_warning',
    statusText: 'Restore or center f2.',
    board: { ready: false, missingSquares: ['f2'], extraSquares: [] }
  });
  observer.handleSnapshot(currentSnapshot, 'physical-board');
  currentSnapshot = snapshot({ stateRevision: 9, statusText: 'Waiting for your move.' });
  observer.handleSnapshot(currentSnapshot, 'physical-board');
  await waitForObserver();
  assert.strictEqual(
    store.listMessages(first.id).filter((message) => message.kind === 'physical').length,
    beforeTransientWarning,
    'a warning restored inside the grace period must remain silent and leave no recovery chatter'
  );

  currentSnapshot = snapshot({
    stateRevision: 1,
    sessionGeneration: 8
  });
  observer.handleSnapshot(currentSnapshot, 'physical-status');
  assert.strictEqual(store.getPhysicalBinding(first.id).status, 'stale');
  assert.deepStrictEqual(stoppedLive, [{ conversationId: first.id, reason: 'physical_session_stale' }]);
  assert.strictEqual(chessService.getState(first.id).fen, virtualBefore.fen);

  store.close();
  store = new MentorStore({ dbPath });
  assert.strictEqual(store.getPhysicalBinding(first.id).status, 'stale', 'binding state should survive restart');
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(emitted.some((entry) => entry.event === 'mentor-physical-board-updated'));
  assert(emitted.some((entry) => entry.event === 'mentor-physical-binding-updated'));
  console.log('Mentor physical-board observer regressions passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
