const assert = require('assert');
const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const { createMentorFeature } = require('../mentor');
const {
  FRAME_TYPES,
  MAX_BUFFERED_RESPONSE_BYTES,
  MAX_SPEAKER_QUEUE_BYTES,
  MentorSpeakerService,
  SPEAKER_END_RESEND_MS,
  SPEAKER_ENCODING,
  SPEAKER_FEED_AHEAD_BYTES,
  SPEAKER_FEED_AHEAD_MS,
  SPEAKER_HEADER_BYTES,
  SPEAKER_PROTOCOL_VERSION,
  SPEAKER_ADAPTIVE_INITIAL_BUFFER_MS,
  SPEAKER_ADAPTIVE_MAX_PROVIDER_GAP_MS,
  SPEAKER_ADAPTIVE_MIN_BUFFER_MS,
  SPEAKER_ADAPTIVE_SAFETY_LEAD_MS,
  SPEAKER_ADAPTIVE_UNSTABLE_PROVIDER_GAP_MS,
  SPEAKER_BYTES_PER_SECOND,
  SPEAKER_START_BUFFER_BYTES,
  SPEAKER_START_BUFFER_MS,
  createImaAdpcmState,
  createSpeakerFrame,
  decodeImaAdpcmToPcm16Le,
  encodePcm16LeToImaAdpcm,
  flushImaAdpcm,
  parseSpeakerFrame
} = require('../mentor/speaker-service');
const { DeterministicMentorLiveConnector } = require('../mentor/live-service');

