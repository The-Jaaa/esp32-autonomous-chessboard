const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Init Gemini client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const GEMINI_TEXT_MODEL = 'gemini-3.5-flash';
const GEMINI_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const GEMINI_VOICE = 'Aoede';

app.use(cors());
app.use(express.json());

// Serve React production build static assets
app.use(express.static(path.join(__dirname, 'client/dist')));

// Endpoint: Handle accidental GET requests for easier debugging
app.get('/api/esp-move', (req, res) => {
  res.send('The ESP32 move endpoint is active! Please send a POST request with JSON body: { "move": "e2e4" }');
});

// Endpoint: Receive move from ESP32
app.post('/api/esp-move', (req, res) => {
  const { move } = req.body;

  if (!move) {
    return res.status(400).json({ error: 'Move is required in the body (e.g., { "move": "e2e4" })' });
  }

  console.log(`[ESP32] Move received: ${move}`);

  // Broadcast the move to all connected frontend clients
  io.emit('esp-move', move);

  return res.status(200).json({ success: true, message: 'Move broadcasted to frontend' });
});

// Wireless logs endpoint
app.post('/api/log', (req, res) => {
  const { message } = req.body;
  if (message) {
    console.log(`[ESP32 LOG] ${message}`);
  }
  res.sendStatus(200);
});

// Commands queue for ESP32
let pendingCommands = [];

// Endpoint to queue a command from the frontend
app.post('/api/command', (req, res) => {
  const { type, x, y, index, val } = req.body;
  
  let cmdStr = "";
  if (type === 'home') cmdStr = "H";
  else if (type === 'magnet') cmdStr = `M:${val}`;
  else if (type === 'xy') cmdStr = `G:${x},${y}`;
  else if (type === 'square') cmdStr = `S:${index}`;
  else if (type === 'drag') cmdStr = `D:${index}`;
  
  let physicalCommand = null;
  if (type === 'home') {
    physicalCommand = { type: 'home', source: 'diagnostics' };
  } else if (type === 'magnet') {
    physicalCommand = { type: 'diagnostic', action: 'magnet', val: Number(val) ? 1 : 0 };
  } else if (type === 'xy') {
    physicalCommand = { type: 'diagnostic', action: 'xy', x: Number(x), y: Number(y), dragging: false };
  } else if (type === 'square') {
    physicalCommand = { type: 'diagnostic', action: 'square', index: Number(index), dragging: false };
  } else if (type === 'drag') {
    physicalCommand = { type: 'diagnostic', action: 'square', index: Number(index), dragging: true };
  }

  if (physicalCommand) {
    queuePhysicalCommand(physicalCommand);
  }

  if (cmdStr) {
    pendingCommands.push(cmdStr);
    console.log(`[Queue] Command added: ${cmdStr}`);
    return res.json({
      success: true,
      message: `Command '${cmdStr}' queued for diagnostics.`,
      physicalQueued: Boolean(physicalCommand)
    });
  }
  
  res.status(400).json({ error: 'Invalid command type' });
});

// Endpoint for ESP32 to poll commands
app.get('/api/poll', (req, res) => {
  console.log(`[Poll] ESP32 polled. Pending commands queue size: ${pendingCommands.length}`);
  if (pendingCommands.length > 0) {
    const responsePayload = pendingCommands.join('\n');
    console.log(`[Poll] Sending commands to ESP32:`, responsePayload.replace(/\n/g, ', '));
    pendingCommands = []; // Clear queue
    res.type('text/plain');
    return res.send(responsePayload);
  }
  res.type('text/plain');
  res.send('OK');
});


function extractGenerateContentText(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((part) => part.text || '')
    .join('')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractGenerateContentAudio(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return {
        audioBase64: part.inlineData.data,
        mimeType: part.inlineData.mimeType || 'audio/wav'
      };
    }
  }
  return null;
}

function extractInteractionAudio(interaction) {
  const outputs = interaction?.outputs || [];
  for (const output of outputs) {
    if (output?.type === 'audio' && output.data) {
      return {
        audioBase64: output.data,
        mimeType: output.mime_type || 'audio/wav'
      };
    }
  }
  return null;
}

async function synthesizeSpeech(text) {
  const ttsInput = `Say this as a concise, natural chess coach: ${text}`;

  if (ai.interactions?.create) {
    try {
      const interaction = await ai.interactions.create({
        model: GEMINI_TTS_MODEL,
        input: ttsInput,
        response_modalities: ['audio'],
        generation_config: {
          speech_config: [{ voice: GEMINI_VOICE }]
        }
      });

      const audio = extractInteractionAudio(interaction);
      if (audio) return audio;
    } catch (err) {
      console.warn('[Gemini TTS Interactions fallback]', err.message);
    }
  }

  const response = await ai.models.generateContent({
    model: GEMINI_TTS_MODEL,
    contents: ttsInput,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: GEMINI_VOICE
          }
        }
      }
    }
  });

  const audio = extractGenerateContentAudio(response);
  if (audio) return audio;

  throw new Error('Gemini TTS did not return audio output.');
}

// Endpoint: Generate Gemini text advice and synthesize it to audio
app.post('/api/advice', async (req, res) => {
  const { fen, pgn, evaluation, lastMove, bestMove } = req.body;

  if (!fen || typeof evaluation === 'undefined') {
    return res.status(400).json({ error: 'Missing fen or evaluation.' });
  }

  try {
    const prompt = `
You are a Grandmaster chess coach. The user is playing White. They just played ${lastMove || 'a move'}. The current board state in FEN is ${fen}. Stockfish evaluates this position at ${evaluation}. The mathematically best next move is ${bestMove || 'unknown'}. Based strictly on this Stockfish evaluation, tell the user honestly if their last move was good, a mistake, or a blunder. Give them a strategic hint on what to focus on next, but DO NOT tell them the exact best move. Speak naturally and concisely as a human coach.
    `;

    const textResponse = await ai.models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: prompt,
      config: {
        responseModalities: ['TEXT']
      }
    });

    const adviceText = extractGenerateContentText(textResponse) || 'Here is my advice.';
    const { audioBase64, mimeType } = makeBrowserPlayableAudio(await synthesizeSpeech(adviceText));

    console.log("[Gemini Advice]:", adviceText);

    return res.json({
      success: true,
      advice: adviceText,
      audioChunks: [audioBase64],
      mimeType: mimeType
    });

  } catch (error) {
    console.error('[Gemini Advice API Error]', error);
    return res.status(500).json({ error: 'Failed to fetch voice advice' });
  }
});


const { spawn } = require('child_process');
const { Chess } = require('chess.js');

// Helper to run Stockfish locally via Node child process
function runLocalEngine(fen, depth = 5) {
  return new Promise((resolve, reject) => {
    const enginePath = path.join(__dirname, 'node_modules', 'stockfish', 'bin', 'stockfish-18-lite-single.js');
    if (!fs.existsSync(enginePath)) {
      return reject(new Error('stockfish engine JS not found.'));
    }

    const engine = spawn('node', [enginePath]);
    let buffer = '';
    let lastScore = 0.0;
    let lastMate = null;

    engine.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (let line of lines) {
        line = line.trim();

        // Parse evaluation info (e.g., "info depth X ... score cp 35 ...")
        if (line.startsWith('info') && line.includes('score')) {
          const parts = line.split(' ');
          const scoreIdx = parts.indexOf('score');
          if (scoreIdx !== -1) {
            const scoreType = parts[scoreIdx + 1]; // "cp" or "mate"
            const scoreVal = parseInt(parts[scoreIdx + 2], 10);
            
            // Stockfish UCI returns score relative to the side to move.
            // Flip it if it's Black's turn to keep evaluation relative to White.
            const isBlackToMove = fen.includes(' b ');
            const multiplier = isBlackToMove ? -1 : 1;

            if (scoreType === 'cp') {
              lastScore = (scoreVal / 100.0) * multiplier;
              lastMate = null;
            } else if (scoreType === 'mate') {
              lastMate = scoreVal * multiplier;
            }
          }
        }

        if (line.startsWith('bestmove')) {
          const parts = line.split(' ');
          resolve({
            success: true,
            bestmove: `bestmove ${parts[1]}`,
            evaluation: lastScore,
            mate: lastMate
          });
          engine.kill();
          return;
        }
      }
    });

    engine.on('error', (err) => {
      reject(err);
    });

    // Send UCI commands
    engine.stdin.write('uci\n');
    engine.stdin.write('isready\n');
    engine.stdin.write(`position fen ${fen}\n`);
    engine.stdin.write(`go depth ${depth}\n`);
  });
}

const PROFILE_KEYS = new Set(['balanced', 'aggressive', 'defensive', 'trickster', 'chaotic', 'solid']);

function clampLevel(level) {
  const parsed = parseInt(level, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(15, parsed));
}

function normalizeProfile(profile) {
  const key = String(profile || 'balanced').toLowerCase();
  return PROFILE_KEYS.has(key) ? key : 'balanced';
}

function getDifficultyLabel(level) {
  if (level === 1) return 'Complete Beginner';
  if (level === 2) return 'Beginner';
  if (level <= 5) return 'Casual';
  if (level <= 8) return 'Intermediate';
  if (level <= 11) return 'Advanced';
  return 'Expert';
}

function gameResultMessage(game) {
  if (!game?.isGameOver?.()) return null;
  if (game.isCheckmate?.()) {
    return game.turn() === 'w' ? 'Checkmate. Black wins.' : 'Checkmate. White wins.';
  }
  if (game.isStalemate?.()) return 'Draw by stalemate.';
  if (game.isThreefoldRepetition?.()) return 'Draw by threefold repetition.';
  if (game.isInsufficientMaterial?.()) return 'Draw by insufficient material.';
  if (game.isDraw?.()) return 'Draw.';
  return 'Game over.';
}

function findKingSquare(game, color) {
  for (let rank = 1; rank <= 8; rank++) {
    for (const file of FILES) {
      const square = `${file}${rank}`;
      const piece = game.get(square);
      if (piece?.type === 'k' && piece.color === color) return square;
    }
  }
  return null;
}

function buildGameStatus(game) {
  const inCheck = Boolean(game?.isCheck?.());
  const checkmate = Boolean(game?.isCheckmate?.());
  const draw = Boolean(game?.isDraw?.());
  const turn = game?.turn?.() || 'w';
  const checkedKingSquare = inCheck || checkmate ? findKingSquare(game, turn) : null;
  const winner = checkmate ? (turn === 'w' ? 'black' : 'white') : null;

  return {
    inCheck,
    checkmate,
    draw,
    resultText: gameResultMessage(game),
    winner,
    checkedKingSquare,
    whiteKingSquare: findKingSquare(game, 'w'),
    blackKingSquare: findKingSquare(game, 'b')
  };
}

function moveToUci(move) {
  return `${move.from}${move.to}${move.promotion || ''}`;
}

function scoreForWhite(engineResult) {
  if (engineResult.mate !== null && engineResult.mate !== undefined) {
    return engineResult.mate > 0
      ? 1000 - Math.min(100, Math.abs(engineResult.mate))
      : -1000 + Math.min(100, Math.abs(engineResult.mate));
  }
  return Number(engineResult.evaluation) || 0;
}

function weightedPick(items, weightFn) {
  if (items.length === 0) return null;

  const weights = items.map((item) => Math.max(0.01, weightFn(item)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = Math.random() * total;

  for (let i = 0; i < items.length; i++) {
    cursor -= weights[i];
    if (cursor <= 0) return items[i];
  }

  return items[items.length - 1];
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function centerDistance(square) {
  const file = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1], 10) - 1;
  return Math.abs(file - 3.5) + Math.abs(rank - 3.5);
}

function featureMoveWeight(move, profile, level) {
  const san = move.san || '';
  const isCapture = Boolean(move.captured);
  const isCheck = san.includes('+') || san.includes('#');
  const isMate = san.includes('#');
  const isPawn = move.piece === 'p';
  const isQueen = move.piece === 'q';
  const isKing = move.piece === 'k';
  const isKnightOrBishop = move.piece === 'n' || move.piece === 'b';
  const toFile = move.to[0];
  const fromFile = move.from[0];
  const isEdgePawn = isPawn && (toFile === 'a' || toFile === 'h' || fromFile === 'a' || fromFile === 'h');
  const isQuiet = !isCapture && !isCheck;
  const isCastle = move.flags?.includes('k') || move.flags?.includes('q');
  const centerBonus = Math.max(0, 4 - centerDistance(move.to)) * 0.08;
  const lowLevelMultiplier = level <= 2 ? 1.35 : level <= 5 ? 1.1 : 0.75;

  let weight = 1 + centerBonus;

  switch (profile) {
    case 'aggressive':
      if (isCapture) weight += 1.5;
      if (isCheck) weight += 1.8;
      if (isQueen) weight += 1.0 * lowLevelMultiplier;
      if (isPawn && !isEdgePawn) weight += 0.35;
      break;
    case 'defensive':
      if (isCastle) weight += 2.2;
      if (isQuiet) weight += 1.0;
      if (isKing && !isCastle) weight += 0.8;
      if (isPawn && (toFile === 'f' || toFile === 'g' || toFile === 'h')) weight += 0.55;
      if (isQueen && level <= 5) weight -= 0.5;
      break;
    case 'trickster':
      if (isCheck) weight += 2.4;
      if (isCapture) weight += 1.1;
      if (isQueen) weight += 0.9 * lowLevelMultiplier;
      if (isKnightOrBishop) weight += 0.35;
      break;
    case 'chaotic':
      weight += Math.random() * (level <= 2 ? 4.5 : 2.5);
      if (isQueen || isEdgePawn || isKing) weight += 1.1 * lowLevelMultiplier;
      if (isCheck || isCapture) weight += 0.45;
      break;
    case 'solid':
      if (isCastle) weight += 1.5;
      if (isKnightOrBishop) weight += 0.6;
      if (isQueen && level <= 6) weight -= 0.75;
      if (isEdgePawn && level <= 5) weight -= 0.45;
      break;
    default:
      if (isCapture) weight += 0.45;
      if (isCheck) weight += 0.65;
      if (isPawn) weight += 0.15;
      if (isEdgePawn && level <= 2) weight += 0.35;
      if (isQueen && level <= 2) weight += 0.3;
      break;
  }

  if (isMate) weight += 8;
  return Math.max(0.05, weight);
}

function getCandidateConfig(level, profile) {
  const profileRandomness = {
    balanced: 1,
    aggressive: 1.05,
    defensive: 0.85,
    trickster: 1.15,
    chaotic: 1.65,
    solid: 0.45
  }[profile] || 1;

  if (level <= 2) {
    return {
      sampleSize: 0,
      scoreDepth: 0,
      bestChance: Math.min(0.65, (level === 1 ? 0.05 : 0.12) + (profile === 'solid' ? 0.18 : 0) - (profile === 'chaotic' ? 0.03 : 0)),
      randomness: profileRandomness,
      style: 'human-weak-heuristic'
    };
  }

  if (level <= 5) {
    return {
      sampleSize: 8 + (level - 3) * 2,
      scoreDepth: 1,
      targetMinLoss: profile === 'solid' ? 0.15 : 0.45,
      targetMaxLoss: profile === 'chaotic' ? 4.0 : 2.6 - (level - 3) * 0.35,
      randomness: profileRandomness,
      style: 'casual-candidate-mistakes'
    };
  }

  if (level <= 8) {
    return {
      sampleSize: 12 + (level - 6) * 2,
      scoreDepth: 1,
      targetMinLoss: profile === 'solid' ? 0 : 0.1,
      targetMaxLoss: profile === 'chaotic' ? 1.7 : 1.05 - (level - 6) * 0.18,
      randomness: profileRandomness * 0.75,
      style: 'intermediate-near-top'
    };
  }

  if (level <= 11) {
    return {
      sampleSize: 16,
      scoreDepth: 2,
      targetMinLoss: 0,
      targetMaxLoss: profile === 'chaotic' ? 0.8 : 0.45 - (level - 9) * 0.08,
      randomness: profileRandomness * 0.45,
      style: 'advanced-top-candidate'
    };
  }

  return {
    sampleSize: 0,
    scoreDepth: level,
    randomness: 0,
    style: 'expert-stockfish-best'
  };
}

async function scoreCandidateMove(fen, move, sideToMove, scoreDepth) {
  const nextGame = new Chess(fen);
  nextGame.move({ from: move.from, to: move.to, promotion: move.promotion || 'q' });
  const engineResult = await runLocalEngine(nextGame.fen(), scoreDepth);
  const whiteScore = scoreForWhite(engineResult);
  const sideScore = sideToMove === 'w' ? whiteScore : -whiteScore;

  return {
    move,
    uci: moveToUci(move),
    whiteScore,
    sideScore,
    engineResult
  };
}

async function scoreCandidateMoves(fen, moves, sideToMove, scoreDepth, concurrency = 4) {
  const scored = [];

  for (let index = 0; index < moves.length; index += concurrency) {
    const batch = moves.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async (move) => {
      try {
        return await scoreCandidateMove(fen, move, sideToMove, scoreDepth);
      } catch (err) {
        console.warn(`[Engine Move] Failed to score candidate ${moveToUci(move)}:`, err.message);
        return null;
      }
    }));

    scored.push(...results.filter(Boolean));
  }

  return scored;
}

async function chooseEngineMove(fen, levelInput, profileInput) {
  const level = clampLevel(levelInput);
  const profile = normalizeProfile(profileInput);
  const game = new Chess(fen);
  const legalMoves = game.moves({ verbose: true });

  if (legalMoves.length === 0) {
    return {
      success: false,
      error: 'No legal moves available.',
      difficultyLabel: getDifficultyLabel(level),
      profile,
      candidateCount: 0
    };
  }

  const config = getCandidateConfig(level, profile);

  if (level >= 12) {
    const result = await runLocalEngine(fen, level);
    const bestUci = result.bestmove ? result.bestmove.split(' ')[1] : null;
    const legalBest = legalMoves.find((move) => moveToUci(move) === bestUci);
    const selected = legalBest || legalMoves[0];

    return {
      success: true,
      move: moveToUci(selected),
      san: selected.san,
      difficultyLabel: getDifficultyLabel(level),
      profile,
      selectionStyle: config.style,
      candidateCount: legalMoves.length
    };
  }

  if (level <= 2) {
    let selected;

    if (profile === 'solid' && Math.random() < config.bestChance) {
      const best = await runLocalEngine(fen, 1);
      const bestUci = best.bestmove ? best.bestmove.split(' ')[1] : null;
      selected = legalMoves.find((move) => moveToUci(move) === bestUci);
    }

    if (!selected) {
      selected = weightedPick(legalMoves, (move) => featureMoveWeight(move, profile, level) * (0.75 + Math.random() * config.randomness));
    }

    return {
      success: true,
      move: moveToUci(selected),
      san: selected.san,
      difficultyLabel: getDifficultyLabel(level),
      profile,
      selectionStyle: config.style,
      candidateCount: legalMoves.length
    };
  }

  const sideToMove = game.turn();
  const orderedMoves = shuffle(legalMoves).sort((a, b) => featureMoveWeight(b, profile, level) - featureMoveWeight(a, profile, level));
  const sampledMoves = orderedMoves.slice(0, Math.min(config.sampleSize, orderedMoves.length));
  const scored = await scoreCandidateMoves(fen, sampledMoves, sideToMove, config.scoreDepth);

  if (scored.length === 0) {
    const fallback = weightedPick(legalMoves, (move) => featureMoveWeight(move, profile, level));
    return {
      success: true,
      move: moveToUci(fallback),
      san: fallback.san,
      difficultyLabel: getDifficultyLabel(level),
      profile,
      selectionStyle: `${config.style}-fallback`,
      candidateCount: legalMoves.length
    };
  }

  scored.sort((a, b) => b.sideScore - a.sideScore);
  const bestScore = scored[0].sideScore;
  const withLoss = scored.map((candidate) => ({
    ...candidate,
    loss: Math.max(0, bestScore - candidate.sideScore)
  }));

  let pool = withLoss.filter((candidate) => candidate.loss >= config.targetMinLoss && candidate.loss <= config.targetMaxLoss);
  if (pool.length === 0) {
    pool = withLoss.slice(0, Math.max(1, Math.min(4, withLoss.length)));
  }

  const selected = weightedPick(pool, (candidate) => {
    const personality = featureMoveWeight(candidate.move, profile, level);
    const enginePreference = 1 / (1 + candidate.loss);
    const noise = 0.75 + Math.random() * Math.max(0.1, config.randomness);
    return personality * enginePreference * noise;
  });

  return {
    success: true,
    move: selected.uci,
    san: selected.move.san,
    difficultyLabel: getDifficultyLabel(level),
    profile,
    selectionStyle: config.style,
    candidateCount: scored.length
  };
}

