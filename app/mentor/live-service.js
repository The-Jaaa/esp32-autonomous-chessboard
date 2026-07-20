const { randomUUID } = require('crypto');
const { validateMessageText, validateRequestId } = require('./service');

const DEFAULT_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const DEFAULT_LIVE_VOICE = 'Aoede';
const LIVE_CONTEXT_CHARACTER_LIMIT = 12000;
const AUDIO_INPUT_MIME_TYPE = 'audio/pcm;rate=16000';
const AUDIO_OUTPUT_SAMPLE_RATE = 24000;

const LIVE_SYSTEM_INSTRUCTION = [
  'You are a patient, practical chess mentor in a live voice conversation.',
  'Keep spoken replies concise, natural, and free of markdown.',
  'Use the supplied conversation and chess workspace context to continue the same lesson.',
  'The user may speak or type and may interrupt you while you are speaking.',
  'Do not claim that you moved pieces, used Stockfish, or changed the board because live tools are not enabled yet.',
  'Messages beginning with [BOARD_CONTEXT_UPDATE] are silent internal state updates. Absorb them without replying unless the user is already discussing that board change.'
].join(' ');

function liveError(message, code = 'mentor_live_error', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function providerErrorMessage(error) {
  return error?.error?.message || error?.message || String(error || 'Gemini Live failed.');
}

function mergeTranscript(current, incoming) {
  const previous = String(current || '').replace(/\s+/g, ' ').trim();
  const next = String(incoming || '').replace(/\s+/g, ' ').trim();
  if (!next || next === previous || previous.endsWith(next)) return previous;
  if (!previous) return next;
  if (next.startsWith(previous)) return next;
  if (previous.startsWith(next)) return previous;

  const maximumOverlap = Math.min(previous.length, next.length);
  for (let size = maximumOverlap; size > 0; size -= 1) {
    if (previous.slice(-size) === next.slice(0, size)) {
      return `${previous}${next.slice(size)}`.trim();
    }
  }
  return `${previous} ${next}`.trim();
}

function boardContextFromState(state) {
  const recentMoves = (state?.history || []).slice(-12).map((move) => move.san).join(' ');
  return [
    `FEN: ${state?.fen || 'unknown'}`,
    `PGN: ${state?.pgn || '(none)'}`,
    `Turn: ${state?.turnName || 'unknown'}`,
    `Game status: ${state?.gameStatus?.resultText || 'unknown'}`,
    `Recent moves: ${recentMoves || '(none)'}`,
    `Orientation: ${state?.orientation || 'white'}`,
    `Revision: ${Number.isInteger(state?.revision) ? state.revision : 'unknown'}`,
    `Highlights: ${JSON.stringify(state?.annotations?.highlights || [])}`,
    `Arrows: ${JSON.stringify(state?.annotations?.arrows || [])}`
  ].join('\n');
}

function initialHistoryTurns(messages, chessState) {
  const turns = messages
    .filter((message) => message.content && ['user', 'model'].includes(message.role))
    .map((message) => ({
      role: message.role === 'model' ? 'model' : 'user',
      parts: [{ text: message.content }]
    }));
  turns.push({
    role: 'user',
    parts: [{
      text: [
        '[INITIAL_CHESS_WORKSPACE]',
        boardContextFromState(chessState),
        'Use this as context only. Do not respond until the learner speaks or types.'
      ].join('\n')
    }]
  });
  return turns;
}

function audioParts(message) {
  return message?.serverContent?.modelTurn?.parts || [];
}

class GeminiMentorLiveConnector {
  constructor({ ai }) {
    this.ai = ai;
  }

  connect(options) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured.');
    }
    return this.ai.live.connect(options);
  }
}

class DeterministicMentorLiveSession {
  constructor(callbacks, { delayMs = 5 } = {}) {
    this.callbacks = callbacks;
    this.delayMs = delayMs;
    this.closed = false;
    this.generation = 0;
    this.clientContent = [];
    this.realtimeInputs = [];
  }

  sendClientContent(payload) {
    this.clientContent.push(payload);
  }

