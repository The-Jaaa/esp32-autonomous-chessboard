const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const { MentorStore, titleFromMessage } = require('../mentor/store');
const { MentorService } = require('../mentor/service');
const { createMentorFeature } = require('../mentor');

function temporaryDatabase(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `mentor-${name}-`));
  return { directory, file: path.join(directory, 'mentor.sqlite') };
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function waitForEvent(emitter, event, predicate = () => true, timeoutMs = 2000) {
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

async function storeRegressions() {
  const temp = temporaryDatabase('store');
  let now = 100;
  let store = new MentorStore({ dbPath: temp.file, now: () => ++now });
  store.migrate();
  store.migrate();

  const first = store.createConversation();
  const second = store.createConversation({ title: 'French Defense' });
  assert.strictEqual(store.listConversations().length, 2);
  assert.strictEqual(store.listConversations({ query: 'french' })[0].id, second.id);

  const longTitle = titleFromMessage('a'.repeat(80));
  assert.strictEqual(longTitle.length, 48);
  assert.ok(longTitle.endsWith('...'));

  const pair = store.createMessagePair(first.id, {
    requestId: 'request-1',
    text: 'Teach me the Italian Game'
  });
  assert.strictEqual(pair.duplicate, false);
  assert.strictEqual(store.getConversation(first.id).title, 'Teach me the Italian Game');
  store.appendMessageContent(pair.assistantMessage.id, 'Opening response');

  const duplicate = store.createMessagePair(first.id, {
    requestId: 'request-1',
    text: 'This duplicate must not be stored'
  });
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(store.listMessages(first.id).length, 2);
  const interruptedVoice = store.createMessagePair(first.id, {
    requestId: 'voice-restart-1',
    text: 'This voice turn is interrupted by restart.',
    kind: 'voice'
  });
  store.close();

  store = new MentorStore({ dbPath: temp.file, now: () => ++now });
  assert.strictEqual(store.getMessage(pair.assistantMessage.id).status, 'failed');
  assert.strictEqual(store.getMessage(interruptedVoice.assistantMessage.id).status, 'failed');
  assert.strictEqual(store.getMessage(interruptedVoice.assistantMessage.id).kind, 'voice');
  assert.strictEqual(store.getConversation(first.id).messages.length, 4);
  assert.strictEqual(store.deleteConversation(first.id), true);
  assert.deepStrictEqual(store.listMessages(first.id), []);
  assert.strictEqual(store.getConversation(second.id).title, 'French Defense');
  store.close();
  cleanup(temp.directory);
}

async function serviceRegressions() {
  const store = new MentorStore({ dbPath: ':memory:' });
  const conversation = store.createConversation();
  const events = [];
  const provider = {
    async *stream() {
      yield 'One ';
      yield 'two.';
    }
  };
  const service = new MentorService({
    store,
    provider,
    emit: (id, event, payload) => events.push({ id, event, payload })
  });
  service.submitMessage(conversation.id, { requestId: 'stream-1', text: 'Count.' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const streamed = store.getMessageByRequestRole(conversation.id, 'stream-1', 'model');
  assert.strictEqual(streamed.content, 'One two.');
  assert.strictEqual(streamed.status, 'complete');
  assert.deepStrictEqual(
    events.map((event) => event.event),
    ['mentor-message-start', 'mentor-message-delta', 'mentor-message-delta', 'mentor-message-complete']
  );

  let release;
  service.provider = {
    async *stream() {
      yield 'Started';
      await new Promise((resolve) => { release = resolve; });
      yield 'Too late';
    }
  };
  service.submitMessage(conversation.id, { requestId: 'cancel-1', text: 'Stop this.' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.strictEqual(service.cancel(conversation.id, 'cancel-1'), true);
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(
    store.getMessageByRequestRole(conversation.id, 'cancel-1', 'model').status,
    'cancelled'
  );

  service.provider = {
    async *stream() {
      throw new Error('Mock Gemini failure');
    }
  };
  service.submitMessage(conversation.id, { requestId: 'failure-1', text: 'Fail this.' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(
    store.getMessageByRequestRole(conversation.id, 'failure-1', 'model').status,
    'failed'
  );
  assert.ok(events.some((event) => event.payload.error === 'Mock Gemini failure'));
  store.close();
}

async function httpAndSocketRegressions() {
  const temp = temporaryDatabase('socket');
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const io = new Server(server);
  const feature = createMentorFeature({
    app,
    io,
    ai: {},
    dbPath: temp.file,
    provider: {
      async *stream() {
        yield 'First ';
        await new Promise((resolve) => setTimeout(resolve, 15));
        yield 'second.';
      }
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const postConversation = () => fetch(`${baseUrl}/api/mentor/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }).then((response) => response.json());
  const first = (await postConversation()).conversation;
  const second = (await postConversation()).conversation;

  const firstClient = createClient(baseUrl, { transports: ['websocket'] });
  const secondClient = createClient(baseUrl, { transports: ['websocket'] });
  await Promise.all([
    waitForEvent(firstClient, 'connect'),
    waitForEvent(secondClient, 'connect')
  ]);
  await Promise.all([
    new Promise((resolve) => firstClient.emit('mentor-subscribe', { conversationId: first.id }, resolve)),
    new Promise((resolve) => secondClient.emit('mentor-subscribe', { conversationId: second.id }, resolve))
  ]);

  let leakedEvents = 0;
  secondClient.on('mentor-message-delta', () => { leakedEvents += 1; });
  const deltas = [];
  firstClient.on('mentor-message-delta', (payload) => deltas.push(payload.delta));
  const completionPromise = waitForEvent(firstClient, 'mentor-message-complete');
  const response = await fetch(`${baseUrl}/api/mentor/conversations/${first.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'socket-1', text: 'Stream a reply.' })
  });
  assert.strictEqual(response.status, 202);
  await completionPromise;
  assert.deepStrictEqual(deltas, ['First ', 'second.']);
  assert.strictEqual(leakedEvents, 0);

  const duplicateResponse = await fetch(`${baseUrl}/api/mentor/conversations/${first.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'socket-1', text: 'Duplicate.' })
  });
  assert.strictEqual(duplicateResponse.status, 200);
  assert.strictEqual((await duplicateResponse.json()).duplicate, true);

  firstClient.disconnect();
  const reconnect = createClient(baseUrl, { transports: ['websocket'] });
  await waitForEvent(reconnect, 'connect');
  const subscribeResult = await new Promise((resolve) =>
    reconnect.emit('mentor-subscribe', { conversationId: first.id }, resolve));
  assert.strictEqual(subscribeResult.success, true);
  const detail = await fetch(`${baseUrl}/api/mentor/conversations/${first.id}`).then((value) => value.json());
  assert.strictEqual(detail.conversation.messages.at(-1).content, 'First second.');

  reconnect.disconnect();
  secondClient.disconnect();
  await new Promise((resolve) => io.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  feature.store.close();
  cleanup(temp.directory);
}

async function main() {
  await storeRegressions();
  await serviceRegressions();
  await httpAndSocketRegressions();
  console.log('Mentor foundation regressions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
