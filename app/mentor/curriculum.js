const { Chess } = require('chess.js');
const { STANDARD_FEN } = require('./store');

const OPENINGS = [{
  id: 'italian-game',
  type: 'opening_drill',
  title: 'Italian Game',
  goal: 'Develop quickly and aim at the center and f7.',
  topic: 'openings',
  skillBands: ['Beginner', 'Intermediate'],
  initialFen: STANDARD_FEN,
  line: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'],
  hints: ['Fight for the center with the king pawn.', 'Develop the king knight toward the center.', 'Place the bishop where it eyes f7.']
}, {
  id: 'ruy-lopez',
  type: 'opening_drill',
  title: 'Ruy Lopez',
  goal: 'Build central pressure by challenging the c6 defender.',
  topic: 'openings',
  skillBands: ['Beginner', 'Intermediate', 'Advanced'],
  initialFen: STANDARD_FEN,
  line: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6'],
  hints: ['Claim central space with e4.', 'Develop the knight and attack e5.', 'Pin the c6 knight with the king bishop.']
}, {
  id: 'queens-gambit',
  type: 'opening_drill',
  title: "Queen's Gambit",
  goal: 'Challenge Black’s d5 pawn and build a broad center.',
  topic: 'openings',
  skillBands: ['Beginner', 'Intermediate', 'Advanced'],
  initialFen: STANDARD_FEN,
  line: ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3', 'g8f6'],
  hints: ['Start with the queen pawn.', 'Challenge d5 with the c-pawn.', 'Develop the queen knight behind the center.']
}, {
  id: 'london-system',
  type: 'opening_drill',
  title: 'London System',
  goal: 'Build a dependable setup with the dark-squared bishop outside the pawn chain.',
  topic: 'openings',
  skillBands: ['Beginner', 'Intermediate'],
  initialFen: STANDARD_FEN,
  line: ['d2d4', 'd7d5', 'g1f3', 'g8f6', 'c1f4', 'e7e6'],
  hints: ['Begin with d4.', 'Develop the king knight naturally.', 'Develop the c1 bishop before playing e3.']
}, {
  id: 'sicilian-defense',
  type: 'opening_drill',
  title: 'Sicilian Defense',
  goal: 'Use an asymmetric pawn structure to contest d4.',
  topic: 'openings',
  skillBands: ['Intermediate', 'Advanced'],
  initialFen: STANDARD_FEN,
  line: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4'],
  hints: ['White claims the center with e4.', 'Black challenges d4 with the c-pawn.', 'Open the center only after developing the knight.']
}, {
  id: 'french-defense',
  type: 'opening_drill',
  title: 'French Defense',
  goal: 'Build a resilient pawn chain and challenge White’s center.',
  topic: 'openings',
  skillBands: ['Beginner', 'Intermediate', 'Advanced'],
  initialFen: STANDARD_FEN,
  line: ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'b1c3', 'g8f6'],
  hints: ['White takes central space with e4.', 'Black prepares the d5 counterstrike.', 'Support the center with natural development.']
}];

