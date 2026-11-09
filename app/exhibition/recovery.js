const { randomUUID } = require('crypto');
const { clone } = require('./script');
const same = (a,b) => Array.isArray(a) && a.length === 64 && a.every((v,i)=>Boolean(v)===Boolean(b[i]));
const names = {p:'pawn',n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'};
module.exports = {
  beginRecovery(message, terminal = false, category = 'blocking') {
    if (this.recovery) return;
    const p = this.pending || (category==='displacement'?this.lastTransfer:null), op = p?.operation;
    const recoverable = category !== 'blocking';
    const expected = op ? (p.direction === 'play' ? op.after : op.before) : this.expected;
    const token = op && this.tokens.find(t=>t.id===op.pieceId);
    const to = op && (p.direction === 'play' ? op.to : op.from);
    this.recovery = { id:randomUUID(), commandId:p?.id || null, category, recoverable, terminal,
      piece:token ? `${token.color==='w'?'White':'Black'} ${token.home[0]}-${names[token.type]}` : null,
      transfer:op ? { index:p.index, direction:p.direction, ply:op.ply, san:op.san } : null,
      pieceId:token?.id, from:op && (p.direction==='play'?op.from:op.to), to,
      expected:clone(expected), requiresConfirmation:Boolean(op && !/^[a-h][1-8]$/.test(to)),
      confirmed:false, protectedSquares:[...new Set([...(op?.protectedSquares || []),
        ...expected.map((v,i)=>Boolean(v)!==Boolean(this.occupancy?.[i])?i:-1).filter(i=>i>=0)])],
      correctionReady:false, stage:'waiting', missing:[], extra:[], message,
      stableSince:null, samples:0, resumeAt:null };
    this.state='recovery'; this.waitingForSync=false; this.refreshRecovery(); this.publish();
  },
  recoveryIdle() {
    const r=this.runtime();
    return r.fresh && r.motionBusy===false && r.motionPending===false && r.magnetOn===false && !r.homingFault
      && this.now()-this.lastSnapshotAt<5000 && (!this.sawFirmwareRun || r.autonomousRunId===this.runId);
  },
  refreshRecovery() {
    const r=this.recovery; if(!r)return;
    if(this.runtime().homingFault){r.recoverable=false;r.message='Positioning fault: home and manually reset before continuing.';}
    const expected=r.expected.map((v,i)=>this.takeover && this.lifted.has(i)?false:v);
    r.missing=expected.map((v,i)=>v&&!this.occupancy?.[i]?i:-1).filter(i=>i>=0);
    r.extra=expected.map((v,i)=>!v&&this.occupancy?.[i]?i:-1).filter(i=>i>=0);
    r.missingSquares=r.missing.map(this.squareName);r.extraSquares=r.extra.map(this.squareName);
    r.correctionReady=r.recoverable && r.terminal && this.recoveryIdle();
    if(!r.correctionReady) { r.stableSince=null;r.samples=0;r.resumeAt=null;
      this.message=r.recoverable?'Wait—robot is stopping.':r.message; return; }
    this.message=r.to?`Place ${r.piece} on ${r.to}${r.requiresConfirmation?', then confirm.':' to continue.'}`:'Restore the highlighted squares to continue.';
    if(!same(this.occupancy,expected)) { r.confirmed=false; r.stableSince=null;r.samples=0;r.resumeAt=null;r.stage='correcting';return; }
    if(r.stableSince===null)r.stableSince=this.now();
    r.samples++;
    if(this.now()-r.stableSince<500 || r.samples<3)return;
    if(r.requiresConfirmation&&!r.confirmed){r.stage='confirmation';return;}
    if(r.resumeAt===null){r.resumeAt=this.now()+1000;r.stage='resuming';this.message='Position corrected—resuming.';this.publish();return;}
    this.message='Position corrected—resuming.';
    if(this.now()<r.resumeAt || this.reconciliation)return;
    const id=`${this.runId}:reconcile:${r.id}`;
    this.reconciliation={id,recoveryId:r.id,expected};r.stage='reconciling';
    this.enqueue({id,type:'autonomous-reconcile',autonomous:{runId:this.runId,revision:this.revision+1,
      restoring:this.direction==='restore',protectedSquares:r.protectedSquares,expectedOccupancy:expected}});
    this.publish('Verifying correction with the board.');
  },
  reconcileResult(body, occupancy) {
    const job=this.reconciliation, r=this.recovery;
    if(!job || job.id!==body.id || !r || job.recoveryId!==r.id)this.fail('Stale recovery acknowledgement.');
    if(body.takeoverRequested)this.takeover=true;
    if(body.success!==true || body.magnetOn!==false || !same(occupancy,job.expected) || !this.recoveryIdle()) {
      this.reconciliation=null;r.recoverable=false;r.stage='blocked';r.message='Correction acknowledgement failed. Manually reconcile the board.';
      this.publish(r.message);return {success:false};
    }
    this.completed.add(body.id);
    if(this.pending?.operation)this.commitTransfer(this.pending);
    this.interference=false;this.reconciliation=null;this.recovery=null;
    this.state=this.direction==='restore'?'restoring':'playing';this.publish('Correction verified.');
    this.advance();return {success:true};
  },
  commitTransfer(pending) {
    if(this.completed.has(pending.id))return;
    const op=pending.operation;
    this.expected=(pending.direction==='play'?op.after:op.before).slice();
    this.tokens=clone(pending.direction==='play'?op.tokensAfter:op.tokensBefore);
    this.cursor+=pending.direction==='play'?1:-1;
    if(pending.direction==='play'&&op.moveComplete)this.fen=op.fenAfter;
    if(pending.direction==='restore') {
      const { SCRIPT }=require('./script');
      this.fen=this.cursor===0?SCRIPT.moves[0].before:SCRIPT.moves[this.compiled.operations[this.cursor-1].ply-1].after;
    }
    this.lastTransfer=pending;this.completed.add(pending.id);this.pending=null;
  }
};
