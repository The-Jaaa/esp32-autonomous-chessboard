const { createHash } = require('crypto');
const { Chess } = require('chess.js');
const { gameStatus, moveToUci, normalizeAnnotations } = require('./chess-service');
const { STANDARD_FEN } = require('./store');
const { listCatalog } = require('./curriculum');

const PHYSICAL_BOARD_ID = 'main-board';
const PHYSICAL_READ_TOOLS = new Set([
  'get_board_state',
  'analyze_position',
  'analyze_move',
  'set_orientation',
  'annotate_board',
  'get_activity_state',
  'start_activity',
  'request_hint',
  'end_activity',
  'resolve_opening_drill'
]);

class MentorPhysicalError extends Error {
  constructor(message, code = 'mentor_physical_error', statusCode = 400, details = {}) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

function sourceKey(snapshot) {
  return snapshot
    ? `physical:${snapshot.serverInstanceId}:${snapshot.sessionGeneration}`
    : null;
}

function serializePhysicalMove(entry, index) {
  return {
    ply: index + 1,
    uci: entry.uci || entry.move,
    san: entry.san,
    lan: entry.lan || entry.uci || entry.move,
    from: entry.from,
    to: entry.to,
    color: entry.color || (entry.side === 'human' ? 'w' : 'b'),
    piece: entry.piece || null,
    captured: entry.capturedPiece || null,
    capturedSquare: entry.capturedSquare || null,
    promotion: entry.promotion || null,
    flags: entry.flags || '',
    castleRookMove: entry.castleRookMove || null,
    enPassantCapturedSquare: entry.enPassantCapturedSquare || null,
    robotGraveyardSlot: entry.robotGraveyardSlot || null,
    robotCapturedPathSquares: entry.robotCapturedPathSquares || [],
    before: entry.beforeFen || null,
    after: entry.afterFen || null,
    side: entry.side,
    createdAt: entry.createdAt || null,
    verified: entry.verified !== false
  };
}

function normalizeSnapshot(snapshot, binding) {
  if (!snapshot?.fen || !binding) return null;
  const game = new Chess(snapshot.fen);
  const history = (snapshot.moveLog || snapshot.physicalMoveLog || [])
    .filter((entry) => entry?.verified !== false)
    .map(serializePhysicalMove);
  const annotations = binding.annotatedFen === snapshot.fen
    ? binding.annotations
    : { highlights: [], arrows: [] };
  return {
    source: 'physical',
    sourceKey: sourceKey(snapshot),
    conversationId: binding.conversationId,
    initialFen: null,
    fen: game.fen(),
    pgn: snapshot.pgn || '',
    orientation: binding.orientation,
    revision: Number(snapshot.stateRevision || 0),
    turn: game.turn(),
    turnName: game.turn() === 'w' ? 'White' : 'Black',
    history,
    legalMoves: game.moves({ verbose: true }).map(moveToUci).sort(),
    annotations,
    gameStatus: {
      ...gameStatus(game),
      checkedKingSquare: snapshot.gameStatus?.checkedKingSquare || null,
      whiteKingSquare: snapshot.gameStatus?.whiteKingSquare || null,
      blackKingSquare: snapshot.gameStatus?.blackKingSquare || null
    },
    events: [],
    cacheConsistent: true,
    physical: {
      boardId: binding.boardId,
      humanColor: snapshot.humanColor || 'white',
      robotColor: snapshot.robotColor || 'black',
      serverInstanceId: snapshot.serverInstanceId,
      sessionGeneration: Number(snapshot.sessionGeneration),
      stateRevision: Number(snapshot.stateRevision || 0),
      active: Boolean(snapshot.active),
      phase: snapshot.phase,
      setupMode: snapshot.setupMode || 'full',
      statusText: snapshot.statusText,
      robotBusy: Boolean(snapshot.robotBusy),
      pendingRobotJob: snapshot.pendingRobotJob || null,
      pendingUndo: snapshot.pendingUndo || null,
      pendingRedo: snapshot.pendingRedo || null,
      robotGraveyardOccupied: snapshot.robotGraveyardOccupied || [],
      selectedSource: snapshot.selectedSource || null,
      legalTargets: snapshot.legalTargets || [],
      board: snapshot.board || { ready: true, missingSquares: [], extraSquares: [] },
      calibration: snapshot.calibration || null,
      lastSnapshotAt: snapshot.lastSnapshotAt || null,
      lastError: snapshot.lastError || null,
      syncWarningReason: snapshot.syncWarningReason || null,
      lastMove: snapshot.lastMove || null,
      openingDrill: snapshot.mentorOpeningDrill || null,
      openingLock: Boolean(snapshot.mentorOpeningLock)
    }
  };
}

function boardDifferenceText(snapshot) {
  const missing = snapshot.board?.missingSquares || [];
  const extra = snapshot.board?.extraSquares || [];
  const parts = [];
  if (missing.length) parts.push(`missing or uncentered: ${missing.join(', ')}`);
  if (extra.length) parts.push(`unexpected occupancy: ${extra.join(', ')}`);
  return parts.join('; ');
}

function guidanceFor(snapshot) {
  if (!snapshot?.active || snapshot.phase === 'setup' || snapshot.phase === 'idle') return null;
  const diff = boardDifferenceText(snapshot);
  let type = null;
  let urgent = false;
  let eventText = '';
  let reply = '';

  if (snapshot.phase === 'sync_warning') {
    type = 'sync_warning';
    urgent = true;
    eventText = `Physical board synchronization warning${diff ? `: ${diff}` : ''}.`;
    const reason = snapshot.syncWarningReason || {};
    if (reason.type === 'opening_drill_wrong_source') {
      reply = `Return the piece to ${reason.sourceSquare}. This opening drill requires ${reason.expectedUci}.`;
    } else if (reason.type === 'opening_drill_wrong_destination' || reason.type === 'opening_drill_wrong_move') {
      reply = snapshot.statusText || `Restore the piece, then play the reviewed move ${reason.expectedUci}.`;
    } else {
      reply = diff
        ? `Please restore or center the indicated pieces. The board reports ${diff}.`
        : (snapshot.statusText || 'Please restore the physical board to the expected position.');
    }
  } else if (snapshot.phase === 'error' || snapshot.lastError) {
    type = 'error';
    urgent = true;
    const message = snapshot.lastError?.message || snapshot.statusText || 'The physical board reported an error.';
    eventText = `Physical board error: ${message}`;
    reply = `${message} Please stop moving pieces and follow the recovery status shown beside the board.`;
  } else if (snapshot.phase === 'undo_waiting_human_restore') {
    type = 'restore_required';
    urgent = true;
    const restore = snapshot.pendingUndo?.waitingForHumanRestore;
    const squares = restore?.squares || restore?.requiredSquares || [];
    eventText = `Physical undo requires a captured piece to be restored${squares.length ? ` on ${squares.join(', ')}` : ''}.`;
    reply = snapshot.statusText || eventText;
  } else if (snapshot.phase === 'castle_pending_rook') {
    type = 'castle_rook_required';
    urgent = true;
    eventText = snapshot.statusText || 'The castling rook still needs to be placed.';
    reply = eventText;
  } else if (!snapshot.robotBusy && !snapshot.pendingRobotJob && snapshot.gameStatus?.checkmate) {
    type = 'checkmate';
    eventText = snapshot.gameStatus.resultText || 'Checkmate.';
    reply = eventText;
  } else if (!snapshot.robotBusy && !snapshot.pendingRobotJob && snapshot.gameStatus?.draw) {
    type = 'draw';
    eventText = snapshot.gameStatus.resultText || 'The physical game is drawn.';
    reply = eventText;
  } else if (!snapshot.robotBusy && !snapshot.pendingRobotJob && snapshot.gameStatus?.inCheck) {
    type = 'check';
    eventText = `${snapshot.gameStatus.resultText || 'Check.'}${snapshot.gameStatus.checkedKingSquare ? ` King on ${snapshot.gameStatus.checkedKingSquare}.` : ''}`;
    reply = eventText;
  }

  if (!type) return null;
  const keyParts = ['check', 'checkmate', 'draw'].includes(type)
    ? [snapshot.serverInstanceId, snapshot.sessionGeneration, type, snapshot.fen]
    : [
        snapshot.serverInstanceId,
        snapshot.sessionGeneration,
        type,
        snapshot.phase,
        snapshot.fen,
        diff,
        snapshot.pendingRobotJob?.id || '',
        snapshot.pendingUndo?.id || '',
        snapshot.statusText || ''
      ];
  return {
    type,
    urgent,
    key: keyParts.join('|'),
    eventText,
    reply,
    prompt: [
      '[PHYSICAL_BOARD_GUIDANCE]',
      eventText,
      urgent ? `Speak this exact recovery instruction now: ${reply}` : `Required guidance: ${reply}`,
      urgent
        ? 'Do not answer an earlier learner request and do not add chess commentary. Do not move or alter any board.'
        : 'Respond in one or two concise spoken sentences. Put the required guidance first. Do not move or alter any board.'
    ].join('\n')
  };
}

function isRecoverableGuidanceKey(key) {
  return ['sync_warning', 'error', 'restore_required', 'castle_rook_required']
    .some((type) => String(key || '').includes(`|${type}|`));
}

class MentorPhysicalObserverService {
  constructor({
    store,
    chessService,
    analysisService,
    emit = () => {},
    boardId = PHYSICAL_BOARD_ID,
    recoverableGuidanceDelayMs = 2000,
    openingGuidanceDelayMs = 1500
  }) {
    this.store = store;
    this.chessService = chessService;
    this.analysisService = analysisService;
    this.emit = emit;
    this.boardId = boardId;
    this.adapter = null;
    this.snapshot = null;
    this.textService = null;
    this.liveService = null;
    this.activityService = null;
    this.recoverableGuidanceDelayMs = recoverableGuidanceDelayMs;
    this.openingGuidanceDelayMs = openingGuidanceDelayMs;
    this.pendingGuidance = new Map();
    this.pendingOpeningGuidance = new Map();
  }

