const { randomUUID } = require('crypto');
const { Chess } = require('chess.js');

const ANNOTATION_ROLES = new Set(['idea', 'good', 'warning', 'danger', 'special']);
const SQUARE_PATTERN = /^[a-h][1-8]$/;

class MentorChessError extends Error {
  constructor(message, statusCode = 400, details = {}) {
    super(message);
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

function normalizeActionId(actionId) {
  const value = actionId || randomUUID();
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new MentorChessError('actionId must contain 1-128 letters, numbers, dots, colons, dashes, or underscores.');
  }
  return value;
}

function requireRevision(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new MentorChessError('expectedRevision must be a non-negative integer.');
  }
  return value;
}

function normalizeFen(fen) {
  if (typeof fen !== 'string' || !fen.trim()) {
    throw new MentorChessError('A valid FEN is required.');
  }
  try {
    return new Chess(fen.trim()).fen();
  } catch (error) {
    throw new MentorChessError(`Invalid FEN: ${error.message}`);
  }
}

function moveToUci(move) {
  return `${move.from}${move.to}${move.promotion || ''}`;
}

function normalizeAnnotations({ highlights = [], arrows = [] } = {}) {
  if (!Array.isArray(highlights) || highlights.length > 16) {
    throw new MentorChessError('Highlights must be an array containing at most 16 squares.');
  }
  if (!Array.isArray(arrows) || arrows.length > 12) {
    throw new MentorChessError('Arrows must be an array containing at most 12 arrows.');
  }
  const normalizedHighlights = highlights.map((highlight) => {
    if (!highlight || !SQUARE_PATTERN.test(highlight.square) || !ANNOTATION_ROLES.has(highlight.role)) {
      throw new MentorChessError('Each highlight needs a valid square and semantic role.');
    }
    return { square: highlight.square, role: highlight.role };
  });
  const normalizedArrows = arrows.map((arrow) => {
    if (!arrow || !SQUARE_PATTERN.test(arrow.from) || !SQUARE_PATTERN.test(arrow.to)
      || arrow.from === arrow.to || !ANNOTATION_ROLES.has(arrow.role)) {
      throw new MentorChessError('Each arrow needs distinct valid squares and a semantic role.');
    }
    return { from: arrow.from, to: arrow.to, role: arrow.role };
  });
  return {
    highlights: [...new Map(normalizedHighlights.map((item) => [`${item.square}:${item.role}`, item])).values()],
    arrows: [...new Map(normalizedArrows.map((item) => [`${item.from}:${item.to}:${item.role}`, item])).values()]
  };
}

function serializeMove(move, index) {
  return {
    ply: index + 1,
    uci: moveToUci(move),
    san: move.san,
    lan: move.lan,
    from: move.from,
    to: move.to,
    color: move.color,
    piece: move.piece,
    captured: move.captured || null,
    promotion: move.promotion || null,
    before: move.before,
    after: move.after
  };
}

function gameStatus(game) {
  let status = game.isCheck() ? 'check' : 'ongoing';
  let resultText = game.isCheck() ? `${game.turn() === 'w' ? 'White' : 'Black'} is in check` : 'Game in progress';
  let winner = null;
  let drawReason = null;

  if (game.isCheckmate()) {
    status = 'checkmate';
    winner = game.turn() === 'w' ? 'black' : 'white';
    resultText = `${winner === 'white' ? 'White' : 'Black'} wins by checkmate`;
  } else if (game.isStalemate()) {
    status = 'stalemate';
    drawReason = 'stalemate';
    resultText = 'Draw by stalemate';
  } else if (game.isInsufficientMaterial()) {
    status = 'draw';
    drawReason = 'insufficient_material';
    resultText = 'Draw by insufficient material';
  } else if (game.isThreefoldRepetition()) {
    status = 'draw';
    drawReason = 'threefold_repetition';
    resultText = 'Draw by threefold repetition';
  } else if (game.isDrawByFiftyMoves()) {
    status = 'draw';
    drawReason = 'fifty_move_rule';
    resultText = 'Draw by the fifty-move rule';
  } else if (game.isDraw()) {
    status = 'draw';
    drawReason = 'draw';
    resultText = 'Draw';
  }

  return {
    status,
    resultText,
    winner,
    drawReason,
    inCheck: game.isCheck(),
    isGameOver: game.isGameOver()
  };
}