  sendRealtimeInput(payload) {
    if (this.closed) throw new Error('Deterministic Live session is closed.');
    this.realtimeInputs.push(payload);
    if (payload.text && !payload.text.startsWith('[BOARD_CONTEXT_UPDATE]')) {
      this.respond(`I heard your typed question: ${payload.text}`);
    } else if (payload.audioStreamEnd) {
      this.emitAudioTurn();
    }
  }

  respond(text) {
    const generation = ++this.generation;
    const midpoint = Math.max(1, Math.floor(text.length / 2));
    const first = text.slice(0, midpoint);
    setTimeout(() => {
      if (this.closed || generation !== this.generation) return;
      this.callbacks.onmessage?.({ serverContent: { outputTranscription: { text: first } } });
    }, this.delayMs);
    setTimeout(() => {
      if (this.closed || generation !== this.generation) return;
      this.callbacks.onmessage?.({
        serverContent: {
          outputTranscription: { text },
          modelTurn: {
            parts: [{
              inlineData: {
                data: Buffer.alloc(480).toString('base64'),
                mimeType: 'audio/pcm;rate=24000'
              }
            }]
          },
          turnComplete: true
        }
      });
    }, this.delayMs * 2);
  }

  emitAudioTurn() {
    setTimeout(() => {
      if (this.closed) return;
      this.callbacks.onmessage?.({
        serverContent: { inputTranscription: { text: 'Can you explain' } }
      });
      this.callbacks.onmessage?.({
        serverContent: { inputTranscription: { text: 'Can you explain this position?' } }
      });
      this.respond('Yes. Let us examine the position together.');
    }, this.delayMs);
  }

  interrupt() {
    if (!this.closed) {
      this.generation += 1;
      this.callbacks.onmessage?.({ serverContent: { interrupted: true, turnComplete: true } });
    }
  }

  fail(message = 'Deterministic Gemini Live failure') {
    if (!this.closed) {
      this.generation += 1;
      this.callbacks.onerror?.(new Error(message));
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.callbacks.onclose?.());
  }
}

class DeterministicMentorLiveConnector {
  constructor(options = {}) {
    this.options = options;
    this.sessions = [];
    this.connectCalls = [];
  }

  async connect(options) {
    this.connectCalls.push(options);
    const session = new DeterministicMentorLiveSession(options.callbacks, this.options);
    this.sessions.push(session);
    queueMicrotask(() => options.callbacks.onopen?.());
    return session;
  }
}

class MentorLiveService {
  constructor({
    store,
    chessService,
    textService,
    connector,
    emit = () => {},
    model = DEFAULT_LIVE_MODEL,
    voiceName = DEFAULT_LIVE_VOICE,
    createId = randomUUID,
    logger = console
  }) {
    this.store = store;
    this.chessService = chessService;
    this.textService = textService;
    this.connector = connector;
    this.emit = emit;
    this.model = model;
    this.voiceName = voiceName;
    this.createId = createId;
    this.logger = logger;
    this.bySocket = new Map();
    this.byConversation = new Map();
  }

  isConversationActive(conversationId) {
    return this.byConversation.has(conversationId);
  }

  isSocketActive(socketId) {
    return this.bySocket.has(socketId);
  }

  statusPayload(record, status, extra = {}) {
    return {
      conversationId: record.conversationId,
      sessionId: record.sessionId,
      status,
      ...extra
    };
  }

  emitStatus(record, status, extra) {
    record.socket.emit('mentor-live-status', this.statusPayload(record, status, extra));
  }

  assertRecord(socket, payload = {}) {
    const record = this.bySocket.get(socket.id);
    if (!record) throw liveError('No active Live mentor session.', 'mentor_live_not_active', 409);
    if (payload.conversationId !== record.conversationId || payload.sessionId !== record.sessionId) {
      throw liveError('The Live mentor session does not match this conversation.', 'mentor_live_stale_session', 409);
    }
    return record;
  }

  reserve(record) {
    this.bySocket.set(record.socket.id, record);
    this.byConversation.set(record.conversationId, record);
  }

