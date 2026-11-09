const { randomUUID } = require('crypto');
const { SCRIPT, clone } = require('./script');
const same = (a, b) => Array.isArray(a) && a.length === 64 && a.every((v, i) => Boolean(v) === Boolean(b[i]));

class AutonomousService {
  constructor({ compile, enqueue, runtime, available, emit, now = Date.now }) {
    Object.assign(this, { compile, enqueue, runtime, available, emit, now });
    this.state = 'available'; this.runId = null; this.revision = 0; this.cycle = 0;
    this.pending = null; this.completed = new Set(); this.occupancy = null; this.lastSnapshotAt = 0;
    this.message = 'Arrange the starting pieces and confirm the graveyard is empty.';
    this.takeover = false; this.lifted = new Set(); this.interference = false;
  }
  ownsBoard() { return !['available', 'manual_ready'].includes(this.state); }
  status() {
    const operation = this.pending?.operation;
    return { runId: this.runId, revision: this.revision, state: this.state, cycle: this.cycle,
      message: this.message, direction: this.direction || null, paused: this.state === 'paused',
      script: { id: SCRIPT.id, title: SCRIPT.title, plies: SCRIPT.moves.length },
      step: this.cursor || 0, totalSteps: this.compiled?.operations.length || 0,
      waitingForSync: Boolean(this.waitingForSync),
      pendingCommandId: this.pending?.id || null, takeoverRequested: this.takeover,
      resetGuidance: Boolean(this.resetGuidance), recovery: this.recovery ? clone(this.recovery) : null,
      protectedSquares: operation?.protectedSquares || [],
      current: operation ? { ply: operation.ply, san: operation.san, from: this.direction === 'restore' ? operation.to : operation.from,
        to: this.direction === 'restore' ? operation.from : operation.to } : null,
      tokens: this.tokens || [], fen: this.fen || null,
      history: SCRIPT.moves.slice(0, SCRIPT.moves.findIndex(m => m.before === this.fen) < 0 ? (this.fen === SCRIPT.moves.at(-1).after ? SCRIPT.moves.length : 0) : SCRIPT.moves.findIndex(m => m.before === this.fen)).map(m => m.san),
      expectedOccupancy: this.expected || null };
  }
  publish(message) { if (message) this.message = message; this.revision++; this.emit(this.status()); }
  fail(message) { throw Object.assign(new Error(message), { statusCode: 409, code: 'autonomous_conflict' }); }
  start({ confirmedStartingPieces, confirmedEmptyGraveyard } = {}) {
    if (this.ownsBoard() || !this.available()) this.fail('End the current board activity first.');
    if (confirmedStartingPieces !== true || confirmedEmptyGraveyard !== true) this.fail('Confirm correct starting pieces and an empty graveyard.');
    const r = this.runtime();
    if (!r.fresh || !r.concurrentSpectrumSupported || !r.controlledTakeoverSupported || !r.acknowledgedHomingSupported || !r.placementRecoverySupported
      || r.motionBusy !== false || r.motionPending !== false || r.magnetOn !== false) this.fail('Connected, idle, updated firmware is required.');
    const compiled = this.compile();
    const expected = this.boardFromTokens(compiled.initial);
    if (this.now() - this.lastSnapshotAt >= 5000 || !same(this.occupancy, expected)) this.fail('Arrange all pieces in their normal starting squares.');
    this.resetGuidance = false; this.recovery = null; this.reconciliation = null; this.lastTransfer=null;
    this.compiled = compiled; this.tokens = clone(compiled.initial); this.expected = expected;
    this.runId = randomUUID(); this.completed.clear(); this.cycle = 1; this.cursor = 0;
    this.direction = 'play'; this.pauseRequested = false; this.exitRequested = false;
    this.takeover = false; this.interference = false; this.lifted.clear(); this.sawFirmwareRun = false;
    this.fen = SCRIPT.moves[0].before;
    this.home('starting'); return this.status();
  }
  boardFromTokens(tokens) { return this._occupancy(tokens); }
  setOccupancyMapper(fn, squareName = String) { this._occupancy = fn; this.squareName = squareName; }
  home(reason) {
    this.state = reason === 'starting' ? 'homing' : 'takeover_homing';
    const id = `${this.runId}:home:${reason}`;
    this.pending = { id, home: reason };
    this.enqueue({ id, type: 'home', autonomous: { runId: this.runId, revision: this.revision + 1, restoring: false } });
    this.publish(reason === 'starting' ? 'Homing before playback.' : 'Magnet off; homing before manual reset. Wait for Manual reset ready.');
  }
  control({ action, runId, expectedRevision, confirmedPiecesPlaced, recoveryId } = {}) {
    if (runId !== this.runId || expectedRevision !== this.revision) this.fail('The autonomous run changed. Refresh the controls.');
    if (action === 'prepare-manual-reset' && ['recovery', 'available', 'manual_ready'].includes(this.state)) {
      const r = this.runtime();
      if (confirmedPiecesPlaced !== true || !this.available() || !r.fresh || !r.acknowledgedHomingSupported
        || r.motionBusy !== false || r.motionPending !== false || r.magnetOn !== false
        || this.now() - this.lastSnapshotAt >= 5000 || !Array.isArray(this.occupancy)) {
        this.fail('Confirm every piece is resting on the board or in storage and the gantry is clear; connected idle firmware with the magnet off is required.');
      }
      // Explicitly abandon the uncertain transfer, never commit or replay it.
      this.runId = randomUUID(); this.completed.clear(); this.pending = null;
      this.recovery=null; this.reconciliation=null; this.expected = this.occupancy.slice(); this.resetGuidance = true;
      this.takeover = false; this.interference = false; this.waitingForSync = false;
      this.sawFirmwareRun = false; this.home('takeover');
      return this.status();
    }
    if (action === 'confirm-recovery-placement') {
      const r=this.recovery;
      if (!r || r.id!==recoveryId || !r.requiresConfirmation || r.confirmed || r.stage!=='confirmation' || !r.correctionReady || !this.recoveryIdle() || r.missing.length || r.extra.length) this.fail('Storage confirmation is stale or the board is not ready.');
      r.confirmed=true; this.publish('Storage placement confirmed.'); return this.status();
    }
    if (!this.ownsBoard()) this.fail('No autonomous run is active.');
    if (action === 'confirm-manual-reset' && this.state === 'recovery') {
      const r = this.runtime();
      if (!r.fresh || r.motionBusy !== false || r.motionPending !== false || r.magnetOn !== false
        || !same(this.occupancy, this._occupancy(this.compiled.initial))) this.fail('Wait for idle firmware and restore the complete starting arrangement.');
      this.recovery=null; this.reconciliation=null; this.pending = null; this.state = 'available'; this.takeover = false;
      this.tokens = clone(this.compiled.initial); this.expected = this._occupancy(this.tokens); this.cursor = 0; this.fen = SCRIPT.moves[0].before;
      this.publish('Manual reset confirmed. Available; confirm correct pieces and cleared storage before starting again.');
      return this.status();
    }
    if (action === 'pause' && ['playing', 'restoring', 'recovery'].includes(this.state)) this.pauseRequested = true;
    else if (action === 'resume' && this.state === 'paused') {
      if (this.pending || !this.ready()) this.fail('Restore the indicated board and reconnect before resuming.');
      this.pauseRequested = false; this.state = this.direction === 'restore' ? 'restoring' : 'playing';
    } else if (action === 'restore-and-exit' && !['homing', 'takeover_homing'].includes(this.state)) {
      this.exitRequested = true; this.pauseRequested = false;
    } else if (action === 'manual-takeover' && !['homing', 'takeover_homing'].includes(this.state)) {
      this.takeover = true; this.pauseRequested = false;
    } else this.fail('This control is unavailable at the current boundary.');
    this.publish();
    if (!this.pending) this.advance();
    return this.status();
  }
  ready() { const r = this.runtime(); return r.fresh && r.motionBusy === false && r.motionPending === false
    && r.magnetOn === false && this.now() - this.lastSnapshotAt < 5000 && same(this.occupancy, this.expected); }
  snapshot(occupancy, runtime = {}, metadata = {}) {
    if(Number.isInteger(metadata.seq)) {
      if(this.lastSensorRun===runtime.autonomousRunId && metadata.seq<=this.lastSensorSequence
        && (this.ownsBoard() || this.now()-this.lastSnapshotAt<5000))return;
      this.lastSensorRun=runtime.autonomousRunId;this.lastSensorSequence=metadata.seq;
    }
    this.occupancy = occupancy.slice(); this.lastSnapshotAt = this.now();
    if (!this.ownsBoard()) return;
    if (runtime.autonomousRunId === this.runId) this.sawFirmwareRun = true;
    else if (this.sawFirmwareRun && typeof runtime.autonomousRunId === 'string' && !['homing', 'takeover_homing'].includes(this.state)) {
      if(this.recovery){this.recovery.recoverable=false;this.recovery.message='Firmware changed runs. Manual reconciliation required.';}
      this.hold('Firmware restarted or changed runs. Manually reconcile the board before starting again.');
      return;
    }
    if (runtime.autonomousRunId === this.runId && runtime.autonomousInterference && this.state !== 'takeover_homing') this.interference = true;
    if (this.direction === 'restore' && this.state !== 'takeover_homing') {
      const protectedSet = new Set(this.recovery?.protectedSquares || this.pending?.operation?.protectedSquares || this.lastTransfer?.operation?.protectedSquares || []);
      const reference = this.expected;
      for (let i = 0; i < 64; i++) {
        if (protectedSet.has(i)) continue;
        if (reference[i] && !occupancy[i]) { this.takeover = true; this.lifted.add(i); }
        if (!reference[i] && occupancy[i]) this.interference = true;
      }
      if (runtime.autonomousRunId === this.runId && runtime.takeoverRequested) this.takeover = true;
    }
    if(this.recovery) { this.refreshRecovery(); return; }
    if (!this.pending && (['playing', 'restoring'].includes(this.state) || (this.takeover && this.state === 'paused'))) this.advance();
  }
  hold(message) {
    if(this.recovery) {
      const changed=this.message!==message || this.recovery.recoverable;
      Object.assign(this.recovery,{recoverable:false,correctionReady:false,stage:'blocked',message,stableSince:null,samples:0,resumeAt:null});
      if(changed)this.publish(message);
      return;
    }
    this.beginRecovery(message);
  }
  advance() {
    if (this.pending || !this.ownsBoard() || ['homing', 'takeover_homing', 'recovery'].includes(this.state)) return;
    if (this.interference) {
      if(this.lastTransfer && this.recoveryIdle()) return this.beginRecovery('Board displaced after verified transfer.',true,'displacement');
      return this.hold('Unexpected piece placement. Movement held; inspect the board before manual reconciliation.');
    }
    if (this.takeover) {
      const missing = this.expected.map((v, i) => v && !this.occupancy[i] ? i : -1).filter(i => i >= 0);
      const extra = this.occupancy.some((v, i) => v && !this.expected[i]);
      const r = this.runtime();
      if (extra || missing.some(i => !this.lifted.has(i))) return this.hold('Takeover placement is uncertain; inspect the board.');
      if (!r.fresh || r.motionBusy || r.motionPending || r.magnetOn) {
        if (!this.waitingForSync) { this.waitingForSync = true; this.publish('Waiting for idle firmware before takeover homing.'); }
        return;
      }
      this.waitingForSync = false;
      return this.home('takeover');
    }
    if (this.pauseRequested) { this.state = 'paused'; return this.publish('Paused at a verified transfer boundary.'); }
    if (!this.ready()) {
      if(this.recoveryIdle() && this.expected && !same(this.occupancy,this.expected)) return this.beginRecovery('Board displaced after verified transfer.',true,'displacement');
      if (!this.waitingForSync) { this.waitingForSync = true; this.publish('Waiting for a fresh matching board and idle firmware. Restore displaced pieces before continuing.'); }
      return;
    }
    this.waitingForSync = false;
    if (this.exitRequested && this.direction === 'play') { this.direction = 'restore'; }
    if (this.direction === 'play' && this.cursor === this.compiled.operations.length) this.direction = 'restore';
    if (this.direction === 'restore' && this.cursor === 0) {
      if (JSON.stringify(this.tokens) !== JSON.stringify(this.compiled.initial)) return this.hold('Restoration identity ledger did not return to its initial state.');
      if (this.exitRequested) { this.state = 'available'; return this.publish('Board restored. Available for another activity.'); }
      this.direction = 'play'; this.cycle++; this.fen = SCRIPT.moves[0].before;
    }
    const index = this.direction === 'play' ? this.cursor : this.cursor - 1;
    const operation = this.compiled.operations[index];
    const id = `${this.runId}:${this.cycle}:${this.direction}:${index}`;
    this.pending = { id, operation, index, direction: this.direction };
    this.state = this.direction === 'play' ? 'playing' : 'restoring';
    const plan = clone(this.direction === 'play' ? operation.plan : operation.reversePlan);
    this.enqueue({ id, type: 'move', plan, autonomous: { runId: this.runId, revision: this.revision + 1,
      restoring: this.direction === 'restore', protectedSquares: operation.protectedSquares, expectedOccupancy: this.expected } });
    this.publish(`${this.direction === 'play' ? 'Playing' : 'Restoring'} ${operation.san}: ${operation.pieceId} ${this.direction === 'play' ? operation.from : operation.to} → ${this.direction === 'play' ? operation.to : operation.from}`);
  }
  result(body, occupancy) {
    if(this.reconciliation?.id===body.id)return this.reconcileResult(body,occupancy);
    if (this.completed.has(body.id)) return { success: true, alreadyCompleted: true };
    if (!this.pending || body.id !== this.pending.id) this.fail('Stale or out-of-order autonomous command result.');
    const pending = this.pending;
    if(this.recovery?.commandId===body.id)return {success:true,alreadyReported:true};
    if (body.success !== true || body.magnetOn === true) {
      if(Array.isArray(occupancy)){this.occupancy=occupancy.slice();this.lastSnapshotAt=this.now();}
      const placement=pending.operation && body.magnetOn===false && /Drop verification|source square|target square/.test(body.error || '');
      this.beginRecovery(body.error || 'Movement failed.',true,placement?'placement':'blocking'); return {success:false}; }
    if (!Array.isArray(occupancy)) { this.hold('Movement result omitted board occupancy.'); return { success: false }; }
    this.occupancy = occupancy.slice(); this.lastSnapshotAt = this.now();
    if (pending.home) {
      if (pending.home === 'starting' && !same(occupancy, this.expected)) { this.hold('Starting arrangement changed during homing.'); return { success: false }; }
      this.completed.add(body.id); this.pending = null;
      if (pending.home === 'takeover') { this.state = 'manual_ready'; this.publish('Manual reset ready. Restore the remaining pieces and clear the graveyard. The board will stay available.'); }
      else { this.state = 'playing'; this.publish(); }
      return { success: true };
    }
    const op = pending.operation;
    if (pending.direction === 'restore') {
      const protectedSet = new Set(op.protectedSquares);
      if (body.takeoverRequested) this.takeover = true;
      if (body.autonomousInterference) this.interference = true;
      for (let i = 0; i < 64; i++) {
        if (protectedSet.has(i)) continue;
        if (this.expected[i] && !occupancy[i]) { this.takeover = true; this.lifted.add(i); }
        if (!this.expected[i] && occupancy[i]) this.interference = true;
      }
    }
    const expected = pending.direction === 'play' ? op.after : op.before;
    const acceptable = occupancy.every((v, i) => Boolean(v) === expected[i]
      || (this.takeover && this.lifted.has(i) && expected[i] && !v));
    if (!acceptable || this.interference) { this.beginRecovery('Transfer result does not match the expected position.',true,'placement'); return { success: false }; }
    this.commitTransfer(pending); this.publish();
    return { success: true };
  }
}
Object.assign(AutonomousService.prototype, require('./recovery'));
module.exports = { AutonomousService, same };
