const net = require('net');
const { EventEmitter } = require('events');

const SPEAKER_PROTOCOL_VERSION = 1;
const SPEAKER_MAGIC = Buffer.from('CMSP');
const SPEAKER_HEADER_BYTES = 16;
const SPEAKER_SAMPLE_RATE = 24000;
const SPEAKER_BYTES_PER_SECOND = SPEAKER_SAMPLE_RATE * 2;
const SPEAKER_ENCODING = 'ima_adpcm4';
const SPEAKER_TRANSPORT_BYTES_PER_SECOND = SPEAKER_SAMPLE_RATE / 2;
const MAX_SPEAKER_QUEUE_BYTES = SPEAKER_BYTES_PER_SECOND * 42;
const MAX_BUFFERED_RESPONSE_BYTES = SPEAKER_BYTES_PER_SECOND * 40;
const SPEAKER_START_BUFFER_MS = 10000;
const SPEAKER_ADAPTIVE_INITIAL_BUFFER_MS = 6000;
const SPEAKER_ADAPTIVE_MIN_BUFFER_MS = 4000;
const SPEAKER_ADAPTIVE_SAFETY_LEAD_MS = 3000;
const SPEAKER_ADAPTIVE_MAX_PROVIDER_GAP_MS = 1500;
const SPEAKER_ADAPTIVE_UNSTABLE_PROVIDER_GAP_MS = 3000;
const SPEAKER_ADAPTIVE_STEP_MS = 1000;
const SPEAKER_ADAPTIVE_SMOOTH_RESPONSES = 2;
const SPEAKER_FEED_AHEAD_MS = 2500;
const SPEAKER_DEGRADED_BUFFER_MS = 41000;
const SPEAKER_IDLE_END_MS = 2000;
const SPEAKER_END_RESEND_MS = 250;
const SPEAKER_PUMP_INTERVAL_MS = 20;
const SPEAKER_PCM_FRAME_MS = 40;
const SPEAKER_FEED_AHEAD_BYTES = Math.floor(
  SPEAKER_BYTES_PER_SECOND * SPEAKER_FEED_AHEAD_MS / 1000
);
const SPEAKER_PCM_FRAME_BYTES = Math.floor(
  SPEAKER_TRANSPORT_BYTES_PER_SECOND * SPEAKER_PCM_FRAME_MS / 1000
);
const SPEAKER_START_BUFFER_BYTES = Math.floor(
  SPEAKER_BYTES_PER_SECOND * SPEAKER_START_BUFFER_MS / 1000
);
const MAX_HANDSHAKE_BYTES = 4096;
const DEFAULT_DEVICE_ID = 'main-board';
const DEFAULT_VOLUME = 50;
const IMA_INDEX_TABLE = Object.freeze([
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8
]);
const IMA_STEP_TABLE = Object.freeze([
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
  143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
  494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
  1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026,
  4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
  27086, 29794, 32767
]);

const FRAME_TYPES = Object.freeze({
  START: 1,
  PCM: 2,
  CLEAR: 3,
  END: 4,
  PING: 5
});

function speakerError(message, code = 'mentor_speaker_error', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function createImaAdpcmState() {
  return { predictor: 0, index: 0, pendingNibble: null };
}

function encodeImaAdpcmNibble(sampleValue, state) {
  const sample = Math.max(-32768, Math.min(32767, Number(sampleValue) || 0));
  const step = IMA_STEP_TABLE[state.index];
  let difference = sample - state.predictor;
  let code = 0;
  if (difference < 0) {
    code = 8;
    difference = -difference;
  }
  let delta = step >> 3;
  if (difference >= step) {
    code |= 4;
    difference -= step;
    delta += step;
  }
  if (difference >= (step >> 1)) {
    code |= 2;
    difference -= step >> 1;
    delta += step >> 1;
  }
  if (difference >= (step >> 2)) {
    code |= 1;
    delta += step >> 2;
  }
  state.predictor += (code & 8) ? -delta : delta;
  state.predictor = Math.max(-32768, Math.min(32767, state.predictor));
  state.index = Math.max(0, Math.min(88, state.index + IMA_INDEX_TABLE[code]));
  return code & 0x0f;
}

function decodeImaAdpcmNibble(codeValue, state) {
  const code = Number(codeValue) & 0x0f;
  const step = IMA_STEP_TABLE[state.index];
  let delta = step >> 3;
  if (code & 4) delta += step;
  if (code & 2) delta += step >> 1;
  if (code & 1) delta += step >> 2;
  state.predictor += (code & 8) ? -delta : delta;
  state.predictor = Math.max(-32768, Math.min(32767, state.predictor));
  state.index = Math.max(0, Math.min(88, state.index + IMA_INDEX_TABLE[code]));
  return state.predictor;
}

function encodePcm16LeToImaAdpcm(pcm, state = createImaAdpcmState()) {
  const bytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  if (bytes.length % 2 !== 0) {
    throw speakerError('PCM16 input must contain complete samples.', 'mentor_speaker_invalid_pcm');
  }
  const output = [];
  for (let offset = 0; offset < bytes.length; offset += 2) {
    const nibble = encodeImaAdpcmNibble(bytes.readInt16LE(offset), state);
    if (state.pendingNibble === null) state.pendingNibble = nibble;
    else {
      output.push(state.pendingNibble | (nibble << 4));
      state.pendingNibble = null;
    }
  }
  return Buffer.from(output);
}

function flushImaAdpcm(state) {
  if (state.pendingNibble === null) return Buffer.alloc(0);
  const output = Buffer.from([state.pendingNibble]);
  state.pendingNibble = null;
  return output;
}

function decodeImaAdpcmToPcm16Le(encodedAudio, state = createImaAdpcmState()) {
  const encoded = Buffer.isBuffer(encodedAudio)
    ? encodedAudio
    : Buffer.from(encodedAudio || []);
  const pcm = Buffer.allocUnsafe(encoded.length * 4);
  for (let index = 0; index < encoded.length; index += 1) {
    pcm.writeInt16LE(decodeImaAdpcmNibble(encoded[index] & 0x0f, state), index * 4);
    pcm.writeInt16LE(decodeImaAdpcmNibble(encoded[index] >> 4, state), index * 4 + 2);
  }
  return pcm;
}

function normalizeOutputMode(value) {
  const mode = String(value || 'auto').toLowerCase();
  if (!['auto', 'board', 'browser'].includes(mode)) {
    throw speakerError('Audio output must be auto, board, or browser.', 'mentor_speaker_invalid_output');
  }
  return mode;
}

function normalizeVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_VOLUME;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function createSpeakerFrame(type, payload = Buffer.alloc(0), sequence = 0, flags = 0) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(SPEAKER_HEADER_BYTES + body.length);
  SPEAKER_MAGIC.copy(frame, 0);
  frame.writeUInt8(SPEAKER_PROTOCOL_VERSION, 4);
  frame.writeUInt8(type, 5);
  frame.writeUInt16BE(flags, 6);
  frame.writeUInt32BE(sequence >>> 0, 8);
  frame.writeUInt32BE(body.length >>> 0, 12);
  body.copy(frame, SPEAKER_HEADER_BYTES);
  return frame;
}

