const { randomUUID } = require('crypto');
const { MAX_TOOL_CALLS, validateMessageText, validateRequestId } = require('./service');
const { titleFromMessage } = require('./store');

const DEFAULT_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const DEFAULT_LIVE_VOICE = 'Aoede';
const LIVE_CONTEXT_CHARACTER_LIMIT = 12000;
const AUDIO_INPUT_MIME_TYPE = 'audio/pcm;rate=16000';
const AUDIO_OUTPUT_SAMPLE_RATE = 24000;
const MAX_LIVE_TOOL_BATCHES = 8;
const DEFAULT_PHYSICAL_TURN_TIMEOUT_MS = 15000;
const VOICE_TRANSCRIPT_PLACEHOLDER = 'Voice request in progress.';

const LIVE_TOOL_LABELS = {
  set_game_preferences: 'Updating game preferences',
  get_physical_game_status: 'Checking physical board',
  start_physical_game: 'Starting physical game',
  attach_physical_game: 'Attaching physical board',
  set_physical_coaching: 'Updating coaching',
  play_physical_move: 'Playing mentor move',
  pause_activity: 'Pausing activity',
  resume_activity: 'Resuming activity',
  confirm_physical_setup: 'Confirming physical setup',
  get_board_state: 'Reading board',
  analyze_position: 'Analyzing position',
  analyze_move: 'Analyzing move',
  play_move: 'Updating board',
  play_line: 'Demonstrating line',
  load_position: 'Loading position',
  reset_board: 'Resetting board',
  set_orientation: 'Flipping board',
  annotate_board: 'Annotating board'
};

const LIVE_SYSTEM_INSTRUCTION = [
  'You are a patient, practical chess mentor in a live voice conversation.',
  'Keep spoken replies concise, natural, and free of markdown.',
  'Use the supplied conversation and chess workspace context to continue the same lesson.',
  'The user may speak or type and may interrupt you while you are speaking.',
  'Use the available high-level chess tools proactively when they improve the lesson.',
  'Start a structured activity only after the learner explicitly agrees.',
  'The primary mentor product always uses the physical board. Never ask whether the learner wants Physical or Virtual play.',
  'If the learner says Let us play without naming an opponent, ask only whether they want Mentor-led or Stockfish-led play, and ask their color only when it is not already known.',
  'An explicit physical game, reviewed opening, or puzzle request is consent to use the matching high-level activity tools.',
  'The primary Live workspace is physical-only. Never use virtual play_move, play_line, load_position, or reset_board for a learner activity.',
  'Calling start_activity is the only valid way to begin product gameplay. It establishes or attaches the physical board and creates the requested activity in one transaction. Include learnerColor and opponentMode when the learner specifies them.',
  'Flipping orientation only changes the app view; it never changes the learner side and never replaces start_activity.',
  'For openings, respect the requested opening and learner color. For puzzles, guide setup and wait for explicit physical setup confirmation.',
  'During an assigned activity turn, analyze first and then make exactly one mentor move, unless you explicitly request a prediction.',
  'For a guided physical game, analyze the learner\'s latest move with analyze_move and state its classification plainly after your physical reply verifies.',
  'Do not soften an inaccuracy, mistake, or blunder. Name it directly, explain the consequence, and give the stronger alternative.',
  'Teach forward: connect the current turn to a concrete two-to-three-ply plan, likely replies, and the condition that would change the plan.',
  'Give only one post-turn explanation. Never repeat narration because a tool was retried, and never claim a physical move succeeded after a tool error.',
  'Do not leave an assigned mentor turn at analysis alone.',
  'During a Mentor-led physical turn, use play_physical_move with one verified candidate and a concise strategic plan.',
  'State weak moves and their consequences plainly and respectfully. Avoid praise padding.',
  'Use Stockfish analysis tools before making objective claims about evaluations, best moves, tactics, or move quality.',
  'Never claim that a tool succeeded until its function response confirms success.',
  'The workspace context states whether it is virtual or physical. Never claim access to raw motors, magnets, routes, sensors, or command queues.',
  'On the physical board, only play_physical_move during the assigned Mentor-led turn may request a guarded robot move; wait for verification before claiming success.',
  'The learner may be White or Black. Use the supplied activity and board context instead of assuming colors.',
  'Messages beginning with [PHYSICAL_BOARD_GUIDANCE] are urgent internal safety instructions. Speak the required recovery instruction exactly and do not answer an earlier learner request in that turn.',
  'Bracketed labels such as [BOARD_CONTEXT_UPDATE] and [PHYSICAL_BOARD_GUIDANCE] are private control markers. Never quote or speak those labels.',
  'Board context updates are silent context, not learner requests. Never respond to a board context update by itself.',
  'Never claim Stockfish failed unless the current Stockfish tool result explicitly reports an error.',
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

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function toolLabel(name) {
  return LIVE_TOOL_LABELS[name] || 'Using mentor tool';
}

function limitToolResponse(call, message, code) {
  return {
    id: call.id,
    name: call.name,
    response: { error: { message, code } }
  };
}

function toolBoardRevision(result) {
  const output = result?.response?.output;
  const revision = output?.board?.revision ?? output?.revision ?? output?.analyzedRevision;
  return Number.isInteger(revision) ? revision : null;
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
    `Workspace source: ${state?.source || 'virtual'}`,
    `Workspace source key: ${state?.sourceKey || 'unknown'}`,
    `FEN: ${state?.fen || 'unknown'}`,
    `PGN: ${state?.pgn || '(none)'}`,
    `Turn: ${state?.turnName || 'unknown'}`,
    `Game status: ${state?.gameStatus?.resultText || 'unknown'}`,
    `Recent moves: ${recentMoves || '(none)'}`,
    `Orientation: ${state?.orientation || 'white'}`,
    `Revision: ${Number.isInteger(state?.revision) ? state.revision : 'unknown'}`,
    `Highlights: ${JSON.stringify(state?.annotations?.highlights || [])}`,
    `Arrows: ${JSON.stringify(state?.annotations?.arrows || [])}`,
    ...(state?.physical ? [
      `Physical human color: ${state.physical.humanColor || 'white'}`,
      `Physical robot color: ${state.physical.robotColor || 'black'}`,
      `Physical phase: ${state.physical.phase}`,
      `Physical status: ${state.physical.statusText}`,
      `Physical missing squares: ${(state.physical.board?.missingSquares || []).join(', ') || '(none)'}`,
      `Physical extra squares: ${(state.physical.board?.extraSquares || []).join(', ') || '(none)'}`,
      `Robot busy: ${state.physical.robotBusy ? 'yes' : 'no'}`
    ] : [])
  ].join('\n');
}

