const { Chess } = require('chess.js');
const { listCatalog } = require('./curriculum');

const MAX_LINE_PLIES = 24;
const MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const PHYSICAL_ONLY_TOOL_NAMES = new Set([
  'play_physical_move',
  'pause_activity',
  'resume_activity',
  'confirm_physical_setup',
  'resolve_opening_drill',
  'resolve_physical_board_handoff'
]);
const VOICE_FIRST_UNATTACHED_TOOL_NAMES = new Set([
  'set_game_preferences',
  'get_physical_game_status',
  'get_activity_state',
  'start_activity',
  'resolve_physical_board_handoff'
]);
const VOICE_FIRST_BLOCKED_TOOL_NAMES = new Set([
  'start_physical_game',
  'attach_physical_game',
  'confirm_physical_setup'
]);
const CUSTOM_ACTIVITY_PROPERTIES = {
  type: { type: 'string', enum: ['opening_drill', 'puzzle', 'guided_lesson'] },
  title: { type: 'string' },
  goal: { type: 'string' },
  topic: { type: 'string' },
  learnerColor: { type: 'string', enum: ['white', 'black'] },
  initialFen: { type: 'string' },
  line: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 24 },
  hints: { type: 'array', items: { type: 'string' }, maxItems: 3 }
};

const TOOL_DECLARATIONS = [{
  name: 'set_game_preferences',
  description: 'Set the learner\'s default side and/or difficulty. Side applies to the next game; difficulty also applies to the next robot turn of an attached physical game.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      humanColor: { type: 'string', enum: ['white', 'black'] },
      difficultyLevel: { type: 'integer', minimum: 1, maximum: 15 }
    },
    additionalProperties: false
  }
}, {
  name: 'play_physical_move',
  description: 'Play one Stockfish-verified opponent move only during Gemini\'s assigned turn in an active Mentor-led physical game. Never use this tool to move the learner\'s pieces or to continue normal play after a reviewed opening.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      uci: { type: 'string', description: 'One legal UCI move from the verified candidate list.' },
      plan: {
        type: 'string',
        maxLength: 240,
        description: 'A concise strategic plan that should guide later mentor moves and explanations.'
      }
    },
    required: ['uci'],
    additionalProperties: false
  }
}, {
  name: 'get_physical_game_status',
  description: 'Check whether the physical chessboard is connected, whether a game is active, and whether it is already attached to a mentor conversation.',
  parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false }
}, {
  name: 'start_physical_game',
  description: 'Start and attach one default physical game after the learner explicitly asks for a physical game. Never call for an ambiguous request to play a game.',
  parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false }
}, {
  name: 'attach_physical_game',
  description: 'Attach this conversation to an already active, unbound physical game after the learner explicitly confirms attachment.',
  parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false }
}, {
  name: 'set_physical_coaching',
  description: 'Enable or disable selective coaching for the attached physical game.',
  parametersJsonSchema: {
    type: 'object',
    properties: { mode: { type: 'string', enum: ['selective', 'off'] } },
    required: ['mode'],
    additionalProperties: false
  }
}, {
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
}, {
  name: 'get_activity_state',
  description: 'Read the current structured lesson or practice activity state for this conversation.',
  parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false }
}, {
  name: 'start_activity',
  description: 'Start a confirmed mentor activity. Only call after the learner explicitly agrees to start.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['practice_game', 'opening_drill', 'puzzle', 'guided_lesson'] },
      opponentMode: { type: 'string', enum: ['mentor', 'stockfish'] },
      learnerColor: { type: 'string', enum: ['white', 'black'] },
      startFrom: { type: 'string', enum: ['standard', 'current'] },
      sourceId: { type: 'string' },
      proposal: {
        type: 'object',
        properties: CUSTOM_ACTIVITY_PROPERTIES,
        required: ['type', 'title', 'goal', 'initialFen', 'line'],
        additionalProperties: false
      }
    },
    required: ['type'],
    additionalProperties: false
  }
}, {
  name: 'resolve_physical_board_handoff',
  description: 'Resolve a pending physical-board ownership conflict after the learner chooses to continue the existing game or explicitly end it and start the requested activity in this conversation.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['continue_existing', 'end_and_start'] }
    },
    required: ['action'],
    additionalProperties: false
  }
}, {
  name: 'pause_activity',
  description: 'Pause the active physical mentor activity. A robot move already in progress finishes safely.',
  parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false }
}, {
  name: 'resume_activity',
  description: 'Resume the paused physical mentor activity without restarting it.',
  parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false }
}, {
  name: 'confirm_physical_setup',
  description: 'Confirm that the named pieces for a physical puzzle were placed correctly after occupancy calibration.',
  parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false }
}, {
  name: 'propose_activity',
  description: 'Validate a custom opening drill, puzzle, or guided lesson without starting it. Ask the learner before starting the returned activity.',
  parametersJsonSchema: {
    type: 'object',
    properties: CUSTOM_ACTIVITY_PROPERTIES,
    required: ['type', 'title', 'goal', 'initialFen', 'line'],
    additionalProperties: false
  }
}, {
  name: 'request_prediction',
  description: 'Pause an active mentor turn and visibly ask the learner to predict the opponent move.',
  parametersJsonSchema: {
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
    additionalProperties: false
  }
}, {
  name: 'request_hint',
  description: 'Advance to the next hint for the active opening, puzzle, or guided lesson.',
  parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false }
}, {
  name: 'end_activity',
  description: 'End the current mentor activity while preserving the current board position.',
  parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false }
}, {
  name: 'resolve_opening_drill',
  description: 'Resolve a completed or blocked physical opening drill. Use action continue when the learner asks to keep playing after the reviewed line; the learner keeps moving their own color and Stockfish supplies opponent replies with selective coaching.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['retry', 'repeat', 'continue', 'finish', 'resume'] }
    },
    required: ['action'],
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
    source: state.source || 'virtual',
    sourceKey: state.sourceKey || `virtual:${state.conversationId}`,
    fen: state.fen,
    pgn: state.pgn,
    turn: state.turnName,
    revision: state.revision,
    orientation: state.orientation,
    gameStatus: state.gameStatus,
    recentMoves: state.history.slice(-12).map((move) => ({ uci: move.uci, san: move.san })),
    legalMoves: state.legalMoves,
    annotations: state.annotations,
    physical: state.physical || null
  };
}

