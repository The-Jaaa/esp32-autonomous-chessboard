const { Chess } = require('chess.js');
const { randomUUID } = require('crypto');
const { STANDARD_FEN } = require('./store');
const {
  getCatalogItem,
  listCatalog,
  recommendCatalog,
  validateCatalogItem
} = require('./curriculum');

const ACTIVITY_TYPES = new Set(['practice_game', 'opening_drill', 'puzzle', 'guided_lesson']);
const ACTIVE_STATUSES = new Set(['active', 'paused']);
const ACTIVITY_TOOL_NAMES = new Set([
  'get_activity_state',
  'propose_activity',
  'start_activity',
  'request_prediction',
  'request_hint',
  'end_activity',
  'resolve_opening_drill',
  'pause_activity',
  'resume_activity',
  'confirm_physical_setup'
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
    engineService = null,
    emit = () => {},
    emitGlobal = () => {},
    emitBoardUpdate = () => {},
    createId = randomUUID,
    logger = console
  }) {
    this.store = store;
    this.chessService = chessService;
    this.analysisService = analysisService;
    this.engineService = engineService;
    this.emit = emit;
    this.emitGlobal = emitGlobal;
    this.emitBoardUpdate = emitBoardUpdate;
    this.createId = createId;
    this.logger = logger;
    this.leaseOwner = `activity-service:${this.createId()}`;
    this.inFlight = new Map();
    this.physicalInFlight = new Map();
    this.runners = {
      isLiveActive: () => false,
      text: null,
      live: null
    };
    this.physicalCoordinator = null;
  }

  setRunners(runners = {}) {
    this.runners = { ...this.runners, ...runners };
  }

  setPhysicalCoordinator(coordinator) {
    this.physicalCoordinator = coordinator;
  }

  isPhysicalActivity(activity) {
    return activity?.config?.boardSource === 'physical';
  }

  get(conversationId) {
    const activity = this.store.getActiveActivity(conversationId);
    return activitySummary(activity, activity ? this.store.listActivityEvents(activity.id) : []);
  }

  getProgressSummary() {
    const profile = this.store.getLearnerProfile();
    const topics = this.store.listTopicProgress();
    return {
      profile,
      topics,
      recommendations: recommendCatalog(profile, topics)
    };
  }

  updateProfile(patch) {
    let profile;
    try {
      profile = this.store.updateLearnerProfile(patch || {});
    } catch (error) {
      throw new MentorActivityError(error.message, 'invalid_learner_profile');
    }
    const summary = this.getProgressSummary();
    this.emitGlobal('mentor-progress-updated', summary);
    return { ...summary, profile };
  }

  catalog(type = null) {
    return listCatalog(type);
  }

  assertExplicitStartConsent(conversationId, requestId) {
    const userMessage = this.store.getRequestMessages(conversationId, requestId)
      .find((message) => message.role === 'user');
    const text = String(userMessage?.content || '').trim();
    const explicit = /^(yes\b|yeah\b|yep\b|sure\b|ok(?:ay)?\b|sounds good\b|do it\b|go ahead\b|start\b|begin\b|let'?s\b|please start\b|i(?:'d| would) like to\b|i want to\b|play a\b|give me a\b|teach me\b|help me practice\b)/i.test(text);
    if (!explicit) {
      throw new MentorActivityError(
        'Ask for the learner’s explicit agreement before starting an activity.',
        'activity_confirmation_required',
        409
      );
    }
    return true;
  }

  reconcile(conversationId, { resumeMentorTurn = false } = {}) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity || activity.status === 'paused') return this.get(conversationId);
    if (this.isPhysicalActivity(activity)) {
      this.physicalCoordinator?.syncPhysicalActivity?.(activity);
      return this.get(conversationId);
    }
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

  startCatalogActivity(conversationId, {
    sourceId,
    learnerColor = 'white',
    expectedRevision,
    requestId = null,
    customItem = null
  } = {}) {
    const item = customItem || getCatalogItem(sourceId);
    if (!item) throw new MentorActivityError('Catalog activity not found.', 'activity_source_not_found', 404);
    if (item.fixedLearnerColor) learnerColor = item.fixedLearnerColor;
    if (!['white', 'black'].includes(learnerColor)) {
      throw new MentorActivityError('Learner color must be white or black.', 'invalid_learner_color');
    }
    let board = this.assertRevision(conversationId, expectedRevision);
    if (this.store.getActiveActivity(conversationId)) {
      throw new MentorActivityError('End the current activity before starting another.', 'activity_already_active', 409);
    }
    if (board.fen !== item.initialFen) {
      const result = this.chessService.setPosition(conversationId, {
        fen: item.initialFen,
        expectedRevision: board.revision,
        actionId: `activity:setup:${this.createId()}`,
        actor: 'system'
      });
      this.emitBoardUpdate(conversationId, result);
      board = result.state;
    }
    const mentorColor = oppositeColor(learnerColor);
    const firstColor = moveColor(board.fen, item.line[0]) === colorCode(learnerColor)
      ? 'learner'
      : 'mentor';
    const phase = firstColor === 'learner'
      ? 'learner_turn'
      : requestId ? 'mentor_thinking' : 'mentor_turn';
    let activity = this.store.createActivity({
      conversationId,
      type: item.type,
      title: item.title,
      goal: item.goal,
      learnerColor,
      mentorColor,
      sourceId: item.id,
      startFen: board.fen,
      startRevision: board.revision,
      boardRevision: board.revision,
      phase,
      totalSteps: item.line.length,
      config: {
        line: item.line,
        hints: item.hints || [],
        topic: item.topic,
        checkpoints: item.checkpoints || [],
        curated: !customItem,
        generated: Boolean(customItem)
      },
      state: { completedMentorTurns: 0, fallbackMoves: 0, lastHint: null }
    });
    if (firstColor === 'mentor' && requestId) {
      activity = this.store.updateActivity(activity.id, { pendingRequestId: requestId });
    }
    this.record(activity, 'catalog_ready', { sourceId: item.id, phase, fen: board.fen });
    if (phase === 'mentor_turn') this.scheduleMentorTurn(conversationId, 'activity_started');
    return this.get(conversationId);
  }

  async startActivity(conversationId, options = {}) {
    if (this.physicalCoordinator?.isAttached?.(conversationId)) {
      if (options.type === 'practice_game') return this.startPhysicalPractice(conversationId, options);
      return this.startPhysicalOpening(conversationId, options);
    }
    if (options.type === 'practice_game') return this.startPractice(conversationId, options);
    if (options.proposal) {
      const validation = await this.proposeActivity(options.proposal, { signal: options.signal });
      if (validation.accepted) {
        return this.startCatalogActivity(conversationId, {
          ...options,
          sourceId: validation.proposal.id,
          customItem: validation.proposal
        });
      }
      return this.startCatalogActivity(conversationId, {
        ...options,
        sourceId: validation.fallback.id
      });
    }
    return this.startCatalogActivity(conversationId, options);
  }

  startPhysicalPractice(conversationId, {
    learnerColor,
    opponentMode = 'mentor',
    expectedRevision,
    requestId = null
  } = {}) {
    if (!['mentor', 'stockfish'].includes(opponentMode)) {
      throw new MentorActivityError('Opponent mode must be mentor or stockfish.', 'invalid_opponent_mode');
    }
    if (this.store.getActiveActivity(conversationId)) {
      throw new MentorActivityError('End the current activity before starting another.', 'activity_already_active', 409);
    }
    const physical = this.physicalCoordinator.requirePracticeStartState(conversationId, expectedRevision);
    const selectedColor = learnerColor || physical.physical.humanColor;
    if (selectedColor !== physical.physical.humanColor) {
      throw new MentorActivityError(
        `This physical session is configured for Human ${physical.physical.humanColor}. Start a new game to change sides.`,
        'physical_activity_color_mismatch',
        409
      );
    }
    const mentorColor = oppositeColor(selectedColor);
    const mentorStarts = physical.turn !== colorCode(selectedColor);
    const activity = this.store.createActivity({
      conversationId,
      type: 'practice_game',
      title: opponentMode === 'mentor' ? 'Guided game with Gemini' : 'Guided game with Stockfish',
      goal: opponentMode === 'mentor'
        ? 'Play a complete physical game while Gemini follows and explains a coherent plan.'
        : 'Play a complete physical game against Stockfish with direct coaching after each turn.',
      learnerColor: selectedColor,
      mentorColor,
      startFen: physical.fen,
      startRevision: physical.revision,
      boardRevision: physical.revision,
      phase: mentorStarts ? 'mentor_turn' : 'learner_turn',
      config: {
        boardSource: 'physical',
        opponentMode,
        movePolicy: opponentMode === 'mentor' ? 'teaching' : 'stockfish',
        serverInstanceId: physical.physical.serverInstanceId,
        sessionGeneration: physical.physical.sessionGeneration
      },
      state: {
        completedMentorTurns: 0,
        fallbackMoves: 0,
        lastPhysicalMoveId: null,
        strategicPlan: null,
        narrationPending: false,
        pauseReason: null,
        requestId
      }
    });
    this.record(activity, 'physical_practice_ready', {
      opponentMode,
      learnerColor: selectedColor,
      phase: activity.phase,
      fen: physical.fen
    });
    this.physicalCoordinator.syncPhysicalActivity(activity);
    this.physicalCoordinator?.announcePhysicalPractice?.(activity);
    if (mentorStarts && opponentMode === 'mentor') {
      this.schedulePhysicalMentorTurn(conversationId, 'activity_started');
    } else if (mentorStarts && opponentMode === 'stockfish') {
      this.physicalCoordinator?.startStockfishTurn?.(conversationId, activity);
    }
    return this.get(conversationId);
  }

  startPhysicalOpening(conversationId, {
    type,
    sourceId,
    expectedRevision,
    learnerColor = 'white',
    requestId = null,
    proposal = null
  } = {}) {
    if (type !== 'opening_drill' || proposal) {
      throw new MentorActivityError(
        'The physical board currently supports reviewed opening drills only.',
        'physical_activity_unsupported',
        409
      );
    }
    const item = getCatalogItem(sourceId);
    if (!item || item.type !== 'opening_drill' || !item.supportsPhysical) {
      throw new MentorActivityError('Reviewed physical opening drill not found.', 'activity_source_not_found', 404);
    }
    if (learnerColor !== 'white') {
      throw new MentorActivityError('Physical opening drills currently use Human White.', 'physical_activity_white_only', 409);
    }
    if (this.store.getActiveActivity(conversationId)) {
      throw new MentorActivityError('End the current activity before starting another.', 'activity_already_active', 409);
    }
    const physical = this.physicalCoordinator.requireOpeningStartState(conversationId, expectedRevision);
    const activity = this.store.createActivity({
      conversationId,
      type: 'opening_drill',
      title: item.title,
      goal: item.goal,
      learnerColor: 'white',
      mentorColor: 'black',
      sourceId: item.id,
      startFen: item.initialFen,
      startRevision: physical.revision,
      boardRevision: physical.revision,
      phase: 'learner_turn',
      totalSteps: item.line.length,
      config: {
        line: item.line,
        hints: item.hints || [],
        topic: item.topic,
        family: item.family || null,
        curated: true,
        boardSource: 'physical',
        serverInstanceId: physical.physical.serverInstanceId,
        sessionGeneration: physical.physical.sessionGeneration
      },
      state: {
        completedMentorTurns: 0,
        fallbackMoves: 0,
        lastHint: null,
        lastPhysicalMoveId: null,
        pauseReason: null,
        iteration: 1,
        requestId
      }
    });
    this.record(activity, 'physical_opening_ready', {
      sourceId: item.id,
      expectedUci: item.line[0],
      serverInstanceId: physical.physical.serverInstanceId,
      sessionGeneration: physical.physical.sessionGeneration
    });
    this.physicalCoordinator.syncPhysicalActivity(activity);
    this.physicalCoordinator?.announcePhysicalOpening?.(activity);
    return this.get(conversationId);
  }

  getPhysicalPolicy(conversationId) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!this.isPhysicalActivity(activity)) return null;
    return {
      activityId: activity.id,
      generation: activity.generation,
      sourceId: activity.sourceId,
      title: activity.title,
      goal: activity.goal,
      status: activity.status,
      phase: activity.phase,
      stepIndex: activity.stepIndex,
      totalSteps: activity.totalSteps,
      expectedUci: activity.config.line?.[activity.stepIndex] || null,
      type: activity.type,
      opponentMode: activity.config.opponentMode || null,
      learnerColor: activity.learnerColor,
      mentorColor: activity.mentorColor,
      expectedActor: activity.type === 'practice_game'
        ? (activity.phase === 'learner_turn' ? 'learner' : 'mentor')
        : activity.stepIndex % 2 === 0 ? 'learner' : 'mentor',
      hints: activity.config.hints || [],
      attempts: activity.attempts,
      hintLevel: activity.hints,
      state: activity.state,
      serverInstanceId: activity.config.serverInstanceId,
      sessionGeneration: activity.config.sessionGeneration
    };
  }

  validatePhysicalLearnerMove(conversationId, uci) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!this.isPhysicalActivity(activity)) return null;
    if (activity.status !== 'active' || activity.phase !== 'learner_turn') {
      throw new MentorActivityError('The activity is not waiting for a learner move.', 'activity_not_learner_turn', 409);
    }
    if (activity.type === 'practice_game') return activity;
    const expectedUci = activity.config.line?.[activity.stepIndex];
    if (uci !== expectedUci) {
      const updated = this.store.updateActivity(activity.id, { attempts: activity.attempts + 1 });
      this.record(updated, 'physical_incorrect_move', { attemptedUci: uci, expectedUci });
      this.physicalCoordinator?.syncPhysicalActivity?.(updated);
      throw new MentorActivityError(
        `Return the piece to its original square. This drill expects ${expectedUci}.`,
        'activity_incorrect_move',
        422,
        { activity: this.get(conversationId), attemptedUci: uci, expectedUci }
      );
    }
    return activity;
  }

  notePhysicalIncorrectAttempt(conversationId, details = {}) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!this.isPhysicalActivity(activity)) return null;
    const updated = this.store.updateActivity(activity.id, { attempts: activity.attempts + 1 });
    this.record(updated, 'physical_incorrect_attempt', details);
    return this.get(conversationId);
  }

  physicalMoveCommitted(conversationId, {
    side,
    uci,
    san,
    revision,
    moveId,
    gameStatus = null
  } = {}) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!this.isPhysicalActivity(activity) || !['active', 'paused'].includes(activity.status)) return null;
    if (moveId && activity.state.lastPhysicalMoveId === moveId) return this.get(conversationId);
    const expectedActor = activity.type === 'practice_game'
      ? (activity.phase === 'learner_turn' ? 'learner' : 'mentor')
      : activity.stepIndex % 2 === 0 ? 'learner' : 'mentor';
    const actor = side === 'human' ? 'learner' : 'mentor';
    const expectedUci = activity.config.line?.[activity.stepIndex];
    if (activity.status !== 'active' || actor !== expectedActor
      || (activity.type !== 'practice_game' && uci !== expectedUci)) {
      throw new MentorActivityError('The verified physical move does not match the active activity turn.', 'physical_activity_move_mismatch', 409);
    }
    if (activity.type === 'practice_game') {
      return this.physicalPracticeMoveCommitted(activity, {
        actor, side, uci, san, revision, moveId, gameStatus
      });
    }
    const nextStep = activity.stepIndex + 1;
    const nextState = {
      ...activity.state,
      lastPhysicalMoveId: moveId || `${side}:${uci}:${revision}`,
      completedMentorTurns: Number(activity.state.completedMentorTurns || 0) + (actor === 'mentor' ? 1 : 0),
      routeBlocked: null,
      pauseReason: null
    };
    const physicalGameOver = Boolean(gameStatus?.isGameOver || gameStatus?.checkmate || gameStatus?.draw);
    if (nextStep >= activity.totalSteps || physicalGameOver) {
      const updated = this.store.updateActivity(activity.id, {
        status: 'paused',
        phase: 'paused',
        stepIndex: nextStep,
        boardRevision: Number.isInteger(revision) ? revision : activity.boardRevision,
        pendingRequestId: null,
        state: { ...nextState, pauseReason: 'line_complete' }
      });
      this.record(updated, physicalGameOver ? 'physical_game_over' : 'physical_line_complete', {
        move: { uci, san, side },
        gameStatus
      });
      const progress = this.store.awardActivityProgress(
        activity.id,
        [activity.config.topic].filter(Boolean),
        activity.attempts > 0 ? 3 : activity.hints > 0 ? 6 : 10
      );
      if (progress.awarded) this.emitGlobal('mentor-progress-updated', this.getProgressSummary());
      this.physicalCoordinator?.syncPhysicalActivity?.(updated);
      return this.get(conversationId);
    }
    const nextActor = nextStep % 2 === 0 ? 'learner' : 'mentor';
    const updated = this.store.updateActivity(activity.id, {
      stepIndex: nextStep,
      phase: nextActor === 'learner' ? 'learner_turn' : 'mentor_turn',
      boardRevision: Number.isInteger(revision) ? revision : activity.boardRevision,
      pendingRequestId: null,
      state: nextState
    });
    this.record(updated, actor === 'learner' ? 'physical_learner_move' : 'physical_mentor_move', {
      move: { uci, san, side },
      nextStep,
      nextActor,
      nextUci: activity.config.line[nextStep]
    });
    this.physicalCoordinator?.syncPhysicalActivity?.(updated);
    return this.get(conversationId);
  }

  physicalPracticeMoveCommitted(activity, { actor, side, uci, san, revision, moveId, gameStatus }) {
    const nextState = {
      ...activity.state,
      lastPhysicalMoveId: moveId || `${side}:${uci}:${revision}`,
      completedMentorTurns: Number(activity.state.completedMentorTurns || 0) + (actor === 'mentor' ? 1 : 0),
      pauseReason: null,
      narrationPending: actor === 'mentor'
    };
    const physicalGameOver = Boolean(gameStatus?.isGameOver || gameStatus?.checkmate || gameStatus?.draw);
    const updated = this.store.updateActivity(activity.id, {
      status: physicalGameOver ? 'complete' : 'active',
      phase: physicalGameOver ? 'game_over' : actor === 'learner' ? 'mentor_turn' : 'learner_turn',
      boardRevision: Number.isInteger(revision) ? revision : activity.boardRevision,
      pendingRequestId: null,
      state: nextState,
      ...(physicalGameOver ? { completedAt: Date.now() } : {})
    });
    this.record(updated, physicalGameOver
      ? 'physical_game_over'
      : actor === 'learner' ? 'physical_learner_move' : 'physical_mentor_move', {
      move: { uci, san, side },
      gameStatus,
      opponentMode: activity.config.opponentMode
    });
    this.physicalCoordinator?.syncPhysicalActivity?.(updated);
    if (!physicalGameOver && actor === 'learner' && activity.config.opponentMode === 'mentor') {
      this.schedulePhysicalMentorTurn(activity.conversationId, 'learner_move');
    }
    return this.get(activity.conversationId);
  }

  markPhysicalRouteBlocked(conversationId, details = {}) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!this.isPhysicalActivity(activity)) return null;
    const updated = this.store.updateActivity(activity.id, {
      status: 'paused',
      phase: 'paused',
      state: { ...activity.state, pauseReason: 'route_blocked', routeBlocked: details }
    });
    this.record(updated, 'physical_route_blocked', details);
    this.physicalCoordinator?.syncPhysicalActivity?.(updated);
    return this.get(conversationId);
  }

  preparePhysicalRepeat(conversationId) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!this.isPhysicalActivity(activity) || activity.state.pauseReason !== 'line_complete') {
      throw new MentorActivityError('The completed opening line is not ready to repeat.', 'physical_repeat_unavailable', 409);
    }
    const updated = this.store.updateActivity(activity.id, {
      status: 'paused',
      phase: 'paused',
      generation: activity.generation + 1,
      state: { ...activity.state, pauseReason: 'repeat_restore', repeatRestorePending: true }
    });
    this.record(updated, 'physical_repeat_restore_started', {});
    this.physicalCoordinator?.syncPhysicalActivity?.(updated);
    return this.get(conversationId);
  }

  completePhysicalRepeat(conversationId, revision) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!this.isPhysicalActivity(activity) || activity.state.pauseReason !== 'repeat_restore') return null;
    const updated = this.store.updateActivity(activity.id, {
      status: 'active',
      phase: 'learner_turn',
      stepIndex: 0,
      attempts: 0,
      hints: 0,
      boardRevision: Number.isInteger(revision) ? revision : activity.boardRevision,
      state: {
        completedMentorTurns: 0,
        fallbackMoves: 0,
        lastHint: null,
        lastPhysicalMoveId: null,
        pauseReason: null,
        repeatRestorePending: false,
        iteration: Number(activity.state.iteration || 1) + 1
      }
    });
    this.record(updated, 'physical_repeat_ready', { expectedUci: activity.config.line[0] });
    this.physicalCoordinator?.syncPhysicalActivity?.(updated);
    return this.get(conversationId);
  }

  resolvePhysicalOpening(conversationId, action) {
    const activity = this.store.getActiveActivity(conversationId);
    if (action === 'repeat') return this.preparePhysicalRepeat(conversationId);
    if (!this.isPhysicalActivity(activity)) {
      if (action === 'resume') return this.physicalCoordinator?.resumeNormalPlay?.(conversationId) || null;
      throw new MentorActivityError('No physical opening drill is active.', 'activity_not_found', 404);
    }
    if (action === 'retry') {
      const result = this.physicalCoordinator.retryPhysicalOpening(conversationId, activity);
      const updated = this.store.updateActivity(activity.id, {
        status: 'active',
        phase: 'mentor_turn',
        state: { ...activity.state, pauseReason: null, routeBlocked: null }
      });
      this.record(updated, 'physical_route_retry', result || {});
      return this.get(conversationId);
    }
    if (!['continue', 'finish'].includes(action) || activity.state.pauseReason !== 'line_complete') {
      throw new MentorActivityError('That opening-drill action is not available now.', 'physical_opening_action_unavailable', 409);
    }
    const updated = this.store.updateActivity(activity.id, {
      status: 'complete',
      phase: 'complete',
      pendingRequestId: null,
      generation: activity.generation + 1,
      completedAt: Date.now(),
      state: { ...activity.state, pauseReason: null, resolution: action }
    });
    this.record(updated, action === 'continue' ? 'physical_continue_game' : 'physical_lesson_finished', {});
    this.physicalCoordinator.resolvePhysicalOpening(conversationId, action, updated);
    return activitySummary(updated, this.store.listActivityEvents(updated.id));
  }

  cancelStalePhysicalActivity(conversationId, reason = 'physical_session_stale') {
    const activity = this.store.getActiveActivity(conversationId);
    if (!this.isPhysicalActivity(activity)) return null;
    const updated = this.store.updateActivity(activity.id, {
      status: 'cancelled',
      phase: 'complete',
      pendingRequestId: null,
      generation: activity.generation + 1,
      completedAt: Date.now(),
      state: { ...activity.state, pauseReason: reason }
    });
    this.record(updated, 'physical_activity_stale', { reason });
    return updated;
  }

  async proposeActivity(proposal = {}, { signal } = {}) {
    try {
      const item = {
        id: `generated-${this.createId()}`,
        type: proposal.type,
        title: String(proposal.title || 'Custom activity').slice(0, 80),
        goal: String(proposal.goal || '').slice(0, 240),
        topic: String(proposal.topic || 'custom').slice(0, 48),
        skillBands: ['Beginner', 'Intermediate', 'Advanced'],
        fixedLearnerColor: proposal.learnerColor || null,
        initialFen: proposal.initialFen,
        line: proposal.line,
        hints: Array.isArray(proposal.hints) ? proposal.hints.slice(0, 3).map((hint) => String(hint).slice(0, 160)) : []
      };
      if (!['opening_drill', 'puzzle', 'guided_lesson'].includes(item.type)) {
        throw new Error('Generated activities must be an opening drill, puzzle, or guided lesson.');
      }
      validateCatalogItem(item);
      if (!this.engineService && ['opening_drill', 'puzzle'].includes(item.type)) {
        throw new Error('Stockfish validation is unavailable.');
      }
      if (item.type === 'puzzle') await this.validateGeneratedPuzzle(item, signal);
      if (item.type === 'opening_drill') await this.validateGeneratedOpening(item, signal);
      return { accepted: true, proposal: item, fallback: null };
    } catch (error) {
      const fallback = recommendCatalog(
        this.store.getLearnerProfile(),
        this.store.listTopicProgress(),
        ['opening_drill', 'puzzle', 'guided_lesson'].includes(proposal.type) ? proposal.type : null
      )[0];
      return { accepted: false, error: error.message, proposal: null, fallback };
    }
  }

  async validateGeneratedPuzzle(item, signal) {
    const game = new Chess(item.initialFen);
    const mover = game.turn() === 'w' ? 'white' : 'black';
    const analysis = await this.engineService.analyzeFen(game.fen(), { mode: 'quick', multiPv: 3, signal });
    const best = analysis.lines?.[0];
    const second = analysis.lines?.[1];
    if (!best || best.move !== item.line[0]) throw new Error('The puzzle solution is not Stockfish\'s best first move.');
    const bestValue = scoreForSide(best.score, mover);
    const secondValue = second ? scoreForSide(second.score, mover) : null;
    const forcedMate = best.score?.type === 'mate' && bestValue > 0;
    const unique = best.score?.type === 'cp' && second?.score?.type === 'cp'
      && bestValue - secondValue >= 150;
    if (!forcedMate && !unique) throw new Error('The puzzle does not have a forced mate or a unique 150-centipawn first move.');
  }

  async validateGeneratedOpening(item, signal) {
    const game = new Chess(item.initialFen);
    for (const expectedUci of item.line) {
      const mover = game.turn() === 'w' ? 'white' : 'black';
      const analysis = await this.engineService.analyzeFen(game.fen(), {
        mode: 'quick', movetimeMs: 250, multiPv: 3, signal
      });
      const best = analysis.lines?.[0];
      const selected = analysis.lines?.find((line) => line.move === expectedUci);
      if (!best || !selected) throw new Error(`Opening move ${expectedUci} is outside Stockfish's top three.`);
      if (best.score?.type === 'mate' && selected.move !== best.move) {
        throw new Error(`Opening move ${expectedUci} misses a forced mate.`);
      }
      if (best.score?.type === 'cp' && selected.score?.type === 'cp'
        && scoreForSide(best.score, mover) - scoreForSide(selected.score, mover) > 50) {
        throw new Error(`Opening move ${expectedUci} is more than 50 centipawns below the best move.`);
      }
      game.move({ from: expectedUci.slice(0, 2), to: expectedUci.slice(2, 4), promotion: expectedUci[4] });
    }
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
    if (this.isPhysicalActivity(updated)) this.physicalCoordinator?.syncPhysicalActivity?.(updated);
    return this.get(conversationId);
  }

  resume(conversationId) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity) throw new MentorActivityError('No paused activity was found.', 'activity_not_found', 404);
    if (activity.status !== 'paused') return this.get(conversationId);
    if (this.isPhysicalActivity(activity)) {
      if (['line_complete', 'repeat_restore', 'route_blocked'].includes(activity.state.pauseReason)) {
        throw new MentorActivityError('Use the opening drill action controls for this paused state.', 'physical_opening_action_required', 409);
      }
      const phase = activity.state.pausedFromPhase || 'learner_turn';
      const physical = this.physicalCoordinator.requireCurrentPhysicalState(conversationId);
      const updated = this.store.updateActivity(activity.id, {
        status: 'active',
        phase,
        boardRevision: physical.revision,
        state: { ...activity.state, pausedFromPhase: null, pauseReason: null }
      });
      this.record(updated, 'resumed', { phase });
      this.physicalCoordinator?.syncPhysicalActivity?.(updated);
      if (updated.type === 'practice_game' && updated.config.opponentMode === 'mentor'
        && phase === 'mentor_turn') {
        this.schedulePhysicalMentorTurn(conversationId, 'activity_resumed');
      }
      return this.get(conversationId);
    }
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
    if (this.isPhysicalActivity(updated)) this.physicalCoordinator?.resolvePhysicalOpening?.(conversationId, 'continue', updated);
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
    const expectedMove = activity.config.line?.[activity.stepIndex];
    if (expectedMove && uci !== expectedMove) {
      const updated = this.store.updateActivity(activity.id, { attempts: activity.attempts + 1 });
      this.record(updated, 'incorrect_move', { attemptedUci: uci, expectedUci: expectedMove });
      throw new MentorActivityError(
        `That move does not match this activity’s objective. The position has not changed. ${activity.config.hints?.[Math.min(activity.hints, 2)] || 'Review the goal and try again.'}`,
        'activity_incorrect_move',
        422,
        { activity: this.get(conversationId), attemptedUci: uci }
      );
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
    if (activity.type !== 'practice_game') {
      return this.advanceScriptedActivity(activity, result, 'learner');
    }
    if (result.state.gameStatus.isGameOver) {
      const updated = this.store.updateActivity(activity.id, {
        status: 'complete',
        phase: 'game_over',
        boardRevision: result.state.revision,
        pendingRequestId: null,
        completedAt: Date.now()
      });
      this.record(updated, 'game_over', { move, gameStatus: result.state.gameStatus });
      return activitySummary(updated, this.store.listActivityEvents(updated.id));
    }
    const updated = this.store.updateActivity(activity.id, {
      phase: 'mentor_turn',
      boardRevision: result.state.revision,
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

  requestHint(conversationId) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity || !['opening_drill', 'puzzle', 'guided_lesson'].includes(activity.type)) {
      throw new MentorActivityError('Hints are available during drills, puzzles, and lessons.', 'hint_not_available', 409);
    }
    const hints = activity.config.hints || [];
    const level = Math.min(3, activity.hints + 1);
    const hint = hints[Math.min(level - 1, hints.length - 1)] || 'Look for forcing moves and the activity goal.';
    const updated = this.store.updateActivity(activity.id, {
      hints: level,
      state: { ...activity.state, lastHint: hint }
    });
    this.record(updated, 'hint_requested', { level, hint });
    return { activity: this.get(conversationId), level, hint };
  }

  validateTool(conversationId, requestId, name, args = {}) {
    if (ACTIVITY_TOOL_NAMES.has(name)) return null;
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity || !ACTIVE_STATUSES.has(activity.status)) return null;
    if (READ_ONLY_TOOLS.has(name) && name !== 'request_prediction') return activity;
    if (this.isPhysicalActivity(activity) && name === 'play_physical_move') {
      return this.validatePhysicalMentorMove(conversationId, requestId, activity, args.uci);
    }
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
    const scriptedMove = activity.config.line?.[activity.stepIndex];
    if (scriptedMove) {
      if (args.uci !== scriptedMove) {
        throw new MentorActivityError('Use the validated continuation for this activity.', 'activity_scripted_move_required', 409);
      }
    } else if (board.legalMoves.length > 1) {
      this.assertTeachingCandidate(conversationId, requestId, activity, args.uci);
    }
    return activity;
  }

  validatePhysicalMentorMove(conversationId, requestId, activity, uci) {
    if (activity.type !== 'practice_game' || activity.config.opponentMode !== 'mentor') {
      throw new MentorActivityError('Gemini move selection is unavailable for this physical activity.', 'physical_mentor_move_unavailable', 409);
    }
    if (activity.status !== 'active' || activity.phase !== 'mentor_thinking'
      || activity.pendingRequestId !== requestId) {
      throw new MentorActivityError('The mentor cannot move outside its assigned physical turn.', 'activity_not_mentor_turn', 409);
    }
    const board = this.physicalCoordinator.requireCurrentPhysicalState(conversationId);
    if (board.turn !== colorCode(activity.mentorColor) || !board.legalMoves.includes(uci)) {
      throw new MentorActivityError(`The mentor controls ${activity.mentorColor} and must choose a legal move.`, 'activity_wrong_color', 409);
    }
    if (board.legalMoves.length > 1) {
      this.assertPhysicalTeachingCandidate(conversationId, requestId, activity, uci);
    }
    return activity;
  }

  assertPhysicalTeachingCandidate(conversationId, requestId, activity, uci) {
    const analysisCall = this.store.listToolCallsForRequest(conversationId, requestId)
      .filter((call) => call.name === 'analyze_position' && call.status === 'complete'
        && call.result?.analyzedRevision === activity.boardRevision)
      .at(-1);
    if (!analysisCall) {
      throw new MentorActivityError('Analyze the current physical position before choosing the mentor move.', 'practice_analysis_required', 409);
    }
    const lines = analysisCall.result?.lines || [];
    const candidate = lines.find((line) => line.move === uci);
    const best = lines[0];
    if (!candidate || !best || lines.slice(0, 3).every((line) => line.move !== uci)) {
      throw new MentorActivityError('Choose one of Stockfish\'s top three verified physical candidates.', 'practice_move_not_grounded', 409);
    }
    if (best.score?.type === 'mate' && candidate.move !== best.move) {
      throw new MentorActivityError('A forced mate is available; preserve the strongest mating line.', 'practice_mate_required', 409);
    }
    if (best.score?.type === 'cp' && candidate.score?.type === 'cp') {
      const bestValue = scoreForSide(best.score, activity.mentorColor);
      const candidateValue = scoreForSide(candidate.score, activity.mentorColor);
      if (bestValue - candidateValue > 50) {
        throw new MentorActivityError('That move is more than 50 centipawns below the verified best move.', 'practice_move_too_weak', 409);
      }
    }
  }

  async playPhysicalMove(conversationId, requestId, uci, { signal } = {}) {
    const activity = this.store.getActiveActivity(conversationId);
    this.validatePhysicalMentorMove(conversationId, requestId, activity, uci);
    const result = await this.physicalCoordinator.playPhysicalMove(conversationId, {
      activityId: activity.id,
      generation: activity.generation,
      requestId,
      uci,
      expectedRevision: activity.boardRevision,
      signal
    });
    return { result, activity: this.get(conversationId) };
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
    if (activity.type !== 'practice_game') {
      return this.advanceScriptedActivity(activity, result, 'mentor', { fallback });
    }
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

  advanceScriptedActivity(activity, result, actor, { fallback = false } = {}) {
    const move = result.state.history.at(-1);
    const nextStep = activity.stepIndex + 1;
    const nextState = {
      ...activity.state,
      completedMentorTurns: Number(activity.state.completedMentorTurns || 0) + (actor === 'mentor' ? 1 : 0),
      fallbackMoves: Number(activity.state.fallbackMoves || 0) + (fallback ? 1 : 0)
    };
    if (nextStep >= activity.totalSteps || result.state.gameStatus.isGameOver) {
      return this.completeActivity(activity, result, {
        stepIndex: nextStep,
        state: nextState,
        eventType: result.state.gameStatus.isGameOver ? 'game_over' : 'activity_completed',
        payload: { move, actor, gameStatus: result.state.gameStatus }
      });
    }
    const nextUci = activity.config.line[nextStep];
    const nextActor = moveColor(result.state.fen, nextUci) === colorCode(activity.learnerColor)
      ? 'learner'
      : 'mentor';
    const updated = this.store.updateActivity(activity.id, {
      stepIndex: nextStep,
      phase: nextActor === 'learner' ? 'learner_turn' : 'mentor_turn',
      boardRevision: result.state.revision,
      pendingRequestId: null,
      state: nextState
    });
    this.record(updated, actor === 'learner' ? 'learner_move' : fallback ? 'engine_fallback_move' : 'mentor_move', {
      move,
      nextStep,
      nextActor
    });
    if (nextActor === 'mentor') this.scheduleMentorTurn(activity.conversationId, 'scripted_continuation');
    return this.get(activity.conversationId);
  }

  completeActivity(activity, result, { stepIndex, state, eventType, payload }) {
    const phase = result.state.gameStatus.isGameOver ? 'game_over' : 'complete';
    const updated = this.store.updateActivity(activity.id, {
      status: 'complete',
      phase,
      stepIndex,
      boardRevision: result.state.revision,
      pendingRequestId: null,
      state,
      completedAt: Date.now()
    });
    this.record(updated, eventType, payload);
    const topics = [activity.config.topic].filter(Boolean);
    const points = activity.attempts > 0 ? 3 : activity.hints > 0 ? 6 : 10;
    const progress = this.store.awardActivityProgress(activity.id, topics, points);
    if (progress.awarded) {
      this.emitGlobal('mentor-progress-updated', this.getProgressSummary());
    }
    return activitySummary(updated, this.store.listActivityEvents(updated.id));
  }

  scheduleMentorTurn(conversationId, reason) {
    if (this.inFlight.has(conversationId)) return this.inFlight.get(conversationId);
    const promise = this.executeMentorTurn(conversationId, reason)
      .catch((error) => {
        this.logger.error?.('[MENTOR_ACTIVITY_TURN_FAILED]', JSON.stringify({
          conversationId,
          error: error.message,
          stack: error.stack
        }));
        const activity = this.store.getActiveActivity(conversationId);
        if (activity?.status === 'active' && activity.phase === 'mentor_thinking') {
          this.pause(conversationId, 'mentor_turn_failed');
        }
      })
      .finally(() => this.inFlight.delete(conversationId));
    this.inFlight.set(conversationId, promise);
    return promise;
  }

  schedulePhysicalMentorTurn(conversationId, reason) {
    if (this.physicalInFlight.has(conversationId)) return this.physicalInFlight.get(conversationId);
    const promise = this.executePhysicalMentorTurn(conversationId, reason)
      .catch((error) => {
        this.logger.error?.('[MENTOR_PHYSICAL_ACTIVITY_TURN_FAILED]', JSON.stringify({
          conversationId,
          error: error.message,
          stack: error.stack
        }));
        const activity = this.store.getActiveActivity(conversationId);
        if (activity?.status === 'active' && activity.phase === 'mentor_thinking') {
          this.pause(conversationId, 'mentor_turn_failed');
        }
      })
      .finally(() => this.physicalInFlight.delete(conversationId));
    this.physicalInFlight.set(conversationId, promise);
    return promise;
  }

  physicalActivityPrompt(activity, board, { corrective = false } = {}) {
    return [
      '[MENTOR_PHYSICAL_ACTIVITY_TURN]',
      corrective
        ? 'Your previous response analyzed the physical position but did not make the required move.'
        : `The learner completed a physical move. It is now your ${activity.mentorColor} turn.`,
      `Activity: ${activity.title}. Learner: ${activity.learnerColor}. Mentor: ${activity.mentorColor}.`,
      `Authoritative physical revision: ${board.revision}. FEN: ${board.fen}`,
      activity.state.strategicPlan ? `Continue this strategic plan: ${activity.state.strategicPlan}` : 'Choose a coherent teaching plan and retain it across turns.',
      'Call analyze_position in quick mode, then call play_physical_move exactly once with a top-three move no more than 50 centipawns below the best.',
      'Forced mates and materially superior moves take priority over teaching flexibility.',
      'Do not finish with analysis alone. Do not describe raw motors, paths, magnets, or sensors.',
      'After verification, explain the learner move, your reply, and the current plan directly and without praise padding.'
    ].join('\n');
  }

  async runPhysicalGeneratedTurn(conversationId, activity, board, requestId, corrective) {
    const displayText = corrective ? 'Mentor is completing its physical move.' : 'Mentor is choosing a physical reply.';
    const prompt = this.physicalActivityPrompt(activity, board, { corrective });
    const useLive = this.runners.isLiveActive(conversationId) && this.runners.live;
    const pair = useLive
      ? this.runners.live({ conversationId, requestId, displayText, prompt, timeoutMs: 15000 })
      : this.runners.text?.({ conversationId, requestId, displayText, prompt, timeoutMs: 15000 });
    if (!pair) throw new MentorActivityError('No mentor response runner is available.', 'activity_runner_unavailable', 503);
    return pair.completion ? pair.completion : pair;
  }

  async executePhysicalMentorTurn(conversationId, reason) {
    let activity = this.store.getActiveActivity(conversationId);
    if (!this.isPhysicalActivity(activity) || activity.type !== 'practice_game'
      || activity.config.opponentMode !== 'mentor' || activity.status !== 'active'
      || !['mentor_turn', 'mentor_thinking'].includes(activity.phase)) return;
    const leased = this.store.claimActivityLease(activity.id, this.leaseOwner, 15000);
    if (!leased) return;
    activity = leased;
    try {
      let board = this.physicalCoordinator.requireCurrentPhysicalState(conversationId);
      if (board.gameStatus.isGameOver) {
        this.end(conversationId, 'game_over');
        return;
      }
      if (board.turn !== colorCode(activity.mentorColor)) {
        throw new MentorActivityError('The physical activity turn does not match the board.', 'activity_turn_mismatch', 409);
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        activity = this.store.getActiveActivity(conversationId);
        if (!activity || activity.status !== 'active') return;
        board = this.physicalCoordinator.requireCurrentPhysicalState(conversationId);
        const requestId = `physical-activity:${activity.id}:${activity.generation + 1}:${board.revision}:${attempt}`;
        activity = this.store.updateActivity(activity.id, {
          phase: 'mentor_thinking',
          boardRevision: board.revision,
          pendingRequestId: requestId,
          generation: activity.generation + 1
        });
        this.physicalCoordinator?.syncPhysicalActivity?.(activity);
        this.record(activity, attempt === 0 ? 'physical_mentor_turn_started' : 'physical_mentor_turn_corrective', {
          requestId, reason, revision: board.revision
        });
        const completion = await this.runPhysicalGeneratedTurn(conversationId, activity, board, requestId, attempt === 1);
        const current = this.store.getActiveActivity(conversationId);
        if (!current || current.status !== 'active' || current.phase === 'learner_turn') return;
        if (completion?.status === 'cancelled') {
          this.pause(conversationId, 'response_stopped');
          return;
        }
      }
      await this.executePhysicalFallback(conversationId);
    } finally {
      this.store.releaseActivityLease(activity.id, this.leaseOwner);
    }
  }

  async executePhysicalFallback(conversationId) {
    const activity = this.store.getActiveActivity(conversationId);
    if (!activity || activity.status !== 'active' || activity.phase !== 'mentor_thinking') return;
    const analysis = await this.physicalCoordinator.analyzePosition(conversationId, { mode: 'quick' });
    const uci = analysis?.bestMove?.uci;
    if (!uci) throw new MentorActivityError('Stockfish returned no physical fallback move.', 'activity_fallback_unavailable', 503);
    const requestId = activity.pendingRequestId;
    await this.physicalCoordinator.playPhysicalMove(conversationId, {
      activityId: activity.id,
      generation: activity.generation,
      requestId,
      uci,
      expectedRevision: activity.boardRevision,
      fallback: true
    });
    const current = this.store.getActiveActivity(conversationId);
    if (current) {
      const updated = this.store.updateActivity(current.id, {
        state: { ...current.state, fallbackMoves: Number(current.state.fallbackMoves || 0) + 1 }
      });
      this.record(updated, 'physical_engine_fallback', { uci, reason: 'Gemini omitted a verified move after one corrective turn.' });
    }
  }

  activityPrompt(activity, board, { corrective = false } = {}) {
    const prefix = corrective
      ? 'Your previous response analyzed the position but did not make the required opponent move.'
      : `The learner committed ${board.history.at(-1)?.san || 'a move'} and it is now your ${activity.mentorColor} turn.`;
    const scriptedMove = activity.config.line?.[activity.stepIndex];
    return [
      '[MENTOR_ACTIVITY_TURN]',
      prefix,
      `Activity: ${activity.title}. Learner: ${activity.learnerColor}. Mentor: ${activity.mentorColor}.`,
      `Authoritative revision: ${board.revision}. FEN: ${board.fen}`,
      scriptedMove
        ? `This reviewed activity requires exactly ${scriptedMove}. Call play_move exactly once with that move.`
        : 'You must use analyze_position in quick mode, then call play_move exactly once with a verified teaching candidate.',
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
    const scriptedMove = activity.config.line?.[activity.stepIndex];
    const analysis = scriptedMove ? null : await this.analysisService.analyzePosition(conversationId, { mode: 'quick' });
    const uci = scriptedMove || analysis?.bestMove?.uci;
    if (!uci) throw new MentorActivityError('Stockfish returned no fallback move.', 'activity_fallback_unavailable', 503);
    const requestId = activity.pendingRequestId;
    const assistant = this.store.getRequestMessages(conversationId, requestId)
      .find((message) => message.role === 'model');
    const existingCalls = this.store.listToolCallsForRequest(conversationId, requestId);
    const fallbackName = scriptedMove ? 'activity_fallback' : 'engine_fallback';
    let fallbackCard = null;
    if (assistant) {
      fallbackCard = this.store.createToolCall({
        conversationId,
        requestId,
        assistantMessageId: assistant.id,
        providerCallId: `${fallbackName}:${activity.id}:${board.revision}`,
        ordinal: Math.max(0, ...existingCalls.map((call) => call.ordinal)) + 1,
        name: fallbackName,
        arguments: { uci },
        progressTotal: 1
      }).toolCall;
      fallbackCard = this.store.updateToolCall(fallbackCard.id, { status: 'running' });
      this.emit(conversationId, 'mentor-tool-started', { conversationId, toolCall: fallbackCard });
    }
    const actionId = `activity:fallback:${activity.id}:${board.revision}`;
    try {
      const result = this.chessService.move(conversationId, {
        uci,
        expectedRevision: board.revision,
        actionId,
        actor: 'mentor',
        activityId: activity.id
      });
      this.emitBoardUpdate(conversationId, result);
      this.mentorMoveCommitted(conversationId, requestId, result, { fallback: true });
      if (fallbackCard) {
        fallbackCard = this.store.updateToolCall(fallbackCard.id, {
          status: 'complete',
          result: {
            kind: fallbackName,
            move: result.state.history.at(-1),
            reason: scriptedMove
              ? 'Gemini did not complete the reviewed activity continuation.'
              : 'Gemini did not complete its opponent turn after one corrective response.'
          },
          progressCurrent: 1,
          progressTotal: 1
        });
        this.emit(conversationId, 'mentor-tool-completed', { conversationId, toolCall: fallbackCard });
      }
    } catch (error) {
      if (fallbackCard) {
        fallbackCard = this.store.updateToolCall(fallbackCard.id, { status: 'failed', error: error.message });
        this.emit(conversationId, 'mentor-tool-failed', { conversationId, toolCall: fallbackCard });
      }
      throw error;
    }
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
