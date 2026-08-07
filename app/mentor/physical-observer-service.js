const { createHash } = require('crypto');
const { Chess } = require('chess.js');
const { gameStatus, moveToUci, normalizeAnnotations } = require('./chess-service');
const { STANDARD_FEN } = require('./store');
const { listCatalog } = require('./curriculum');

const PHYSICAL_BOARD_ID = 'main-board';
const PHYSICAL_READ_TOOLS = new Set([
  'set_game_preferences',
  'get_physical_game_status',
  'start_physical_game',
  'attach_physical_game',
  'set_physical_coaching',
  'get_board_state',
  'analyze_position',
  'analyze_move',
  'set_orientation',
  'annotate_board',
  'get_activity_state',
  'start_activity',
  'play_physical_move',
  'pause_activity',
  'resume_activity',
  'confirm_physical_setup',
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
    id: entry.id || `${entry.uci || entry.move}:${entry.createdAt || index + 1}`,
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
    initialFen: snapshot.initialFen || null,
    fen: game.fen(),
    pgn: snapshot.pgn || '',
    orientation: binding.orientation,
    humanColor: snapshot.humanColor || 'white',
    robotColor: snapshot.robotColor || 'black',
    sessionGeneration: Number(snapshot.sessionGeneration),
    configuredLevel: snapshot.configuredLevel || snapshot.level || 1,
    activeSearchLevel: snapshot.activeSearchLevel ?? null,
    difficultyPending: Boolean(snapshot.difficultyPending),
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
      configuredLevel: snapshot.configuredLevel || snapshot.level || 1,
      activeSearchLevel: snapshot.activeSearchLevel ?? null,
      difficultyPending: Boolean(snapshot.difficultyPending),
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
      pendingPromotion: snapshot.pendingPromotion || null,
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
      openingLock: Boolean(snapshot.mentorOpeningLock),
      coaching: {
        mode: binding.coachingMode,
        lastTrigger: binding.lastCoachingTrigger,
        analysisState: binding.coachingAnalysisState || 'idle',
        fullTurnsSinceSummary: binding.fullTurnsSinceSummary
      }
    }
  };
}

function materialScore(fen) {
  const board = String(fen || '').split(' ')[0] || '';
  const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let score = 0;
  for (const piece of board) {
    const value = values[piece.toLowerCase()];
    if (value === undefined) continue;
    score += piece === piece.toUpperCase() ? value : -value;
  }
  return score;
}

function physicalMoveIdentity(move) {
  if (!move) return null;
  return String(move.id || `${move.uci || move.move}:${move.createdAt || move.at || ''}`);
}