  release(record) {
    if (this.bySocket.get(record.socket.id) === record) this.bySocket.delete(record.socket.id);
    if (this.byConversation.get(record.conversationId) === record) {
      this.byConversation.delete(record.conversationId);
    }
  }

  async start(socket, { conversationId } = {}) {
    if (!conversationId || !this.store.getConversation(conversationId)) {
      throw liveError('Conversation not found.', 'mentor_live_conversation_not_found', 404);
    }
    if (!socket.rooms.has(`mentor:${conversationId}`)) {
      throw liveError('Subscribe to the conversation before starting Live mentor.', 'mentor_live_not_subscribed', 403);
    }
    const existingSocket = this.bySocket.get(socket.id);
    if (existingSocket) {
      if (existingSocket.conversationId === conversationId) {
        return { duplicate: true, sessionId: existingSocket.sessionId };
      }
      throw liveError('This browser already owns another Live mentor session.', 'mentor_live_socket_busy', 409);
    }
    if (this.byConversation.has(conversationId)) {
      throw liveError('This conversation already has an active Live mentor session.', 'mentor_live_conversation_busy', 409);
    }
    if (this.textService?.hasActiveConversation(conversationId)) {
      throw liveError('Stop the current text mentor response before starting Live mentor.', 'mentor_text_active', 409);
    }

    const record = {
      socket,
      conversationId,
      sessionId: this.createId(),
      providerSession: null,
      turnOrdinal: 0,
      turn: null,
      pendingBoardState: null,
      contextPending: false,
      ready: false,
      closing: false,
      closedEmitted: false
    };
    this.reserve(record);
    this.emitStatus(record, 'connecting');

    try {
      record.providerSession = await this.connector.connect({
        model: this.model,
        config: {
          responseModalities: ['AUDIO'],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {}
          },
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: this.voiceName }
            }
          },
          systemInstruction: {
            parts: [{ text: LIVE_SYSTEM_INSTRUCTION }]
          }
        },
        callbacks: {
          onopen: () => this.logger.log?.(`[MENTOR_LIVE_OPEN] ${record.sessionId}`),
          onmessage: (message) => this.handleProviderMessage(record, message),
          onerror: (error) => this.handleProviderError(record, error),
          onclose: () => this.handleProviderClose(record)
        }
      });

      const history = this.store.contextMessages(conversationId, LIVE_CONTEXT_CHARACTER_LIMIT);
      const chessState = this.chessService.getState(conversationId);
      record.providerSession.sendClientContent({
        turns: initialHistoryTurns(history, chessState),
        turnComplete: false
      });
      record.ready = true;
      this.emitStatus(record, 'listening');
      return { duplicate: false, sessionId: record.sessionId };
    } catch (error) {
      this.release(record);
      throw liveError(providerErrorMessage(error), 'mentor_live_connect_failed', 502);
    }
  }

  sendAudio(socket, payload = {}) {
    const record = this.assertRecord(socket, payload);
    if (!record.ready || record.closing) return false;
    if (typeof payload.data !== 'string' || !payload.data || payload.data.length > 262144) {
      throw liveError('Live audio data is required.', 'mentor_live_invalid_audio');
    }
    record.providerSession.sendRealtimeInput({
      audio: { mimeType: AUDIO_INPUT_MIME_TYPE, data: payload.data }
    });
    return true;
  }

  sendAudioEnd(socket, payload = {}) {
    const record = this.assertRecord(socket, payload);
    if (!record.ready || record.closing) return false;
    record.providerSession.sendRealtimeInput({ audioStreamEnd: true });
    return true;
  }

  sendText(socket, payload = {}) {
    const record = this.assertRecord(socket, payload);
    if (!validateRequestId(payload.requestId)) {
      throw liveError('A valid requestId is required.', 'mentor_live_invalid_request');
    }
    if (!validateMessageText(payload.text)) {
      throw liveError('Message text must contain 1-8000 characters.', 'mentor_live_invalid_text');
    }
    const existing = this.store.getRequestMessages(record.conversationId, payload.requestId);
    if (existing.length) {
      return {
        duplicate: true,
        userMessage: existing.find((message) => message.role === 'user') || null,
        assistantMessage: existing.find((message) => message.role === 'model') || null
      };
    }
    if (record.turn) this.finalizeTurn(record, 'cancelled');

    const pair = this.store.createMessagePair(record.conversationId, {
      requestId: payload.requestId,
      text: payload.text.trim(),
      kind: 'voice'
    });
    record.contextPending = false;
    record.turn = {
      turnId: this.createId(),
      requestId: payload.requestId,
      source: 'text',
      userText: payload.text.trim(),
      assistantText: '',
      pair
    };
    this.emit(record.conversationId, 'mentor-live-user-transcript', {
      ...this.statusPayload(record, 'listening'),
      turnId: record.turn.turnId,
      text: record.turn.userText,
      isFinal: true,
      message: pair.userMessage
    });
    this.emit(record.conversationId, 'mentor-live-assistant-transcript', {
      ...this.statusPayload(record, 'thinking'),
      turnId: record.turn.turnId,
      text: '',
      isFinal: false,
      message: pair.assistantMessage
    });
    record.providerSession.sendRealtimeInput({ text: record.turn.userText });
    this.emitStatus(record, 'thinking');
    return { duplicate: false, ...pair };
  }

  createAudioTurn(record) {
    record.turnOrdinal += 1;
    record.contextPending = false;
    return {
      turnId: this.createId(),
      requestId: `voice:${record.sessionId}:${record.turnOrdinal}`,
      source: 'audio',
      userText: '',
      assistantText: '',
      pair: null
    };
  }

  currentTurn(record, source = 'audio') {
    if (!record.turn) {
      record.turn = source === 'context'
        ? {
          turnId: this.createId(),
          requestId: `context:${record.sessionId}:${record.turnOrdinal}`,
          source: 'context',
          userText: '',
          assistantText: '',
          pair: null
        }
        : this.createAudioTurn(record);
    }
    return record.turn;
  }

  handleInputTranscript(record, text) {
    if (record.closing) return;
    if (record.turn?.source === 'text' || record.turn?.source === 'context' || record.turn?.assistantText) {
      this.finalizeTurn(record, 'cancelled');
    }
    const turn = this.currentTurn(record);
    turn.userText = mergeTranscript(turn.userText, text);
    this.emit(record.conversationId, 'mentor-live-user-transcript', {
      ...this.statusPayload(record, 'listening'),
      turnId: turn.turnId,
      text: turn.userText,
      isFinal: false
    });
    this.emitStatus(record, 'listening');
  }

  handleOutputTranscript(record, text) {
    if (record.closing) return;
    const turn = this.currentTurn(record, record.contextPending ? 'context' : 'audio');
    turn.assistantText = mergeTranscript(turn.assistantText, text);
    this.emit(record.conversationId, 'mentor-live-assistant-transcript', {
      ...this.statusPayload(record, 'speaking'),
      turnId: turn.turnId,
      text: turn.assistantText,
      isFinal: false
    });
    this.emitStatus(record, 'speaking');
  }

  handleProviderMessage(record, message) {
    if (this.bySocket.get(record.socket.id) !== record || record.closing) return;
    const content = message?.serverContent;
    if (content?.interrupted) {
      record.socket.emit('mentor-live-interrupted', {
        ...this.statusPayload(record, 'interrupted'),
        turnId: record.turn?.turnId || null
      });
      if (record.turn && (record.turn.assistantText || record.turn.source !== 'audio')) {
        this.finalizeTurn(record, 'cancelled');
      }
      this.emitStatus(record, 'listening');
    }
    if (content?.inputTranscription?.text) {
      this.handleInputTranscript(record, content.inputTranscription.text);
    }
    if (content?.outputTranscription?.text) {
      this.handleOutputTranscript(record, content.outputTranscription.text);
    }
    for (const part of audioParts(message)) {
      if (part.text && !content?.outputTranscription?.text) this.handleOutputTranscript(record, part.text);
      if (part.inlineData?.data) {
        const mimeType = part.inlineData.mimeType || 'audio/pcm;rate=24000';
        const match = /rate=(\d+)/i.exec(mimeType);
        record.socket.emit('mentor-live-audio', {
          conversationId: record.conversationId,
          sessionId: record.sessionId,
          data: part.inlineData.data,
          mimeType,
          sampleRate: match ? Number(match[1]) : AUDIO_OUTPUT_SAMPLE_RATE
        });
        this.emitStatus(record, 'speaking');
      }
    }
    if (content?.turnComplete && record.turn) {
      this.finalizeTurn(record, 'complete');
      this.emitStatus(record, 'listening');
    }
  }

  finalizeTurn(record, status) {
    const turn = record.turn;
    if (!turn) return null;
    record.turn = null;
    record.contextPending = false;

    if (turn.source === 'context') {
      this.flushBoardContext(record);
      return null;
    }

    const userText = turn.userText || 'Voice input was not transcribed.';
    const assistantStatus = status === 'complete' && !turn.assistantText ? 'failed' : status;
    let pair = turn.pair;
    if (!pair) {
      pair = this.store.createMessagePair(record.conversationId, {
        requestId: turn.requestId,
        text: userText,
        kind: 'voice',
        assistantContent: turn.assistantText,
        assistantStatus
      });
    } else {
      this.store.replaceMessageContent(pair.assistantMessage.id, turn.assistantText);
      this.store.setMessageStatus(pair.assistantMessage.id, assistantStatus);
      pair = {
        ...pair,
        userMessage: this.store.getMessage(pair.userMessage.id),
        assistantMessage: this.store.getMessage(pair.assistantMessage.id)
      };
    }
    const conversation = this.store.touchConversation(record.conversationId);
    this.emit(record.conversationId, 'mentor-live-user-transcript', {
      ...this.statusPayload(record, 'listening'),
      turnId: turn.turnId,
      text: userText,
      isFinal: true,
      message: pair.userMessage,
      conversation
    });
    this.emit(record.conversationId, 'mentor-live-assistant-transcript', {
      ...this.statusPayload(record, assistantStatus === 'complete' ? 'listening' : assistantStatus),
      turnId: turn.turnId,
      text: turn.assistantText,
      isFinal: true,
      message: pair.assistantMessage,
      conversation
    });
    this.flushBoardContext(record);
    return pair;
  }

  notifyBoardUpdated(conversationId, state) {
    const record = this.byConversation.get(conversationId);
    if (!record || record.closing || !record.ready) return false;
    record.pendingBoardState = state;
    if (!record.turn) this.flushBoardContext(record);
    return true;
  }

  flushBoardContext(record) {
    if (!record.pendingBoardState || record.turn || record.closing || !record.ready) return false;
    const state = record.pendingBoardState;
    record.pendingBoardState = null;
    record.contextPending = true;
    record.providerSession.sendRealtimeInput({
      text: `[BOARD_CONTEXT_UPDATE]\n${boardContextFromState(state)}`
    });
    return true;
  }

  handleProviderError(record, error) {
    if (this.bySocket.get(record.socket.id) !== record) return;
    const message = providerErrorMessage(error);
    if (record.turn) this.finalizeTurn(record, 'failed');
    record.socket.emit('mentor-live-error', {
      ...this.statusPayload(record, 'failed'),
      error: message,
      code: 'mentor_live_provider_error'
    });
    this.emitStatus(record, 'failed', { error: message });
    this.logger.error?.('[MENTOR_LIVE_FAILED]', JSON.stringify({
      conversationId: record.conversationId,
      sessionId: record.sessionId,
      error: message
    }));
    this.closeRecord(record, 'provider_error').catch((closeError) => {
      this.logger.warn?.('[MENTOR_LIVE_PROVIDER_CLOSE_FAILED]', providerErrorMessage(closeError));
    });
  }

  handleProviderClose(record) {
    if (this.bySocket.get(record.socket.id) !== record && record.closedEmitted) return;
    if (record.turn) this.finalizeTurn(record, 'cancelled');
    this.release(record);
    if (!record.closedEmitted) {
      record.closedEmitted = true;
      this.emit(record.conversationId, 'mentor-live-closed', this.statusPayload(record, 'closed'));
    }
  }

  async stop(socket, payload = {}, reason = 'client_stop') {
    const record = this.assertRecord(socket, payload);
    await this.closeRecord(record, reason);
    return true;
  }

  async closeRecord(record, reason) {
    if (record.closing) return;
    record.closing = true;
    if (record.turn) this.finalizeTurn(record, 'cancelled');
    try {
      record.providerSession?.sendRealtimeInput({ audioStreamEnd: true });
    } catch (error) {
      this.logger.warn?.('[MENTOR_LIVE_AUDIO_END_FAILED]', providerErrorMessage(error));
    }
    this.release(record);
    try {
      await Promise.resolve(record.providerSession?.close());
    } catch (error) {
      this.logger.warn?.('[MENTOR_LIVE_CLOSE_FAILED]', providerErrorMessage(error));
    }
    if (!record.closedEmitted) {
      record.closedEmitted = true;
      this.emit(record.conversationId, 'mentor-live-closed', {
        ...this.statusPayload(record, 'closed'),
        reason
      });
    }
  }

  async stopSocket(socketId, reason = 'disconnect') {
    const record = this.bySocket.get(socketId);
    if (record) await this.closeRecord(record, reason);
  }

  async stopConversation(conversationId, reason = 'conversation_closed') {
    const record = this.byConversation.get(conversationId);
    if (record) await this.closeRecord(record, reason);
  }

  async closeAll() {
    await Promise.all([...this.bySocket.values()].map((record) => this.closeRecord(record, 'shutdown')));
  }

  registerSocket(socket) {
    const reply = (acknowledge, result) => {
      if (typeof acknowledge === 'function') acknowledge(result);
    };
    const fail = (socketInstance, payload, acknowledge, error) => {
      const conversationId = payload?.conversationId;
      const sessionId = payload?.sessionId || this.bySocket.get(socketInstance.id)?.sessionId || null;
      const response = {
        success: false,
        conversationId,
        sessionId,
        error: providerErrorMessage(error),
        code: error.code || 'mentor_live_error'
      };
      socketInstance.emit('mentor-live-error', response);
      reply(acknowledge, response);
    };

    socket.on('mentor-live-start', async (payload = {}, acknowledge) => {
      try {
        const result = await this.start(socket, payload);
        reply(acknowledge, { success: true, conversationId: payload.conversationId, ...result });
      } catch (error) {
        fail(socket, payload, acknowledge, error);
      }
    });
    socket.on('mentor-live-audio-input', (payload = {}) => {
      try {
        this.sendAudio(socket, payload);
      } catch (error) {
        fail(socket, payload, null, error);
      }
    });
    socket.on('mentor-live-audio-end', (payload = {}, acknowledge) => {
      try {
        const success = this.sendAudioEnd(socket, payload);
        reply(acknowledge, { success });
      } catch (error) {
        fail(socket, payload, acknowledge, error);
      }
    });
    socket.on('mentor-live-text-input', (payload = {}, acknowledge) => {
      try {
        const result = this.sendText(socket, payload);
        reply(acknowledge, { success: true, ...result });
      } catch (error) {
        fail(socket, payload, acknowledge, error);
      }
    });
    socket.on('mentor-live-stop', async (payload = {}, acknowledge) => {
      try {
        await this.stop(socket, payload);
        reply(acknowledge, { success: true });
      } catch (error) {
        fail(socket, payload, acknowledge, error);
      }
    });
    socket.on('disconnect', () => {
      this.stopSocket(socket.id).catch((error) => {
        this.logger.warn?.('[MENTOR_LIVE_DISCONNECT_CLOSE_FAILED]', providerErrorMessage(error));
      });
    });
  }
}

module.exports = {
  AUDIO_INPUT_MIME_TYPE,
  AUDIO_OUTPUT_SAMPLE_RATE,
  DEFAULT_LIVE_MODEL,
  DEFAULT_LIVE_VOICE,
  DeterministicMentorLiveConnector,
  GeminiMentorLiveConnector,
  LIVE_CONTEXT_CHARACTER_LIMIT,
  LIVE_SYSTEM_INSTRUCTION,
  MentorLiveService,
  boardContextFromState,
  initialHistoryTurns,
  mergeTranscript
};