function waitForEvent(emitter, event, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}.`));
    }, timeoutMs);
    const listener = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      emitter.off(event, listener);
      resolve(value);
    };
    emitter.on(event, listener);
  });
}

function waitForCondition(predicate, message, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(message));
      setTimeout(check, 10);
    };
    check();
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

class FakeSpeakerBoard {
  constructor({ port, token = 'speaker-test-token', boardId = 'main-board' }) {
    this.port = port;
    this.token = token;
    this.boardId = boardId;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.accepted = false;
    this.frames = [];
  }

  async connect({ fragmented = false } = {}) {
    this.socket = net.createConnection({ host: '127.0.0.1', port: this.port });
    this.socket.on('data', (chunk) => this.consume(chunk));
    await waitForEvent(this.socket, 'connect');
    const hello = `${JSON.stringify({
      type: 'hello',
      protocolVersion: SPEAKER_PROTOCOL_VERSION,
      boardId: this.boardId,
      token: this.token,
      capabilities: {
        encoding: SPEAKER_ENCODING,
        sampleRate: 24000,
        channels: 1,
        bufferBytes: 131072
      }
    })}\n`;
    if (fragmented) {
      const split = Math.floor(hello.length / 2);
      this.socket.write(hello.slice(0, split));
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.socket.write(hello.slice(split));
    } else {
      this.socket.write(hello);
    }
    await waitForCondition(() => this.accepted, 'Board was not accepted.');
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.accepted) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) return;
      const message = JSON.parse(this.buffer.subarray(0, newline).toString('utf8'));
      this.buffer = this.buffer.subarray(newline + 1);
      this.accepted = message.type === 'accepted';
    }
    while (this.buffer.length >= SPEAKER_HEADER_BYTES) {
      const payloadLength = this.buffer.readUInt32BE(12);
      const frameLength = SPEAKER_HEADER_BYTES + payloadLength;
      if (this.buffer.length < frameLength) break;
      this.frames.push(parseSpeakerFrame(this.buffer.subarray(0, frameLength)));
      this.buffer = this.buffer.subarray(frameLength);
    }
  }

  telemetry(message) {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  close() {
    this.socket?.destroy();
  }
}

async function adaptiveBufferRegressions() {
  let clock = 10000;
  const statuses = [];
  const service = new MentorSpeakerService({
    token: 'speaker-test-token',
    startBufferBytes: SPEAKER_BYTES_PER_SECOND,
    adaptiveInitialBufferMs: 600,
    adaptiveMinimumBufferMs: 400,
    adaptiveSafetyLeadMs: 250,
    adaptiveMaximumProviderGapMs: 100,
    adaptiveUnstableProviderGapMs: 300,
    adaptiveStepMs: 100,
    adaptiveSmoothResponses: 2,
    now: () => clock,
    emitStatus: (_conversationId, status) => statuses.push(status),
    logger: { log() {}, warn() {} }
  });
  service.listen(0, '127.0.0.1');
  await waitForEvent(service.server, 'listening');
  const board = new FakeSpeakerBoard({ port: service.server.address().port });
  await board.connect();

  service.bindSession({ conversationId: 'fast', sessionId: 'fast', outputMode: 'board' });
  service.routeAudio({
    conversationId: 'fast',
    sessionId: 'fast',
    pcm: Buffer.alloc(SPEAKER_BYTES_PER_SECOND * 0.6, 1)
  });
  await waitForCondition(
    () => board.frames.some((frame) => frame.type === FRAME_TYPES.START),
    'Fast provider audio should start at the adaptive target.'
  );
  const fastPlaying = statuses.find((status) => (
    status.sessionId === 'fast' && status.status === 'playing'
  ));
  assert.strictEqual(fastPlaying.startReason, 'adaptive_buffer');
  assert.strictEqual(fastPlaying.adaptiveStartBufferMs, 600);
  assert.ok(fastPlaying.providerLeadMs >= 250);
  service.endSpeech('fast', 'fast');
  board.telemetry({ type: 'ended', sessionId: 'fast', bufferedMs: 0 });
  await waitForCondition(
    () => statuses.some((status) => status.sessionId === 'fast' && status.status === 'ended'),
    'Expected the fast response to finalize.'
  );
  service.releaseSession('fast', 'fast', 'test_complete');

  board.frames = [];
  service.bindSession({ conversationId: 'slow', sessionId: 'slow', outputMode: 'board' });
  const hundredMs = Buffer.alloc(SPEAKER_BYTES_PER_SECOND * 0.1, 2);
  for (let index = 0; index < 6; index += 1) {
    if (index > 0) clock += 100;
    service.routeAudio({ conversationId: 'slow', sessionId: 'slow', pcm: hundredMs });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(
    board.frames.some((frame) => frame.type === FRAME_TYPES.START),
    false,
    'Near-real-time provider audio must not start with insufficient safety lead.'
  );
  for (let index = 6; index < 10; index += 1) {
    clock += 100;
    service.routeAudio({ conversationId: 'slow', sessionId: 'slow', pcm: hundredMs });
  }
  await waitForCondition(
    () => board.frames.some((frame) => frame.type === FRAME_TYPES.START),
    'The maximum buffer must eventually start a slow provider response.'
  );
  const slowPlaying = statuses.find((status) => (
    status.sessionId === 'slow' && status.status === 'playing'
  ));
  assert.strictEqual(slowPlaying.startReason, 'maximum_buffer');
  service.endSpeech('slow', 'slow');
  board.telemetry({ type: 'ended', sessionId: 'slow', bufferedMs: 0 });
  await waitForCondition(
    () => statuses.some((status) => status.sessionId === 'slow' && status.status === 'ended'),
    'Expected the slow response to finalize.'
  );
  service.releaseSession('slow', 'slow', 'test_complete');

  board.frames = [];
  clock += 1000;
  service.bindSession({ conversationId: 'unstable', sessionId: 'unstable', outputMode: 'board' });
  service.routeAudio({
    conversationId: 'unstable',
    sessionId: 'unstable',
    pcm: Buffer.alloc(SPEAKER_BYTES_PER_SECOND * 0.6, 3)
  });
  await waitForCondition(
    () => board.frames.some((frame) => frame.type === FRAME_TYPES.START),
    'Expected the unstable test response to begin.'
  );
  board.telemetry({ type: 'underrun', sessionId: 'unstable', bufferedMs: 0 });
  await waitForCondition(
    () => service.listDevices()[0].adaptiveStartBufferMs === 1000,
    'An underrun should restore the maximum startup buffer.'
  );
  service.endSpeech('unstable', 'unstable');
  board.telemetry({ type: 'ended', sessionId: 'unstable', bufferedMs: 0 });
  await waitForCondition(
    () => statuses.some((status) => status.sessionId === 'unstable' && status.status === 'ended'),
    'Expected the unstable response to finalize.'
  );
  service.releaseSession('unstable', 'unstable', 'test_complete');

  board.frames = [];
  service.bindSession({ conversationId: 'recovery', sessionId: 'recovery', outputMode: 'board' });
  service.routeAudio({ conversationId: 'recovery', sessionId: 'recovery', pcm: hundredMs });
  assert.strictEqual(service.listDevices()[0].adaptiveStartBufferMs, 1000);
  const recoveryBuffering = statuses.find((status) => (
    status.sessionId === 'recovery' && status.status === 'buffering'
  ));
  assert.strictEqual(recoveryBuffering.adaptiveStartBufferMs, 1000);
  assert.strictEqual(board.frames.some((frame) => frame.type === FRAME_TYPES.START), false);
  service.releaseSession('recovery', 'recovery', 'test_complete');

  board.close();
  await service.close();
}

async function protocolRegressions() {
  assert.strictEqual(SPEAKER_FEED_AHEAD_MS, 2500);
  assert.strictEqual(MAX_SPEAKER_QUEUE_BYTES, 24000 * 2 * 42);
  assert.strictEqual(MAX_BUFFERED_RESPONSE_BYTES, 24000 * 2 * 40);
  assert.strictEqual(SPEAKER_START_BUFFER_MS, 10000);
  assert.strictEqual(SPEAKER_START_BUFFER_BYTES, 24000 * 2 * 10);
  assert.strictEqual(SPEAKER_ADAPTIVE_INITIAL_BUFFER_MS, 6000);
  assert.strictEqual(SPEAKER_ADAPTIVE_MIN_BUFFER_MS, 4000);
  assert.strictEqual(SPEAKER_ADAPTIVE_SAFETY_LEAD_MS, 3000);
  assert.strictEqual(SPEAKER_ADAPTIVE_MAX_PROVIDER_GAP_MS, 1500);
  assert.strictEqual(SPEAKER_ADAPTIVE_UNSTABLE_PROVIDER_GAP_MS, 3000);
  assert.strictEqual(SPEAKER_END_RESEND_MS, 250);
  const codecSamples = Array.from({ length: 240 }, (_, index) => (
    Math.round(Math.sin(index * Math.PI / 24) * 12000)
  ));
  const codecPcm = Buffer.alloc(codecSamples.length * 2);
  codecSamples.forEach((sample, index) => codecPcm.writeInt16LE(sample, index * 2));
  const codecState = createImaAdpcmState();
  const codecEncoded = Buffer.concat([
    encodePcm16LeToImaAdpcm(codecPcm, codecState),
    flushImaAdpcm(codecState)
  ]);
  const codecDecoded = decodeImaAdpcmToPcm16Le(codecEncoded);
  assert.strictEqual(codecEncoded.length, codecPcm.length / 4);
  assert.strictEqual(codecDecoded.length, codecPcm.length);
  const averageError = codecSamples.reduce((total, sample, index) => (
    total + Math.abs(sample - codecDecoded.readInt16LE(index * 2))
  ), 0) / codecSamples.length;
  assert.ok(averageError < 1200, `Unexpected ADPCM average error ${averageError}.`);
  const chunkedState = createImaAdpcmState();
  const chunkedEncoded = [];
  for (let offset = 0; offset < codecPcm.length; offset += 2) {
    chunkedEncoded.push(encodePcm16LeToImaAdpcm(codecPcm.subarray(offset, offset + 2), chunkedState));
  }
  chunkedEncoded.push(flushImaAdpcm(chunkedState));
  assert.deepStrictEqual(Buffer.concat(chunkedEncoded), codecEncoded);
  assert.strictEqual(flushImaAdpcm(chunkedState).length, 0);
  const oddState = createImaAdpcmState();
  assert.strictEqual(encodePcm16LeToImaAdpcm(codecPcm.subarray(0, 2), oddState).length, 0);
  assert.strictEqual(flushImaAdpcm(oddState).length, 1);
  const payload = Buffer.from([1, 2, 3, 4]);
  const encoded = createSpeakerFrame(FRAME_TYPES.PCM, payload, 7);
  const parsed = parseSpeakerFrame(encoded);
  assert.strictEqual(parsed.type, FRAME_TYPES.PCM);
  assert.strictEqual(parsed.sequence, 7);
  assert.deepStrictEqual(parsed.payload, payload);
  assert.throws(() => parseSpeakerFrame(encoded.subarray(1)), /magic|length|incomplete/i);

  const statuses = [];
  const service = new MentorSpeakerService({
    token: 'speaker-test-token',
    emitStatus: (_conversationId, status) => statuses.push(status),
    logger: { log() {}, warn() {} }
  });
  service.listen(0, '127.0.0.1');
  await waitForEvent(service.server, 'listening');
  const port = service.server.address().port;

  const rejected = net.createConnection({ host: '127.0.0.1', port });
  await waitForEvent(rejected, 'connect');
  rejected.write(`${JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    boardId: 'intruder',
    token: 'wrong',
    capabilities: { encoding: SPEAKER_ENCODING, sampleRate: 24000, channels: 1 }
  })}\n`);
  const rejection = await waitForEvent(rejected, 'data');
  assert.match(rejection.toString('utf8'), /rejected/);
  rejected.destroy();

  const fragmentedBoard = new FakeSpeakerBoard({ port, boardId: 'fragment-board' });
  await fragmentedBoard.connect({ fragmented: true });
  fragmentedBoard.socket.write(
    `${JSON.stringify({ type: 'playing', bufferedMs: 120 })}\n`
      + `${JSON.stringify({ type: 'underrun', bufferedMs: 0 })}\n`
  );
  await waitForCondition(
    () => service.listDevices().find((device) => device.id === 'fragment-board')?.underruns === 1,
    'Expected coalesced speaker telemetry to be processed.'
  );
  fragmentedBoard.close();
  await waitForCondition(
    () => !service.listDevices().some((device) => device.id === 'fragment-board'),
    'Expected fragmented test board to disconnect.'
  );

  const board = new FakeSpeakerBoard({ port });
  await board.connect();
  assert.strictEqual(service.listDevices().length, 1);
  assert.strictEqual(service.listDevices()[0].id, 'main-board');
  const auxiliaryBoard = new FakeSpeakerBoard({ port, boardId: 'analysis-board' });
  await auxiliaryBoard.connect();
  assert.strictEqual(service.listDevices().length, 2);

  const binding = service.bindSession({
    conversationId: 'conversation-a',
    sessionId: 'session-a',
    outputMode: 'board',
    volume: 64
  });
  assert.strictEqual(binding.resolvedOutput, 'board');
  const pcm = Buffer.alloc(960, 4);
  assert.strictEqual(service.routeAudio({
    conversationId: 'conversation-a',
    sessionId: 'session-a',
    pcm,
    sampleRate: 24000
  }).destination, 'board');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.strictEqual(board.frames.length, 0, 'Board audio must wait for the startup buffer.');

  const queuedPcm = Buffer.alloc(480000, 7);
  assert.strictEqual(service.routeAudio({
    conversationId: 'conversation-a',
    sessionId: 'session-a',
    pcm: queuedPcm,
    sampleRate: 24000
  }).destination, 'board');
  await waitForCondition(
    () => board.frames.length >= 2,
    'Expected START and PCM frames after the startup buffer filled.'
  );
  assert.strictEqual(board.frames[0].type, FRAME_TYPES.START);
  assert.strictEqual(JSON.parse(board.frames[0].payload.toString()).volume, 64);
  assert.strictEqual(JSON.parse(board.frames[0].payload.toString()).encoding, SPEAKER_ENCODING);
  assert.strictEqual(JSON.parse(board.frames[0].payload.toString()).bitsPerSample, 4);
  assert.strictEqual(board.frames[1].type, FRAME_TYPES.PCM);
  assert.deepStrictEqual(
    board.frames[1].payload,
    encodePcm16LeToImaAdpcm(pcm, createImaAdpcmState())
  );
  assert.strictEqual(service.endSpeech('conversation-a', 'session-a'), true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const pcmBeforeInterrupt = board.frames
    .filter((frame) => frame.type === FRAME_TYPES.PCM)
    .reduce((total, frame) => total + frame.payload.length, 0);
  assert.ok(pcmBeforeInterrupt <= (131072 + pcm.length + 4000) / 4);
  const interruptedAt = Date.now();
  service.clearOutput('conversation-a', 'session-a', 'latency_test');
  await waitForCondition(
    () => board.frames.some((frame) => frame.type === FRAME_TYPES.CLEAR),
    'Expected paced CLEAR frame.'
  );
  assert.ok(Date.now() - interruptedAt < 250);
  const clearIndex = board.frames.findIndex((frame) => frame.type === FRAME_TYPES.CLEAR);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.strictEqual(
    board.frames.slice(clearIndex + 1).some((frame) => frame.type === FRAME_TYPES.PCM),
    false
  );

  service.bindSession({
    conversationId: 'conversation-aux',
    sessionId: 'session-aux',
    outputMode: 'board',
    deviceId: 'analysis-board'
  });
  const mainFrameCount = board.frames.length;
  assert.strictEqual(service.routeAudio({
    conversationId: 'conversation-aux',
    sessionId: 'session-aux',
    pcm,
    sampleRate: 24000
  }).destination, 'board');
  assert.strictEqual(service.endSpeech('conversation-aux', 'session-aux'), true);
  await waitForCondition(() => auxiliaryBoard.frames.length >= 2, 'Expected isolated auxiliary audio frames.');
  await waitForCondition(
    () => auxiliaryBoard.frames.some((frame) => frame.type === FRAME_TYPES.END),
    'Expected the initial END frame.'
  );
  const auxiliaryEndCount = auxiliaryBoard.frames.filter((frame) => frame.type === FRAME_TYPES.END).length;
  await new Promise((resolve) => setTimeout(resolve, SPEAKER_END_RESEND_MS + 10));
  auxiliaryBoard.telemetry({
    type: 'playing',
    sessionId: 'session-aux',
    bufferedMs: 100
  });
  await waitForCondition(
    () => auxiliaryBoard.frames.filter((frame) => frame.type === FRAME_TYPES.END).length
      > auxiliaryEndCount,
    'Expected END to be repeated near the final buffer boundary.'
  );
  auxiliaryBoard.telemetry({ type: 'ended', sessionId: 'session-aux', bufferedMs: 0 });
  assert.strictEqual(board.frames.length, mainFrameCount);

  assert.throws(() => service.bindSession({
    conversationId: 'conversation-b',
    sessionId: 'session-b',
    outputMode: 'board'
  }), /not available/i);
  const automaticFallback = service.bindSession({
    conversationId: 'conversation-b',
    sessionId: 'session-b',
    outputMode: 'auto'
  });
  assert.strictEqual(automaticFallback.resolvedOutput, 'browser');

  service.clearOutput('conversation-a', 'session-a', 'test_interrupt');
  service.endSpeech('conversation-a', 'session-a');
  await waitForCondition(() => board.frames.some((frame) => frame.type === FRAME_TYPES.CLEAR), 'Expected CLEAR frame.');
  board.telemetry({ type: 'cleared', sessionId: 'session-a', bufferedMs: 0 });
  await waitForCondition(() => statuses.some((status) => status.status === 'cleared'), 'Expected cleared status.');
  service.releaseSession('conversation-a', 'session-a', 'replace_test');

  const replacementBoard = new FakeSpeakerBoard({ port });
  await replacementBoard.connect();
  await waitForCondition(() => board.socket.destroyed, 'Expected duplicate board ID to replace the old socket.');
  const automaticBoard = service.bindSession({
    conversationId: 'conversation-auto',
    sessionId: 'session-auto',
    outputMode: 'auto'
  });
  assert.strictEqual(automaticBoard.resolvedOutput, 'board');
  assert.strictEqual(service.routeAudio({
    conversationId: 'conversation-auto',
    sessionId: 'session-auto',
    pcm,
    sampleRate: 24000
  }).destination, 'board');
  replacementBoard.close();
  await waitForCondition(
    () => statuses.some((status) => status.sessionId === 'session-auto' && status.status === 'fallback'),
    'Expected Auto mode to fall back after a mid-turn disconnect.'
  );
  assert.strictEqual(service.routeAudio({
    conversationId: 'conversation-auto',
    sessionId: 'session-auto',
    pcm,
    sampleRate: 24000
  }).destination, 'browser');

  const constrainedStatuses = [];
  const constrained = new MentorSpeakerService({
    token: 'speaker-test-token',
    maxQueueBytes: 32,
    maxResponseBytes: 32,
    emitStatus: (_conversationId, status) => constrainedStatuses.push(status),
    logger: { log() {}, warn() {} }
  });
  constrained.listen(0, '127.0.0.1');
  await waitForEvent(constrained.server, 'listening');
  const constrainedBoard = new FakeSpeakerBoard({ port: constrained.server.address().port });
  await constrainedBoard.connect();
  constrained.bindSession({ conversationId: 'c', sessionId: 's', outputMode: 'auto' });
  const degraded = constrained.routeAudio({ conversationId: 'c', sessionId: 's', pcm, sampleRate: 24000 });
  assert.strictEqual(degraded.destination, 'browser');
  assert.strictEqual(degraded.reason, 'audio_response_limit');
  assert.strictEqual(constrained.listDevices()[0].status, 'ready');
  assert.ok(constrainedStatuses.some((status) => status.status === 'response_too_long'));
  assert.ok(constrainedStatuses.every((status) => status.status !== 'degraded'));
  assert.strictEqual(constrained.endSpeech('c', 's'), false);
  constrained.releaseSession('c', 's', 'response_limit_test');
  assert.strictEqual(constrained.bindSession({
    conversationId: 'c2',
    sessionId: 's2',
    outputMode: 'board'
  }).resolvedOutput, 'board');

  board.close();
  auxiliaryBoard.close();
  replacementBoard.close();
  constrainedBoard.close();
  await service.close();
  await constrained.close();
}

async function liveRoutingRegressions() {
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const io = new Server(server);
  const statuses = [];
  const speaker = {
    bindings: new Map(),
    pcm: [],
    clears: [],
    listDevices: () => [{ id: 'main-board', status: 'ready' }],
    bindSession(values) {
      const binding = {
        outputMode: values.outputMode,
        resolvedOutput: values.outputMode === 'browser' ? 'browser' : 'board',
        deviceId: values.deviceId,
        boardVolume: values.volume,
        speakerStatus: values.outputMode === 'browser' ? 'browser' : 'ready'
      };
      this.bindings.set(values.sessionId, binding);
      return binding;
    },
    routeAudio(values) {
      this.pcm.push(values);
      return { destination: this.bindings.get(values.sessionId).resolvedOutput };
    },
    endSpeech() {},
    clearOutput(conversationId, sessionId, reason) {
      this.clears.push({ conversationId, sessionId, reason });
      return true;
    },
    releaseSession(conversationId, sessionId, reason) {
      this.clears.push({ conversationId, sessionId, reason });
      this.bindings.delete(sessionId);
      return true;
    },
    async close() {}
  };
  const connector = new DeterministicMentorLiveConnector({ delayMs: 10 });
  const feature = createMentorFeature({
    app,
    io,
    ai: {},
    dbPath: ':memory:',
    liveConnector: connector,
    speakerService: speaker
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const conversation = (await fetch(`${baseUrl}/api/mentor/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }).then((response) => response.json())).conversation;
  const client = createClient(baseUrl, { transports: ['websocket'] });
  await waitForEvent(client, 'connect');
  await emitWithAck(client, 'mentor-subscribe', { conversationId: conversation.id });
  client.on('mentor-speaker-status', (payload) => statuses.push(payload));
  let browserAudio = 0;
  client.on('mentor-live-audio', () => { browserAudio += 1; });

  const started = await emitWithAck(client, 'mentor-live-start', {
    conversationId: conversation.id,
    outputMode: 'board',
    deviceId: 'main-board',
    boardVolume: 71
  });
  assert.strictEqual(started.success, true);
  assert.strictEqual(started.resolvedOutput, 'board');
  const completed = waitForEvent(client, 'mentor-live-assistant-transcript', (value) => value.isFinal);
  await emitWithAck(client, 'mentor-live-text-input', {
    conversationId: conversation.id,
    sessionId: started.sessionId,
    requestId: 'speaker-live-turn',
    text: 'Explain this position.'
  });
  await completed;
  assert.strictEqual(speaker.pcm.length, 1);
  assert.strictEqual(browserAudio, 0);

  const interrupted = await emitWithAck(client, 'mentor-live-interrupt-output', {
    conversationId: conversation.id,
    sessionId: started.sessionId
  });
  assert.strictEqual(interrupted.success, true);
  assert.ok(speaker.clears.some((entry) => entry.reason === 'client_interrupt'));

  const devices = await fetch(`${baseUrl}/api/mentor/audio/devices`).then((response) => response.json());
  assert.strictEqual(devices.devices[0].id, 'main-board');

  await emitWithAck(client, 'mentor-live-stop', {
    conversationId: conversation.id,
    sessionId: started.sessionId
  });
  client.close();
  await feature.close();
  io.close();
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  await adaptiveBufferRegressions();
  await protocolRegressions();
  await liveRoutingRegressions();
  console.log('Mentor speaker regressions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
