const { Chess } = require('chess.js');

const MAX_LINE_PLIES = 24;
const MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

const TOOL_DECLARATIONS = [{
  name: 'get_board_state',
  description: 'Read the authoritative board state, legal moves, orientation, and teaching annotations.',
  parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false }
}, {
  name: 'analyze_position',
  description: 'Ask Stockfish to evaluate the authoritative current position and return up to three verified candidate lines. Use deep mode only when the user requests detailed calculation.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['quick', 'deep'], description: 'Quick takes about one second; deep takes about three seconds.' }
    },
    additionalProperties: false
  }
}, {
  name: 'analyze_move',
  description: 'Ask Stockfish to assess the latest committed move, or a supplied legal candidate move without playing it.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      uci: { type: 'string', description: 'Optional legal candidate UCI move. Omit it to assess the latest committed move.' },
      mode: { type: 'string', enum: ['quick', 'deep'], description: 'Quick takes about one second total; deep takes about three seconds total.' }
    },
    additionalProperties: false
  }
}, {
  name: 'play_move',
  description: 'Play one legal move on the mentor board using UCI notation such as e2e4 or a7a8q.',
  parametersJsonSchema: {
    type: 'object',
    properties: { uci: { type: 'string', description: 'A legal UCI move.' } },
    required: ['uci'],
    additionalProperties: false
  }
}, {
  name: 'play_line',
  description: 'Demonstrate a fully legal sequence of up to 24 UCI plies, one move per second.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      moves: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_LINE_PLIES
      }
    },
    required: ['moves'],
    additionalProperties: false
  }
}, {
  name: 'load_position',
  description: 'Replace the mentor board with a valid FEN position for a lesson, puzzle, or example.',
  parametersJsonSchema: {
    type: 'object',
    properties: { fen: { type: 'string', description: 'A complete valid FEN.' } },
    required: ['fen'],
    additionalProperties: false
  }
}, {
  name: 'reset_board',
  description: 'Reset the mentor board to this conversation’s initial position.',
  parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false }
}, {
  name: 'set_orientation',
  description: 'Show the board from White or Black’s perspective.',
  parametersJsonSchema: {
    type: 'object',
    properties: { orientation: { type: 'string', enum: ['white', 'black'] } },
    required: ['orientation'],
    additionalProperties: false
  }
}, {
  name: 'annotate_board',
  description: 'Replace the teaching highlights and arrows on the current board. Empty arrays clear annotations.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      highlights: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          properties: {
            square: { type: 'string' },
            role: { type: 'string', enum: ['idea', 'good', 'warning', 'danger', 'special'] }
          },
          required: ['square', 'role'],
          additionalProperties: false
        }
      },
      arrows: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            role: { type: 'string', enum: ['idea', 'good', 'warning', 'danger', 'special'] }
          },
          required: ['from', 'to', 'role'],
          additionalProperties: false
        }
      }
    },
    required: ['highlights', 'arrows'],
    additionalProperties: false
  }
}];

function makeAbortError(message = 'Mentor tool execution was cancelled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function waitWithSignal(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(makeAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function compactBoardState(state) {
  return {
    fen: state.fen,
    pgn: state.pgn,
    turn: state.turnName,
    revision: state.revision,
    orientation: state.orientation,
    gameStatus: state.gameStatus,
    recentMoves: state.history.slice(-12).map((move) => ({ uci: move.uci, san: move.san })),
    legalMoves: state.legalMoves,
    annotations: state.annotations
  };
}

function progressTotalFor(name, args) {
  if (name === 'play_line' && Array.isArray(args?.moves)) return args.moves.length;
  if (name === 'analyze_move') return 2;
  return 1;
}

class MentorToolService {
  constructor({ store, chessService, analysisService = null, emit = () => {}, emitBoardUpdate = () => {}, delay = waitWithSignal }) {
    this.store = store;
    this.chessService = chessService;
    this.analysisService = analysisService;
    this.emit = emit;
    this.emitBoardUpdate = emitBoardUpdate;
    this.delay = delay;
  }

