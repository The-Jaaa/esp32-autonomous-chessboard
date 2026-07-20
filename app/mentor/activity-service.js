const { Chess } = require('chess.js');
const { randomUUID } = require('crypto');
const { STANDARD_FEN } = require('./store');

const ACTIVITY_TYPES = new Set(['practice_game', 'opening_drill', 'puzzle', 'guided_lesson']);
const ACTIVE_STATUSES = new Set(['active', 'paused']);
const ACTIVITY_TOOL_NAMES = new Set([
  'get_activity_state',
  'propose_activity',
  'start_activity',
  'request_prediction',
  'request_hint',
  'end_activity'
]);
const READ_ONLY_TOOLS = new Set([
  'get_board_state',
  'get_activity_state',
  'analyze_position',
  'analyze_move',
  'annotate_board',
  'set_orientation',
  'request_prediction',
  'request_hint',
  'end_activity'
]);

class MentorActivityError extends Error {
  constructor(message, code = 'activity_error', statusCode = 400, details = {}) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

function colorCode(color) {
  return color === 'white' ? 'w' : 'b';
}

function oppositeColor(color) {
  return color === 'white' ? 'black' : 'white';
}

function moveColor(fen, uci) {
  const game = new Chess(fen);
  const piece = game.get(uci.slice(0, 2));
  return piece?.color || null;
}

function activitySummary(activity, events = []) {
  if (!activity) return null;
  return { ...activity, events };
}

function scoreForSide(score, color) {
  if (!score) return null;
  return color === 'white' ? score.value : -score.value;
}

class MentorActivityService {
  constructor({
    store,
    chessService,
    analysisService,
    emit = () => {},
    emitBoardUpdate = () => {},
    createId = randomUUID,
    logger = console
  }) {
    this.store = store;
    this.chessService = chessService;
    this.analysisService = analysisService;
    this.emit = emit;
    this.emitBoardUpdate = emitBoardUpdate;
    this.createId = createId;
    this.logger = logger;
    this.leaseOwner = `activity-service:${this.createId()}`;
    this.inFlight = new Map();
    this.runners = {
      isLiveActive: () => false,
      text: null,
      live: null
    };
  }

  setRunners(runners = {}) {
    this.runners = { ...this.runners, ...runners };
  }

  get(conversationId) {
    const activity = this.store.getActiveActivity(conversationId);
    return activitySummary(activity, activity ? this.store.listActivityEvents(activity.id) : []);
  }