  clearPendingGuidance(conversationId) {
    const pending = this.pendingGuidance.get(conversationId);
    if (pending) clearTimeout(pending.timer);
    this.pendingGuidance.delete(conversationId);
  }

  clearPendingOpeningGuidance(conversationId) {
    const pending = this.pendingOpeningGuidance.get(conversationId);
    if (pending) clearTimeout(pending.timer);
    this.pendingOpeningGuidance.delete(conversationId);
  }

  setDependencies({ textService, liveService, activityService }) {
    this.textService = textService;
    this.liveService = liveService;
    this.activityService = activityService;
    this.activityService?.setPhysicalCoordinator?.(this);
  }

  setAdapter(adapter) {
    this.adapter = adapter;
    const snapshot = adapter?.getSnapshot?.();
    if (snapshot) this.handleSnapshot(snapshot, 'physical-status');
  }

  requireCurrentPhysicalState(conversationId) {
    return this.getState(conversationId);
  }

  requireOpeningStartState(conversationId, expectedRevision) {
    const state = this.getState(conversationId);
    const physical = state.physical;
    if (Number(expectedRevision) !== state.revision) {
      throw new MentorPhysicalError('The physical board changed before the drill started.', 'stale_revision', 409, { state });
    }
    if (state.fen !== STANDARD_FEN || state.history.length !== 0
      || physical.setupMode !== 'full' || physical.phase !== 'ready'
      || !physical.board?.ready || physical.robotBusy
      || physical.pendingRobotJob || physical.pendingUndo || physical.pendingRedo
      || physical.robotGraveyardOccupied.length > 0) {
      throw new MentorPhysicalError(
        'Physical opening drills require a synchronized full standard position with no pending work.',
        'physical_opening_setup_required',
        409,
        { state }
      );
    }
    return state;
  }