function parseSpeakerFrame(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < SPEAKER_HEADER_BYTES) {
    throw speakerError('Speaker frame is incomplete.', 'mentor_speaker_frame_incomplete');
  }
  if (!buffer.subarray(0, 4).equals(SPEAKER_MAGIC)) {
    throw speakerError('Speaker frame has invalid magic.', 'mentor_speaker_frame_magic');
  }
  if (buffer.readUInt8(4) !== SPEAKER_PROTOCOL_VERSION) {
    throw speakerError('Speaker frame uses an unsupported version.', 'mentor_speaker_frame_version');
  }
  const payloadLength = buffer.readUInt32BE(12);
  if (buffer.length !== SPEAKER_HEADER_BYTES + payloadLength) {
    throw speakerError('Speaker frame length does not match its payload.', 'mentor_speaker_frame_length');
  }
  return {
    version: buffer.readUInt8(4),
    type: buffer.readUInt8(5),
    flags: buffer.readUInt16BE(6),
    sequence: buffer.readUInt32BE(8),
    payload: buffer.subarray(SPEAKER_HEADER_BYTES)
  };
}

class MentorSpeakerService extends EventEmitter {
  constructor({
    token = process.env.ESP32_AUDIO_TOKEN || '',
    defaultDeviceId = DEFAULT_DEVICE_ID,
    emitStatus = () => {},
    logger = console,
    createServer = net.createServer,
    relayService = null,
    maxQueueBytes = MAX_SPEAKER_QUEUE_BYTES,
    maxResponseBytes = MAX_BUFFERED_RESPONSE_BYTES,
    startBufferBytes = SPEAKER_START_BUFFER_BYTES,
    adaptiveInitialBufferMs = SPEAKER_ADAPTIVE_INITIAL_BUFFER_MS,
    adaptiveMinimumBufferMs = SPEAKER_ADAPTIVE_MIN_BUFFER_MS,
    adaptiveSafetyLeadMs = SPEAKER_ADAPTIVE_SAFETY_LEAD_MS,
    adaptiveMaximumProviderGapMs = SPEAKER_ADAPTIVE_MAX_PROVIDER_GAP_MS,
    adaptiveUnstableProviderGapMs = SPEAKER_ADAPTIVE_UNSTABLE_PROVIDER_GAP_MS,
    adaptiveStepMs = SPEAKER_ADAPTIVE_STEP_MS,
    adaptiveSmoothResponses = SPEAKER_ADAPTIVE_SMOOTH_RESPONSES,
    idleEndMs = SPEAKER_IDLE_END_MS,
    now = () => Date.now()
  } = {}) {
    super();
    this.token = String(token || '');
    this.defaultDeviceId = defaultDeviceId;
    this.emitStatus = emitStatus;
    this.logger = logger;
    this.maxQueueBytes = maxQueueBytes;
    this.maxResponseBytes = maxResponseBytes;
    this.startBufferBytes = startBufferBytes;
    this.maximumStartBufferMs = Math.max(
      1,
      Math.round(startBufferBytes * 1000 / SPEAKER_BYTES_PER_SECOND)
    );
    this.adaptiveMinimumBufferMs = Math.min(
      this.maximumStartBufferMs,
      Math.max(1, Math.round(adaptiveMinimumBufferMs))
    );
    this.adaptiveInitialBufferMs = Math.max(
      this.adaptiveMinimumBufferMs,
      Math.min(this.maximumStartBufferMs, Math.round(adaptiveInitialBufferMs))
    );
    this.adaptiveSafetyLeadMs = Math.max(0, Math.round(adaptiveSafetyLeadMs));
    this.adaptiveMaximumProviderGapMs = Math.max(0, Math.round(adaptiveMaximumProviderGapMs));
    this.adaptiveUnstableProviderGapMs = Math.max(
      this.adaptiveMaximumProviderGapMs,
      Math.round(adaptiveUnstableProviderGapMs)
    );
    this.adaptiveStepMs = Math.max(1, Math.round(adaptiveStepMs));
    this.adaptiveSmoothResponses = Math.max(1, Math.round(adaptiveSmoothResponses));
    this.idleEndMs = idleEndMs;
    this.now = now;
    this.relayService = relayService;
    this.devices = new Map();
    this.bindings = new Map();
    this.bufferProfiles = new Map();
    this.sockets = new Set();
    this.server = createServer((socket) => this.accept(socket));
    this.pingTimer = null;
  }

  listen(port = 3001, host) {
    if (this.server.listening) return this.server;
    this.server.listen(port, host, () => {
      this.logger.log?.(`[Mentor Speaker] TCP server listening on ${host || '0.0.0.0'}:${port}`);
    });
    this.pingTimer = setInterval(() => this.pingDevices(), 10000);
    this.pingTimer.unref?.();
    return this.server;
  }

  accept(socket) {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    const connection = { socket, buffer: '', device: null, closed: false };
    socket.on('data', (chunk) => this.handleDeviceData(connection, chunk));
    socket.on('close', () => this.removeConnection(connection, 'disconnected'));
    socket.on('error', (error) => {
      this.logger.warn?.('[Mentor Speaker] socket error:', error.message);
      this.removeConnection(connection, 'error');
    });
  }

