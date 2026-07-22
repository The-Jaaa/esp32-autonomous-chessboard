const { Chess } = require('chess.js');
const { analysisTimeMs, normalizeAnalysisMode } = require('./engine-service');

const MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

class MentorAnalysisError extends Error {
  constructor(message, code = 'analysis_error', details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

function moveToUci(move) {
  return `${move.from}${move.to}${move.promotion || ''}`;
}

function scoreForColor(score, color) {
  if (!score) return null;
  return { ...score, value: color === 'w' ? score.value : -score.value, perspective: color === 'w' ? 'white' : 'black' };
}

function scoreToNumber(score) {
  if (!score) return 0;
  if (score.type === 'cp') return score.value;
  return score.value > 0
    ? 100000 - (Math.abs(score.value) * 100)
    : -100000 + (Math.abs(score.value) * 100);
}

function mateImpact(bestScore, playedScore) {
  const bestMate = bestScore?.type === 'mate' ? bestScore.value : null;
  const playedMate = playedScore?.type === 'mate' ? playedScore.value : null;
  if (bestMate > 0 && !(playedMate > 0)) return 'missed_forced_mate';
  if (playedMate < 0 && !(bestMate < 0)) return 'allowed_forced_mate';
  if (playedMate > 0) return 'kept_or_delivered_forced_mate';
  if (playedMate < 0 && bestMate < 0) return 'mate_remains_unavoidable';
  return null;
}

function classifyMove({ legalCount, moveUci, bestMoveUci, bestScore, playedScore }) {
  if (legalCount === 1) return { classification: 'forced', centipawnLoss: 0, mateImpact: mateImpact(bestScore, playedScore) };
  if (moveUci === bestMoveUci) return { classification: 'best', centipawnLoss: 0, mateImpact: mateImpact(bestScore, playedScore) };

  const impact = mateImpact(bestScore, playedScore);
  if (impact === 'missed_forced_mate' || impact === 'allowed_forced_mate') {
    return { classification: 'blunder', centipawnLoss: null, mateImpact: impact };
  }
  if (bestScore?.type === 'mate' || playedScore?.type === 'mate') {
    if (bestScore?.value > 0 && playedScore?.value > 0) {
      return { classification: 'good', centipawnLoss: null, mateImpact: impact };
    }
    const mateLoss = Math.max(0, scoreToNumber(bestScore) - scoreToNumber(playedScore));
    return {
      classification: mateLoss <= 100 ? 'good' : mateLoss <= 250 ? 'mistake' : 'blunder',
      centipawnLoss: null,
      mateImpact: impact
    };
  }

  const centipawnLoss = Math.max(0, Math.round(scoreToNumber(bestScore) - scoreToNumber(playedScore)));
  let classification = 'blunder';
  if (centipawnLoss <= 15) classification = 'best';
  else if (centipawnLoss <= 50) classification = 'good';
  else if (centipawnLoss <= 100) classification = 'inaccuracy';
  else if (centipawnLoss <= 250) classification = 'mistake';
  return { classification, centipawnLoss, mateImpact: impact };
}

function terminalResult(fen) {
  const game = new Chess(fen);
  if (!game.isGameOver()) return null;
  let score = { type: 'cp', value: 0, perspective: 'white' };
  let wdl = { white: 0, draw: 1000, black: 0, whitePercent: 0, drawPercent: 100, blackPercent: 0 };
  if (game.isCheckmate()) {
    const whiteWon = game.turn() === 'b';
    score = { type: 'mate', value: whiteWon ? 1 : -1, perspective: 'white' };
    wdl = whiteWon
      ? { white: 1000, draw: 0, black: 0, whitePercent: 100, drawPercent: 0, blackPercent: 0 }
      : { white: 0, draw: 0, black: 1000, whitePercent: 0, drawPercent: 0, blackPercent: 100 };
  }
  return {
    status: 'terminal',
    fen: game.fen(),
    score,
    wdl,
    bestMove: null,
    lines: [],
    telemetry: { depth: 0, seldepth: 0, nodes: 0, nps: 0, timeMs: 0, elapsedMs: 0 }
  };
}

class MentorAnalysisService {
  constructor({ chessService, engineService }) {
    this.chessService = chessService;
    this.engineService = engineService;
  }

  assertCurrent(conversationId, expected) {
    const current = this.chessService.getState(conversationId);
    if (current.revision !== expected.revision || current.fen !== expected.fen) {
      throw new MentorAnalysisError('The board changed while Stockfish was analyzing it.', 'stale_analysis', {
        state: current
      });
    }
    return current;
  }

  async analyzePosition(conversationId, { mode = 'quick', signal } = {}) {
    const state = this.chessService.getState(conversationId);
    return this.analyzePositionState(state, {
      mode,
      signal,
      assertCurrent: () => this.assertCurrent(conversationId, state)
    });
  }

  async analyzePositionState(state, { mode = 'quick', signal, assertCurrent = () => state } = {}) {
    const normalizedMode = normalizeAnalysisMode(mode);
    if (state.gameStatus.isGameOver || !state.legalMoves.length) {
      throw new MentorAnalysisError('This position is already terminal and has no legal move to analyze.', 'terminal_position');
    }
    const analysis = await this.engineService.analyzeFen(state.fen, {
      mode: normalizedMode,
      multiPv: 3,
      signal
    });
    assertCurrent();
    return {
      kind: 'position_analysis',
      analyzedSource: state.source || 'virtual',
      sourceKey: state.sourceKey || `virtual:${state.conversationId}`,
      analyzedFen: state.fen,
      analyzedRevision: state.revision,
      mode: normalizedMode,
      score: analysis.score,
      wdl: analysis.wdl,
      bestMove: analysis.bestMove,
      lines: analysis.lines,
      telemetry: analysis.telemetry
    };
  }

  async analyzeMove(conversationId, { uci, mode = 'quick', signal, onProgress = () => {} } = {}) {
    const state = this.chessService.getState(conversationId);
    return this.analyzeMoveState(state, {
      uci,
      mode,
      signal,
      onProgress,
      assertCurrent: () => this.assertCurrent(conversationId, state)
    });
  }

  async analyzeMoveState(state, {
    uci,
    mode = 'quick',
    signal,
    onProgress = () => {},
    assertCurrent = () => state
  } = {}) {
    const normalizedMode = normalizeAnalysisMode(mode);
    const source = uci ? 'candidate' : 'latest_move';
    let requestedUci = uci;
    let baseFen;
    let resultingFen;
    let moveSan;

    if (source === 'latest_move') {
      const latest = state.history.at(-1);
      if (!latest) throw new MentorAnalysisError('There is no committed move to analyze.', 'missing_move_history');
      requestedUci = latest.uci;
      baseFen = latest.before;
      resultingFen = latest.after;
      moveSan = latest.san;
    } else {
      if (typeof requestedUci !== 'string' || !MOVE_PATTERN.test(requestedUci)) {
        throw new MentorAnalysisError('analyze_move requires a legal UCI move.', 'invalid_move');
      }
      baseFen = state.fen;
      const preview = new Chess(baseFen);
      let move = null;
      try {
        move = preview.move({
          from: requestedUci.slice(0, 2),
          to: requestedUci.slice(2, 4),
          promotion: requestedUci[4]
        });
      } catch {
        move = null;
      }
      if (!move) throw new MentorAnalysisError(`Illegal candidate move: ${requestedUci}.`, 'illegal_move');
      requestedUci = moveToUci(move);
      moveSan = move.san;
      resultingFen = preview.fen();
    }

    const baseGame = new Chess(baseFen);
    const legalMoves = baseGame.moves({ verbose: true });
    if (!legalMoves.some((move) => moveToUci(move) === requestedUci)) {
      throw new MentorAnalysisError(`The move ${requestedUci} is not legal in its source position.`, 'illegal_move');
    }

    const totalTime = analysisTimeMs(normalizedMode);
    const beforeTime = Math.floor(totalTime / 2);
    const afterTime = totalTime - beforeTime;
    const before = await this.engineService.analyzeFen(baseFen, {
      mode: normalizedMode,
      movetimeMs: beforeTime,
      multiPv: 3,
      signal
    });
    onProgress(1, 2);
    const after = terminalResult(resultingFen) || await this.engineService.analyzeFen(resultingFen, {
      mode: normalizedMode,
      movetimeMs: afterTime,
      multiPv: 1,
      signal
    });
    onProgress(2, 2);
    assertCurrent();

    const mover = baseGame.turn();
    const bestForMover = scoreForColor(before.score, mover);
    const playedForMover = scoreForColor(after.score, mover);
    const quality = classifyMove({
      legalCount: legalMoves.length,
      moveUci: requestedUci,
      bestMoveUci: before.bestMove?.uci,
      bestScore: bestForMover,
      playedScore: playedForMover
    });
    const currentPositionAnalysis = source === 'latest_move' ? after : before;

    return {
      kind: 'move_analysis',
      source,
      analyzedSource: state.source || 'virtual',
      sourceKey: state.sourceKey || `virtual:${state.conversationId}`,
      analyzedFen: state.fen,
      analyzedRevision: state.revision,
      baseFen,
      resultingFen,
      mode: normalizedMode,
      move: { uci: requestedUci, san: moveSan, color: mover },
      classification: quality.classification,
      centipawnLoss: quality.centipawnLoss,
      mateImpact: quality.mateImpact,
      before: {
        score: before.score,
        wdl: before.wdl,
        bestMove: before.bestMove,
        lines: before.lines,
        telemetry: before.telemetry
      },
      after: {
        score: after.score,
        wdl: after.wdl,
        bestMove: after.bestMove,
        lines: after.lines,
        telemetry: after.telemetry
      },
      score: currentPositionAnalysis.score,
      wdl: currentPositionAnalysis.wdl,
      bestAlternative: before.lines[0] || null,
      telemetry: {
        elapsedMs: (before.telemetry?.elapsedMs || 0) + (after.telemetry?.elapsedMs || 0),
        passes: [before.telemetry, after.telemetry]
      }
    };
  }
}

module.exports = {
  MentorAnalysisError,
  MentorAnalysisService,
  classifyMove,
  mateImpact,
  scoreForColor,
  scoreToNumber,
  terminalResult
};
