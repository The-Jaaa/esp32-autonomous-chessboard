const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { SpotifyRelayService } = require('../audio/spotify-relay-service');

const SAMPLE_RATE = 44100;
const VOICE_RATE = 24000;
const DURATION_SECONDS = 7;

function sinePcm({ sampleRate, channels, frequency, amplitude, activeFrom = 0, activeTo = DURATION_SECONDS }) {
  const frames = sampleRate * DURATION_SECONDS;
  const pcm = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / sampleRate;
    const sample = time >= activeFrom && time < activeTo
      ? Math.round(Math.sin(time * frequency * Math.PI * 2) * amplitude * 32767)
      : 0;
    for (let channel = 0; channel < channels; channel += 1) {
      pcm.writeInt16LE(sample, (frame * channels + channel) * 2);
    }
  }
  return pcm;
}

function runProcess(command, args, inputs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', ...(inputs.length > 1 ? ['pipe'] : [])]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${path.basename(command)} exited ${code}: ${Buffer.concat(stderr).toString()}`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() });
    });
    child.stdin.end(inputs[0]);
    if (inputs[1]) child.stdio[3].end(inputs[1]);
  });
}

function rms(pcm, fromSeconds, toSeconds) {
  const first = Math.floor(fromSeconds * SAMPLE_RATE);
  const last = Math.min(Math.floor(toSeconds * SAMPLE_RATE), pcm.length / 2);
  let sum = 0;
  for (let index = first; index < last; index += 1) {
    const sample = pcm.readInt16LE(index * 2) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / Math.max(1, last - first));
}

function toDb(ratio) {
  return 20 * Math.log10(Math.max(ratio, Number.EPSILON));
}

async function run() {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const ffmpeg = path.join(
    projectRoot,
    'tools', 'ffmpeg', 'extract', 'ffmpeg-8.1.2-essentials_build', 'bin', 'ffmpeg.exe'
  );
  const ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe.exe');
  const service = new SpotifyRelayService({ rootDir: projectRoot, token: 'test' });
  const music = sinePcm({ sampleRate: SAMPLE_RATE, channels: 2, frequency: 440, amplitude: 0.55 });
  const voice = sinePcm({
    sampleRate: VOICE_RATE,
    channels: 1,
    frequency: 1000,
    amplitude: 0.8,
    activeFrom: 2,
    activeTo: 3
  });

  const encoded = (await runProcess(ffmpeg, service.ffmpegArgs(), [music, voice])).stdout;
  assert(encoded.length > 70000, 'Mixer did not produce a sustained MP3 stream.');

  const probe = await runProcess(ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels',
    '-of', 'json', 'pipe:0'
  ], [encoded]);
  const stream = JSON.parse(probe.stdout.toString()).streams[0];
  assert.strictEqual(stream.codec_name, 'mp3');
  assert.strictEqual(Number(stream.sample_rate), SAMPLE_RATE);
  assert.strictEqual(Number(stream.channels), 1);

  const decoded = (await runProcess(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-f', 's16le', '-codec:a', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '1', 'pipe:1'
  ], [encoded])).stdout;
  const baseline = rms(decoded, 1.0, 1.6);
  const ducked = rms(decoded, 2.55, 2.7);
  const recovered = rms(decoded, 5.5, 6.1);
  const duckDb = toDb(ducked / baseline);
  const recoveryDb = toDb(recovered / baseline);
  assert(duckDb <= -14 && duckDb >= -24, `Expected about 18 dB ducking, measured ${duckDb.toFixed(1)} dB.`);
  assert(Math.abs(recoveryDb) <= 1.5, `Music did not recover to baseline: ${recoveryDb.toFixed(1)} dB.`);

  console.log(
    `Spotify mixer regression passed: 44.1 kHz mono MP3, duck=${duckDb.toFixed(1)} dB, recovery=${recoveryDb.toFixed(1)} dB.`
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