// Endpoint: Evaluate position using the local Stockfish engine
app.get('/api/evaluate', async (req, res) => {
  const { fen, depth = 5 } = req.query;

  if (!fen) {
    return res.status(400).json({ error: 'Missing FEN parameter.' });
  }

  try {
    const result = await runLocalEngine(fen, parseInt(depth, 10));
    return res.json(result);
  } catch (err) {
    console.error('[Stockfish Engine Error]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint: Select an engine move using difficulty and personality rules
app.post('/api/engine-move', async (req, res) => {
  const { fen, level = 1, profile = 'balanced' } = req.body || {};

  if (!fen) {
    return res.status(400).json({ success: false, error: 'Missing fen.' });
  }

  try {
    const result = await chooseEngineMove(fen, level, profile);
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('[Engine Move Error]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const FILES = 'abcdefgh';
const PHYSICAL_START_FEN = new Chess().fen();

// Raw ESP square indexes are the physical sensor/LED/gantry indexes, not chess
// board order. This table matches the measured board wiring/orientation:
// 63=a8, 62=a7, 56=a1, 55=b1, 0=h8, and 1=h7.
const PHYSICAL_INDEX_TO_SQUARE = [
  'h8', 'h7', 'h6', 'h5', 'h4', 'h3', 'h2', 'h1',
  'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8',
  'f8', 'f7', 'f6', 'f5', 'f4', 'f3', 'f2', 'f1',
  'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8',
  'd8', 'd7', 'd6', 'd5', 'd4', 'd3', 'd2', 'd1',
  'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8',
  'b8', 'b7', 'b6', 'b5', 'b4', 'b3', 'b2', 'b1',
  'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'
];

const PHYSICAL_SQUARE_TO_INDEX = new Map(
  PHYSICAL_INDEX_TO_SQUARE.map((square, index) => [square, index])
);

const DEFAULT_Z_GRAVEYARD_SLOTS = [
  { label: 'Z1', x: 29300, y: 34450 },
  { label: 'Z2', x: 24800, y: 34450 },
  { label: 'Z3', x: 21300, y: 34450 },
  { label: 'Z4', x: 17300, y: 34450 },
  { label: 'Z5', x: 13300, y: 34450 },
  { label: 'Z6', x: 9300, y: 34450 },
  { label: 'Z7', x: 5300, y: 34450 },
  { label: 'Z8', x: 1300, y: 34450 }
];

const DEFAULT_I_GRAVEYARD_SLOTS = [
  { label: 'I8', x: 1500, y: -350 },
  { label: 'I7', x: 5500, y: -350 },
  { label: 'I6', x: 9500, y: -350 },
  { label: 'I5', x: 13700, y: -350 },
  { label: 'I4', x: 17600, y: -350 },
  { label: 'I3', x: 21600, y: -350 },
  { label: 'I2', x: 25600, y: -350 },
  { label: 'I1', x: 29600, y: -350 }
];

const DEFAULT_GRAVEYARD_SLOTS = [
  ...DEFAULT_Z_GRAVEYARD_SLOTS,
  ...DEFAULT_I_GRAVEYARD_SLOTS
];

function validatePhysicalSquareMap() {
  const seen = new Set(PHYSICAL_INDEX_TO_SQUARE);
  if (PHYSICAL_INDEX_TO_SQUARE.length !== 64 || seen.size !== 64) {
    throw new Error('Physical square map must contain 64 unique chess squares.');
  }

  for (const file of FILES) {
    for (let rank = 1; rank <= 8; rank++) {
      const square = `${file}${rank}`;
      if (!seen.has(square)) {
        throw new Error(`Physical square map is missing ${square}.`);
      }
    }
  }
}

validatePhysicalSquareMap();

const PHYSICAL_LED_COLORS = {
  off: { r: 0, g: 0, b: 0 },
  correct: { r: 0, g: 180, b: 60 },
  missing: { r: 255, g: 32, b: 32 },
  extra: { r: 255, g: 170, b: 0 },
  source: { r: 0, g: 96, b: 255 },
  quiet: { r: 0, g: 220, b: 80 },
  capture: { r: 255, g: 32, b: 32 },
  special: { r: 170, g: 70, b: 255 },
  check: { r: 255, g: 0, b: 0 },
  winner: { r: 0, g: 220, b: 80 },
  draw: { r: 170, g: 70, b: 255 }
};

const PHYSICAL_PROMOTIONS_ENABLED = false;

const physicalSession = {
  active: false,
  phase: 'idle',
  setupMode: 'full',
  game: new Chess(),
  occupancy: Array(64).fill(false),
  selectedSource: null,
  pendingCaptureTarget: null,
  pendingCastleMove: null,
  legalTargets: [],
  level: 1,
  profile: 'balanced',
  graveyardSlots: [],
  nextGraveyardSlot: 0,
  robotGraveyardOccupied: [],
  pendingRobotJob: null,
  moveLog: [],
  pendingUndo: null,
  redoStack: [],
  pendingRedo: null,
  autoRobotReply: true,
  commands: [],
  nextCommandId: 1,
  lastSnapshotAt: null,
  lastCalibrationKey: '',
  lastError: null,
  syncWarningReason: null,
  postRobotSettleGuard: null,
  statusText: 'Physical board idle.',
  lastMove: null
};

const PHYSICAL_LOG_DIR = path.join(__dirname, 'logs');
const PHYSICAL_LOG_MEMORY_LIMIT = 500;
let physicalLogCounter = 1;
const physicalLogs = [];
const completedRobotJobs = new Map();

function indexToSquare(index) {
  const normalized = Number(index);
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 63) return null;

  return PHYSICAL_INDEX_TO_SQUARE[normalized];
}

function squareToIndex(square) {
  if (!/^[a-h][1-8]$/.test(square || '')) return null;

  return PHYSICAL_SQUARE_TO_INDEX.get(square) ?? null;
}

function normalizeOccupancyPayload(body = {}) {
  if (Array.isArray(body.occupancy) && body.occupancy.length === 64) {
    return body.occupancy.map(Boolean);
  }

  if (Array.isArray(body.occupied)) {
    const occupancy = Array(64).fill(false);
    for (const index of body.occupied) {
      const normalized = Number(index);
      if (Number.isInteger(normalized) && normalized >= 0 && normalized < 64) {
        occupancy[normalized] = true;
      }
    }
    return occupancy;
  }

  if (typeof body.bitboard === 'string' && body.bitboard.length >= 64) {
    return body.bitboard.slice(0, 64).split('').map((char) => char === '1');
  }

  return null;
}

function occupancyFromGame(game) {
  const occupancy = Array(64).fill(false);
  const board = game.board();

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (!board[row][col]) continue;
      const square = `${FILES[col]}${8 - row}`;
      const index = squareToIndex(square);
      if (index !== null) occupancy[index] = true;
    }
  }

  return occupancy;
}

function pieceAtStart(square) {
  return new Chess(PHYSICAL_START_FEN).get(square);
}

function physicalStartOccupancy() {
  return occupancyFromGame(new Chess(PHYSICAL_START_FEN));
}

function occupiedIndices(occupancy) {
  return occupancy
    .map((occupied, index) => (occupied ? index : null))
    .filter((index) => index !== null);
}

function diffOccupancy(expected, actual) {
  const missing = [];
  const extra = [];

  for (let index = 0; index < 64; index++) {
    if (expected[index] && !actual[index]) missing.push(index);
    if (!expected[index] && actual[index]) extra.push(index);
  }

  return { missing, extra };
}

function physicalLogFilePath(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return path.join(PHYSICAL_LOG_DIR, `physical-board-${day}.jsonl`);
}

function normalizeLogOccupancy(value) {
  if (!Array.isArray(value)) return null;
  if (value.length === 64 && value.every((item) => typeof item === 'boolean')) {
    return occupiedIndices(value.map(Boolean));
  }
  return value
    .map((index) => Number(index))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < 64);
}

function summarizePendingRobotJob(job = physicalSession.pendingRobotJob) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind || 'robot',
    move: job.uci,
    san: job.san,
    routeMode: job.command?.routeMode || null,
    planStepCount: Array.isArray(job.command?.plan) ? job.command.plan.length : 0
  };
}

function summarizePhysicalCommand(command = {}) {
  const summary = {
    id: command.id,
    type: command.type
  };

  if (command.type === 'move') {
    summary.move = command.move;
    summary.san = command.san;
    summary.from = command.from;
    summary.to = command.to;
    summary.capture = Boolean(command.capture);
    summary.routeMode = command.routeMode || null;
    summary.pathSquares = command.pathSquares || [];
    summary.rawPathSquares = command.rawPathSquares || command.pathSquares || [];
    summary.compressedPathSquares = command.compressedPathSquares || command.pathSquares || [];
    summary.routeCost = command.routeCost ?? null;
    summary.blockedReason = command.blockedReason || null;
    summary.capturePreview = command.capturePreview || null;
    summary.captureStrategy = command.captureStrategy || null;
    summary.captureStrategyRejected = command.captureStrategyRejected || [];
    summary.graveyardRouteScore = command.graveyardRouteScore ?? null;
    summary.planStepCount = Array.isArray(command.plan) ? command.plan.length : 0;
    summary.plan = Array.isArray(command.plan)
      ? command.plan.map((step) => ({
          action: step.action,
          phase: step.phase ?? null,
          to: step.to
            ? step.to.square || step.to.label || `${step.to.x},${step.to.y}`
            : undefined,
          sourceEmpty: step.sourceEmpty,
          targetOccupied: step.targetOccupied
        }))
      : [];
  }

  if (command.type === 'diagnostic') {
    summary.action = command.action;
    summary.index = command.index;
    summary.x = command.x;
    summary.y = command.y;
    summary.dragging = Boolean(command.dragging);
  }

  if (command.type === 'led') {
    summary.mode = command.mode;
    summary.squareCount = Array.isArray(command.squares) ? command.squares.length : 0;
  }

  return summary;
}

function summarizeMotionPlan(command = {}) {
  return {
    id: command.id || null,
    move: command.move || null,
    san: command.san || null,
    routeMode: command.routeMode || null,
    pathSquares: command.pathSquares || [],
    rawPathSquares: command.rawPathSquares || command.pathSquares || [],
    compressedPathSquares: command.compressedPathSquares || command.pathSquares || [],
    routeCost: command.routeCost ?? null,
    blockedReason: command.blockedReason || null,
    capturePreview: command.capturePreview || null,
    captureStrategy: command.captureStrategy || null,
    captureStrategyRejected: command.captureStrategyRejected || [],
    graveyardRouteScore: command.graveyardRouteScore ?? null,
    graveyardRouteCandidates: command.graveyardRouteCandidates || [],
    capture: Boolean(command.capture),
    planStepCount: Array.isArray(command.plan) ? command.plan.length : 0,
    plan: Array.isArray(command.plan)
      ? command.plan.map((step) => ({
          action: step.action,
          phase: step.phase ?? null,
          to: step.to
            ? {
                type: step.to.type,
                square: step.to.square,
                index: step.to.index,
                label: step.to.label,
                lane: step.to.lane,
                rank: step.to.rank,
                x: step.to.x,
                y: step.to.y
              }
            : null,
          sourceEmpty: step.sourceEmpty ?? null,
          targetOccupied: step.targetOccupied ?? null,
          nudgeTargetIndex: step.nudgeTargetIndex ?? null
        }))
      : []
  };
}

function withPhysicalPlanningContext(fen, graveyardSlots, callback) {
  const previous = {
    game: physicalSession.game,
    graveyardSlots: physicalSession.graveyardSlots,
    nextGraveyardSlot: physicalSession.nextGraveyardSlot,
    robotGraveyardOccupied: [...physicalSession.robotGraveyardOccupied],
    active: physicalSession.active
  };

  try {
    physicalSession.game = new Chess(fen);
    physicalSession.graveyardSlots = normalizeGraveyardSlots(graveyardSlots);
    physicalSession.nextGraveyardSlot = 0;
    physicalSession.robotGraveyardOccupied = [];
    physicalSession.active = false;
    return callback(physicalSession.game);
  } finally {
    physicalSession.game = previous.game;
    physicalSession.graveyardSlots = previous.graveyardSlots;
    physicalSession.nextGraveyardSlot = previous.nextGraveyardSlot;
    physicalSession.robotGraveyardOccupied = previous.robotGraveyardOccupied;
    physicalSession.active = previous.active;
  }
}

function rememberCompletedRobotJob(job, result = {}) {
  if (!job?.id) return;
  completedRobotJobs.set(job.id, {
    id: job.id,
    move: job.uci,
    san: job.san,
    completedAt: Date.now(),
    ...result
  });

  if (completedRobotJobs.size > 20) {
    const oldest = [...completedRobotJobs.entries()]
      .sort((a, b) => (a[1].completedAt || 0) - (b[1].completedAt || 0))
      .slice(0, completedRobotJobs.size - 20);
    for (const [id] of oldest) completedRobotJobs.delete(id);
  }
}

function logPhysicalEvent(type, message, options = {}) {
  const timestamp = new Date();
  const expectedOccupancy = options.expectedOccupancy || occupancyFromGame(physicalSession.game);
  const actualOccupancy = options.actualOccupancy || physicalSession.occupancy;
  const diff = options.diff || diffOccupancy(expectedOccupancy, actualOccupancy);
  const expectedOccupied = normalizeLogOccupancy(options.expectedOccupied) || occupiedIndices(expectedOccupancy);
  const actualOccupied = normalizeLogOccupancy(options.actualOccupied) || occupiedIndices(actualOccupancy);
  const missing = normalizeLogOccupancy(diff.missing || []);
  const extra = normalizeLogOccupancy(diff.extra || []);
  const entry = {
    id: `plog-${Date.now()}-${physicalLogCounter++}`,
    timestamp: timestamp.toISOString(),
    level: options.level || (type === 'error' ? 'error' : 'info'),
    phase: physicalSession.phase,
    type,
    message,
    fen: physicalSession.game.fen(),
    moveHistory: physicalSession.game.history(),
    pendingRobotJob: summarizePendingRobotJob(),
    expectedOccupied,
    actualOccupied,
    missing,
    extra,
    missingSquares: missing.map(indexToSquare).filter(Boolean),
    extraSquares: extra.map(indexToSquare).filter(Boolean),
    commandId: options.commandId || null,
    details: options.details || null
  };

  physicalLogs.push(entry);
  if (physicalLogs.length > PHYSICAL_LOG_MEMORY_LIMIT) {
    physicalLogs.splice(0, physicalLogs.length - PHYSICAL_LOG_MEMORY_LIMIT);
  }

  if (process.env.PHYSICAL_LOG_DISABLE === '1') {
    return entry;
  }

  try {
    fs.mkdirSync(PHYSICAL_LOG_DIR, { recursive: true });
    fs.appendFile(physicalLogFilePath(timestamp), `${JSON.stringify(entry)}\n`, (err) => {
      if (err) console.error('[Physical Log Write Error]', err.message);
    });
  } catch (err) {
    console.error('[Physical Log Setup Error]', err.message);
  }

  io.emit('physical-log', entry);
  return entry;
}

function readRecentPhysicalLogs(limit = 200) {
  const normalizedLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  if (physicalLogs.length > 0) {
    return physicalLogs.slice(-normalizedLimit);
  }

  try {
    const logPath = physicalLogFilePath();
    if (!fs.existsSync(logPath)) return [];
    return fs.readFileSync(logPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-normalizedLimit)
      .map((line) => JSON.parse(line));
  } catch (err) {
    console.error('[Physical Log Read Error]', err.message);
    return [];
  }
}

function buildFullCalibrationReport(occupancy) {
  const expected = physicalStartOccupancy();
  const diff = diffOccupancy(expected, occupancy);
  return {
    mode: 'full',
    ready: diff.missing.length === 0 && diff.extra.length === 0,
    missing: diff.missing,
    extra: diff.extra,
    missingSquares: diff.missing.map(indexToSquare),
    extraSquares: diff.extra.map(indexToSquare)
  };
}

function buildPartialCalibrationReport(occupancy) {
  const expectedStart = physicalStartOccupancy();
  const present = [];
  const omitted = [];
  const extra = [];

  for (let index = 0; index < 64; index++) {
    if (expectedStart[index] && occupancy[index]) present.push(index);
    if (expectedStart[index] && !occupancy[index]) omitted.push(index);
    if (!expectedStart[index] && occupancy[index]) extra.push(index);
  }

  const required = [squareToIndex('e1'), squareToIndex('e8')];
  const missingRequired = required.filter((index) => index === null || !occupancy[index]);

  return {
    mode: 'partial',
    ready: extra.length === 0 && missingRequired.length === 0,
    missing: missingRequired,
    extra,
    present,
    omitted,
    missingSquares: missingRequired.map(indexToSquare),
    extraSquares: extra.map(indexToSquare),
    presentSquares: present.map(indexToSquare),
    omittedSquares: omitted.map(indexToSquare)
  };
}

function buildCalibrationReport(occupancy) {
  return physicalSession.setupMode === 'partial'
    ? buildPartialCalibrationReport(occupancy)
    : buildFullCalibrationReport(occupancy);
}

function buildPartialGameFromOccupancy(occupancy) {
  const rows = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = '';
    let empty = 0;

    for (const file of FILES) {
      const square = `${file}${rank}`;
      const index = squareToIndex(square);
      const startPiece = pieceAtStart(square);
      const includePiece = index !== null && occupancy[index] && startPiece;

      if (includePiece) {
        if (empty > 0) {
          row += empty;
          empty = 0;
        }
        row += startPiece.color === 'w' ? startPiece.type.toUpperCase() : startPiece.type;
      } else {
        empty++;
      }
    }

    if (empty > 0) row += empty;
    rows.push(row);
  }

  const rights = [
    occupancy[squareToIndex('e1')] && occupancy[squareToIndex('h1')] ? 'K' : '',
    occupancy[squareToIndex('e1')] && occupancy[squareToIndex('a1')] ? 'Q' : '',
    occupancy[squareToIndex('e8')] && occupancy[squareToIndex('h8')] ? 'k' : '',
    occupancy[squareToIndex('e8')] && occupancy[squareToIndex('a8')] ? 'q' : ''
  ].join('') || '-';

  return `${rows.join('/')} w ${rights} - 0 1`;
}

function serializePhysicalState() {
  const report = buildCalibrationReport(physicalSession.occupancy);
  const expectedCurrent = occupancyFromGame(physicalSession.game);
  const boardDiff = diffOccupancy(expectedCurrent, physicalSession.occupancy);
  const boardReport = {
    ready: boardDiff.missing.length === 0 && boardDiff.extra.length === 0,
    missing: boardDiff.missing,
    extra: boardDiff.extra,
    missingSquares: boardDiff.missing.map(indexToSquare),
    extraSquares: boardDiff.extra.map(indexToSquare)
  };

  return {
    active: physicalSession.active,
    phase: physicalSession.phase,
    setupMode: physicalSession.setupMode,
    statusText: physicalSession.statusText,
    gameStatus: buildGameStatus(physicalSession.game),
    fen: physicalSession.game.fen(),
    pgn: physicalSession.game.pgn(),
    history: physicalSession.game.history(),
    turn: physicalSession.game.turn(),
    occupied: occupiedIndices(physicalSession.occupancy),
    occupancy: physicalSession.occupancy,
    calibration: report,
    board: boardReport,
    selectedSource: physicalSession.selectedSource,
    pendingCaptureTarget: physicalSession.pendingCaptureTarget,
    pendingCastleMove: physicalSession.pendingCastleMove,
    legalTargets: physicalSession.legalTargets,
    robotBusy: physicalSession.phase === 'robot_busy'
      || physicalSession.phase === 'robot_thinking'
      || physicalSession.phase === 'undo_robot_busy'
      || physicalSession.phase === 'redo_robot_busy',
    pendingRobotJob: physicalSession.pendingRobotJob
      ? {
          id: physicalSession.pendingRobotJob.id,
          move: physicalSession.pendingRobotJob.uci,
          san: physicalSession.pendingRobotJob.san,
          kind: physicalSession.pendingRobotJob.kind || 'robot'
        }
      : null,
    pendingUndo: physicalSession.pendingUndo
      ? {
          id: physicalSession.pendingUndo.id,
          mode: physicalSession.pendingUndo.mode,
          remaining: physicalSession.pendingUndo.entries?.length || 0,
          waitingForHumanRestore: physicalSession.pendingUndo.waitingForHumanRestore || null
        }
      : null,
    pendingRedo: physicalSession.pendingRedo
      ? {
          id: physicalSession.pendingRedo.id,
          mode: physicalSession.pendingRedo.mode,
          remaining: physicalSession.pendingRedo.entries?.length || 0,
          currentEntry: physicalSession.pendingRedo.currentEntry || null
        }
      : null,
    canUndoPhysical: physicalSession.active
      && ['ready', 'game_over'].includes(physicalSession.phase)
      && !physicalSession.pendingRobotJob
      && physicalSession.moveLog.length > 0,
    canRedoPhysical: physicalSession.active
      && ['ready', 'game_over'].includes(physicalSession.phase)
      && !physicalSession.pendingRobotJob
      && !physicalSession.pendingUndo
      && !physicalSession.pendingRedo
      && physicalSession.redoStack.length > 0,
    physicalRedoCount: physicalSession.redoStack.length,
    physicalMoveLog: physicalSession.moveLog.map(summarizePhysicalMoveLogEntry),
    lastSnapshotAt: physicalSession.lastSnapshotAt,
    lastError: physicalSession.lastError,
    syncWarningReason: physicalSession.syncWarningReason,
    postRobotSettleGuard: physicalSession.postRobotSettleGuard,
    lastMove: physicalSession.lastMove,
    level: physicalSession.level,
    profile: physicalSession.profile,
    graveyardSlotCount: physicalSession.graveyardSlots.length,
    nextGraveyardSlot: physicalSession.nextGraveyardSlot,
    robotGraveyardOccupied: physicalSession.robotGraveyardOccupied
  };
}

function emitPhysicalState(eventName = 'physical-status', extra = {}) {
  const state = { ...serializePhysicalState(), ...extra };
  io.emit(eventName, state);
  if (eventName !== 'physical-status') io.emit('physical-status', state);
}

function queuePhysicalCommand(command) {
  const queued = {
    id: command.id || `cmd-${Date.now()}-${physicalSession.nextCommandId++}`,
    createdAt: Date.now(),
    ...command
  };
  physicalSession.commands.push(queued);
  if (queued.type !== 'led') {
    logPhysicalEvent('command_queued', `Queued ${queued.type || 'unknown'} command.`, {
      commandId: queued.id,
      details: { command: summarizePhysicalCommand(queued) }
    });
  }
  return queued;
}

function armPostRobotSettleGuard(reason) {
  physicalSession.postRobotSettleGuard = {
    reason,
    armedAt: Date.now()
  };
  queuePhysicalCommand({ type: 'request-snapshot', reason: `post-${reason}-settle` });
}

function clearPostRobotSettleGuard(message) {
  if (!physicalSession.postRobotSettleGuard) return;
  logPhysicalEvent('post_robot_settle_clear', message || 'Post-robot settle guard cleared after clean snapshot.', {
    details: physicalSession.postRobotSettleGuard
  });
  physicalSession.postRobotSettleGuard = null;
}

function queueLedCommand(mode, squares) {
  physicalSession.commands = physicalSession.commands.filter((command) => command.type !== 'led');
  return queuePhysicalCommand({
    type: 'led',
    mode,
    squares
  });
}

function queueRawLedCommand(mode, payload = {}) {
  physicalSession.commands = physicalSession.commands.filter((command) => command.type !== 'led');
  return queuePhysicalCommand({
    type: 'led',
    mode,
    ...payload
  });
}

function makeLedSquare(index, colorName, effect = 'solid') {
  return {
    index,
    square: indexToSquare(index),
    color: PHYSICAL_LED_COLORS[colorName] || PHYSICAL_LED_COLORS.off,
    effect
  };
}

function queueCalibrationLedCommand(report) {
  const key = `${report.mode}|${report.missing.join(',')}|${report.extra.join(',')}|${(report.present || []).join(',')}`;
  if (physicalSession.lastCalibrationKey === key) return;
  physicalSession.lastCalibrationKey = key;
  logPhysicalEvent(report.ready ? 'calibration_ready' : 'calibration_update', report.ready
    ? 'Physical setup calibration is stable.'
    : `Physical setup needs ${report.missing.length} missing and ${report.extra.length} extra squares fixed.`, {
      level: report.ready ? 'info' : 'warning',
      diff: { missing: report.missing || [], extra: report.extra || [] },
      details: {
        mode: report.mode,
        presentSquares: report.presentSquares || [],
        omittedSquares: report.omittedSquares || []
      }
    });

  const expected = physicalStartOccupancy();
  const missingRequired = new Set(report.mode === 'partial' ? report.missing : []);
  const squares = [];
  for (let index = 0; index < 64; index++) {
    if (expected[index] && physicalSession.occupancy[index]) {
      squares.push(makeLedSquare(index, 'correct'));
    } else if (report.mode === 'full' && expected[index] && !physicalSession.occupancy[index]) {
      squares.push(makeLedSquare(index, 'missing', 'pulse'));
    } else if (report.mode === 'partial' && missingRequired.has(index)) {
      squares.push(makeLedSquare(index, 'missing', 'pulse'));
    } else if (!expected[index] && physicalSession.occupancy[index]) {
      squares.push(makeLedSquare(index, 'extra', 'pulse'));
    } else {
      squares.push(makeLedSquare(index, 'off'));
    }
  }
  queueLedCommand('calibration', squares);
}

function queueLegalMoveLedCommand(sourceSquare, legalMoves) {
  const sourceIndex = squareToIndex(sourceSquare);
  const squares = [makeLedSquare(sourceIndex, 'source', 'pulse')];

  for (const move of legalMoves) {
    const targetIndex = squareToIndex(move.to);
    const isSpecial = Boolean(move.promotion) || move.flags?.includes('k') || move.flags?.includes('q') || move.flags?.includes('e');
    const color = isSpecial ? 'special' : move.captured ? 'capture' : 'quiet';
    squares.push(makeLedSquare(targetIndex, color, move.captured ? 'pulse' : 'solid'));
  }

  queueLedCommand('legal-moves', squares);
}

function clearPhysicalLeds() {
  queueLedCommand('clear', Array.from({ length: 64 }, (_, index) => makeLedSquare(index, 'off')));
}

function queueHumanMoveConfirmLedCommand(targetSquare) {
  const index = squareToIndex(targetSquare);
  if (!Number.isInteger(index)) {
    clearPhysicalLeds();
    return null;
  }

  return queueRawLedCommand('human-move-confirm', {
    squares: [makeLedSquare(index, 'quiet', 'confirm')],
    targetIndex: index,
    flashes: 2
  });
}

function runwayPathFromSquares(squares = [], colorName = 'quiet', label = 'path') {
  return {
    label,
    color: PHYSICAL_LED_COLORS[colorName] || PHYSICAL_LED_COLORS.quiet,
    squares: (squares || [])
      .map((square) => ({ square, index: squareToIndex(square) }))
      .filter((item) => Number.isInteger(item.index))
  };
}

function queueRobotPathPreviewLedCommand(command) {
  const preview = command?.capturePreview;
  if (!preview) return null;

  const startSquares = [];
  const attackerStart = preview.attackerSquares?.[0];
  const capturedStart = preview.capturedSquares?.[0];
  if (attackerStart) startSquares.push(makeLedSquare(squareToIndex(attackerStart), 'source', 'pulse'));
  if (capturedStart) startSquares.push(makeLedSquare(squareToIndex(capturedStart), 'capture', 'pulse'));

  const segments = [];
  if (preview.stageSquares?.length > 1) {
    segments.push(runwayPathFromSquares(preview.stageSquares, 'quiet', 'attacker-stage'));
  }
  if (preview.capturedSquares?.length > 1) {
    segments.push(runwayPathFromSquares(preview.capturedSquares, 'special', 'captured-graveyard'));
  }
  if (preview.finalSquares?.length > 1) {
    segments.push(runwayPathFromSquares(preview.finalSquares, 'source', 'attacker-final'));
  }
  if (segments.length === 0 && preview.attackerSquares?.length > 1) {
    segments.push(runwayPathFromSquares(preview.attackerSquares, 'source', 'attacker-direct'));
  }

  return queueRawLedCommand('led-runway', {
    squares: startSquares,
    segments,
    stepDelayMs: 250,
    holdMs: 500,
    clearWhenDone: false
  });
}

function queueGameStatusLedCommand(game = physicalSession.game) {
  const status = buildGameStatus(game);
  if (!status.inCheck && !status.checkmate && !status.draw) return null;

  const squares = [];
  if (status.checkmate) {
    const losingKing = status.checkedKingSquare;
    const winningKing = status.winner === 'white' ? status.whiteKingSquare : status.blackKingSquare;
    if (losingKing) squares.push(makeLedSquare(squareToIndex(losingKing), 'check', 'loser'));
    if (winningKing) squares.push(makeLedSquare(squareToIndex(winningKing), 'winner', 'winner'));
    return queueLedCommand('celebrate-checkmate', squares);
  }

  if (status.draw) {
    if (status.whiteKingSquare) squares.push(makeLedSquare(squareToIndex(status.whiteKingSquare), 'draw', 'pulse'));
    if (status.blackKingSquare) squares.push(makeLedSquare(squareToIndex(status.blackKingSquare), 'draw', 'pulse'));
    return queueLedCommand(status.resultText?.toLowerCase().includes('stalemate') ? 'celebrate-stalemate' : 'celebrate-draw', squares);
  }

  if (status.checkedKingSquare) {
    squares.push(makeLedSquare(squareToIndex(status.checkedKingSquare), 'check', 'flash'));
    return queueLedCommand('check', squares);
  }

  return null;
}

function setPhysicalError(message, details = {}) {
  physicalSession.phase = 'error';
  physicalSession.lastError = { message, details, at: Date.now() };
  physicalSession.syncWarningReason = null;
  physicalSession.pendingCastleMove = null;
  physicalSession.statusText = message;
  queueLedCommand('error', details.index !== undefined ? [makeLedSquare(details.index, 'check', 'flash')] : []);
  logPhysicalEvent('error', message, {
    level: 'error',
    commandId: details.id || details.commandId || null,
    diff: details.missing || details.extra ? { missing: details.missing || [], extra: details.extra || [] } : undefined,
    details
  });
  emitPhysicalState('physical-error', { error: physicalSession.lastError });
}

function queueBoardSyncWarningLedCommand(diff) {
  const squares = [
    ...diff.missing.map((index) => makeLedSquare(index, 'extra', 'pulse')),
    ...diff.extra.map((index) => makeLedSquare(index, 'extra', 'pulse'))
  ];
  queueLedCommand('sync-warning', squares);
}

function setPhysicalSyncWarning(message, diff = {}) {
  physicalSession.phase = 'sync_warning';
  physicalSession.lastError = null;
  physicalSession.syncWarningReason = diff.reason || null;
  physicalSession.pendingCastleMove = null;
  physicalSession.statusText = message;
  queueBoardSyncWarningLedCommand({
    missing: diff.missing || [],
    extra: diff.extra || []
  });
  logPhysicalEvent('sync_warning', message, {
    level: 'warning',
    commandId: diff.commandId || null,
    diff: { missing: diff.missing || [], extra: diff.extra || [] },
    details: diff
  });
  emitPhysicalState('physical-board', { syncWarning: diff });
}

function parseUciToMove(uci) {
  if (!uci || uci.length < 4) return null;
  return {
    from: uci.substring(0, 2),
    to: uci.substring(2, 4),
    promotion: uci.length > 4 ? uci.substring(4, 5) : 'q'
  };
}

function legalMoveMatchesUci(move, uci) {
  return moveToUci(move) === uci;
}

function legalMovesForSource(game, sourceSquare) {
  return game.moves({ square: sourceSquare, verbose: true })
    .filter(isPhysicalMoveAllowed);
}

function isPhysicalMoveAllowed(move) {
  if (!PHYSICAL_PROMOTIONS_ENABLED && move.promotion) return false;
  return true;
}

function castleRookMove(move) {
  if (!move.flags?.includes('k') && !move.flags?.includes('q')) return null;

  const rank = move.color === 'w' ? '1' : '8';
  if (move.to[0] === 'g') {
    return { from: `h${rank}`, to: `f${rank}`, fromIndex: squareToIndex(`h${rank}`), toIndex: squareToIndex(`f${rank}`) };
  }
  return { from: `a${rank}`, to: `d${rank}`, fromIndex: squareToIndex(`a${rank}`), toIndex: squareToIndex(`d${rank}`) };
}

function capturedSquareForMove(move) {
  if (!move.captured) return null;
  if (move.flags?.includes('e')) return `${move.to[0]}${move.from[1]}`;
  return move.to;
}

function occupancyFromFen(fen) {
  return occupancyFromGame(new Chess(fen));
}

function summarizePhysicalMoveLogEntry(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    side: entry.side,
    move: entry.uci,
    san: entry.san,
    from: entry.from,
    to: entry.to,
    capturedSquare: entry.capturedSquare || null,
    capturedPiece: entry.capturedPiece || null,
    robotGraveyardSlot: entry.robotGraveyardSlot?.label || null,
    verified: Boolean(entry.verified)
  };
}

