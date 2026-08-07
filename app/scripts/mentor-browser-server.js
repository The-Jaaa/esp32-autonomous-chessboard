const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');

const databasePath = path.join(__dirname, '..', 'tmp', 'mentor-playwright.sqlite');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) {
  fs.rmSync(`${databasePath}${suffix}`, { force: true });
}

process.env.MENTOR_DB_PATH = databasePath;
process.env.MENTOR_FAKE_TEXT = '1';
process.env.MENTOR_FAKE_LIVE = '1';
process.env.PORT = '3010';

const { app, server, mentorFeature } = require('../server');

const PHYSICAL_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let physicalSnapshot = makePhysicalSnapshot();

function makePhysicalSnapshot(overrides = {}) {
  const fen = overrides.fen || PHYSICAL_START_FEN;
  const game = new Chess(fen);
  return {
    protocolVersion: 1,
    serverInstanceId: 'mentor-browser-server',
    sessionGeneration: 1,
    stateRevision: 1,
    active: true,
    phase: 'ready',
    statusText: 'Waiting for your move.',
    fen,
    pgn: game.pgn(),
    gameStatus: {
      inCheck: game.isCheck(),
      checkmate: game.isCheckmate(),
      draw: game.isDraw(),
      resultText: null,
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
    ...overrides
  };
}

mentorFeature.physicalObserver.setAdapter({ getSnapshot: () => physicalSnapshot });

app.post('/api/test/mentor-physical-state', (req, res) => {
  physicalSnapshot = makePhysicalSnapshot({
    ...physicalSnapshot,
    ...req.body,
    stateRevision: Number(req.body?.stateRevision || physicalSnapshot.stateRevision + 1),
    lastSnapshotAt: Date.now()
  });
  mentorFeature.physicalObserver.handleSnapshot(physicalSnapshot, 'physical-board');
  res.json({ state: physicalSnapshot });
});

app.post('/api/test/mentor-physical-handoff/:conversationId', (req, res) => {
  const binding = mentorFeature.store.getActivePhysicalBinding('main-board');
  if (!binding) return res.status(409).json({ error: 'No owner is attached.' });
  if (!mentorFeature.store.getActiveActivity(binding.conversationId)) {
    mentorFeature.activityService.startPhysicalPractice(binding.conversationId, {
      learnerColor: physicalSnapshot.humanColor || 'white',
      opponentMode: 'stockfish',
      expectedRevision: physicalSnapshot.stateRevision
    });
  }
  const result = mentorFeature.physicalObserver.ensureVoiceActivityBoard(req.params.conversationId, {
    requestId: `browser-handoff-${Date.now()}`,
    learnerColor: physicalSnapshot.humanColor || 'white',
    activityRequest: {
      type: 'practice_game',
      opponentMode: 'stockfish',
      learnerColor: physicalSnapshot.humanColor || 'white'
    }
  });
  return res.json(result);
});

server.listen(Number(process.env.PORT), () => {
  console.log(`Mentor browser test server listening on port ${process.env.PORT}`);
});
