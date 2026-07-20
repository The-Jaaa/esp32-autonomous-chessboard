const assert = require('assert');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const { createMentorFeature } = require('../mentor');
const { MentorStore } = require('../mentor/store');
const {
  DeterministicMentorLiveConnector,
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

async function storeAndTranscriptRegressions() {
  assert.strictEqual(mergeTranscript('', 'Can you'), 'Can you');
  assert.strictEqual(mergeTranscript('Can you', 'Can you explain this?'), 'Can you explain this?');
  assert.strictEqual(mergeTranscript('Can you explain', 'explain this?'), 'Can you explain this?');
  assert.strictEqual(mergeTranscript('Complete sentence', 'sentence'), 'Complete sentence');

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

  const boardResponse = await fetch(`${baseUrl}/api/mentor/conversations/${first.id}/moves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uci: 'e2e4', expectedRevision: 0, actionId: 'live-board-1' })
  });
  assert.strictEqual(boardResponse.status, 200);
  assert.ok(connector.sessions[0].realtimeInputs.some((input) =>
    input.text?.startsWith('[BOARD_CONTEXT_UPDATE]') && input.text.includes(' b ')));

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

  await emitWithAck(client, 'mentor-subscribe', { conversationId: second.id });
  const secondStart = await emitWithAck(client, 'mentor-live-start', { conversationId: second.id });
  assert.strictEqual(secondStart.success, true);
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