function buildPhysicalMoveLogEntry(side, move, beforeFen, afterFen, extra = {}) {
  const capturedSquare = capturedSquareForMove(move);
  const castle = castleRookMove(move);
  return {
    id: `pmove-${Date.now()}-${physicalSession.moveLog.length + 1}`,
    side,
    beforeFen,
    afterFen,
    uci: moveToUci(move),
    san: move.san,
    color: move.color,
    piece: move.piece,
    from: move.from,
    to: move.to,
    flags: move.flags || '',
    promotion: move.promotion || null,
    capturedSquare,
    capturedPiece: move.captured || null,
    castleRookMove: castle,
    enPassantCapturedSquare: move.flags?.includes('e') ? capturedSquare : null,
    robotGraveyardSlot: extra.robotGraveyardSlot || null,
    robotCapturedPathSquares: extra.robotCapturedPathSquares || [],
    verified: extra.verified !== false,
    createdAt: Date.now()
  };
}

function clonePhysicalMoveLogEntry(entry) {
  if (!entry) return null;
  return {
    ...entry,
    castleRookMove: entry.castleRookMove ? { ...entry.castleRookMove } : null,
    robotGraveyardSlot: entry.robotGraveyardSlot ? { ...entry.robotGraveyardSlot } : null,
    robotCapturedPathSquares: Array.isArray(entry.robotCapturedPathSquares)
      ? [...entry.robotCapturedPathSquares]
      : []
  };
}

function recordPhysicalMove(side, move, beforeFen, afterFen, extra = {}) {
  if (!extra.preserveRedo) {
    physicalSession.redoStack = [];
    physicalSession.pendingRedo = null;
  }
  const entry = buildPhysicalMoveLogEntry(side, move, beforeFen, afterFen, extra);
  physicalSession.moveLog.push(entry);
  return entry;
}

function removePhysicalMoveLogEntry(entry) {
  const index = physicalSession.moveLog.findIndex((item) => item.id === entry?.id);
  if (index >= 0) {
    physicalSession.moveLog.splice(index, 1);
  }
}

function occupancyMatchesAfterMove(game, move, occupancy) {
  const copy = new Chess(game.fen());
  copy.move({ from: move.from, to: move.to, promotion: move.promotion || 'q' });
  const expected = occupancyFromGame(copy);
  const diff = diffOccupancy(expected, occupancy);
  return diff.missing.length === 0 && diff.extra.length === 0;
}

function castleKingLooksPlaced(move, occupancy) {
  if (!move.flags?.includes('k') && !move.flags?.includes('q')) return false;
  const sourceIndex = squareToIndex(move.from);
  const targetIndex = squareToIndex(move.to);
  if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex)) return false;
  return !occupancy[sourceIndex] && occupancy[targetIndex];
}

function queueCastleRookLedCommand(move) {
  const rook = castleRookMove(move);
  if (!rook) return null;

  const squares = [
    makeLedSquare(squareToIndex(move.to), 'source', 'pulse'),
    makeLedSquare(rook.fromIndex, 'source', 'pulse'),
    makeLedSquare(rook.toIndex, 'special', 'pulse')
  ];
  return queueLedCommand('castle-rook', squares);
}

function setPendingCastleMove(move) {
  const rook = castleRookMove(move);
  physicalSession.pendingCastleMove = {
    move: moveToUci(move),
    san: move.san,
    from: move.from,
    to: move.to,
    rook
  };
  physicalSession.phase = 'castle_pending_rook';
  physicalSession.selectedSource = rook?.from || null;
  physicalSession.pendingCaptureTarget = null;
  physicalSession.legalTargets = rook
    ? [{
        move: moveToUci(move),
        from: rook.from,
        to: rook.to,
        index: rook.toIndex,
        capture: false,
        special: true
      }]
    : [];
  physicalSession.statusText = rook
    ? `King placed on ${move.to}. Move rook from ${rook.from} to ${rook.to} to finish castling.`
    : `King placed on ${move.to}. Finish the castling rook move.`;
  logPhysicalEvent('castle_pending_rook', physicalSession.statusText, {
    details: {
      move: moveToUci(move),
      san: move.san,
      rook
    }
  });
  queueCastleRookLedCommand(move);
  emitPhysicalState('physical-board');
}

function moveLooksComplete(move, occupancy) {
  const sourceIndex = squareToIndex(move.from);
  const targetIndex = squareToIndex(move.to);
  if (sourceIndex === null || targetIndex === null) return false;

  if (move.flags?.includes('k') || move.flags?.includes('q') || move.flags?.includes('e')) {
    return occupancyMatchesAfterMove(physicalSession.game, move, occupancy);
  }

  if (!move.captured) {
    return !occupancy[sourceIndex] && occupancy[targetIndex];
  }

  return physicalSession.pendingCaptureTarget === move.to && !occupancy[sourceIndex] && occupancy[targetIndex];
}

async function finalizeHumanPhysicalMove(move, occupancy) {
  const beforeFen = physicalSession.game.fen();
  const applied = physicalSession.game.move({ from: move.from, to: move.to, promotion: move.promotion || 'q' });
  if (!applied) {
    setPhysicalError(`Rejected physical move ${moveToUci(move)} as illegal.`, { move: moveToUci(move) });
    return;
  }
  const afterFen = physicalSession.game.fen();

  physicalSession.occupancy = occupancy;
  physicalSession.selectedSource = null;
  physicalSession.pendingCaptureTarget = null;
  physicalSession.pendingCastleMove = null;
  physicalSession.legalTargets = [];
  physicalSession.syncWarningReason = null;
  physicalSession.lastMove = { side: 'human', move: moveToUci(applied), san: applied.san, at: Date.now() };
  recordPhysicalMove('human', applied, beforeFen, afterFen, { verified: true });
  logPhysicalEvent('human_move', `Human physical move accepted: ${applied.san}.`, {
    details: {
      move: moveToUci(applied),
      san: applied.san
    }
  });
  queueHumanMoveConfirmLedCommand(applied.to);
  queueGameStatusLedCommand(physicalSession.game);

  emitPhysicalState('physical-move', {
    side: 'human',
    move: moveToUci(applied),
    san: applied.san
  });

  if (physicalSession.game.isGameOver()) {
    const message = gameResultMessage(physicalSession.game) || 'Game over.';
    physicalSession.phase = 'game_over';
    physicalSession.statusText = message;
    logPhysicalEvent('game_over', message, {
      details: {
        result: message,
        afterMove: moveToUci(applied),
        san: applied.san
      }
    });
    emitPhysicalState();
    return;
  }

  if (physicalSession.game.turn() === 'b' && physicalSession.autoRobotReply !== false) {
    physicalSession.phase = 'robot_thinking';
    physicalSession.statusText = 'Move accepted. Engine will choose a physical reply.';
    emitPhysicalState();
    setTimeout(() => {
      queueRobotReply().catch((err) => {
        setPhysicalError(err.message || String(err));
      });
    }, 0);
  } else {
    physicalSession.phase = 'ready';
    physicalSession.statusText = 'Waiting for your move.';
    emitPhysicalState();
  }
}

function normalizeGraveyardSlots(slots) {
  const inputSlots = Array.isArray(slots) && slots.length > 0
    ? slots
    : DEFAULT_GRAVEYARD_SLOTS;

  return inputSlots
    .map((slot, index) => {
      const rawLabel = String(slot.label || `Graveyard ${index + 1}`).trim();
      const capturedMatch = rawLabel.match(/^captured\s*([1-8])$/i);
      const label = capturedMatch ? `Z${capturedMatch[1]}` : rawLabel;
      const laneMatch = label.match(/^([zi])\s*([1-8])$/i);
      return {
        id: slot.id || `graveyard-${index + 1}`,
        label,
        key: label.toUpperCase() || slot.id || `graveyard-${index + 1}`,
        x: Number(slot.x),
        y: Number(slot.y),
        lane: laneMatch ? laneMatch[1].toUpperCase() : null,
        rank: laneMatch ? Number(laneMatch[2]) : null
      };
    })
    .filter((slot) => Number.isFinite(slot.x) && Number.isFinite(slot.y));
}

function findStagingSquareCandidates(game, move) {
  if (!move.captured) return null;

  const targetFile = FILES.indexOf(move.to[0]);
  const targetRank = Number(move.to[1]);
  const candidates = [];

  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      const fileIndex = targetFile + df;
      const rank = targetRank + dr;
      if (fileIndex < 0 || fileIndex > 7 || rank < 1 || rank > 8) continue;

      const square = `${FILES[fileIndex]}${rank}`;
      if (square === move.from || square === move.to) continue;
      if (!game.get(square)) {
        candidates.push({
          square,
          index: squareToIndex(square),
          distance: Math.abs(df) + Math.abs(dr)
        });
      }
    }
  }

  if (candidates.length === 0) {
    for (let rank = 1; rank <= 8; rank++) {
      for (let fileIndex = 0; fileIndex < 8; fileIndex++) {
        const square = `${FILES[fileIndex]}${rank}`;
        if (square === move.from || square === move.to || game.get(square)) continue;
        candidates.push({
          square,
          index: squareToIndex(square),
          distance: Math.abs(fileIndex - targetFile) + Math.abs(rank - targetRank)
        });
      }
    }
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates;
}

function findStagingSquare(game, move) {
  return findStagingSquareCandidates(game, move)?.[0] || null;
}

function graveyardSlotKey(slot) {
  return String(slot?.key || slot?.label || slot?.id || '').toUpperCase();
}

function middleOutRankDistance(rank) {
  const order = [4, 5, 3, 6, 2, 7, 1, 8];
  const index = order.indexOf(Number(rank));
  return index === -1 ? order.length : index;
}

function sortedRobotGraveyardSlots() {
  return physicalSession.graveyardSlots
    .slice()
    .sort((a, b) => {
      const laneA = a.lane || 'Z';
      const laneB = b.lane || 'Z';
      if (laneA !== laneB) return laneA === 'Z' ? -1 : 1;
      const middleDistance = middleOutRankDistance(a.rank) - middleOutRankDistance(b.rank);
      if (middleDistance !== 0) return middleDistance;
      return String(a.label).localeCompare(String(b.label));
    });
}

function isRobotGraveyardSlotOccupied(slot) {
  const key = graveyardSlotKey(slot);
  return key && physicalSession.robotGraveyardOccupied.includes(key);
}

function reserveRobotGraveyardSlot(slot) {
  const key = graveyardSlotKey(slot);
  if (key && !physicalSession.robotGraveyardOccupied.includes(key)) {
    physicalSession.robotGraveyardOccupied.push(key);
  }
}

function releaseRobotGraveyardSlot(slot) {
  const key = graveyardSlotKey(slot);
  if (!key) return;
  physicalSession.robotGraveyardOccupied = physicalSession.robotGraveyardOccupied.filter((item) => item !== key);
}

function squareFileIndex(square) {
  return FILES.indexOf(square?.[0]);
}

function squareRank(square) {
  return Number(square?.[1]);
}

function squareTarget(square) {
  return {
    type: 'square',
    square,
    index: squareToIndex(square)
  };
}

function squareFromFileRank(fileIndex, rank) {
  if (fileIndex < 0 || fileIndex > 7 || rank < 1 || rank > 8) return null;
  return `${FILES[fileIndex]}${rank}`;
}

function boardPlanningOccupancy(game, ignoredSquares = []) {
  const ignored = new Set(ignoredSquares.filter(Boolean));
  const expected = occupancyFromGame(game);
  const occupancy = expected.slice();

  if (physicalSession.active && Array.isArray(physicalSession.occupancy)) {
    for (let index = 0; index < 64; index++) {
      occupancy[index] = Boolean(occupancy[index] || physicalSession.occupancy[index]);
    }
  }

  for (const square of ignored) {
    const index = squareToIndex(square);
    if (Number.isInteger(index)) occupancy[index] = false;
  }

  return occupancy;
}

function isSquareOccupiedForPlanning(occupancy, square) {
  const index = squareToIndex(square);
  return Number.isInteger(index) ? Boolean(occupancy[index]) : true;
}

function adjacentOccupiedCount(occupancy, square, ignoredSquares = []) {
  const ignored = new Set(ignoredSquares.filter(Boolean));
  const file = squareFileIndex(square);
  const rank = squareRank(square);
  let count = 0;

  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      const neighbor = squareFromFileRank(file + df, rank + dr);
      if (!neighbor || ignored.has(neighbor)) continue;
      if (isSquareOccupiedForPlanning(occupancy, neighbor)) count++;
    }
  }

  return count;
}

function movementCornerIsBlocked(occupancy, from, to, ignoredSquares = []) {
  const ignored = new Set(ignoredSquares.filter(Boolean));
  const fromFile = squareFileIndex(from);
  const fromRank = squareRank(from);
  const toFile = squareFileIndex(to);
  const toRank = squareRank(to);
  const df = Math.sign(toFile - fromFile);
  const dr = Math.sign(toRank - fromRank);
  if (Math.abs(df) !== 1 || Math.abs(dr) !== 1) return false;

  const sideA = squareFromFileRank(fromFile + df, fromRank);
  const sideB = squareFromFileRank(fromFile, fromRank + dr);
  return Boolean(
    sideA && sideB
    && !ignored.has(sideA)
    && !ignored.has(sideB)
    && isSquareOccupiedForPlanning(occupancy, sideA)
    && isSquareOccupiedForPlanning(occupancy, sideB)
  );
}

function squareStepDirection(fromSquare, toSquare) {
  return {
    file: Math.sign(squareFileIndex(toSquare) - squareFileIndex(fromSquare)),
    rank: Math.sign(squareRank(toSquare) - squareRank(fromSquare))
  };
}

function sameStepDirection(a, b) {
  return a.file === b.file && a.rank === b.rank;
}

function compressPathSquares(squares = []) {
  if (!Array.isArray(squares) || squares.length <= 2) return squares.slice();

  const compressed = [squares[0]];
  let previousDirection = squareStepDirection(squares[0], squares[1]);

  for (let index = 2; index < squares.length; index++) {
    const direction = squareStepDirection(squares[index - 1], squares[index]);
    if (!sameStepDirection(previousDirection, direction)) {
      compressed.push(squares[index - 1]);
    }
    previousDirection = direction;
  }

  compressed.push(squares[squares.length - 1]);
  return compressed;
}

function clearChessLinePath(game, fromSquare, toSquare, options = {}) {
  const path = pathSquaresBetween(fromSquare, toSquare);
  if (!path) return null;

  const ignoredSquares = [
    fromSquare,
    ...(options.allowOccupiedTarget === false ? [] : [toSquare]),
    ...(options.ignoredSquares || [])
  ].filter(Boolean);
  const ignored = new Set(ignoredSquares);
  const occupancy = boardPlanningOccupancy(game, ignoredSquares);
  const squares = [fromSquare, ...path];

  for (let index = 1; index < squares.length; index++) {
    const square = squares[index];
    if (!ignored.has(square) && isSquareOccupiedForPlanning(occupancy, square)) return null;
  }

  const direction = squareStepDirection(fromSquare, toSquare);
  const diagonal = direction.file !== 0 && direction.rank !== 0;
  return {
    squares,
    cost: path.length * (diagonal ? 14 : 10),
    mode: squares.length <= 2 ? 'board-direct' : 'board-line'
  };
}

function findBoardPath(game, fromSquare, toSquare, options = {}) {
  const ignoredSquares = [
    fromSquare,
    ...(options.allowOccupiedTarget === false ? [] : [toSquare]),
    ...(options.ignoredSquares || [])
  ].filter(Boolean);
  const ignored = new Set(ignoredSquares);
  const occupancy = boardPlanningOccupancy(game, ignoredSquares);
  const buffered = options.buffered !== false;
  const open = new Map();
  const closed = new Set();
  const start = {
    square: fromSquare,
    path: [fromSquare],
    cost: 0,
    score: Math.abs(squareFileIndex(fromSquare) - squareFileIndex(toSquare))
      + Math.abs(squareRank(fromSquare) - squareRank(toSquare))
  };

  open.set(fromSquare, start);

  while (open.size > 0) {
    let current = null;
    for (const candidate of open.values()) {
      if (!current || candidate.score < current.score) current = candidate;
    }

    open.delete(current.square);
    if (current.square === toSquare) {
      return {
        squares: current.path,
        cost: current.cost,
        mode: buffered ? 'board-buffered' : 'board-relaxed'
      };
    }

    closed.add(current.square);
    const file = squareFileIndex(current.square);
    const rank = squareRank(current.square);

    for (let df = -1; df <= 1; df++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (df === 0 && dr === 0) continue;
        const nextSquare = squareFromFileRank(file + df, rank + dr);
        if (!nextSquare || closed.has(nextSquare)) continue;
        if (!ignored.has(nextSquare) && isSquareOccupiedForPlanning(occupancy, nextSquare)) continue;
        const adjacentCount = adjacentOccupiedCount(occupancy, nextSquare, ignoredSquares);

        const diagonal = df !== 0 && dr !== 0;
        const stepCost = diagonal ? 14 : 10;
        const bufferPenalty = buffered ? adjacentCount * 10 : 0;
        const nextCost = current.cost + stepCost + bufferPenalty;
        const heuristic = (Math.abs(squareFileIndex(nextSquare) - squareFileIndex(toSquare))
          + Math.abs(squareRank(nextSquare) - squareRank(toSquare))) * 10;
        const existing = open.get(nextSquare);

        if (!existing || nextCost < existing.cost) {
          open.set(nextSquare, {
            square: nextSquare,
            path: [...current.path, nextSquare],
            cost: nextCost,
            score: nextCost + heuristic
          });
        }
      }
    }
  }

  return null;
}

function findBestBoardPath(game, fromSquare, toSquare, options = {}) {
  return findBoardPath(game, fromSquare, toSquare, { ...options, buffered: true })
    || findBoardPath(game, fromSquare, toSquare, { ...options, buffered: false });
}

function coordinateTarget(slot, role = 'lane') {
  if (!slot) return null;
  return {
    type: 'coordinate',
    role,
    label: slot.label,
    lane: slot.lane || null,
    rank: slot.rank || null,
    x: slot.x,
    y: slot.y
  };
}

function planTargetKey(target) {
  if (!target) return 'none';
  if (target.type === 'square') return `square:${target.index}`;
  return `coord:${target.label || `${target.x},${target.y}`}`;
}

function dedupePlanTargets(targets) {
  const result = [];
  const seen = new Set();
  for (const target of targets) {
    if (!target) continue;
    const key = planTargetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
  }
  return result;
}