  syncPhysicalActivity(activity) {
    if (!activity || activity.config?.boardSource !== 'physical') {
      this.adapter?.setOpeningDrill?.(null);
      return null;
    }
    const policy = this.activityService?.getPhysicalPolicy?.(activity.conversationId) || null;
    this.adapter?.setOpeningDrill?.(policy);
    return policy;
  }

  announcePhysicalOpening(activity) {
    if (!activity || activity.config?.boardSource !== 'physical') return null;
    const firstMove = activity.config.line?.[0] || null;
    const firstHint = activity.config.hints?.[0] || '';
    const displayText = `${activity.title} lesson started.`;
    const reply = [
      `We will practice the ${activity.title}, where the main plan is to ${String(activity.goal || 'develop with purpose').replace(/\.$/, '')}.`,
      firstHint,
      firstMove ? `You are White; begin with ${firstMove}.` : null
    ].filter(Boolean).join(' ');
    const requestId = `physical-opening-start:${activity.id}:${activity.generation}`;
    const prompt = [
      '[PHYSICAL_OPENING_START]',
      `Opening: ${activity.title}`,
      `Main strategic goal: ${activity.goal}`,
      `First reviewed move: ${firstMove}`,
      `Teaching cue: ${firstHint || '(none)'}`,
      'Introduce the opening before play begins. Explain its central strategic idea, what White is trying to achieve, and one technique the learner should watch for.',
      `Finish by clearly asking the learner to play ${firstMove}.`,
      'Use three or four concise spoken sentences. Do not call tools or claim that a move has already been played.'
    ].join('\n');
    const live = this.liveService?.requestPhysicalTurn(activity.conversationId, {
      requestId,
      displayText,
      prompt,
      urgent: false,
      fallbackAssistantText: reply,
      timeoutMs: 30000,
      queueKey: 'physical-opening'
    });
    if (live) return live;
    const pair = this.store.createMessagePair(activity.conversationId, {
      requestId,
      text: displayText,
      kind: 'physical',
      assistantContent: reply,
      assistantStatus: 'complete',
      suppressTitle: true
    });
    if (!pair || pair.duplicate) return pair;
    const conversation = this.store.touchConversation(activity.conversationId);
    this.emit(activity.conversationId, 'mentor-message-start', {
      conversationId: activity.conversationId,
      requestId,
      message: pair.userMessage
    });
    this.emit(activity.conversationId, 'mentor-message-complete', {
      conversationId: activity.conversationId,
      requestId,
      message: pair.assistantMessage,
      conversation
    });
    return pair;
  }