  handleDeviceData(connection, chunk) {
    if (connection.closed) return;
    connection.buffer += chunk.toString('utf8');
    if (connection.buffer.length > MAX_HANDSHAKE_BYTES * 4) {
      connection.socket.destroy(new Error('Speaker telemetry exceeded the input limit.'));
      return;
    }
    while (true) {
      const newline = connection.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = connection.buffer.slice(0, newline).trim();
      connection.buffer = connection.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        connection.socket.destroy(new Error('Invalid speaker JSON.'));
        return;
      }
      if (!connection.device) this.registerDevice(connection, message);
      else this.handleTelemetry(connection.device, message);
    }
  }

  registerDevice(connection, message) {
    const boardId = String(message?.boardId || '').trim();
    const suppliedToken = String(message?.token || '');
    const capabilities = message?.capabilities || {};
    const validCapabilities = capabilities.encoding === SPEAKER_ENCODING
      && Number(capabilities.sampleRate) === SPEAKER_SAMPLE_RATE
      && Number(capabilities.channels) === 1;
    if (message?.type !== 'hello'
      || Number(message?.protocolVersion) !== SPEAKER_PROTOCOL_VERSION
      || !boardId
      || boardId.length > 64
      || !this.token
      || suppliedToken !== this.token
      || !validCapabilities) {
      connection.socket.write(`${JSON.stringify({ type: 'rejected', reason: 'authentication_or_capability_mismatch' })}\n`);
      connection.socket.end();
      return;
    }

    const existing = this.devices.get(boardId);
    if (existing && existing.socket !== connection.socket) {
      existing.socket.destroy();
      this.removeDevice(existing, 'replaced');
    }
    const device = {
      id: boardId,
      socket: connection.socket,
      connectedAt: this.now(),
      lastSeenAt: this.now(),
      capabilities,
      state: 'ready',
      activeSessionId: null,
      bufferedMs: 0,
      underruns: 0,
      freeHeap: null,
      freePsram: null,
      sensorMaxGapMs: null,
      i2sBytesPerSecond: null,
      i2sTimeoutsPerSecond: null
    };
    connection.device = device;
    this.devices.set(boardId, device);
    connection.socket.write(`${JSON.stringify({
      type: 'accepted',
      protocolVersion: SPEAKER_PROTOCOL_VERSION,
      boardId,
      sampleRate: SPEAKER_SAMPLE_RATE
    })}\n`);
    this.emit('devices-changed', this.listDevices());
    this.logger.log?.(`[Mentor Speaker] ${boardId} connected`);
  }

  bufferProfileFor(deviceId) {
    let profile = this.bufferProfiles.get(deviceId);
    if (!profile) {
      profile = {
        targetMs: this.adaptiveInitialBufferMs,
        smoothResponses: 0,
        lastReason: 'initial'
      };
      this.bufferProfiles.set(deviceId, profile);
    }
    return profile;
  }

  providerLeadMs(binding, at = this.now()) {
    if (binding.firstProviderChunkAt === null) return 0;
    const audioMs = Math.round(binding.providerBytes * 1000 / SPEAKER_BYTES_PER_SECOND);
    return audioMs - Math.max(0, at - binding.firstProviderChunkAt);
  }

  prepareAdaptiveResponse(binding) {
    const profile = this.bufferProfileFor(binding.deviceId);
    binding.providerChunkCount = 0;
    binding.providerBytes = 0;
    binding.firstProviderChunkAt = null;
    binding.lastProviderChunkAt = null;
    binding.maxProviderGapMs = 0;
    binding.responseHadUnderrun = false;
    binding.responseQualityFinalized = false;
    binding.adaptiveTargetMs = profile.targetMs;
    binding.adaptiveStartReason = null;
    binding.adaptiveBufferedAtStartMs = 0;
  }

  adaptiveStartDecision(binding) {
    const bufferedMs = Math.round(binding.responseBytes * 1000 / SPEAKER_BYTES_PER_SECOND);
    const providerLeadMs = this.providerLeadMs(binding);
    if (binding.responseBytes >= this.startBufferBytes) {
      return { start: true, reason: 'maximum_buffer', bufferedMs, providerLeadMs };
    }
    if (bufferedMs < binding.adaptiveTargetMs) {
      return { start: false, reason: 'target_not_reached', bufferedMs, providerLeadMs };
    }
    if (binding.maxProviderGapMs > this.adaptiveMaximumProviderGapMs) {
      return { start: false, reason: 'provider_gap', bufferedMs, providerLeadMs };
    }
    if (providerLeadMs < this.adaptiveSafetyLeadMs) {
      return { start: false, reason: 'insufficient_lead', bufferedMs, providerLeadMs };
    }
    return { start: true, reason: 'adaptive_buffer', bufferedMs, providerLeadMs };
  }

  markAdaptiveResponseUnstable(binding, reason) {
    if (binding.transport !== 'tcp') return;
    const profile = this.bufferProfileFor(binding.deviceId);
    profile.targetMs = this.maximumStartBufferMs;
    profile.smoothResponses = 0;
    profile.lastReason = reason;
    binding.adaptiveTargetMs = profile.targetMs;
  }

  finalizeAdaptiveResponse(binding) {
    if (binding.transport !== 'tcp' || binding.responseQualityFinalized) return;
    binding.responseQualityFinalized = true;
    const profile = this.bufferProfileFor(binding.deviceId);
    const providerLeadMs = this.providerLeadMs(binding, binding.lastProviderChunkAt || this.now());
    if (binding.responseHadUnderrun
        || binding.maxProviderGapMs >= this.adaptiveUnstableProviderGapMs) {
      this.markAdaptiveResponseUnstable(
        binding,
        binding.responseHadUnderrun ? 'device_underrun' : 'provider_gap'
      );
      return;
    }
    const smooth = binding.maxProviderGapMs <= this.adaptiveMaximumProviderGapMs
      && providerLeadMs >= this.adaptiveSafetyLeadMs;
    if (!smooth) {
      profile.smoothResponses = 0;
      profile.lastReason = 'held';
      return;
    }
    profile.smoothResponses += 1;
    profile.lastReason = 'smooth';
    if (profile.smoothResponses < this.adaptiveSmoothResponses) return;
    profile.targetMs = Math.max(
      this.adaptiveMinimumBufferMs,
      profile.targetMs - this.adaptiveStepMs
    );
    profile.smoothResponses = 0;
    profile.lastReason = 'reduced_after_smooth_responses';
  }

  handleTelemetry(device, message) {
    if (!message || typeof message.type !== 'string') return;
    device.lastSeenAt = this.now();
    if (Number.isFinite(Number(message.bufferedMs))) device.bufferedMs = Math.max(0, Number(message.bufferedMs));
    if (message.type === 'underrun') device.underruns += 1;
    for (const field of [
      'freeHeap',
      'freePsram',
      'sensorMaxGapMs',
      'i2sBytesPerSecond',
      'i2sTimeoutsPerSecond'
    ]) {
      if (Number.isFinite(Number(message[field]))) device[field] = Number(message[field]);
    }
    if (message.type === 'error' || device.bufferedMs > SPEAKER_DEGRADED_BUFFER_MS) {
      device.state = 'degraded';
      if (message.type === 'error') {
        this.logger.warn?.(
          `[Mentor Speaker] ${device.id} reported ${message.error || 'unknown speaker error'}`
        );
      }
    }
    else if (message.type === 'started' || message.type === 'playing') device.state = 'playing';
    else if (message.type === 'ready' || message.type === 'cleared' || message.type === 'ended') {
      device.state = 'ready';
    }

    const binding = device.activeSessionId ? this.bindings.get(device.activeSessionId) : null;
    if (binding && (!message.sessionId || message.sessionId === binding.sessionId)) {
      if (message.type === 'underrun') {
        binding.responseHadUnderrun = true;
        this.markAdaptiveResponseUnstable(binding, 'device_underrun');
      }
      if (Number.isFinite(Number(message.bufferedMs))) {
        binding.bufferedBytes = Math.max(
          0,
          Math.floor(Number(message.bufferedMs) * SPEAKER_BYTES_PER_SECOND / 1000)
        );
        binding.bufferUpdatedAt = this.now();
      }
      if (binding.speaking && binding.endSent && message.type === 'playing'
          && device.bufferedMs <= 250
          && this.now() - binding.lastEndSentAt >= SPEAKER_END_RESEND_MS) {
        const resent = this.write(device, createSpeakerFrame(FRAME_TYPES.END, {
          sessionId: binding.sessionId,
          finalSequence: binding.sequence
        }, binding.sequence));
        if (resent) binding.lastEndSentAt = this.now();
      }
      if (message.type === 'ended' || message.type === 'cleared') {
        if (message.type === 'ended') this.finalizeAdaptiveResponse(binding);
        binding.speaking = false;
        this.resetAudioQueue(binding);
      } else if (binding.speaking) {
        this.pumpAudio(binding);
        if (message.type === 'underrun') this.scheduleIdleGuard(binding);
      }
      if (message.type !== 'pong') {
        this.publish(binding, message.type, {
          bufferedMs: device.bufferedMs,
          underruns: device.underruns,
          queuedMs: Math.round(binding.queuedBytes * 1000 / SPEAKER_BYTES_PER_SECOND),
          providerChunkCount: binding.providerChunkCount,
          maxProviderGapMs: binding.maxProviderGapMs,
          adaptiveTargetMs: binding.adaptiveTargetMs,
          providerLeadMs: this.providerLeadMs(binding),
          error: message.error || null,
          freeHeap: device.freeHeap,
          freePsram: device.freePsram,
          sensorMaxGapMs: device.sensorMaxGapMs,
          i2sBytesPerSecond: device.i2sBytesPerSecond,
          i2sTimeoutsPerSecond: device.i2sTimeoutsPerSecond,
          adaptiveStartBufferMs: this.bufferProfileFor(device.id).targetMs
        });
      }
      if (message.type === 'underrun') {
        this.logger.warn?.(
          `[Mentor Speaker] ${device.id} underrun #${device.underruns}; `
          + `queued=${Math.round(binding.queuedBytes * 1000 / SPEAKER_BYTES_PER_SECOND)}ms, `
          + `largest provider gap=${binding.maxProviderGapMs}ms`
        );
      }
    }
    this.emit('telemetry', { deviceId: device.id, ...message });
  }

  removeConnection(connection, reason) {
    if (connection.closed) return;
    connection.closed = true;
    this.sockets.delete(connection.socket);
    if (connection.device) this.removeDevice(connection.device, reason);
  }

  removeDevice(device, reason) {
    if (this.devices.get(device.id) !== device) return;
    this.devices.delete(device.id);
    const binding = device.activeSessionId ? this.bindings.get(device.activeSessionId) : null;
    if (binding) {
      binding.speaking = false;
      if (this.relayService?.canMixMentor?.()) {
        binding.transport = 'relay';
        binding.resolvedOutput = 'board';
        binding.fallback = false;
        binding.degraded = false;
        this.publish(binding, 'ready', { reason: 'spotify_relay_active' });
      } else if (binding.requestedMode === 'auto') {
        binding.degraded = true;
        binding.resolvedOutput = 'browser';
        binding.fallback = true;
        this.publish(binding, 'fallback', { reason });
      } else {
        binding.degraded = true;
        this.publish(binding, 'disconnected', { reason });
      }
    }
    device.activeSessionId = null;
    this.emit('devices-changed', this.listDevices());
    this.logger.log?.(`[Mentor Speaker] ${device.id} ${reason}`);
  }

  listDevices() {
    const devices = [...this.devices.values()]
      .map((device) => ({
        id: device.id,
        status: device.state,
        connectedAt: device.connectedAt,
        lastSeenAt: device.lastSeenAt,
        bufferedMs: device.bufferedMs,
        underruns: device.underruns,
        freeHeap: device.freeHeap,
        freePsram: device.freePsram,
        sensorMaxGapMs: device.sensorMaxGapMs,
        i2sBytesPerSecond: device.i2sBytesPerSecond,
        i2sTimeoutsPerSecond: device.i2sTimeoutsPerSecond,
        adaptiveStartBufferMs: this.bufferProfileFor(device.id).targetMs,
        capabilities: {
          encoding: device.capabilities.encoding,
          sampleRate: Number(device.capabilities.sampleRate),
          channels: Number(device.capabilities.channels),
          bufferBytes: Number(device.capabilities.bufferBytes) || null
        }
      }));
    if (this.relayService?.canMixMentor?.()
        && !devices.some((device) => device.id === this.defaultDeviceId)) {
      devices.push({
        id: this.defaultDeviceId,
        status: 'relay',
        connectedAt: null,
        lastSeenAt: this.now(),
        bufferedMs: 0,
        underruns: 0,
        freeHeap: null,
        freePsram: null,
        sensorMaxGapMs: null,
        i2sBytesPerSecond: null,
        i2sTimeoutsPerSecond: null,
        adaptiveStartBufferMs: null,
        capabilities: {
          encoding: 'pcm16_mixed_http_mp3',
          sampleRate: SPEAKER_SAMPLE_RATE,
          channels: 1,
          bufferBytes: null
        }
      });
    }
    return devices.sort((left, right) => left.id.localeCompare(right.id));
  }

  bindSession({ conversationId, sessionId, outputMode = 'auto', deviceId, volume = DEFAULT_VOLUME }) {
    const requestedMode = normalizeOutputMode(outputMode);
    const selectedDeviceId = String(deviceId || this.defaultDeviceId);
    const device = this.devices.get(selectedDeviceId);
    const tcpAvailable = device && !device.socket.destroyed && device.state !== 'degraded'
      && (!device.activeSessionId || device.activeSessionId === sessionId);
    const relayAvailable = selectedDeviceId === this.defaultDeviceId
      && this.relayService?.canMixMentor?.();
    const available = tcpAvailable || relayAvailable;
    if (requestedMode === 'board' && !available) {
      throw speakerError(
        `Board speaker ${selectedDeviceId} is not available.`,
        'mentor_speaker_unavailable',
        409
      );
    }
    const binding = {
      conversationId,
      sessionId,
      requestedMode,
      resolvedOutput: requestedMode === 'browser' || !available ? 'browser' : 'board',
      deviceId: selectedDeviceId,
      volume: normalizeVolume(volume),
      sequence: 0,
      speaking: false,
      speechBytes: 0,
      audioQueue: [],
      queuedBytes: 0,
      responseQueue: [],
      responseBytes: 0,
      adpcmState: createImaAdpcmState(),
      collectingResponse: false,
      responseRejected: false,
      bufferedBytes: 0,
      bufferUpdatedAt: this.now(),
      pumpTimer: null,
      idleTimer: null,
      relayEndTimer: null,
      endRequested: false,
      endSent: false,
      lastEndSentAt: 0,
      degraded: false,
      fallback: requestedMode === 'auto' && !available,
      transport: relayAvailable ? 'relay' : tcpAvailable ? 'tcp' : 'browser',
      providerChunkCount: 0,
      providerBytes: 0,
      firstProviderChunkAt: null,
      lastProviderChunkAt: null,
      maxProviderGapMs: 0,
      responseHadUnderrun: false,
      responseQualityFinalized: false,
      adaptiveTargetMs: this.bufferProfileFor(selectedDeviceId).targetMs,
      adaptiveStartReason: null,
      adaptiveBufferedAtStartMs: 0
    };
    this.bindings.set(sessionId, binding);
    if (binding.resolvedOutput === 'board' && binding.transport === 'tcp') {
      device.activeSessionId = sessionId;
    }
    this.publish(binding, binding.fallback ? 'fallback' : 'ready', {
      reason: binding.fallback ? 'board_unavailable' : null
    });
    return this.publicBinding(binding);
  }

  publicBinding(binding) {
    return {
      outputMode: binding.requestedMode,
      resolvedOutput: binding.resolvedOutput,
      deviceId: binding.deviceId,
      boardVolume: binding.volume,
      speakerStatus: binding.fallback ? 'fallback' : binding.resolvedOutput === 'board' ? 'ready' : 'browser',
      adaptiveStartBufferMs: binding.transport === 'tcp' ? binding.adaptiveTargetMs : null
    };
  }

  publish(binding, status, extra = {}) {
    const payload = {
      conversationId: binding.conversationId,
      sessionId: binding.sessionId,
      deviceId: binding.deviceId,
      outputMode: binding.requestedMode,
      resolvedOutput: binding.resolvedOutput,
      status,
      ...extra
    };
    this.emitStatus(binding.conversationId, payload);
    this.emit('status', payload);
  }

  write(device, frame) {
    if (!device || device.socket.destroyed) return false;
    if (device.socket.writableLength + frame.length > this.maxQueueBytes) return false;
    device.socket.write(frame);
    return true;
  }

  estimatedBufferedBytes(binding) {
    const elapsedMs = Math.max(0, this.now() - binding.bufferUpdatedAt);
    const drainedBytes = Math.floor(elapsedMs * SPEAKER_BYTES_PER_SECOND / 1000);
    return Math.max(0, binding.bufferedBytes - drainedBytes);
  }

  updateBufferedEstimate(binding, addedBytes = 0) {
    binding.bufferedBytes = this.estimatedBufferedBytes(binding) + addedBytes;
    binding.bufferUpdatedAt = this.now();
  }

  cancelPump(binding) {
    if (binding.pumpTimer) clearTimeout(binding.pumpTimer);
    binding.pumpTimer = null;
  }

  cancelIdleGuard(binding) {
    if (binding.idleTimer) clearTimeout(binding.idleTimer);
    binding.idleTimer = null;
  }

  scheduleIdleGuard(binding) {
    this.cancelIdleGuard(binding);
    if (!binding.speaking || binding.lastProviderChunkAt === null) return;
    const bufferedMs = Math.ceil(
      this.estimatedBufferedBytes(binding) * 1000 / SPEAKER_BYTES_PER_SECOND
    );
    const silentMs = Math.max(0, this.now() - binding.lastProviderChunkAt);
    const delayMs = Math.max(50, bufferedMs + Math.max(0, this.idleEndMs - silentMs));
    binding.idleTimer = setTimeout(() => {
      binding.idleTimer = null;
      if (!binding.speaking) return;
      const remainingBytes = binding.queuedBytes + this.estimatedBufferedBytes(binding);
      const idleMs = Math.max(0, this.now() - binding.lastProviderChunkAt);
      if (remainingBytes > 0 || idleMs < this.idleEndMs) {
        this.scheduleIdleGuard(binding);
        return;
      }
      this.logger.warn?.(
        `[Mentor Speaker] ${binding.deviceId} output ended after ${idleMs}ms without audio`
      );
      this.clearOutput(binding.conversationId, binding.sessionId, 'audio_idle_timeout');
    }, delayMs);
    binding.idleTimer.unref?.();
  }

  resetPlaybackQueue(binding) {
    this.cancelPump(binding);
    this.cancelIdleGuard(binding);
    if (binding.relayEndTimer) clearTimeout(binding.relayEndTimer);
    binding.relayEndTimer = null;
    binding.audioQueue = [];
    binding.queuedBytes = 0;
    binding.bufferedBytes = 0;
    binding.bufferUpdatedAt = this.now();
    binding.endRequested = false;
    binding.endSent = false;
    binding.lastEndSentAt = 0;
  }

  resetAudioQueue(binding) {
    this.resetPlaybackQueue(binding);
    binding.responseQueue = [];
    binding.responseBytes = 0;
    binding.adpcmState = createImaAdpcmState();
    binding.collectingResponse = false;
  }

  flushPendingAudio(binding) {
    const encodedAudio = flushImaAdpcm(binding.adpcmState);
    if (encodedAudio.length === 0) return;
    const decodedBytes = encodedAudio.length * 4;
    if (binding.speaking) {
      binding.audioQueue.push(encodedAudio);
      binding.queuedBytes += decodedBytes;
    } else {
      binding.responseQueue.push(encodedAudio);
      binding.responseBytes += decodedBytes;
    }
  }

  schedulePump(binding) {
    if (binding.pumpTimer || !binding.speaking) return;
    binding.pumpTimer = setTimeout(() => {
      binding.pumpTimer = null;
      this.pumpAudio(binding);
    }, SPEAKER_PUMP_INTERVAL_MS);
    binding.pumpTimer.unref?.();
  }

  pumpAudio(binding) {
    if (!binding.speaking || binding.resolvedOutput !== 'board') return;
    const device = this.devices.get(binding.deviceId);
    if (!device || device.activeSessionId !== binding.sessionId || device.state === 'degraded') {
      this.degradeBinding(binding, 'device_unavailable_while_pumping');
      return;
    }

    const advertisedBufferBytes = Number(device.capabilities.bufferBytes) || 0;
    const deviceFeedAheadBytes = advertisedBufferBytes > SPEAKER_PCM_FRAME_BYTES
      ? Math.max(
        SPEAKER_FEED_AHEAD_BYTES,
        Math.min(this.maxResponseBytes, advertisedBufferBytes - SPEAKER_PCM_FRAME_BYTES)
      )
      : SPEAKER_FEED_AHEAD_BYTES;
    let availableBytes = Math.max(
      0,
      deviceFeedAheadBytes - this.estimatedBufferedBytes(binding)
    );
    while (availableBytes >= 4 && binding.audioQueue.length > 0) {
      const queued = binding.audioQueue[0];
      const frameBytes = Math.min(
        queued.length,
        SPEAKER_PCM_FRAME_BYTES,
        Math.floor(availableBytes / 4)
      );
      if (frameBytes <= 0) break;
      const payload = queued.subarray(0, frameBytes);
      const decodedBytes = frameBytes * 4;
      const sequence = ++binding.sequence;
      if (!this.write(device, createSpeakerFrame(FRAME_TYPES.PCM, payload, sequence))) {
        this.degradeBinding(binding, 'audio_backpressure');
        return;
      }
      binding.audioQueue[0] = queued.subarray(frameBytes);
      if (binding.audioQueue[0].length === 0) binding.audioQueue.shift();
      binding.queuedBytes -= decodedBytes;
      binding.speechBytes += decodedBytes;
      this.updateBufferedEstimate(binding, decodedBytes);
      availableBytes -= decodedBytes;
    }

    if (binding.queuedBytes === 0 && binding.endRequested && !binding.endSent) {
      const sent = this.write(device, createSpeakerFrame(FRAME_TYPES.END, {
        sessionId: binding.sessionId,
        finalSequence: binding.sequence
      }, binding.sequence));
      if (!sent) {
        this.degradeBinding(binding, 'end_backpressure');
        return;
      }
      binding.endSent = true;
      binding.lastEndSentAt = this.now();
    }

    if (binding.queuedBytes > 0 || (binding.endRequested && !binding.endSent)) {
      this.schedulePump(binding);
    }
  }

  startSpeech(binding, device) {
    this.resetPlaybackQueue(binding);
    binding.sequence = 0;
    binding.speechBytes = 0;
    const frame = createSpeakerFrame(FRAME_TYPES.START, {
      sessionId: binding.sessionId,
      conversationId: binding.conversationId,
      sampleRate: SPEAKER_SAMPLE_RATE,
      channels: 1,
      encoding: SPEAKER_ENCODING,
      bitsPerSample: 4,
      decodedBitsPerSample: 16,
      volume: binding.volume
    });
    if (!this.write(device, frame)) return false;
    binding.speaking = true;
    this.publish(binding, 'playing', {
      adaptiveStartBufferMs: binding.adaptiveTargetMs,
      bufferedResponseMs: binding.adaptiveBufferedAtStartMs,
      providerLeadMs: this.providerLeadMs(binding),
      startReason: binding.adaptiveStartReason || 'response_complete'
    });
    return true;
  }

  startBufferedPlayback(binding, device) {
    if (binding.speaking) return true;
    if (binding.responseBytes === 0) return false;
    const responseQueue = binding.responseQueue;
    const responseBytes = binding.responseBytes;
    binding.adaptiveBufferedAtStartMs = Math.round(
      responseBytes * 1000 / SPEAKER_BYTES_PER_SECOND
    );
    binding.responseQueue = [];
    binding.responseBytes = 0;
    if (!this.startSpeech(binding, device)) {
      binding.responseQueue = responseQueue;
      binding.responseBytes = responseBytes;
      return false;
    }
    binding.audioQueue = responseQueue;
    binding.queuedBytes = responseBytes;
    this.pumpAudio(binding);
    return true;
  }

  routeAudio({ conversationId, sessionId, pcm, sampleRate = SPEAKER_SAMPLE_RATE }) {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.conversationId !== conversationId || binding.requestedMode === 'browser') {
      return { destination: 'browser', reason: binding?.fallback ? 'fallback' : 'browser_selected' };
    }
    const bytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    if (binding.responseRejected) {
      return {
        destination: binding.requestedMode === 'auto' ? 'browser' : 'none',
        reason: 'audio_response_limit'
      };
    }
    const relayAvailable = binding.deviceId === this.defaultDeviceId
      && this.relayService?.canMixMentor?.();
    if (relayAvailable) {
      if (sampleRate !== SPEAKER_SAMPLE_RATE || bytes.length === 0 || bytes.length % 2 !== 0) {
        return this.degradeBinding(binding, 'relay_pcm_unavailable');
      }
      if (!binding.collectingResponse) {
        binding.providerChunkCount = 0;
        binding.providerBytes = 0;
        binding.firstProviderChunkAt = null;
        binding.lastProviderChunkAt = null;
        binding.maxProviderGapMs = 0;
        binding.collectingResponse = true;
      }
      const receivedAt = this.now();
      if (binding.firstProviderChunkAt === null) binding.firstProviderChunkAt = receivedAt;
      if (binding.lastProviderChunkAt !== null) {
        binding.maxProviderGapMs = Math.max(binding.maxProviderGapMs, receivedAt - binding.lastProviderChunkAt);
      }
      binding.lastProviderChunkAt = receivedAt;
      if (binding.providerBytes + bytes.length > this.maxResponseBytes) {
        return this.rejectOversizedResponse(binding);
      }
      binding.providerChunkCount += 1;
      binding.providerBytes += bytes.length;
      binding.transport = 'relay';
      binding.resolvedOutput = 'board';
      binding.fallback = false;
      binding.degraded = false;
      if (!this.relayService.routeMentorPcm({
        sessionId,
        pcm: bytes,
        volume: binding.volume,
        sampleRate
      })) {
        return this.degradeBinding(binding, 'relay_backpressure');
      }
      if (!binding.speaking) {
        binding.speaking = true;
        this.publish(binding, 'playing', { transport: 'spotify-relay' });
      }
      return {
        destination: 'board',
        deviceId: binding.deviceId,
        transport: 'spotify-relay',
        bufferedResponseMs: Math.round(
          (this.relayService.status().buffers?.voiceBytes || 0) * 1000 / SPEAKER_BYTES_PER_SECOND
        )
      };
    }
    if (binding.resolvedOutput !== 'board') {
      return { destination: 'browser', reason: binding.fallback ? 'fallback' : 'browser_selected' };
    }
    const device = this.devices.get(binding.deviceId);
    if (!device || device.activeSessionId !== sessionId || device.state === 'degraded'
      || sampleRate !== SPEAKER_SAMPLE_RATE || bytes.length === 0 || bytes.length % 2 !== 0) {
      return this.degradeBinding(binding, 'device_or_pcm_unavailable');
    }
    if (!binding.collectingResponse && !binding.speaking && binding.responseBytes === 0) {
      this.prepareAdaptiveResponse(binding);
      binding.adpcmState = createImaAdpcmState();
      binding.collectingResponse = true;
      this.publish(binding, 'buffering', {
        bufferedResponseMs: 0,
        adaptiveStartBufferMs: binding.adaptiveTargetMs,
        maximumStartBufferMs: this.maximumStartBufferMs,
        providerLeadMs: 0
      });
    }
    const receivedAt = this.now();
    if (binding.firstProviderChunkAt === null) binding.firstProviderChunkAt = receivedAt;
    if (binding.lastProviderChunkAt !== null) {
      binding.maxProviderGapMs = Math.max(
        binding.maxProviderGapMs,
        receivedAt - binding.lastProviderChunkAt
      );
    }
    binding.lastProviderChunkAt = receivedAt;
    if (binding.providerBytes + bytes.length > this.maxResponseBytes) {
      return this.rejectOversizedResponse(binding);
    }
    binding.providerChunkCount += 1;
    binding.providerBytes += bytes.length;
    const encodedAudio = encodePcm16LeToImaAdpcm(bytes, binding.adpcmState);
    const decodedBytes = encodedAudio.length * 4;
    if (binding.speaking) {
      if (encodedAudio.length > 0) binding.audioQueue.push(encodedAudio);
      binding.queuedBytes += decodedBytes;
      this.pumpAudio(binding);
    } else {
      if (encodedAudio.length > 0) binding.responseQueue.push(encodedAudio);
      binding.responseBytes += decodedBytes;
      const decision = this.adaptiveStartDecision(binding);
      if (decision.start) {
        binding.adaptiveStartReason = decision.reason;
        if (!this.startBufferedPlayback(binding, device)) {
          return this.degradeBinding(binding, 'start_backpressure');
        }
      }
    }
    return {
      destination: 'board',
      sequence: binding.sequence,
      deviceId: binding.deviceId,
      bufferedResponseMs: Math.round(
        (binding.responseBytes + binding.queuedBytes + this.estimatedBufferedBytes(binding))
        * 1000 / SPEAKER_BYTES_PER_SECOND
      ),
      adaptiveStartBufferMs: binding.adaptiveTargetMs,
      providerLeadMs: this.providerLeadMs(binding)
    };
  }

  degradeBinding(binding, reason) {
    if (binding.transport === 'relay') this.relayService?.clearMentorPcm?.(binding.sessionId);
    this.resetAudioQueue(binding);
    binding.speaking = false;
    binding.degraded = true;
    const device = this.devices.get(binding.deviceId);
    if (device && binding.transport !== 'relay') device.state = 'degraded';
    if (binding.requestedMode === 'auto') {
      binding.resolvedOutput = 'browser';
      binding.fallback = true;
      this.publish(binding, 'fallback', { reason });
      return { destination: 'browser', reason };
    }
    this.publish(binding, 'degraded', { reason });
    return { destination: 'none', reason };
  }

  rejectOversizedResponse(binding) {
    const device = this.devices.get(binding.deviceId);
    if (binding.transport === 'relay') this.relayService?.clearMentorPcm?.(binding.sessionId);
    if (binding.speaking && device?.activeSessionId === binding.sessionId) {
      this.write(device, createSpeakerFrame(FRAME_TYPES.CLEAR, {
        sessionId: binding.sessionId,
        reason: 'audio_response_limit'
      }, binding.sequence));
      if (device.state === 'playing') device.state = 'ready';
    }
    this.resetAudioQueue(binding);
    binding.speaking = false;
    binding.responseRejected = true;
    this.publish(binding, 'response_too_long', {
      reason: 'audio_response_limit',
      maxResponseMs: Math.round(this.maxResponseBytes * 1000 / SPEAKER_BYTES_PER_SECOND)
    });
    return {
      destination: binding.requestedMode === 'auto' ? 'browser' : 'none',
      reason: 'audio_response_limit'
    };
  }

  endSpeech(conversationId, sessionId) {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.conversationId !== conversationId) return false;
    if (binding.transport === 'relay') {
      const ended = this.relayService?.endMentorPcm?.(sessionId) || false;
      binding.collectingResponse = false;
      if (binding.relayEndTimer) clearTimeout(binding.relayEndTimer);
      const bufferedMs = Math.round(
        (this.relayService?.status?.().buffers?.voiceBytes || 0) * 1000 / SPEAKER_BYTES_PER_SECOND
      );
      binding.relayEndTimer = setTimeout(() => {
        binding.relayEndTimer = null;
        if (!binding.speaking) return;
        binding.speaking = false;
        this.publish(binding, ended ? 'ended' : 'degraded', { transport: 'spotify-relay' });
      }, bufferedMs + 2800);
      binding.relayEndTimer.unref?.();
      return ended;
    }
    const device = this.devices.get(binding.deviceId);
    if (!device || device.activeSessionId !== sessionId) return false;
    if (binding.responseRejected) {
      binding.responseRejected = false;
      this.publish(binding, 'ready', { reason: 'response_limit_cleared' });
      return false;
    }
    binding.collectingResponse = false;
    this.flushPendingAudio(binding);
    if (!binding.speaking && binding.responseBytes > 0) {
      binding.adaptiveStartReason = 'response_complete';
      if (!this.startBufferedPlayback(binding, device)) {
        this.degradeBinding(binding, 'start_backpressure');
        return false;
      }
    }
    if (!binding.speaking) return false;
    binding.endRequested = true;
    this.cancelIdleGuard(binding);
    const providerAudioMs = Math.round(binding.providerBytes * 1000 / SPEAKER_BYTES_PER_SECOND);
    const providerElapsedMs = binding.firstProviderChunkAt === null
      ? 0
      : Math.max(0, (binding.lastProviderChunkAt || this.now()) - binding.firstProviderChunkAt);
    this.logger.log?.(
      `[Mentor Speaker] ${binding.deviceId} response received `
      + `${providerAudioMs}ms audio across ${providerElapsedMs}ms; `
      + `${binding.providerChunkCount} chunks, largest gap ${binding.maxProviderGapMs}ms; `
      + `start=${binding.adaptiveStartReason || 'response_complete'} at `
      + `${binding.adaptiveTargetMs}ms target`
    );
    this.pumpAudio(binding);
    return true;
  }

  clearOutput(conversationId, sessionId, reason = 'interrupted') {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.conversationId !== conversationId) return false;
    const device = this.devices.get(binding.deviceId);
    if (binding.transport === 'relay') this.relayService?.clearMentorPcm?.(sessionId);
    if (binding.relayEndTimer) clearTimeout(binding.relayEndTimer);
    binding.relayEndTimer = null;
    binding.speaking = false;
    this.resetAudioQueue(binding);
    if (device?.activeSessionId === sessionId) {
      this.write(device, createSpeakerFrame(FRAME_TYPES.CLEAR, { sessionId, reason }, binding.sequence));
      if (device.state === 'playing') device.state = 'ready';
    }
    this.publish(binding, 'cleared', { reason });
    return true;
  }

  releaseSession(conversationId, sessionId, reason = 'closed') {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.conversationId !== conversationId) return false;
    this.clearOutput(conversationId, sessionId, reason);
    const device = this.devices.get(binding.deviceId);
    if (device?.activeSessionId === sessionId) {
      this.write(device, createSpeakerFrame(FRAME_TYPES.END, { sessionId, reason }, binding.sequence));
      device.activeSessionId = null;
      if (device.state === 'playing') device.state = 'ready';
    }
    this.bindings.delete(sessionId);
    return true;
  }

  pingDevices() {
    for (const device of this.devices.values()) {
      this.write(device, createSpeakerFrame(FRAME_TYPES.PING, { sentAt: this.now() }));
    }
  }

  async close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.devices.clear();
    this.bindings.clear();
    if (this.server.listening) {
      await new Promise((resolve) => this.server.close(resolve));
    }
  }
}