function laneSlots(lane) {
  return physicalSession.graveyardSlots
    .filter((slot) => slot.lane === lane && !isRobotGraveyardSlotOccupied(slot))
    .sort((a, b) => a.rank - b.rank);
}

function preferredLaneForSquare(square) {
  const file = squareFileIndex(square);
  return file <= 3 ? 'Z' : 'I';
}

function sortedLaneCandidates(square, preferredLane = preferredLaneForSquare(square)) {
  const rank = squareRank(square);
  const candidates = [
    ...laneSlots(preferredLane),
    ...laneSlots(preferredLane === 'Z' ? 'I' : 'Z')
  ];

  return candidates
    .slice()
    .sort((a, b) => {
      const rankDistance = Math.abs((a.rank || rank) - rank) - Math.abs((b.rank || rank) - rank);
      if (rankDistance !== 0) return rankDistance;
      if (a.lane === preferredLane && b.lane !== preferredLane) return -1;
      if (a.lane !== preferredLane && b.lane === preferredLane) return 1;
      return String(a.label).localeCompare(String(b.label));
    });
}

function laneSlotTransitClear(fromSlot, toSlot) {
  if (!fromSlot || !toSlot || fromSlot.lane !== toSlot.lane) return false;
  const fromRank = Number(fromSlot.rank);
  const toRank = Number(toSlot.rank);
  if (!Number.isInteger(fromRank) || !Number.isInteger(toRank)) return false;

  const minRank = Math.min(fromRank, toRank);
  const maxRank = Math.max(fromRank, toRank);
  return physicalSession.graveyardSlots.every((slot) => {
    if (slot.lane !== fromSlot.lane || !isRobotGraveyardSlotOccupied(slot)) return true;
    const rank = Number(slot.rank);
    return !Number.isInteger(rank) || rank <= minRank || rank >= maxRank;
  });
}

function chooseLaneSlot(square, preferredLane = preferredLaneForSquare(square)) {
  const candidates = sortedLaneCandidates(square, preferredLane);
  if (candidates.length === 0) return null;

  return candidates[0];
}

function lanePathSquares(square, lane) {
  const file = squareFileIndex(square);
  const rank = squareRank(square);
  if (file < 0 || !Number.isInteger(rank)) return [];

  const direction = lane === 'Z' ? -1 : 1;
  const squares = [];
  for (let fileIndex = file + direction; fileIndex >= 0 && fileIndex <= 7; fileIndex += direction) {
    squares.push(`${FILES[fileIndex]}${rank}`);
  }
  return squares;
}

function lanePathClear(game, square, lane, ignoredSquares = []) {
  const ignored = new Set(ignoredSquares.filter(Boolean));
  return lanePathSquares(square, lane)
    .every((pathSquare) => ignored.has(pathSquare) || !game.get(pathSquare));
}

function chooseClearLaneSlot(game, square, preferredLane = preferredLaneForSquare(square), ignoredSquares = []) {
  const candidates = sortedLaneCandidates(square, preferredLane);
  if (candidates.length === 0) return null;

  return candidates.find((slot) => lanePathClear(game, square, slot.lane, ignoredSquares)) || null;
}

function pathSquaresBetween(from, to) {
  const fromFile = squareFileIndex(from);
  const toFile = squareFileIndex(to);
  const fromRank = squareRank(from);
  const toRank = squareRank(to);
  const df = Math.sign(toFile - fromFile);
  const dr = Math.sign(toRank - fromRank);
  const fileDistance = Math.abs(toFile - fromFile);
  const rankDistance = Math.abs(toRank - fromRank);

  if (fromFile !== toFile && fromRank !== toRank && fileDistance !== rankDistance) {
    return null;
  }

  const squares = [];
  let file = fromFile;
  let rank = fromRank;
  do {
    file += df;
    rank += dr;
    squares.push(`${FILES[file]}${rank}`);
  } while (file !== toFile || rank !== toRank);
  return squares;
}

function corridorHasNearbyPieces(game, from, to, ignoredSquares = []) {
  const ignored = new Set(ignoredSquares);
  const minFile = Math.max(0, Math.min(squareFileIndex(from), squareFileIndex(to)) - 1);
  const maxFile = Math.min(7, Math.max(squareFileIndex(from), squareFileIndex(to)) + 1);
  const minRank = Math.max(1, Math.min(squareRank(from), squareRank(to)) - 1);
  const maxRank = Math.min(8, Math.max(squareRank(from), squareRank(to)) + 1);

  for (let file = minFile; file <= maxFile; file++) {
    for (let rank = minRank; rank <= maxRank; rank++) {
      const square = `${FILES[file]}${rank}`;
      if (!ignored.has(square) && game.get(square)) return true;
    }
  }
  return false;
}

function isSimplePawnPush(move) {
  if (move.piece !== 'p' || move.captured || move.flags?.includes('e')) return false;
  const fileDistance = Math.abs(squareFileIndex(move.to) - squareFileIndex(move.from));
  const rankDistance = Math.abs(squareRank(move.to) - squareRank(move.from));
  return fileDistance === 0 && rankDistance >= 1 && rankDistance <= 2;
}

function isShortQuietMove(move) {
  if (move.captured || move.flags?.includes('e') || move.flags?.includes('k') || move.flags?.includes('q')) return false;
  const fileDistance = Math.abs(squareFileIndex(move.to) - squareFileIndex(move.from));
  const rankDistance = Math.abs(squareRank(move.to) - squareRank(move.from));
  return Math.max(fileDistance, rankDistance) === 1;
}

function directRouteSafe(game, move) {
  if (move.captured || move.flags?.includes('k') || move.flags?.includes('q')) return false;

  const fileDistance = Math.abs(squareFileIndex(move.to) - squareFileIndex(move.from));
  const rankDistance = Math.abs(squareRank(move.to) - squareRank(move.from));
  const isKnightMove = (fileDistance === 1 && rankDistance === 2) || (fileDistance === 2 && rankDistance === 1);
  if (isKnightMove) {
    return !game.get(move.to);
  }

  const path = pathSquaresBetween(move.from, move.to);
  if (!path) return false;
  if (path.some((square) => game.get(square))) return false;

  return true;
}

function withPlanPhase(step, phase) {
  return phase ? { ...step, phase } : step;
}

function makeTransferSteps(fromTarget, dragTargets, verify = {}, options = {}) {
  const phase = options.phase || null;
  const steps = [
    withPlanPhase({ action: 'travel', to: fromTarget }, phase),
    withPlanPhase({ action: 'pickup' }, phase),
    ...dedupePlanTargets(dragTargets).map((target) => withPlanPhase({ action: 'drag', to: target }, phase)),
    withPlanPhase({ action: 'drop', nudgeTargetIndex: Number.isInteger(verify.targetOccupied) ? verify.targetOccupied : null }, phase),
    {
      action: 'verify',
      phase,
      sourceEmpty: Number.isInteger(verify.sourceEmpty) ? verify.sourceEmpty : null,
      targetOccupied: Number.isInteger(verify.targetOccupied) ? verify.targetOccupied : null
    }
  ];
  return steps;
}

function laneRouteTargets(game, fromSquare, toSquare, preferredLane = preferredLaneForSquare(fromSquare), ignoredSquares = []) {
  const sourceLaneSlot = chooseClearLaneSlot(game, fromSquare, preferredLane, ignoredSquares);
  if (!sourceLaneSlot) return [];

  const targetLaneSlot = chooseClearLaneSlot(game, toSquare, sourceLaneSlot.lane || preferredLane, ignoredSquares);
  if (!targetLaneSlot) return [];

  return dedupePlanTargets([
    coordinateTarget(sourceLaneSlot, 'lane'),
    coordinateTarget(targetLaneSlot, 'lane'),
    squareTarget(toSquare)
  ]);
}

function laneBoardRoute(game, fromSquare, toSquare, preferredLane = preferredLaneForSquare(fromSquare), ignoredSquares = []) {
  const ignored = [fromSquare, toSquare, ...(ignoredSquares || [])].filter(Boolean);
  const fromRank = squareRank(fromSquare);
  const sourceSlots = sortedLaneCandidates(fromSquare, preferredLane)
    .filter((slot) => Number(slot.rank) === fromRank)
    .filter((slot) => lanePathClear(game, fromSquare, slot.lane, ignored));
  const candidates = [];
  const failures = [];

  for (const sourceSlot of sourceSlots) {
    const entrySlots = sortedLaneCandidates(toSquare, sourceSlot.lane)
      .filter((slot) => slot.lane === sourceSlot.lane && laneSlotTransitClear(sourceSlot, slot));

    for (const entrySlot of entrySlots) {
      const entrySquare = laneExitSquareForSlot(entrySlot);
      if (!entrySquare) {
        failures.push({ slot: entrySlot.label, error: 'Lane slot has no matching board edge square.' });
        continue;
      }

      const entryOccupancy = boardPlanningOccupancy(game, ignored);
      if (!ignored.includes(entrySquare) && isSquareOccupiedForPlanning(entryOccupancy, entrySquare)) {
        failures.push({ slot: entrySlot.label, error: `Lane entry ${entrySquare} is occupied.` });
        continue;
      }

      if (!lanePathClear(game, entrySquare, entrySlot.lane, ignored)) {
        failures.push({ slot: entrySlot.label, error: `Lane entry ${entrySquare} is blocked.` });
        continue;
      }

      const path = findBestBoardPath(game, entrySquare, toSquare, { ignoredSquares: ignored });
      if (!path) {
        failures.push({ slot: entrySlot.label, error: `No board path from ${entrySquare} to ${toSquare}.` });
        continue;
      }

      const rawBoardPath = path.squares;
      const compressedBoardPath = compressPathSquares(rawBoardPath);
      const offboardCost = Math.abs(Number(sourceSlot.rank) - Number(entrySlot.rank)) * 12;
      const routeCost = 1200 + offboardCost + path.cost;
      candidates.push({
        routeMode: 'lane-board',
        routeCost,
        pathSquares: [fromSquare, ...compressedBoardPath],
        rawPathSquares: [fromSquare, ...rawBoardPath],
        compressedPathSquares: [fromSquare, ...compressedBoardPath],
        targets: dedupePlanTargets([
          coordinateTarget(sourceSlot, 'lane'),
          coordinateTarget(entrySlot, 'lane'),
          squareTarget(entrySquare),
          ...compressedBoardPath.slice(1).map(squareTarget)
        ]),
        sourceSlot,
        entrySlot
      });
    }
  }

  candidates.sort((a, b) => a.routeCost - b.routeCost);
  return candidates[0] || { failures };
}

function buildBoardTransferPlan(game, move, fromSquare, toSquare, options = {}) {
  const fromIndex = squareToIndex(fromSquare);
  const toIndex = squareToIndex(toSquare);
  let dragTargets = [squareTarget(toSquare)];
  let routeMode = 'direct';
  let routeCost = 0;
  let pathSquares = [fromSquare, toSquare];
  let rawPathSquares = [fromSquare, toSquare];
  let compressedPathSquares = [fromSquare, toSquare];
  let blockedReason = null;

  if (!options.forceLane) {
    const moveForRoute = { ...move, from: fromSquare, to: toSquare };
    const canUseSimpleDirect = isSimplePawnPush(moveForRoute) && directRouteSafe(game, moveForRoute);
    const clearLinePath = canUseSimpleDirect
      ? null
      : clearChessLinePath(game, fromSquare, toSquare, {
        ignoredSquares: options.ignoredSquares || []
      });
    const path = canUseSimpleDirect || clearLinePath
      ? clearLinePath
      : findBestBoardPath(game, fromSquare, toSquare, {
        ignoredSquares: options.ignoredSquares || []
      });

    if (canUseSimpleDirect) {
      routeMode = 'direct';
      rawPathSquares = [fromSquare, toSquare];
      compressedPathSquares = rawPathSquares;
    } else if (clearLinePath) {
      rawPathSquares = clearLinePath.squares;
      compressedPathSquares = compressPathSquares(rawPathSquares);
      pathSquares = compressedPathSquares;
      routeCost = clearLinePath.cost;
      dragTargets = compressedPathSquares.slice(1).map(squareTarget);
      routeMode = clearLinePath.mode;
    } else if (path) {
      rawPathSquares = path.squares;
      compressedPathSquares = compressPathSquares(rawPathSquares);
      pathSquares = compressedPathSquares;
      routeCost = path.cost;
      dragTargets = compressedPathSquares.slice(1).map(squareTarget);
      routeMode = rawPathSquares.length <= 2 ? 'board-direct' : path.mode;
    } else {
      blockedReason = `No board path from ${fromSquare} to ${toSquare}.`;
    }
  }

  if (options.forceLane || blockedReason) {
    dragTargets = laneRouteTargets(game, fromSquare, toSquare, options.preferredLane, [
      fromSquare,
      toSquare,
      ...(options.ignoredSquares || [])
    ]);
    const hasLaneWaypoint = dragTargets.some((target) => target.type === 'coordinate');
    if (!hasLaneWaypoint) {
      const laneBoard = laneBoardRoute(game, fromSquare, toSquare, options.preferredLane, options.ignoredSquares || []);
      if (!laneBoard?.targets) {
        const laneBoardReason = laneBoard?.failures?.map((failure) => `${failure.slot || 'lane'}: ${failure.error}`).join(' | ');
        throw new Error(`No safe route from ${fromSquare} to ${toSquare}. ${blockedReason || 'Board path was skipped.'} The configured Z/I lane path is blocked.${laneBoardReason ? ` ${laneBoardReason}` : ''}`);
      }

      dragTargets = laneBoard.targets;
      routeMode = laneBoard.routeMode;
      routeCost = laneBoard.routeCost;
      pathSquares = laneBoard.pathSquares;
      rawPathSquares = laneBoard.rawPathSquares;
      compressedPathSquares = laneBoard.compressedPathSquares;
    } else {
      routeMode = 'lane';
      routeCost = 1000 + dragTargets.length * 100;
      pathSquares = [fromSquare, toSquare];
      rawPathSquares = pathSquares;
      compressedPathSquares = pathSquares;
    }
  }

  return {
    routeMode,
    routeCost,
    pathSquares,
    rawPathSquares,
    compressedPathSquares,
    blockedReason,
    steps: makeTransferSteps(squareTarget(fromSquare), dragTargets, {
      sourceEmpty: fromIndex,
      targetOccupied: toIndex
    }, {
      phase: options.phase || null
    })
  };
}

function laneExitSquareForSlot(slot) {
  if (!slot?.lane || !Number.isInteger(slot.rank)) return null;
  return `${slot.lane === 'Z' ? 'a' : 'h'}${slot.rank}`;
}

function routeCrowdingCost(game, pathSquares = [], ignoredSquares = []) {
  const occupancy = boardPlanningOccupancy(game, ignoredSquares);
  return (pathSquares || []).reduce((sum, square) => (
    sum + adjacentOccupiedCount(occupancy, square, ignoredSquares)
  ), 0);
}

function planCapturedPieceRemoval(game, capturedSquare, ignoredSquares = [], options = {}) {
  const failures = [];
  const candidates = [];

  for (const slot of sortedRobotGraveyardSlots()) {
    if (isRobotGraveyardSlotOccupied(slot)) continue;

    const graveyardTarget = coordinateTarget(slot, 'graveyard');
    const exitSquare = laneExitSquareForSlot(slot);
    if (!graveyardTarget || !exitSquare) {
      failures.push({ slot: slot.label, error: 'Slot is missing lane/rank metadata.' });
      continue;
    }

    const path = findBestBoardPath(game, capturedSquare, exitSquare, {
      ignoredSquares,
      allowOccupiedTarget: false
    });

    if (!path) {
      failures.push({ slot: slot.label, error: `No board path from ${capturedSquare} to ${exitSquare}.` });
      continue;
    }

    const compressedPathSquares = compressPathSquares(path.squares);
    const crowdingCost = routeCrowdingCost(game, path.squares, ignoredSquares);
    const preferenceCost = middleOutRankDistance(slot.rank) + (slot.lane === 'I' ? 0.5 : 0);
    candidates.push({
      slot,
      routeMode: path.squares.length <= 2 ? 'graveyard-direct' : 'graveyard-board-path',
      routeCost: path.cost + 500 + crowdingCost * 12 + preferenceCost,
      routeScore: path.cost + crowdingCost * 12 + preferenceCost,
      crowdingCost,
      preferenceCost,
      pathSquares: compressedPathSquares,
      rawPathSquares: path.squares,
      compressedPathSquares,
      targets: [
        ...compressedPathSquares.slice(1).map(squareTarget),
        graveyardTarget
      ],
      failures
    });
  }

  if (candidates.length === 0) return { failures };

  candidates.sort((a, b) => {
    const scoreDelta = a.routeScore - b.routeScore;
    if (Math.abs(scoreDelta) > 0.001) return scoreDelta;
    return sortedRobotGraveyardSlots().indexOf(a.slot) - sortedRobotGraveyardSlots().indexOf(b.slot);
  });

  const selected = candidates[0];
  if (options.reserve !== false) {
    reserveRobotGraveyardSlot(selected.slot);
  }
  return {
    ...selected,
    candidates: candidates.map((candidate) => ({
      slot: candidate.slot.label,
      routeScore: candidate.routeScore,
      routeCost: candidate.routeCost,
      crowdingCost: candidate.crowdingCost,
      pathSquares: candidate.pathSquares
    }))
  };
}

function combineRouteMetadata(parts, routeMode) {
  return {
    routeMode,
    routeCost: parts.reduce((sum, part) => sum + (part?.routeCost || 0), 0),
    pathSquares: parts.flatMap((part) => part?.pathSquares || []),
    rawPathSquares: parts.flatMap((part) => part?.rawPathSquares || part?.pathSquares || []),
    compressedPathSquares: parts.flatMap((part) => part?.compressedPathSquares || part?.pathSquares || []),
    blockedReason: parts.flatMap((part) => part?.failures || []).map((failure) => `${failure.slot || 'route'}: ${failure.error}`).join(' | ') || null
  };
}

function makeCaptureStartLedStep(attackerSquare, capturedSquare) {
  return {
    action: 'led-capture-start',
    phase: 'capture-preview',
    attacker: {
      square: attackerSquare,
      index: squareToIndex(attackerSquare),
      color: PHYSICAL_LED_COLORS.source
    },
    captured: {
      square: capturedSquare,
      index: squareToIndex(capturedSquare),
      color: PHYSICAL_LED_COLORS.capture
    },
    holdMs: 1000
  };
}

function makeRunwayMotionStep(label, squares = [], colorName = 'quiet') {
  const pathSquares = (squares || [])
    .map((square) => ({
      square,
      index: squareToIndex(square)
    }))
    .filter((square) => Number.isInteger(square.index));

  if (pathSquares.length <= 1) return null;

  return {
    action: 'led-runway',
    phase: label,
    label,
    color: PHYSICAL_LED_COLORS[colorName] || PHYSICAL_LED_COLORS.quiet,
    squares: pathSquares,
    stepDelayMs: 250,
    holdMs: 500,
    clearWhenDone: false
  };
}

function compactSteps(steps = []) {
  return steps.filter(Boolean);
}

