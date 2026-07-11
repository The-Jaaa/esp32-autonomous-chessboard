import { Chess } from 'chess.js';

const g = new Chess();
try {
  const move = g.move({ from: 'e2', to: 'e4', promotion: 'q' });
  console.log('Move successful:', move);
  console.log('Turn:', g.turn());
} catch(e) {
  console.log('Error:', e);
}