  declarations() {
    return TOOL_DECLARATIONS;
  }

  publish(conversationId, event, toolCall) {
    this.emit(conversationId, event, { conversationId, toolCall });
  }

  update(conversationId, id, event, patch) {
    const toolCall = this.store.updateToolCall(id, patch);
    this.publish(conversationId, event, toolCall);
    return toolCall;
  }

  boardUpdate(conversationId, result, actionId) {
    this.emitBoardUpdate(conversationId, { ...result, actionId });
  }

  async execute({ conversationId, requestId, assistantMessageId, ordinal, call, signal }) {
    const name = String(call?.name || 'unknown_tool');
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    const providerCallId = String(call?.id || `${name}-${ordinal}`);
    const created = this.store.createToolCall({
      conversationId,
      requestId,
      assistantMessageId,
      providerCallId,
      ordinal,
      name,
      arguments: args,
      progressTotal: progressTotalFor(name, args)
    });
    if (created.duplicate && ['complete', 'failed', 'cancelled'].includes(created.toolCall.status)) {
      return {
        response: created.toolCall.status === 'complete'
          ? { output: created.toolCall.result }
          : { error: { message: created.toolCall.error, status: created.toolCall.status } },
        toolCall: created.toolCall
      };
    }

    let toolCall = this.update(conversationId, created.toolCall.id, 'mentor-tool-started', {
      status: 'running'
    });
    try {
      if (signal?.aborted) throw makeAbortError();
      const result = await this.runTool(name, args, {
        conversationId,
        toolCall,
        signal,
        onProgress: (progressCurrent, progressTotal) => {
          toolCall = this.update(conversationId, toolCall.id, 'mentor-tool-progress', {
            status: 'running',
            progressCurrent,
            progressTotal
          });
        }
      });
      toolCall = this.update(conversationId, toolCall.id, 'mentor-tool-completed', {
        status: 'complete',
        result,
        error: null,
        progressCurrent: toolCall.progressTotal || 1
      });
      return { response: { output: result }, toolCall };
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted) {
        toolCall = this.update(conversationId, toolCall.id, 'mentor-tool-cancelled', {
          status: 'cancelled',
          result: error.partialResult || null,
          error: error.message
        });
        throw error;
      }
      toolCall = this.update(conversationId, toolCall.id, 'mentor-tool-failed', {
        status: 'failed',
        error: error.message,
        result: error.state ? { board: compactBoardState(error.state) } : null
      });
      return {
        response: {
          error: {
            message: error.message,
            code: error.code || 'tool_failed',
            board: error.state ? compactBoardState(error.state) : compactBoardState(this.chessService.getState(conversationId))
          }
        },
        toolCall
      };
    }
  }

  async runTool(name, args, context) {
    const { conversationId, toolCall, signal, onProgress } = context;
    if (name === 'get_board_state') {
      onProgress(1, 1);
      return compactBoardState(this.chessService.getState(conversationId));
    }

    if (name === 'analyze_position') {
      if (!this.analysisService) throw new Error('Stockfish mentor analysis is unavailable.');
      const result = await this.analysisService.analyzePosition(conversationId, {
        mode: args.mode || 'quick',
        signal
      });
      onProgress(1, 1);
      return result;
    }

    if (name === 'analyze_move') {
      if (!this.analysisService) throw new Error('Stockfish mentor analysis is unavailable.');
      return this.analysisService.analyzeMove(conversationId, {
        uci: args.uci,
        mode: args.mode || 'quick',
        signal,
        onProgress
      });
    }

    if (name === 'play_move') {
      if (typeof args.uci !== 'string' || !MOVE_PATTERN.test(args.uci)) {
        throw new Error('play_move requires one valid UCI move.');
      }
      const state = this.chessService.getState(conversationId);
      const actionId = `mentor:${toolCall.id}:0`;
      const result = this.chessService.move(conversationId, {
        uci: args.uci,
        expectedRevision: state.revision,
        actionId
      });
      this.boardUpdate(conversationId, result, actionId);
      onProgress(1, 1);
      return { move: result.state.history.at(-1), board: compactBoardState(result.state) };
    }

    if (name === 'play_line') {
      if (!Array.isArray(args.moves) || args.moves.length < 1 || args.moves.length > MAX_LINE_PLIES
        || args.moves.some((move) => typeof move !== 'string' || !MOVE_PATTERN.test(move))) {
        throw new Error(`play_line requires 1-${MAX_LINE_PLIES} valid UCI moves.`);
      }
      const initial = this.chessService.getState(conversationId);
      const preview = new Chess(initial.fen);
      for (const uci of args.moves) {
        let move = null;
        try {
          move = preview.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        } catch {
          move = null;
        }
        if (!move) throw new Error(`The demonstration contains an illegal move: ${uci}. No moves were played.`);
      }

      const completed = [];
      for (let index = 0; index < args.moves.length; index += 1) {
        if (signal?.aborted) {
          const error = makeAbortError();
          error.partialResult = { completedMoves: completed };
          throw error;
        }
        const state = this.chessService.getState(conversationId);
        const actionId = `mentor:${toolCall.id}:${index}`;
        const result = this.chessService.move(conversationId, {
          uci: args.moves[index],
          expectedRevision: state.revision,
          actionId
        });
        const committed = result.state.history.at(-1);
        completed.push({ uci: committed.uci, san: committed.san });
        this.boardUpdate(conversationId, result, actionId);
        onProgress(index + 1, args.moves.length);
        if (index < args.moves.length - 1) {
          try {
            await this.delay(1000, signal);
          } catch (error) {
            error.partialResult = { completedMoves: completed };
            throw error;
          }
        }
      }
      return {
        completedMoves: completed,
        board: compactBoardState(this.chessService.getState(conversationId))
      };
    }

    if (name === 'load_position') {
      const state = this.chessService.getState(conversationId);
      const actionId = `mentor:${toolCall.id}:0`;
      const result = this.chessService.setPosition(conversationId, {
        fen: args.fen,
        expectedRevision: state.revision,
        actionId
      });
      this.boardUpdate(conversationId, result, actionId);
      onProgress(1, 1);
      return { board: compactBoardState(result.state) };
    }

    if (name === 'reset_board') {
      const state = this.chessService.getState(conversationId);
      const actionId = `mentor:${toolCall.id}:0`;
      const result = this.chessService.reset(conversationId, {
        expectedRevision: state.revision,
        actionId
      });
      this.boardUpdate(conversationId, result, actionId);
      onProgress(1, 1);
      return { board: compactBoardState(result.state) };
    }

    if (name === 'set_orientation') {
      const state = this.chessService.getState(conversationId);
      const actionId = `mentor:${toolCall.id}:0`;
      const result = this.chessService.setOrientation(conversationId, {
        orientation: args.orientation,
        expectedRevision: state.revision,
        actionId
      });
      this.boardUpdate(conversationId, result, actionId);
      onProgress(1, 1);
      return { orientation: result.state.orientation, board: compactBoardState(result.state) };
    }

    if (name === 'annotate_board') {
      const state = this.chessService.getState(conversationId);
      const actionId = `mentor:${toolCall.id}:0`;
      const result = this.chessService.setAnnotations(conversationId, {
        highlights: args.highlights,
        arrows: args.arrows,
        expectedRevision: state.revision
      });
      this.boardUpdate(conversationId, result, actionId);
      onProgress(1, 1);
      return { annotations: result.state.annotations, board: compactBoardState(result.state) };
    }

    throw new Error(`Unknown mentor tool: ${name}.`);
  }
}

module.exports = {
  MAX_LINE_PLIES,
  MentorToolService,
  TOOL_DECLARATIONS,
  compactBoardState,
  makeAbortError,
  waitWithSignal
};
