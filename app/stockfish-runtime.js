const fs = require('fs');
const path = require('path');
function resolveStockfishPath(override = process.env.STOCKFISH_PATH) {
  return path.resolve(override || path.join(__dirname, '../tools/stockfish/stockfish/stockfish-windows-x86-64-universal.exe'));
}
function requireStockfish(executable) {
  if (!fs.existsSync(executable)) throw new Error(`Native Stockfish 19 not found at ${executable}. Run tools/setup-stockfish.ps1 or set STOCKFISH_PATH.`);
  return executable;
}
module.exports = { resolveStockfishPath, requireStockfish };
