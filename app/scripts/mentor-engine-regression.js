const assert = require('assert');
const { EventEmitter } = require('events');
const { Chess } = require('chess.js');
const { MentorStore } = require('../mentor/store');
const { MentorChessService } = require('../mentor/chess-service');
const { MentorToolService } = require('../mentor/tool-service');
const {
  MentorEngineService,
  parseInfoLine,
  pvToSan,
  scoreForWhite,
  wdlForWhite
} = require('../mentor/engine-service');
const {
  MentorAnalysisService,
  classifyMove
} = require('../mentor/analysis-service');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function waitUntil(predicate, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('Timed out waiting for test condition.'));
      setTimeout(check, 2);
    };
    check();
  });
}

class FakeStockfishProcess extends EventEmitter {
  constructor(goBehaviors = []) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.commands = [];
    this.goBehaviors = [...goBehaviors];
    this.multiPv = 1;
    this.currentBehavior = null;
    this.stdin = {
      writable: true,
      write: (chunk) => this.command(String(chunk).trim())
    };
  }

  line(value) {
    queueMicrotask(() => this.stdout.emit('data', Buffer.from(`${value}\n`)));
  }

  command(value) {
    this.commands.push(value);
    if (value === 'uci') this.line('uciok');
    if (value === 'isready') this.line('readyok');
    const multi = value.match(/^setoption name MultiPV value (\d+)$/);
    if (multi) this.multiPv = Number(multi[1]);
    if (value.startsWith('go movetime ')) {
      this.currentBehavior = this.goBehaviors.shift() || { type: 'normal' };
      if (this.currentBehavior.type === 'crash') {
        queueMicrotask(() => this.emit('exit', 9));
      } else if (this.currentBehavior.type !== 'hold') {
        this.completeSearch();
      }
    }
    if (value === 'stop' && this.currentBehavior?.respondToStop !== false) this.completeSearch();
  }

  completeSearch() {
    const moves = ['e2e4', 'g1f3', 'd2d4'];
    for (let rank = 1; rank <= this.multiPv; rank += 1) {
      this.line(`info depth ${12 - rank} seldepth 16 multipv ${rank} score cp ${35 - (rank * 5)} wdl ${300 - rank} 500 ${200 + rank} nodes ${1000 * rank} nps 50000 time 20 pv ${moves[rank - 1]} e7e5`);
    }
    this.line('bestmove e2e4');
    this.currentBehavior = null;
  }

  kill() {
    this.stdin.writable = false;
    queueMicrotask(() => this.emit('exit', 0));
  }
}

function engineResult(fen, cp, bestMove = 'e2e4', overrides = {}) {
  const game = new Chess(fen);
  const turn = game.turn();
  let move = null;
  try {
    move = game.move({ from: bestMove.slice(0, 2), to: bestMove.slice(2, 4), promotion: bestMove[4] });
  } catch {
    move = null;
  }
  const line = {
    rank: 1,
    move: bestMove,
    moveSan: move?.san || bestMove,
    score: { type: 'cp', value: cp, perspective: 'white' },
    scoreSideToMove: { type: 'cp', value: turn === 'w' ? cp : -cp, perspective: 'side_to_move' },
    wdl: { white: 400, draw: 400, black: 200, whitePercent: 40, drawPercent: 40, blackPercent: 20 },
    depth: 12,
    seldepth: 16,
    nodes: 1000,
    nps: 50000,
    timeMs: 500,
    pv: [bestMove],
    pvSan: [move?.san || bestMove]
  };
  return {
    status: 'complete',
    fen,
    turn,
    mode: 'quick',
    score: line.score,
    scoreSideToMove: line.scoreSideToMove,
    wdl: line.wdl,
    bestMove: { uci: bestMove, san: move?.san || bestMove },
    lines: [line],
    telemetry: { depth: 12, seldepth: 16, nodes: 1000, nps: 50000, timeMs: 500, elapsedMs: 500 },
    ...overrides
  };
}

class ScriptedEngine {
  constructor(results = []) {
    this.results = [...results];
    this.calls = [];
  }

  async analyzeFen(fen, options) {
    this.calls.push({ fen, options });
    const next = this.results.shift();
    if (typeof next === 'function') return next(fen, options);
    return next || engineResult(fen, 20);
  }
}

async function parserRegressions() {
  const parsed = parseInfoLine('info depth 18 seldepth 25 multipv 2 score mate -3 wdl 10 20 970 nodes 4200 nps 210000 time 20 pv e7e8q a1a2');
  assert.deepStrictEqual(parsed.score, { type: 'mate', value: -3 });
  assert.strictEqual(parsed.multipv, 2);
  assert.deepStrictEqual(parsed.wdl, [10, 20, 970]);
  assert.deepStrictEqual(parsed.pv, ['e7e8q', 'a1a2']);
  assert.deepStrictEqual(scoreForWhite({ type: 'cp', value: 40 }, 'b'), { type: 'cp', value: -40, perspective: 'white' });
  assert.strictEqual(wdlForWhite([100, 300, 600], 'b').white, 600);
  assert.deepStrictEqual(pvToSan(START_FEN, ['e2e4', 'e7e5', 'g1f3']), ['e4', 'e5', 'Nf3']);
}

