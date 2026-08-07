const { Chess } = require('chess.js');

const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const SQUARE_PATTERN = /\b[a-h][1-8]\b/g;
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

function responseText(response) {
  if (typeof response?.text === 'string') return response.text;
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || '').join('');
}

function parseJson(text) {
  const cleaned = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

function pieceMap(fen) {
  const game = new Chess(fen);
  const result = {};
  const files = 'abcdefgh';
  game.board().forEach((rank, row) => rank.forEach((piece, column) => {
    if (!piece) return;
    const square = `${files[column]}${8 - row}`;
    result[square] = `${piece.color === 'w' ? 'white' : 'black'} ${PIECE_NAMES[piece.type]}`;
  }));
  return result;
}

function materialFromMap(map) {
  const counts = {};
  for (const piece of Object.values(map)) counts[piece] = Number(counts[piece] || 0) + 1;
  return counts;
}

function lineMoves(positionAnalysis) {
  return (positionAnalysis?.lines || []).slice(0, 3).map((line) => ({
    rank: line.rank,
    uci: (line.pv || []).slice(0, 5),
    san: (line.pvSan || []).slice(0, 5),
    score: line.score
  }));
}

function buildPhysicalCoachingEvidence({ state, humanMove, robotMove, moveAnalysis, positionAnalysis }) {
  const currentPieces = pieceMap(state.fen);
  return {
    sourceKey: state.sourceKey,
    serverInstanceId: state.physical.serverInstanceId,
    sessionGeneration: state.physical.sessionGeneration,
    revision: state.revision,
    finalFen: state.fen,
    pgn: state.pgn || '',
    turn: state.turn,
    gameStatus: state.gameStatus,
    humanMove: {
      id: humanMove.id,
      uci: humanMove.uci,
      san: humanMove.san || humanMove.uci,
      beforeFen: humanMove.before,
      afterFen: humanMove.after,
      captured: humanMove.captured || null,
      capturedSquare: humanMove.capturedSquare || null
    },
    robotMove: {
      id: robotMove?.id || null,
      uci: robotMove?.uci || null,
      san: robotMove?.san || robotMove?.uci || null,
      beforeFen: robotMove?.before || humanMove.after,
      afterFen: robotMove?.after || state.fen,
      captured: robotMove?.captured || null,
      capturedSquare: robotMove?.capturedSquare || null
    },
    recentMoves: state.history.slice(-12).map((move) => ({ uci: move.uci, san: move.san })),
    pieces: currentPieces,
    material: materialFromMap(currentPieces),
    moveAnalysis: {
      classification: moveAnalysis?.classification || 'unclassified',
      centipawnLoss: moveAnalysis?.centipawnLoss ?? null,
      mateImpact: moveAnalysis?.mateImpact || null,
      bestAlternative: moveAnalysis?.bestAlternative
        ? { uci: moveAnalysis.bestAlternative.move, san: moveAnalysis.bestAlternative.moveSan }
        : null,
      beforeScore: moveAnalysis?.before?.score || null,
      afterScore: moveAnalysis?.after?.score || null
    },
    positionAnalysis: {
      score: positionAnalysis?.score || null,
      bestMove: positionAnalysis?.bestMove || null,
      lines: lineMoves(positionAnalysis)
    }
  };
}

function scoreText(score) {
  if (!score) return null;
  if (score.type === 'mate') return `mate in ${Math.abs(score.value)}`;
  return `${score.value >= 0 ? '+' : ''}${(score.value / 100).toFixed(2)}`;
}

function deterministicCoaching(evidence) {
  const quality = evidence.moveAnalysis.classification;
  const alternative = evidence.moveAnalysis.bestAlternative?.san;
  const line = evidence.positionAnalysis.lines[0]?.san || [];
  const assessment = `${evidence.humanMove.san} was ${quality}.${alternative && alternative !== evidence.humanMove.san ? ` ${alternative} was the stronger alternative.` : ''}`;
  const reply = evidence.robotMove.san ? `Stockfish replied ${evidence.robotMove.san}.` : '';
  const evaluation = scoreText(evidence.positionAnalysis.score);
  const plan = line.length
    ? `The verified continuation is ${line.slice(0, 3).join(', ')}${evaluation ? `, with an evaluation of ${evaluation} from White's perspective` : ''}.`
    : `Reassess the current position before choosing the next plan${evaluation ? `; the evaluation is ${evaluation} from White's perspective` : ''}.`;
  return [assessment, reply, plan].filter(Boolean).join(' ');
}

function allowedSquares(evidence) {
  const squares = new Set(Object.keys(evidence.pieces));
  for (const move of [evidence.humanMove, evidence.robotMove]) {
    if (!move?.uci) continue;
    squares.add(move.uci.slice(0, 2));
    squares.add(move.uci.slice(2, 4));
  }
  for (const line of evidence.positionAnalysis.lines) {
    for (const uci of line.uci) {
      squares.add(uci.slice(0, 2));
      squares.add(uci.slice(2, 4));
    }
  }
  return squares;
}

function validateCoachingDraft(draft, evidence) {
  const errors = [];
  if (!draft || typeof draft !== 'object') return { valid: false, errors: ['Response is not an object.'] };
  if (draft.learnerMove !== evidence.humanMove.uci) errors.push('Learner move does not match the verified move.');
  if ((draft.opponentMove || null) !== (evidence.robotMove.uci || null)) errors.push('Opponent move does not match the verified reply.');
  if (draft.classification !== evidence.moveAnalysis.classification) errors.push('Classification does not match Stockfish.');
  if (typeof draft.text !== 'string' || !draft.text.trim()) errors.push('Coaching text is empty.');
  const plan = Array.isArray(draft.planUci) ? draft.planUci : [];
  const allowedLines = evidence.positionAnalysis.lines.map((line) => line.uci);
  if (plan.some((uci) => !UCI_PATTERN.test(uci))) errors.push('Plan contains malformed UCI moves.');
  if (plan.length && !allowedLines.some((line) => plan.every((uci, index) => line[index] === uci))) {
    errors.push('Plan is not a prefix of a verified Stockfish line.');
  }
  const squares = String(draft.text || '').match(SQUARE_PATTERN) || [];
  const permittedSquares = allowedSquares(evidence);
  if (squares.some((square) => !permittedSquares.has(square))) errors.push('Text references a square outside the verified position or lines.');
  const claims = Array.isArray(draft.claims) ? draft.claims : [];
  for (const claim of claims) {
    if (claim?.type === 'piece_on') {
      if (evidence.pieces[claim.square] !== claim.piece) errors.push(`Incorrect piece claim on ${claim.square}.`);
    } else if (claim?.type === 'move') {
      const actual = [evidence.humanMove.uci, evidence.robotMove.uci];
      const inLine = evidence.positionAnalysis.lines.some((line) => line.uci.includes(claim.uci));
      if (!actual.includes(claim.uci) && !inLine) errors.push(`Unverified move claim ${claim.uci}.`);
    } else if (claim?.type === 'capture') {
      const actualCapture = [evidence.humanMove, evidence.robotMove]
        .some((move) => move?.uci === claim.uci && move.captured);
      if (!actualCapture) errors.push(`Unverified capture claim ${claim.uci}.`);
    } else {
      errors.push('Unsupported factual claim type.');
    }
  }
  if (/\b(?:capture|captured|takes|took|wins? a piece)\b/i.test(draft.text || '')
      && !claims.some((claim) => claim.type === 'capture')) {
    errors.push('Capture language is not backed by a validated capture claim.');
  }
  if (/\b(?:attack|attacks|attacked|threat|threatens|trapped)\b/i.test(draft.text || '')) {
    errors.push('Unstructured attack or threat claims are not allowed in automatic coaching.');
  }
  return { valid: errors.length === 0, errors };
}

class GeminiPhysicalCoachingGenerator {
  constructor({ ai, model = 'gemini-3.5-flash' } = {}) {
    this.ai = ai;
    this.model = model;
  }

  async generate(evidence, corrections = []) {
    if (!this.ai || !process.env.GEMINI_API_KEY) return null;
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        'Return one JSON object only with keys learnerMove, opponentMove, classification, text, planUci, and claims.',
        'Use only the supplied facts. Do not infer attacks, threats, captures, or piece locations.',
        'claims may contain only {type:"piece_on",piece,square}, {type:"move",uci}, or {type:"capture",uci}.',
        'planUci must be a prefix of one supplied Stockfish line. Write two or three concise, direct coaching sentences.',
        corrections.length ? `Correct these previous validation failures: ${corrections.join(' ')}` : '',
        JSON.stringify(evidence)
      ].filter(Boolean).join('\n'),
      config: { responseModalities: ['TEXT'] }
    });
    return parseJson(responseText(response));
  }
}

class PhysicalCoachingService {
  constructor({ ai, model, generator = null, logger = console } = {}) {
    this.generator = generator || new GeminiPhysicalCoachingGenerator({ ai, model });
    this.logger = logger;
  }

  async create(evidence) {
    let corrections = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const draft = await this.generator.generate(evidence, corrections);
        if (!draft) break;
        const validation = validateCoachingDraft(draft, evidence);
        if (validation.valid) {
          return { text: draft.text.trim(), draft, validation, mode: attempt === 1 ? 'generated' : 'regenerated' };
        }
        corrections = validation.errors;
      } catch (error) {
        corrections = [error.message];
        this.logger.warn?.('[MENTOR_PHYSICAL_COACHING_GENERATION_FAILED]', error.message);
      }
    }
    return {
      text: deterministicCoaching(evidence),
      draft: null,
      validation: { valid: true, errors: corrections },
      mode: 'fallback'
    };
  }
}

module.exports = {
  GeminiPhysicalCoachingGenerator,
  PhysicalCoachingService,
  buildPhysicalCoachingEvidence,
  deterministicCoaching,
  pieceMap,
  validateCoachingDraft
};