class MentorChessService {
  constructor({ store }) {
    this.store = store;
  }

  reconstruct(conversationId) {
    const session = this.store.getChessSession(conversationId);
    if (!session) throw new MentorChessError('Conversation not found.', 404);
    const game = new Chess(session.initialFen);
    const events = this.store.listBoardEvents(conversationId);

    for (const event of events) {
      if (event.type === 'move') {
        const move = game.move({
          from: event.payload.from,
          to: event.payload.to,
          promotion: event.payload.promotion || undefined
        });
        if (!move) throw new Error(`Unable to reconstruct board event ${event.id}.`);
      } else if (event.type === 'set_position') {
        game.load(event.payload.fen);
      } else if (event.type === 'reset') {
        game.load(session.initialFen);
      }
    }

    return { session, events, game };
  }

  serialize(conversationId, reconstructed = this.reconstruct(conversationId)) {
    const { session, events, game } = reconstructed;
    const history = game.history({ verbose: true }).map(serializeMove);
    const legalMoves = game.moves({ verbose: true }).map(moveToUci).sort();
    return {
      conversationId,
      initialFen: session.initialFen,
      fen: game.fen(),
      pgn: game.pgn(),
      orientation: session.orientation,
      revision: session.revision,
      turn: game.turn(),
      turnName: game.turn() === 'w' ? 'White' : 'Black',
      history,
      legalMoves,
      annotations: this.store.getBoardAnnotations(conversationId, session.revision),
      gameStatus: gameStatus(game),
      events,
      cacheConsistent: session.currentFen === game.fen() && session.pgn === game.pgn()
    };
  }

  getState(conversationId) {
    return this.serialize(conversationId);
  }

  commit({ conversationId, expectedRevision, eventType, actionId, payload, before, game, orientation }) {
    const result = this.store.commitBoardMutation({
      conversationId,
      expectedRevision,
      eventType,
      actionId,
      payload,
      beforeFen: before.fen(),
      afterFen: game.fen(),
      pgn: game.pgn(),
      orientation
    });
    if (result.status === 'not_found') throw new MentorChessError('Conversation not found.', 404);
    if (result.status === 'stale') {
      throw new MentorChessError('The chess position changed before this action was committed.', 409, {
        code: 'stale_revision',
        state: this.getState(conversationId)
      });
    }
    return {
      duplicate: result.status === 'duplicate',
      actionId,
      event: result.event,
      state: this.getState(conversationId)
    };
  }

  move(conversationId, { uci, expectedRevision, actionId }) {
    const revision = requireRevision(expectedRevision);
    const normalizedAction = normalizeActionId(actionId);
    const duplicate = this.store.getBoardEventByAction(conversationId, normalizedAction);
    if (duplicate) {
      return { duplicate: true, actionId: normalizedAction, event: duplicate, state: this.getState(conversationId) };
    }
    if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
      throw new MentorChessError('Move must use UCI notation, for example e2e4 or a7a8q.');
    }