function buildCaptureMotionPlan(game, move, capturedSquare, staging) {
  const capturedIndex = squareToIndex(capturedSquare);
  const directRemoval = planCapturedPieceRemoval(game, capturedSquare, [capturedSquare].filter(Boolean), { reserve: false });
  const stagedRemoval = planCapturedPieceRemoval(game, capturedSquare, [move.from, capturedSquare].filter(Boolean), { reserve: false });
  const rejectedStrategies = [];

  const capturelessMove = {
    ...move,
    captured: null,
    flags: String(move.flags || '').replace('c', '').replace('e', '')
  };

  if (directRemoval.slot) {
    try {
      const attackerPlan = buildBoardTransferPlan(game, capturelessMove, move.from, move.to, {
        ignoredSquares: [capturedSquare, move.to],
        phase: 'attacker-final'
      });
      const metadata = combineRouteMetadata([directRemoval, attackerPlan], 'capture-direct-after-removal');
      reserveRobotGraveyardSlot(directRemoval.slot);
      return {
        ...metadata,
        graveyardSlot: directRemoval.slot,
        captureStrategy: 'capture-direct-after-removal',
        captureStrategyRejected: rejectedStrategies,
        graveyardRouteScore: directRemoval.routeScore ?? null,
        graveyardRouteCandidates: directRemoval.candidates || [],
        capturePreview: {
          strategy: 'capture-direct-after-removal',
          attackerSquares: attackerPlan.compressedPathSquares || attackerPlan.pathSquares || [],
          stageSquares: [],
          capturedSquares: directRemoval.compressedPathSquares || directRemoval.pathSquares || [],
          finalSquares: attackerPlan.compressedPathSquares || attackerPlan.pathSquares || [],
          graveyardLabel: directRemoval.slot?.label || null
        },
        steps: compactSteps([
          makeCaptureStartLedStep(move.from, capturedSquare),
          makeRunwayMotionStep('captured-graveyard', directRemoval.compressedPathSquares || directRemoval.pathSquares || [], 'special'),
          ...makeTransferSteps(squareTarget(capturedSquare), directRemoval.targets, {
            sourceEmpty: capturedIndex
          }, {
            phase: 'captured-removal'
          }),
          makeRunwayMotionStep('attacker-final', attackerPlan.compressedPathSquares || attackerPlan.pathSquares || [], 'source'),
          ...attackerPlan.steps
        ])
      };
    } catch (err) {
      rejectedStrategies.push({
        strategy: 'capture-direct-after-removal',
        error: err.message
      });
    }
  } else {
    const reason = directRemoval.failures?.[0]?.error || 'No robot graveyard slot is available.';
    rejectedStrategies.push({
      strategy: 'capture-direct-after-removal',
      error: `No clear graveyard route was found for captured piece on ${capturedSquare}. ${reason}`
    });
  }

  const stagingCandidates = findStagingSquareCandidates(game, move) || [];
  const stagedRemovalPath = new Set(stagedRemoval.rawPathSquares || stagedRemoval.pathSquares || []);
  const preferredStaging = [
    ...(staging ? [staging] : []),
    ...stagingCandidates.filter((candidate) => candidate.square !== staging?.square)
  ];

  for (const candidate of preferredStaging) {
    if (!candidate?.square || stagedRemovalPath.has(candidate.square)) continue;

    try {
      const approachPlan = buildBoardTransferPlan(game, capturelessMove, move.from, candidate.square, {
        ignoredSquares: [],
        phase: 'attacker-stage'
      });
      const finalPlan = buildBoardTransferPlan(game, capturelessMove, candidate.square, move.to, {
        ignoredSquares: [move.from, capturedSquare, move.to].filter(Boolean),
        phase: 'attacker-final'
      });
      if (!stagedRemoval.slot) {
        const reason = stagedRemoval.failures?.[0]?.error || 'No robot graveyard slot is available.';
        throw new Error(`No clear graveyard route was found for captured piece on ${capturedSquare}. ${reason}`);
      }
      const metadata = combineRouteMetadata([approachPlan, stagedRemoval, finalPlan], 'capture-stage-first-board');
      reserveRobotGraveyardSlot(stagedRemoval.slot);
      return {
        ...metadata,
        graveyardSlot: stagedRemoval.slot,
        captureStrategy: 'capture-stage-first-board',
        captureStrategyRejected: rejectedStrategies,
        graveyardRouteScore: stagedRemoval.routeScore ?? null,
        graveyardRouteCandidates: stagedRemoval.candidates || [],
        capturePreview: {
          strategy: 'capture-stage-first-board',
          attackerSquares: [
            ...(approachPlan.compressedPathSquares || approachPlan.pathSquares || []),
            ...(finalPlan.compressedPathSquares || finalPlan.pathSquares || []).slice(1)
          ],
          stageSquares: approachPlan.compressedPathSquares || approachPlan.pathSquares || [],
          capturedSquares: stagedRemoval.compressedPathSquares || stagedRemoval.pathSquares || [],
          finalSquares: finalPlan.compressedPathSquares || finalPlan.pathSquares || [],
          graveyardLabel: stagedRemoval.slot?.label || null
        },
        steps: compactSteps([
          makeCaptureStartLedStep(move.from, capturedSquare),
          makeRunwayMotionStep('attacker-stage', approachPlan.compressedPathSquares || approachPlan.pathSquares || [], 'quiet'),
          ...approachPlan.steps,
          makeRunwayMotionStep('captured-graveyard', stagedRemoval.compressedPathSquares || stagedRemoval.pathSquares || [], 'special'),
          ...makeTransferSteps(squareTarget(capturedSquare), stagedRemoval.targets, {
            sourceEmpty: capturedIndex
          }, {
            phase: 'captured-removal'
          }),
          makeRunwayMotionStep('attacker-final', finalPlan.compressedPathSquares || finalPlan.pathSquares || [], 'source'),
          ...finalPlan.steps
        ])
      };
    } catch (err) {
      rejectedStrategies.push({
        strategy: 'capture-stage-first-board',
        stagingSquare: candidate.square,
        error: err.message
      });
    }
  }

  const fallbackRemoval = directRemoval.slot ? directRemoval : stagedRemoval;
  if (!fallbackRemoval.slot) {
    const reason = fallbackRemoval.failures?.[0]?.error || 'No robot graveyard slot is available.';
    throw new Error(`No clear graveyard route was found for captured piece on ${capturedSquare}. ${reason}`);
  }

  try {
    const attackerPlan = buildBoardTransferPlan(game, capturelessMove, move.from, move.to, {
      ignoredSquares: [capturedSquare, move.to]
    });
    const metadata = combineRouteMetadata([fallbackRemoval, attackerPlan], attackerPlan.routeMode === 'lane'
      ? 'capture-remove-first-lane'
      : 'capture-remove-first-board');
    reserveRobotGraveyardSlot(fallbackRemoval.slot);
    return {
      ...metadata,
      graveyardSlot: fallbackRemoval.slot,
      captureStrategy: metadata.routeMode,
      captureStrategyRejected: rejectedStrategies,
      graveyardRouteScore: fallbackRemoval.routeScore ?? null,
      graveyardRouteCandidates: fallbackRemoval.candidates || [],
      capturePreview: {
        strategy: metadata.routeMode,
        attackerSquares: attackerPlan.compressedPathSquares || attackerPlan.pathSquares || [],
        stageSquares: [],
        capturedSquares: fallbackRemoval.compressedPathSquares || fallbackRemoval.pathSquares || [],
        finalSquares: attackerPlan.compressedPathSquares || attackerPlan.pathSquares || [],
        graveyardLabel: fallbackRemoval.slot?.label || null
      },
      steps: compactSteps([
        makeCaptureStartLedStep(move.from, capturedSquare),
        makeRunwayMotionStep('captured-graveyard', fallbackRemoval.compressedPathSquares || fallbackRemoval.pathSquares || [], 'special'),
        ...makeTransferSteps(squareTarget(capturedSquare), fallbackRemoval.targets, {
          sourceEmpty: capturedIndex
        }, {
          phase: 'captured-removal'
        }),
        makeRunwayMotionStep('attacker-final', attackerPlan.compressedPathSquares || attackerPlan.pathSquares || [], 'source'),
        ...attackerPlan.steps
      ])
    };
  } catch (err) {
    rejectedStrategies.push({
      strategy: 'capture-remove-first-fallback',
      error: err.message
    });
  }

  const ignoredAfterPickup = [move.from, move.to, capturedSquare, staging?.square].filter(Boolean);
  const safeBoardStaging = staging
    ? buildBoardTransferPlan(game, { ...move, captured: null, flags: '' }, move.from, staging.square, {
      ignoredSquares: ignoredAfterPickup,
      phase: 'attacker-stage'
    })
    : null;
  if (!safeBoardStaging) {
    throw new Error(`No safe capture route was found for ${moveToUci(move)}.`);
  }

  const stagingToTarget = buildBoardTransferPlan(game, { ...move, captured: null, flags: '' }, staging.square, move.to, {
    ignoredSquares: ignoredAfterPickup,
    phase: 'attacker-final'
  });
  const metadata = combineRouteMetadata([safeBoardStaging, removal, stagingToTarget], 'capture-board-staging');

  return {
    ...metadata,
    graveyardSlot: removal.slot,
    captureStrategy: 'capture-board-staging',
    captureStrategyRejected: rejectedStrategies,
    graveyardRouteScore: removal.routeScore ?? null,
    graveyardRouteCandidates: removal.candidates || [],
    capturePreview: {
      strategy: 'capture-board-staging',
      attackerSquares: [
        ...(safeBoardStaging.compressedPathSquares || safeBoardStaging.pathSquares || []),
        ...(stagingToTarget.compressedPathSquares || stagingToTarget.pathSquares || []).slice(1)
      ],
      stageSquares: safeBoardStaging.compressedPathSquares || safeBoardStaging.pathSquares || [],
      capturedSquares: removal.compressedPathSquares || removal.pathSquares || [],
      finalSquares: stagingToTarget.compressedPathSquares || stagingToTarget.pathSquares || [],
      graveyardLabel: removal.slot?.label || null
    },
    steps: compactSteps([
      makeCaptureStartLedStep(move.from, capturedSquare),
      makeRunwayMotionStep('attacker-stage', safeBoardStaging.compressedPathSquares || safeBoardStaging.pathSquares || [], 'quiet'),
      ...safeBoardStaging.steps,
      makeRunwayMotionStep('captured-graveyard', removal.compressedPathSquares || removal.pathSquares || [], 'special'),
      ...makeTransferSteps(squareTarget(capturedSquare), removal.targets, {
        sourceEmpty: capturedIndex
      }, {
        phase: 'captured-removal'
      }),
      makeRunwayMotionStep('attacker-final', stagingToTarget.compressedPathSquares || stagingToTarget.pathSquares || [], 'source'),
      ...stagingToTarget.steps
    ])
  };
}

function buildCastleMotionPlan(game, move) {
  const rookMove = castleRookMove(move);
  if (!rookMove) {
    return buildBoardTransferPlan(game, move, move.from, move.to);
  }

  const planPart = (planningGame, from, to, moveForPart, phase) => {
    try {
      return buildBoardTransferPlan(planningGame, moveForPart, from, to, { phase });
    } catch (err) {
      return buildBoardTransferPlan(planningGame, moveForPart, from, to, { forceLane: true, phase });
    }
  };
  const kingPlan = planPart(game, move.from, move.to, move, 'castle-king');
  const afterKingGame = new Chess(game.fen());
  const kingPiece = afterKingGame.get(move.from) || { type: 'k', color: move.color };
  afterKingGame.remove(move.from);
  afterKingGame.put({ type: kingPiece.type || 'k', color: kingPiece.color || move.color }, move.to);

  const rookPlan = planPart(afterKingGame, rookMove.from, rookMove.to, {
    ...move,
    piece: 'r',
    from: rookMove.from,
    to: rookMove.to,
    captured: null,
    flags: ''
  }, 'castle-rook');
  const metadata = combineRouteMetadata([kingPlan, rookPlan], kingPlan.routeMode === 'lane' || rookPlan.routeMode === 'lane'
    ? 'castle-lane'
    : rookPlan.routeMode === 'lane-board'
      ? 'castle-lane-board'
      : 'castle-board');
  return {
    ...metadata,
    steps: [...kingPlan.steps, ...rookPlan.steps]
  };
}

function buildRobotMoveCommand(move) {
  if (!isPhysicalMoveAllowed(move)) {
    throw new Error(`Promotion move ${moveToUci(move)} is disabled in physical board mode.`);
  }

  const uci = moveToUci(move);
  const capturedSquare = capturedSquareForMove(move);
  const staging = findStagingSquare(physicalSession.game, move);

  if (capturedSquare && physicalSession.graveyardSlots.length === 0) {
    throw new Error('A capture was selected, but no graveyard slots are configured.');
  }

  const jobId = `robot-${Date.now()}`;
  const motionPlan = move.flags?.includes('k') || move.flags?.includes('q')
    ? buildCastleMotionPlan(physicalSession.game, move)
    : capturedSquare
      ? buildCaptureMotionPlan(physicalSession.game, move, capturedSquare, staging)
      : buildBoardTransferPlan(physicalSession.game, move, move.from, move.to);

  return {
    id: jobId,
    type: 'move',
    move: uci,
    san: move.san,
    color: move.color,
    from: move.from,
    to: move.to,
    fromIndex: squareToIndex(move.from),
    toIndex: squareToIndex(move.to),
    promotion: move.promotion || null,
    capture: Boolean(capturedSquare),
    capturedSquare,
    capturedIndex: capturedSquare ? squareToIndex(capturedSquare) : null,
    stagingSquare: staging?.square || null,
    stagingIndex: staging?.index ?? null,
    graveyardSlot: capturedSquare ? motionPlan.graveyardSlot || null : null,
    castleRookMove: castleRookMove(move),
    routeMode: motionPlan.routeMode,
    pathSquares: motionPlan.pathSquares || [],
    rawPathSquares: motionPlan.rawPathSquares || motionPlan.pathSquares || [],
    compressedPathSquares: motionPlan.compressedPathSquares || motionPlan.pathSquares || [],
    routeCost: motionPlan.routeCost ?? null,
    blockedReason: motionPlan.blockedReason || null,
    capturePreview: motionPlan.capturePreview || null,
    captureStrategy: motionPlan.captureStrategy || null,
    captureStrategyRejected: motionPlan.captureStrategyRejected || [],
    graveyardRouteScore: motionPlan.graveyardRouteScore ?? null,
    graveyardRouteCandidates: motionPlan.graveyardRouteCandidates || [],
    plan: motionPlan.steps,
    speedProfile: {
      travel: 'fast',
      drag: 'slow'
    },
    verify: {
      sourceEmpty: squareToIndex(move.from),
      targetOccupied: squareToIndex(move.to)
    }
  };
}

function buildSafeBoardTransferPlan(game, move, fromSquare, toSquare, options = {}) {
  try {
    return buildBoardTransferPlan(game, move, fromSquare, toSquare, options);
  } catch (err) {
    return buildBoardTransferPlan(game, move, fromSquare, toSquare, {
      ...options,
      forceLane: true
    });
  }
}

function makeUndoMoveLike(entry, fromSquare, toSquare, piece = entry.piece) {
  return {
    color: entry.color,
    piece,
    from: fromSquare,
    to: toSquare,
    captured: null,
    flags: '',
    san: `Undo ${entry.san}`
  };
}

function gameAfterUndoAttackerBack(entry) {
  const game = new Chess(entry.afterFen);
  game.remove(entry.to);
  game.put({ type: entry.piece, color: entry.color }, entry.from);
  return game;
}

function capturedMissingUndoOccupancy(entry) {
  const expected = occupancyFromFen(entry.beforeFen);
  const capturedIndex = squareToIndex(entry.capturedSquare);
  if (Number.isInteger(capturedIndex)) {
    expected[capturedIndex] = false;
  }
  return expected;
}

function restoreCapturedPieceTargets(entry) {
  const slot = entry.robotGraveyardSlot;
  const recordedPath = Array.isArray(entry.robotCapturedPathSquares)
    ? entry.robotCapturedPathSquares.filter(Boolean)
    : [];
  const fallbackExit = laneExitSquareForSlot(slot);
  const path = recordedPath.length > 0 ? recordedPath : [entry.capturedSquare, fallbackExit].filter(Boolean);
  const reversed = path.slice().reverse();
  if (reversed[reversed.length - 1] !== entry.capturedSquare) {
    reversed.push(entry.capturedSquare);
  }
  return dedupePlanTargets(reversed.map(squareTarget));
}

function buildUndoCastlePlan(entry) {
  const rook = entry.castleRookMove;
  if (!rook) throw new Error(`Move ${entry.san} is not castling.`);

  const currentGame = new Chess(entry.afterFen);
  const kingMove = makeUndoMoveLike(entry, entry.to, entry.from, 'k');
  const kingPlan = buildSafeBoardTransferPlan(currentGame, kingMove, entry.to, entry.from, {
    phase: 'undo-castle-king'
  });

  const afterKingGame = new Chess(entry.afterFen);
  afterKingGame.remove(entry.to);
  afterKingGame.put({ type: 'k', color: entry.color }, entry.from);
  const rookMove = makeUndoMoveLike(entry, rook.to, rook.from, 'r');
  const rookPlan = buildSafeBoardTransferPlan(afterKingGame, rookMove, rook.to, rook.from, {
    phase: 'undo-castle-rook'
  });

  return {
    ...combineRouteMetadata([kingPlan, rookPlan], 'undo-castle'),
    steps: [...kingPlan.steps, ...rookPlan.steps]
  };
}

function buildUndoMovePlan(entry) {
  if (entry.castleRookMove) {
    return {
      plan: buildUndoCastlePlan(entry),
      expectedOccupancyAfter: occupancyFromFen(entry.beforeFen),
      completeFen: entry.beforeFen
    };
  }

  const currentGame = new Chess(entry.afterFen);
  const reverseMove = makeUndoMoveLike(entry, entry.to, entry.from);
  const attackerPlan = buildSafeBoardTransferPlan(currentGame, reverseMove, entry.to, entry.from, {
    ignoredSquares: entry.capturedSquare ? [entry.capturedSquare] : [],
    phase: 'undo-attacker'
  });

  if (!entry.capturedSquare) {
    return {
      plan: {
        ...attackerPlan,
        routeMode: `undo-${attackerPlan.routeMode}`,
        steps: attackerPlan.steps
      },
      expectedOccupancyAfter: occupancyFromFen(entry.beforeFen),
      completeFen: entry.beforeFen
    };
  }

  if (entry.side === 'human' && !entry.robotGraveyardSlot) {
    return {
      plan: {
        ...attackerPlan,
        routeMode: `undo-human-capture-${attackerPlan.routeMode}`,
        steps: attackerPlan.steps
      },
      expectedOccupancyAfter: capturedMissingUndoOccupancy(entry),
      waitForHumanRestore: true,
      restoreSquares: [entry.capturedSquare],
      completeFen: entry.beforeFen
    };
  }

  if (!entry.robotGraveyardSlot) {
    throw new Error(`Cannot undo robot capture ${entry.san}; no robot graveyard slot was recorded.`);
  }

  const restoreTargets = restoreCapturedPieceTargets(entry);
  const capturedIndex = squareToIndex(entry.capturedSquare);
  const restoreSteps = makeTransferSteps(
    coordinateTarget(entry.robotGraveyardSlot, 'graveyard'),
    restoreTargets,
    { targetOccupied: capturedIndex },
    { phase: 'undo-captured-restore' }
  );
  const restorePathSquares = restoreTargets
    .map((target) => target.square)
    .filter(Boolean);
  const metadata = combineRouteMetadata([
    attackerPlan,
    {
      routeMode: 'undo-restore-captured',
      routeCost: 500 + restoreTargets.length * 100,
      pathSquares: restorePathSquares,
      rawPathSquares: restorePathSquares,
      compressedPathSquares: restorePathSquares
    }
  ], entry.side === 'human' ? 'undo-human-capture-restore' : 'undo-robot-capture');

  return {
    plan: {
      ...metadata,
      steps: [...attackerPlan.steps, ...restoreSteps]
    },
    expectedOccupancyAfter: occupancyFromFen(entry.beforeFen),
    completeFen: entry.beforeFen,
    freeGraveyardSlot: entry.robotGraveyardSlot
  };
}

function buildPhysicalUndoCommand(entry) {
  const undoPlan = buildUndoMovePlan(entry);
  const command = {
    id: `undo-${Date.now()}-${physicalSession.nextCommandId++}`,
    type: 'move',
    move: entry.uci,
    san: `Undo ${entry.san}`,
    color: entry.color,
    from: entry.to,
    to: entry.from,
    fromIndex: squareToIndex(entry.to),
    toIndex: squareToIndex(entry.from),
    capture: false,
    routeMode: undoPlan.plan.routeMode,
    pathSquares: undoPlan.plan.pathSquares || [],
    rawPathSquares: undoPlan.plan.rawPathSquares || undoPlan.plan.pathSquares || [],
    compressedPathSquares: undoPlan.plan.compressedPathSquares || undoPlan.plan.pathSquares || [],
    routeCost: undoPlan.plan.routeCost ?? null,
    blockedReason: undoPlan.plan.blockedReason || null,
    plan: undoPlan.plan.steps,
    speedProfile: {
      travel: 'fast',
      drag: 'slow'
    },
    verify: {}
  };
  return { command, undoPlan };
}

function planPhysicalRobotCandidates(candidateMoves) {
  const planned = [];
  const failures = [];

  for (const candidate of candidateMoves) {
    const graveyardSlotBefore = physicalSession.nextGraveyardSlot;
    const robotGraveyardBefore = [...physicalSession.robotGraveyardOccupied];
    try {
      const command = buildRobotMoveCommand(candidate);
      const nextGraveyardSlot = physicalSession.nextGraveyardSlot;
      const robotGraveyardOccupied = [...physicalSession.robotGraveyardOccupied];
      physicalSession.nextGraveyardSlot = graveyardSlotBefore;
      physicalSession.robotGraveyardOccupied = robotGraveyardBefore;
      planned.push({
        move: candidate,
        command,
        nextGraveyardSlot,
        robotGraveyardOccupied
      });
    } catch (err) {
      physicalSession.nextGraveyardSlot = graveyardSlotBefore;
      physicalSession.robotGraveyardOccupied = robotGraveyardBefore;
      failures.push({
        move: moveToUci(candidate),
        san: candidate.san,
        error: err.message
      });
    }
  }

  return { planned, failures };
}

async function chooseBestRoutablePhysicalMove(fen, planned, level) {
  if (planned.length === 0) return null;
  if (planned.length === 1) return planned[0];

  const game = new Chess(fen);
  const sideToMove = game.turn();
  const scoreDepth = Math.max(4, level);
  const scored = await scoreCandidateMoves(fen, planned.map((item) => item.move), sideToMove, scoreDepth);
  const byUci = new Map(scored.map((item) => [item.uci, item]));

  return planned
    .map((item) => ({
      ...item,
      score: byUci.get(moveToUci(item.move))?.sideScore ?? -Infinity,
      scoreDepth,
      routeCost: item.command?.routeCost ?? item.command?.plan?.length ?? 0
    }))
    .sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (Math.abs(scoreDelta) > 0.05) return scoreDelta;
      return a.routeCost - b.routeCost;
    })[0] || planned[0];
}

function robotPlanningSnapshotStatus() {
  const expected = occupancyFromGame(physicalSession.game);
  const actual = physicalSession.occupancy;
  const diff = diffOccupancy(expected, actual);
  const snapshotAgeMs = physicalSession.lastSnapshotAt ? Date.now() - physicalSession.lastSnapshotAt : null;
  return {
    ready: diff.missing.length === 0 && diff.extra.length === 0,
    expected,
    actual,
    diff,
    snapshotAgeMs
  };
}

function applyPendingRobotMoveToGame(pending) {
  if (!pending) return null;
  if (pending.applied) return pending.appliedMove || parseUciToMove(pending.uci);

  pending.preMoveFen = pending.preMoveFen || physicalSession.game.fen();
  const moveObj = physicalSession.game.move(parseUciToMove(pending.uci));
  if (!moveObj) return null;

  pending.applied = true;
  pending.appliedMove = {
    color: moveObj.color,
    piece: moveObj.piece,
    from: moveObj.from,
    to: moveObj.to,
    flags: moveObj.flags || '',
    captured: moveObj.captured || null,
    promotion: moveObj.promotion || null,
    san: moveObj.san
  };
  physicalSession.lastMove = { side: 'engine', move: moveToUci(moveObj), san: moveObj.san, at: Date.now() };
  return pending.appliedMove;
}

function rollbackPendingRobotMove(pending) {
  if (!pending?.applied || !pending.preMoveFen) return;
  physicalSession.game = new Chess(pending.preMoveFen);
  pending.applied = false;
  pending.appliedMove = null;
  physicalSession.lastMove = null;
}

async function queueRobotReply() {
  physicalSession.phase = 'robot_thinking';
  physicalSession.statusText = 'Engine is choosing a physical reply.';
  logPhysicalEvent('robot_thinking', 'Engine is choosing a physical board reply.');
  emitPhysicalState();

  try {
    const snapshotStatus = robotPlanningSnapshotStatus();
    logPhysicalEvent('robot_planning_snapshot', snapshotStatus.ready
      ? 'Latest sensor snapshot matches expected board before robot planning.'
      : 'Robot planning paused because latest sensor snapshot does not match expected board.', {
        level: snapshotStatus.ready ? 'info' : 'warning',
        expectedOccupancy: snapshotStatus.expected,
        actualOccupancy: snapshotStatus.actual,
        diff: snapshotStatus.diff,
        details: {
          snapshotAgeMs: snapshotStatus.snapshotAgeMs,
          missingSquares: snapshotStatus.diff.missing.map(indexToSquare).filter(Boolean),
          extraSquares: snapshotStatus.diff.extra.map(indexToSquare).filter(Boolean)
        }
      });

    if (!snapshotStatus.ready) {
      setPhysicalSyncWarning('Board changed before robot planning. Restore/center the highlighted squares before the robot moves.', {
        ...snapshotStatus.diff,
        reason: {
          type: 'robot_planning_stale_snapshot',
          snapshotAgeMs: snapshotStatus.snapshotAgeMs
        }
      });
      return;
    }

    const result = await chooseEngineMove(physicalSession.game.fen(), physicalSession.level, physicalSession.profile);
    if (!result.success || !result.move) {
      throw new Error(result.error || 'Engine did not return a move.');
    }

    const legalMoves = physicalSession.game.moves({ verbose: true })
      .filter(isPhysicalMoveAllowed);
    const preferredMove = legalMoves.find((move) => legalMoveMatchesUci(move, result.move));

    if (!preferredMove) {
      throw new Error(`Engine returned illegal physical move ${result.move}.`);
    }

    const candidateMoves = [
      preferredMove,
      ...legalMoves.filter((move) => !legalMoveMatchesUci(move, result.move))
    ];
    const { planned, failures: planningFailures } = planPhysicalRobotCandidates(candidateMoves);
    const preferredPlan = planned.find((plan) => legalMoveMatchesUci(plan.move, result.move)) || null;
    const selectedPlan = physicalSession.level >= 12
      ? preferredPlan || await chooseBestRoutablePhysicalMove(physicalSession.game.fen(), planned, physicalSession.level)
      : planned[0] || null;
    const legalMove = selectedPlan?.move || null;
    const command = selectedPlan?.command || null;

    if (!command || !legalMove) {
      throw new Error(`No legal robot reply has a safe physical route. First failure: ${planningFailures[0]?.error || 'unknown route error'}`);
    }

    physicalSession.nextGraveyardSlot = selectedPlan.nextGraveyardSlot;
    physicalSession.robotGraveyardOccupied = selectedPlan.robotGraveyardOccupied || physicalSession.robotGraveyardOccupied;

    if (!legalMoveMatchesUci(legalMove, result.move)) {
      const preferredFailure = planningFailures.find((failure) => failure.move === result.move) || null;
      logPhysicalEvent('robot_move_fallback', `Engine preferred ${result.move}, but physical planner selected ${legalMove.san}.`, {
        level: 'warning',
        details: {
          preferredMove: result.move,
          selectedMove: moveToUci(legalMove),
          expertReranked: physicalSession.level >= 12,
          selectedScore: selectedPlan.score ?? null,
          scoreDepth: selectedPlan.scoreDepth ?? null,
          routeMode: command.routeMode,
          routeCost: command.routeCost ?? null,
          preferredFailure,
          failures: planningFailures.slice(0, 8)
        }
      });
    }

    physicalSession.pendingRobotJob = {
      id: command.id,
      uci: moveToUci(legalMove),
      san: legalMove.san,
      command,
      preMoveFen: physicalSession.game.fen(),
      applied: false,
      appliedMove: null
    };
    physicalSession.phase = 'robot_busy';
    physicalSession.statusText = `Robot moving: ${legalMove.san}`;
    const appliedMove = applyPendingRobotMoveToGame(physicalSession.pendingRobotJob);
    if (!appliedMove) {
      throw new Error(`Robot move ${moveToUci(legalMove)} is no longer legal.`);
    }
    clearPhysicalLeds();
    logPhysicalEvent('robot_move_planned', `Robot move planned and shown in app: ${legalMove.san}.`, {
      commandId: command.id,
      details: {
        move: moveToUci(legalMove),
        san: legalMove.san,
        routeMode: command.routeMode,
        routeCost: command.routeCost ?? null,
        pathSquares: command.pathSquares || [],
        rawPathSquares: command.rawPathSquares || [],
        compressedPathSquares: command.compressedPathSquares || [],
        capturePreview: command.capturePreview || null,
        captureStrategy: command.captureStrategy || null,
        captureStrategyRejected: command.captureStrategyRejected || [],
        graveyardRouteScore: command.graveyardRouteScore ?? null,
        graveyardRouteCandidates: command.graveyardRouteCandidates || [],
        snapshotAgeMs: snapshotStatus.snapshotAgeMs
      }
    });
    emitPhysicalState('physical-move', {
      side: 'engine',
      move: moveToUci(legalMove),
      san: legalMove.san,
      planned: true
    });
    queuePhysicalCommand(command);
    logPhysicalEvent('robot_job_queued', `Robot job queued for ${legalMove.san}.`, {
      commandId: command.id,
      details: { command: summarizePhysicalCommand(command) }
    });
    emitPhysicalState();
  } catch (err) {
    if (physicalSession.pendingRobotJob?.applied) {
      rollbackPendingRobotMove(physicalSession.pendingRobotJob);
    }
    physicalSession.pendingRobotJob = null;
    setPhysicalError(err.message);
  }
}

