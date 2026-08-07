const assert = require('assert');
const { Chess } = require('chess.js');
const {
  PhysicalCoachingService,
  buildPhysicalCoachingEvidence,
  deterministicCoaching,
  validateCoachingDraft
} = require('../mentor/physical-coaching-service');

function moveEntry(game, san, id, side) {
  const before = game.fen();
  const move = game.move(san);
  return {
    id,
    uci: `${move.from}${move.to}${move.promotion || ''}`,
    san: move.san,
    before,
    after: game.fen(),
    captured: move.captured || null,
    capturedSquare: move.captured ? move.to : null,
    side
  };
}

function fixtureEvidence() {
  const game = new Chess();
  const history = [];
  history.push(moveEntry(game, 'e4', 'human-1', 'human'));
  history.push(moveEntry(game, 'd6', 'robot-1', 'robot'));
  history.push(moveEntry(game, 'Nf3', 'human-2', 'human'));
  history.push(moveEntry(game, 'Nf6', 'robot-2', 'robot'));
  const humanMove = history[2];
  const robotMove = history[3];
  return buildPhysicalCoachingEvidence({
    state: {
      sourceKey: 'physical:server:7',
      fen: game.fen(),
      pgn: game.pgn(),
      turn: game.turn(),
      revision: 44,
      history,
      physical: { serverInstanceId: 'server', sessionGeneration: 7 },
      gameStatus: { status: 'ongoing', isGameOver: false, inCheck: false }
    },
    humanMove,
    robotMove,
    moveAnalysis: {
      classification: 'good',
      centipawnLoss: 20,
      bestAlternative: { move: 'd2d4', moveSan: 'd4' },
      before: { score: { type: 'cp', value: 20 } },
      after: { score: { type: 'cp', value: 0 } }
    },
    positionAnalysis: {
      score: { type: 'cp', value: 12 },
      bestMove: { uci: 'd2d4', san: 'd4' },
      lines: [{ rank: 1, pv: ['d2d4', 'g7g6', 'b1c3'], pvSan: ['d4', 'g6', 'Nc3'], score: { type: 'cp', value: 12 } }]
    }
  });
}

async function main() {
  const evidence = fixtureEvidence();
  assert.strictEqual(evidence.pieces.f3, 'white knight');
  assert.strictEqual(evidence.pieces.f6, 'black knight');
  assert.strictEqual(evidence.humanMove.beforeFen.includes(' w '), true);
  assert.strictEqual(evidence.finalFen, evidence.robotMove.afterFen);

  const valid = {
    learnerMove: 'g1f3',
    opponentMove: 'g8f6',
    classification: 'good',
    text: 'Nf3 was good, and Stockfish replied Nf6. The verified continuation is d4, g6, Nc3.',
    planUci: ['d2d4', 'g7g6', 'b1c3'],
    claims: [
      { type: 'move', uci: 'g1f3' },
      { type: 'move', uci: 'g8f6' },
      { type: 'piece_on', piece: 'white knight', square: 'f3' }
    ]
  };
  assert.strictEqual(validateCoachingDraft(valid, evidence).valid, true);

  const hallucinated = {
    ...valid,
    text: 'Nf3 was good, but the bishop on h5 is trapped and Stockfish captured it.',
    claims: [
      { type: 'piece_on', piece: 'white bishop', square: 'h5' },
      { type: 'capture', uci: 'g8f6' }
    ]
  };
  const rejected = validateCoachingDraft(hallucinated, evidence);
  assert.strictEqual(rejected.valid, false);
  assert(rejected.errors.some((error) => error.includes('h5')));
  assert(rejected.errors.some((error) => error.includes('capture')));

  let calls = 0;
  const regenerated = new PhysicalCoachingService({
    generator: {
      async generate(_evidence, corrections) {
        calls += 1;
        if (calls === 1) {
          assert.strictEqual(corrections.length, 0);
          return hallucinated;
        }
        assert(corrections.length > 0);
        return valid;
      }
    },
    logger: { warn() {} }
  });
  const corrected = await regenerated.create(evidence);
  assert.strictEqual(corrected.mode, 'regenerated');
  assert.strictEqual(corrected.text, valid.text);
  assert.strictEqual(calls, 2);

  const fallbackService = new PhysicalCoachingService({
    generator: { async generate() { return hallucinated; } },
    logger: { warn() {} }
  });
  const fallback = await fallbackService.create(evidence);
  assert.strictEqual(fallback.mode, 'fallback');
  assert.strictEqual(fallback.text, deterministicCoaching(evidence));
  assert.match(fallback.text, /Nf3 was good/);
  assert.match(fallback.text, /Stockfish replied Nf6/);
  assert.match(fallback.text, /d4, g6, Nc3/);
  assert.doesNotMatch(fallback.text, /h5|captur|trapped/i);

  console.log('Mentor grounded physical coaching regressions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
