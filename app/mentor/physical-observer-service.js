const { createHash } = require('crypto');
const { Chess } = require('chess.js');
const { gameStatus, moveToUci, normalizeAnnotations } = require('./chess-service');

const PHYSICAL_BOARD_ID = 'main-board';
const PHYSICAL_READ_TOOLS = new Set([
  'get_board_state',
  'analyze_position',
  'analyze_move',
  'set_orientation',
  'annotate_board'
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
      statusText: snapshot.statusText,
      robotBusy: Boolean(snapshot.robotBusy),
      pendingRobotJob: snapshot.pendingRobotJob || null,
      pendingUndo: snapshot.pendingUndo || null,
      pendingRedo: snapshot.pendingRedo || null,
      selectedSource: snapshot.selectedSource || null,
      legalTargets: snapshot.legalTargets || [],
      board: snapshot.board || { ready: true, missingSquares: [], extraSquares: [] },
      calibration: snapshot.calibration || null,
      lastSnapshotAt: snapshot.lastSnapshotAt || null,
      lastError: snapshot.lastError || null,
      syncWarningReason: snapshot.syncWarningReason || null,
      lastMove: snapshot.lastMove || null
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
    reply = diff
      ? `Please restore or center the indicated pieces. The board reports ${diff}.`
      : (snapshot.statusText || 'Please restore the physical board to the expected position.');
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
  } else if (snapshot.gameStatus?.checkmate) {
    type = 'checkmate';
    eventText = snapshot.gameStatus.resultText || 'Checkmate.';
    reply = eventText;
  } else if (snapshot.gameStatus?.draw) {
    type = 'draw';
    eventText = snapshot.gameStatus.resultText || 'The physical game is drawn.';
    reply = eventText;
  } else if (snapshot.gameStatus?.inCheck) {
    type = 'check';
    eventText = `${snapshot.gameStatus.resultText || 'Check.'}${snapshot.gameStatus.checkedKingSquare ? ` King on ${snapshot.gameStatus.checkedKingSquare}.` : ''}`;
    reply = eventText;
  }

  if (!type) return null;
  const keyParts = [
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
  constructor({ store, chessService, analysisService, emit = () => {}, boardId = PHYSICAL_BOARD_ID }) {
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
  }

  setDependencies({ textService, liveService, activityService }) {
    this.textService = textService;
    this.liveService = liveService;
    this.activityService = activityService;
  }

  setAdapter(adapter) {
    this.adapter = adapter;
    const snapshot = adapter?.getSnapshot?.();
    if (snapshot) this.handleSnapshot(snapshot, 'physical-status');
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
      'You may analyze or annotate this position, but you cannot move, reset, load, demonstrate, or otherwise control the physical board.',
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
    if (meaningfulChange) this.liveService?.notifyPhysicalBoardUpdated(binding.conversationId, state);
    this.processGuidance(binding.conversationId, snapshot, updated);
  }

  processGuidance(conversationId, snapshot, binding) {
    const guidance = guidanceFor(snapshot);
    if (!guidance) {
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
      // Fall through to a deterministic text-only response.
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