function expectedDiffForPendingRobotMove(occupancy) {
  const pending = physicalSession.pendingRobotJob;
  if (!pending || !occupancy) return null;

  if (pending.applied) {
    const expected = occupancyFromGame(physicalSession.game);
    return {
      illegal: false,
      moveObj: pending.appliedMove || parseUciToMove(pending.uci),
      expected,
      diff: diffOccupancy(expected, occupancy)
    };
  }

  const copy = new Chess(physicalSession.game.fen());
  const moveObj = copy.move(parseUciToMove(pending.uci));
  if (!moveObj) {
    return {
      illegal: true,
      error: `Pending robot move ${pending.uci} is no longer legal.`
    };
  }

  const expected = occupancyFromGame(copy);
  return {
    illegal: false,
    moveObj,
    expected,
    diff: diffOccupancy(expected, occupancy)
  };
}

function completePendingRobotMove(occupancy = null) {
  const pending = physicalSession.pendingRobotJob;
  if (!pending) {
    return { success: false, error: 'No robot job is pending.' };
  }

  let moveObj = pending.appliedMove || null;
  if (!pending.applied) {
    moveObj = physicalSession.game.move(parseUciToMove(pending.uci));
    if (!moveObj) {
      setPhysicalError(`Robot move ${pending.uci} is no longer legal.`, { id: pending.id });
      return { success: false, error: `Robot move ${pending.uci} is no longer legal.` };
    }
  }

  physicalSession.occupancy = occupancy || occupancyFromGame(physicalSession.game);
  recordPhysicalMove('robot', moveObj, pending.preMoveFen || null, physicalSession.game.fen(), {
    verified: true,
    robotGraveyardSlot: pending.command?.graveyardSlot || null,
    robotCapturedPathSquares: pending.command?.capturePreview?.capturedSquares || []
  });
  rememberCompletedRobotJob(pending, {
    move: pending.uci,
    san: moveObj?.san || pending.san
  });
  physicalSession.pendingRobotJob = null;
  physicalSession.syncWarningReason = null;
  physicalSession.lastMove = { side: 'engine', move: pending.uci, san: moveObj?.san || pending.san, at: Date.now() };
  physicalSession.phase = physicalSession.game.isGameOver() ? 'game_over' : 'ready';
  physicalSession.statusText = physicalSession.game.isGameOver()
    ? gameResultMessage(physicalSession.game) || 'Game over.'
    : 'Waiting for your move.';
  logPhysicalEvent('robot_move_committed', `Robot move committed after hardware verification: ${moveObj?.san || pending.san}.`, {
    commandId: pending.id,
    actualOccupancy: occupancy || occupancyFromGame(physicalSession.game),
    details: {
      move: pending.uci,
      san: moveObj?.san || pending.san
    }
  });
  clearPhysicalLeds();
  queueGameStatusLedCommand(physicalSession.game);
  if (physicalSession.phase === 'ready') {
    armPostRobotSettleGuard('robot_move');
  }

  if (physicalSession.phase === 'game_over') {
    logPhysicalEvent('game_over', physicalSession.statusText, {
      commandId: pending.id,
      details: {
        result: physicalSession.statusText,
        afterMove: pending.uci,
        san: moveObj?.san || pending.san
      }
    });
  }

  emitPhysicalState('physical-move', {
    side: 'engine',
    move: pending.uci,
    san: moveObj?.san || pending.san,
    verified: true
  });

  return { success: true, moveObj };
}

function lastPhysicalMoveForStatus() {
  const last = physicalSession.moveLog[physicalSession.moveLog.length - 1];
  if (!last) return null;
  return {
    side: last.side === 'robot' ? 'engine' : 'human',
    move: last.uci,
    san: last.san,
    at: last.createdAt
  };
}

function completePhysicalUndoEntry(entry, targetFen, occupancy) {
  physicalSession.game = new Chess(targetFen);
  physicalSession.occupancy = occupancy || occupancyFromFen(targetFen);
  removePhysicalMoveLogEntry(entry);
  physicalSession.lastMove = lastPhysicalMoveForStatus();
}

function queueUndoRestoreLedCommand(entry, options = {}) {
  const squares = [];
  const targetIndex = squareToIndex(entry.from);
  const currentIndex = squareToIndex(entry.to);

  if (options.manualMoveBack) {
    if (Number.isInteger(currentIndex)) {
      squares.push(makeLedSquare(currentIndex, 'source', 'solid'));
    }
    if (Number.isInteger(targetIndex)) {
      squares.push(makeLedSquare(targetIndex, 'special', 'pulse'));
    }
  }

  const capturedIndex = squareToIndex(entry.capturedSquare);
  if (Number.isInteger(capturedIndex)) {
    squares.push(makeLedSquare(capturedIndex, 'special', 'pulse'));
  }
  if (!options.manualMoveBack && Number.isInteger(targetIndex)) {
    squares.push(makeLedSquare(targetIndex, 'source', 'solid'));
  }
  return queueLedCommand('undo-restore', squares);
}

function queueUndoBoardRestoreLedCommand(diff = {}) {
  const squares = [
    ...(diff.missing || []).map((index) => makeLedSquare(index, 'special', 'pulse')),
    ...(diff.extra || []).map((index) => makeLedSquare(index, 'extra', 'pulse'))
  ];
  return queueLedCommand('undo-board-restore', squares);
}

function describeUndoPiece(entry) {
  const names = {
    p: 'pawn',
    n: 'knight',
    b: 'bishop',
    r: 'rook',
    q: 'queen',
    k: 'king'
  };
  return names[entry.piece] || 'piece';
}

function manualHumanUndoStatus(entry) {
  const pieceName = describeUndoPiece(entry);
  if (entry.capturedSquare) {
    return `Move your ${pieceName} back from ${entry.to} to ${entry.from}, then restore the captured piece on ${entry.capturedSquare}.`;
  }
  return `Move your ${pieceName} back from ${entry.to} to ${entry.from}, then wait for the board to detect it.`;
}

function startManualHumanUndoRestore(entry, reason = null) {
  if (!physicalSession.pendingUndo) {
    return { success: false, error: 'No undo is pending.' };
  }

  physicalSession.pendingRobotJob = null;
  physicalSession.pendingUndo.currentEntry = summarizePhysicalMoveLogEntry(entry);
  physicalSession.pendingUndo.waitingForHumanRestore = {
    entry,
    targetFen: entry.beforeFen,
    restoreSquares: [entry.from, entry.capturedSquare].filter(Boolean),
    targetOccupancy: occupancyFromFen(entry.beforeFen),
    manualMoveBack: true,
    reason
  };
  physicalSession.phase = 'undo_waiting_human_restore';
  physicalSession.statusText = manualHumanUndoStatus(entry);
  clearPhysicalLeds();
  queueUndoRestoreLedCommand(entry, { manualMoveBack: true });
  logPhysicalEvent('physical_undo_waiting_human_restore', physicalSession.statusText, {
    level: reason ? 'warning' : 'info',
    details: {
      entry: summarizePhysicalMoveLogEntry(entry),
      restoreSquares: physicalSession.pendingUndo.waitingForHumanRestore.restoreSquares,
      manualMoveBack: true,
      reason
    }
  });
  emitPhysicalState('physical-board');
  return { success: true, waitingForHumanRestore: true, state: serializePhysicalState() };
}

function formatUndoBoardRestoreStatus(diff = {}) {
  const missing = (diff.missing || []).map(indexToSquare).filter(Boolean);
  const extra = (diff.extra || []).map(indexToSquare).filter(Boolean);
  const parts = [];
  if (missing.length > 0) parts.push(`restore/center ${missing.join(', ')}`);
  if (extra.length > 0) parts.push(`clear ${extra.join(', ')}`);
  return parts.length > 0
    ? `Undo move finished, but the board still differs. Please ${parts.join(' and ')}.`
    : 'Undo move finished, but the board still differs. Restore/center the highlighted squares.';
}

function undoPrimaryMotionComplete(entry, occupancy) {
  if (!entry || !Array.isArray(occupancy)) return false;
  const checks = [];
  const reverseSource = squareToIndex(entry.to);
  const reverseTarget = squareToIndex(entry.from);
  if (Number.isInteger(reverseSource)) checks.push([reverseSource, false]);
  if (Number.isInteger(reverseTarget)) checks.push([reverseTarget, true]);

  if (entry.castleRookMove) {
    const rookReverseSource = squareToIndex(entry.castleRookMove.to);
    const rookReverseTarget = squareToIndex(entry.castleRookMove.from);
    if (Number.isInteger(rookReverseSource)) checks.push([rookReverseSource, false]);
    if (Number.isInteger(rookReverseTarget)) checks.push([rookReverseTarget, true]);
  }

  if (entry.side === 'robot' && entry.capturedSquare && entry.robotGraveyardSlot) {
    const capturedIndex = squareToIndex(entry.capturedSquare);
    if (Number.isInteger(capturedIndex)) checks.push([capturedIndex, true]);
  }

  return checks.length > 0 && checks.every(([index, expected]) => Boolean(occupancy[index]) === expected);
}

function waitForUndoBoardRestore(undo, actualOccupancy, diff, reason = null) {
  const entry = undo.entry;
  completePhysicalUndoEntry(entry, undo.completeFen, actualOccupancy);
  physicalSession.pendingRobotJob = null;
  if (undo.freeGraveyardSlot) {
    releaseRobotGraveyardSlot(undo.freeGraveyardSlot);
  }

  physicalSession.pendingUndo.waitingForHumanRestore = {
    entry,
    targetFen: undo.completeFen,
    restoreSquares: [
      ...(diff.missing || []).map(indexToSquare).filter(Boolean),
      ...(diff.extra || []).map(indexToSquare).filter(Boolean)
    ],
    targetOccupancy: occupancyFromFen(undo.completeFen),
    boardRestore: true,
    completeEntryOnRestore: false,
    reason
  };
  physicalSession.phase = 'undo_waiting_human_restore';
  physicalSession.statusText = formatUndoBoardRestoreStatus(diff);
  queueUndoBoardRestoreLedCommand(diff);
  logPhysicalEvent('physical_undo_waiting_board_restore', physicalSession.statusText, {
    level: 'warning',
    actualOccupancy,
    diff,
    details: {
      entry: summarizePhysicalMoveLogEntry(entry),
      restoreSquares: physicalSession.pendingUndo.waitingForHumanRestore.restoreSquares,
      reason
    }
  });
  emitPhysicalState('physical-board', { undoRestoreDiff: diff });
  return { success: true, waitingForHumanRestore: true };
}

function finishPhysicalUndo() {
  const redoEntries = physicalSession.pendingUndo?.redoEntries || [];
  if (redoEntries.length > 0) {
    physicalSession.redoStack.push(redoEntries.map(clonePhysicalMoveLogEntry));
  }
  physicalSession.pendingUndo = null;
  physicalSession.pendingRobotJob = null;
  physicalSession.phase = physicalSession.game.isGameOver() ? 'game_over' : 'ready';
  physicalSession.statusText = physicalSession.game.isGameOver()
    ? gameResultMessage(physicalSession.game) || 'Game over.'
    : 'Undo complete. Waiting for your move.';
  clearPhysicalLeds();
  queueGameStatusLedCommand(physicalSession.game);
  if (physicalSession.phase === 'ready') {
    armPostRobotSettleGuard('undo');
  }
  logPhysicalEvent('physical_undo_complete', physicalSession.statusText);
  emitPhysicalState('physical-move', { undo: true });
  return { success: true, complete: true };
}

function findRedoMoveForEntry(entry) {
  return physicalSession.game.moves({ verbose: true })
    .filter(isPhysicalMoveAllowed)
    .find((move) => legalMoveMatchesUci(move, entry.uci)) || null;
}

function finishPhysicalRedo() {
  physicalSession.pendingRedo = null;
  physicalSession.pendingRobotJob = null;
  physicalSession.phase = physicalSession.game.isGameOver() ? 'game_over' : 'ready';
  physicalSession.statusText = physicalSession.game.isGameOver()
    ? gameResultMessage(physicalSession.game) || 'Game over.'
    : 'Redo complete. Waiting for your move.';
  clearPhysicalLeds();
  queueGameStatusLedCommand(physicalSession.game);
  if (physicalSession.phase === 'ready') {
    armPostRobotSettleGuard('redo');
  }
  logPhysicalEvent('physical_redo_complete', physicalSession.statusText);
  emitPhysicalState('physical-move', { redo: true });
  return { success: true, complete: true };
}

function queueNextPhysicalRedoStep() {
  const pendingRedo = physicalSession.pendingRedo;
  if (!pendingRedo) {
    return { success: false, error: 'No redo is pending.' };
  }

  const entry = pendingRedo.entries.shift();
  if (!entry) {
    return finishPhysicalRedo();
  }

  if (entry.beforeFen && physicalSession.game.fen() !== entry.beforeFen) {
    pendingRedo.entries.unshift(entry);
    const message = `Redo ${entry.san} cannot start because the current board history no longer matches the undone position.`;
    setPhysicalSyncWarning(message, {
      missing: [],
      extra: [],
      reason: {
        type: 'redo_fen_mismatch',
        move: entry.uci,
        san: entry.san,
        expectedFen: entry.beforeFen,
        actualFen: physicalSession.game.fen()
      }
    });
    return { success: false, recoverable: true, error: message, state: serializePhysicalState() };
  }

  let move;
  let command;
  try {
    move = findRedoMoveForEntry(entry);
    if (!move) {
      throw new Error(`Move ${entry.uci} is not legal from the current redo position.`);
    }
    command = buildRobotMoveCommand(move);
  } catch (err) {
    pendingRedo.entries.unshift(entry);
    const reason = err?.message || 'Redo path could not be planned.';
    setPhysicalSyncWarning(`Redo paused: ${reason}`, {
      missing: [],
      extra: [],
      reason: {
        type: 'redo_planning_failed',
        move: entry.uci,
        san: entry.san,
        error: reason
      }
    });
    logPhysicalEvent('physical_redo_plan_failed', `Redo planning failed for ${entry.san}: ${reason}`, {
      level: 'warning',
      details: {
        entry: summarizePhysicalMoveLogEntry(entry),
        reason
      }
    });
    return { success: false, recoverable: true, error: reason, state: serializePhysicalState() };
  }

  physicalSession.pendingRobotJob = {
    id: command.id,
    kind: 'redo',
    uci: moveToUci(move),
    san: move.san,
    command,
    preMoveFen: physicalSession.game.fen(),
    applied: false,
    appliedMove: null,
    redo: {
      entry
    }
  };
  pendingRedo.currentEntry = summarizePhysicalMoveLogEntry(entry);
  physicalSession.phase = 'redo_robot_busy';
  physicalSession.statusText = `Redoing ${entry.san}. Robot is replaying the move.`;

  const appliedMove = applyPendingRobotMoveToGame(physicalSession.pendingRobotJob);
  if (!appliedMove) {
    physicalSession.pendingRobotJob = null;
    pendingRedo.entries.unshift(entry);
    setPhysicalError(`Redo move ${entry.uci} is no longer legal.`);
    return { success: false, error: `Redo move ${entry.uci} is no longer legal.`, state: serializePhysicalState() };
  }

  clearPhysicalLeds();
  queuePhysicalCommand(command);
  logPhysicalEvent('physical_redo_step_queued', physicalSession.statusText, {
    commandId: command.id,
    details: {
      entry: summarizePhysicalMoveLogEntry(entry),
      command: summarizePhysicalCommand(command)
    }
  });
  emitPhysicalState('physical-move', {
    side: entry.side === 'robot' ? 'engine' : 'human',
    move: moveToUci(move),
    san: move.san,
    planned: true,
    redo: true
  });
  return { success: true, state: serializePhysicalState() };
}

function completePendingRedoRobotJob(occupancy = null) {
  const pending = physicalSession.pendingRobotJob;
  const redo = pending?.redo;
  if (!pending || pending.kind !== 'redo' || !redo?.entry) {
    return { success: false, error: 'No redo robot job is pending.' };
  }

  let moveObj = pending.appliedMove || null;
  if (!pending.applied) {
    moveObj = physicalSession.game.move(parseUciToMove(pending.uci));
    if (!moveObj) {
      setPhysicalError(`Redo move ${pending.uci} is no longer legal.`, { id: pending.id });
      return { success: false, error: `Redo move ${pending.uci} is no longer legal.` };
    }
  }

  const entry = redo.entry;
  const actualOccupancy = occupancy || occupancyFromGame(physicalSession.game);
  const expected = occupancyFromGame(physicalSession.game);
  const diff = diffOccupancy(expected, actualOccupancy);
  const hasMismatch = diff.missing.length > 0 || diff.extra.length > 0;

  physicalSession.occupancy = actualOccupancy;
  recordPhysicalMove(entry.side, moveObj, pending.preMoveFen || entry.beforeFen || null, physicalSession.game.fen(), {
    verified: true,
    robotGraveyardSlot: pending.command?.graveyardSlot || null,
    robotCapturedPathSquares: pending.command?.capturePreview?.capturedSquares || [],
    preserveRedo: true
  });
  rememberCompletedRobotJob(pending, {
    move: pending.uci,
    san: moveObj?.san || pending.san,
    redo: true
  });
  physicalSession.pendingRobotJob = null;
  physicalSession.syncWarningReason = null;
  physicalSession.lastMove = {
    side: entry.side === 'robot' ? 'engine' : 'human',
    move: pending.uci,
    san: moveObj?.san || pending.san,
    at: Date.now()
  };
  logPhysicalEvent('physical_redo_step_complete', `Redo step complete for ${moveObj?.san || pending.san}.`, {
    commandId: pending.id,
    actualOccupancy,
    details: {
      entry: summarizePhysicalMoveLogEntry(entry),
      move: pending.uci,
      san: moveObj?.san || pending.san
    }
  });
  if (hasMismatch) {
    setPhysicalSyncWarning('Redo move completed, but sensors do not match the expected board. Restore or center the yellow squares before continuing redo.', {
      ...diff,
      commandId: pending.id,
      move: pending.uci,
      san: pending.san,
      expectedOccupied: occupiedIndices(expected),
      actualOccupied: occupiedIndices(actualOccupancy),
      missingSquares: diff.missing.map(indexToSquare).filter(Boolean),
      extraSquares: diff.extra.map(indexToSquare).filter(Boolean),
      reason: {
        type: 'redo_result_mismatch',
        commandId: pending.id
      }
    });
    return { success: false, recoverable: true, error: 'Redo final occupancy mismatch.' };
  }
  return queueNextPhysicalRedoStep();
}

function queueNextPhysicalUndoStep() {
  const pendingUndo = physicalSession.pendingUndo;
  if (!pendingUndo) {
    return { success: false, error: 'No undo is pending.' };
  }

  const entry = pendingUndo.entries.shift();
  if (!entry) {
    return finishPhysicalUndo();
  }

  let command;
  let undoPlan;
  try {
    ({ command, undoPlan } = buildPhysicalUndoCommand(entry));
  } catch (err) {
    const reason = err?.message || 'Undo path could not be planned.';
    if (entry.side === 'human') {
      return startManualHumanUndoRestore(entry, reason);
    }

    pendingUndo.entries.unshift(entry);
    setPhysicalSyncWarning(`Undo paused: ${reason}`, {
      missing: [],
      extra: [],
      reason: {
        type: 'undo_planning_failed',
        move: entry.uci,
        san: entry.san,
        error: reason
      }
    });
    logPhysicalEvent('physical_undo_plan_failed', `Undo planning failed for ${entry.san}: ${reason}`, {
      level: 'warning',
      details: {
        entry: summarizePhysicalMoveLogEntry(entry),
        reason
      }
    });
    return { success: false, recoverable: true, error: reason, state: serializePhysicalState() };
  }
  physicalSession.pendingRobotJob = {
    id: command.id,
    kind: 'undo',
    uci: entry.uci,
    san: `Undo ${entry.san}`,
    command,
    undo: {
      entry,
      expectedOccupancyAfter: undoPlan.expectedOccupancyAfter,
      completeFen: undoPlan.completeFen,
      waitForHumanRestore: Boolean(undoPlan.waitForHumanRestore),
      restoreSquares: undoPlan.restoreSquares || [],
      freeGraveyardSlot: undoPlan.freeGraveyardSlot || null
    }
  };
  pendingUndo.currentEntry = summarizePhysicalMoveLogEntry(entry);
  physicalSession.phase = 'undo_robot_busy';
  physicalSession.statusText = `Undoing ${entry.san}. Robot is moving pieces back.`;
  clearPhysicalLeds();
  queuePhysicalCommand(command);
  logPhysicalEvent('physical_undo_step_queued', physicalSession.statusText, {
    commandId: command.id,
    details: {
      entry: summarizePhysicalMoveLogEntry(entry),
      command: summarizePhysicalCommand(command)
    }
  });
  emitPhysicalState('physical-move', { undo: true });
  return { success: true, state: serializePhysicalState() };
}

function selectUndoTurnEntries() {
  const latest = physicalSession.moveLog[physicalSession.moveLog.length - 1];
  if (!latest) return [];
  const previous = physicalSession.moveLog[physicalSession.moveLog.length - 2];
  if (latest.side === 'robot' && previous?.side === 'human') {
    return [latest, previous];
  }
  return [latest];
}

function startPhysicalUndoTurn() {
  if (!physicalSession.active) {
    return { success: false, error: 'Physical board mode is not active.' };
  }
  if (!['ready', 'game_over'].includes(physicalSession.phase)) {
    return { success: false, error: `Cannot undo while physical board phase is ${physicalSession.phase}.` };
  }
  if (physicalSession.pendingRobotJob) {
    return { success: false, error: 'Cannot undo while a robot job is pending.' };
  }
  if (physicalSession.moveLog.length === 0) {
    return { success: false, error: 'No physical moves are available to undo.' };
  }

  const expected = occupancyFromGame(physicalSession.game);
  const diff = diffOccupancy(expected, physicalSession.occupancy);
  if (diff.missing.length > 0 || diff.extra.length > 0) {
    setPhysicalSyncWarning('Board must match the current game before undo can start. Restore/center the highlighted squares.', {
      ...diff,
      reason: { type: 'undo_stale_board' }
    });
    return { success: false, recoverable: true, error: 'Board does not match current game state.', state: serializePhysicalState() };
  }

  const entries = selectUndoTurnEntries();
  physicalSession.pendingUndo = {
    id: `undo-turn-${Date.now()}`,
    mode: 'turn',
    entries: [...entries],
    redoEntries: entries.slice().reverse().map(clonePhysicalMoveLogEntry),
    waitingForHumanRestore: null,
    startedAt: Date.now()
  };
  logPhysicalEvent('physical_undo_started', `Undo turn started for ${entries.map((entry) => entry.san).join(', ')}.`, {
    details: {
      entries: entries.map(summarizePhysicalMoveLogEntry)
    }
  });
  return queueNextPhysicalUndoStep();
}