  reconcile(conversationId, { resumeMentorTurn = false } = {}) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity || activity.status === 'paused') return this.get(conversationId);
    const board = this.chessService.getState(conversationId);
    if (board.gameStatus.isGameOver) {
      const updated = this.store.updateActivity(activity.id, {
        status: 'complete',
        phase: 'game_over',
        boardRevision: board.revision,
        pendingRequestId: null,
        completedAt: Date.now()
      });
      this.record(updated, 'reconciled_game_over', { revision: board.revision });
      return activitySummary(updated, this.store.listActivityEvents(updated.id));
    }
    if (activity.phase === 'awaiting_prediction' && activity.boardRevision === board.revision) {
      return this.get(conversationId);
    }
    const phase = board.turn === colorCode(activity.learnerColor) ? 'learner_turn' : 'mentor_turn';
    const updated = this.store.updateActivity(activity.id, {
      phase,
      boardRevision: board.revision,
      pendingRequestId: null
    });
    if (phase !== activity.phase || board.revision !== activity.boardRevision) {
      this.record(updated, 'reconciled', { phase, revision: board.revision });
    }
    if (resumeMentorTurn && phase === 'mentor_turn') {
      this.scheduleMentorTurn(conversationId, 'subscription_recovery');
    }
    return this.get(conversationId);
  }

  publish(conversationId, activity = this.get(conversationId), event = null) {
    this.emit(conversationId, 'mentor-activity-updated', {
      conversationId,
      activity,
      event
    });
    return activity;
  }

  record(activity, type, payload = {}) {
    const event = this.store.appendActivityEvent(activity.id, activity.conversationId, type, payload);
    const current = this.get(activity.conversationId)
      || activitySummary(this.store.getActivity(activity.id), this.store.listActivityEvents(activity.id));
    this.publish(activity.conversationId, current, event);
    return event;
  }

  assertRevision(conversationId, expectedRevision) {
    const state = this.chessService.getState(conversationId);
    if (!Number.isInteger(expectedRevision) || state.revision !== expectedRevision) {
      throw new MentorActivityError(
        'The board changed before the activity action could be applied.',
        'stale_revision',
        409,
        { state }
      );
    }
    return state;
  }

  startPractice(conversationId, {
    learnerColor = 'white',
    startFrom = 'standard',
    expectedRevision,
    requestId = null,
    title = 'Practice game',
    goal = 'Play a complete coached game.'
  } = {}) {
    if (!['white', 'black'].includes(learnerColor)) {
      throw new MentorActivityError('Learner color must be white or black.', 'invalid_learner_color');
    }
    if (!['standard', 'current'].includes(startFrom)) {
      throw new MentorActivityError('Practice must start from the standard or current position.', 'invalid_start_mode');
    }
    let board = this.assertRevision(conversationId, expectedRevision);
    if (this.store.getActiveActivity(conversationId)) {
      throw new MentorActivityError('End the current activity before starting another.', 'activity_already_active', 409);
    }
    if (startFrom === 'standard' && board.fen !== STANDARD_FEN) {
      const result = this.chessService.setPosition(conversationId, {
        fen: STANDARD_FEN,
        expectedRevision: board.revision,
        actionId: `activity:start:${this.createId()}`,
        actor: 'system'
      });
      this.emitBoardUpdate(conversationId, result);
      board = result.state;
    }
    if (board.gameStatus.isGameOver) {
      throw new MentorActivityError('A practice game cannot start from a finished position.', 'terminal_position');
    }
    const mentorColor = oppositeColor(learnerColor);
    const mentorStarts = board.turn !== colorCode(learnerColor);
    const phase = mentorStarts && requestId ? 'mentor_thinking' : mentorStarts ? 'mentor_turn' : 'learner_turn';
    const activity = this.store.createActivity({
      conversationId,
      type: 'practice_game',
      title: String(title || 'Practice game').slice(0, 80),
      goal: String(goal || '').slice(0, 240),
      learnerColor,
      mentorColor,
      startFen: board.fen,
      startRevision: board.revision,
      boardRevision: board.revision,
      phase,
      config: { startFrom, movePolicy: 'teaching' },
      state: { completedMentorTurns: 0, fallbackMoves: 0 }
    });
    if (mentorStarts && requestId) {
      this.store.updateActivity(activity.id, { pendingRequestId: requestId });
    }
    this.record(activity, 'practice_ready', { phase, fen: board.fen });
    if (phase === 'mentor_turn') this.scheduleMentorTurn(conversationId, 'activity_started');
    return this.get(conversationId);
  }

  pause(conversationId, reason = 'learner_paused') {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity) throw new MentorActivityError('No active activity was found.', 'activity_not_found', 404);
    if (activity.status === 'paused') return this.get(conversationId);
    const updated = this.store.updateActivity(activity.id, {
      status: 'paused',
      phase: 'paused',
      pendingRequestId: null,
      generation: activity.generation + 1,
      state: { ...activity.state, pausedFromPhase: activity.phase }
    });
    this.record(updated, 'paused', { reason, previousPhase: activity.phase });
    return this.get(conversationId);
  }

  resume(conversationId) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity) throw new MentorActivityError('No paused activity was found.', 'activity_not_found', 404);
    if (activity.status !== 'paused') return this.get(conversationId);
    const board = this.chessService.getState(conversationId);
    let phase = activity.state.pausedFromPhase || (
      board.turn === colorCode(activity.learnerColor) ? 'learner_turn' : 'mentor_turn'
    );
    if (phase === 'mentor_thinking') phase = 'mentor_turn';
    const updated = this.store.updateActivity(activity.id, {
      status: 'active',
      phase,
      boardRevision: board.revision,
      state: { ...activity.state, pausedFromPhase: null }
    });
    this.record(updated, 'resumed', { phase });
    if (phase === 'mentor_turn') this.scheduleMentorTurn(conversationId, 'activity_resumed');
    return this.get(conversationId);
  }

  end(conversationId, reason = 'learner_ended') {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity) return null;
    const updated = this.store.updateActivity(activity.id, {
      status: reason === 'game_over' ? 'complete' : 'cancelled',
      phase: reason === 'game_over' ? 'game_over' : 'complete',
      pendingRequestId: null,
      generation: activity.generation + 1,
      completedAt: Date.now()
    });
    this.record(updated, reason === 'game_over' ? 'game_over' : 'ended', { reason });
    return activitySummary(updated, this.store.listActivityEvents(updated.id));
  }

  validateLearnerMove(conversationId, { uci, expectedRevision }) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity) return null;
    if (activity.status !== 'active' || activity.phase !== 'learner_turn') {
      throw new MentorActivityError('Wait for the mentor turn to finish before moving.', 'activity_not_learner_turn', 409, {
        activity: this.get(conversationId)
      });
    }
    const board = this.assertRevision(conversationId, expectedRevision);
    if (board.turn !== colorCode(activity.learnerColor)
      || moveColor(board.fen, uci) !== colorCode(activity.learnerColor)) {
      throw new MentorActivityError(`You are playing ${activity.learnerColor}.`, 'activity_wrong_color', 409);
    }
    return activity;
  }

  assertBoardSetupAllowed(conversationId) {
    const activity = this.store.getActiveActivity(conversationId);
    if (activity) {
      throw new MentorActivityError(
        'End the current activity before loading or resetting the board.',
        'activity_board_setup_blocked',
        409,
        { activity: this.get(conversationId) }
      );
    }
  }

  learnerMoveCommitted(conversationId, result) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity || activity.status !== 'active' || result.duplicate) return this.get(conversationId);
    const move = result.state.history.at(-1);
    if (result.state.gameStatus.isGameOver) {
      const updated = this.store.updateActivity(activity.id, {
        status: 'complete',
        phase: 'game_over',
        boardRevision: result.state.revision,
        attempts: activity.attempts + 1,
        pendingRequestId: null,
        completedAt: Date.now()
      });
      this.record(updated, 'game_over', { move, gameStatus: result.state.gameStatus });
      return activitySummary(updated, this.store.listActivityEvents(updated.id));
    }
    const updated = this.store.updateActivity(activity.id, {
      phase: 'mentor_turn',
      boardRevision: result.state.revision,
      attempts: activity.attempts + 1,
      pendingRequestId: null
    });
    this.record(updated, 'learner_move', { move, revision: result.state.revision });
    this.scheduleMentorTurn(conversationId, 'learner_move');
    return this.get(conversationId);
  }

  prepareConversationTurn(conversationId, requestId) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity || activity.status !== 'active' || activity.phase !== 'awaiting_prediction') return null;
    const updated = this.store.updateActivity(activity.id, {
      phase: 'mentor_thinking',
      pendingRequestId: requestId,
      predictionPrompt: null,
      generation: activity.generation + 1
    });
    this.record(updated, 'prediction_answered', { requestId });
    return updated;
  }

  requestPrediction(conversationId, { requestId, prompt }) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity || activity.status !== 'active' || activity.phase !== 'mentor_thinking'
      || activity.pendingRequestId !== requestId) {
      throw new MentorActivityError('Prediction can only be requested during the current mentor turn.', 'prediction_not_available', 409);
    }
    const updated = this.store.updateActivity(activity.id, {
      phase: 'awaiting_prediction',
      predictionPrompt: String(prompt || 'What move do you expect?').slice(0, 240),
      pendingRequestId: null
    });
    this.record(updated, 'prediction_requested', { prompt: updated.predictionPrompt });
    return this.get(conversationId);
  }

  validateTool(conversationId, requestId, name, args = {}) {
    if (ACTIVITY_TOOL_NAMES.has(name)) return null;
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity || !ACTIVE_STATUSES.has(activity.status)) return null;
    if (READ_ONLY_TOOLS.has(name) && name !== 'request_prediction') return activity;
    if (name !== 'play_move') {
      throw new MentorActivityError(
        `${name} is unavailable while ${activity.title} is active. End the activity first.`,
        'activity_tool_blocked',
        409
      );
    }
    if (activity.status !== 'active' || activity.phase !== 'mentor_thinking'
      || activity.pendingRequestId !== requestId) {
      throw new MentorActivityError('The mentor cannot move outside its assigned turn.', 'activity_not_mentor_turn', 409);
    }
    const board = this.chessService.getState(conversationId);
    if (board.turn !== colorCode(activity.mentorColor)
      || moveColor(board.fen, args.uci || '') !== colorCode(activity.mentorColor)) {
      throw new MentorActivityError(`The mentor controls ${activity.mentorColor}.`, 'activity_wrong_color', 409);
    }
    if (board.legalMoves.length > 1) this.assertTeachingCandidate(conversationId, requestId, activity, args.uci);
    return activity;
  }

  assertTeachingCandidate(conversationId, requestId, activity, uci) {
    const analysisCall = this.store.listToolCallsForRequest(conversationId, requestId)
      .filter((call) => call.name === 'analyze_position' && call.status === 'complete'
        && call.result?.analyzedRevision === activity.boardRevision)
      .at(-1);
    if (!analysisCall) {
      throw new MentorActivityError('Analyze the current position before choosing the mentor move.', 'practice_analysis_required', 409);
    }
    const lines = analysisCall.result?.lines || [];
    const candidate = lines.find((line) => line.move === uci);
    const best = lines[0];
    if (!candidate || !best) {
      throw new MentorActivityError('Choose one of Stockfish\'s verified candidate moves.', 'practice_move_not_grounded', 409);
    }
    if (best.score?.type === 'mate' && candidate.move !== best.move) {
      throw new MentorActivityError('A forced mate is available; preserve the strongest mating line.', 'practice_mate_required', 409);
    }
    if (best.score?.type === 'cp' && candidate.score?.type === 'cp') {
      const bestValue = scoreForSide(best.score, activity.mentorColor);
      const candidateValue = scoreForSide(candidate.score, activity.mentorColor);
      if (bestValue - candidateValue > 50) {
        throw new MentorActivityError('That move is too far below the verified teaching candidates.', 'practice_move_too_weak', 409);
      }
    }
  }

  mentorMoveCommitted(conversationId, requestId, result, { fallback = false } = {}) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity || activity.status !== 'active') return null;
    if (!fallback && activity.pendingRequestId !== requestId) return null;
    const move = result.state.history.at(-1);
    const nextState = {
      ...activity.state,
      completedMentorTurns: Number(activity.state.completedMentorTurns || 0) + 1,
      fallbackMoves: Number(activity.state.fallbackMoves || 0) + (fallback ? 1 : 0)
    };
    if (result.state.gameStatus.isGameOver) {
      const updated = this.store.updateActivity(activity.id, {
        status: 'complete',
        phase: 'game_over',
        boardRevision: result.state.revision,
        pendingRequestId: null,
        state: nextState,
        completedAt: Date.now()
      });
      this.record(updated, fallback ? 'engine_fallback_move' : 'mentor_move', { move, gameStatus: result.state.gameStatus });
      return this.get(conversationId);
    }
    const updated = this.store.updateActivity(activity.id, {
      phase: 'learner_turn',
      boardRevision: result.state.revision,
      pendingRequestId: null,
      state: nextState
    });
    this.record(updated, fallback ? 'engine_fallback_move' : 'mentor_move', { move, revision: result.state.revision });
    return this.get(conversationId);
  }

  scheduleMentorTurn(conversationId, reason) {
    if (this.inFlight.has(conversationId)) return this.inFlight.get(conversationId);
    const promise = this.executeMentorTurn(conversationId, reason)
      .catch((error) => {
        this.logger.error?.('[MENTOR_ACTIVITY_TURN_FAILED]', JSON.stringify({ conversationId, error: error.message }));
        const activity = this.store.getActiveActivity(conversationId);
        if (activity?.status === 'active' && activity.phase === 'mentor_thinking') {
          this.pause(conversationId, 'mentor_turn_failed');
        }
      })
      .finally(() => this.inFlight.delete(conversationId));
    this.inFlight.set(conversationId, promise);
    return promise;
  }

  activityPrompt(activity, board, { corrective = false } = {}) {
    const prefix = corrective
      ? 'Your previous response analyzed the position but did not make the required opponent move.'
      : `The learner committed ${board.history.at(-1)?.san || 'a move'} and it is now your ${activity.mentorColor} turn.`;
    return [
      '[MENTOR_ACTIVITY_TURN]',
      prefix,
      `Activity: ${activity.title}. Learner: ${activity.learnerColor}. Mentor: ${activity.mentorColor}.`,
      `Authoritative revision: ${board.revision}. FEN: ${board.fen}`,
      'You must use analyze_position in quick mode, then call play_move exactly once with a verified teaching candidate.',
      'You may instead call request_prediction when a prediction exercise is specifically useful.',
      'Do not finish with analysis alone. Explain the completed action naturally after its tool result.'
    ].join('\n');
  }

  async runGeneratedTurn(conversationId, activity, board, requestId, corrective) {
    const displayText = corrective
      ? 'Mentor is completing its move.'
      : `You played ${board.history.at(-1)?.san || 'a move'}.`;
    const prompt = this.activityPrompt(activity, board, { corrective });
    const useLive = this.runners.isLiveActive(conversationId) && this.runners.live;
    const pair = useLive
      ? this.runners.live({ conversationId, requestId, displayText, prompt })
      : this.runners.text?.({ conversationId, requestId, displayText, prompt });
    if (!pair) throw new MentorActivityError('No mentor response runner is available.', 'activity_runner_unavailable', 503);
    return pair.completion ? pair.completion : pair;
  }

  async executeMentorTurn(conversationId, reason) {
    let activity = this.store.getActiveActivity(conversationId);
    if (!activity || activity.status !== 'active' || !['mentor_turn', 'mentor_thinking'].includes(activity.phase)) return;
    const leased = this.store.claimActivityLease(activity.id, this.leaseOwner);
    if (!leased) return;
    activity = leased;
    try {
      let board = this.chessService.getState(conversationId);
      if (board.gameStatus.isGameOver) {
        this.end(conversationId, 'game_over');
        return;
      }
      if (board.turn !== colorCode(activity.mentorColor)) {
        throw new MentorActivityError('The activity turn does not match the authoritative board.', 'activity_turn_mismatch', 409);
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        activity = this.store.getActiveActivity(conversationId);
        if (!activity || activity.status !== 'active') return;
        board = this.chessService.getState(conversationId);
        const requestId = `activity:${activity.id}:${activity.generation + 1}:${board.revision}:${attempt}`;
        activity = this.store.updateActivity(activity.id, {
          phase: 'mentor_thinking',
          boardRevision: board.revision,
          pendingRequestId: requestId,
          generation: activity.generation + 1
        });
        this.record(activity, attempt === 0 ? 'mentor_turn_started' : 'mentor_turn_corrective', {
          requestId,
          reason,
          revision: board.revision
        });
        const completion = await this.runGeneratedTurn(conversationId, activity, board, requestId, attempt === 1);
        const current = this.store.getActiveActivity(conversationId);
        if (!current || current.status !== 'active'
          || ['learner_turn', 'awaiting_prediction', 'game_over'].includes(current.phase)) return;
        if (completion?.status === 'cancelled') {
          this.pause(conversationId, 'response_stopped');
          return;
        }
      }

      await this.executeFallback(conversationId);
    } finally {
      this.store.releaseActivityLease(activity.id, this.leaseOwner);
    }
  }

  async executeFallback(conversationId) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity || activity.status !== 'active' || activity.phase !== 'mentor_thinking') return;
    const board = this.chessService.getState(conversationId);
    const analysis = await this.analysisService.analyzePosition(conversationId, { mode: 'quick' });
    const uci = analysis.bestMove?.uci;
    if (!uci) throw new MentorActivityError('Stockfish returned no fallback move.', 'activity_fallback_unavailable', 503);
    const actionId = `activity:fallback:${activity.id}:${board.revision}`;
    const result = this.chessService.move(conversationId, {
      uci,
      expectedRevision: board.revision,
      actionId,
      actor: 'mentor',
      activityId: activity.id
    });
    this.emitBoardUpdate(conversationId, result);
    this.mentorMoveCommitted(conversationId, activity.pendingRequestId, result, { fallback: true });
  }
}

module.exports = {
  ACTIVITY_TOOL_NAMES,
  ACTIVITY_TYPES,
  MentorActivityError,
  MentorActivityService,
  activitySummary,
  colorCode,
  oppositeColor
};