function initialHistoryTurns(messages, chessState) {
  const transcript = messages
    .filter((message) => message.content && ['user', 'model'].includes(message.role))
    .map((message) => `${message.role === 'model' ? 'Mentor' : 'Learner'}: ${message.content}`)
    .join('\n\n');
  return [{
    role: 'user',
    parts: [{
      text: [
        '[INITIAL_CONVERSATION_CONTEXT]',
        transcript || '(no prior messages)',
        '[INITIAL_CHESS_WORKSPACE]',
        boardContextFromState(chessState),
        'The labelled transcript above is prior conversation context, not a new request.',
        'Use this as context only. Do not respond until the learner speaks or types.'
      ].join('\n')
    }]
  }];
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
    this.toolResponses = [];
    this.pendingToolReply = null;
    this.responding = false;
  }

  sendClientContent(payload) {
    this.clientContent.push(payload);
  }

  sendRealtimeInput(payload) {
    if (this.closed) throw new Error('Deterministic Live session is closed.');
    this.realtimeInputs.push(payload);
    if (this.responding && payload.audioStreamEnd) return;
    if (this.responding && payload.text?.startsWith('[PHYSICAL_BOARD_GUIDANCE]')) {
      this.generation += 1;
      this.responding = false;
      this.callbacks.onmessage?.({
        serverContent: {
          interrupted: true,
          outputTranscription: { text: 'Stale output from the interrupted response.' },
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
      queueMicrotask(() => {
        if (this.closed) return;
        this.callbacks.onmessage?.({ serverContent: { turnComplete: true } });
        this.respond(`I heard your typed question: ${payload.text}`);
      });
      return;
    }
    if (payload.text === 'Run the Live board tool demo.') {
      this.emitToolCall([{
        id: 'live-browser-line',
        name: 'play_line',
        args: { moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6'] }
      }], 'The Live board demonstration is complete.');
    } else if (payload.text === 'Run the Live annotation tool demo.') {
      this.emitToolCall([{
        id: 'live-browser-annotation',
        name: 'annotate_board',
        args: {
          highlights: [{ square: 'f7', role: 'danger' }],
          arrows: [{ from: 'f3', to: 'e5', role: 'idea' }]
        }
      }], 'The teaching marks are now on the board.');
    } else if (payload.text === 'Run the Live analysis tool demo.') {
      this.emitToolCall([{
        id: 'live-browser-analysis',
        name: 'analyze_position',
        args: { mode: 'quick' }
      }], 'The Stockfish analysis is ready.');
    } else if (payload.text && !payload.text.startsWith('[BOARD_CONTEXT_UPDATE]')) {
      this.respond(`I heard your typed question: ${payload.text}`);
    } else if (payload.audioStreamEnd) {
      this.emitAudioTurn();
    }
  }

  sendToolResponse(payload) {
    if (this.closed) throw new Error('Deterministic Live session is closed.');
    this.toolResponses.push(payload);
    const reply = this.pendingToolReply;
    this.pendingToolReply = null;
    if (reply) this.respond(reply);
  }

  emitToolCall(functionCalls, afterResponseText = 'The requested tool completed.', { turnComplete = false } = {}) {
    if (this.closed) return;
    this.generation += 1;
    this.pendingToolReply = afterResponseText;
    this.callbacks.onmessage?.({
      toolCall: { functionCalls },
      ...(turnComplete ? { serverContent: { turnComplete: true } } : {})
    });
  }

  cancelToolCalls(ids) {
    if (!this.closed) this.callbacks.onmessage?.({ toolCallCancellation: { ids } });
  }

  respond(text) {
    const generation = ++this.generation;
    this.responding = true;
    const midpoint = Math.max(1, Math.floor(text.length / 2));
    const first = text.slice(0, midpoint);
    setTimeout(() => {
      if (this.closed || generation !== this.generation) return;
      this.callbacks.onmessage?.({ serverContent: { outputTranscription: { text: first } } });
    }, this.delayMs);
    setTimeout(() => {
      if (this.closed || generation !== this.generation) return;
      this.responding = false;
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
      this.responding = false;
      this.callbacks.onmessage?.({ serverContent: { interrupted: true, turnComplete: true } });
    }
  }

  fail(message = 'Deterministic Gemini Live failure') {
    if (!this.closed) {
      this.generation += 1;
      this.responding = false;
      this.callbacks.onerror?.(new Error(message));
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.responding = false;
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
    toolService,
    activityService = null,
    speakerService = null,
    stateProvider = null,
    connector,
    emit = () => {},
    model = DEFAULT_LIVE_MODEL,
    voiceName = DEFAULT_LIVE_VOICE,
    voiceFirstPhysical = false,
    createId = randomUUID,
    logger = console
  }) {
    this.store = store;
    this.chessService = chessService;
    this.textService = textService;
    this.toolService = toolService;
    this.activityService = activityService;
    this.speakerService = speakerService;
    this.stateProvider = stateProvider || ((conversationId) => this.chessService.getState(conversationId));
    this.connector = connector;
    this.emit = emit;
    this.model = model;
    this.voiceName = voiceName;
    this.voiceFirstPhysical = voiceFirstPhysical;
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
      outputMode: record.speaker?.outputMode || 'auto',
      resolvedOutput: record.speaker?.resolvedOutput || 'browser',
      deviceId: record.speaker?.deviceId || 'main-board',
      boardVolume: record.speaker?.boardVolume ?? 50,
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

  hasActiveTools(record) {
    return record.activeToolCalls.size > 0 || record.turn?.toolBusy === true;
  }

  async connectProvider(record) {
    const generation = Number(record.providerGeneration || 0) + 1;
    record.providerGeneration = generation;
    const isCurrent = () => this.byConversation.get(record.conversationId) === record
      && record.providerGeneration === generation
      && !record.closing;
    const providerSession = await this.connector.connect({
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
        },
        tools: this.toolService?.declarations(record.conversationId, { voiceFirstPhysical: this.voiceFirstPhysical })?.length
          ? [{ functionDeclarations: this.toolService.declarations(record.conversationId, { voiceFirstPhysical: this.voiceFirstPhysical }) }]
          : undefined
      },
      callbacks: {
        onopen: () => {
          if (isCurrent()) this.logger.log?.(`[MENTOR_LIVE_OPEN] ${record.sessionId}`);
        },
        onmessage: (message) => {
          if (isCurrent()) this.handleProviderMessage(record, message);
        },
        onerror: (error) => {
          if (isCurrent()) this.handleProviderError(record, error);
        },
        onclose: (event) => {
          if (isCurrent()) this.handleProviderClose(record, event);
        }
      }
    });
    if (!isCurrent()) {
      await Promise.resolve(providerSession?.close?.()).catch(() => {});
      return null;
    }
    record.providerSession = providerSession;
    const history = this.store.contextMessages(record.conversationId, LIVE_CONTEXT_CHARACTER_LIMIT);
    const chessState = this.stateProvider(record.conversationId);
    record.providerSession.sendClientContent({
      turns: initialHistoryTurns(history, chessState),
      turnComplete: false
    });
    return providerSession;
  }

  async start(socket, {
    conversationId,
    outputMode = 'auto',
    deviceId = 'main-board',
    boardVolume = 50
  } = {}) {
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
      suppressAudioUntilTurnComplete: false,
      speaker: null,
      activeToolCalls: new Map(),
      toolQueue: Promise.resolve(),
      pendingSystemTurns: [],
      pendingContextReconnect: null,
      reconnecting: false,
      providerGeneration: 0,
      physicalGuidanceLock: false,
      discardUnsolicitedAfterPhysical: false,
      ready: false,
      closing: false,
      closedEmitted: false
    };
    this.reserve(record);

    try {
      record.speaker = this.speakerService
        ? this.speakerService.bindSession({
          conversationId,
          sessionId: record.sessionId,
          outputMode,
          deviceId,
          volume: boardVolume
        })
        : {
          outputMode,
          resolvedOutput: 'browser',
          deviceId,
          boardVolume,
          speakerStatus: outputMode === 'auto' ? 'fallback' : 'browser'
        };
      this.emitStatus(record, 'connecting');
      await this.connectProvider(record);
      record.ready = true;
      this.emitStatus(record, 'listening');
      this.activityService?.resumeStrandedPhysicalMentorTurn?.(conversationId);
      return { duplicate: false, sessionId: record.sessionId, ...record.speaker };
    } catch (error) {
      this.speakerService?.releaseSession(conversationId, record.sessionId, 'start_failed');
      this.release(record);
      if (error?.code?.startsWith('mentor_speaker_')) throw error;
      throw liveError(providerErrorMessage(error), 'mentor_live_connect_failed', 502);
    }
  }

  sendAudio(socket, payload = {}) {
    const record = this.assertRecord(socket, payload);
    if (!record.ready || record.closing) return false;
    if (record.physicalGuidanceLock) return false;
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
    if (record.physicalGuidanceLock) return false;
    record.providerSession.sendRealtimeInput({ audioStreamEnd: true });
    return true;
  }

  sendText(socket, payload = {}) {
    const record = this.assertRecord(socket, payload);
    if (record.physicalGuidanceLock) {
      throw liveError(
        'Wait for the urgent physical-board guidance to finish.',
        'mentor_live_physical_guidance_busy',
        409
      );
    }
    if (this.hasActiveTools(record)) {
      throw liveError(
        'Wait for the current Live mentor tool to finish, or stop the Live session.',
        'mentor_live_tool_busy',
        409
      );
    }
    if (!validateRequestId(payload.requestId)) {
      throw liveError('A valid requestId is required.', 'mentor_live_invalid_request');
    }
    if (!validateMessageText(payload.text)) {
      throw liveError('Message text must contain 1-8000 characters.', 'mentor_live_invalid_text');
    }
    record.discardUnsolicitedAfterPhysical = false;
    record.suppressAudioUntilTurnComplete = false;
    this.activityService?.prepareConversationTurn(record.conversationId, payload.requestId);
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
    record.suppressAudioUntilTurnComplete = false;
    record.turn = this.createTurn(record, {
      turnId: this.createId(),
      requestId: payload.requestId,
      source: 'text',
      userText: payload.text.trim(),
      assistantText: '',
      pair
    });
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
    record.turn.shellEmitted = true;
    record.providerSession.sendRealtimeInput({ text: record.turn.userText });
    this.emitStatus(record, 'thinking');
    return { duplicate: false, ...pair };
  }

  createTurn(record, values) {
    const turn = {
      turnId: values.turnId || this.createId(),
      requestId: values.requestId,
      source: values.source,
      userText: values.userText || '',
      assistantText: values.assistantText || '',
      expectedAssistantText: values.expectedAssistantText || '',
      pair: values.pair || null,
      toolBatchCount: 0,
      toolCallCount: 0,
      toolOrdinal: 0,
      pendingToolBatches: 0,
      hadTools: false,
      toolBusy: false,
      activeToolName: null,
      activeToolIds: [],
      pendingFinalStatus: null,
      cancelledToolIds: new Set(),
      cancelled: false,
      placeholderTitle: null,
      shellEmitted: values.shellEmitted === true,
      receivedProviderOutput: false,
      emptyCompletionsToIgnore: Number(values.emptyCompletionsToIgnore || 0),
      emptyCompletionsIgnored: 0,
      timeoutId: null,
      timeoutRequest: null,
      timeoutArmedAt: 0,
      timeoutMs: 0,
      record,
      resolveCompletion: null,
      completion: null
    };
    turn.completion = new Promise((resolve) => { turn.resolveCompletion = resolve; });
    return turn;
  }

  armPhysicalTurnTimeout(record, turn, request = {}) {
    if (turn.timeoutId) clearTimeout(turn.timeoutId);
    const requested = Number(request.timeoutMs);
    const timeoutMs = Number.isFinite(requested) && requested > 0
      ? Math.min(60000, Math.max(10, Math.round(requested)))
      : DEFAULT_PHYSICAL_TURN_TIMEOUT_MS;
    turn.timeoutRequest = request;
    turn.timeoutArmedAt = Date.now();
    turn.timeoutMs = timeoutMs;
    turn.timeoutId = setTimeout(() => {
      if (record.closing || record.turn !== turn) return;
      const fallback = String(request.fallbackAssistantText || turn.expectedAssistantText || '').trim();
      if (!turn.assistantText && fallback) {
        turn.assistantText = fallback;
        this.updateTurnAssistantMessage(turn);
      }
      this.speakerService?.clearOutput(
        record.conversationId,
        record.sessionId,
        'physical_guidance_timeout'
      );
      this.logger.warn?.('[MENTOR_LIVE_PHYSICAL_TIMEOUT]', JSON.stringify({
        conversationId: record.conversationId,
        sessionId: record.sessionId,
        requestId: turn.requestId,
        timeoutMs
      }));
      this.finalizeTurn(record, turn.assistantText ? 'complete' : 'failed');
      this.emitStatus(record, 'listening', { reason: 'physical_guidance_timeout' });
    }, timeoutMs);
    turn.timeoutId.unref?.();
  }

  notePhysicalTurnProgress(record, turn) {
    if (turn?.source !== 'physical' || !turn.timeoutRequest || record.turn !== turn) return;
    const rearmInterval = Math.min(1000, Math.max(5, Math.floor(turn.timeoutMs / 3)));
    if (Date.now() - turn.timeoutArmedAt < rearmInterval) return;
    this.armPhysicalTurnTimeout(record, turn, turn.timeoutRequest);
  }

  createAudioTurn(record) {
    record.turnOrdinal += 1;
    record.contextPending = false;
    return this.createTurn(record, {
      requestId: `voice:${record.sessionId}:${record.turnOrdinal}`,
      source: 'audio',
      userText: ''
    });
  }

  currentTurn(record, source = 'audio') {
    if (!record.turn) {
      record.turn = source === 'context'
        ? this.createTurn(record, {
          requestId: `context:${record.sessionId}:${record.turnOrdinal}`,
          source: 'context',
          userText: ''
        })
        : this.createAudioTurn(record);
    }
    return record.turn;
  }

  refreshTurnPair(turn) {
    if (!turn.pair) return null;
    turn.pair = {
      ...turn.pair,
      userMessage: this.store.getMessage(turn.pair.userMessage.id),
      assistantMessage: this.store.getMessage(turn.pair.assistantMessage.id)
    };
    return turn.pair;
  }

  ensureTurnPair(record, turn) {
    if (turn.source === 'context') return null;
    if (!turn.pair) {
      const userText = turn.userText || VOICE_TRANSCRIPT_PLACEHOLDER;
      turn.pair = this.store.createMessagePair(record.conversationId, {
        requestId: turn.requestId,
        text: userText,
        kind: turn.source === 'activity' ? 'activity' : turn.source === 'physical' ? 'physical' : 'voice',
        assistantContent: turn.assistantText,
        assistantStatus: 'streaming',
        suppressTitle: turn.source === 'physical'
      });
      if (!turn.userText) turn.placeholderTitle = titleFromMessage(userText);
    } else {
      if (turn.userText) this.store.replaceMessageContent(turn.pair.userMessage.id, turn.userText);
      this.store.replaceMessageContent(turn.pair.assistantMessage.id, turn.assistantText);
      const assistant = this.store.getMessage(turn.pair.assistantMessage.id);
      if (!['complete', 'failed', 'cancelled'].includes(assistant.status)) {
        this.store.setMessageStatus(assistant.id, 'streaming');
      }
      this.refreshTurnPair(turn);
    }

    if (!turn.shellEmitted) {
      this.emit(record.conversationId, 'mentor-live-user-transcript', {
        ...this.statusPayload(record, 'listening'),
        turnId: turn.turnId,
        text: turn.userText,
        isFinal: false,
        message: turn.pair.userMessage
      });
      this.emit(record.conversationId, 'mentor-live-assistant-transcript', {
        ...this.statusPayload(record, 'thinking'),
        turnId: turn.turnId,
        text: turn.assistantText,
        isFinal: false,
        message: turn.pair.assistantMessage
      });
      turn.shellEmitted = true;
    }
    return turn.pair;
  }

  updateTurnUserMessage(record, turn) {
    if (!turn.pair || !turn.userText) return null;
    this.store.replaceMessageContent(turn.pair.userMessage.id, turn.userText);
    if (turn.placeholderTitle) {
      const conversation = this.store.getConversation(record.conversationId);
      if (conversation?.messageCount === 2 && conversation.title === turn.placeholderTitle) {
        this.store.updateConversation(record.conversationId, { title: titleFromMessage(turn.userText) });
      }
      turn.placeholderTitle = null;
    }
    this.refreshTurnPair(turn);
    return turn.pair.userMessage;
  }

  updateTurnAssistantMessage(turn) {
    if (!turn.pair) return null;
    this.store.replaceMessageContent(turn.pair.assistantMessage.id, turn.assistantText);
    this.refreshTurnPair(turn);
    return turn.pair.assistantMessage;
  }

  handleInputTranscript(record, text) {
    if (record.closing || record.physicalGuidanceLock) return;
    record.discardUnsolicitedAfterPhysical = false;
    record.suppressAudioUntilTurnComplete = false;
    if (record.turn && !record.turn.toolBusy
      && !(record.turn.source === 'audio' && record.turn.hadTools)
      && (record.turn.source === 'text' || record.turn.source === 'activity'
        || record.turn.source === 'context' || record.turn.assistantText)) {
      this.finalizeTurn(record, 'cancelled');
    }
    const turn = this.currentTurn(record);
    this.activityService?.prepareConversationTurn(record.conversationId, turn.requestId);
    turn.userText = mergeTranscript(turn.userText, text);
    const message = this.updateTurnUserMessage(record, turn);
    this.emit(record.conversationId, 'mentor-live-user-transcript', {
      ...this.statusPayload(record, turn.toolBusy ? 'tool_running' : 'listening'),
      turnId: turn.turnId,
      text: turn.userText,
      isFinal: false,
      message
    });
    if (!turn.toolBusy) this.emitStatus(record, 'listening');
  }

  handleOutputTranscript(record, text) {
    if (record.closing) return;
    const turn = this.currentTurn(record, record.contextPending ? 'context' : 'audio');
    turn.receivedProviderOutput = true;
    turn.hadTools = true;
    turn.assistantText = turn.expectedAssistantText
      || mergeTranscript(turn.assistantText, text);
    this.notePhysicalTurnProgress(record, turn);
    const message = this.updateTurnAssistantMessage(turn);
    const status = turn.toolBusy ? 'tool_running' : 'speaking';
    this.emit(record.conversationId, 'mentor-live-assistant-transcript', {
      ...this.statusPayload(record, status),
      turnId: turn.turnId,
      text: turn.assistantText,
      isFinal: false,
      message
    });
    if (!turn.toolBusy) this.emitStatus(record, 'speaking');
  }

  abortToolCalls(record, ids = null) {
    const selected = ids ? new Set(ids.map(String)) : null;
    let aborted = 0;
    for (const [id, execution] of record.activeToolCalls.entries()) {
      if (selected && !selected.has(id)) continue;
      execution.cancelled = true;
      execution.turn.cancelledToolIds.add(id);
      execution.controller.abort();
      aborted += 1;
    }
    if (selected && record.turn) {
      for (const id of selected) record.turn.cancelledToolIds.add(id);
    }
    return aborted;
  }

  handleToolCancellation(record, cancellation = {}) {
    const ids = Array.isArray(cancellation.ids) ? cancellation.ids.map(String) : [];
    if (!ids.length) return;
    this.abortToolCalls(record, ids);
    record.socket.emit('mentor-live-interrupted', {
      ...this.statusPayload(record, 'interrupted'),
      turnId: record.turn?.turnId || null,
      toolCallIds: ids
    });
  }

  queueToolBatch(record, calls) {
    const functionCalls = Array.isArray(calls) ? calls.filter((call) => call?.name) : [];
    if (!functionCalls.length) return;
    const turn = this.currentTurn(record, record.contextPending ? 'context' : 'audio');
    turn.pendingToolBatches += 1;
    turn.toolBusy = true;
    const execution = record.toolQueue.then(async () => {
      try {
        await this.executeToolBatch(record, turn, functionCalls);
      } finally {
        this.finishToolBatch(record, turn);
      }
    });
    record.toolQueue = execution.catch((error) => {
      if (!isAbortError(error) && !record.closing) {
        this.logger.error?.('[MENTOR_LIVE_TOOL_BATCH_FAILED]', JSON.stringify({
          conversationId: record.conversationId,
          sessionId: record.sessionId,
          error: providerErrorMessage(error)
        }));
        this.handleProviderError(record, error);
      }
    });
  }

  finishToolBatch(record, turn) {
    turn.pendingToolBatches = Math.max(0, turn.pendingToolBatches - 1);
    if (turn.pendingToolBatches > 0 || record.activeToolCalls.size > 0) return;
    turn.toolBusy = false;
    turn.activeToolName = null;
    turn.activeToolIds = [];
    if (record.turn !== turn || record.closing || turn.cancelled) return;
    if (turn.pendingFinalStatus) {
      const status = turn.pendingFinalStatus;
      turn.pendingFinalStatus = null;
      this.finalizeTurn(record, status);
      this.emitStatus(record, 'listening');
    } else if (turn.cancelledToolIds.size > 0) {
      this.emitStatus(record, 'thinking');
    }
  }

  sendToolResponses(record, responses) {
    if (!responses.length || record.closing || !record.ready) return false;
    record.providerSession.sendToolResponse({ functionResponses: responses });
    return true;
  }

  clearDeliveredBoardContext(record, result) {
    const revision = toolBoardRevision(result);
    if (revision === null) return;
    const toolCallId = result?.toolCall?.id;
    const actionId = record.pendingBoardState?.actionId;
    const belongsToTool = toolCallId && actionId?.startsWith(`mentor:${toolCallId}:`);
    if (belongsToTool && record.pendingBoardState?.state?.revision === revision) {
      record.pendingBoardState = null;
    }
  }

  async executeToolBatch(record, turn, calls) {
    if (record.closing || turn.cancelled) return;
    this.ensureTurnPair(record, turn);
    turn.toolBatchCount += 1;
    const providerCalls = calls.map((call, index) => ({
      ...call,
      id: String(call.id || `live:${turn.turnId}:${turn.toolCallCount + index + 1}`),
      args: call.args && typeof call.args === 'object' ? call.args : {}
    }));

    if (turn.source === 'context') {
      this.sendToolResponses(record, providerCalls.map((call) => limitToolResponse(
        call,
        'Tools cannot run from a silent board-context update.',
        'live_context_tool_rejected'
      )));
      this.emitStatus(record, 'thinking');
      return;
    }
    if (turn.toolBatchCount > MAX_LIVE_TOOL_BATCHES) {
      this.sendToolResponses(record, providerCalls.map((call) => limitToolResponse(
        call,
        `Live mentor exceeded the ${MAX_LIVE_TOOL_BATCHES}-batch tool limit.`,
        'live_tool_batch_limit'
      )));
      this.emitStatus(record, 'thinking');
      return;
    }
    if (turn.toolCallCount + providerCalls.length > MAX_TOOL_CALLS) {
      this.sendToolResponses(record, providerCalls.map((call) => limitToolResponse(
        call,
        `Live mentor exceeded the ${MAX_TOOL_CALLS}-tool-call limit.`,
        'live_tool_call_limit'
      )));
      this.emitStatus(record, 'thinking');
      return;
    }

    turn.toolCallCount += providerCalls.length;
    turn.activeToolIds = providerCalls.map((call) => call.id);
    const responses = [];

    for (const call of providerCalls) {
      if (record.closing || turn.cancelled || turn.cancelledToolIds.has(call.id)) continue;
      turn.toolOrdinal += 1;
      turn.activeToolName = call.name;
      const controller = new AbortController();
      const execution = { controller, turn, cancelled: false };
      record.activeToolCalls.set(call.id, execution);
      this.emitStatus(record, 'tool_running', {
        toolName: call.name,
        toolLabel: toolLabel(call.name),
        toolCallIds: turn.activeToolIds
      });

      try {
        const result = await this.toolService.execute({
          conversationId: record.conversationId,
          requestId: turn.requestId,
          assistantMessageId: turn.pair.assistantMessage.id,
          ordinal: turn.toolOrdinal,
          call,
          signal: controller.signal,
          channel: this.voiceFirstPhysical ? 'live-physical' : 'live'
        });
        this.clearDeliveredBoardContext(record, result);
        if (!execution.cancelled && !turn.cancelled && !turn.cancelledToolIds.has(call.id)) {
          responses.push({ id: call.id, name: call.name, response: result.response });
        }
      } catch (error) {
        if (!isAbortError(error) && !execution.cancelled && !turn.cancelled) {
          responses.push({
            id: call.id,
            name: call.name,
            response: { error: { message: providerErrorMessage(error), code: error.code || 'tool_failed' } }
          });
        }
      } finally {
        if (record.activeToolCalls.get(call.id) === execution) record.activeToolCalls.delete(call.id);
      }
    }

    if (!record.closing && !turn.cancelled && this.sendToolResponses(record, responses)) {
      this.emitStatus(record, 'thinking');
    }
  }

  handleProviderMessage(record, message) {
    if (this.bySocket.get(record.socket.id) !== record || record.closing) return;
    if (message?.toolCallCancellation) {
      this.handleToolCancellation(record, message.toolCallCancellation);
    }
    const content = message?.serverContent;
    if (record.discardUnsolicitedAfterPhysical && !record.turn) {
      if (content?.inputTranscription?.text) {
        record.discardUnsolicitedAfterPhysical = false;
        record.suppressAudioUntilTurnComplete = false;
      } else if (content?.outputTranscription?.text
          || audioParts(message).length
          || message?.toolCall?.functionCalls?.length
          || content?.turnComplete) {
        if (content?.turnComplete) {
          record.discardUnsolicitedAfterPhysical = false;
          record.suppressAudioUntilTurnComplete = false;
          this.emitStatus(record, 'listening');
        }
        return;
      }
    }
    const interrupted = content?.interrupted === true;
    if (interrupted) {
      const interruptedTurn = record.turn;
      if (interruptedTurn) {
        interruptedTurn.cancelled = true;
        this.abortToolCalls(record);
      }
      record.socket.emit('mentor-live-interrupted', {
        ...this.statusPayload(record, 'interrupted'),
        turnId: interruptedTurn?.turnId || null
      });
      this.speakerService?.clearOutput(record.conversationId, record.sessionId, 'provider_interrupted');
      record.suppressAudioUntilTurnComplete = false;
      if (interruptedTurn && (interruptedTurn.assistantText
        || interruptedTurn.source !== 'audio'
        || interruptedTurn.pair)) {
        this.finalizeTurn(record, 'cancelled');
      }
      if (!record.turn) this.emitStatus(record, 'listening');
      if (content?.inputTranscription?.text) {
        this.handleInputTranscript(record, content.inputTranscription.text);
      }
      return;
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
        const audioTurn = this.currentTurn(record, record.contextPending ? 'context' : 'audio');
        audioTurn.receivedProviderOutput = true;
        this.notePhysicalTurnProgress(record, audioTurn);
        const mimeType = part.inlineData.mimeType || 'audio/pcm;rate=24000';
        const match = /rate=(\d+)/i.exec(mimeType);
        const sampleRate = match ? Number(match[1]) : AUDIO_OUTPUT_SAMPLE_RATE;
        let destination = record.speaker?.resolvedOutput === 'board' ? 'board' : 'browser';
        if (!record.suppressAudioUntilTurnComplete && this.speakerService) {
          const routed = this.speakerService.routeAudio({
            conversationId: record.conversationId,
            sessionId: record.sessionId,
            pcm: Buffer.from(part.inlineData.data, 'base64'),
            sampleRate
          });
          destination = routed.destination;
          if (destination === 'browser' && record.speaker?.outputMode === 'auto') {
            record.speaker = {
              ...record.speaker,
              resolvedOutput: 'browser',
              speakerStatus: 'fallback'
            };
          }
        }
        if (!record.suppressAudioUntilTurnComplete && destination === 'browser') {
          record.socket.emit('mentor-live-audio', {
            conversationId: record.conversationId,
            sessionId: record.sessionId,
            data: part.inlineData.data,
            mimeType,
            sampleRate
          });
        }
        if (!record.turn?.toolBusy) this.emitStatus(record, 'speaking');
      }
    }
    const hasToolCalls = message?.toolCall?.functionCalls?.length > 0;
    if (hasToolCalls) {
      this.queueToolBatch(record, message.toolCall.functionCalls);
    }
    if (content?.turnComplete && record.turn && !interrupted && !hasToolCalls) {
      this.speakerService?.endSpeech(record.conversationId, record.sessionId);
      record.suppressAudioUntilTurnComplete = false;
      if (record.turn.source === 'physical'
          && !record.turn.receivedProviderOutput
          && record.turn.emptyCompletionsIgnored < record.turn.emptyCompletionsToIgnore) {
        record.turn.emptyCompletionsIgnored += 1;
        this.emitStatus(record, 'thinking');
      } else if (record.turn.toolBusy) {
        record.turn.pendingFinalStatus = 'complete';
      } else {
        this.finalizeTurn(record, 'complete');
        this.emitStatus(record, 'listening');
      }
    }
  }

  finalizeTurn(record, status) {
    const turn = record.turn;
    if (!turn) return null;
    if (status === 'complete' && turn.toolBusy) {
      turn.pendingFinalStatus = status;
      return null;
    }
    if (turn.timeoutId) {
      clearTimeout(turn.timeoutId);
      turn.timeoutId = null;
    }
    if (status !== 'complete') {
      turn.cancelled = true;
      this.abortToolCalls(record);
    }
    record.turn = null;
    record.contextPending = false;
    if (turn.source === 'physical') {
      record.physicalGuidanceLock = false;
      record.discardUnsolicitedAfterPhysical = true;
      record.suppressAudioUntilTurnComplete = true;
    }

    if (turn.source === 'context') {
      turn.resolveCompletion?.(null);
      if (record.pendingContextReconnect) {
        this.reconnectProvider(record).catch(() => {});
        return null;
      }
      if (!this.flushPendingSystemTurns(record)) this.flushBoardContext(record);
      return null;
    }

    const userText = turn.userText || 'Voice input was not transcribed.';
    const assistantStatus = status === 'complete' && !turn.assistantText ? 'failed' : status;
    let pair = turn.pair;
    if (!pair) {
      pair = this.store.createMessagePair(record.conversationId, {
        requestId: turn.requestId,
        text: userText,
        kind: turn.source === 'physical' ? 'physical' : 'voice',
        assistantContent: turn.assistantText,
        assistantStatus,
        suppressTitle: turn.source === 'physical'
      });
    } else {
      this.store.replaceMessageContent(pair.userMessage.id, userText);
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
    turn.resolveCompletion?.({ status: assistantStatus, ...pair });
    if (record.pendingContextReconnect) {
      this.reconnectProvider(record).catch(() => {});
      return pair;
    }
    if (!this.flushPendingSystemTurns(record)) this.flushBoardContext(record);
    return pair;
  }

  startPhysicalTurn(record, request) {
    if (request.validateBeforeStart && !request.validateBeforeStart()) {
      return { stale: true, sessionId: record.sessionId };
    }
    const existing = this.store.getRequestMessages(record.conversationId, request.requestId);
    if (existing.length) return { duplicate: true, sessionId: record.sessionId };
    let pair = this.store.createMessagePair(record.conversationId, {
      requestId: request.requestId,
      text: request.displayText,
      kind: 'physical',
      suppressTitle: true
    });
    const turn = this.createTurn(record, {
      turnId: this.createId(),
      requestId: request.requestId,
      source: 'physical',
      userText: request.displayText,
      assistantText: request.expectedAssistantText || '',
      expectedAssistantText: request.expectedAssistantText,
      pair,
      emptyCompletionsToIgnore: request.urgent ? 1 : 0
    });
    if (turn.expectedAssistantText) {
      this.store.replaceMessageContent(pair.assistantMessage.id, turn.expectedAssistantText);
      pair = {
        ...pair,
        assistantMessage: this.store.getMessage(pair.assistantMessage.id)
      };
      turn.pair = pair;
    }
    record.contextPending = false;
    if (request.replaceOutput) {
      this.speakerService?.clearOutput(
        record.conversationId,
        record.sessionId,
        'physical_guidance_replaced'
      );
    }
    record.suppressAudioUntilTurnComplete = false;
    record.physicalGuidanceLock = request.urgent === true;
    record.discardUnsolicitedAfterPhysical = false;
    record.turn = turn;
    this.armPhysicalTurnTimeout(record, turn, request);
    this.emit(record.conversationId, 'mentor-live-user-transcript', {
      ...this.statusPayload(record, 'listening'),
      turnId: turn.turnId,
      text: request.displayText,
      isFinal: true,
      message: pair.userMessage
    });
    this.emit(record.conversationId, 'mentor-live-assistant-transcript', {
      ...this.statusPayload(record, 'thinking'),
      turnId: turn.turnId,
      text: turn.assistantText,
      isFinal: false,
      message: pair.assistantMessage
    });
    turn.shellEmitted = true;
    if (!request.promptAlreadySent) {
      record.providerSession.sendRealtimeInput({ text: request.prompt });
    }
    this.emitStatus(record, 'thinking');
    return { duplicate: false, ...pair, completion: turn.completion, sessionId: record.sessionId };
  }

  flushPendingSystemTurns(record) {
    if (record.turn || record.closing || !record.ready || !record.pendingSystemTurns.length) return false;
    while (record.pendingSystemTurns.length) {
      const request = record.pendingSystemTurns.shift();
      if (request.validateBeforeStart && !request.validateBeforeStart()) continue;
      if (request.activityTurn) {
        const started = this.startActivityTurn(record, request);
        started.completion.then(request.resolveQueuedCompletion);
        return true;
      }
      this.startPhysicalTurn(record, request);
      return true;
    }
    return false;
  }

  requestContextReconnect(conversationId, reason = 'workspace_changed') {
    const record = this.byConversation.get(conversationId);
    if (!record || record.closing) return null;
    record.pendingContextReconnect = { reason, requestedAt: Date.now() };
    this.speakerService?.clearOutput(record.conversationId, record.sessionId, reason);
    this.emitStatus(record, 'switching_source', { reason, text: 'Switching to physical board' });
    if (!record.turn && !this.hasActiveTools(record)) this.reconnectProvider(record).catch(() => {});
    return { queued: Boolean(record.turn || this.hasActiveTools(record)), sessionId: record.sessionId };
  }

  async reconnectProvider(record) {
    if (!record || record.closing || record.reconnecting || !record.pendingContextReconnect) return false;
    record.reconnecting = true;
    record.ready = false;
    const pending = record.pendingContextReconnect;
    record.pendingContextReconnect = null;
    this.emitStatus(record, 'reconnecting', { reason: pending.reason, text: 'Reconnecting' });
    const previous = record.providerSession;
    record.providerGeneration += 1;
    record.providerSession = null;
    try {
      await Promise.resolve(previous?.close?.()).catch(() => {});
      await this.connectProvider(record);
      record.ready = true;
      record.reconnecting = false;
      this.emitStatus(record, 'listening', { reason: pending.reason, reconnected: true });
      return true;
    } catch (error) {
      record.reconnecting = false;
      this.logger.error?.('[MENTOR_LIVE_RECONNECT_FAILED]', JSON.stringify({
        conversationId: record.conversationId,
        sessionId: record.sessionId,
        reason: pending.reason,
        error: providerErrorMessage(error)
      }));
      record.socket.emit('mentor-live-error', {
        ...this.statusPayload(record, 'failed'),
        code: 'mentor_live_reconnect_failed',
        error: providerErrorMessage(error)
      });
      await this.closeRecord(record, 'context_reconnect_failed');
      return false;
    }
  }

  requestPhysicalTurn(conversationId, request) {
    const record = this.byConversation.get(conversationId);
    if (!record || record.closing || !record.ready) return null;
    if (this.store.getRequestMessages(conversationId, request.requestId).length) {
      return { duplicate: true, sessionId: record.sessionId };
    }
    if (record.pendingSystemTurns.some((item) => item.requestId === request.requestId)) {
      return { duplicate: true, queued: true, sessionId: record.sessionId };
    }
    if (request.queueKey) {
      record.pendingSystemTurns = record.pendingSystemTurns
        .filter((item) => item.queueKey !== request.queueKey);
    }
    if (request.urgent) {
      this.speakerService?.clearOutput(
        record.conversationId,
        record.sessionId,
        'physical_guidance_interrupt'
      );
    }
    if (request.urgent && (record.turn || this.hasActiveTools(record))) {
      const queued = record.pendingSystemTurns
        .filter((item) => item.requestId !== request.requestId);
      record.pendingSystemTurns = [{ ...request, promptAlreadySent: true }, ...queued];
      record.physicalGuidanceLock = true;
      record.suppressAudioUntilTurnComplete = true;
      this.abortToolCalls(record);
      if (record.turn) {
        record.turn.cancelled = true;
      }
      record.socket.emit('mentor-live-interrupted', {
        ...this.statusPayload(record, 'interrupted'),
        physicalGuidance: true
      });
      record.providerSession.sendRealtimeInput({ audioStreamEnd: true });
      record.providerSession.sendRealtimeInput({ text: request.prompt });
      return { queued: true, interrupting: true, sessionId: record.sessionId };
    }
    if (record.turn || this.hasActiveTools(record)) {
      if (!record.pendingSystemTurns.some((item) => item.requestId === request.requestId)) {
        record.pendingSystemTurns.push(request);
      }
      return { queued: true, sessionId: record.sessionId };
    }
    return this.startPhysicalTurn(record, request);
  }

  requestActivityTurn(conversationId, { requestId, displayText, prompt }) {
    const record = this.byConversation.get(conversationId);
    if (!record || record.closing || !record.ready) return null;
    const pending = record.pendingSystemTurns.find((item) => item.activityTurn && item.requestId === requestId);
    if (pending) return { queued: true, completion: pending.queuedCompletion, sessionId: record.sessionId };
    if (record.turn || this.hasActiveTools(record)) {
      let resolveQueuedCompletion;
      const queuedCompletion = new Promise((resolve) => { resolveQueuedCompletion = resolve; });
      record.pendingSystemTurns.unshift({
        activityTurn: true,
        requestId,
        displayText,
        prompt,
        queuedCompletion,
        resolveQueuedCompletion
      });
      return { queued: true, completion: queuedCompletion, sessionId: record.sessionId };
    }
    return this.startActivityTurn(record, { requestId, displayText, prompt });
  }

  startActivityTurn(record, { requestId, displayText, prompt }) {
    const conversationId = record.conversationId;
    const pair = this.store.createMessagePair(conversationId, {
      requestId,
      text: displayText,
      kind: 'activity'
    });
    const turn = this.createTurn(record, {
      turnId: this.createId(),
      requestId,
      source: 'activity',
      userText: displayText,
      assistantText: '',
      pair
    });
    record.contextPending = false;
    record.turn = turn;
    this.emit(conversationId, 'mentor-live-user-transcript', {
      ...this.statusPayload(record, 'listening'),
      turnId: turn.turnId,
      text: displayText,
      isFinal: true,
      message: pair.userMessage
    });
    this.emit(conversationId, 'mentor-live-assistant-transcript', {
      ...this.statusPayload(record, 'thinking'),
      turnId: turn.turnId,
      text: '',
      isFinal: false,
      message: pair.assistantMessage
    });
    turn.shellEmitted = true;
    record.providerSession.sendRealtimeInput({ text: prompt });
    this.emitStatus(record, 'thinking');
    return { ...pair, completion: turn.completion, sessionId: record.sessionId };
  }

  clearPendingSystemTurns(record, status = 'cancelled') {
    const pending = record.pendingSystemTurns;
    record.pendingSystemTurns = [];
    for (const request of pending) {
      request.resolveQueuedCompletion?.({ status });
    }
  }

  notifyBoardUpdated(conversationId, state, { actionId = null } = {}) {
    const record = this.byConversation.get(conversationId);
    if (!record || record.closing || !record.ready) return false;
    record.pendingBoardState = { state, actionId };
    if (!record.turn) this.flushBoardContext(record);
    return true;
  }

  notifyPhysicalBoardUpdated(conversationId, state) {
    return this.notifyBoardUpdated(conversationId, state, { actionId: null });
  }

  flushBoardContext(record) {
    if (!record.pendingBoardState || record.turn || record.closing || !record.ready) return false;
    const { state } = record.pendingBoardState;
    record.pendingBoardState = null;
    record.contextPending = false;
    record.providerSession.sendClientContent({
      turns: [{
        role: 'user',
        parts: [{ text: `[BOARD_CONTEXT_UPDATE]\n${boardContextFromState(state)}` }]
      }],
      turnComplete: false
    });
    return true;
  }

  handleProviderError(record, error) {
    if (this.bySocket.get(record.socket.id) !== record) return;
    const message = providerErrorMessage(error);
    record.ready = false;
    record.physicalGuidanceLock = false;
    record.discardUnsolicitedAfterPhysical = false;
    record.pendingBoardState = null;
    this.clearPendingSystemTurns(record, 'failed');
    this.abortToolCalls(record);
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

  handleProviderClose(record, event = {}) {
    if (this.bySocket.get(record.socket.id) !== record && record.closedEmitted) return;
    const unexpected = !record.closing;
    const closeMessage = event?.reason || 'Gemini Live closed unexpectedly.';
    this.logger.log?.('[MENTOR_LIVE_PROVIDER_CLOSED]', JSON.stringify({
      conversationId: record.conversationId,
      sessionId: record.sessionId,
      code: event?.code ?? null,
      reason: event?.reason || null,
      wasClean: event?.wasClean ?? null
    }));
    record.ready = false;
    record.physicalGuidanceLock = false;
    record.discardUnsolicitedAfterPhysical = false;
    this.speakerService?.releaseSession(record.conversationId, record.sessionId, 'provider_closed');
    record.pendingBoardState = null;
    this.clearPendingSystemTurns(record, unexpected ? 'failed' : 'cancelled');
    this.abortToolCalls(record);
    if (record.turn) this.finalizeTurn(record, unexpected ? 'failed' : 'cancelled');
    this.release(record);
    if (unexpected) {
      record.socket.emit('mentor-live-error', {
        ...this.statusPayload(record, 'failed'),
        error: closeMessage,
        code: 'mentor_live_provider_closed'
      });
      this.emitStatus(record, 'failed', { error: closeMessage });
    }
    if (!record.closedEmitted) {
      record.closedEmitted = true;
      this.emit(record.conversationId, 'mentor-live-closed', {
        ...this.statusPayload(record, unexpected ? 'failed' : 'closed'),
        reason: unexpected ? closeMessage : 'provider_closed',
        failed: unexpected
      });
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
    record.physicalGuidanceLock = false;
    record.discardUnsolicitedAfterPhysical = false;
    this.logger.log?.('[MENTOR_LIVE_CLOSING]', JSON.stringify({
      conversationId: record.conversationId,
      sessionId: record.sessionId,
      reason
    }));
    this.abortToolCalls(record);
    this.clearPendingSystemTurns(record, 'cancelled');
    if (record.turn) this.finalizeTurn(record, 'cancelled');
    await record.toolQueue.catch(() => {});
    try {
      record.providerSession?.sendRealtimeInput({ audioStreamEnd: true });
    } catch (error) {
      this.logger.warn?.('[MENTOR_LIVE_AUDIO_END_FAILED]', providerErrorMessage(error));
    }
    this.speakerService?.releaseSession(record.conversationId, record.sessionId, reason);
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

  interruptOutput(socket, payload = {}) {
    const record = this.assertRecord(socket, payload);
    record.suppressAudioUntilTurnComplete = true;
    this.speakerService?.clearOutput(record.conversationId, record.sessionId, 'client_interrupt');
    record.socket.emit('mentor-live-interrupted', {
      ...this.statusPayload(record, 'interrupted'),
      turnId: record.turn?.turnId || null,
      outputOnly: true
    });
    this.emitStatus(record, record.turn?.toolBusy ? 'tool_running' : 'listening');
    return true;
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
    socket.on('mentor-live-interrupt-output', (payload = {}, acknowledge) => {
      try {
        const success = this.interruptOutput(socket, payload);
        reply(acknowledge, { success });
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
  LIVE_TOOL_LABELS,
  LIVE_SYSTEM_INSTRUCTION,
  MAX_LIVE_TOOL_BATCHES,
  MentorLiveService,
  boardContextFromState,
  initialHistoryTurns,
  mergeTranscript
};