function startPhysicalRedoTurn() {
  if (!physicalSession.active) {
    return { success: false, error: 'Physical board mode is not active.' };
  }
  if (!['ready', 'game_over'].includes(physicalSession.phase)) {
    return { success: false, error: `Cannot redo while physical board phase is ${physicalSession.phase}.` };
  }
  if (physicalSession.pendingRobotJob) {
    return { success: false, error: 'Cannot redo while a robot job is pending.' };
  }
  if (physicalSession.pendingUndo) {
    return { success: false, error: 'Cannot redo while undo is pending.' };
  }
  if (physicalSession.redoStack.length === 0) {
    return { success: false, error: 'No physical moves are available to redo.' };
  }

  const expected = occupancyFromGame(physicalSession.game);
  const diff = diffOccupancy(expected, physicalSession.occupancy);
  if (diff.missing.length > 0 || diff.extra.length > 0) {
    setPhysicalSyncWarning('Board must match the current game before redo can start. Restore/center the highlighted squares.', {
      ...diff,
      reason: { type: 'redo_stale_board' }
    });
    return { success: false, recoverable: true, error: 'Board does not match current game state.', state: serializePhysicalState() };
  }

  const entries = physicalSession.redoStack.pop() || [];
  physicalSession.pendingRedo = {
    id: `redo-turn-${Date.now()}`,
    mode: 'turn',
    entries: entries.map(clonePhysicalMoveLogEntry),
    currentEntry: null,
    startedAt: Date.now()
  };
  logPhysicalEvent('physical_redo_started', `Redo turn started for ${entries.map((entry) => entry.san).join(', ')}.`, {
    details: {
      entries: entries.map(summarizePhysicalMoveLogEntry)
    }
  });
  return queueNextPhysicalRedoStep();
}

function pausePendingUndoAfterFailure(error, occupancy = null) {
  const pending = physicalSession.pendingRobotJob;
  const actualOccupancy = occupancy || physicalSession.occupancy;
  const expected = occupancyFromGame(physicalSession.game);
  const diff = diffOccupancy(expected, actualOccupancy);
  physicalSession.occupancy = actualOccupancy;
  setPhysicalSyncWarning(`Undo paused: ${error}. Restore/center the yellow squares, then retry.`, {
    ...diff,
    commandId: pending?.id || null,
    reason: {
      type: 'undo_robot_job_failed',
      commandId: pending?.id || null,
      error
    }
  });
  return { success: true };
}

function completePendingUndoRobotJob(occupancy = null) {
  const pending = physicalSession.pendingRobotJob;
  const undo = pending?.undo;
  if (!pending || pending.kind !== 'undo' || !undo) {
    return { success: false, error: 'No undo robot job is pending.' };
  }

  const actualOccupancy = occupancy || physicalSession.occupancy;
  const diff = diffOccupancy(undo.expectedOccupancyAfter, actualOccupancy);
  if (diff.missing.length > 0 || diff.extra.length > 0) {
    if (undoPrimaryMotionComplete(undo.entry, actualOccupancy)) {
      return waitForUndoBoardRestore(undo, actualOccupancy, diff, 'undo_result_residual_mismatch');
    }

    setPhysicalSyncWarning('Undo robot move completed, but sensors do not match the expected undo position. Restore/center the highlighted squares.', {
      ...diff,
      commandId: pending.id,
      reason: {
        type: 'undo_result_mismatch',
        commandId: pending.id
      }
    });
    return { success: false, recoverable: true, error: 'Undo final occupancy mismatch.' };
  }

  physicalSession.pendingRobotJob = null;
  physicalSession.occupancy = actualOccupancy;

  if (undo.freeGraveyardSlot) {
    releaseRobotGraveyardSlot(undo.freeGraveyardSlot);
  }

  if (undo.waitForHumanRestore) {
    physicalSession.pendingUndo.waitingForHumanRestore = {
      entry: undo.entry,
      targetFen: undo.completeFen,
      restoreSquares: undo.restoreSquares || [],
      targetOccupancy: occupancyFromFen(undo.completeFen)
    };
    physicalSession.phase = 'undo_waiting_human_restore';
    physicalSession.statusText = `Place the captured ${undo.entry.capturedPiece || 'piece'} back on ${undo.entry.capturedSquare}, then wait for the board to detect it.`;
    queueUndoRestoreLedCommand(undo.entry);
    logPhysicalEvent('physical_undo_waiting_human_restore', physicalSession.statusText, {
      details: {
        entry: summarizePhysicalMoveLogEntry(undo.entry),
        restoreSquares: undo.restoreSquares || []
      }
    });
    emitPhysicalState('physical-board');
    return { success: true, waitingForHumanRestore: true };
  }

  completePhysicalUndoEntry(undo.entry, undo.completeFen, actualOccupancy);
  logPhysicalEvent('physical_undo_step_complete', `Undo step complete for ${undo.entry.san}.`, {
    details: {
      entry: summarizePhysicalMoveLogEntry(undo.entry)
    }
  });
  return queueNextPhysicalUndoStep();
}

function processUndoWaitingHumanRestoreSnapshot(occupancy) {
  const pending = physicalSession.pendingUndo?.waitingForHumanRestore;
  if (!pending) {
    physicalSession.phase = 'ready';
    physicalSession.statusText = 'Waiting for your move.';
    emitPhysicalState('physical-board');
    return;
  }

  const diff = diffOccupancy(pending.targetOccupancy, occupancy);
  if (diff.missing.length === 0 && diff.extra.length === 0) {
    if (pending.completeEntryOnRestore !== false) {
      completePhysicalUndoEntry(pending.entry, pending.targetFen, occupancy);
    } else {
      physicalSession.game = new Chess(pending.targetFen);
      physicalSession.occupancy = occupancy;
      physicalSession.lastMove = lastPhysicalMoveForStatus();
    }
    physicalSession.pendingUndo.waitingForHumanRestore = null;
    logPhysicalEvent('physical_undo_human_restore_complete', pending.boardRestore
      ? 'Board restored after undo mismatch.'
      : `Captured piece restored for undo of ${pending.entry.san}.`, {
      actualOccupancy: occupancy,
      details: {
        entry: pending.entry ? summarizePhysicalMoveLogEntry(pending.entry) : null,
        boardRestore: Boolean(pending.boardRestore)
      }
    });
    queueNextPhysicalUndoStep();
    return;
  }

  physicalSession.occupancy = occupancy;
  physicalSession.statusText = pending.boardRestore
    ? formatUndoBoardRestoreStatus(diff)
    : pending.manualMoveBack
    ? manualHumanUndoStatus(pending.entry)
    : `Restore captured piece on ${pending.restoreSquares.join(', ') || pending.entry.capturedSquare}.`;
  if (pending.boardRestore) {
    queueUndoBoardRestoreLedCommand(diff);
  } else {
    queueUndoRestoreLedCommand(pending.entry, { manualMoveBack: Boolean(pending.manualMoveBack) });
  }
  emitPhysicalState('physical-board', { undoRestoreDiff: diff });
}

function pausePendingRobotJobAfterFailure(error, occupancy = null) {
  const pending = physicalSession.pendingRobotJob;
  if (!pending) {
    return { success: false, error: 'No robot job is pending.' };
  }

  const cleanError = String(error || 'robot command failed').replace(/[.\s]+$/, '');
  const actualOccupancy = occupancy || physicalSession.occupancy;
  const postMoveResult = expectedDiffForPendingRobotMove(actualOccupancy);
  rollbackPendingRobotMove(pending);
  const preMoveExpected = occupancyFromGame(physicalSession.game);
  const preMoveDiff = diffOccupancy(preMoveExpected, actualOccupancy);
  const move = parseUciToMove(pending.uci);
  const fromIndex = squareToIndex(move?.from);
  const toIndex = squareToIndex(move?.to);
  const highlightDiff = preMoveDiff.missing.length > 0 || preMoveDiff.extra.length > 0
    ? preMoveDiff
    : {
        missing: [fromIndex, toIndex].filter((index) => Number.isInteger(index)),
        extra: []
      };
  const reason = {
    type: 'robot_job_failed',
    commandId: pending.id,
    move: pending.uci,
    san: pending.san,
    message: `Robot move ${pending.san} paused: ${cleanError}`,
    error: cleanError,
    preMoveDiff: {
      missing: preMoveDiff.missing,
      extra: preMoveDiff.extra,
      missingSquares: preMoveDiff.missing.map(indexToSquare).filter(Boolean),
      extraSquares: preMoveDiff.extra.map(indexToSquare).filter(Boolean)
    },
    intendedPostMoveDiff: postMoveResult && !postMoveResult.illegal
      ? {
          missing: postMoveResult.diff.missing,
          extra: postMoveResult.diff.extra,
          missingSquares: postMoveResult.diff.missing.map(indexToSquare).filter(Boolean),
          extraSquares: postMoveResult.diff.extra.map(indexToSquare).filter(Boolean)
        }
      : null
  };

  physicalSession.occupancy = actualOccupancy;
  logPhysicalEvent('robot_job_failed_recoverable', reason.message, {
    level: 'warning',
    commandId: pending.id,
    expectedOccupancy: preMoveExpected,
    actualOccupancy,
    diff: preMoveDiff,
    details: reason
  });

  setPhysicalSyncWarning(`${reason.message}. Restore/center the yellow squares, then retry the robot move.`, {
    ...highlightDiff,
    commandId: pending.id,
    move: pending.uci,
    san: pending.san,
    reason
  });

  return { success: true, reason };
}

function processRobotBusySnapshot(occupancy) {
  const pending = physicalSession.pendingRobotJob;
  if (!pending) {
    physicalSession.phase = 'ready';
    physicalSession.statusText = 'Waiting for your move.';
    emitPhysicalState('physical-board');
    return;
  }

  const result = expectedDiffForPendingRobotMove(occupancy);
  if (result?.illegal) {
    setPhysicalError(result.error, { id: pending.id });
    return;
  }

  physicalSession.occupancy = occupancy;
  physicalSession.statusText = `Robot moving: ${pending.san}`;
  emitPhysicalState('physical-board');
}

function processUndoRobotBusySnapshot(occupancy) {
  const pending = physicalSession.pendingRobotJob;
  physicalSession.occupancy = occupancy;
  physicalSession.statusText = pending
    ? `Undoing: ${pending.san}`
    : 'Undo in progress.';
  emitPhysicalState('physical-board');
}

function processSyncWarningSnapshot(occupancy) {
  const expected = occupancyFromGame(physicalSession.game);
  const diff = diffOccupancy(expected, occupancy);

  if (diff.missing.length === 0 && diff.extra.length === 0) {
    clearPostRobotSettleGuard('Sync warning cleared after board matched expected position.');
    if (physicalSession.pendingRobotJob) {
      physicalSession.statusText = physicalSession.syncWarningReason?.message
        || `Board is restored. Retry robot move ${physicalSession.pendingRobotJob.san} when the piece is centered.`;
      logPhysicalEvent('sync_restored_pending_robot', 'Board matches the pre-robot position; pending robot job is waiting for user retry.', {
        actualOccupancy: occupancy,
        commandId: physicalSession.pendingRobotJob.id,
        details: {
          pendingRobotJob: summarizePendingRobotJob(),
          reason: physicalSession.syncWarningReason
        }
      });
      emitPhysicalState('physical-board');
      return;
    }

    physicalSession.phase = 'ready';
    physicalSession.lastError = null;
    physicalSession.syncWarningReason = null;
    physicalSession.statusText = physicalSession.game.turn() === 'w'
      ? 'Board restored. Waiting for your move.'
      : 'Board restored. Waiting for robot move.';
    logPhysicalEvent('sync_restored', 'Physical board occupancy matches the expected game state again.', {
      actualOccupancy: occupancy
    });
    clearPhysicalLeds();
    emitPhysicalState('physical-board');
    return;
  }

  const missingSquares = diff.missing.map(indexToSquare).filter(Boolean);
  const extraSquares = diff.extra.map(indexToSquare).filter(Boolean);
  physicalSession.statusText = `Restore/center board: missing ${missingSquares.join(', ') || 'none'}, extra ${extraSquares.join(', ') || 'none'}.`;
  queueBoardSyncWarningLedCommand(diff);
  emitPhysicalState('physical-board', { syncWarning: diff });
}

function processReadySnapshot(occupancy) {
  const expected = occupancyFromGame(physicalSession.game);
  const diff = diffOccupancy(expected, occupancy);

  if (diff.missing.length === 0 && diff.extra.length === 0) {
    clearPostRobotSettleGuard('Ready board snapshot matched expected position.');
    physicalSession.statusText = physicalSession.game.turn() === 'w'
      ? 'Waiting for your move.'
      : 'Waiting for robot move.';
    queueGameStatusLedCommand(physicalSession.game);
    emitPhysicalState('physical-board');
    return;
  }

  if (physicalSession.postRobotSettleGuard && diff.missing.length === 1 && diff.extra.length === 0) {
    const missingSquare = indexToSquare(diff.missing[0]);
    setPhysicalSyncWarning(`Center the piece on ${missingSquare}; the robot just finished moving and the sensor is not detecting it.`, {
      ...diff,
      reason: {
        type: 'post_robot_settle_missing',
        square: missingSquare,
        guard: physicalSession.postRobotSettleGuard
      }
    });
    return;
  }

  if (physicalSession.game.turn() !== 'w') {
    if (diff.missing.length + diff.extra.length > 0) {
      setPhysicalSyncWarning('Board changed while it was not the player turn. Restore the expected position.', diff);
    }
    return;
  }

  if (diff.missing.length === 1 && diff.extra.length === 0) {
    const sourceSquare = indexToSquare(diff.missing[0]);
    const piece = physicalSession.game.get(sourceSquare);

    if (!piece) {
      setPhysicalSyncWarning(`Square ${sourceSquare} is not expected to contain a piece. Restore the board position.`, diff);
      return;
    }

    if (piece.color !== 'w') {
      setPhysicalSyncWarning(`Black piece on ${sourceSquare} is not detected. Center it on the sensor before moving White.`, diff);
      return;
    }

    const legalMoves = legalMovesForSource(physicalSession.game, sourceSquare);
    if (legalMoves.length === 0) {
      setPhysicalSyncWarning(`The piece on ${sourceSquare} has no legal moves. Put it back on ${sourceSquare}.`, {
        ...diff,
        reason: {
          type: 'no_legal_moves_lift',
          sourceSquare,
          index: diff.missing[0]
        }
      });
      return;
    }

    physicalSession.phase = 'piece_lifted';
    physicalSession.selectedSource = sourceSquare;
    physicalSession.pendingCaptureTarget = null;
    physicalSession.pendingCastleMove = null;
    physicalSession.legalTargets = legalMoves.map((move) => ({
      move: moveToUci(move),
      from: move.from,
      to: move.to,
      index: squareToIndex(move.to),
      capture: Boolean(move.captured),
      special: Boolean(move.promotion) || move.flags?.includes('k') || move.flags?.includes('q') || move.flags?.includes('e')
    }));
    physicalSession.statusText = `Piece lifted from ${sourceSquare}.`;
    logPhysicalEvent('piece_lifted', `White piece lifted from ${sourceSquare}; legal destinations highlighted.`, {
      level: 'info',
      diff,
      details: {
        sourceSquare,
        legalTargets: physicalSession.legalTargets
      }
    });
    queueLegalMoveLedCommand(sourceSquare, legalMoves);
    emitPhysicalState('physical-board');
    return;
  }

  if (diff.missing.length + diff.extra.length > 1) {
    setPhysicalSyncWarning('Board position does not match the current game. Restore or center the highlighted squares.', diff);
  }
}

async function processLiftedSnapshot(occupancy) {
  const sourceSquare = physicalSession.selectedSource;
  const sourceIndex = squareToIndex(sourceSquare);
  const legalMoves = legalMovesForSource(physicalSession.game, sourceSquare);

  if (occupancy[sourceIndex] && !physicalSession.pendingCaptureTarget) {
    physicalSession.phase = 'ready';
    physicalSession.selectedSource = null;
    physicalSession.legalTargets = [];
    physicalSession.statusText = 'Move cancelled; waiting for your move.';
    logPhysicalEvent('move_cancelled', `Piece returned to ${sourceSquare}; move cancelled.`, {
      actualOccupancy: occupancy,
      details: { sourceSquare }
    });
    clearPhysicalLeds();
    emitPhysicalState('physical-board');
    return;
  }

  for (const move of legalMoves) {
    if ((move.flags?.includes('k') || move.flags?.includes('q'))
      && castleKingLooksPlaced(move, occupancy)
      && !occupancyMatchesAfterMove(physicalSession.game, move, occupancy)) {
      setPendingCastleMove(move);
      return;
    }

    if (move.captured) {
      const capturedSquare = capturedSquareForMove(move);
      const capturedIndex = squareToIndex(capturedSquare);
      if (!occupancy[capturedIndex]) {
        physicalSession.pendingCaptureTarget = move.to;
        physicalSession.statusText = `Capture target ${move.to} cleared. Place your piece on ${move.to}.`;
        emitPhysicalState('physical-board');
      }
    }

    if (moveLooksComplete(move, occupancy)) {
      await finalizeHumanPhysicalMove(move, occupancy);
      return;
    }
  }

  emitPhysicalState('physical-board');
}

async function processCastlePendingSnapshot(occupancy) {
  const pending = physicalSession.pendingCastleMove;
  if (!pending) {
    setPhysicalSyncWarning('Castling state was lost. Restore the board and try again.', {
      ...diffOccupancy(occupancyFromGame(physicalSession.game), occupancy),
      reason: { type: 'castle_state_missing' }
    });
    return;
  }

  const legalMove = physicalSession.game.moves({ verbose: true })
    .filter(isPhysicalMoveAllowed)
    .find((move) => moveToUci(move) === pending.move);

  if (!legalMove) {
    setPhysicalSyncWarning('Castling is no longer legal. Restore the board position.', {
      ...diffOccupancy(occupancyFromGame(physicalSession.game), occupancy),
      reason: { type: 'castle_no_longer_legal', move: pending.move }
    });
    return;
  }

  const expected = occupancyFromGame(physicalSession.game);
  const currentDiff = diffOccupancy(expected, occupancy);
  if (currentDiff.missing.length === 0 && currentDiff.extra.length === 0) {
    physicalSession.phase = 'ready';
    physicalSession.selectedSource = null;
    physicalSession.pendingCastleMove = null;
    physicalSession.legalTargets = [];
    physicalSession.statusText = 'Castling cancelled; waiting for your move.';
    logPhysicalEvent('castle_cancelled', 'Castling cancelled; king returned to the source square.', {
      actualOccupancy: occupancy,
      details: { move: pending.move }
    });
    clearPhysicalLeds();
    emitPhysicalState('physical-board');
    return;
  }

  if (occupancyMatchesAfterMove(physicalSession.game, legalMove, occupancy)) {
    await finalizeHumanPhysicalMove(legalMove, occupancy);
    return;
  }

  physicalSession.statusText = pending.rook
    ? `Finish castling: move rook from ${pending.rook.from} to ${pending.rook.to}.`
    : 'Finish the castling rook move.';
  queueCastleRookLedCommand(legalMove);
  emitPhysicalState('physical-board');
}

async function processPhysicalSnapshot(occupancy, metadata = {}) {
  physicalSession.lastSnapshotAt = Date.now();
  physicalSession.occupancy = occupancy;

  if (!physicalSession.active || physicalSession.phase === 'idle') {
    emitPhysicalState('physical-board');
    return;
  }

  if (physicalSession.phase === 'setup') {
    const report = buildCalibrationReport(occupancy);
    queueCalibrationLedCommand(report);

    if (report.ready) {
      if (physicalSession.setupMode === 'partial') {
        const partialFen = buildPartialGameFromOccupancy(occupancy);
        try {
          physicalSession.game = new Chess(partialFen);
        } catch (err) {
          setPhysicalError(`Partial setup could not create a legal chess position: ${err.message}`, { fen: partialFen });
          return;
        }
      }

      physicalSession.phase = 'ready';
      physicalSession.statusText = physicalSession.setupMode === 'partial'
        ? `Partial setup accepted with ${report.present.length} detected starting pieces. Waiting for your move.`
        : 'Calibration passed. Waiting for your move.';
      physicalSession.lastError = null;
      logPhysicalEvent('setup_ready', physicalSession.statusText, {
        actualOccupancy: occupancy,
        details: {
          setupMode: physicalSession.setupMode,
          presentSquares: report.presentSquares || [],
          omittedSquares: report.omittedSquares || []
        }
      });
      clearPhysicalLeds();
    } else {
      physicalSession.statusText = physicalSession.setupMode === 'partial'
        ? `Partial setup needs both kings and no extra squares: ${report.missing.length} required missing, ${report.extra.length} extra.`
        : `Calibration needed: ${report.missing.length} missing, ${report.extra.length} extra.`;
    }

    emitPhysicalState('physical-board', { snapshotMeta: metadata });
    return;
  }

  if (physicalSession.phase === 'ready') {
    processReadySnapshot(occupancy);
    return;
  }

  if (physicalSession.phase === 'robot_busy') {
    processRobotBusySnapshot(occupancy);
    return;
  }

  if (physicalSession.phase === 'undo_robot_busy') {
    processUndoRobotBusySnapshot(occupancy);
    return;
  }

  if (physicalSession.phase === 'redo_robot_busy') {
    processRobotBusySnapshot(occupancy);
    return;
  }

  if (physicalSession.phase === 'undo_waiting_human_restore') {
    processUndoWaitingHumanRestoreSnapshot(occupancy);
    return;
  }

  if (physicalSession.phase === 'sync_warning') {
    processSyncWarningSnapshot(occupancy);
    return;
  }

  if (physicalSession.phase === 'piece_lifted') {
    await processLiftedSnapshot(occupancy);
    return;
  }

  if (physicalSession.phase === 'castle_pending_rook') {
    await processCastlePendingSnapshot(occupancy);
    return;
  }

  emitPhysicalState('physical-board', { snapshotMeta: metadata });
}

app.post('/api/physical/start', (req, res) => {
  const { level = 1, profile = 'balanced', graveyardSlots = [], setupMode = 'full' } = req.body || {};

  physicalSession.active = true;
  physicalSession.phase = 'setup';
  physicalSession.setupMode = setupMode === 'partial' ? 'partial' : 'full';
  physicalSession.game = new Chess(PHYSICAL_START_FEN);
  physicalSession.occupancy = Array(64).fill(false);
  physicalSession.selectedSource = null;
  physicalSession.pendingCaptureTarget = null;
  physicalSession.pendingCastleMove = null;
  physicalSession.legalTargets = [];
  physicalSession.level = clampLevel(level);
  physicalSession.profile = normalizeProfile(profile);
  physicalSession.graveyardSlots = normalizeGraveyardSlots(graveyardSlots);
  physicalSession.nextGraveyardSlot = 0;
  physicalSession.robotGraveyardOccupied = [];
  physicalSession.pendingRobotJob = null;
  physicalSession.moveLog = [];
  physicalSession.pendingUndo = null;
  physicalSession.redoStack = [];
  physicalSession.pendingRedo = null;
  physicalSession.autoRobotReply = true;
  physicalSession.commands = [];
  physicalSession.lastCalibrationKey = '';
  physicalSession.lastError = null;
  physicalSession.syncWarningReason = null;
  physicalSession.postRobotSettleGuard = null;
  physicalSession.lastMove = null;
  physicalSession.statusText = physicalSession.setupMode === 'partial'
    ? 'Partial physical setup started. Detected starting pieces will become the game position.'
    : 'Physical board setup calibration started.';

  logPhysicalEvent('setup_started', physicalSession.statusText, {
    details: {
      setupMode: physicalSession.setupMode,
      level: physicalSession.level,
      profile: physicalSession.profile,
      graveyardSlots: physicalSession.graveyardSlots.map((slot) => ({
        label: slot.label,
        lane: slot.lane || null,
        rank: slot.rank || null,
        x: slot.x,
        y: slot.y
      }))
    }
  });
  queuePhysicalCommand({ type: 'home' });
  queuePhysicalCommand({ type: 'request-snapshot' });
  emitPhysicalState();

  return res.json({ success: true, state: serializePhysicalState() });
});