function coachingFallback(trigger, humanMove, analysis) {
  const san = humanMove?.san || humanMove?.uci || 'your move';
  if (trigger === 'checkmate') return `That ends the game by checkmate. Review how ${san} changed the king's safety.`;
  if (trigger === 'draw') return 'The game is drawn. This is a good point to review which winning chances disappeared.';
  if (trigger === 'check') return `The position is now in check. Notice how ${san} changed the forcing moves available to both sides.`;
  if (trigger === 'promotion') return `The promotion changed the position sharply. Check the new piece's immediate threats before planning the next move.`;
  if (trigger === 'material_swing') return `The last turn changed the material balance significantly. Recheck every capture and recapture before continuing.`;
  if (['inaccuracy', 'mistake', 'blunder'].includes(trigger)) {
    const alternative = analysis?.bestAlternative?.san || analysis?.before?.bestMove?.san || analysis?.before?.bestMove?.uci;
    return `${san} was classified as a${trigger === 'inaccuracy' ? 'n' : ''} ${trigger}.${alternative ? ` A stronger choice was ${alternative}.` : ''}`;
  }
  return 'Strategic checkpoint: compare piece activity, king safety, and the next pawn break before choosing your plan.';
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

  if (snapshot.pendingPromotion) {
    type = 'promotion_replacement';
    const promotion = snapshot.pendingPromotion;
    eventText = `Physical promotion replacement required on ${promotion.to}.`;
    reply = snapshot.statusText || `Replace the pawn on ${promotion.to} with the requested ${promotion.selectedPiece || promotion.displayedPiece || 'piece'}.`;
  } else if (snapshot.phase === 'sync_warning') {
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
  const keyParts = type === 'promotion_replacement'
    ? [snapshot.serverInstanceId, snapshot.sessionGeneration, type, snapshot.pendingPromotion?.id || '']
    : ['check', 'checkmate', 'draw'].includes(type)
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
    openingGuidanceDelayMs = 1500,
    coachingDelayMs = 1500
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
    this.coachingDelayMs = coachingDelayMs;
    this.pendingGuidance = new Map();
    this.pendingOpeningGuidance = new Map();
    this.pendingCoaching = new Map();
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

  clearPendingCoaching(conversationId) {
    const pending = this.pendingCoaching.get(conversationId);
    if (pending?.timer) clearTimeout(pending.timer);
    pending?.controller?.abort?.();
    this.pendingCoaching.delete(conversationId);
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
      || physical.setupMode !== 'full' || !['setup', 'ready'].includes(physical.phase)
      || (physical.phase === 'ready' && !physical.board?.ready) || physical.robotBusy
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

  requirePracticeStartState(conversationId, expectedRevision) {
    const state = this.getState(conversationId);
    const physical = state.physical;
    if (Number(expectedRevision) !== state.revision) {
      throw new MentorPhysicalError('The physical board changed before the game started.', 'stale_revision', 409, { state });
    }
    if ((physical.phase === 'ready' && !physical.board?.ready) || physical.robotBusy || physical.pendingRobotJob
      || physical.pendingUndo || physical.pendingRedo || physical.pendingPromotion
      || !['setup', 'ready', 'game_over'].includes(physical.phase)) {
      throw new MentorPhysicalError(
        'The physical board must be synchronized and idle before guided play starts.',
        'physical_practice_setup_required',
        409,
        { state }
      );
    }
    if (state.gameStatus.isGameOver) {
      throw new MentorPhysicalError('Start a new physical game before guided play.', 'terminal_position', 409, { state });
    }
    return state;
  }

  playPhysicalMove(conversationId, options) {
    const state = this.getState(conversationId);
    if (Number(options.expectedRevision) !== state.revision) {
      throw new MentorPhysicalError('The physical board changed before the mentor move was queued.', 'stale_revision', 409, { state });
    }
    return this.adapter?.playActivityMove?.(options)
      || Promise.reject(new MentorPhysicalError('Physical mentor move execution is unavailable.', 'physical_move_unavailable', 503));
  }

  startStockfishTurn(conversationId, activity) {
    const state = this.getState(conversationId);
    return this.adapter?.startActivityStockfishTurn?.({
      activityId: activity.id,
      generation: activity.generation,
      expectedRevision: state.revision
    }) || null;
  }

  startScriptedTurn(conversationId, activity) {
    const state = this.getState(conversationId);
    return this.adapter?.startActivityScriptedTurn?.({
      activityId: activity.id,
      generation: activity.generation,
      expectedRevision: state.revision,
      uci: activity.config.line?.[activity.stepIndex]
    }) || null;
  }

  preparePhysicalPuzzle(conversationId, { fen, learnerColor, expectedRevision }) {
    const current = this.getState(conversationId);
    if (Number(expectedRevision) !== current.revision) {
      throw new MentorPhysicalError('The physical board changed before puzzle setup started.', 'stale_revision', 409, { state: current });
    }
    const result = this.adapter?.startCustomActivityGame?.({ fen, humanColor: learnerColor });
    if (!result?.success) {
      throw new MentorPhysicalError('The physical puzzle session could not be started.', 'physical_puzzle_start_failed', 500);
    }
    const snapshot = this.snapshot;
    const detail = this.attach(conversationId, {
      serverInstanceId: snapshot.serverInstanceId,
      sessionGeneration: snapshot.sessionGeneration,
      allowLiveSwitch: true,
      coachingMode: 'off',
      coachingOrigin: 'physical_puzzle'
    });
    return detail.state;
  }

  confirmPhysicalPuzzleSetup(conversationId, activity) {
    const state = this.getState(conversationId);
    if (state.fen !== activity.startFen || !state.physical.board?.ready
      || state.physical.phase !== 'ready' || state.physical.robotBusy
      || state.physical.pendingRobotJob) {
      throw new MentorPhysicalError(
        'The puzzle occupancy is not exact yet. Restore every listed square before confirming piece identity.',
        'physical_puzzle_setup_incomplete',
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
      firstMove ? (activity.learnerColor === 'white'
        ? `You are White; begin with ${firstMove}.`
        : `You are Black. The robot will begin the reviewed line with ${firstMove}.`) : null
    ].filter(Boolean).join(' ');
    const requestId = `physical-opening-start:${activity.id}:${activity.generation}`;
    const prompt = [
      '[PHYSICAL_OPENING_START]',
      `Opening: ${activity.title}`,
      `Main strategic goal: ${activity.goal}`,
      `First reviewed move: ${firstMove}`,
      `Teaching cue: ${firstHint || '(none)'}`,
      'Introduce the opening before play begins. Explain its central strategic idea, what White is trying to achieve, and one technique the learner should watch for.',
      activity.learnerColor === 'white'
        ? `Finish by clearly asking the learner to play ${firstMove}.`
        : `Finish by explaining that the robot will play ${firstMove}, then the learner will answer as Black.`,
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

  announcePhysicalPuzzleSetup(activity) {
    const checklist = activity.config.setupChecklist
      .map((item) => `${item.color} ${item.piece} on ${item.square}`)
      .join(', ');
    const reply = `Set up ${activity.title}: ${checklist}. When every piece is placed and the board shows no missing or extra squares, say that the setup is confirmed.`;
    const requestId = `physical-puzzle-setup:${activity.id}:${activity.generation}`;
    const live = this.liveService?.requestPhysicalTurn(activity.conversationId, {
      requestId,
      displayText: `${activity.title} setup required.`,
      prompt: `[PHYSICAL_PUZZLE_SETUP]\n${reply}\nRead the checklist clearly. Do not call tools until the learner confirms setup.`,
      urgent: false,
      fallbackAssistantText: reply,
      timeoutMs: 30000,
      queueKey: 'physical-puzzle'
    });
    if (live) return live;
    return this.persistCoachingMessage(activity.conversationId, requestId, `${activity.title} setup required.`, reply);
  }

  announcePhysicalPractice(activity) {
    if (!activity || activity.config?.boardSource !== 'physical' || activity.type !== 'practice_game') return null;
    const mode = activity.config.opponentMode === 'mentor' ? 'Mentor-led' : 'Stockfish-led';
    const reply = activity.config.opponentMode === 'mentor'
      ? `The ${mode} game is ready. You are ${activity.learnerColor}. I will choose verified replies, explain my plan directly, and tell you plainly when a move is weak.`
      : `The ${mode} game is ready. You are ${activity.learnerColor}. Stockfish will play the opponent moves, and I will explain each completed turn directly.`;
    const requestId = `physical-practice-start:${activity.id}:${activity.generation}`;
    const live = this.liveService?.requestPhysicalTurn(activity.conversationId, {
      requestId,
      displayText: `${mode} physical game started.`,
      prompt: `[PHYSICAL_PRACTICE_START]\n${reply}\nUse two concise spoken sentences. Do not call tools.`,
      urgent: false,
      fallbackAssistantText: reply,
      timeoutMs: 30000,
      queueKey: 'physical-practice'
    });
    if (live) return live;
    return this.persistCoachingMessage(activity.conversationId, requestId, `${mode} physical game started.`, reply);
  }

  processPhysicalPracticeGuidance(conversationId, snapshot, event) {
    if (event !== 'physical-move' || snapshot.side !== 'engine' || !snapshot.verified) return;
    const activity = this.activityService?.get?.(conversationId);
    if (activity?.config?.boardSource !== 'physical' || activity.type !== 'practice_game'
      || activity.config.opponentMode !== 'stockfish') return;
    const humanMove = [...(snapshot.moveLog || snapshot.physicalMoveLog || [])]
      .reverse()
      .find((move) => move.side === 'human');
    if (!humanMove) return;
    const expectedFen = snapshot.fen;
    const expectedRevision = Number(snapshot.stateRevision || 0);
    const requestId = `physical-practice-turn:${activity.id}:${humanMove.id}:${snapshot.lastMove?.at || expectedRevision}`;
    const timer = setTimeout(async () => {
      const current = this.snapshot;
      if (!current?.board?.ready || current.fen !== expectedFen
        || Number(current.stateRevision || 0) !== expectedRevision
        || current.phase !== 'ready') return;
      let analysis = null;
      try {
        const state = this.getState(conversationId);
        analysis = await this.analysisService.analyzeMoveState({
          ...state,
          history: [humanMove]
        }, {
          mode: 'quick',
          assertCurrent: () => this.assertAnalysisCurrent(conversationId, state)
        });
      } catch {
        // The fallback still gives a concise turn summary when engine analysis is unavailable.
      }
      const classification = analysis?.classification || 'unclassified';
      const best = analysis?.bestAlternative?.san || analysis?.before?.bestMove?.san || analysis?.before?.bestMove?.uci || null;
      const fallback = ['inaccuracy', 'mistake', 'blunder'].includes(classification)
        ? `${humanMove.san || humanMove.uci} was a ${classification}.${best ? ` ${best} was stronger.` : ''} The consequence is visible in the opponent's reply; address that before starting another plan.`
        : `Turn complete. ${humanMove.san || humanMove.uci} was ${classification}.${best ? ` The main alternative was ${best}.` : ''} Now compare piece activity, king safety, and the next forcing move.`;
      const prompt = [
        '[PHYSICAL_PRACTICE_TURN]',
        `Learner move: ${humanMove.uci} (${humanMove.san || humanMove.uci})`,
        `Classification: ${classification}`,
        `Centipawn loss: ${analysis?.centipawnLoss ?? 'unavailable'}`,
        `Best alternative: ${best || 'unavailable'}`,
        `Opponent reply: ${snapshot.san || snapshot.move}`,
        `Activity goal: ${activity.goal}`,
        'Explain the learner move, the opponent reply, and the current plan in two or three concise spoken sentences.',
        'Be blunt but respectful. State mistakes plainly, explain the concrete consequence, and give the correction without praise padding. Do not call tools.'
      ].join('\n');
      try {
        const live = this.liveService?.requestPhysicalTurn(conversationId, {
          requestId,
          displayText: `Turn complete after ${humanMove.san || humanMove.uci}.`,
          prompt,
          urgent: false,
          fallbackAssistantText: fallback,
          timeoutMs: 30000,
          queueKey: 'physical-practice'
        });
        if (live) return;
      } catch {
        // Persist the deterministic explanation below.
      }
      this.persistCoachingMessage(conversationId, requestId, `Turn complete after ${humanMove.san || humanMove.uci}.`, fallback);
    }, this.coachingDelayMs);
    timer.unref?.();
  }

  retryPhysicalOpening(conversationId) {
    this.requireCurrentBinding(conversationId);
    return this.adapter?.retryOpeningDrill?.() || { success: false };
  }

  resolvePhysicalOpening(conversationId, action) {
    this.requireCurrentBinding(conversationId);
    const result = this.adapter?.resolveOpeningDrill?.(action) || { success: false };
    if (action === 'continue') this.setCoaching(conversationId, 'selective', 'opening_continue');
    return result;
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
    const adapterStatus = this.adapter?.getGameStatus?.() || null;
    return {
      available: Boolean(this.snapshot?.active && this.snapshot.phase !== 'idle'),
      boardId: this.boardId,
      serverInstanceId: this.snapshot?.serverInstanceId || null,
      sessionGeneration: Number(this.snapshot?.sessionGeneration || 0),
      stateRevision: Number(this.snapshot?.stateRevision || 0),
      phase: this.snapshot?.phase || 'idle',
      statusText: this.snapshot?.statusText || 'Physical board unavailable.',
      sensorFresh: Boolean(adapterStatus?.sensorFresh),
      sensorAgeMs: adapterStatus?.sensorAgeMs ?? null,
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

  attach(conversationId, {
    serverInstanceId,
    sessionGeneration,
    allowLiveSwitch = false,
    coachingMode = 'prompt_pending',
    coachingOrigin = 'manual'
  } = {}) {
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
    if (!allowLiveSwitch && this.textService?.hasActiveConversation(conversationId)) {
      throw new MentorPhysicalError('Stop the current mentor response before attaching the physical board.', 'mentor_text_active', 409);
    }
    if (!allowLiveSwitch && this.liveService?.isConversationActive(conversationId)) {
      throw new MentorPhysicalError('Stop Live voice before changing the board source.', 'mentor_live_active', 409);
    }
    const virtualState = this.chessService.getState(conversationId);
    const result = this.store.attachPhysicalBinding(conversationId, {
      boardId: this.boardId,
      serverInstanceId,
      sessionGeneration: Number(sessionGeneration),
      stateRevision: Number(this.snapshot.stateRevision || 0),
      orientation: virtualState.orientation,
      coachingMode,
      coachingOrigin
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
    if (coachingMode === 'prompt_pending') this.promptForManualCoaching(conversationId);
    if (allowLiveSwitch) this.liveService?.requestContextReconnect?.(conversationId, 'physical_board_attached');
    return detail;
  }

  getPhysicalGameStatus(conversationId = null) {
    const availability = this.availability();
    return {
      ...availability,
      attachedToThisConversation: Boolean(
        conversationId && availability.boundConversationId === conversationId
      ),
      canStart: !availability.available && availability.sensorFresh
    };
  }

  assertPhysicalIntent(conversationId, requestId) {
    const messages = this.store.getRequestMessages(conversationId, requestId);
    const current = messages.find((message) => message.role === 'user')?.content || '';
    const explicit = /\bphysical\b|\breal (?:chess )?board\b|\bon the (?:chess )?board\b/i.test(current);
    if (explicit) return true;
    const conversation = this.store.getConversation(conversationId);
    const recent = (conversation?.messages || []).slice(-4);
    const affirmative = /^(yes|yeah|yep|physical|the physical one|board)$/i.test(current.trim());
    const askedChoice = recent.some((message) => message.role === 'model'
      && /physical\s+or\s+virtual|attach.{0,40}physical|physical.{0,40}attach/i.test(message.content));
    if (affirmative && askedChoice) return true;
    throw new MentorPhysicalError(
      'Ask the learner whether they want a Physical or Virtual game before starting anything.',
      'physical_game_choice_required',
      409
    );
  }

  startPhysicalGame(conversationId, { requestId, requireIntent = true } = {}) {
    if (!this.store.getConversation(conversationId)) {
      throw new MentorPhysicalError('Conversation not found.', 'conversation_not_found', 404);
    }
    if (requireIntent) this.assertPhysicalIntent(conversationId, requestId);
    const existingAction = requestId && this.store.getPhysicalAction(conversationId, requestId);
    if (existingAction?.status === 'complete') return { ...existingAction.result, duplicate: true };
    if (existingAction?.status === 'failed') {
      throw new MentorPhysicalError(
        'This physical-game request already failed and will not be replayed.',
        existingAction.errorCode || 'physical_start_failed',
        409
      );
    }
    const status = this.getPhysicalGameStatus(conversationId);
    if (status.available) {
      if (status.boundConversationId === conversationId) {
        const result = { started: false, attached: true, physicalBoard: this.detail(conversationId) };
        if (requestId) this.store.savePhysicalAction(conversationId, requestId, 'start', result);
        return result;
      }
      if (status.boundConversationId) {
        throw new MentorPhysicalError(
          'The active physical game is attached to another conversation.',
          'physical_board_already_attached',
          409
        );
      }
      throw new MentorPhysicalError(
        'A physical game is already active. Ask the learner to confirm attaching to the existing game.',
        'physical_game_attach_confirmation_required',
        409,
        { physicalStatus: status }
      );
    }
    if (!status.sensorFresh) {
      throw new MentorPhysicalError(
        'The ESP32 sensor connection is stale. Reconnect the board before starting a physical game.',
        'physical_sensor_stale',
        409,
        { sensorAgeMs: status.sensorAgeMs }
      );
    }
    try {
      this.adapter?.startDefaultGame?.();
      const detail = this.attach(conversationId, {
        serverInstanceId: this.snapshot.serverInstanceId,
        sessionGeneration: this.snapshot.sessionGeneration,
        allowLiveSwitch: true,
        coachingMode: 'selective',
        coachingOrigin: 'gemini_started'
      });
      const result = { started: true, attached: true, physicalBoard: detail };
      if (requestId) this.store.savePhysicalAction(conversationId, requestId, 'start', result);
      return result;
    } catch (error) {
      if (requestId) this.store.savePhysicalAction(conversationId, requestId, 'start', null, error.code || 'physical_start_failed');
      throw error;
    }
  }

  attachPhysicalGame(conversationId, { requestId, requireIntent = true } = {}) {
    if (requireIntent) this.assertPhysicalIntent(conversationId, requestId);
    const existingAction = requestId && this.store.getPhysicalAction(conversationId, requestId);
    if (existingAction?.status === 'complete') return { ...existingAction.result, duplicate: true };
    if (existingAction?.status === 'failed') {
      throw new MentorPhysicalError(
        'This physical-board attachment request already failed and will not be replayed.',
        existingAction.errorCode || 'physical_attach_failed',
        409
      );
    }
    const status = this.getPhysicalGameStatus(conversationId);
    if (!status.available) {
      throw new MentorPhysicalError('There is no active physical game to attach.', 'physical_board_unavailable', 409);
    }
    if (status.boundConversationId === conversationId) {
      const result = { started: false, attached: true, physicalBoard: this.detail(conversationId) };
      if (requestId) this.store.savePhysicalAction(conversationId, requestId, 'attach', result);
      return result;
    }
    const detail = this.attach(conversationId, {
      serverInstanceId: status.serverInstanceId,
      sessionGeneration: status.sessionGeneration,
      allowLiveSwitch: true,
      coachingMode: 'prompt_pending',
      coachingOrigin: 'mentor_attach'
    });
    const result = { started: false, attached: true, physicalBoard: detail };
    if (requestId) this.store.savePhysicalAction(conversationId, requestId, 'attach', result);
    return result;
  }

  setCoaching(conversationId, mode, origin = 'user') {
    this.requireCurrentBinding(conversationId);
    if (!['off', 'prompt_pending', 'selective'].includes(mode)) {
      throw new MentorPhysicalError('Coaching mode must be off or selective.', 'invalid_coaching_mode');
    }
    if (mode === 'off') this.clearPendingCoaching(conversationId);
    const binding = this.store.updatePhysicalBinding(conversationId, {
      coachingMode: mode,
      coachingOrigin: origin,
      coachingPromptedAt: mode === 'prompt_pending' ? Date.now() : null,
      ...(mode === 'selective' ? { fullTurnsSinceSummary: 0 } : {})
    });
    const detail = this.detail(conversationId);
    this.emit(conversationId, 'mentor-physical-binding-updated', { conversationId, physicalBoard: detail });
    return { binding, physicalBoard: detail };
  }

  promptForManualCoaching(conversationId) {
    const binding = this.store.getPhysicalBinding(conversationId);
    if (!binding || binding.coachingMode !== 'prompt_pending' || binding.coachingPromptedAt) return null;
    this.store.updatePhysicalBinding(conversationId, { coachingPromptedAt: Date.now() });
    const requestId = `physical-coaching-prompt:${binding.sessionGeneration}`;
    const pair = this.store.createMessagePair(conversationId, {
      requestId,
      text: 'Physical board attached.',
      kind: 'physical',
      assistantContent: 'Would you like selective coaching during this physical game? I will speak only at important moments and after every three complete turns.',
      assistantStatus: 'complete',
      suppressTitle: true
    });
    if (!pair || pair.duplicate) return pair;
    this.emit(conversationId, 'mentor-message-start', { conversationId, requestId, message: pair.userMessage });
    this.emit(conversationId, 'mentor-message-complete', {
      conversationId,
      requestId,
      message: pair.assistantMessage,
      conversation: this.store.touchConversation(conversationId)
    });
    return pair;
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
    this.clearPendingCoaching(conversationId);
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
    const reviewedPuzzles = listCatalog('puzzle')
      .filter((item) => item.supportsPhysical)
      .map((item) => `${item.title} [${item.id}, ${item.difficultyBand}]`)
      .join(', ');
    const openingContext = activity?.config?.boardSource === 'physical'
      ? [
          `Active physical activity: ${activity.title} (${activity.type})`,
          `Activity goal: ${activity.goal}`,
          activity.type === 'practice_game'
            ? `Opponent mode: ${activity.config.opponentMode}. Current activity phase: ${activity.phase}.`
            : `Opening step: ${Math.min(activity.stepIndex + 1, activity.totalSteps)} of ${activity.totalSteps}`,
          activity.type === 'practice_game'
            ? `Strategic plan: ${activity.state?.strategicPlan || '(not set yet)'}`
            : `Required next move: ${activity.config.line?.[activity.stepIndex] || '(line complete)'}`,
          activity.type === 'practice_game'
            ? 'In mentor mode, use Stockfish evidence and play_physical_move on the assigned turn. In Stockfish mode, the backend chooses the robot move.'
            : activity.state?.pauseReason === 'puzzle_setup'
              ? `Setup checklist: ${activity.config.setupChecklist?.map((item) => `${item.color} ${item.piece} ${item.square}`).join(', ')}`
              : 'The activity coordinator enforces and executes the reviewed line.'
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
      `Reviewed physical puzzles: ${reviewedPuzzles}`,
      activity?.type === 'practice_game' && activity.config?.opponentMode === 'mentor'
        ? 'During your assigned mentor turn, you may use play_physical_move after Stockfish verification. You cannot access motors, routes, magnets, or command queues.'
        : 'You may analyze or annotate this position, but you cannot directly move, reset, load, or demonstrate on the physical board.',
      'You may start a reviewed opening from the exact standard position or a reviewed puzzle through its guided custom setup.',
      'Never claim a physical move succeeded until its tool result confirms exact hardware verification.'
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

  coachingTrigger(snapshot, humanMove, analysis, fullTurnsSinceSummary) {
    if (snapshot.gameStatus?.checkmate) return 'checkmate';
    if (snapshot.gameStatus?.draw) return 'draw';
    if (snapshot.gameStatus?.inCheck) return 'check';
    if (humanMove?.promotion) return 'promotion';
    if (analysis?.mateImpact) return analysis.classification || 'mate_override';
    if (['inaccuracy', 'mistake', 'blunder'].includes(analysis?.classification)) {
      return analysis.classification;
    }
    if (humanMove?.before && Math.abs(materialScore(snapshot.fen) - materialScore(humanMove.before)) >= 3) {
      return 'material_swing';
    }
    if (fullTurnsSinceSummary >= 3) return 'strategic_summary';
    return null;
  }

  coachingStillCurrent(conversationId, expected) {
    const binding = this.store.getPhysicalBinding(conversationId);
    const snapshot = this.snapshot;
    return Boolean(
      binding?.status === 'active'
      && binding.coachingMode === 'selective'
      && snapshot?.active
      && snapshot.serverInstanceId === expected.serverInstanceId
      && Number(snapshot.sessionGeneration) === expected.sessionGeneration
      && Number(snapshot.stateRevision || 0) === expected.stateRevision
      && snapshot.fen === expected.fen
      && physicalMoveIdentity(snapshot.lastMove) === expected.lastMoveId
      && snapshot.phase === 'ready'
      && snapshot.board?.ready
      && !snapshot.robotBusy
      && !snapshot.pendingRobotJob
    );
  }

  persistCoachingMessage(conversationId, requestId, displayText, reply) {
    const pair = this.store.createMessagePair(conversationId, {
      requestId,
      text: displayText,
      kind: 'physical',
      assistantContent: reply,
      assistantStatus: 'complete',
      suppressTitle: true
    });
    if (!pair || pair.duplicate) return pair;
    this.emit(conversationId, 'mentor-message-start', { conversationId, requestId, message: pair.userMessage });
    this.emit(conversationId, 'mentor-message-complete', {
      conversationId,
      requestId,
      message: pair.assistantMessage,
      conversation: this.store.touchConversation(conversationId)
    });
    return pair;
  }

  async runSelectiveCoaching(conversationId, expected, humanMove, nextTurnCount) {
    if (!this.coachingStillCurrent(conversationId, expected)) return;
    const controller = new AbortController();
    const pending = this.pendingCoaching.get(conversationId);
    if (pending) pending.controller = controller;
    this.emit(conversationId, 'mentor-physical-coaching-updated', {
      conversationId,
      mode: 'selective',
      analysisState: 'analyzing',
      text: 'Analyzing your move'
    });
    let analysis = null;
    try {
      const state = this.getState(conversationId);
      analysis = await this.analysisService.analyzeMoveState({
        ...state,
        history: [humanMove]
      }, {
        mode: 'quick',
        signal: controller.signal,
        assertCurrent: () => {
          if (!this.coachingStillCurrent(conversationId, expected)) {
            throw new MentorPhysicalError('The physical position changed during coaching analysis.', 'stale_analysis', 409);
          }
        }
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'stale_analysis') return;
    }
    if (!this.coachingStillCurrent(conversationId, expected)) return;
    const trigger = this.coachingTrigger(this.snapshot, humanMove, analysis, nextTurnCount);
    if (!trigger) {
      this.store.updatePhysicalBinding(conversationId, { fullTurnsSinceSummary: nextTurnCount });
      this.emit(conversationId, 'mentor-physical-coaching-updated', {
        conversationId,
        mode: 'selective',
        analysisState: 'idle',
        text: 'Selective coaching on'
      });
      return;
    }

    const binding = this.store.getPhysicalBinding(conversationId);
    if (binding.lastCoachingFen === expected.fen && binding.lastCoachedMoveId === expected.humanMoveId) return;
    const fallback = coachingFallback(trigger, humanMove, analysis);
    const requestId = `physical-coaching:${expected.sessionGeneration}:${expected.humanMoveId}:${trigger}`
      .replace(/[^A-Za-z0-9._:-]/g, '_');
    const activity = this.activityService?.get?.(conversationId);
    const prompt = [
      '[PHYSICAL_SELECTIVE_COACHING]',
      `Trigger: ${trigger}`,
      `Learner move: ${humanMove.uci} (${humanMove.san || humanMove.uci})`,
      `Move classification: ${analysis?.classification || 'not available'}`,
      `Centipawn loss: ${analysis?.centipawnLoss ?? 'not available'}`,
      `Mate impact: ${analysis?.mateImpact || 'none'}`,
      `Best alternative: ${analysis?.bestAlternative?.san || analysis?.before?.bestMove?.san || analysis?.before?.bestMove?.uci || 'not available'}`,
      `Recent moves: ${this.getState(conversationId).history.slice(-8).map((move) => move.san).join(' ')}`,
      activity ? `Current lesson or opening: ${activity.title}. Goal: ${activity.goal}` : 'No structured activity is active.',
      `Recent advice fingerprints: ${binding.adviceFingerprints.join(', ') || '(none)'}`,
      'Explain one useful cause-and-effect lesson from this position in two or three concise spoken sentences.',
      'Do not merely restate the move notation. Do not move or alter the physical board, and avoid repeating recent advice.'
    ].join('\n');
    const fingerprint = createHash('sha1').update(`${trigger}|${fallback}`).digest('hex').slice(0, 12);
    this.store.updatePhysicalBinding(conversationId, {
      lastCoachedRevision: expected.stateRevision,
      lastCoachedMoveId: expected.humanMoveId,
      lastCoachingTrigger: trigger,
      lastCoachingFen: expected.fen,
      fullTurnsSinceSummary: nextTurnCount >= 3 ? 0 : nextTurnCount,
      adviceFingerprints: [...binding.adviceFingerprints, fingerprint].slice(-8)
    });
    this.emit(conversationId, 'mentor-physical-coaching-updated', {
      conversationId,
      mode: 'selective',
      analysisState: 'explaining',
      trigger,
      text: 'Mentor explaining'
    });
    try {
      const live = this.liveService?.requestPhysicalTurn(conversationId, {
        requestId,
        displayText: `Coaching after ${humanMove.san || humanMove.uci}.`,
        prompt,
        urgent: false,
        fallbackAssistantText: fallback,
        timeoutMs: 30000,
        queueKey: 'physical-selective-coaching',
        validateBeforeStart: () => this.coachingStillCurrent(conversationId, expected)
      });
      if (live) return;
    } catch {
      // Persist the deterministic fallback if Live cannot accept the turn.
    }
    this.persistCoachingMessage(
      conversationId,
      requestId,
      `Coaching after ${humanMove.san || humanMove.uci}.`,
      fallback
    );
  }

  scheduleSelectiveCoaching(conversationId, snapshot) {
    const binding = this.store.getPhysicalBinding(conversationId);
    if (!binding || binding.coachingMode !== 'selective') return;
    if (this.activityService?.get?.(conversationId)?.config?.boardSource === 'physical') return;
    const state = normalizeSnapshot(snapshot, binding);
    const humanMove = [...state.history].reverse().find((move) => move.side === 'human');
    const humanMoveId = physicalMoveIdentity(humanMove);
    const robotMoveId = physicalMoveIdentity(state.history.at(-1));
    if (!humanMove || !humanMoveId || !robotMoveId || binding.lastObservedRobotMoveId === robotMoveId) return;
    const updated = this.store.updatePhysicalBinding(conversationId, {
      lastObservedRobotMoveId: robotMoveId
    });
    const expected = {
      serverInstanceId: snapshot.serverInstanceId,
      sessionGeneration: Number(snapshot.sessionGeneration),
      stateRevision: Number(snapshot.stateRevision || 0),
      fen: snapshot.fen,
      lastMoveId: physicalMoveIdentity(snapshot.lastMove),
      humanMoveId
    };
    this.clearPendingCoaching(conversationId);
    const timer = setTimeout(() => {
      const current = this.pendingCoaching.get(conversationId);
      if (!current || current.expected.fen !== expected.fen) return;
      this.runSelectiveCoaching(
        conversationId,
        expected,
        humanMove,
        Number(updated.fullTurnsSinceSummary || 0) + 1
      ).finally(() => {
        if (this.pendingCoaching.get(conversationId)?.expected.fen === expected.fen) {
          this.pendingCoaching.delete(conversationId);
        }
      });
    }, this.coachingDelayMs);
    timer.unref?.();
    this.pendingCoaching.set(conversationId, { timer, expected, controller: null });
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
      this.clearPendingCoaching(binding.conversationId);
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
    this.processPhysicalPracticeGuidance(binding.conversationId, snapshot, event);
    if (event === 'physical-move' && snapshot.side === 'engine' && snapshot.verified) {
      this.scheduleSelectiveCoaching(binding.conversationId, snapshot);
    }
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
    const opponentName = activity.mentorColor === 'white' ? 'White' : 'Black';
    const displayText = `${opponentName} played ${moveText}.`;
    const reply = complete
      ? `${opponentName} played ${moveText}. You completed the reviewed ${activity.title} line: ${activity.goal} Choose Repeat, Continue, or simply make a legal move to continue the game.`
      : `${opponentName} played ${moveText}. ${teachingCue} Next, play ${nextUci}. ${nextCue}`.trim();
    const requestId = `physical-opening:${activity.id}:${snapshot.lastMove?.at || snapshot.stateRevision}:${activity.stepIndex}`;
    const prompt = [
      '[PHYSICAL_OPENING_STEP]',
      `Opening: ${activity.title}`,
      `${opponentName} just completed the reviewed move ${snapshot.move} (${moveText}).`,
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