    const reconstructed = this.reconstruct(conversationId);
    const before = new Chess(reconstructed.game.fen());
    let move;
    try {
      move = reconstructed.game.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4]
      });
    } catch {
      move = null;
    }
    if (!move) throw new MentorChessError(`Illegal move: ${uci}.`);

    return this.commit({
      conversationId,
      expectedRevision: revision,
      eventType: 'move',
      actionId: normalizedAction,
      payload: {
        uci: moveToUci(move),
        san: move.san,
        from: move.from,
        to: move.to,
        promotion: move.promotion || null
      },
      before,
      game: reconstructed.game
    });
  }

  setPosition(conversationId, { fen, expectedRevision, actionId }) {
    const revision = requireRevision(expectedRevision);
    const normalizedAction = normalizeActionId(actionId);
    const duplicate = this.store.getBoardEventByAction(conversationId, normalizedAction);
    if (duplicate) {
      return { duplicate: true, actionId: normalizedAction, event: duplicate, state: this.getState(conversationId) };
    }
    const reconstructed = this.reconstruct(conversationId);
    const before = new Chess(reconstructed.game.fen());
    const normalizedFen = normalizeFen(fen);
    reconstructed.game.load(normalizedFen);
    return this.commit({
      conversationId,
      expectedRevision: revision,
      eventType: 'set_position',
      actionId: normalizedAction,
      payload: { fen: normalizedFen },
      before,
      game: reconstructed.game
    });
  }

  reset(conversationId, { expectedRevision, actionId }) {
    const revision = requireRevision(expectedRevision);
    const normalizedAction = normalizeActionId(actionId);
    const duplicate = this.store.getBoardEventByAction(conversationId, normalizedAction);
    if (duplicate) {
      return { duplicate: true, actionId: normalizedAction, event: duplicate, state: this.getState(conversationId) };
    }
    const reconstructed = this.reconstruct(conversationId);
    const before = new Chess(reconstructed.game.fen());
    reconstructed.game.load(reconstructed.session.initialFen);
    return this.commit({
      conversationId,
      expectedRevision: revision,
      eventType: 'reset',
      actionId: normalizedAction,
      payload: {},
      before,
      game: reconstructed.game
    });
  }

  setOrientation(conversationId, { orientation, expectedRevision, actionId }) {
    if (!['white', 'black'].includes(orientation)) {
      throw new MentorChessError('Board orientation must be white or black.');
    }
    const revision = requireRevision(expectedRevision);
    const normalizedAction = normalizeActionId(actionId);
    const duplicate = this.store.getBoardEventByAction(conversationId, normalizedAction);
    if (duplicate) {
      return { duplicate: true, actionId: normalizedAction, event: duplicate, state: this.getState(conversationId) };
    }
    const reconstructed = this.reconstruct(conversationId);
    const before = new Chess(reconstructed.game.fen());
    return this.commit({
      conversationId,
      expectedRevision: revision,
      eventType: 'orientation',
      actionId: normalizedAction,
      payload: { orientation },
      before,
      game: reconstructed.game,
      orientation
    });
  }

  setAnnotations(conversationId, { highlights, arrows, expectedRevision }) {
    const revision = requireRevision(expectedRevision);
    const annotations = normalizeAnnotations({ highlights, arrows });
    const result = this.store.setBoardAnnotations(conversationId, {
      expectedRevision: revision,
      ...annotations
    });
    if (result.status === 'not_found') throw new MentorChessError('Conversation not found.', 404);
    if (result.status === 'stale') {
      throw new MentorChessError('The chess position changed before annotations were applied.', 409, {
        code: 'stale_revision',
        state: this.getState(conversationId)
      });
    }
    return {
      actionId: null,
      duplicate: false,
      state: this.getState(conversationId)
    };
  }

  promptContext(conversationId) {
    const state = this.getState(conversationId);
    const recentMoves = state.history.slice(-12).map((move) => move.san).join(' ');
    return [
      'Current chess workspace:',
      `FEN: ${state.fen}`,
      `PGN: ${state.pgn || '(none)'}`,
      `Turn: ${state.turnName}`,
      `Game status: ${state.gameStatus.resultText}`,
      `Recent moves: ${recentMoves || '(none)'}`,
      `Legal UCI moves: ${state.legalMoves.join(', ') || '(none)'}`,
      'You may use the supplied board tools whenever a visual example would improve the lesson.'
    ].join('\n');
  }
}

module.exports = {
  MentorChessError,
  MentorChessService,
  gameStatus,
  moveToUci,
  normalizeAnnotations,
  normalizeFen
};