app.get('/api/physical/status', (req, res) => {
  res.json({ success: true, state: serializePhysicalState() });
});

app.get('/api/physical/logs', (req, res) => {
  res.json({
    success: true,
    logs: readRecentPhysicalLogs(req.query.limit)
  });
});

app.post('/api/physical/plan-preview', (req, res) => {
  const { fen, move, graveyardSlots = [] } = req.body || {};
  if (!fen || !move) {
    return res.status(400).json({ success: false, error: 'Expected fen and move.' });
  }

  try {
    const result = withPhysicalPlanningContext(fen, graveyardSlots, (game) => {
      const legalMove = game.moves({ verbose: true })
        .filter(isPhysicalMoveAllowed)
        .find((candidate) => legalMoveMatchesUci(candidate, move));

      if (!legalMove) {
        return { success: false, status: 400, error: `Move ${move} is not legal in the supplied FEN.` };
      }

      const command = buildRobotMoveCommand(legalMove);
      return {
        success: true,
        move: moveToUci(legalMove),
        san: legalMove.san,
        command: summarizeMotionPlan(command),
        graveyardSlotCount: physicalSession.graveyardSlots.length
      };
    });

    if (!result.success) {
      return res.status(result.status || 400).json(result);
    }
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/physical/planner-check', (req, res) => {
  const { fen = PHYSICAL_START_FEN, graveyardSlots = [] } = req.body || {};

  try {
    const result = withPhysicalPlanningContext(fen, graveyardSlots, (game) => {
      const moves = game.moves({ verbose: true })
        .filter(isPhysicalMoveAllowed)
        .map((move) => {
          const graveyardSlotBefore = physicalSession.nextGraveyardSlot;
          const robotGraveyardBefore = [...physicalSession.robotGraveyardOccupied];
          try {
            const command = buildRobotMoveCommand(move);
            physicalSession.nextGraveyardSlot = graveyardSlotBefore;
            physicalSession.robotGraveyardOccupied = robotGraveyardBefore;
            return {
              move: moveToUci(move),
              san: move.san,
              success: true,
              command: summarizeMotionPlan(command)
            };
          } catch (err) {
            physicalSession.nextGraveyardSlot = graveyardSlotBefore;
            physicalSession.robotGraveyardOccupied = robotGraveyardBefore;
            return {
              move: moveToUci(move),
              san: move.san,
              success: false,
              error: err.message
            };
          }
        });

      return {
        success: true,
        fen: game.fen(),
        turn: game.turn(),
        graveyardSlotCount: physicalSession.graveyardSlots.length,
        moves,
        routableCount: moves.filter((move) => move.success).length,
        blockedCount: moves.filter((move) => !move.success).length
      };
    });

    return res.json(result);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/physical/retry-robot', (req, res) => {
  const pending = physicalSession.pendingRobotJob;
  if (!pending) {
    return res.status(400).json({ success: false, error: 'No robot job is pending.' });
  }

  const expected = occupancyFromGame(physicalSession.game);
  const diff = diffOccupancy(expected, physicalSession.occupancy);
  if (diff.missing.length > 0 || diff.extra.length > 0) {
    return res.status(409).json({
      success: false,
      error: 'Restore/center the board before retrying the robot move.',
      diff: {
        missing: diff.missing,
        extra: diff.extra,
        missingSquares: diff.missing.map(indexToSquare).filter(Boolean),
        extraSquares: diff.extra.map(indexToSquare).filter(Boolean)
      },
      state: serializePhysicalState()
    });
  }

  if (pending.kind === 'undo') {
    physicalSession.phase = 'undo_robot_busy';
    physicalSession.statusText = `Retrying undo: ${pending.san}`;
    physicalSession.syncWarningReason = null;
    clearPhysicalLeds();
    queuePhysicalCommand(pending.command);
    logPhysicalEvent('physical_undo_retry', `Retrying undo command ${pending.san}.`, {
      commandId: pending.id,
      details: { pendingRobotJob: summarizePendingRobotJob() }
    });
    emitPhysicalState();
    return res.json({ success: true, state: serializePhysicalState() });
  }

  if (pending.kind === 'redo') {
    physicalSession.phase = 'redo_robot_busy';
    physicalSession.statusText = `Retrying redo: ${pending.san}`;
    physicalSession.syncWarningReason = null;
    const appliedMove = applyPendingRobotMoveToGame(pending);
    if (!appliedMove) {
      setPhysicalError(`Redo move ${pending.uci} is no longer legal.`, { id: pending.id });
      return res.status(500).json({ success: false, state: serializePhysicalState() });
    }
    clearPhysicalLeds();
    emitPhysicalState('physical-move', {
      side: pending.redo?.entry?.side === 'robot' ? 'engine' : 'human',
      move: pending.uci,
      san: pending.san,
      planned: true,
      retry: true,
      redo: true
    });
    queuePhysicalCommand(pending.command);
    logPhysicalEvent('physical_redo_retry', `Retrying redo command ${pending.san}.`, {
      commandId: pending.id,
      details: { pendingRobotJob: summarizePendingRobotJob() }
    });
    emitPhysicalState();
    return res.json({ success: true, state: serializePhysicalState() });
  }

  physicalSession.phase = 'robot_busy';
  physicalSession.statusText = `Retrying robot move: ${pending.san}`;
  physicalSession.syncWarningReason = null;
  const appliedMove = applyPendingRobotMoveToGame(pending);
  if (!appliedMove) {
    setPhysicalError(`Robot move ${pending.uci} is no longer legal.`, { id: pending.id });
    return res.status(500).json({ success: false, state: serializePhysicalState() });
  }
  clearPhysicalLeds();
  emitPhysicalState('physical-move', {
    side: 'engine',
    move: pending.uci,
    san: pending.san,
    planned: true,
    retry: true
  });
  queuePhysicalCommand(pending.command);
  logPhysicalEvent('robot_job_retry', `Retrying robot move ${pending.san}.`, {
    commandId: pending.id,
    details: { pendingRobotJob: summarizePendingRobotJob() }
  });
  emitPhysicalState();
  return res.json({ success: true, state: serializePhysicalState() });
});

app.post('/api/physical/undo-turn', (req, res) => {
  try {
    const result = startPhysicalUndoTurn();
    const status = result.success || result.recoverable ? 200 : 409;
    return res.status(status).json({
      ...result,
      state: serializePhysicalState()
    });
  } catch (err) {
    setPhysicalError(`Physical undo failed: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: err.message,
      state: serializePhysicalState()
    });
  }
});

app.post('/api/physical/redo-turn', (req, res) => {
  try {
    const result = startPhysicalRedoTurn();
    const status = result.success || result.recoverable ? 200 : 409;
    return res.status(status).json({
      ...result,
      state: serializePhysicalState()
    });
  } catch (err) {
    setPhysicalError(`Physical redo failed: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: err.message,
      state: serializePhysicalState()
    });
  }
});

app.post('/api/physical/snapshot', async (req, res) => {
  const occupancy = normalizeOccupancyPayload(req.body);

  if (!occupancy) {
    return res.status(400).json({ success: false, error: 'Expected occupancy[64], occupied[], or bitboard string.' });
  }

  try {
    const commandIdsBefore = new Set(physicalSession.commands.map((command) => command.id));
    await processPhysicalSnapshot(occupancy, {
      seq: req.body?.seq,
      stable: req.body?.stable,
      source: req.body?.source || 'esp32'
    });
    const immediateCommands = physicalSession.commands
      .filter((command) => command.type === 'led' && !commandIdsBefore.has(command.id));
    return res.json({ success: true, state: serializePhysicalState(), immediateCommands });
  } catch (err) {
    console.error('[Physical Snapshot Error]', err);
    setPhysicalError(err.message);
    return res.status(500).json({ success: false, error: err.message, state: serializePhysicalState() });
  }
});

app.get('/api/physical/poll', (req, res) => {
  const commands = physicalSession.commands.splice(0, physicalSession.commands.length);
  res.json({
    success: true,
    phase: physicalSession.phase,
    commands,
    state: serializePhysicalState()
  });
});

app.post('/api/physical/job-result', (req, res) => {
  const { id, success, error, failedPhase = null, failedStep = null } = req.body || {};
  const occupancy = normalizeOccupancyPayload(req.body);
  const pending = physicalSession.pendingRobotJob;

  if (!pending) {
    if (id && completedRobotJobs.has(id)) {
      const completed = completedRobotJobs.get(id);
      logPhysicalEvent('robot_job_result_late', `Late robot job result accepted for already completed move ${completed.san || completed.move}.`, {
        level: 'info',
        commandId: id,
        actualOccupancy: occupancy || physicalSession.occupancy,
        diff: { missing: [], extra: [] },
      details: { id, success, error, failedPhase, failedStep, completed }
      });
      return res.json({ success: true, alreadyCompleted: true, state: serializePhysicalState() });
    }

    logPhysicalEvent('robot_job_result_unexpected', 'Robot job result received, but no robot job is pending.', {
      level: 'warning',
      commandId: id || null,
      actualOccupancy: occupancy || physicalSession.occupancy,
      details: { id, success, error, failedPhase, failedStep }
    });
    return res.status(400).json({ success: false, error: 'No robot job is pending.' });
  }

  if (id && id !== pending.id) {
    logPhysicalEvent('robot_job_result_unexpected', `Unexpected robot job id ${id}; expected ${pending.id}.`, {
      level: 'warning',
      commandId: id,
      actualOccupancy: occupancy || physicalSession.occupancy,
      details: { expectedId: pending.id, receivedId: id }
    });
    return res.status(409).json({ success: false, error: `Unexpected robot job id ${id}; expected ${pending.id}.` });
  }

  logPhysicalEvent('robot_job_result', success
    ? `Robot reported job ${pending.id} complete.`
    : `Robot reported job ${pending.id} failed.`, {
      level: success ? 'info' : 'warning',
      commandId: pending.id,
      actualOccupancy: occupancy || physicalSession.occupancy,
      diff: { missing: [], extra: [] },
      details: { id, success, error, failedPhase, failedStep }
    });

  if (!success) {
    const phaseText = failedPhase ? ` during ${failedPhase}` : '';
    const stepText = failedStep !== null && failedStep !== undefined && Number.isInteger(Number(failedStep)) ? ` at step ${failedStep}` : '';
    const enrichedError = `${error || `Robot job ${pending.id} failed.`}${phaseText}${stepText}`;
    if (pending.kind === 'undo') {
      pausePendingUndoAfterFailure(enrichedError, occupancy);
      return res.json({
        success: false,
        recoverable: true,
        error: enrichedError,
        state: serializePhysicalState()
      });
    }
    if (pending.kind === 'redo') {
      const paused = pausePendingRobotJobAfterFailure(enrichedError, occupancy);
      return res.json({
        success: false,
        recoverable: true,
        error: enrichedError,
        reason: paused.reason,
        state: serializePhysicalState()
      });
    }
    const paused = pausePendingRobotJobAfterFailure(enrichedError, occupancy);
    if (!paused.success) {
      setPhysicalError(enrichedError, { id: pending.id, failedPhase, failedStep });
      return res.status(500).json({ success: false, state: serializePhysicalState() });
    }
    return res.json({
      success: false,
      recoverable: true,
      error: enrichedError,
      reason: paused.reason,
      state: serializePhysicalState()
    });
  }

  if (pending.kind === 'undo') {
    const completed = completePendingUndoRobotJob(occupancy);
    return res.json({
      success: completed.success,
      recoverable: Boolean(completed.recoverable || completed.waitingForHumanRestore),
      error: completed.error,
      state: serializePhysicalState()
    });
  }

  if (pending.kind === 'redo') {
    const completed = completePendingRedoRobotJob(occupancy);
    return res.json({
      success: completed.success,
      recoverable: Boolean(completed.recoverable),
      error: completed.error,
      state: serializePhysicalState()
    });
  }

  if (occupancy) {
    const expectedResult = expectedDiffForPendingRobotMove(occupancy);
    if (expectedResult?.illegal) {
      setPhysicalError(`Robot reported success, but ${pending.uci} is no longer legal.`, { id: pending.id });
      return res.status(500).json({ success: false, state: serializePhysicalState() });
    }

    const diff = expectedResult.diff;
    if (diff.missing.length > 0 || diff.extra.length > 0) {
      const warningDiff = {
        ...diff,
        commandId: pending.id,
        move: pending.uci,
        san: pending.san,
        expectedOccupied: occupiedIndices(expectedResult.expected),
        actualOccupied: occupiedIndices(occupancy),
        missingSquares: diff.missing.map(indexToSquare).filter(Boolean),
        extraSquares: diff.extra.map(indexToSquare).filter(Boolean)
      };
      logPhysicalEvent('robot_result_mismatch', 'Robot move completed, but final occupancy does not match the expected board.', {
        level: 'warning',
        commandId: pending.id,
        expectedOccupancy: expectedResult.expected,
        actualOccupancy: occupancy,
        diff,
        details: warningDiff
      });

      const completed = completePendingRobotMove(occupancy);
      if (!completed.success) {
        return res.status(500).json({ success: false, error: completed.error, state: serializePhysicalState() });
      }

      setPhysicalSyncWarning('Robot move completed, but sensors do not match the expected board. Restore or center the yellow squares.', warningDiff);
      return res.json({
        success: false,
        recoverable: true,
        error: 'Final occupancy mismatch.',
        diff: warningDiff,
        state: serializePhysicalState()
      });
    }
  }

  const completed = completePendingRobotMove(occupancy);
  if (!completed.success) {
    return res.status(500).json({ success: false, error: completed.error, state: serializePhysicalState() });
  }

  return res.json({ success: true, state: serializePhysicalState() });
});

const net = require('net');

// Keep track of connected ESP32 audio clients
let esp32AudioClients = [];

// TCP Server on port 3001 to stream raw audio bytes over Wi-Fi to the ESP32
const audioServer = net.createServer((socket) => {
  console.log('[Audio Server] ESP32 connected for audio streaming');
  esp32AudioClients.push(socket);

  socket.on('close', () => {
    console.log('[Audio Server] ESP32 disconnected');
    esp32AudioClients = esp32AudioClients.filter(c => c !== socket);
  });

  socket.on('error', (err) => {
    console.error('[Audio Server] ESP32 socket error:', err.message);
  });
});

function startAudioServer(port = 3001) {
  if (audioServer.listening) return audioServer;
  audioServer.listen(port, () => {
    console.log(`Audio Server listening on port ${port} (TCP)`);
  });
  return audioServer;
}

// Helper to broadcast PCM audio to all connected ESP32s
function broadcastAudioToESP32(pcmBuffer) {
  for (const client of esp32AudioClients) {
    try {
      client.write(pcmBuffer);
    } catch (err) {
      console.error('[Audio Server] Failed to write to ESP32:', err.message);
    }
  }
}

// Active live sessions mapped by socket.id
const activeLiveSessions = new Map();

function closeLiveSession(socketId, reason) {
  const session = activeLiveSessions.get(socketId);
  if (!session) return Promise.resolve();

  console.log(`[Socket ${socketId}] Closing Live Mentor Session${reason ? ` (${reason})` : ''}`);
  activeLiveSessions.delete(socketId);

  try {
    session.sendRealtimeInput({ audioStreamEnd: true });
  } catch (err) {
    console.warn(`[Socket ${socketId}] Failed to signal Live audio end:`, err.message);
  }

  try {
    return Promise.resolve(session.close()).catch((err) => {
      console.warn(`[Socket ${socketId}] Failed to close Live session:`, err.message);
    });
  } catch (err) {
    console.warn(`[Socket ${socketId}] Failed to close Live session:`, err.message);
    return Promise.resolve();
  }
}

function extractAudioSampleRate(mimeType, fallback = 24000) {
  const match = /rate=(\d+)/i.exec(mimeType || '');
  return match ? parseInt(match[1], 10) : fallback;
}

function pcm16MonoToWavBase64(pcmBase64, sampleRate = 24000) {
  const pcmBuffer = Buffer.from(pcmBase64, 'base64');
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  const blockAlign = 2;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]).toString('base64');
}

function makeBrowserPlayableAudio({ audioBase64, mimeType }) {
  const normalizedMimeType = mimeType || 'audio/wav';
  const isRawPcm = /audio\/(?:pcm|l16)/i.test(normalizedMimeType);

  if (!isRawPcm) {
    return { audioBase64, mimeType: normalizedMimeType };
  }

  return {
    audioBase64: pcm16MonoToWavBase64(audioBase64, extractAudioSampleRate(normalizedMimeType)),
    mimeType: 'audio/wav'
  };
}

function buildLiveMentorContext(data = {}) {
  const {
    move,
    fen,
    pgn,
    evaluation,
    previousEvaluation,
    bestMove,
    turn,
    gamePhase
  } = data;

  const currentEval = Number.isFinite(Number(evaluation)) ? Number(evaluation) : null;
  const priorEval = Number.isFinite(Number(previousEvaluation)) ? Number(previousEvaluation) : null;
  let moveQuality = 'unknown';

  if (currentEval !== null && priorEval !== null) {
    const whiteDelta = currentEval - priorEval;
    if (whiteDelta <= -2) moveQuality = 'likely blunder';
    else if (whiteDelta <= -0.8) moveQuality = 'likely mistake';
    else if (whiteDelta >= 0.8) moveQuality = 'strong move';
    else moveQuality = 'roughly balanced';
  }

  return [
    'System event from the chessboard.',
    `Player move: ${move || 'unknown'}.`,
    `FEN: ${fen || 'unknown'}.`,
    `PGN: ${pgn || 'not provided'}.`,
    `Evaluation for White: ${currentEval !== null ? currentEval : 'unknown'}.`,
    `Previous evaluation for White: ${priorEval !== null ? priorEval : 'unknown'}.`,
    `Move quality estimate: ${moveQuality}.`,
    `Engine best move: ${bestMove || 'unknown'}.`,
    `Side to move after this move: ${turn || 'unknown'}.`,
    `Game phase: ${gamePhase || 'unknown'}.`,
    'Give one concise spoken coaching reaction. Do not use markdown. Do not reveal the exact best move unless the player asks for it.'
  ].join('\n');
}

io.on('connection', (socket) => {
  console.log('A client connected:', socket.id);

  // Setup Gemini Live session for Mentor Mode
  socket.on('start-live-mentor', async () => {
    console.log(`[Socket ${socket.id}] Starting Live Mentor Session`);
    
    try {
      // Disconnect existing if any
      if (activeLiveSessions.has(socket.id)) {
        await closeLiveSession(socket.id, 'restart');
      }

      // Establish connection to Gemini Live via the SDK
      const session = await ai.live.connect({
        model: GEMINI_LIVE_MODEL,
        config: {
          responseModalities: ['AUDIO'],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: GEMINI_VOICE
              }
            }
          },
          systemInstruction: {
            parts: [{
              text: "You are a friendly Grandmaster chess coach. The user is playing White. You receive live microphone audio and structured chessboard events containing SAN moves, FEN, engine evaluation, and best move hints. Respond naturally and concisely. Point out clear mistakes, blunders, and strategic ideas, but do not reveal the exact best move unless the user explicitly asks. Do not output markdown; speak plain conversational sentences."
            }]
          }
        },
        callbacks: {
          onopen: () => {
            console.log(`[Socket ${socket.id}] Connected to Gemini Live API`);
            socket.emit('live-mentor-ready');
          },
          onmessage: (msg) => {
            if (msg.serverContent?.inputTranscription?.text) {
              socket.emit('live-mentor-user-transcript', msg.serverContent.inputTranscription.text);
            }

            if (msg.serverContent?.outputTranscription?.text) {
              socket.emit('live-mentor-transcript', msg.serverContent.outputTranscription.text);
            }

            // Process message from Gemini Live
            if (msg.serverContent?.modelTurn?.parts) {
              for (const part of msg.serverContent.modelTurn.parts) {
                // If text transcript is returned, send to client for subtitles
                if (part.text) {
                  socket.emit('live-mentor-transcript', part.text);
                }
                
                // If raw PCM audio is returned, broadcast to ESP32 speakers AND send to client
                if (part.inlineData && part.inlineData.data) {
                  // Gemini Live returns 24kHz 16-bit Mono PCM
                  const pcmBase64 = part.inlineData.data;
                  const mimeType = part.inlineData.mimeType || 'audio/pcm;rate=24000';
                  const pcmBuffer = Buffer.from(pcmBase64, 'base64');
                  
                  // Broadcast raw PCM to ESP32 speakers!
                  broadcastAudioToESP32(pcmBuffer);
                  
                  // Send to client for subtitle timing / browser fallback
                  socket.emit('live-mentor-audio', {
                    data: pcmBase64,
                    mimeType,
                    sampleRate: extractAudioSampleRate(mimeType)
                  });
                }
              }
            }
          },
          onerror: (err) => {
            console.error(`[Socket ${socket.id}] Gemini Live Error:`, err);
            socket.emit('live-mentor-error', err.message);
          },
          onclose: () => {
            console.log(`[Socket ${socket.id}] Gemini Live Closed`);
            socket.emit('live-mentor-closed');
            activeLiveSessions.delete(socket.id);
          }
        }
      });

      activeLiveSessions.set(socket.id, session);

    } catch (err) {
      console.error('Failed to connect to Gemini Live:', err);
      socket.emit('live-mentor-error', err.message);
    }
  });

  // Client streams mic audio chunk (raw PCM 16kHz 16-bit Mono)
  socket.on('live-mentor-audio-chunk', (pcmBase64) => {
    const session = activeLiveSessions.get(socket.id);
    if (session) {
      try {
        session.sendRealtimeInput({
          audio: {
            mimeType: 'audio/pcm;rate=16000',
            data: pcmBase64
          }
        });
      } catch (err) {
        console.error(`[Socket ${socket.id}] Failed to send Live audio chunk:`, err.message);
        socket.emit('live-mentor-error', err.message);
      }
    }
  });

  // Client streams system text event (move played, FEN status)
  socket.on('live-mentor-move', (data) => {
    const session = activeLiveSessions.get(socket.id);
    if (session) {
      const contextMessage = buildLiveMentorContext(data);
      console.log(`[Live Mentor] Move context:\n${contextMessage}`);
      try {
        session.sendRealtimeInput({ text: contextMessage });
      } catch (err) {
        console.error(`[Socket ${socket.id}] Failed to send Live move context:`, err.message);
        socket.emit('live-mentor-error', err.message);
      }
    }
  });

  socket.on('stop-live-mentor', async () => {
    if (activeLiveSessions.has(socket.id)) {
      await closeLiveSession(socket.id, 'client stop');
    }
  });

  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    if (activeLiveSessions.has(socket.id)) {
      await closeLiveSession(socket.id, 'disconnect');
    }
  });
});



// Fallback all non-API and non-socket routes to React's index.html (SPA Router Support)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

function startHttpServer(port = process.env.PORT || 3000) {
  if (server.listening) return server;
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
  return server;
}

function startServers() {
  startAudioServer(3001);
  startHttpServer();
  return { server, audioServer };
}

if (require.main === module) {
  startServers();
}

module.exports = {
  app,
  server,
  audioServer,
  startServers,
  physicalPlanner: {
    PHYSICAL_START_FEN,
    DEFAULT_Z_GRAVEYARD_SLOTS,
    DEFAULT_GRAVEYARD_SLOTS,
    normalizeGraveyardSlots,
    withPhysicalPlanningContext,
    buildBoardTransferPlan,
    buildRobotMoveCommand,
    summarizeMotionPlan,
    legalMoveMatchesUci,
    moveToUci
  },
  physicalBoardTest: {
    physicalSession,
    processPhysicalSnapshot,
    queueRobotReply,
    pausePendingRobotJobAfterFailure,
    startPhysicalUndoTurn,
    startPhysicalRedoTurn,
    completePendingUndoRobotJob,
    completePendingRedoRobotJob,
    serializePhysicalState,
    occupancyFromGame,
    occupancyFromFen,
    squareToIndex,
    normalizeProfile,
    clampLevel
  }
};
