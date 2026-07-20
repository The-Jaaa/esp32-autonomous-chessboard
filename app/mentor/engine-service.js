const { spawn } = require('child_process');
const path = require('path');
const { Chess } = require('chess.js');

const QUICK_TIME_MS = 1000;
const DEEP_TIME_MS = 3000;
const MAX_WAITING_JOBS = 8;

class MentorEngineError extends Error {
  constructor(message, code = 'engine_error') {
    super(message);
    this.code = code;
  }
}

function makeAbortError(message = 'Stockfish analysis was cancelled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'analysis_cancelled';
  return error;
}

function normalizeAnalysisMode(mode = 'quick') {
  if (mode !== 'quick' && mode !== 'deep') {
    throw new MentorEngineError('Analysis mode must be quick or deep.', 'invalid_analysis_mode');
  }
  return mode;
}

function analysisTimeMs(mode = 'quick') {
  return normalizeAnalysisMode(mode) === 'deep' ? DEEP_TIME_MS : QUICK_TIME_MS;
}

function parseInfoLine(line) {
  if (typeof line !== 'string' || !line.startsWith('info ') || !line.includes(' score ')) return null;
  const number = (name) => {
    const match = line.match(new RegExp(`(?:^| )${name} (-?\\d+)`));
    return match ? Number(match[1]) : null;
  };
  const scoreMatch = line.match(/ score (cp|mate) (-?\d+)/);
  if (!scoreMatch) return null;
  const pvMarker = line.indexOf(' pv ');
  const pv = pvMarker >= 0 ? line.slice(pvMarker + 4).trim().split(/\s+/).filter(Boolean) : [];
  const wdlMatch = line.match(/ wdl (\d+) (\d+) (\d+)/);
  return {
    depth: number('depth'),
    seldepth: number('seldepth'),
    multipv: number('multipv') || 1,
    score: { type: scoreMatch[1], value: Number(scoreMatch[2]) },
    wdl: wdlMatch ? wdlMatch.slice(1).map(Number) : null,
    nodes: number('nodes'),
    nps: number('nps'),
    timeMs: number('time'),
    pv
  };
}

function scoreForWhite(score, turn) {
  if (!score) return null;
  return {
    type: score.type,
    value: turn === 'w' ? score.value : -score.value,
    perspective: 'white'
  };
}

function wdlForWhite(wdl, turn) {
  if (!wdl) return null;
  const [wins, draws, losses] = turn === 'w' ? wdl : [wdl[2], wdl[1], wdl[0]];
  const total = wins + draws + losses || 1;
  return {
    white: wins,
    draw: draws,
    black: losses,
    whitePercent: Number(((wins / total) * 100).toFixed(1)),
    drawPercent: Number(((draws / total) * 100).toFixed(1)),
    blackPercent: Number(((losses / total) * 100).toFixed(1))
  };
}

function pvToSan(fen, pv) {
  const game = new Chess(fen);
  const san = [];
  for (const uci of pv) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) break;
    let move = null;
    try {
      move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      move = null;
    }
    if (!move) break;
    san.push(move.san);
  }
  return san;
}

function serializeLine(fen, turn, info) {
  const san = pvToSan(fen, info.pv);
  return {
    rank: info.multipv,
    move: info.pv[0] || null,
    moveSan: san[0] || null,
    score: scoreForWhite(info.score, turn),
    scoreSideToMove: { ...info.score, perspective: 'side_to_move' },
    wdl: wdlForWhite(info.wdl, turn),
    depth: info.depth,
    seldepth: info.seldepth,
    nodes: info.nodes,
    nps: info.nps,
    timeMs: info.timeMs,
    pv: info.pv,
    pvSan: san
  };
}

function terminalAnalysis(fen) {
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
    turn: game.turn(),
    score,
    wdl,
    bestMove: null,
    lines: [],
    telemetry: { depth: 0, seldepth: 0, nodes: 0, nps: 0, timeMs: 0, elapsedMs: 0 }
  };
}

