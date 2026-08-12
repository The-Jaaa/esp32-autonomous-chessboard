const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { timingSafeEqual } = require('crypto');

const MUSIC_SAMPLE_RATE = 44100;
const MUSIC_CHANNELS = 2;
const VOICE_SAMPLE_RATE = 24000;
const FRAME_MS = 20;
const MUSIC_FRAME_BYTES = MUSIC_SAMPLE_RATE * MUSIC_CHANNELS * 2 * FRAME_MS / 1000;
const VOICE_FRAME_BYTES = VOICE_SAMPLE_RATE * 2 * FRAME_MS / 1000;
const MAX_PACE_CATCHUP_FRAMES = 8;
const PACE_RESET_AFTER_MS = 1000;
const DEFAULT_IDLE_MS = 10000;
const DEFAULT_MUSIC_GAIN_DB = 6;
const STABLE_PROCESS_MS = 30000;
const RESTART_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);

class ByteQueue {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.offset = 0;
    this.length = 0;
    this.droppedBytes = 0;
  }

  push(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    while (this.length > this.maxBytes && this.chunks.length) {
      const overflow = this.length - this.maxBytes;
      const firstAvailable = this.chunks[0].length - this.offset;
      const removed = Math.min(overflow, firstAvailable);
      this.offset += removed;
      this.length -= removed;
      this.droppedBytes += removed;
      if (this.offset === this.chunks[0].length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
  }

  read(size) {
    const output = Buffer.alloc(size);
    let written = 0;
    while (written < size && this.chunks.length) {
      const chunk = this.chunks[0];
      const available = chunk.length - this.offset;
      const count = Math.min(size - written, available);
      chunk.copy(output, written, this.offset, this.offset + count);
      written += count;
      this.offset += count;
      this.length -= count;
      if (this.offset === chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return output;
  }

  clear() {
    this.chunks = [];
    this.offset = 0;
    this.length = 0;
  }
}

function scalePcm16Le(pcm, volume) {
  const input = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  const output = Buffer.alloc(input.length & ~1);
  const gain = Math.max(0, Math.min(100, Number(volume) || 0)) / 100;
  for (let offset = 0; offset < output.length; offset += 2) {
    const sample = input.readInt16LE(offset);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * gain))), offset);
  }
  return output;
}

