const { Chess } = require('chess.js');
const { STANDARD_FEN } = require('./store');

const LEGACY_OPENINGS = [{
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

function opening(id, title, family, goal, skillBands, line, hints) {
  return {
    id,
    type: 'opening_drill',
    title,
    family,
    goal,
    topic: 'openings',
    skillBands,
    supportsPhysical: true,
    initialFen: STANDARD_FEN,
    line,
    hints
  };
}

const OPENINGS = [
  opening('italian-game', 'Italian Game', 'Open games',
    'Develop quickly, secure the king, and pressure f7.', ['Beginner', 'Intermediate'],
    ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'd2d3', 'g8f6', 'e1g1', 'd7d6'],
    ['Claim the center with the king pawn.', 'Develop the king knight toward e5.', 'Aim the bishop at f7 and prepare to castle.']),
  opening('two-knights-defense', 'Two Knights Defense', 'Open games',
    'Meet the Italian setup with active knight development.', ['Beginner', 'Intermediate'],
    ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'd2d3', 'f8c5', 'e1g1', 'd7d6'],
    ['Open the center with e4.', 'Develop the king knight.', 'Develop the bishop to c4 and castle.']),
  opening('ruy-lopez', 'Ruy Lopez', 'Open games',
    'Build pressure on e5 by challenging its c6 defender.', ['Beginner', 'Intermediate', 'Advanced'],
    ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7'],
    ['Claim the center with e4.', 'Attack e5 with the king knight.', 'Place the bishop on b5, then preserve it after ...a6.']),
  opening('scotch-game', 'Scotch Game', 'Open games',
    'Open the center early and develop with tempo.', ['Beginner', 'Intermediate'],
    ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4', 'e5d4', 'f3d4', 'g8f6', 'b1c3', 'f8b4'],
    ['Take central space with e4.', 'Develop Nf3 before opening the center.', 'Challenge e5 immediately with d4.']),
  opening('vienna-game', 'Vienna Game', 'Open games',
    'Develop the queen knight first and build a flexible kingside attack.', ['Beginner', 'Intermediate'],
    ['e2e4', 'e7e5', 'b1c3', 'g8f6', 'f1c4', 'b8c6', 'd2d3', 'f8b4', 'g1e2', 'd7d6'],
    ['Begin with e4.', 'Develop the queen knight to c3.', 'Support the center and prepare kingside development.']),
  opening('queens-gambit', "Queen's Gambit Declined", 'Queen-pawn openings',
    "Challenge Black's d5 pawn and build a broad center.", ['Beginner', 'Intermediate', 'Advanced'],
    ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3', 'g8f6', 'c1g5', 'f8e7', 'e2e3', 'e8g8'],
    ['Start with the queen pawn.', 'Challenge d5 with the c-pawn.', 'Develop Nc3 and pin the f6 knight with Bg5.']),
  opening('queens-gambit-accepted', "Queen's Gambit Accepted", 'Queen-pawn openings',
    'Recover the gambit pawn while developing naturally.', ['Intermediate', 'Advanced'],
    ['d2d4', 'd7d5', 'c2c4', 'd5c4', 'e2e3', 'g8f6', 'f1c4', 'e7e6', 'g1f3', 'c7c5'],
    ['Offer the c-pawn to challenge d5.', 'Prepare to recover c4 with e3.', 'Recapture with the bishop and continue development.']),
  opening('slav-defense', 'Slav Defense', 'Queen-pawn openings',
    'Support d5 with the c-pawn while keeping the light bishop active.', ['Intermediate', 'Advanced'],
    ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'g8f6', 'b1c3', 'd5c4', 'a2a4', 'c8f5'],
    ['Build the d4 and c4 center.', 'Develop Nf3 and Nc3.', 'Use a4 to discourage ...b5 after Black captures c4.']),
  opening('london-system', 'London System', 'Queen-pawn openings',
    'Build a dependable setup with the bishop outside the pawn chain.', ['Beginner', 'Intermediate'],
    ['d2d4', 'd7d5', 'g1f3', 'g8f6', 'c1f4', 'e7e6', 'e2e3', 'c7c5', 'c2c3', 'b8c6'],
    ['Begin with d4.', 'Develop the king knight naturally.', 'Develop Bf4 before closing the pawn chain with e3.']),
  opening('catalan-opening', 'Catalan Opening', 'Queen-pawn openings',
    'Combine a queen-pawn center with long-diagonal pressure.', ['Intermediate', 'Advanced'],
    ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'g2g3', 'd7d5', 'f1g2', 'f8e7', 'g1f3', 'e8g8'],
    ['Begin with d4 and c4.', 'Prepare to fianchetto with g3.', 'Develop Bg2 and Nf3 to pressure the center.']),
  opening('english-opening', 'English Opening', 'Flank openings',
    'Control the center from the flank and build a kingside fianchetto.', ['Intermediate', 'Advanced'],
    ['c2c4', 'e7e5', 'b1c3', 'g8f6', 'g2g3', 'd7d5', 'c4d5', 'f6d5', 'f1g2', 'd5b6'],
    ['Start with the c-pawn.', 'Develop Nc3 to support d5.', 'Fianchetto the king bishop after exchanging in the center.']),
  opening('reti-opening', 'Reti Opening', 'Flank openings',
    'Delay central pawns while developing and controlling the center indirectly.', ['Intermediate', 'Advanced'],
    ['g1f3', 'd7d5', 'g2g3', 'g8f6', 'f1g2', 'e7e6', 'e1g1', 'f8e7', 'd2d3', 'e8g8'],
    ['Develop Nf3 without fixing the center.', 'Prepare a kingside fianchetto.', 'Castle before deciding on the central pawn break.']),
  opening('sicilian-defense', 'Open Sicilian', 'Black defenses',
    'Open the center against the Sicilian and develop actively.', ['Intermediate', 'Advanced'],
    ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'],
    ['Claim the center with e4.', 'Develop Nf3 before playing d4.', 'Recapture on d4 with the knight and continue with Nc3.']),
  opening('french-defense', 'French Advance', 'Black defenses',
    "Build a space advantage, then support White's advanced pawn chain.", ['Beginner', 'Intermediate', 'Advanced'],
    ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'e4e5', 'c7c5', 'c2c3', 'b8c6', 'g1f3', 'd8b6'],
    ['Create the e4-d4 center.', 'Advance e5 when Black challenges it.', 'Support d4 with c3 and develop Nf3.']),
  opening('caro-kann-classical', 'Caro-Kann Classical', 'Black defenses',
    'Develop naturally after Black challenges the e4 center.', ['Beginner', 'Intermediate', 'Advanced'],
    ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4', 'c3e4', 'c8f5', 'e4g3', 'f5g6'],
    ['Build the e4-d4 center.', 'Develop Nc3 before Black captures.', 'Recapture with the knight and preserve it with Ng3.']),
  opening('scandinavian-defense', 'Scandinavian Defense', 'Black defenses',
    "Gain time against Black's early queen development.", ['Beginner', 'Intermediate'],
    ['e2e4', 'd7d5', 'e4d5', 'd8d5', 'b1c3', 'd5d8', 'd2d4', 'g8f6', 'g1f3', 'c7c6'],
    ['Take the d5 pawn.', 'Develop Nc3 with tempo on the queen.', 'Build a central pawn and knight setup.']),
  opening('pirc-defense', 'Pirc Defense', 'Black defenses',
    'Build a large center before Black challenges it from the flank.', ['Intermediate', 'Advanced'],
    ['e2e4', 'd7d6', 'd2d4', 'g8f6', 'b1c3', 'g7g6', 'f2f4', 'f8g7', 'g1f3', 'e8g8'],
    ['Occupy the center with e4 and d4.', 'Develop Nc3 to reinforce e4.', 'Use f4 for space before completing development.']),
  opening('kings-indian-defense', "King's Indian Defense", 'Black defenses',
    "Build a classical pawn center against Black's kingside fianchetto.", ['Intermediate', 'Advanced'],
    ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'f8g7', 'e2e4', 'd7d6', 'g1f3', 'e8g8'],
    ['Begin with d4 and c4.', 'Develop Nc3 before building the full center.', 'Complete the center with e4 and develop Nf3.'])
];

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
}].map((item, index) => ({
  ...item,
  type: 'puzzle',
  skillBands: index < 4 ? ['Beginner'] : index < 8 ? ['Intermediate'] : ['Advanced'],
  difficultyBand: index < 4 ? 'beginner' : index < 8 ? 'intermediate' : 'advanced',
  supportsPhysical: true,
  fixedLearnerColor: new Chess(item.initialFen).turn() === 'w' ? 'white' : 'black'
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
    family: item.family || null,
    skillBands: item.skillBands,
    fixedLearnerColor: item.fixedLearnerColor || null,
    supportsPhysical: Boolean(item.supportsPhysical),
    difficultyBand: item.difficultyBand || null,
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