module.exports = {
  DEFAULT_DEVICE_ID,
  DEFAULT_VOLUME,
  FRAME_TYPES,
  MAX_SPEAKER_QUEUE_BYTES,
  MAX_BUFFERED_RESPONSE_BYTES,
  SPEAKER_DEGRADED_BUFFER_MS,
  SPEAKER_END_RESEND_MS,
  SPEAKER_ENCODING,
  SPEAKER_IDLE_END_MS,
  SPEAKER_FEED_AHEAD_BYTES,
  SPEAKER_FEED_AHEAD_MS,
  SPEAKER_PCM_FRAME_BYTES,
  MentorSpeakerService,
  SPEAKER_BYTES_PER_SECOND,
  SPEAKER_HEADER_BYTES,
  SPEAKER_MAGIC,
  SPEAKER_PROTOCOL_VERSION,
  SPEAKER_SAMPLE_RATE,
  SPEAKER_TRANSPORT_BYTES_PER_SECOND,
  SPEAKER_START_BUFFER_BYTES,
  SPEAKER_START_BUFFER_MS,
  SPEAKER_ADAPTIVE_INITIAL_BUFFER_MS,
  SPEAKER_ADAPTIVE_MIN_BUFFER_MS,
  SPEAKER_ADAPTIVE_SAFETY_LEAD_MS,
  SPEAKER_ADAPTIVE_MAX_PROVIDER_GAP_MS,
  SPEAKER_ADAPTIVE_UNSTABLE_PROVIDER_GAP_MS,
  createSpeakerFrame,
  createImaAdpcmState,
  decodeImaAdpcmToPcm16Le,
  encodePcm16LeToImaAdpcm,
  flushImaAdpcm,
  normalizeOutputMode,
  normalizeVolume,
  parseSpeakerFrame,
  speakerError
};
