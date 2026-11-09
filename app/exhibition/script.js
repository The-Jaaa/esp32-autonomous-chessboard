const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');

const PGN_PATH = path.join(__dirname, 'tal-shamkovich-1965.pgn');
const scriptGame = new Chess();
scriptGame.loadPgn(fs.readFileSync(PGN_PATH, 'utf8'));
const SCRIPT = { id: 'tal-shamkovich-1965', title: 'Tal–Shamkovich, Kiev 1965',
  headers: scriptGame.getHeaders(), moves: scriptGame.history({ verbose: true }) };
const clone = value => JSON.parse(JSON.stringify(value));

function compileScript(adapter, slots) {
  const review = JSON.parse(fs.readFileSync(path.join(__dirname, 'engine-review.json'), 'utf8'));
  if (!review.engine || review.rows.length !== SCRIPT.moves.length
    || review.rows.some((row, i) => row.played !== SCRIPT.moves[i].san || !row.best)) throw Error('The fixed script needs a matching completed engine review.');
  const tokens = new Chess().board().flat().filter(Boolean).map(p => ({
    id: p.square, home: p.square, color: p.color, type: p.type, location: p.square
  }));
  const initial = clone(tokens);
  const operations = [];
  let maxStorage = 0;
  const boardOccupancy = () => adapter.occupancy(tokens);
  // Reserve every board square touched by each compressed drag segment, not
  // only its waypoints. Sensors can observe a carried piece between endpoints.
  function routeReservations(points) {
    const indices = new Set(points.filter(t => Number.isInteger(t.index)).map(t => t.index));
    for(let n=1;n<points.length;n++) {
      const a=points[n-1].square, b=points[n].square;
      if(!a || !b)continue; // A storage endpoint is outside the sensed board.
      const x=a.charCodeAt(0)-97,y=Number(a[1]);
      const dx=b.charCodeAt(0)-97-x,dy=Number(b[1])-y;
      for(let file=0;file<8;file++)for(let rank=1;rank<=8;rank++) {
        let lo=0,hi=1,hit=true;
        for(const [origin,delta,center] of [[x,dx,file],[y,dy,rank]]) {
          if(delta===0){if(Math.abs(origin-center)>0.5)hit=false;continue;}
          const t1=(center-0.5-origin)/delta,t2=(center+0.5-origin)/delta;
          lo=Math.max(lo,Math.min(t1,t2));hi=Math.min(hi,Math.max(t1,t2));
        }
        if(hit && lo<=hi+1e-9)indices.add(adapter.squareIndex(String.fromCharCode(97+file)+rank));
      }
    }
    return [...indices];
  }
  function append(steps, move, label) {
    let source = null, targets = [];
    for (const step of steps) {
      if (step.action === 'travel') { source = clone(step.to); targets = []; }
      if (step.action === 'drag') targets.push(clone(step.to));
      if (step.action !== 'drop') continue;
      if (!source || !targets.length) throw Error('Incomplete physical transfer in script.');
      const destination = targets.at(-1);
      const from = adapter.location(source), to = adapter.location(destination);
      const piece = tokens.find(p => p.location === from);
      if (!piece || tokens.some(p => p.location === to)) throw Error(`Invalid piece transfer ${from} → ${to}.`);
      const before = boardOccupancy();
      const tokenBefore = clone(tokens);
      piece.location = to;
      if (move.promotionPawnId && piece.type === move.promotion && to === move.to) piece.representedPawn = move.promotionPawnId;
      maxStorage = Math.max(maxStorage, tokens.filter(p => !/^[a-h][1-8]$/.test(p.location)).length);
      if (maxStorage > slots.length) throw Error('Script exceeds graveyard capacity.');
      const makePlan = (start, route) => {
        const end = route.at(-1);
        const verify = { action: 'verify' };
        if (Number.isInteger(start.index)) verify.sourceEmpty = start.index;
        if (Number.isInteger(end.index)) verify.targetOccupied = end.index;
        return [{ action: 'travel', to: start }, { action: 'pickup' },
          ...route.map(to => ({ action: 'drag', to })),
          { action: 'drop', nudgeTargetIndex: Number.isInteger(end.index) ? end.index : null }, verify];
      };
      operations.push({ ply: move.ply, san: move.san, label, pieceId: piece.id, from, to,
        plan: makePlan(source, targets), reversePlan: makePlan(destination, [source, ...targets.slice(0, -1)].reverse()),
        before, after: boardOccupancy(), tokensBefore: tokenBefore, tokensAfter: clone(tokens),
        protectedSquares: routeReservations([source,...targets]) });
      source = null; targets = [];
    }
  }
  for (let i = 0; i < SCRIPT.moves.length; i++) {
    const move = { ...SCRIPT.moves[i], ply: i + 1 };
    const stored = tokens.filter(p => !/^[a-h][1-8]$/.test(p.location)).map(p => p.location);
    const command = adapter.forward(move.before, move, slots, stored);
    append(command.plan, move, `Play ${move.san}`);
    if (move.promotion) {
      const pawn = tokens.find(p => p.location === move.to);
      const replacement = tokens.find(p => p.color === move.color && p.type === move.promotion
        && !/^[a-h][1-8]$/.test(p.location));
      if (!replacement) throw Error(`No captured replacement for ${move.san}.`);
      const reservedSlot = replacement.location;
      const swap = adapter.promotion(move, slots, tokens, replacement, pawn);
      append(swap, { ...move, promotionPawnId: pawn.id }, `Exchange pawn for captured ${move.promotion}`);
      if (replacement.location !== move.to || pawn.location !== reservedSlot) throw Error('Promotion exchange did not complete.');
    }
    const expected = adapter.fenOccupancy(move.after);
    if (JSON.stringify(expected) !== JSON.stringify(boardOccupancy())) throw Error(`Occupancy disagrees after ${move.san}.`);
    operations.at(-1).fenAfter = move.after;
    operations.at(-1).moveComplete = true;
  }
  for (const op of operations) {
    op.protectedSquares = [...new Set(operations.filter(p => p.ply === op.ply).flatMap(p => p.protectedSquares))];
  }
  if (!SCRIPT.moves.some(m => m.promotion) || !SCRIPT.moves.some(m => /[kq]/.test(m.flags))) throw Error('Script misses required events.');
  return { script: SCRIPT, operations, initial, maxStorage, final: clone(tokens) };
}
module.exports = { PGN_PATH, SCRIPT, compileScript, clone };
