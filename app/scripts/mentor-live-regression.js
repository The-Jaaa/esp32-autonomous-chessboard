const assert = require('assert');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const { createMentorFeature } = require('../mentor');
const { MentorStore } = require('../mentor/store');
const {
  DeterministicMentorLiveConnector,
  initialHistoryTurns,
  mergeTranscript
} = require('../mentor/live-service');

function waitForEvent(emitter, event, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}.`));
    }, timeoutMs);
    const listener = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.off(event, listener);
      resolve(payload);
    };
    emitter.on(event, listener);
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function waitForCondition(predicate, message, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(message));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function delayWithSignal(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      const error = new Error('Synthetic analysis cancelled.');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function storeAndTranscriptRegressions() {
  assert.strictEqual(mergeTranscript('', 'Can you'), 'Can you');
  assert.strictEqual(mergeTranscript('Can you', 'Can you explain this?'), 'Can you explain this?');
  assert.strictEqual(mergeTranscript('Can you explain', 'explain this?'), 'Can you explain this?');
  assert.strictEqual(mergeTranscript('Complete sentence', 'sentence'), 'Complete sentence');

  const initialTurns = initialHistoryTurns([{
    role: 'user',
    content: 'Show me a fork.'
  }, {
    role: 'model',
    content: 'Let us use the board.'
  }], {
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    pgn: '',
    turnName: 'White',
    gameStatus: { resultText: 'Game in progress' },
    history: [],
    orientation: 'white',
    revision: 0,
    annotations: { highlights: [], arrows: [] }
  });
  assert.strictEqual(initialTurns.length, 1);
  assert.strictEqual(initialTurns[0].role, 'user');
  assert.match(initialTurns[0].parts[0].text, /Learner: Show me a fork\./);
  assert.match(initialTurns[0].parts[0].text, /Mentor: Let us use the board\./);
  assert.match(initialTurns[0].parts[0].text, /INITIAL_CHESS_WORKSPACE/);

  const store = new MentorStore({ dbPath: ':memory:' });
  const conversation = store.createConversation();
  const pair = store.createMessagePair(conversation.id, {
    requestId: 'voice:test:1',
    text: 'Teach me by voice',
    kind: 'voice',
    assistantContent: 'Let us begin.',
    assistantStatus: 'complete'
  });
  assert.strictEqual(pair.userMessage.kind, 'voice');
  assert.strictEqual(pair.assistantMessage.kind, 'voice');
  assert.strictEqual(pair.assistantMessage.content, 'Let us begin.');
  assert.strictEqual(store.getConversation(conversation.id).title, 'Teach me by voice');
  store.close();
}

async function socketRegressions() {
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const io = new Server(server);
  const connector = new DeterministicMentorLiveConnector({ delayMs: 20 });
  let releaseHeldText;
  const provider = {
    async *stream({ messages }) {
      if (messages.at(-1)?.content === 'Hold this text response.') {
        await new Promise((resolve) => { releaseHeldText = resolve; });
      }
      yield 'Text response.';
    }
  };
  const feature = createMentorFeature({
    app,
    io,
    ai: {},
    dbPath: ':memory:',
    provider,
    liveConnector: connector
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const createConversation = () => fetch(`${baseUrl}/api/mentor/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }).then((response) => response.json()).then((body) => body.conversation);
  const first = await createConversation();
  const second = await createConversation();
  const textBusy = await createConversation();
  const toolConversation = await createConversation();
  const activityConversation = await createConversation();
  const client = createClient(baseUrl, { transports: ['websocket'] });
  const competingClient = createClient(baseUrl, { transports: ['websocket'] });
  await Promise.all([
    waitForEvent(client, 'connect'),
    waitForEvent(competingClient, 'connect')
  ]);
  await emitWithAck(client, 'mentor-subscribe', { conversationId: first.id });
  await emitWithAck(competingClient, 'mentor-subscribe', { conversationId: first.id });

  const statusEvents = [];
  client.on('mentor-live-status', (payload) => statusEvents.push(payload.status));
  const started = await emitWithAck(client, 'mentor-live-start', { conversationId: first.id });
  assert.strictEqual(started.success, true);
  assert.strictEqual(connector.sessions.length, 1);
  assert.strictEqual(connector.connectCalls[0].model, 'gemini-3.1-flash-live-preview');
  assert.strictEqual(connector.sessions[0].clientContent.length, 1);
  assert.match(
    connector.sessions[0].clientContent[0].turns.at(-1).parts[0].text,
    /INITIAL_CHESS_WORKSPACE/
  );
  assert.ok(statusEvents.includes('listening'));

  const competing = await emitWithAck(competingClient, 'mentor-live-start', { conversationId: first.id });
  assert.strictEqual(competing.success, false);
  assert.strictEqual(competing.code, 'mentor_live_conversation_busy');

  const blockedRest = await fetch(`${baseUrl}/api/mentor/conversations/${first.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'blocked-rest', text: 'Do not run this.' })
  });
  assert.strictEqual(blockedRest.status, 409);
  assert.strictEqual((await blockedRest.json()).code, 'mentor_live_active');

  const typedComplete = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.isFinal && payload.message?.requestId === 'live-typed-1');
  const typed = await emitWithAck(client, 'mentor-live-text-input', {
    conversationId: first.id,
    sessionId: started.sessionId,
    requestId: 'live-typed-1',
    text: 'Explain the center.'
  });
  assert.strictEqual(typed.success, true);
  await typedComplete;
  const typedMessages = feature.store.getRequestMessages(first.id, 'live-typed-1');
  assert.strictEqual(typedMessages.length, 2);
  assert.ok(typedMessages.every((message) => message.kind === 'voice'));
  assert.strictEqual(typedMessages[1].status, 'complete');
  assert.match(typedMessages[1].content, /typed question/);

  const duplicate = await emitWithAck(client, 'mentor-live-text-input', {
    conversationId: first.id,
    sessionId: started.sessionId,
    requestId: 'live-typed-1',
    text: 'Duplicate text.'
  });
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(feature.store.getRequestMessages(first.id, 'live-typed-1').length, 2);

  const audioComplete = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.isFinal && payload.message?.requestId?.startsWith('voice:'));
  await emitWithAck(client, 'mentor-live-audio-end', {
    conversationId: first.id,
    sessionId: started.sessionId
  });
  const audioResult = await audioComplete;
  const audioMessages = feature.store.getRequestMessages(first.id, audioResult.message.requestId);
  assert.strictEqual(audioMessages[0].content, 'Can you explain this position?');
  assert.strictEqual(audioMessages[1].content, 'Yes. Let us examine the position together.');

  const queuedTypedFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.isFinal && payload.message?.requestId === 'live-before-check');
  await emitWithAck(client, 'mentor-live-text-input', {
    conversationId: first.id,
    sessionId: started.sessionId,
    requestId: 'live-before-check',
    text: 'Finish this explanation before announcing check.'
  });
  const queuedPhysicalFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.isFinal && payload.message?.requestId === 'physical:check');
  const queuedPhysical = feature.liveService.requestPhysicalTurn(first.id, {
    requestId: 'physical:check',
    displayText: 'Black is in check.',
    prompt: '[PHYSICAL_BOARD_GUIDANCE]\nBlack is in check.',
    urgent: false
  });
  assert.strictEqual(queuedPhysical.queued, true);
  await queuedTypedFinal;
  await queuedPhysicalFinal;
  assert.ok(feature.store.getRequestMessages(first.id, 'physical:check').every((message) => message.kind === 'physical'));

  const urgentPartial = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    !payload.isFinal && payload.message?.requestId === 'live-before-warning' && payload.text);
  await emitWithAck(client, 'mentor-live-text-input', {
    conversationId: first.id,
    sessionId: started.sessionId,
    requestId: 'live-before-warning',
    text: 'This response should be interrupted by a board warning.'
  });
  await urgentPartial;
  const urgentPhysicalFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.isFinal && payload.message?.requestId === 'physical:restore-e2');
  const urgentPhysical = feature.liveService.requestPhysicalTurn(first.id, {
    requestId: 'physical:restore-e2',
    displayText: 'Restore or center e2.',
    prompt: '[PHYSICAL_BOARD_GUIDANCE]\nPlease restore or center e2.',
    urgent: true,
    expectedAssistantText: 'Please restore or center e2.'
  });
  assert.strictEqual(urgentPhysical.queued, true);
  assert.strictEqual(urgentPhysical.interrupting, true);
  const guidanceBusy = await emitWithAck(client, 'mentor-live-text-input', {
    conversationId: first.id,
    sessionId: started.sessionId,
    requestId: 'live-during-physical-warning',
    text: 'This must not interrupt the recovery instruction.'
  });
  assert.strictEqual(guidanceBusy.success, false);
  assert.strictEqual(guidanceBusy.code, 'mentor_live_physical_guidance_busy');
  await urgentPhysicalFinal;
  assert.strictEqual(feature.store.getRequestMessages(first.id, 'live-before-warning')[1].status, 'cancelled');
  assert.strictEqual(feature.store.getRequestMessages(first.id, 'physical:restore-e2')[1].status, 'complete');
  assert.strictEqual(
    feature.store.getRequestMessages(first.id, 'physical:restore-e2')[1].content,
    'Please restore or center e2.'
  );
  assert.strictEqual(connector.sessions[0].realtimeInputs.filter((input) =>
    input.text?.startsWith('[PHYSICAL_BOARD_GUIDANCE]\nPlease restore or center e2.')).length, 1);
  const messageCountBeforeUnsolicitedTail = feature.store.listMessages(first.id).length;
  connector.sessions[0].callbacks.onmessage?.({
    serverContent: {
      outputTranscription: { text: 'Just as I was saying, here is the interrupted explanation.' },
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
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(feature.store.listMessages(first.id).length, messageCountBeforeUnsolicitedTail);

  const boardResponse = await fetch(`${baseUrl}/api/mentor/conversations/${first.id}/moves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uci: 'e2e4', expectedRevision: 0, actionId: 'live-board-1' })
  });
  assert.strictEqual(boardResponse.status, 200);
  assert.ok(connector.sessions[0].clientContent.some((input) =>
    input.turnComplete === false
      && input.turns?.[0]?.parts?.[0]?.text?.startsWith('[BOARD_CONTEXT_UPDATE]')
      && input.turns[0].parts[0].text.includes(' b ')));
  assert.strictEqual(
    connector.sessions[0].realtimeInputs.some((input) => input.text?.startsWith('[BOARD_CONTEXT_UPDATE]')),
    false,
    'silent board context must not use the response-triggering realtime text channel'
  );

  const interruptedFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.isFinal && payload.message?.requestId === 'live-interrupt-1');
  const partial = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    !payload.isFinal && payload.turnId && payload.text);
  await emitWithAck(client, 'mentor-live-text-input', {
    conversationId: first.id,
    sessionId: started.sessionId,
    requestId: 'live-interrupt-1',
    text: 'Start a long answer.'
  });
  await partial;
  connector.sessions[0].interrupt();
  const interrupted = await interruptedFinal;
  assert.strictEqual(interrupted.message.status, 'cancelled');
  assert.ok(interrupted.message.content.length > 0);

  const liveSession = connector.sessions[0];
  const progressiveRealtimeInput = liveSession.sendRealtimeInput.bind(liveSession);
  liveSession.sendRealtimeInput = (payload) => {
    if (payload.text === '[PHYSICAL_OPENING_STEP]\nExplain the strategic idea.') {
      liveSession.realtimeInputs.push(payload);
      return;
    }
    progressiveRealtimeInput(payload);
  };
  const progressiveFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.isFinal && payload.message?.requestId === 'physical:progressive-speech');
  feature.liveService.requestPhysicalTurn(first.id, {
    requestId: 'physical:progressive-speech',
    displayText: 'Black played a reviewed move.',
    prompt: '[PHYSICAL_OPENING_STEP]\nExplain the strategic idea.',
    fallbackAssistantText: 'Fallback opening guidance.',
    timeoutMs: 60,
    queueKey: 'physical-opening'
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  liveSession.callbacks.onmessage({
    serverContent: { outputTranscription: { text: 'The actual spoken strategic explanation' } }
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  liveSession.callbacks.onmessage({
    serverContent: {
      outputTranscription: { text: ' connects development with central control.' },
      turnComplete: true
    }
  });
  const progressive = await progressiveFinal;
  assert.strictEqual(progressive.message.status, 'complete');
  assert.match(progressive.message.content, /actual spoken strategic explanation/i);
  assert.match(progressive.message.content, /development with central control/i);
  assert.doesNotMatch(progressive.message.content, /fallback opening guidance/i);
  liveSession.sendRealtimeInput = progressiveRealtimeInput;

  const sendRealtimeInput = liveSession.sendRealtimeInput.bind(liveSession);
  liveSession.sendRealtimeInput = (payload) => {
    if (payload.text === '[PHYSICAL_OPENING_STEP]\nSimulate a stalled provider response.') {
      liveSession.realtimeInputs.push(payload);
      return;
    }
    sendRealtimeInput(payload);
  };
  const timeoutFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.isFinal && payload.message?.requestId === 'physical:opening-timeout');
  feature.liveService.requestPhysicalTurn(first.id, {
    requestId: 'physical:opening-timeout',
    displayText: 'Black completed the reviewed line.',
    prompt: '[PHYSICAL_OPENING_STEP]\nSimulate a stalled provider response.',
    expectedAssistantText: 'The reviewed line is complete. Choose Repeat, Continue, or Finish.',
    fallbackAssistantText: 'The reviewed line is complete. Choose Repeat, Continue, or Finish.',
    timeoutMs: 25,
    queueKey: 'physical-opening'
  });
  assert.strictEqual(
    feature.store.getRequestMessages(first.id, 'physical:opening-timeout')[1].content,
    'The reviewed line is complete. Choose Repeat, Continue, or Finish.',
    'physical fallback guidance should be visible before provider output'
  );
  const timedOut = await timeoutFinal;
  assert.strictEqual(timedOut.message.status, 'complete');
  assert.strictEqual(feature.liveService.isConversationActive(first.id), true);
  liveSession.sendRealtimeInput = sendRealtimeInput;

  const failedFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.isFinal && payload.message?.requestId === 'live-failure-1');
  await emitWithAck(client, 'mentor-live-text-input', {
    conversationId: first.id,
    sessionId: started.sessionId,
    requestId: 'live-failure-1',
    text: 'Trigger a provider failure.'
  });
  connector.sessions[0].fail('Mock Live provider failure');
  assert.strictEqual((await failedFinal).message.status, 'failed');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(feature.liveService.isConversationActive(first.id), false);

  await emitWithAck(client, 'mentor-subscribe', { conversationId: textBusy.id });
  const textRequest = await fetch(`${baseUrl}/api/mentor/conversations/${textBusy.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'held-text', text: 'Hold this text response.' })
  });
  assert.strictEqual(textRequest.status, 202);
  const liveDuringText = await emitWithAck(client, 'mentor-live-start', { conversationId: textBusy.id });
  assert.strictEqual(liveDuringText.success, false);
  assert.strictEqual(liveDuringText.code, 'mentor_text_active');
  releaseHeldText();
  await waitForEvent(client, 'mentor-message-complete', (payload) => payload.requestId === 'held-text');

  feature.toolService.delay = (milliseconds, signal) => delayWithSignal(Math.min(milliseconds, 80), signal);
  feature.toolService.analysisService = {
    async analyzePosition(conversationId, { mode = 'quick', signal } = {}) {
      await delayWithSignal(60, signal);
      const state = feature.chessService.getState(conversationId);
      return {
        kind: 'position_analysis',
        analyzedFen: state.fen,
        analyzedRevision: state.revision,
        mode,
        score: { type: 'cp', value: 24 },
        wdl: { white: 410, draw: 390, black: 200 },
        bestMove: { uci: state.legalMoves[0], san: state.legalMoves[0] },
        lines: [],
        telemetry: { depth: 10, elapsedMs: 60 }
      };
    },
    async analyzeMove(conversationId, { uci, mode = 'quick', signal, onProgress = () => {} } = {}) {
      onProgress(1, 2);
      await delayWithSignal(30, signal);
      onProgress(2, 2);
      const state = feature.chessService.getState(conversationId);
      return {
        kind: 'move_analysis',
        source: 'candidate',
        analyzedFen: state.fen,
        analyzedRevision: state.revision,
        mode,
        move: { uci, san: uci },
        classification: 'good',
        centipawnLoss: 20,
        before: { score: { type: 'cp', value: 24 }, lines: [] },
        after: { score: { type: 'cp', value: 4 }, lines: [] },
        score: { type: 'cp', value: 24 },
        wdl: { white: 410, draw: 390, black: 200 },
        bestAlternative: null
      };
    }
  };

  await emitWithAck(client, 'mentor-subscribe', { conversationId: toolConversation.id });
  const toolStart = await emitWithAck(client, 'mentor-live-start', { conversationId: toolConversation.id });
  assert.strictEqual(toolStart.success, true);
  const toolSession = connector.sessions.at(-1);
  const declarationNames = connector.connectCalls.at(-1).config.tools[0].functionDeclarations
    .map((declaration) => declaration.name);
  const expectedToolNames = [
    'get_board_state',
    'analyze_position',
    'analyze_move',
    'play_move',
    'play_line',
    'load_position',
    'reset_board',
    'set_orientation',
    'annotate_board',
    'get_activity_state',
    'start_activity',
    'propose_activity',
    'request_prediction',
    'request_hint',
    'end_activity'
  ];
  assert.deepStrictEqual([...declarationNames].sort(), [...expectedToolNames].sort());

  const earlyToolStarted = waitForEvent(client, 'mentor-tool-started', (payload) =>
    payload.conversationId === toolConversation.id && payload.toolCall.providerCallId === 'live-early-analysis');
  const earlyFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.conversationId === toolConversation.id && payload.isFinal);
  toolSession.emitToolCall([{
    id: 'live-early-analysis',
    name: 'analyze_position',
    args: { mode: 'quick' }
  }], 'I analyzed the position after hearing your full question.', { turnComplete: true });
  await earlyToolStarted;
  const earlyMessages = feature.store.listMessages(toolConversation.id);
  assert.strictEqual(earlyMessages.length, 2, 'A durable voice pair was not created before the tool ran.');
  assert.strictEqual(earlyMessages[0].content, 'Voice request in progress.');
  toolSession.callbacks.onmessage({
    serverContent: { inputTranscription: { text: 'Analyze this position before explaining it.' } }
  });
  const earlyResult = await earlyFinal;
  assert.strictEqual(
    earlyResult.message.content,
    'I analyzed the position after hearing your full question.',
    'A tool-call turnComplete closed the voice response before the tool explanation.'
  );
  const earlyRequestId = earlyResult.message.requestId;
  assert.strictEqual(
    feature.store.getRequestMessages(toolConversation.id, earlyRequestId)[0].content,
    'Analyze this position before explaining it.'
  );
  assert.strictEqual(
    feature.store.getConversation(toolConversation.id).title,
    'Analyze this position before explaining it.'
  );
  assert.strictEqual(feature.store.listToolCalls(toolConversation.id)[0].assistantMessageId, earlyResult.message.id);

  const allToolsFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.conversationId === toolConversation.id
      && payload.isFinal
      && payload.message?.requestId !== earlyRequestId,
  5000);
  toolSession.callbacks.onmessage({
    serverContent: { inputTranscription: { text: 'Use every available mentor tool in order.' } }
  });
  toolSession.emitToolCall([
    { id: 'live-all-1', name: 'get_board_state', args: {} },
    { id: 'live-all-2', name: 'play_move', args: { uci: 'e2e4' } },
    { id: 'live-all-3', name: 'play_line', args: { moves: ['e7e5', 'g1f3'] } },
    { id: 'live-all-4', name: 'set_orientation', args: { orientation: 'black' } },
    {
      id: 'live-all-5',
      name: 'annotate_board',
      args: {
        highlights: [{ square: 'f7', role: 'danger' }],
        arrows: [{ from: 'f3', to: 'e5', role: 'idea' }]
      }
    },
    { id: 'live-all-6', name: 'analyze_position', args: { mode: 'quick' } },
    { id: 'live-all-7', name: 'analyze_move', args: { uci: 'b8c6', mode: 'quick' } },
    { id: 'live-all-8', name: 'load_position', args: { fen: '7k/8/8/8/8/8/8/K7 w - - 0 1' } },
    { id: 'live-all-9', name: 'reset_board', args: {} }
  ], 'All nine shared mentor tools completed in order.');
  const allToolsResult = await allToolsFinal;
  const allToolsResponse = toolSession.toolResponses.at(-1).functionResponses;
  assert.deepStrictEqual(allToolsResponse.map((response) => response.id), [
    'live-all-1', 'live-all-2', 'live-all-3', 'live-all-4', 'live-all-5',
    'live-all-6', 'live-all-7', 'live-all-8', 'live-all-9'
  ]);
  assert.deepStrictEqual(allToolsResponse.map((response) => response.name), [
    'get_board_state', 'play_move', 'play_line', 'set_orientation', 'annotate_board',
    'analyze_position', 'analyze_move', 'load_position', 'reset_board'
  ]);
  assert.ok(allToolsResponse.every((response) => response.response.output));
  const allToolsRecords = feature.store.listToolCalls(toolConversation.id)
    .filter((toolCall) => toolCall.requestId === allToolsResult.message.requestId);
  assert.strictEqual(allToolsRecords.length, 9);
  assert.ok(allToolsRecords.every((toolCall) => toolCall.status === 'complete'));
  assert.strictEqual(feature.chessService.getState(toolConversation.id).history.length, 0);

  const invalidFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.conversationId === toolConversation.id
      && payload.isFinal
      && payload.message?.requestId !== allToolsResult.message.requestId);
  toolSession.callbacks.onmessage({
    serverContent: { inputTranscription: { text: 'Try invalid tools without changing the board.' } }
  });
  toolSession.emitToolCall([
    { id: 'live-invalid-move', name: 'play_move', args: { uci: 'e2e5' } },
    { id: 'live-invalid-fen', name: 'load_position', args: { fen: 'not-a-fen' } },
    { id: 'live-unknown-tool', name: 'invent_board_state', args: {} }
  ], 'The invalid actions were rejected safely.');
  const invalidResult = await invalidFinal;
  const invalidResponses = toolSession.toolResponses.at(-1).functionResponses;
  assert.ok(invalidResponses.every((response) => response.response.error));
  assert.strictEqual(feature.chessService.getState(toolConversation.id).history.length, 0);

  const callLimitFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
      payload.conversationId === toolConversation.id
      && payload.isFinal
      && payload.message?.requestId !== invalidResult.message.requestId);
  toolSession.callbacks.onmessage({
    serverContent: { inputTranscription: { text: 'Exceed the per-turn tool-call limit safely.' } }
  });
  toolSession.emitToolCall(Array.from({ length: 13 }, (_, index) => ({
    id: `live-limit-${index + 1}`,
    name: 'get_board_state',
    args: {}
  })), 'The tool-call limit protected this turn.');
  await callLimitFinal;
  const limitResponses = toolSession.toolResponses.at(-1).functionResponses;
  assert.strictEqual(limitResponses.length, 13);
  assert.ok(limitResponses.every((response) =>
    response.response.error?.code === 'live_tool_call_limit'));

  const duplicateFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.conversationId === toolConversation.id
      && payload.isFinal
      && payload.message?.requestId !== allToolsResult.message.requestId);
  toolSession.callbacks.onmessage({
    serverContent: { inputTranscription: { text: 'Play one move, even if the provider repeats its call.' } }
  });
  const duplicateCall = [{ id: 'live-duplicate-move', name: 'play_move', args: { uci: 'e2e4' } }];
  toolSession.emitToolCall(duplicateCall, 'The move was applied once.');
  toolSession.callbacks.onmessage({ toolCall: { functionCalls: duplicateCall } });
  await duplicateFinal;
  await waitForCondition(
    () => toolSession.toolResponses.filter((payload) =>
      payload.functionResponses.some((response) => response.id === 'live-duplicate-move')).length === 2,
    'The duplicate provider call did not reuse its original result.'
  );
  const duplicateRecords = feature.store.listToolCalls(toolConversation.id)
    .filter((toolCall) => toolCall.providerCallId === 'live-duplicate-move');
  assert.strictEqual(duplicateRecords.length, 1);
  assert.strictEqual(feature.chessService.getState(toolConversation.id).history.length, 1);

  const lineStarted = waitForEvent(client, 'mentor-tool-progress', (payload) =>
    payload.conversationId === toolConversation.id
      && payload.toolCall.providerCallId === 'live-cancel-line'
      && payload.toolCall.progressCurrent === 1);
  toolSession.callbacks.onmessage({
    serverContent: { inputTranscription: { text: 'Start a line that I will interrupt.' } }
  });
  toolSession.emitToolCall([{
    id: 'live-cancel-line',
    name: 'play_line',
    args: { moves: ['e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6'] }
  }], 'This response must not be spoken after cancellation.');
  await lineStarted;
  const busySubmission = await emitWithAck(client, 'mentor-live-text-input', {
    conversationId: toolConversation.id,
    sessionId: toolStart.sessionId,
    requestId: 'live-during-tool',
    text: 'Do not queue this typed message.'
  });
  assert.strictEqual(busySubmission.success, false);
  assert.strictEqual(busySubmission.code, 'mentor_live_tool_busy');
  toolSession.cancelToolCalls(['live-cancel-line']);
  const cancelledTool = await waitForEvent(client, 'mentor-tool-cancelled', (payload) =>
    payload.conversationId === toolConversation.id
      && payload.toolCall.providerCallId === 'live-cancel-line');
  assert.strictEqual(cancelledTool.toolCall.progressCurrent, 1);
  const toolInterruptedFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.conversationId === toolConversation.id
      && payload.isFinal
      && payload.message?.status === 'cancelled');
  toolSession.interrupt();
  await toolInterruptedFinal;
  assert.strictEqual(feature.chessService.getState(toolConversation.id).history.length, 2);

  const analysisStarted = waitForEvent(client, 'mentor-tool-started', (payload) =>
    payload.conversationId === toolConversation.id
      && payload.toolCall.providerCallId === 'live-cancel-analysis');
  toolSession.callbacks.onmessage({
    serverContent: { inputTranscription: { text: 'Start an analysis that I will interrupt.' } }
  });
  toolSession.emitToolCall([{
    id: 'live-cancel-analysis',
    name: 'analyze_position',
    args: { mode: 'deep' }
  }], 'This analysis response must not be spoken after cancellation.');
  await analysisStarted;
  toolSession.cancelToolCalls(['live-cancel-analysis']);
  await waitForEvent(client, 'mentor-tool-cancelled', (payload) =>
    payload.conversationId === toolConversation.id
      && payload.toolCall.providerCallId === 'live-cancel-analysis');
  const analysisInterruptedFinal = waitForEvent(client, 'mentor-live-assistant-transcript', (payload) =>
    payload.conversationId === toolConversation.id
      && payload.isFinal
      && payload.message?.status === 'cancelled');
  toolSession.interrupt();
  await analysisInterruptedFinal;

  await emitWithAck(client, 'mentor-live-stop', {
    conversationId: toolConversation.id,
    sessionId: toolStart.sessionId
  });

  await emitWithAck(client, 'mentor-subscribe', { conversationId: activityConversation.id });
  const activityLive = await emitWithAck(client, 'mentor-live-start', { conversationId: activityConversation.id });
  assert.strictEqual(activityLive.success, true);
  const activityStart = await fetch(`${baseUrl}/api/mentor/conversations/${activityConversation.id}/activities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'practice_game', learnerColor: 'white', startFrom: 'standard', expectedRevision: 0 })
  });
  assert.strictEqual(activityStart.status, 201);
  const learnerMove = await fetch(`${baseUrl}/api/mentor/conversations/${activityConversation.id}/moves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uci: 'e2e4', expectedRevision: 0, actionId: 'live-activity-e4' })
  });
  assert.strictEqual(learnerMove.status, 200);
  await waitForCondition(
    () => feature.chessService.getState(activityConversation.id).history.length === 2,
    'Live activity did not guarantee the opponent reply.',
    5000
  );
  assert.strictEqual(feature.activityService.get(activityConversation.id).phase, 'learner_turn');
  assert.strictEqual(feature.activityService.get(activityConversation.id).state.fallbackMoves, 1);
  assert.strictEqual(
    feature.store.listMessages(activityConversation.id).filter((message) => message.kind === 'activity').length,
    4
  );
  await emitWithAck(client, 'mentor-live-stop', {
    conversationId: activityConversation.id,
    sessionId: activityLive.sessionId
  });

  await emitWithAck(client, 'mentor-subscribe', { conversationId: second.id });
  const secondStart = await emitWithAck(client, 'mentor-live-start', { conversationId: second.id });
  assert.strictEqual(secondStart.success, true);
  const unexpectedClose = waitForEvent(client, 'mentor-live-error', (payload) =>
    payload.conversationId === second.id && payload.code === 'mentor_live_provider_closed');
  connector.sessions.at(-1).callbacks.onclose({
    code: 1007,
    reason: 'Request contains an invalid argument.',
    wasClean: true
  });
  assert.match((await unexpectedClose).error, /invalid argument/);
  assert.strictEqual(feature.liveService.isConversationActive(second.id), false);
  client.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.strictEqual(feature.liveService.isConversationActive(second.id), false);

  competingClient.disconnect();
  await feature.close();
  await new Promise((resolve) => io.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  await storeAndTranscriptRegressions();
  await socketRegressions();
  console.log('Mentor Live regressions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
