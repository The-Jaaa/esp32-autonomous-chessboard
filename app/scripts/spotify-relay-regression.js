const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const os = require('os');
const path = require('path');
const {
  ByteQueue,
  MUSIC_FRAME_BYTES,
  SpotifyRelayService,
  scalePcm16Le
} = require('../audio/spotify-relay-service');
const { MentorSpeakerService } = require('../mentor/speaker-service');

function fakeChild(kind) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr];
  if (kind === 'ffmpeg') child.stdio[3] = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('close', 0, null));
    return true;
  };
  return child;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition.');
}

async function run() {
  const queue = new ByteQueue(8);
  queue.push(Buffer.from([1, 2, 3, 4, 5, 6]));
  queue.push(Buffer.from([7, 8, 9, 10]));
  assert.deepStrictEqual([...queue.read(8)], [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.strictEqual(queue.droppedBytes, 2);

  const scaled = scalePcm16Le(Buffer.from([0x10, 0x27, 0xf0, 0xd8]), 50);
  assert.strictEqual(scaled.readInt16LE(0), 5000);
  assert.strictEqual(scaled.readInt16LE(2), -5000);

  let now = 1000;
  const children = [];
  const service = new SpotifyRelayService({
    ffmpegPath: 'ffmpeg-test.exe',
    librespotPath: 'librespot-test.exe',
    cacheDir: path.join(os.tmpdir(), 'chess-spotify-relay-test'),
    host: '127.0.0.1',
    port: 0,
    streamHost: '127.0.0.1',
    token: 'relay-test-token',
    idleMs: 10000,
    fileExists: () => true,
    now: () => now,
    logger: { log() {}, warn() {} },
    spawnProcess(command, args) {
      const kind = command.includes('ffmpeg') ? 'ffmpeg' : 'librespot';
      const child = fakeChild(kind);
      children.push({ kind, child, args });
      return child;
    }
  });

  assert.strictEqual(service.status().state, 'disabled');
  await service.enable();
  assert.strictEqual(children.length, 2);
  const ffmpeg = children.find((entry) => entry.kind === 'ffmpeg');
  const librespot = children.find((entry) => entry.kind === 'librespot');
  assert(ffmpeg.args.join(' ').includes('sidechaincompress'));
  assert(ffmpeg.args.join(' ').includes('alimiter'));
  assert(librespot.args.includes('pipe'));
  assert(librespot.args.includes('--disable-audio-cache'));
  assert.strictEqual(librespot.args[librespot.args.indexOf('--volume-ctrl') + 1], 'linear');

  const port = service.server.address().port;
  const unauthorized = await fetch(`http://127.0.0.1:${port}/live.mp3`);
  assert.strictEqual(unauthorized.status, 401);
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
  assert.strictEqual(health.enabled, true);
  assert.strictEqual(health.state, 'ready');

  librespot.child.stdout.write(Buffer.alloc(MUSIC_FRAME_BYTES, 64));
  await waitFor(() => service.status().spotifyActive);
  assert.strictEqual(service.status().boardMode, 'relay');
  assert.strictEqual(service.canMixMentor(), false);
  service.setBoardRelayReady(true);
  assert.strictEqual(service.routeMentorPcm({
    sessionId: 'mentor-a',
    pcm: Buffer.alloc(960, 32),
    volume: 50,
    sampleRate: 24000
  }), true);
  assert.strictEqual(service.status().state, 'ducking');
  service.setBoardRelayReady(false);
  assert.strictEqual(service.canMixMentor(), false);
  service.setBoardRelayReady(true);

  now += 5000;
  librespot.child.stdout.write(Buffer.alloc(MUSIC_FRAME_BYTES));
  service.checkActivity();
  assert.strictEqual(service.status().spotifyActive, true);

  now += 5001;
  service.checkActivity();
  assert.strictEqual(service.status().spotifyActive, false);
  assert.strictEqual(service.status().boardMode, 'mentor');

  const routedPcm = [];
  const relayAdapter = {
    canMixMentor: () => true,
    routeMentorPcm(values) { routedPcm.push(values); return true; },
    endMentorPcm: () => true,
    clearMentorPcm: () => true,
    status: () => ({ buffers: { voiceBytes: 0 } })
  };
  const speaker = new MentorSpeakerService({
    token: 'speaker-token',
    relayService: relayAdapter,
    logger: { log() {}, warn() {} },
    emitStatus() {}
  });
  const binding = speaker.bindSession({
    conversationId: 'conversation-a',
    sessionId: 'session-a',
    outputMode: 'board',
    deviceId: 'main-board',
    volume: 37
  });
  assert.strictEqual(binding.resolvedOutput, 'board');
  const routed = speaker.routeAudio({
    conversationId: 'conversation-a',
    sessionId: 'session-a',
    pcm: Buffer.alloc(960, 1),
    sampleRate: 24000
  });
  assert.strictEqual(routed.transport, 'spotify-relay');
  assert.strictEqual(routedPcm[0].volume, 37);
  speaker.clearOutput('conversation-a', 'session-a', 'test');
  await speaker.close();

  const controller = new AbortController();
  const authorizedPromise = fetch(`http://127.0.0.1:${port}/live.mp3`, {
    headers: { Authorization: `Basic ${Buffer.from('esp32:relay-test-token').toString('base64')}` },
    signal: controller.signal
  }).catch((error) => error);
  await waitFor(() => service.clients.size === 1);
  ffmpeg.child.stdout.write(Buffer.alloc(2048, 0x55));
  ffmpeg.child.emit('close', 1, null);
  await waitFor(() => service.clients.size === 0);
  assert.strictEqual(service.status().state, 'recovering');
  assert.strictEqual(service.status().restartCount, 1);
  assert.strictEqual(service.status().buffers.rollingBytes, 0);
  await waitFor(() => children.filter((entry) => entry.kind === 'ffmpeg').length === 2, 1500);
  controller.abort();
  await authorizedPromise;

  await service.disable();
  assert.strictEqual(service.status().state, 'disabled');
  assert.strictEqual(service.server.listening, false);
  console.log('Spotify relay regressions passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