  retryPhysicalOpening(conversationId) {
    this.requireCurrentBinding(conversationId);
    return this.adapter?.retryOpeningDrill?.() || { success: false };
  }

  resolvePhysicalOpening(conversationId, action) {
    this.requireCurrentBinding(conversationId);
    return this.adapter?.resolveOpeningDrill?.(action) || { success: false };
  }

  resumeNormalPlay(conversationId) {
    this.requireCurrentBinding(conversationId);
    return this.adapter?.resolveOpeningDrill?.('resume') || { success: false };
  }

  isAttached(conversationId) {
    return this.store.getPhysicalBinding(conversationId)?.status === 'active';
  }

  availability() {
    const activeBinding = this.store.getActivePhysicalBinding(this.boardId);
    return {
      available: Boolean(this.snapshot?.active && this.snapshot.phase !== 'idle'),
      boardId: this.boardId,
      serverInstanceId: this.snapshot?.serverInstanceId || null,
      sessionGeneration: Number(this.snapshot?.sessionGeneration || 0),
      stateRevision: Number(this.snapshot?.stateRevision || 0),
      phase: this.snapshot?.phase || 'idle',
      statusText: this.snapshot?.statusText || 'Physical board unavailable.',
      boundConversationId: activeBinding?.conversationId || null,
      binding: activeBinding ? {
        conversationId: activeBinding.conversationId,
        status: activeBinding.status,
        serverInstanceId: activeBinding.serverInstanceId,
        sessionGeneration: activeBinding.sessionGeneration,
        stateRevision: activeBinding.stateRevision
      } : null
    };
  }

  detail(conversationId) {
    const binding = this.store.getPhysicalBinding(conversationId);
    return {
      binding,
      state: binding?.status === 'active' ? normalizeSnapshot(this.snapshot, binding) : null
    };
  }

  requireCurrentBinding(conversationId) {
    const binding = this.store.getPhysicalBinding(conversationId);
    if (!binding || binding.status !== 'active') {
      throw new MentorPhysicalError('This conversation is not attached to the physical board.', 'physical_board_not_attached', 409);
    }
    if (!this.snapshot?.active
      || binding.serverInstanceId !== this.snapshot.serverInstanceId
      || binding.sessionGeneration !== Number(this.snapshot.sessionGeneration)) {
      this.store.detachPhysicalBinding(conversationId, 'stale');
      throw new MentorPhysicalError('The attached physical session is no longer current.', 'physical_board_stale', 409);
    }
    return binding;
  }

  getState(conversationId) {
    const binding = this.requireCurrentBinding(conversationId);
    return normalizeSnapshot(this.snapshot, binding);
  }

