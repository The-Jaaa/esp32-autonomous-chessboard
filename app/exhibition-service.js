const { randomUUID } = require('crypto');

const PATTERNS = ['auto', 'wave', 'chessboard', 'sweep', 'breathing', 'music'];
class ExhibitionService {
  constructor({ board, emit, now = Date.now }) {
    this.board = board;
    this.emit = emit;
    this.now = now;
    this.desired = { serverInstanceId: randomUUID(), revision: 0, enabled: false,
      pattern: 'auto', brightnessPercent: 100, speed: 'normal' };
    this.runtime = null;
    this.updatedAt = 0;
  }
  fail(message, code = 'exhibition_conflict', statusCode = 409) {
    throw Object.assign(new Error(message), { code, statusCode });
  }
  fresh() { return Boolean(this.runtime && this.now() - this.updatedAt < 5000); }
  idle() { return this.fresh() && this.runtime.motionBusy === false
    && this.runtime.motionPending === false && this.runtime.magnetOn === false; }
  status() {
    const connected = this.fresh();
    const applied = connected && this.runtime.exhibitionServerInstanceId === this.desired.serverInstanceId
      && this.runtime.exhibitionRevision === this.desired.revision
      && this.runtime.exhibitionEnabled === this.desired.enabled;
    return { desired: { ...this.desired }, reported: this.runtime, connected,
      recoveryActive: Boolean(this.recoveryActive?.()),
      supported: this.runtime?.exhibitionSupported === true,
      spectrumSupported: connected && this.runtime?.musicSpectrumSupported === true,
      state: !connected ? 'disconnected' : !this.runtime.exhibitionSupported ? 'unsupported'
        : applied ? (this.desired.enabled ? 'running' : 'off') : this.desired.enabled ? 'starting' : 'stopping' };
  }
  report(runtime) {
    if (!runtime || typeof runtime !== 'object') return;
    const before = JSON.stringify(this.status());
    this.runtime = { spectrumFrames: runtime.spectrumFrames,
      spectrumDroppedWindows: runtime.spectrumDroppedWindows, spectrumMaxAnalysisUs: runtime.spectrumMaxAnalysisUs,
      spectrumLevels: runtime.spectrumLevels, musicSpectrumSupported: runtime.musicSpectrumSupported === true, exhibitionSupported: runtime.exhibitionSupported === true,
      concurrentSpectrumSupported: runtime.concurrentSpectrumSupported === true,
      controlledTakeoverSupported: runtime.controlledTakeoverSupported === true,
      acknowledgedHomingSupported: runtime.acknowledgedHomingSupported === true,
      placementRecoverySupported: runtime.placementRecoverySupported === true, homingFault: runtime.homingFault === true,
      autonomousRunId: runtime.autonomousRunId, takeoverRequested: runtime.takeoverRequested,
      autonomousInterference: runtime.autonomousInterference,
      motionBusy: runtime.motionBusy, motionPending: runtime.motionPending, magnetOn: runtime.magnetOn,
      exhibitionEnabled: runtime.exhibitionEnabled,
      exhibitionRevision: runtime.exhibitionRevision,
      exhibitionServerInstanceId: runtime.exhibitionServerInstanceId };
    this.updatedAt = this.now();
    if (JSON.stringify(this.status()) !== before) this.publish();
  }
  publish() { this.emit(this.status()); }
  change(body) {
    if (typeof body.enabled !== 'boolean') this.fail('enabled must be a boolean.', 'invalid_exhibition_settings', 400);
    const next = { ...this.desired, ...body };
    if (!PATTERNS.includes(next.pattern) || !['slow', 'normal', 'fast'].includes(next.speed)
      || !Number.isInteger(next.brightnessPercent) || next.brightnessPercent < 10 || next.brightnessPercent > 100) {
      this.fail('Choose a valid pattern, speed, and brightness from 10 to 100.', 'invalid_exhibition_settings', 400);
    }
    const board = this.board();
    if (next.enabled) {
      if (next.pattern === 'music' && (!this.fresh() || !this.runtime.musicSpectrumSupported))
        this.fail('Update the board firmware to use Spectrum.', 'music_unsupported');
      if (board.active) this.fail('End the physical game before starting the light show.');
      if (this.fresh() && !this.runtime.exhibitionSupported) this.fail('Update the board firmware to use the light show.', 'exhibition_unsupported');
      if (!this.concurrentAllowed?.() && (board.pending || !this.idle())) this.fail('Wait for a connected, idle board with the magnet off.');
    }
    const changed = ['enabled', 'pattern', 'speed', 'brightnessPercent'].some(key => next[key] !== this.desired[key]);
    if (changed) {
      for (const key of ['enabled', 'pattern', 'speed', 'brightnessPercent']) this.desired[key] = next[key];
      this.desired.revision++;
      this.publish();
    }
    return this.status();
  }
  stop() { return this.change({ enabled: false }); }
  ownsBoard() { return this.desired.enabled || this.runtime?.exhibitionEnabled === true; }
}
module.exports = { ExhibitionService };