const PUZZLES = [{
  id: 'back-rank-mate', title: 'Back-Rank Mate', topic: 'mate_patterns',
  goal: 'Find the immediate back-rank checkmate.',
  initialFen: '6k1/5ppp/8/8/8/8/6PP/4R1K1 w - - 0 1', line: ['e1e8'],
  hints: ['The king has no flight square.', 'Use the rook.', 'The target square is e8.']
}, {
  id: 'queen-corridor-mate', title: 'Queen Corridor Mate', topic: 'mate_patterns',
  goal: 'Use the queen to seal the eighth rank.',
  initialFen: '7k/6pp/8/4Q3/8/8/8/6K1 w - - 0 1', line: ['e5e8'],
  hints: ['Look for a check on the eighth rank.', 'The queen can control every escape square.', 'Move the queen to e8.']
}, {
  id: 'royal-fork', title: 'Royal Fork', topic: 'forks',
  goal: 'Fork the king and queen with the knight.',
  initialFen: '3q3k/8/7N/8/8/8/8/6K1 w - - 0 1', line: ['h6f7'],
  hints: ['A knight check can attack two royal pieces.', 'Use the knight on h6.', 'The fork square is f7.']
}, {
  id: 'bishop-pin', title: 'Bishop Pin', topic: 'pins',
  goal: 'Pin the knight to its king.',
  initialFen: '4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1', line: ['f1b5'],
  hints: ['Line up a bishop with the king.', 'Use the bishop on f1.', 'The pinning square is b5.']
}, {
  id: 'queen-skewer', title: 'King And Queen Skewer', topic: 'skewers',
  goal: 'Capture the queen with check and keep the initiative.',
  initialFen: 'k7/q7/8/8/8/8/8/R5K1 w - - 0 1', line: ['a1a7'],
  hints: ['The queen and king share a file.', 'Use the rook on a1.', 'Capture on a7 with check.']
}, {
  id: 'discovered-attack', title: 'Discovered Attack', topic: 'discovered_attacks',
  goal: 'Move the bishop and uncover a rook check.',
  initialFen: 'q3k3/8/8/8/8/8/4B3/4R1K1 w - - 0 1', line: ['e2d3'],
  hints: ['One piece is blocking a checking line.', 'Move the bishop away from the e-file.', 'Place the bishop on d3.']
}, {
  id: 'knight-double-attack', title: 'Knight Double Attack', topic: 'forks',
  goal: 'Check the king while attacking the rook.',
  initialFen: '3r3k/8/7N/8/8/8/8/6K1 w - - 0 1', line: ['h6f7'],
  hints: ['Look for a forcing knight check.', 'The h6 knight has a central jump.', 'Jump to f7.']
}, {
  id: 'second-pin', title: 'Pin Before Winning', topic: 'pins',
  goal: 'Create an absolute pin on the king.',
  initialFen: '3k4/8/3n4/8/8/8/8/R3K3 w - - 0 1', line: ['a1d1'],
  hints: ['Put the rook on the same file as the knight and king.', 'Use the rook on a1.', 'The pinning square is d1.']
}, {
  id: 'diagonal-skewer', title: 'Diagonal Skewer', topic: 'skewers',
  goal: 'Win the queen on the checking diagonal.',
  initialFen: '7k/6q1/8/8/8/2B5/8/6K1 w - - 0 1', line: ['c3g7'],
  hints: ['The queen is lined up with its king.', 'Use the bishop on c3.', 'Capture on g7 with check.']
}, {
  id: 'discovered-check', title: 'Discovered Check', topic: 'discovered_attacks',
  goal: 'Uncover the rook with a developing bishop move.',
  initialFen: '4k3/8/8/8/8/8/4B3/4R1K1 w - - 0 1', line: ['e2b5'],
  hints: ['The rook is lined up with the king.', 'Move the e2 bishop with check.', 'Place the bishop on b5.']
}, {
  id: 'ladder-mate', title: 'Ladder Mate', topic: 'mate_patterns',
  goal: 'Finish the king with the second rook.',
  initialFen: '7k/R4K2/8/8/8/8/8/6R1 w - - 0 1', line: ['g1g8'],
  hints: ['The a7 rook covers the seventh rank.', 'Bring the other rook to the eighth rank.', 'Play Rg8 mate.']
}, {
  id: 'supported-queen-mate', title: 'Supported Queen Mate', topic: 'mate_patterns',
  goal: 'Place the protected queen next to the king.',
  initialFen: '7k/8/5KQ1/8/8/8/8/8 w - - 0 1', line: ['g6g7'],
  hints: ['The white king protects g7.', 'Use the queen for a close-range check.', 'Play Qg7 mate.']
}].map((item) => ({
  ...item,
  type: 'puzzle',
  skillBands: ['Beginner', 'Intermediate', 'Advanced'],
  fixedLearnerColor: 'white'
}));

