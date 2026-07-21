const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  MentorSpeakerService,
  SPEAKER_BYTES_PER_SECOND,
  SPEAKER_SAMPLE_RATE
} = require('../mentor/speaker-service');

const FRAME_MS = 40;
const FRAME_SAMPLES = Math.floor(SPEAKER_SAMPLE_RATE * FRAME_MS / 1000);

function toneFrame(frequency, phase, amplitude = 6000) {
  const pcm = Buffer.alloc(FRAME_SAMPLES * 2);
  const phaseStep = (Math.PI * 2 * frequency) / SPEAKER_SAMPLE_RATE;
  let nextPhase = phase;
  for (let index = 0; index < FRAME_SAMPLES; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin(nextPhase) * amplitude), index * 2);
    nextPhase += phaseStep;
    if (nextPhase >= Math.PI * 2) nextPhase -= Math.PI * 2;
  }
  return { pcm, phase: nextPhase };
}

function silenceFrame() {
  return Buffer.alloc(FRAME_SAMPLES * 2);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForBoard(service, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (service.listDevices().some((device) => device.id === 'main-board')) return;
    await delay(100);
  }
  throw new Error('main-board did not connect within 20 seconds.');
}

function buildAudio(frameCount, createFrame) {
  const frames = [];
  let phase = 0;
  for (let index = 0; index < frameCount; index += 1) {
    const generated = createFrame(phase);
    const pcm = Buffer.isBuffer(generated) ? generated : generated.pcm;
    if (!Buffer.isBuffer(generated)) phase = generated.phase;
    frames.push(pcm);
  }
  return Buffer.concat(frames);
}

function routeAudio(service, binding, pcm) {
  const routed = service.routeAudio({
    conversationId: binding.conversationId,
    sessionId: binding.sessionId,
    pcm,
    sampleRate: SPEAKER_SAMPLE_RATE
  });
  if (routed.destination !== 'board') {
    throw new Error(`Tone routing failed: ${routed.reason || routed.destination}`);
  }
}

async function main() {
  if (!process.env.ESP32_AUDIO_TOKEN) {
    throw new Error('ESP32_AUDIO_TOKEN is missing from app/.env.');
  }

  let terminalStatus = null;
  const service = new MentorSpeakerService({
    token: process.env.ESP32_AUDIO_TOKEN,
    maxQueueBytes: SPEAKER_BYTES_PER_SECOND * 10
  });
  service.on('status', (status) => {
    console.log(`[TONE_TEST] status=${status.status} buffered=${status.bufferedMs ?? 'n/a'}`);
    if (status.status === 'ended' || status.status === 'underrun') terminalStatus = status.status;
  });
  service.on('telemetry', (telemetry) => {
    if (telemetry.type !== 'playing') return;
    console.log(
      `[TONE_TEST] dmaBytesPerSecond=${telemetry.i2sBytesPerSecond ?? 'n/a'} `
      + `timeoutsPerSecond=${telemetry.i2sTimeoutsPerSecond ?? 'n/a'}`
    );
  });
  service.listen(3001);

  try {
    console.log('[TONE_TEST] Waiting for main-board...');
    await waitForBoard(service);
    console.log('[TONE_TEST] Board connected. Playing 440 Hz, silence, then 880 Hz.');
    const binding = {
      conversationId: 'speaker-tone-test',
      sessionId: `speaker-tone-${Date.now()}`
    };
    service.bindSession({
      ...binding,
      outputMode: 'board',
      deviceId: 'main-board',
      volume: 60
    });
    routeAudio(service, binding, Buffer.concat([
      buildAudio(50, (phase) => toneFrame(440, phase)),
      buildAudio(13, silenceFrame),
      buildAudio(50, (phase) => toneFrame(880, phase))
    ]));
    service.endSpeech(binding.conversationId, binding.sessionId);
    const deadline = Date.now() + 15000;
    while (!terminalStatus && Date.now() < deadline) await delay(50);
    if (terminalStatus !== 'ended') {
      throw new Error(`Expected clean ended telemetry, received ${terminalStatus || 'timeout'}.`);
    }
    console.log('[TONE_TEST] Complete.');
  } finally {
    await service.close();
  }
}

main().catch((error) => {
  console.error(`[TONE_TEST] Failed: ${error.message}`);
  process.exitCode = 1;
});