  attach(conversationId, { serverInstanceId, sessionGeneration } = {}) {
    if (!this.store.getConversation(conversationId)) {
      throw new MentorPhysicalError('Conversation not found.', 'conversation_not_found', 404);
    }
    if (!this.snapshot?.active || this.snapshot.phase === 'idle') {
      throw new MentorPhysicalError('Start the physical game from the Companion Board first.', 'physical_board_unavailable', 409);
    }
    if (serverInstanceId !== this.snapshot.serverInstanceId
      || Number(sessionGeneration) !== Number(this.snapshot.sessionGeneration)) {
      throw new MentorPhysicalError('The physical session changed before it could be attached.', 'physical_board_stale', 409);
    }
    if (this.activityService?.get(conversationId)) {
      throw new MentorPhysicalError('End the virtual mentor activity before attaching the physical board.', 'physical_activity_active', 409);
    }
    if (this.textService?.hasActiveConversation(conversationId)) {
      throw new MentorPhysicalError('Stop the current mentor response before attaching the physical board.', 'mentor_text_active', 409);
    }
    if (this.liveService?.isConversationActive(conversationId)) {
      throw new MentorPhysicalError('Stop Live voice before changing the board source.', 'mentor_live_active', 409);
    }
    const virtualState = this.chessService.getState(conversationId);
    const result = this.store.attachPhysicalBinding(conversationId, {
      boardId: this.boardId,
      serverInstanceId,
      sessionGeneration: Number(sessionGeneration),
      stateRevision: Number(this.snapshot.stateRevision || 0),
      orientation: virtualState.orientation
    });
    if (result.status === 'conflict') {
      throw new MentorPhysicalError('The physical board is already attached to another conversation.', 'physical_board_already_attached', 409, {
        boundConversationId: result.binding.conversationId
      });
    }
    const detail = this.detail(conversationId);
    this.emit(conversationId, 'mentor-physical-binding-updated', { conversationId, physicalBoard: detail });
    this.emit(conversationId, 'mentor-physical-board-updated', { conversationId, state: detail.state, event: 'attached' });
    this.processGuidance(conversationId, this.snapshot, result.binding);
    return detail;
  }

  detach(conversationId) {
    if (this.textService?.hasActiveConversation(conversationId)) {
      throw new MentorPhysicalError('Stop the current mentor response before detaching the physical board.', 'mentor_text_active', 409);
    }
    if (this.liveService?.isConversationActive(conversationId)) {
      throw new MentorPhysicalError('Stop Live voice before changing the board source.', 'mentor_live_active', 409);
    }
    this.clearPendingGuidance(conversationId);
    this.clearPendingOpeningGuidance(conversationId);
    const binding = this.store.detachPhysicalBinding(conversationId);
    const detail = { binding, state: null };
    this.emit(conversationId, 'mentor-physical-binding-updated', { conversationId, physicalBoard: detail });
    return detail;
  }

  setOrientation(conversationId, { orientation, expectedRevision } = {}) {
    const binding = this.requireCurrentBinding(conversationId);
    if (!['white', 'black'].includes(orientation)) {
      throw new MentorPhysicalError('Board orientation must be white or black.', 'invalid_orientation');
    }
    if (Number(expectedRevision) !== Number(this.snapshot.stateRevision)) {
      throw new MentorPhysicalError('The physical board changed before orientation was updated.', 'stale_revision', 409, {
        state: this.getState(conversationId)
      });
    }
    const updated = this.store.updatePhysicalBinding(conversationId, { orientation });
    const state = normalizeSnapshot(this.snapshot, updated);
    this.emit(conversationId, 'mentor-physical-board-updated', { conversationId, state, event: 'orientation' });
    return { actionId: null, duplicate: false, state, binding };
  }

  setAnnotations(conversationId, { highlights, arrows, expectedRevision } = {}) {
    this.requireCurrentBinding(conversationId);
    if (Number(expectedRevision) !== Number(this.snapshot.stateRevision)) {
      throw new MentorPhysicalError('The physical board changed before annotations were applied.', 'stale_revision', 409, {
        state: this.getState(conversationId)
      });
    }
    const annotations = normalizeAnnotations({ highlights, arrows });
    const updated = this.store.updatePhysicalBinding(conversationId, {
      annotatedFen: this.snapshot.fen,
      annotations
    });
    const state = normalizeSnapshot(this.snapshot, updated);
    this.emit(conversationId, 'mentor-physical-board-updated', { conversationId, state, event: 'annotations' });
    return { actionId: null, duplicate: false, state };
  }