const LESSONS = [{
  id: 'piece-basics', title: 'Piece Basics', topic: 'piece_basics',
  goal: 'Practice a rook’s straight-line movement.',
  initialFen: '7k/8/8/8/8/8/8/R6K w - - 0 1', line: ['a1a4'],
  hints: ['Rooks travel in straight lines.', 'Use the rook on a1.', 'Move it to a4.']
}, {
  id: 'central-control', title: 'Central Control', topic: 'central_control',
  goal: 'Claim space and influence key central squares.', initialFen: STANDARD_FEN,
  line: ['e2e4', 'e7e5'], hints: ['Use a central pawn.', 'Move the king pawn.', 'Play e4.']
}, {
  id: 'development', title: 'Development', topic: 'development',
  goal: 'Develop a minor piece toward the center.', initialFen: STANDARD_FEN,
  line: ['g1f3', 'g8f6'], hints: ['Develop before moving the same piece twice.', 'Use the king knight.', 'Play Nf3.']
}, {
  id: 'king-safety', title: 'King Safety', topic: 'king_safety',
  goal: 'Castle to place the king behind its pawns.',
  initialFen: 'r3k2r/pppp1ppp/2n2n2/4p3/2B1P1b1/2N2N2/PPPP1PPP/R3K2R w KQkq - 6 7',
  line: ['e1g1'], hints: ['The king and rook can move together.', 'Castle on the kingside.', 'Move the king from e1 to g1.']
}, {
  id: 'tactical-scanning', title: 'Tactical Scanning', topic: 'tactical_scanning',
  goal: 'Scan checks, captures, and threats before moving.',
  initialFen: '3q3k/8/7N/8/8/8/8/6K1 w - - 0 1', line: ['h6f7'],
  hints: ['Start by listing every check.', 'The knight has a forcing jump.', 'Play Nf7+.']
}].map((item) => ({
  ...item,
  type: 'guided_lesson',
  skillBands: ['Beginner', 'Intermediate'],
  fixedLearnerColor: 'white',
  checkpoints: [
    { kind: 'explanation', text: item.goal },
    { kind: 'prediction', text: item.hints[0] },
    { kind: 'learner_move', uci: item.line[0] }
  ]
}));

const CATALOG = [...OPENINGS, ...PUZZLES, ...LESSONS];

function moveUci(move) {
  return `${move.from}${move.to}${move.promotion || ''}`;
}

function validateCatalogItem(item) {
  const game = new Chess(item.initialFen);
  if (!Array.isArray(item.line) || item.line.length === 0 || item.line.length > 24) {
    throw new Error(`Curriculum item ${item.id} needs 1-24 moves.`);
  }
  item.line.forEach((uci, index) => {
    let move = null;
    try {
      move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      move = null;
    }
    if (!move || moveUci(move) !== uci) {
      throw new Error(`Curriculum item ${item.id} has illegal move ${uci} at ply ${index + 1}.`);
    }
  });
  return true;
}

CATALOG.forEach(validateCatalogItem);

function publicCatalogItem(item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    goal: item.goal,
    topic: item.topic,
    skillBands: item.skillBands,
    fixedLearnerColor: item.fixedLearnerColor || null,
    moveCount: item.line.length
  };
}

function listCatalog(type = null) {
  return CATALOG.filter((item) => !type || item.type === type).map(publicCatalogItem);
}

function getCatalogItem(id) {
  return CATALOG.find((item) => item.id === id) || null;
}

function recommendCatalog(profile, progress, type = null) {
  const mastery = new Map((progress || []).map((item) => [item.topic, item.mastery]));
  let candidates = CATALOG.filter((item) => (!type || item.type === type)
    && item.skillBands.includes(profile.skillBand));
  if (!candidates.length) candidates = CATALOG.filter((item) => !type || item.type === type);
  return candidates
    .sort((left, right) => (mastery.get(left.topic) || 0) - (mastery.get(right.topic) || 0)
      || left.title.localeCompare(right.title))
    .slice(0, 6)
    .map(publicCatalogItem);
}

module.exports = {
  CATALOG,
  LESSONS,
  OPENINGS,
  PUZZLES,
  getCatalogItem,
  listCatalog,
  publicCatalogItem,
  recommendCatalog,
  validateCatalogItem
};