class MentorEngineService {
  constructor({
    stockfishPath = path.join(__dirname, '..', 'node_modules', 'stockfish', 'bin', 'stockfish-18-lite-single.js'),
    processFactory,
    maxWaitingJobs = MAX_WAITING_JOBS,
    hashMb = 32,
    startupTimeoutMs = 5000,
    watchdogGraceMs = 750,
    stopGraceMs = 300,
    abortGraceMs = 500,
    now = () => Date.now()
  } = {}) {
    this.stockfishPath = stockfishPath;
    this.processFactory = processFactory || (() => spawn(process.execPath, [this.stockfishPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    }));
    this.maxWaitingJobs = maxWaitingJobs;
    this.hashMb = hashMb;
    this.startupTimeoutMs = startupTimeoutMs;
    this.watchdogGraceMs = watchdogGraceMs;
    this.stopGraceMs = stopGraceMs;
    this.abortGraceMs = abortGraceMs;
    this.now = now;
    this.process = null;
    this.readyPromise = null;
    this.buffer = '';
    this.waiters = [];
    this.queue = [];
    this.currentJob = null;
    this.searchContext = null;
    this.closed = false;
    this.expectedExit = false;
  }

  send(command) {
    if (!this.process?.stdin?.writable) throw new MentorEngineError('Stockfish is unavailable.', 'engine_unavailable');
    this.process.stdin.write(`${command}\n`);
  }