  promptContext(conversationId) {
    const state = this.getState(conversationId);
    const recentMoves = state.history.slice(-12).map((move) => move.san).join(' ');
    const physical = state.physical;
    const activity = this.activityService?.get?.(conversationId) || null;
    const reviewedOpenings = listCatalog()
      .filter((item) => item.type === 'opening_drill' && item.supportsPhysical)
      .map((item) => `${item.title} [${item.id}]`)
      .join(', ');
    const openingContext = activity?.config?.boardSource === 'physical'
      ? [
          `Active physical opening drill: ${activity.title}`,
          `Opening goal: ${activity.goal}`,
          `Opening step: ${Math.min(activity.stepIndex + 1, activity.totalSteps)} of ${activity.totalSteps}`,
          `Required next move: ${activity.config.line?.[activity.stepIndex] || '(line complete)'}`,
          `Required actor: ${activity.stepIndex % 2 === 0 ? 'learner' : 'mentor robot'}`,
          'The opening coordinator, not Gemini, enforces and executes the reviewed line.'
        ]
      : [];
    return [
      'Current workspace source: physical chessboard (read-only).',
      `FEN: ${state.fen}`,
      `PGN: ${state.pgn || '(none)'}`,
      `Turn: ${state.turnName}`,
      `Game status: ${state.gameStatus.resultText}`,
      `Recent verified moves: ${recentMoves || '(none)'}`,
      `Human player: ${physical.humanColor === 'black' ? 'Black' : 'White'}`,
      `Physical robot opponent: ${physical.robotColor === 'white' ? 'White' : 'Black'}`,
      `Physical phase: ${physical.phase}`,
      `Physical status: ${physical.statusText}`,
      `Missing or uncentered squares: ${physical.board.missingSquares.join(', ') || '(none)'}`,
      `Unexpected occupied squares: ${physical.board.extraSquares.join(', ') || '(none)'}`,
      `Robot busy: ${physical.robotBusy ? 'yes' : 'no'}`,
      ...openingContext,
      `Reviewed physical opening drills: ${reviewedOpenings}`,
      'You may analyze or annotate this position, but you cannot move, reset, load, demonstrate, or otherwise control the physical board.',
      'You may start and guide a reviewed physical opening drill only when the board is at the exact standard starting position.',
      'Never say that you played a physical move. The backend robot chooses and executes the opponent moves.'
    ].join('\n');
  }

  allowedTool(name) {
    return PHYSICAL_READ_TOOLS.has(name);
  }

  async analyzePosition(conversationId, options = {}) {
    const state = this.getState(conversationId);
    const result = await this.analysisService.analyzePositionState(state, {
      ...options,
      assertCurrent: () => this.assertAnalysisCurrent(conversationId, state)
    });
    this.store.updatePhysicalBinding(conversationId, { analyzedFen: result.analyzedFen });
    return result;
  }

  async analyzeMove(conversationId, options = {}) {
    const state = this.getState(conversationId);
    const result = await this.analysisService.analyzeMoveState(state, {
      ...options,
      assertCurrent: () => this.assertAnalysisCurrent(conversationId, state)
    });
    this.store.updatePhysicalBinding(conversationId, { analyzedFen: result.analyzedFen });
    return result;
  }

  assertAnalysisCurrent(conversationId, expected) {
    const current = this.getState(conversationId);
    if (current.sourceKey !== expected.sourceKey
      || current.revision !== expected.revision
      || current.fen !== expected.fen) {
      throw new MentorPhysicalError('The physical board changed while Stockfish was analyzing it.', 'stale_analysis', 409, { state: current });
    }
    return current;
  }

  handleSnapshot(snapshot, event = 'physical-status') {
    this.snapshot = snapshot;
    const binding = this.store.getActivePhysicalBinding(this.boardId);
    if (!binding) return;
    if (!snapshot?.active
      || binding.serverInstanceId !== snapshot.serverInstanceId
      || binding.sessionGeneration !== Number(snapshot.sessionGeneration)) {
      const stale = this.store.detachPhysicalBinding(binding.conversationId, 'stale');
      this.clearPendingGuidance(binding.conversationId);
      this.clearPendingOpeningGuidance(binding.conversationId);
      this.activityService?.cancelStalePhysicalActivity?.(binding.conversationId, 'physical_session_stale');
      this.emit(binding.conversationId, 'mentor-physical-binding-updated', {
        conversationId: binding.conversationId,
        physicalBoard: { binding: stale, state: null }
      });
      this.liveService?.stopConversation?.(binding.conversationId, 'physical_session_stale')?.catch?.(() => {});
      return;
    }

    const meaningfulChange = binding.stateRevision !== Number(snapshot.stateRevision || 0);
    let updated = binding;
    if (binding.annotatedFen && binding.annotatedFen !== snapshot.fen) {
      updated = this.store.updatePhysicalBinding(binding.conversationId, {
        stateRevision: Number(snapshot.stateRevision || 0),
        annotatedFen: null,
        analyzedFen: null,
        annotations: { highlights: [], arrows: [] }
      });
    } else if (binding.stateRevision !== Number(snapshot.stateRevision || 0)) {
      updated = this.store.updatePhysicalBinding(binding.conversationId, {
        stateRevision: Number(snapshot.stateRevision || 0),
        analyzedFen: binding.analyzedFen === snapshot.fen ? binding.analyzedFen : null
      });
    }
    const state = normalizeSnapshot(snapshot, updated);
    this.emit(binding.conversationId, 'mentor-physical-board-updated', {
      conversationId: binding.conversationId,
      state,
      event
    });
    if (!['ready', 'mentor_drill_complete'].includes(snapshot.phase)) {
      this.clearPendingOpeningGuidance(binding.conversationId);
    }
    const committedBoardChange = event === 'physical-move'
      && snapshot.planned !== true
      && (snapshot.side === 'human' || snapshot.side === 'engine' || snapshot.undo || snapshot.redo);
    if (meaningfulChange && committedBoardChange) {
      this.liveService?.notifyPhysicalBoardUpdated(binding.conversationId, state);
    }
    this.processGuidance(binding.conversationId, snapshot, updated);
    this.processOpeningGuidance(binding.conversationId, snapshot, event);
  }