async function workerRegressions() {
  const process = new FakeStockfishProcess([{ type: 'normal' }, { type: 'normal' }]);
  let starts = 0;
  const service = new MentorEngineService({ processFactory: () => { starts += 1; return process; } });
  const [first, second] = await Promise.all([
    service.analyzeFen(START_FEN, { movetimeMs: 5, multiPv: 3 }),
    service.analyzeFen(START_FEN, { movetimeMs: 5, multiPv: 2 })
  ]);
  assert.strictEqual(starts, 1);
  assert.strictEqual(first.lines.length, 3);
  assert.strictEqual(first.bestMove.uci, 'e2e4');
  assert.strictEqual(second.lines.length, 2);
  assert.strictEqual(process.commands.filter((command) => command.startsWith('go movetime')).length, 2);
  service.close();

  const queuedProcess = new FakeStockfishProcess([{ type: 'hold' }, { type: 'normal' }]);
  const queued = new MentorEngineService({ processFactory: () => queuedProcess, maxWaitingJobs: 1 });
  const controller = new AbortController();
  const active = queued.analyzeFen(START_FEN, { movetimeMs: 100, signal: controller.signal }).catch((error) => error);
  await waitUntil(() => queuedProcess.commands.some((command) => command.startsWith('go movetime')));
  const waiting = queued.analyzeFen(START_FEN, { movetimeMs: 5 });
  await assert.rejects(queued.analyzeFen(START_FEN, { movetimeMs: 5 }), (error) => error.code === 'engine_busy');
  controller.abort();
  assert.strictEqual((await active).name, 'AbortError');
  assert.strictEqual((await waiting).bestMove.uci, 'e2e4');
  queued.close();

  let processNumber = 0;
  const crashing = new MentorEngineService({
    processFactory: () => new FakeStockfishProcess([processNumber++ === 0 ? { type: 'crash' } : { type: 'normal' }])
  });
  await assert.rejects(crashing.analyzeFen(START_FEN, { movetimeMs: 5 }), (error) => error.code === 'engine_crashed');
  assert.strictEqual((await crashing.analyzeFen(START_FEN, { movetimeMs: 5 })).bestMove.uci, 'e2e4');
  crashing.close();

  const stalled = new MentorEngineService({
    processFactory: () => new FakeStockfishProcess([{ type: 'hold', respondToStop: false }]),
    watchdogGraceMs: 5,
    stopGraceMs: 5
  });
  await assert.rejects(stalled.analyzeFen(START_FEN, { movetimeMs: 1 }), (error) => error.code === 'engine_timeout');
  stalled.close();
}

function classificationRegressions() {
  const cp = (value) => ({ type: 'cp', value });
  assert.strictEqual(classifyMove({ legalCount: 1, moveUci: 'a1a2', bestMoveUci: 'a1a2', bestScore: cp(0), playedScore: cp(0) }).classification, 'forced');
  assert.strictEqual(classifyMove({ legalCount: 5, moveUci: 'a1a2', bestMoveUci: 'a1a3', bestScore: cp(100), playedScore: cp(85) }).classification, 'best');
  assert.strictEqual(classifyMove({ legalCount: 5, moveUci: 'a1a2', bestMoveUci: 'a1a3', bestScore: cp(100), playedScore: cp(50) }).classification, 'good');
  assert.strictEqual(classifyMove({ legalCount: 5, moveUci: 'a1a2', bestMoveUci: 'a1a3', bestScore: cp(100), playedScore: cp(0) }).classification, 'inaccuracy');
  assert.strictEqual(classifyMove({ legalCount: 5, moveUci: 'a1a2', bestMoveUci: 'a1a3', bestScore: cp(100), playedScore: cp(-150) }).classification, 'mistake');
  assert.strictEqual(classifyMove({ legalCount: 5, moveUci: 'a1a2', bestMoveUci: 'a1a3', bestScore: cp(100), playedScore: cp(-151) }).classification, 'blunder');
  assert.strictEqual(classifyMove({
    legalCount: 5,
    moveUci: 'a1a2',
    bestMoveUci: 'a1a3',
    bestScore: { type: 'mate', value: 3 },
    playedScore: cp(500)
  }).mateImpact, 'missed_forced_mate');
}

