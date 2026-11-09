const { Chess } = require('chess.js');

function createAutonomousPlanner(p) {
  const location = target => target.square || target.label;
  const occupancy = tokens => {
    const result = Array(64).fill(false);
    for (const token of tokens) {
      const index = p.squareToIndex(token.location);
      if (Number.isInteger(index)) result[index] = true;
    }
    return result;
  };
  function context(fen, slots, stored, fn) {
    return p.withPhysicalPlanningContext(fen, slots, game => {
      p.session.robotGraveyardOccupied = stored;
      return fn(game);
    });
  }
  return { location, occupancy, squareIndex: p.squareToIndex, fenOccupancy: p.occupancyFromFen,
    // Script-wide matching keeps scarce exits available for later captures.
    forward: (fen, move, slots, stored) => {
      const allocation = {16:'Z2',17:'Z3',26:'Z5',27:'I1',36:'Z4',37:'I3',60:'Z1',61:'Z6',69:'Z7',70:'Z8',75:'I8',76:'I7',81:'I6',82:'I5',83:'I4'};
      const chosen = allocation[move.ply];
      return context(fen, slots, chosen ? slots.filter(s => s.label !== chosen).map(s => s.label) : stored,
        () => p.buildRobotMoveCommand(move));
    },
    promotion(move, slots, tokens, replacement) {
      const slot = slots.find(s => s.label === replacement.location);
      if (!slot) throw Error('Promotion replacement has no configured slot.');
      const stored = tokens.filter(t => !/^[a-h][1-8]$/.test(t.location) && t.id !== replacement.id).map(t => t.location);
      const errors = [];
      for (const file of 'abcdefgh') for (let rank = 1; rank <= 8; rank++) {
        const stage = file + rank;
        try {
          return context(move.after, slots, stored, game => {
            if (game.get(stage)) throw Error('Staging occupied.');
            const pawnMove = { color: move.color, piece: 'p', flags: '', from: move.to, to: stage };
            const first = p.planPhysicalTransfer(game, pawnMove, move.to, stage);
            game.remove(move.to);
            // A queen placeholder preserves valid chess.js FENs while planning the
            // physical pawn on its temporary square. Routes use occupancy only.
            game.put({ color: move.color, type: 'q' }, stage);
            const exit = `${slot.lane === 'Z' ? 'a' : 'h'}${slot.rank}`;
            const route = p.buildBoardTransferPlan(game, { ...pawnMove, piece: move.promotion }, move.to, exit);
            const points = route.steps.filter(s => s.action === 'drag').map(s => s.to);
            const reverse = [p.squareTarget(move.to), ...points.slice(0, -1)].reverse();
            const second = p.makeTransferSteps(p.coordinateTarget(slot, 'graveyard'), reverse,
              { targetOccupied: p.squareToIndex(move.to) });
            game.put({ color: move.color, type: move.promotion }, move.to);
            p.session.graveyardSlots = [slot];
            const last = p.planPhysicalTransfer(game, { ...pawnMove, from: stage }, stage, null,
              { operation: 'graveyard-removal' });
            return [...first.steps, ...second, ...last.steps];
          });
        } catch (error) { errors.push(error.message); }
      }
      throw Error(`No automatic promotion exchange route: ${errors.at(-1)}`);
    }
  };
}
module.exports = { createAutonomousPlanner };