  processOpeningGuidance(conversationId, snapshot, event) {
    if (event !== 'physical-move' || snapshot.side !== 'engine' || !snapshot.verified) return;
    const activity = this.activityService?.get?.(conversationId);
    if (activity?.config?.boardSource !== 'physical' || activity.type !== 'opening_drill') return;
    const nextUci = activity.config.line?.[activity.stepIndex] || null;
    const complete = activity.state?.pauseReason === 'line_complete';
    const moveText = snapshot.san || snapshot.move || 'the reviewed reply';
    const completedPairIndex = Math.max(0, Math.floor(activity.stepIndex / 2) - 1);
    const teachingCue = activity.config.hints?.[completedPairIndex] || activity.goal || '';
    const nextPairIndex = Math.floor(activity.stepIndex / 2);
    const nextCue = activity.config.hints?.[nextPairIndex] || '';
    const displayText = `Black played ${moveText}.`;
    const reply = complete
      ? `Black played ${moveText}. You completed the reviewed ${activity.title} line: ${activity.goal} Choose Repeat, Continue, or simply make a legal move to continue the game.`
      : `Black played ${moveText}. ${teachingCue} Next, play ${nextUci}. ${nextCue}`.trim();
    const requestId = `physical-opening:${activity.id}:${snapshot.lastMove?.at || snapshot.stateRevision}:${activity.stepIndex}`;
    const prompt = [
      '[PHYSICAL_OPENING_STEP]',
      `Opening: ${activity.title}`,
      `Black just completed the reviewed move ${snapshot.move} (${moveText}).`,
      complete
        ? 'The ten-ply reviewed line is complete. Summarize the opening structure, the main technique the learner practiced, and the usual middlegame plan. Explain that they may choose Repeat or Finish, or simply make any legal move to continue the game.'
        : `The required next learner move is ${nextUci}. Teaching cue for the completed move pair: ${teachingCue}. Teaching cue for the next step: ${nextCue || activity.goal}. Explain why both the learner's previous move and Black's reply belong to the opening, connect them to a technique such as central control, development, king safety, pawn structure, or piece coordination, then clearly ask for ${nextUci}.`,
      'Use three or four concise spoken sentences. Teach the idea and cause-and-effect, not merely the move notation. Do not call a board-changing tool and do not suggest a different move.'
    ].join('\n');
    const deliver = () => {
      try {
        const live = this.liveService?.requestPhysicalTurn(conversationId, {
          requestId,
          displayText,
          prompt,
          urgent: false,
          fallbackAssistantText: reply,
          timeoutMs: 30000,
          queueKey: 'physical-opening'
        });
        if (live) return;
      } catch {
        // Fall through to the persisted deterministic guidance.
      }
      const pair = this.store.createMessagePair(conversationId, {
        requestId,
        text: displayText,
        kind: 'physical',
        assistantContent: reply,
        assistantStatus: 'complete',
        suppressTitle: true
      });
      if (!pair || pair.duplicate) return;
      const conversation = this.store.touchConversation(conversationId);
      this.emit(conversationId, 'mentor-message-start', {
        conversationId,
        requestId,
        message: pair.userMessage
      });
      this.emit(conversationId, 'mentor-message-complete', {
        conversationId,
        requestId,
        message: pair.assistantMessage,
        conversation
      });
    };

    if (!this.liveService?.isConversationActive?.(conversationId)) {
      deliver();
      return;
    }

    this.clearPendingOpeningGuidance(conversationId);
    const expectedMoveAt = snapshot.lastMove?.at || snapshot.stateRevision;
    const timer = setTimeout(() => {
      this.pendingOpeningGuidance.delete(conversationId);
      const current = this.snapshot;
      const currentActivity = this.activityService?.get?.(conversationId);
      const stable = current?.active
        && current.serverInstanceId === snapshot.serverInstanceId
        && Number(current.sessionGeneration) === Number(snapshot.sessionGeneration)
        && current.fen === snapshot.fen
        && (current.lastMove?.at || current.stateRevision) === expectedMoveAt
        && ['ready', 'mentor_drill_complete'].includes(current.phase)
        && currentActivity?.id === activity.id
        && currentActivity.stepIndex === activity.stepIndex;
      if (stable) deliver();
    }, this.openingGuidanceDelayMs);
    timer.unref?.();
    this.pendingOpeningGuidance.set(conversationId, { requestId, timer });
  }