async function analysisAndToolRegressions() {
  const store = new MentorStore({ dbPath: ':memory:' });
  const chess = new MentorChessService({ store });
  const conversation = store.createConversation();
  const scripted = new ScriptedEngine([engineResult(START_FEN, 30, 'e2e4')]);
  const analysis = new MentorAnalysisService({ chessService: chess, engineService: scripted });
  const position = await analysis.analyzePosition(conversation.id, { mode: 'deep' });
  assert.strictEqual(position.kind, 'position_analysis');
  assert.strictEqual(position.mode, 'deep');
  assert.strictEqual(position.analyzedFen, START_FEN);
  assert.strictEqual(scripted.calls[0].options.multiPv, 3);

  chess.move(conversation.id, { uci: 'e2e4', expectedRevision: 0, actionId: 'human-e4' });
  const afterE4 = chess.getState(conversation.id).fen;
  const moveEngine = new ScriptedEngine([
    engineResult(START_FEN, 35, 'e2e4'),
    engineResult(afterE4, 30, 'e7e5')
  ]);
  const moveAnalysis = new MentorAnalysisService({ chessService: chess, engineService: moveEngine });
  const latest = await moveAnalysis.analyzeMove(conversation.id, { mode: 'quick' });
  assert.strictEqual(latest.move.uci, 'e2e4');
  assert.strictEqual(latest.classification, 'best');
  assert.strictEqual(latest.analyzedFen, afterE4);
  assert.strictEqual(moveEngine.calls[0].options.movetimeMs + moveEngine.calls[1].options.movetimeMs, 1000);

  const candidatePreview = new Chess(afterE4);
  candidatePreview.move('a6');
  const candidateEngine = new ScriptedEngine([
    engineResult(afterE4, 20, 'e7e5'),
    engineResult(candidatePreview.fen(), 20, 'g1f3')
  ]);
  const candidateAnalysis = new MentorAnalysisService({ chessService: chess, engineService: candidateEngine });
  const beforeCandidate = chess.getState(conversation.id).fen;
  const candidate = await candidateAnalysis.analyzeMove(conversation.id, { uci: 'a7a6' });
  assert.strictEqual(candidate.source, 'candidate');
  assert.strictEqual(chess.getState(conversation.id).fen, beforeCandidate);
  assert.strictEqual(candidate.analyzedFen, beforeCandidate);
  await assert.rejects(candidateAnalysis.analyzeMove(conversation.id, { uci: 'e2e5' }), (error) => error.code === 'illegal_move');

  const staleConversation = store.createConversation();
  const staleEngine = new ScriptedEngine([() => {
    chess.move(staleConversation.id, { uci: 'e2e4', expectedRevision: 0, actionId: 'concurrent-e4' });
    return engineResult(START_FEN, 30);
  }]);
  const staleAnalysis = new MentorAnalysisService({ chessService: chess, engineService: staleEngine });
  await assert.rejects(staleAnalysis.analyzePosition(staleConversation.id), (error) => error.code === 'stale_analysis');

  const toolConversation = store.createConversation();
  const pair = store.createMessagePair(toolConversation.id, { requestId: 'engine-tool', text: 'Analyze.' });
  let calls = 0;
  const toolAnalysis = {
    async analyzePosition(id, options) {
      calls += 1;
      return { ...engineResult(chess.getState(id).fen, 25), kind: 'position_analysis', analyzedFen: chess.getState(id).fen, analyzedRevision: 0, mode: options.mode };
    }
  };
  const tools = new MentorToolService({ store, chessService: chess, analysisService: toolAnalysis });
  const call = {
    conversationId: toolConversation.id,
    requestId: 'engine-tool',
    assistantMessageId: pair.assistantMessage.id,
    ordinal: 1,
    call: { id: 'provider-analysis', name: 'analyze_position', args: { mode: 'quick' } },
    signal: new AbortController().signal
  };
  const first = await tools.execute(call);
  const duplicate = await tools.execute(call);
  assert.strictEqual(first.toolCall.status, 'complete');
  assert.strictEqual(duplicate.toolCall.status, 'complete');
  assert.strictEqual(calls, 1);
  assert.strictEqual(store.listToolCalls(toolConversation.id)[0].result.kind, 'position_analysis');
  store.close();
}

async function realEngineSmoke() {
  const engine = new MentorEngineService();
  try {
    const result = await engine.analyzeFen(START_FEN, { movetimeMs: 100, multiPv: 2 });
    const legal = new Chess(START_FEN).moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion || ''}`);
    assert.ok(legal.includes(result.bestMove.uci));
    assert.ok(result.lines.length >= 1);
  } finally {
    engine.close();
  }
}

async function main() {
  await parserRegressions();
  await workerRegressions();
  classificationRegressions();
  await analysisAndToolRegressions();
  await realEngineSmoke();
  console.log('Mentor Stockfish analysis regressions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