  waitForLine(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new MentorEngineError(`Stockfish timed out while waiting for ${label}.`, 'engine_start_timeout'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(trimmed)) continue;
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve(trimmed);
    }
    if (!this.searchContext) return;
    const info = parseInfoLine(trimmed);
    if (info && info.multipv <= this.searchContext.multiPv) {
      this.searchContext.lines.set(info.multipv, info);
      return;
    }
    if (trimmed.startsWith('bestmove ')) this.finishSearch(trimmed.split(/\s+/)[1] || null);
  }

  handleData(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) this.handleLine(line);
  }

  handleProcessFailure(error) {
    const failure = error instanceof MentorEngineError
      ? error
      : new MentorEngineError(error?.message || 'Stockfish exited unexpectedly.', 'engine_crashed');
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    if (this.searchContext) {
      const context = this.searchContext;
      this.searchContext = null;
      clearTimeout(context.watchdog);
      clearTimeout(context.killTimer);
      context.reject(failure);
    }
    this.process = null;
    this.readyPromise = null;
  }

  async ensureProcess() {
    if (this.closed) throw new MentorEngineError('Stockfish service is closed.', 'engine_closed');
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      const child = this.processFactory();
      this.process = child;
      this.expectedExit = false;
      child.stdout.on('data', (chunk) => this.handleData(chunk));
      child.stderr?.on('data', () => {});
      child.on('error', (error) => this.handleProcessFailure(error));
      child.on('exit', (code) => {
        if (!this.expectedExit) {
          this.handleProcessFailure(new MentorEngineError(`Stockfish exited with code ${code}.`, 'engine_crashed'));
        } else {
          this.process = null;
          this.readyPromise = null;
        }
      });

      const uciOk = this.waitForLine((line) => line === 'uciok', this.startupTimeoutMs, 'uciok');
      this.send('uci');
      await uciOk;
      this.send('setoption name Threads value 1');
      this.send(`setoption name Hash value ${this.hashMb}`);
      this.send('setoption name UCI_ShowWDL value true');
      const ready = this.waitForLine((line) => line === 'readyok', this.startupTimeoutMs, 'readyok');
      this.send('isready');
      await ready;
      return child;
    })().catch((error) => {
      this.readyPromise = null;
      this.terminateProcess();
      throw error;
    });
    return this.readyPromise;
  }

  analyzeFen(fen, { mode = 'quick', movetimeMs, multiPv = 3, signal } = {}) {
    let game;
    try {
      game = new Chess(fen);
    } catch (error) {
      return Promise.reject(new MentorEngineError(`Invalid FEN: ${error.message}`, 'invalid_fen'));
    }
    const terminal = terminalAnalysis(game.fen());
    if (terminal) return Promise.resolve(terminal);
    const normalizedMode = normalizeAnalysisMode(mode);
    const requestedTime = Number.isInteger(movetimeMs) && movetimeMs > 0
      ? movetimeMs
      : analysisTimeMs(normalizedMode);
    const requestedPv = Math.max(1, Math.min(3, Number(multiPv) || 1, game.moves().length));
    if (signal?.aborted) return Promise.reject(makeAbortError());
    if (this.queue.length >= this.maxWaitingJobs) {
      return Promise.reject(new MentorEngineError('Stockfish analysis queue is full.', 'engine_busy'));
    }

    return new Promise((resolve, reject) => {
      const job = {
        fen: game.fen(),
        turn: game.turn(),
        mode: normalizedMode,
        movetimeMs: requestedTime,
        multiPv: requestedPv,
        signal,
        resolve,
        reject,
        startedAt: null,
        abortListener: null,
        running: false
      };
      job.abortListener = () => {
        if (!job.running) {
          this.queue = this.queue.filter((candidate) => candidate !== job);
          reject(makeAbortError());
          return;
        }
        if (this.currentJob === job && this.searchContext) {
          this.searchContext.cancelled = true;
          try { this.send('stop'); } catch { this.terminateProcess(); }
          this.searchContext.killTimer = setTimeout(() => this.terminateProcess(), this.abortGraceMs);
        }
      };
      signal?.addEventListener('abort', job.abortListener, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  async pump() {
    if (this.currentJob || !this.queue.length || this.closed) return;
    const job = this.queue.shift();
    this.currentJob = job;
    job.running = true;
    try {
      await this.ensureProcess();
      if (job.signal?.aborted) throw makeAbortError();
      const result = await this.executeSearch(job);
      job.resolve(result);
    } catch (error) {
      job.reject(error);
    } finally {
      job.signal?.removeEventListener('abort', job.abortListener);
      this.currentJob = null;
      queueMicrotask(() => this.pump());
    }
  }

  executeSearch(job) {
    return new Promise((resolve, reject) => {
      job.startedAt = this.now();
      const context = {
        job,
        multiPv: job.multiPv,
        lines: new Map(),
        resolve,
        reject,
        cancelled: false,
        watchdog: null,
        killTimer: null
      };
      this.searchContext = context;
      context.watchdog = setTimeout(() => {
        if (this.searchContext !== context) return;
        try { this.send('stop'); } catch { this.terminateProcess(); return; }
        context.killTimer = setTimeout(() => this.terminateProcess(), this.stopGraceMs);
      }, job.movetimeMs + this.watchdogGraceMs);
      this.send(`setoption name MultiPV value ${job.multiPv}`);
      this.send(`position fen ${job.fen}`);
      this.send(`go movetime ${job.movetimeMs}`);
    });
  }

  finishSearch(bestMove) {
    const context = this.searchContext;
    if (!context) return;
    this.searchContext = null;
    clearTimeout(context.watchdog);
    clearTimeout(context.killTimer);
    if (context.cancelled || context.job.signal?.aborted) {
      context.reject(makeAbortError());
      return;
    }
    const lines = [...context.lines.values()]
      .sort((left, right) => left.multipv - right.multipv)
      .map((info) => serializeLine(context.job.fen, context.job.turn, info));
    if (!lines.length) {
      context.reject(new MentorEngineError('Stockfish returned no analysis lines.', 'empty_engine_result'));
      return;
    }
    const primary = lines.find((line) => line.move === bestMove) || lines[0];
    context.resolve({
      status: 'complete',
      fen: context.job.fen,
      turn: context.job.turn,
      mode: context.job.mode,
      score: primary.score,
      scoreSideToMove: primary.scoreSideToMove,
      wdl: primary.wdl,
      bestMove: {
        uci: bestMove && bestMove !== '(none)' ? bestMove : primary.move,
        san: primary.moveSan
      },
      lines,
      telemetry: {
        depth: primary.depth,
        seldepth: primary.seldepth,
        nodes: primary.nodes,
        nps: primary.nps,
        timeMs: primary.timeMs,
        elapsedMs: Math.max(0, this.now() - context.job.startedAt)
      }
    });
  }

  terminateProcess() {
    if (!this.process) return;
    this.expectedExit = true;
    const child = this.process;
    this.process = null;
    this.readyPromise = null;
    try { child.kill(); } catch { /* Process is already gone. */ }
    if (this.searchContext) {
      const context = this.searchContext;
      this.searchContext = null;
      clearTimeout(context.watchdog);
      clearTimeout(context.killTimer);
      context.reject(context.cancelled ? makeAbortError() : new MentorEngineError('Stockfish did not stop cleanly.', 'engine_timeout'));
    }
  }

  close() {
    this.closed = true;
    const closedError = new MentorEngineError('Stockfish service is closed.', 'engine_closed');
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(closedError);
    }
    for (const job of this.queue.splice(0)) {
      job.signal?.removeEventListener('abort', job.abortListener);
      job.reject(new MentorEngineError('Stockfish service closed before analysis started.', 'engine_closed'));
    }
    this.terminateProcess();
  }
}

module.exports = {
  DEEP_TIME_MS,
  MAX_WAITING_JOBS,
  MentorEngineError,
  MentorEngineService,
  QUICK_TIME_MS,
  analysisTimeMs,
  makeAbortError,
  normalizeAnalysisMode,
  parseInfoLine,
  pvToSan,
  scoreForWhite,
  terminalAnalysis,
  wdlForWhite
};
