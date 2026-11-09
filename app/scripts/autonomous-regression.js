process.env.PHYSICAL_LOG_DISABLE = '1';
process.env.MENTOR_FAKE_TEXT = '1';
process.env.MENTOR_FAKE_LIVE = '1';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-autonomous-'));
process.env.MENTOR_DB_PATH = path.join(temp, 'test.sqlite');
const server = require('../server');
const { compileScript, clone, SCRIPT } = require('../exhibition/script');
const { createAutonomousPlanner } = require('../exhibition/planner');
const { AutonomousService } = require('../exhibition/autonomous-service');
const p = server.autonomousPlannerHelpers;
const adapter = createAutonomousPlanner(p);
const compiled = compileScript(adapter, p.normalizeGraveyardSlots(p.DEFAULT_GRAVEYARD_SLOTS));
const idle = { fresh: true, motionBusy: false, motionPending: false, magnetOn: false,
  concurrentSpectrumSupported: true, controlledTakeoverSupported: true, placementRecoverySupported: true, acknowledgedHomingSupported: true };

function harness() {
  let time = 10000;
  const queue = [], runtime = { ...idle };
  const c = new AutonomousService({ compile: () => compiled, enqueue: command => queue.push(command),
    runtime: () => runtime, available: () => true, emit: () => {}, now: () => time });
  c.setOccupancyMapper(adapter.occupancy);
  const snap = occupancy => { time += 10; c.snapshot(occupancy, runtime); };
  const start = () => { snap(adapter.occupancy(compiled.initial)); c.start({ confirmedStartingPieces: true, confirmedEmptyGraveyard: true }); };
  const finish = (actual) => {
    const job = queue.shift(); assert.ok(job);
    const pending = c.pending;
    const expected = actual || (pending.home ? c.expected : pending.direction === 'play' ? pending.operation.after : pending.operation.before);
    c.result({ id: job.id, success: true, magnetOn: false }, expected);
    snap(expected);
    return job;
  };
  const control = action => c.control({ action, runId: c.runId, expectedRevision: c.revision });
  return { c, queue, runtime, snap, start, finish, control, advanceTime: n => { time += n; } };
}
async function main() {
  assert.equal(SCRIPT.moves.length, 83);
  assert.equal(compiled.maxStorage, 15);
  assert.ok(compiled.final.some(t => t.representedPawn));
  assert.equal(compiled.initial.length, 32);
  assert.equal(new Set(compiled.initial.map(t => t.id)).size, 32);
  const firstKnight = compiled.operations.find(op => op.from === 'g1' && op.to === 'f3');
  const originalKnight = p.withPhysicalPlanningContext(SCRIPT.moves[2].before,
    p.normalizeGraveyardSlots(p.DEFAULT_GRAVEYARD_SLOTS), () => p.buildRobotMoveCommand(SCRIPT.moves[2]));
  const start = originalKnight.plan.findIndex(s => s.action === 'travel' && s.to.square === 'g1');
  const end = originalKnight.plan.findIndex((s, i) => i > start && s.action === 'drop');
  assert.deepEqual(firstKnight.plan.filter(s => s.action === 'drag').map(s => s.to),
    originalKnight.plan.slice(start, end).filter(s => s.action === 'drag').map(s => s.to),
    'Autonomous motion must preserve the existing shared planner route.');
  // Every reverse transfer follows precisely the recorded route backwards and
  // restores that physical piece's identity, not merely its occupied square.
  let tokens = clone(compiled.final);
  for (const op of [...compiled.operations].reverse()) {
    assert.deepEqual(tokens, op.tokensAfter);
    const piece = tokens.find(t => t.id === op.pieceId);
    assert.equal(piece.location, op.to);
    const travel = op.reversePlan.find(s => s.action === 'travel').to;
    const end = op.reversePlan.filter(s => s.action === 'drag').at(-1).to;
    assert.equal(adapter.location(travel), op.to);
    assert.equal(adapter.location(end), op.from);
    for (const plan of [op.plan, op.reversePlan]) {
      const target = plan.filter(s => s.action === 'drag').at(-1).to;
      assert.equal(plan.find(s => s.action === 'drop').nudgeTargetIndex, Number.isInteger(target.index) ? target.index : null);
      assert.equal(plan.at(-2).action, 'drop', 'Do not insert extra travel after the original drop.');
    }
    tokens = clone(op.tokensBefore);
  }
  assert.deepEqual(tokens, compiled.initial);
  {
    const h = harness(); h.start(); h.finish();
    for (let i = 0; i < compiled.operations.length * 6; i++) h.finish();
    assert.equal(h.c.cycle, 4, 'Three complete play/restore cycles must repeat automatically.');
    assert.deepEqual(h.c.tokens, compiled.initial);
  }
  {
    const h = harness(); h.start();
    const id = h.c.pending.id;
    assert.throws(() => h.c.result({ id: 'wrong', success: true }, h.c.expected));
    h.finish(); const count = h.queue.length;
    assert.equal(h.c.result({ id, success: true }, h.c.expected).alreadyCompleted, true);
    assert.equal(h.queue.length, count);
    assert.throws(() => h.c.control({ action: 'pause', runId: h.c.runId, expectedRevision: -1 }));
    h.control('pause'); h.finish();
    assert.equal(h.c.state, 'paused'); assert.equal(h.queue.length, 0);
    h.runtime.fresh = false; assert.throws(() => h.control('resume'));
    h.runtime.fresh = true; h.control('resume'); assert.ok(h.c.pending);
    h.control('restore-and-exit'); h.finish();
    while (h.c.ownsBoard()) h.finish();
    assert.equal(h.c.state, 'available'); assert.deepEqual(h.c.tokens, compiled.initial);
  }
  // Test a takeover at every reverse transfer, covering clearances, captures,
  // castling and all three promotion-exchange transfers.
  let takeovers = 0;
  for (let index = 0; index < compiled.operations.length; index++) {
    const h = harness(); h.start(); h.finish();
    while (h.c.direction !== 'restore') h.finish();
    while (h.c.pending.index > index) h.finish();
    const op = h.c.pending.operation;
    const candidate = h.c.expected.findIndex((occupied, i) => occupied && !op.protectedSquares.includes(i));
    if (candidate < 0) continue;
    const lifted = h.c.expected.slice(); lifted[candidate] = false;
    h.snap(lifted);
    assert.equal(h.c.takeover, true);
    const after = op.before.slice(); after[candidate] = false;
    h.finish(after);
    assert.equal(h.c.state, 'takeover_homing');
    assert.equal(h.queue.length, 1);
    assert.equal(h.queue[0].type, 'home');
    h.finish(after);
    assert.equal(h.c.state, 'manual_ready');
    assert.equal(h.queue.length, 0);
    h.snap(adapter.occupancy(compiled.initial));
    assert.equal(h.queue.length, 0, 'Manual reset must never restart the exhibition.');
    takeovers++;
  }
  {
    const h = harness(); h.start(); h.finish();
    while (h.c.direction !== 'restore') h.finish();
    const op = h.c.pending.operation;
    const candidate = h.c.expected.findIndex((occupied, i) => occupied && !op.protectedSquares.includes(i));
    const after = op.before.slice(); after[candidate] = false;
    // No intervening snapshot: the final result is the first evidence of a lift.
    h.finish(after);
    assert.equal(h.c.state, 'takeover_homing');
    h.finish(after);
    assert.equal(h.c.state, 'manual_ready');
  }
  {
    const h = harness(); h.start(); h.finish();
    h.c.result({ id: h.c.pending.id, success: false, error: 'placement failed' }, h.c.expected);
    assert.equal(h.c.state, 'recovery');
    assert.equal(h.queue.length, 1, 'The consumed pending command is not an automatic retry.');
  }
  {
    const h = harness(); h.start();
    h.c.result({ id: h.c.pending.id, success: false, error: 'homing timed out' }, h.c.expected);
    assert.equal(h.c.state, 'recovery');
    assert.notEqual(h.c.state, 'manual_ready');
  }
  {
    const h = harness(); h.start(); h.finish();
    h.runtime.fresh = false;
    h.finish();
    assert.equal(h.c.pending, null);
    assert.equal(h.queue.length, 0);
    h.runtime.fresh = true; h.snap(h.c.expected);
    assert.ok(h.c.pending);
  }
  for (const homeSucceeds of [true, false]) {
    const h = harness(); h.start(); h.finish();
    const oldId = h.c.pending.id;
    h.queue.shift();
    h.c.result({ id: oldId, success: false, error: 'piece slipped' }, h.c.expected);
    const request = () => h.c.control({ action: 'prepare-manual-reset', runId: h.c.runId,
      expectedRevision: h.c.revision, confirmedPiecesPlaced: true });
    assert.throws(() => h.control('prepare-manual-reset'), /Confirm every piece/);
    h.runtime.magnetOn = true; assert.throws(request); h.runtime.magnetOn = false;
    h.runtime.motionBusy = true; assert.throws(request); h.runtime.motionBusy = false;
    h.runtime.motionPending = true; assert.throws(request); h.runtime.motionPending = false;
    h.runtime.fresh = false; assert.throws(request); h.runtime.fresh = true;
    h.advanceTime(5001); assert.throws(request); h.snap(h.c.expected);
    const before = clone(h.c.tokens), oldRun = h.c.runId;
    request();
    assert.notEqual(h.c.runId, oldRun);
    assert.equal(h.c.state, 'takeover_homing');
    assert.equal(h.queue.length, 1); assert.equal(h.queue[0].type, 'home');
    assert.throws(() => h.c.result({ id: oldId, success: true }, h.c.expected));
    assert.deepEqual(h.c.tokens, before, 'The failed transfer must not commit.');
    if (homeSucceeds) {
      h.finish(); assert.equal(h.c.state, 'manual_ready');
      assert.equal(h.c.resetGuidance, true); assert.equal(h.queue.length, 0);
      h.snap(adapter.occupancy(compiled.initial)); assert.equal(h.queue.length, 0);
    } else {
      const home = h.queue.shift();
      h.c.result({ id: home.id, success: false, error: 'homing timed out' }, h.c.expected);
      assert.equal(h.c.state, 'recovery'); assert.equal(h.queue.length, 0);
    }
  }

  // Every transfer, including capture bays, castling, promotion and inverse promotion,
  // can be manually completed without replaying any of its physical steps.
  for (const direction of ['play','restore']) for (let index=0; index<compiled.operations.length; index++) {
    const h=harness(); h.start(); h.finish(); h.queue.length=0; h.c.pending=null;
    const op=compiled.operations[index];
    h.c.direction=direction; h.c.cursor=direction==='play'?index:index+1;
    h.c.tokens=clone(direction==='play'?op.tokensBefore:op.tokensAfter);
    h.c.expected=(direction==='play'?op.before:op.after).slice();
    h.c.occupancy=h.c.expected.slice(); h.c.advance();
    const job=h.queue.shift(); assert.equal(job.type,'move');
    const beforeTokens=clone(h.c.tokens), beforeCursor=h.c.cursor;
    h.c.result({id:job.id,success:false,magnetOn:false,error:'Drop verification failed after nudge attempts.'}, h.c.expected);
    assert.equal(h.c.recovery.recoverable,true);
    assert.deepEqual(h.c.tokens,beforeTokens); assert.equal(h.c.cursor,beforeCursor);
    assert.equal(h.c.result({id:job.id,success:true,magnetOn:false},h.c.expected).alreadyReported,true);
    const target=(direction==='play'?op.after:op.before).slice();
    h.runtime.motionBusy=true; h.advanceTime(1000);h.snap(target);assert.equal(h.queue.length,0);
    h.runtime.motionBusy=false;
    // A broken stability window must start again.
    h.advanceTime(300);h.snap(target);h.advanceTime(300);h.snap(h.c.expected);
    h.advanceTime(300);h.snap(target);assert.equal(h.queue.length,0);
    for(let n=0;n<4;n++){h.advanceTime(250);h.snap(target);}
    if(h.c.recovery.requiresConfirmation){
      assert.equal(h.c.recovery.stage,'confirmation');
      assert.throws(()=>h.c.control({action:'confirm-recovery-placement',runId:h.c.runId,expectedRevision:h.c.revision,recoveryId:'wrong'}));
      const confirm=()=>h.c.control({action:'confirm-recovery-placement',runId:h.c.runId,expectedRevision:h.c.revision,recoveryId:h.c.recovery.id});
      confirm();assert.throws(confirm);
    }
    h.control('pause');
    for(let n=0;n<7;n++){h.advanceTime(250);h.snap(target);}
    assert.equal(h.queue.length,1);
    const reconcile=h.queue.shift();assert.equal(reconcile.type,'autonomous-reconcile');
    assert.equal(h.c.cursor,beforeCursor,'No commitment before firmware acknowledgement.');
    h.c.result({id:reconcile.id,success:true,magnetOn:false},target);
    assert.equal(h.c.state,'paused');assert.equal(h.queue.length,0);
    assert.equal(h.c.cursor,beforeCursor+(direction==='play'?1:-1));
    assert.deepEqual(h.c.tokens,direction==='play'?op.tokensAfter:op.tokensBefore);
    assert.equal(h.c.result({id:job.id,success:true},target).alreadyCompleted,true);
    assert.equal(h.c.result({id:reconcile.id,success:true},target).alreadyCompleted,true);
  }
  {
    const h=harness();h.start();h.finish();h.control('pause');h.finish();
    const cursor=h.c.cursor, displaced=h.c.expected.slice();displaced[0]=!displaced[0];
    h.c.state='playing';h.c.pauseRequested=false;h.snap(displaced);assert.equal(h.c.recovery.category,'displacement');
    const target=h.c.expected.slice();h.control('pause');
    for(let n=0;n<10;n++){h.advanceTime(250);h.snap(target);}
    const ack=h.queue.shift();assert.equal(ack.type,'autonomous-reconcile');
    h.c.result({id:ack.id,success:true,magnetOn:false},target);assert.equal(h.c.cursor,cursor);
  }

  for(const index of [0,16,compiled.operations.findIndex(op=>op.san.includes('='))]) {
    const h=harness();h.start();h.finish();h.queue.length=0;h.c.pending=null;
    const op=compiled.operations[index];h.c.direction='restore';h.c.cursor=index+1;
    h.c.tokens=clone(op.tokensAfter);h.c.expected=op.after.slice();h.c.occupancy=op.after.slice();h.c.advance();
    const job=h.queue.shift();h.c.result({id:job.id,success:false,magnetOn:false,error:'Drop verification failed'},op.after);
    const r=h.c.recovery;
    const other=op.before.findIndex((v,i)=>v&&!r.protectedSquares.includes(i));
    assert.ok(other>=0);
    const corrected=op.before.slice();corrected[other]=false;
    h.advanceTime(100);h.snap(corrected);assert.equal(h.c.takeover,true);
    for(let n=0;n<4;n++){h.advanceTime(250);h.snap(corrected);}
    if(r.requiresConfirmation)h.c.control({action:'confirm-recovery-placement',runId:h.c.runId,expectedRevision:h.c.revision,recoveryId:r.id});
    for(let n=0;n<7;n++){h.advanceTime(250);h.snap(corrected);}
    const ack=h.queue.shift();assert.equal(ack.type,'autonomous-reconcile');
    h.c.result({id:ack.id,success:true,magnetOn:false},corrected);
    assert.equal(h.c.state,'takeover_homing');assert.equal(h.queue.length,1);assert.equal(h.queue[0].type,'home');
    h.finish(corrected);assert.equal(h.c.state,'manual_ready');assert.equal(h.queue.length,0);
  }
  {
    const h=harness();h.start();h.finish();const job=h.queue.shift();
    h.c.result({id:job.id,success:false,magnetOn:false,error:'Drop verification failed'},h.c.expected);
    const target=h.c.pending.operation.after;
    h.c.snapshot(target,h.runtime,{seq:20});h.advanceTime(2000);
    h.c.snapshot(target,h.runtime,{seq:20});assert.equal(h.c.recovery.samples,1);
    h.runtime.fresh=false;h.snap(target);assert.equal(h.c.recovery.samples,0);
    h.runtime.fresh=true;h.runtime.magnetOn=true;h.snap(target);assert.equal(h.queue.length,0);
    h.runtime.magnetOn=false;
    for(let n=0;n<10;n++){h.advanceTime(250);h.snap(target);}
    const ack=h.queue.shift();h.c.result({id:ack.id,success:false,magnetOn:false,error:'baseline failed'},target);
    assert.equal(h.c.state,'recovery');assert.equal(h.c.recovery.recoverable,false);assert.equal(h.queue.length,0);
  }

  {
    const h=harness(), initial=adapter.occupancy(compiled.initial);
    h.c.snapshot(initial,h.runtime,{seq:100});h.advanceTime(6000);
    h.c.snapshot(initial,h.runtime,{seq:1});
    assert.equal(h.c.lastSensorSequence,1,'Idle board must accept a rebooted firmware sequence after stale telemetry.');
    assert.ok(h.c.recoveryIdle());
  }

  {
    const h=harness();h.start();h.finish();h.queue.length=0;h.c.pending=null;
    const index=compiled.operations.findIndex(op=>op.from==='c3'&&op.to==='e2');
    const op=compiled.operations[index];h.c.direction='restore';h.c.cursor=index+1;
    h.c.tokens=clone(op.tokensAfter);h.c.expected=op.after.slice();h.c.occupancy=op.after.slice();h.c.advance();
    const job=h.queue.shift();h.c.result({id:job.id,success:true,magnetOn:false},op.before);
    const cursor=h.c.cursor, shifted=op.before.slice();shifted[p.squareToIndex('c3')]=false;shifted[p.squareToIndex('d2')]=true;
    h.snap(shifted);assert.equal(h.c.takeover,false,'Late robot route changes must not request takeover.');
    assert.equal(h.c.recovery.category,'displacement');assert.equal(h.c.recovery.to,'c3');
    h.control('pause');for(let n=0;n<10;n++){h.advanceTime(250);h.snap(op.before);}
    const ack=h.queue.shift();assert.equal(ack.type,'autonomous-reconcile');h.c.result({id:ack.id,success:true,magnetOn:false},op.before);
    assert.equal(h.c.cursor,cursor,'Post-commit recovery must not commit twice.');assert.equal(h.c.state,'paused');
  }

  for(const op of compiled.operations.filter(op=>op.from==='h2'&&op.to==='h4')) {
    assert.ok(op.protectedSquares.includes(p.squareToIndex('h3')),'Compressed pawn travel must reserve its intermediate sensor square.');
  }
  {
    const h=harness();h.start();h.finish();h.queue.length=0;h.c.pending=null;
    const index=compiled.operations.findIndex(op=>op.from==='h4'&&op.to==='h2'),op=compiled.operations[index];
    h.c.direction='restore';h.c.cursor=index+1;h.c.tokens=clone(op.tokensAfter);
    h.c.expected=op.after.slice();h.c.occupancy=op.after.slice();h.c.advance();
    const traveling=op.after.slice();traveling[p.squareToIndex('h2')]=false;traveling[p.squareToIndex('h3')]=true;
    h.snap(traveling);assert.equal(h.c.takeover,false);assert.equal(h.c.interference,false);
    assert.ok(h.c.pending.operation.protectedSquares.includes(p.squareToIndex('h3')));
  }
  console.log(`Autonomous: ${SCRIPT.moves.length} legal plies, ${compiled.operations.length} reversible transfers, storage max ${compiled.maxStorage}, three complete cycles, ${takeovers} takeover boundaries, controls, guarded reset homing, and failure cases passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await server.mentorFeature.close(); fs.rmSync(temp, { recursive: true, force: true });
});