function progressTotalFor(name, args) {
  if (name === 'play_line' && Array.isArray(args?.moves)) return args.moves.length;
  if (name === 'analyze_move') return 2;
  return 1;
}

class MentorToolService {
  constructor({ store, chessService, analysisService = null, activityService = null, physicalObserver = null, gameSettingsService = null, emit = () => {}, emitBoardUpdate = () => {}, delay = waitWithSignal }) {
    this.store = store;
    this.chessService = chessService;
    this.analysisService = analysisService;
    this.activityService = activityService;
    this.physicalObserver = physicalObserver;
    this.gameSettingsService = gameSettingsService;
    this.emit = emit;
    this.emitBoardUpdate = emitBoardUpdate;
    this.delay = delay;
    this.inFlight = new Map();
  }

  declarations(conversationId = null, { voiceFirstPhysical = false } = {}) {
    if (voiceFirstPhysical) {
      const physicalDeclarations = TOOL_DECLARATIONS.map((tool) => {
        if (tool.name === 'resolve_physical_board_handoff') {
          return {
            ...tool,
            description: 'Resolve the current pending physical-board ownership conflict after the learner chooses an action. The backend binds the handoff identity.',
            parametersJsonSchema: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['continue_existing', 'end_and_start'] }
              },
              required: ['action'],
              additionalProperties: false
            }
          };
        }
        if (tool.name !== 'start_activity') return tool;
        const sourceIds = listCatalog()
          .filter((item) => item.supportsPhysical && item.type === 'opening_drill')
          .map((item) => item.id);
        return {
          ...tool,
          description: 'Start a confirmed guided physical game or reviewed opening. Opening identity and learner color may be retained from earlier spoken turns.',
          parametersJsonSchema: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['practice_game', 'opening_drill'] },
              opponentMode: { type: 'string', enum: ['mentor', 'stockfish'] },
              learnerColor: { type: 'string', enum: ['white', 'black'] },
              sourceId: { type: 'string', enum: sourceIds }
            },
            required: ['type'],
            additionalProperties: false
          }
        };
      });
      if (conversationId && this.physicalObserver?.isAttached(conversationId)) {
        return physicalDeclarations.filter((tool) => this.physicalObserver.allowedTool(tool.name)
          && !VOICE_FIRST_BLOCKED_TOOL_NAMES.has(tool.name));
      }
      return physicalDeclarations.filter((tool) => VOICE_FIRST_UNATTACHED_TOOL_NAMES.has(tool.name));
    }
    if (conversationId && this.physicalObserver?.isAttached(conversationId)) {
      return TOOL_DECLARATIONS.filter((tool) => this.physicalObserver.allowedTool(tool.name));
    }
    return TOOL_DECLARATIONS.filter((tool) => !PHYSICAL_ONLY_TOOL_NAMES.has(tool.name));
  }

  setActivityService(activityService) {
    this.activityService = activityService;
  }

  setPhysicalObserver(physicalObserver) {
    this.physicalObserver = physicalObserver;
  }

  workspaceState(conversationId) {
    return this.physicalObserver?.isAttached(conversationId)
      ? this.physicalObserver.getState(conversationId)
      : this.chessService.getState(conversationId);
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

  executionKey(conversationId, requestId, call, ordinal) {
    const providerCallId = String(call?.id || `${String(call?.name || 'unknown_tool')}-${ordinal}`);
    return `${conversationId}:${requestId}:${providerCallId}`;
  }

  execute(options) {
    const key = this.executionKey(
      options.conversationId,
      options.requestId,
      options.call,
      options.ordinal
    );
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const execution = this.executeOnce(options);
    this.inFlight.set(key, execution);
    execution.finally(() => {
      if (this.inFlight.get(key) === execution) this.inFlight.delete(key);
    }).catch(() => {});
    return execution;
  }

  async executeOnce({ conversationId, requestId, assistantMessageId, ordinal, call, signal, channel = 'text' }) {
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
      if (this.physicalObserver?.isAttached(conversationId)
        && !this.physicalObserver.allowedTool(name)) {
        const error = new Error(`${name} is unavailable while observing the read-only physical board.`);
        error.code = 'physical_board_read_only';
        error.state = this.physicalObserver.getState(conversationId);
        throw error;
      }
      this.activityService?.validateTool(conversationId, requestId, name, args);
      const result = await this.runTool(name, args, {
        conversationId,
        requestId,
        toolCall,
        signal,
        channel,
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
            board: error.state ? compactBoardState(error.state) : compactBoardState(this.workspaceState(conversationId))
          }
        },
        toolCall
      };
    }
  }

  async runTool(name, args, context) {
    const { conversationId, requestId, toolCall, signal, onProgress, channel } = context;
    if (channel === 'live-physical' && VOICE_FIRST_BLOCKED_TOOL_NAMES.has(name)) {
      const error = new Error('Use start_activity to start or attach the physical board and create the requested Mentor activity transactionally.');
      error.code = 'voice_activity_start_required';
      throw error;
    }
    if (name === 'set_game_preferences') {
      if (!this.gameSettingsService) throw new Error('Game settings are unavailable.');
      const result = this.gameSettingsService.updateFromMentor(conversationId, args);
      const activity = this.activityService?.get?.(conversationId) || null;
      let difficultyApplies = args.difficultyLevel === undefined ? null : 'next_game';
      if (args.difficultyLevel !== undefined && activity?.config?.boardSource === 'physical') {
        if (activity.type === 'practice_game' && activity.config.opponentMode === 'stockfish') {
          difficultyApplies = 'next_robot_turn';
        } else if (activity.type === 'puzzle') {
          difficultyApplies = 'next_puzzle';
        } else {
          difficultyApplies = 'next_game';
        }
      }
      onProgress(1, 1);
      return {
        ...result,
        applicability: {
          humanColor: args.humanColor === undefined ? null : 'next_game',
          difficultyLevel: difficultyApplies,
          currentActivityUnchanged: Boolean(activity && difficultyApplies !== 'next_robot_turn')
        }
      };
    }

    if (name === 'get_physical_game_status') {
      onProgress(1, 1);
      return this.physicalObserver?.getPhysicalGameStatus(conversationId) || { available: false };
    }

    if (name === 'start_physical_game') {
      if (!this.physicalObserver) throw new Error('Physical game control is unavailable.');
      const result = this.physicalObserver.startPhysicalGame(conversationId, { requestId });
      onProgress(1, 1);
      return result;
    }

    if (name === 'attach_physical_game') {
      if (!this.physicalObserver) throw new Error('Physical game control is unavailable.');
      const result = this.physicalObserver.attachPhysicalGame(conversationId, { requestId });
      onProgress(1, 1);
      return result;
    }

    if (name === 'set_physical_coaching') {
      if (!this.physicalObserver) throw new Error('Physical coaching is unavailable.');
      const result = this.physicalObserver.setCoaching(conversationId, args.mode, 'gemini');
      onProgress(1, 1);
      return result;
    }

    if (name === 'get_board_state') {
      onProgress(1, 1);
      return compactBoardState(this.workspaceState(conversationId));
    }

    if (name === 'get_activity_state') {
      onProgress(1, 1);
      return this.activityService?.get(conversationId) || null;
    }

    if (name === 'start_activity') {
      if (!this.activityService) throw new Error('Mentor activities are unavailable.');
      const voiceFirstPhysical = channel === 'live-physical';
      const activityArgs = voiceFirstPhysical
        ? this.activityService.normalizePhysicalActivityRequest(
          this.activityService.mergePhysicalActivityIntent(conversationId, args)
        )
        : args;
      const activeActivity = this.activityService.get?.(conversationId) || null;
      const requestedType = activityArgs.type || 'practice_game';
      const requestedOpponent = activityArgs.opponentMode || 'mentor';
      const requestedColor = activityArgs.learnerColor || this.gameSettingsService?.get()?.defaults?.humanColor || 'white';
      const sameActiveActivity = activeActivity
        && activeActivity.status === 'active'
        && activeActivity.type === requestedType
        && activeActivity.learnerColor === requestedColor
        && (requestedType !== 'practice_game' || activeActivity.config?.opponentMode === requestedOpponent)
        && (!activityArgs.sourceId || activeActivity.sourceId === activityArgs.sourceId);
      if (sameActiveActivity) {
        if (voiceFirstPhysical) this.activityService.completePhysicalActivityIntent(conversationId);
        onProgress(1, 1);
        return {
          activity: activeActivity,
          board: compactBoardState(this.workspaceState(conversationId)),
          alreadyActive: true
        };
      }
      this.activityService.assertExplicitStartConsent(conversationId, requestId);
      if (voiceFirstPhysical) {
        const learnerColor = requestedColor;
        if (activityArgs.learnerColor && this.gameSettingsService) {
          this.gameSettingsService.updateFromMentor(conversationId, { humanColor: learnerColor });
        }
        const boardPreparation = this.physicalObserver?.ensureVoiceActivityBoard(conversationId, {
          requestId,
          learnerColor,
          activityRequest: {
            type: requestedType,
            opponentMode: requestedOpponent,
            learnerColor,
            sourceId: activityArgs.sourceId || null,
            proposal: null
          }
        });
        if (boardPreparation?.handoffRequired) {
          onProgress(1, 1);
          return boardPreparation;
        }
      }
      const state = this.workspaceState(conversationId);
      const activity = await this.activityService.startActivity(conversationId, {
        type: activityArgs.type,
        learnerColor: activityArgs.learnerColor || this.gameSettingsService?.get()?.defaults?.humanColor || 'white',
        startFrom: activityArgs.startFrom || 'standard',
        sourceId: activityArgs.sourceId,
        opponentMode: activityArgs.opponentMode || 'mentor',
        proposal: activityArgs.proposal,
        expectedRevision: state.revision,
        requestId,
        signal
      });
      if (voiceFirstPhysical) this.activityService.completePhysicalActivityIntent(conversationId);
      onProgress(1, 1);
      return { activity, board: compactBoardState(this.workspaceState(conversationId)) };
    }

    if (name === 'resolve_physical_board_handoff') {
      if (!this.physicalObserver?.resolvePhysicalBoardHandoff) {
        throw new Error('Physical-board handoff is unavailable.');
      }
      const handoff = this.store.getPendingPhysicalHandoff(conversationId);
      if (!handoff) {
        const error = new Error('No current physical-board handoff is waiting for this conversation.');
        error.code = 'physical_handoff_not_found';
        throw error;
      }
      const result = await this.physicalObserver.resolvePhysicalBoardHandoff(conversationId, {
        handoffId: handoff.id,
        action: args.action,
        requestId
      });
      onProgress(1, 1);
      return result;
    }

    if (name === 'pause_activity') {
      const activity = this.activityService?.pause(conversationId, 'mentor_paused');
      onProgress(1, 1);
      return { activity };
    }

    if (name === 'resume_activity') {
      const activity = this.activityService?.resume(conversationId);
      onProgress(1, 1);
      return { activity };
    }

    if (name === 'confirm_physical_setup') {
      if (!this.activityService?.confirmPhysicalSetup) throw new Error('Physical setup confirmation is unavailable.');
      const activity = this.activityService.confirmPhysicalSetup(conversationId, requestId);
      onProgress(1, 1);
      return { activity };
    }

    if (name === 'propose_activity') {
      if (!this.activityService) throw new Error('Mentor activities are unavailable.');
      const result = await this.activityService.proposeActivity(args, { signal });
      onProgress(1, 1);
      return result;
    }

    if (name === 'request_prediction') {
      if (!this.activityService) throw new Error('Mentor activities are unavailable.');
      const activity = this.activityService.requestPrediction(conversationId, {
        requestId,
        prompt: args.prompt
      });
      onProgress(1, 1);
      return { activity };
    }

    if (name === 'request_hint') {
      if (!this.activityService?.requestHint) throw new Error('Hints are unavailable for this activity.');
      const result = this.activityService.requestHint(conversationId);
      onProgress(1, 1);
      return result;
    }

    if (name === 'end_activity') {
      if (!this.activityService) throw new Error('Mentor activities are unavailable.');
      const activity = this.activityService.end(conversationId, 'mentor_ended');
      onProgress(1, 1);
      return { activity };
    }

    if (name === 'resolve_opening_drill') {
      if (!this.activityService) throw new Error('Mentor activities are unavailable.');
      const activity = this.activityService.resolvePhysicalOpening(conversationId, args.action);
      onProgress(1, 1);
      return { activity, board: compactBoardState(this.workspaceState(conversationId)) };
    }

    if (name === 'analyze_position') {
      if (!this.analysisService) throw new Error('Stockfish mentor analysis is unavailable.');
      const result = this.physicalObserver?.isAttached(conversationId)
        ? await this.physicalObserver.analyzePosition(conversationId, {
          mode: args.mode || 'quick',
          signal
        })
        : await this.analysisService.analyzePosition(conversationId, {
        mode: args.mode || 'quick',
        signal
      });
      onProgress(1, 1);
      return result;
    }

    if (name === 'analyze_move') {
      if (!this.analysisService) throw new Error('Stockfish mentor analysis is unavailable.');
      const options = {
        uci: args.uci,
        mode: args.mode || 'quick',
        signal,
        onProgress
      };
      return this.physicalObserver?.isAttached(conversationId)
        ? this.physicalObserver.analyzeMove(conversationId, options)
        : this.analysisService.analyzeMove(conversationId, options);
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
        actionId,
        actor: this.activityService?.get(conversationId) ? 'mentor' : 'unknown',
        activityId: this.activityService?.get(conversationId)?.id || null
      });
      this.boardUpdate(conversationId, result, actionId);
      this.activityService?.mentorMoveCommitted(conversationId, requestId, result);
      onProgress(1, 1);
      return { move: result.state.history.at(-1), board: compactBoardState(result.state) };
    }

    if (name === 'play_physical_move') {
      if (typeof args.uci !== 'string' || !MOVE_PATTERN.test(args.uci)) {
        throw new Error('play_physical_move requires one valid UCI move.');
      }
      const result = await this.activityService.playPhysicalMove(conversationId, requestId, args.uci, {
        signal,
        strategicPlan: args.plan
      });
      onProgress(1, 1);
      return result;
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
      if (this.physicalObserver?.isAttached(conversationId)) {
        const state = this.physicalObserver.getState(conversationId);
        const result = this.physicalObserver.setOrientation(conversationId, {
          orientation: args.orientation,
          expectedRevision: state.revision
        });
        onProgress(1, 1);
        return { orientation: result.state.orientation, board: compactBoardState(result.state) };
      }
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
      if (this.physicalObserver?.isAttached(conversationId)) {
        const state = this.physicalObserver.getState(conversationId);
        const result = this.physicalObserver.setAnnotations(conversationId, {
          highlights: args.highlights,
          arrows: args.arrows,
          expectedRevision: state.revision
        });
        onProgress(1, 1);
        return { annotations: result.state.annotations, board: compactBoardState(result.state) };
      }
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