function hasAudiblePcm(pcm, threshold = 32) {
  for (let offset = 0; offset + 1 < pcm.length; offset += 32) {
    if (Math.abs(pcm.readInt16LE(offset)) >= threshold) return true;
  }
  return false;
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function defaultToolPath(root, tool) {
  if (tool === 'ffmpeg') {
    return path.join(root, 'tools', 'ffmpeg', 'extract', 'ffmpeg-8.1.2-essentials_build', 'bin', 'ffmpeg.exe');
  }
  return path.join(root, 'tools', 'librespot', 'bin', 'librespot.exe');
}

class SpotifyRelayService extends EventEmitter {
  constructor({
    rootDir = path.resolve(__dirname, '..', '..'),
    ffmpegPath,
    librespotPath,
    cacheDir,
    host = process.env.SPOTIFY_RELAY_HOST || '0.0.0.0',
    port = Number(process.env.SPOTIFY_RELAY_PORT || 8001),
    streamHost = process.env.SPOTIFY_RELAY_PUBLIC_HOST || process.env.CHESS_AUDIO_SERVER_HOST || '',
    token = process.env.ESP32_AUDIO_TOKEN || '',
    deviceName = process.env.SPOTIFY_DEVICE_NAME || 'UoM Chessboard',
    idleMs = Number(process.env.SPOTIFY_IDLE_MS || DEFAULT_IDLE_MS),
    musicGainDb = Number(process.env.SPOTIFY_MUSIC_GAIN_DB ?? DEFAULT_MUSIC_GAIN_DB),
    spawnProcess = spawn,
    createServer = http.createServer,
    fileExists = fs.existsSync,
    logger = console,
    now = () => Date.now()
  } = {}) {
    super();
    this.rootDir = rootDir;
    this.ffmpegPath = ffmpegPath || process.env.FFMPEG_PATH || defaultToolPath(rootDir, 'ffmpeg');
    this.librespotPath = librespotPath || process.env.LIBRESPOT_PATH || defaultToolPath(rootDir, 'librespot');
    this.cacheDir = cacheDir || path.join(rootDir, 'tools', 'librespot', 'runtime', 'cache');
    this.host = host;
    this.port = port;
    this.streamHost = streamHost;
    this.token = String(token || '');
    this.deviceName = deviceName;
    this.idleMs = idleMs;
    this.musicGainDb = Math.max(0, Math.min(12, Number.isFinite(musicGainDb)
      ? musicGainDb
      : DEFAULT_MUSIC_GAIN_DB));
    this.spawnProcess = spawnProcess;
    this.fileExists = fileExists;
    this.logger = logger;
    this.now = now;
    this.enabled = false;
    this.spotifyActive = false;
    this.voiceActive = false;
    this.boardRelayReady = false;
    this.state = 'disabled';
    this.lastError = null;
    this.restartCount = 0;
    this.lastSpotifyAudioAt = 0;
    this.lastVoiceAudioAt = 0;
    this.librespot = null;
    this.ffmpeg = null;
    this.paceTimer = null;
    this.paceStartedAt = null;
    this.pacedFrames = 0;
    this.activityTimer = null;
    this.restartTimers = new Set();
    this.restartAttempts = { librespot: 0, ffmpeg: 0 };
    this.stopping = false;
    this.musicBlocked = false;
    this.voiceBlocked = false;
    this.musicQueue = new ByteQueue(MUSIC_FRAME_BYTES * 200);
    this.voiceQueue = new ByteQueue(VOICE_FRAME_BYTES * 2000);
    this.currentVoiceSession = null;
    this.clients = new Set();
    this.rollingChunks = [];
    this.rollingBytes = 0;
    this.maxRollingBytes = 18000;
    this.server = createServer((request, response) => this.handleHttp(request, response));
  }

  status() {
    const boardMode = this.enabled && this.spotifyActive && this.ffmpeg ? 'relay' : 'mentor';
    return {
      enabled: this.enabled,
      state: this.state,
      deviceName: this.deviceName,
      spotifyActive: this.spotifyActive,
      voiceActive: this.voiceActive,
      boardRelayReady: this.boardRelayReady,
      boardMode,
      clientCount: this.clients.size,
      restartCount: this.restartCount,
      lastError: this.lastError,
      streamUrl: this.streamUrl(),
      musicGainDb: this.musicGainDb,
      buffers: {
        musicBytes: this.musicQueue.length,
        voiceBytes: this.voiceQueue.length,
        rollingBytes: this.rollingBytes,
        musicDroppedBytes: this.musicQueue.droppedBytes,
        voiceDroppedBytes: this.voiceQueue.droppedBytes
      }
    };
  }

  streamUrl() {
    const host = this.streamHost || (this.host === '0.0.0.0' ? 'YOUR_SERVER_IP' : this.host);
    return `http://${host}:${this.port}/live.mp3`;
  }

  publish(forceState) {
    if (forceState) this.state = forceState;
    else if (!this.enabled) this.state = 'disabled';
    else if (this.lastError && (!this.ffmpeg || !this.librespot)) this.state = 'recovering';
    else if (this.voiceActive) this.state = 'ducking';
    else if (this.spotifyActive) this.state = 'playing';
    else this.state = 'ready';
    const status = this.status();
    this.emit('status', status);
    return status;
  }

  validateSetup() {
    if (!this.token) throw new Error('ESP32_AUDIO_TOKEN is required for the Spotify relay.');
    if (!this.fileExists(this.ffmpegPath)) throw new Error(`FFmpeg not found: ${this.ffmpegPath}`);
    if (!this.fileExists(this.librespotPath)) throw new Error(`librespot not found: ${this.librespotPath}`);
  }

  async enable() {
    if (this.enabled) return this.status();
    try {
      this.validateSetup();
    } catch (error) {
      this.lastError = error.message;
      this.publish('error');
      throw error;
    }
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.enabled = true;
    this.stopping = false;
    this.lastError = null;
    this.restartCount = 0;
    this.restartAttempts = { librespot: 0, ffmpeg: 0 };
    this.publish('starting');
    try {
      await this.listen();
      this.startFfmpeg();
      this.startLibrespot();
      this.startTimers();
      return this.publish();
    } catch (error) {
      await this.disable();
      this.lastError = error.message;
      this.publish('error');
      throw error;
    }
  }

  listen() {
    if (this.server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        this.logger.log?.(`[Spotify Relay] listening on ${this.streamUrl()}`);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
  }

  ffmpegArgs() {
    const musicGain = this.musicGainDb.toFixed(1);
    const filter = [
      '[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[voice_sc][voice_mix]',
      '[voice_mix]adelay=750|750[voice_delayed]',
      `[0:a]volume=${musicGain}dB[music_boosted]`,
      '[music_boosted][voice_sc]sidechaincompress=threshold=0.048:ratio=20:attack=600:release=1200:makeup=1[ducked]',
      '[ducked][voice_delayed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95,pan=mono|c0=0.5*c0+0.5*c1[out]'
    ].join(';');
    return [
      '-hide_banner', '-loglevel', 'warning',
      '-thread_queue_size', '1024', '-f', 's16le', '-ar', String(MUSIC_SAMPLE_RATE), '-ac', '2', '-i', 'pipe:0',
      '-thread_queue_size', '1024', '-f', 's16le', '-ar', String(VOICE_SAMPLE_RATE), '-ac', '1', '-i', 'pipe:3',
      '-filter_complex', filter, '-map', '[out]',
      '-codec:a', 'libmp3lame', '-b:a', '96k', '-ar', String(MUSIC_SAMPLE_RATE), '-ac', '1',
      '-write_xing', '0', '-f', 'mp3', 'pipe:1'
    ];
  }

  startFfmpeg() {
    if (!this.enabled || this.ffmpeg) return;
    const child = this.spawnProcess(this.ffmpegPath, this.ffmpegArgs(), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    });
    child.spotifyRelayStartedAt = this.now();
    this.ffmpeg = child;
    this.musicBlocked = false;
    this.voiceBlocked = false;
    child.stdin.on('drain', () => { this.musicBlocked = false; });
    child.stdio[3].on('drain', () => { this.voiceBlocked = false; });
    child.stdout.on('data', (chunk) => this.broadcast(chunk));
    child.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) this.logger.warn?.(`[Spotify Relay/FFmpeg] ${message}`);
    });
    child.on('error', (error) => this.childFailed('ffmpeg', child, error));
    child.on('close', (code, signal) => this.childClosed('ffmpeg', child, code, signal));
    if (this.librespot) this.lastError = null;
    this.publish();
  }

  startLibrespot() {
    if (!this.enabled || this.librespot) return;
    const args = [
      '--name', this.deviceName,
      '--backend', 'pipe',
      '--format', 'S16',
      '--bitrate', '160',
      '--initial-volume', '50',
      '--volume-ctrl', 'linear',
      '--enable-volume-normalisation',
      '--disable-audio-cache',
      '--cache', this.cacheDir,
      '--system-cache', this.cacheDir
    ];
    const child = this.spawnProcess(this.librespotPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.spotifyRelayStartedAt = this.now();
    this.librespot = child;
    child.stdout.on('data', (chunk) => {
      this.musicQueue.push(chunk);
      if (this.musicQueue.length >= MUSIC_FRAME_BYTES * 160) child.stdout.pause();
      if (hasAudiblePcm(chunk)) {
        this.restartAttempts.librespot = 0;
        this.lastSpotifyAudioAt = this.now();
        if (!this.spotifyActive) {
          this.spotifyActive = true;
          this.publish();
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) this.logger.log?.(`[Spotify Relay/librespot] ${message}`);
    });
    child.on('error', (error) => this.childFailed('librespot', child, error));
    child.on('close', (code, signal) => this.childClosed('librespot', child, code, signal));
    if (this.ffmpeg) this.lastError = null;
    this.publish();
  }

  childFailed(kind, child, error) {
    if (this[kind] !== child) return;
    this.lastError = `${kind}: ${error.message}`;
    this.publish('recovering');
  }

  childClosed(kind, child, code, signal) {
    if (this[kind] !== child) return;
    this[kind] = null;
    if (kind === 'ffmpeg') {
      this.closeClients();
      this.rollingChunks = [];
      this.rollingBytes = 0;
    } else {
      this.spotifyActive = false;
    }
    if (this.stopping || !this.enabled) return;
    this.lastError = `${kind} exited (${code ?? signal ?? 'unknown'})`;
    this.restartCount += 1;
    this.publish('recovering');
    if (this.now() - child.spotifyRelayStartedAt >= STABLE_PROCESS_MS) {
      this.restartAttempts[kind] = 0;
    }
    const attempt = this.restartAttempts[kind]++;
    const delay = RESTART_DELAYS_MS[Math.min(attempt, RESTART_DELAYS_MS.length - 1)];
    const timer = setTimeout(() => {
      this.restartTimers.delete(timer);
      if (kind === 'ffmpeg') this.startFfmpeg();
      else this.startLibrespot();
    }, delay);
    timer.unref?.();
    this.restartTimers.add(timer);
  }

  startTimers() {
    if (!this.paceTimer) {
      this.paceStartedAt = this.now();
      this.pacedFrames = 0;
      this.paceTimer = setInterval(() => this.pace(), FRAME_MS);
      this.paceTimer.unref?.();
    }
    if (!this.activityTimer) {
      this.activityTimer = setInterval(() => this.checkActivity(), 250);
      this.activityTimer.unref?.();
    }
  }

  pace() {
    if (!this.ffmpeg) return;
    const now = this.now();
    if (this.paceStartedAt === null) this.paceStartedAt = now;
    let targetFrames = Math.floor((now - this.paceStartedAt) / FRAME_MS);
    if (targetFrames - this.pacedFrames > PACE_RESET_AFTER_MS / FRAME_MS) {
      this.paceStartedAt = now;
      this.pacedFrames = 0;
      targetFrames = 1;
    }

    let sent = 0;
    while (this.pacedFrames < targetFrames && sent < MAX_PACE_CATCHUP_FRAMES) {
      if (this.musicBlocked || this.voiceBlocked
          || !this.ffmpeg.stdin?.writable || !this.ffmpeg.stdio[3]?.writable) break;
      this.musicBlocked = !this.ffmpeg.stdin.write(this.musicQueue.read(MUSIC_FRAME_BYTES));
      this.voiceBlocked = !this.ffmpeg.stdio[3].write(this.voiceQueue.read(VOICE_FRAME_BYTES));
      this.pacedFrames += 1;
      sent += 1;
    }
    if (this.librespot?.stdout?.isPaused?.() && this.musicQueue.length <= MUSIC_FRAME_BYTES * 80) {
      this.librespot.stdout.resume();
    }
    if (this.voiceActive && this.voiceQueue.length === 0
        && this.now() - this.lastVoiceAudioAt > 2000) {
      this.voiceActive = false;
      this.currentVoiceSession = null;
      this.publish();
    }
  }

  checkActivity() {
    if (this.spotifyActive && this.now() - this.lastSpotifyAudioAt >= this.idleMs) {
      this.spotifyActive = false;
      this.publish();
    }
  }

  canMixMentor() {
    return this.enabled && this.spotifyActive && this.boardRelayReady && Boolean(this.ffmpeg);
  }

  setBoardRelayReady(ready) {
    const next = Boolean(ready);
    if (this.boardRelayReady === next) return;
    this.boardRelayReady = next;
    if (!next) this.clearMentorPcm();
    this.publish();
  }

  routeMentorPcm({ sessionId, pcm, volume = 50, sampleRate = VOICE_SAMPLE_RATE }) {
    if (!this.canMixMentor() || sampleRate !== VOICE_SAMPLE_RATE) return false;
    if (this.currentVoiceSession && this.currentVoiceSession !== sessionId) this.voiceQueue.clear();
    this.currentVoiceSession = sessionId;
    this.voiceQueue.push(scalePcm16Le(pcm, volume));
    this.lastVoiceAudioAt = this.now();
    if (!this.voiceActive) {
      this.voiceActive = true;
      this.publish();
    }
    return true;
  }

  endMentorPcm(sessionId) {
    if (this.currentVoiceSession !== sessionId) return false;
    this.lastVoiceAudioAt = this.now();
    return true;
  }

  clearMentorPcm(sessionId) {
    if (sessionId && this.currentVoiceSession !== sessionId) return false;
    this.voiceQueue.clear();
    this.currentVoiceSession = null;
    this.voiceActive = false;
    this.publish();
    return true;
  }

  authorized(request) {
    const header = String(request.headers.authorization || '');
    if (!header.startsWith('Basic ')) return false;
    let decoded;
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      return false;
    }
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;
    return secureEqual(decoded.slice(0, separator), 'esp32')
      && secureEqual(decoded.slice(separator + 1), this.token);
  }

  handleHttp(request, response) {
    const pathname = new URL(request.url, 'http://relay.local').pathname;
    if (pathname === '/' || pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(this.status()));
      return;
    }
    if (pathname !== '/live.mp3') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found\n');
      return;
    }
    if (!this.authorized(request)) {
      response.writeHead(401, {
        'Content-Type': 'text/plain; charset=utf-8',
        'WWW-Authenticate': 'Basic realm="Chessboard audio"'
      });
      response.end('Unauthorized\n');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'close'
    });
    const client = { request, response, blocked: false };
    this.clients.add(client);
    if (this.rollingBytes > 0) {
      client.blocked = !response.write(Buffer.concat(this.rollingChunks, this.rollingBytes));
      if (client.blocked) response.once('drain', () => { client.blocked = false; });
    }
    const remove = () => {
      this.clients.delete(client);
      this.publish();
    };
    request.once('close', remove);
    response.once('close', remove);
    this.publish();
  }

  broadcast(chunk) {
    const copy = Buffer.from(chunk);
    this.rollingChunks.push(copy);
    this.rollingBytes += copy.length;
    while (this.rollingBytes > this.maxRollingBytes && this.rollingChunks.length > 1) {
      this.rollingBytes -= this.rollingChunks.shift().length;
    }
    for (const client of [...this.clients]) {
      if (client.response.destroyed || client.blocked) {
        client.response.destroy();
        continue;
      }
      client.blocked = !client.response.write(copy);
      if (client.blocked) client.response.once('drain', () => { client.blocked = false; });
    }
  }

  closeClients() {
    for (const client of this.clients) client.response.destroy();
    this.clients.clear();
  }

  terminate(child) {
    if (!child || child.killed) return;
    child.kill('SIGTERM');
  }

  async disable() {
    if (!this.enabled && !this.server.listening) {
      this.lastError = null;
      return this.publish('disabled');
    }
    this.stopping = true;
    this.enabled = false;
    for (const timer of this.restartTimers) clearTimeout(timer);
    this.restartTimers.clear();
    if (this.paceTimer) clearInterval(this.paceTimer);
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.paceTimer = null;
    this.paceStartedAt = null;
    this.pacedFrames = 0;
    this.activityTimer = null;
    this.closeClients();
    this.terminate(this.librespot);
    this.terminate(this.ffmpeg);
    this.librespot = null;
    this.ffmpeg = null;
    this.musicQueue.clear();
    this.voiceQueue.clear();
    this.rollingChunks = [];
    this.rollingBytes = 0;
    this.spotifyActive = false;
    this.voiceActive = false;
    this.boardRelayReady = false;
    this.currentVoiceSession = null;
    this.restartAttempts = { librespot: 0, ffmpeg: 0 };
    this.lastError = null;
    if (this.server.listening) {
      await new Promise((resolve) => this.server.close(resolve));
    }
    this.stopping = false;
    return this.publish('disabled');
  }

  async close() {
    return this.disable();
  }
}

module.exports = {
  ByteQueue,
  DEFAULT_IDLE_MS,
  DEFAULT_MUSIC_GAIN_DB,
  FRAME_MS,
  MUSIC_FRAME_BYTES,
  SpotifyRelayService,
  VOICE_FRAME_BYTES,
  hasAudiblePcm,
  scalePcm16Le
};