  deliverGuidance(conversationId, snapshot, guidance) {
    const binding = this.store.getPhysicalBinding(conversationId);
    if (!binding || binding.status !== 'active' || binding.lastEventKey === guidance.key) return;
    this.store.updatePhysicalBinding(conversationId, { lastEventKey: guidance.key });
    const occurrenceKey = `${guidance.key}|${Number(snapshot.stateRevision || 0)}`;
    const digest = createHash('sha1').update(occurrenceKey).digest('hex').slice(0, 16);
    const requestId = `physical:${snapshot.sessionGeneration}:${digest}`;
    try {
      const live = this.liveService?.requestPhysicalTurn(conversationId, {
        requestId,
        displayText: guidance.eventText,
        prompt: guidance.prompt,
        urgent: guidance.urgent,
        expectedAssistantText: guidance.urgent ? guidance.reply : null
      });
      if (live) return;
    } catch {
      // Fall through to the persisted deterministic guidance.
    }
    const pair = this.store.createMessagePair(conversationId, {
      requestId,
      text: guidance.eventText,
      kind: 'physical',
      assistantContent: guidance.reply,
      assistantStatus: 'complete',
      suppressTitle: true
    });
    if (!pair || pair.duplicate) return;
    const conversation = this.store.touchConversation(conversationId);
    this.emit(conversationId, 'mentor-message-start', {
      conversationId,
      requestId,
      message: pair.userMessage
    });
    this.emit(conversationId, 'mentor-message-complete', {
      conversationId,
      requestId,
      message: pair.assistantMessage,
      conversation
    });
  }

  processGuidance(conversationId, snapshot, binding) {
    const guidance = guidanceFor(snapshot);
    if (!guidance) {
      this.clearPendingGuidance(conversationId);
      const previousKey = binding.lastEventKey;
      if (isRecoverableGuidanceKey(previousKey) && snapshot.phase !== 'ready') return;
      if (previousKey) this.store.updatePhysicalBinding(conversationId, { lastEventKey: null });
      if (snapshot.phase === 'ready'
          && isRecoverableGuidanceKey(previousKey)
          && this.liveService?.isConversationActive?.(conversationId)) {
        const occurrenceKey = `${previousKey}|recovered|${Number(snapshot.stateRevision || 0)}`;
        const digest = createHash('sha1').update(occurrenceKey).digest('hex').slice(0, 16);
        this.liveService.requestPhysicalTurn(conversationId, {
          requestId: `physical:${snapshot.sessionGeneration}:recovered:${digest}`,
          displayText: 'Physical board restored.',
          prompt: [
            '[PHYSICAL_BOARD_RECOVERED]',
            'The physical board is restored and synchronized.',
            'Briefly acknowledge the restoration, then continue the interrupted chess teaching response from where it stopped.',
            'Do not repeat the recovery warning or repeat sentences that were already completed. Do not move or alter the physical board.'
          ].join('\n'),
          urgent: false,
          replaceOutput: true
        });
      }
      return;
    }
    if (binding.lastEventKey === guidance.key) return;
    if (guidance.type === 'error') {
      this.clearPendingGuidance(conversationId);
      this.deliverGuidance(conversationId, snapshot, guidance);
      return;
    }
    const pending = this.pendingGuidance.get(conversationId);
    if (pending?.key === guidance.key) return;
    this.clearPendingGuidance(conversationId);
    const timer = setTimeout(() => {
      this.pendingGuidance.delete(conversationId);
      const current = this.snapshot;
      const currentGuidance = guidanceFor(current);
      if (currentGuidance?.key === guidance.key) {
        this.deliverGuidance(conversationId, current, currentGuidance);
      }
    }, this.recoverableGuidanceDelayMs);
    timer.unref?.();
    this.pendingGuidance.set(conversationId, { key: guidance.key, timer });
  }
}

module.exports = {
  MentorPhysicalError,
  MentorPhysicalObserverService,
  PHYSICAL_BOARD_ID,
  PHYSICAL_READ_TOOLS,
  guidanceFor,
  normalizeSnapshot,
  sourceKey
};
