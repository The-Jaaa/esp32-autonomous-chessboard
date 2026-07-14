import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { useSocket } from '../context/useSocket';
import { Link } from 'react-router-dom';

const PROFILE_OPTIONS = [
  { value: 'balanced', label: 'Balanced', description: 'Mixed human-like play for the selected level.' },
  { value: 'aggressive', label: 'Aggressive', description: 'Favors checks, captures, queen activity, and attacks.' },
  { value: 'defensive', label: 'Defensive', description: 'Favors quiet, cautious, and king-safety moves.' },
  { value: 'trickster', label: 'Trickster', description: 'Favors tactical-looking checks, captures, and threats.' },
  { value: 'chaotic', label: 'Chaotic', description: 'Maximum variety and randomness, especially at low levels.' },
  { value: 'solid', label: 'Solid', description: 'Least random; closest to Stockfish for the selected level.' }
];

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

const DEFAULT_GRAVEYARD_TEXT = [
  'Z1: 29300,34450',
  'Z2: 24800,34450',
  'Z3: 21300,34450',
  'Z4: 17300,34450',
  'Z5: 13300,34450',
  'Z6: 9300,34450',
  'Z7: 5300,34450',
  'Z8: 1300,34450',
  'I8: 1500,-350',
  'I7: 5500,-350',
  'I6: 9500,-350',
  'I5: 13700,-350',
  'I4: 17600,-350',
  'I3: 21600,-350',
  'I2: 25600,-350',
  'I1: 29600,-350'
].join('\n');

function normalizeGraveyardLabel(label) {
  const trimmed = String(label || '').trim();
  const capturedMatch = trimmed.match(/^captured\s*([1-8])$/i);
  if (capturedMatch) return `Z${capturedMatch[1]}`;
  return trimmed;
}

function parseDiagnosticSquare(value) {
  const input = String(value || '').trim().toLowerCase();
  if (!input) return null;

  if (/^\d+$/.test(input)) {
    const index = Number(input);
    if (index >= 0 && index <= 63) {
      return { index, square: PHYSICAL_INDEX_TO_SQUARE[index], raw: true };
    }
    return null;
  }

  if (/^[a-h][1-8]$/.test(input) && PHYSICAL_SQUARE_TO_INDEX.has(input)) {
    return { index: PHYSICAL_SQUARE_TO_INDEX.get(input), square: input, raw: false };
  }

  return null;
}

function parseUciMove(uci) {
  if (!uci || uci.length < 4) return null;
  return {
    from: uci.substring(0, 2),
    to: uci.substring(2, 4),
    promotion: uci.length > 4 ? uci.substring(4, 5) : 'q'
  };
}

function parseGraveyardSlots(text) {
  return text
    .split(/\r?\n/)
    .map((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return null;

      const labelMatch = trimmed.match(/^([^:]+):\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
      const plainMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);

      if (labelMatch) {
        return {
          id: `graveyard-${index + 1}`,
          label: normalizeGraveyardLabel(labelMatch[1]),
          x: Number(labelMatch[2]),
          y: Number(labelMatch[3])
        };
      }

      if (plainMatch) {
        return {
          id: `graveyard-${index + 1}`,
          label: `Graveyard ${index + 1}`,
          x: Number(plainMatch[1]),
          y: Number(plainMatch[2])
        };
      }

      return null;
    })
    .filter(Boolean);
}

function formatPhysicalLogTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function physicalLogColor(level) {
  if (level === 'error') return 'var(--danger-color)';
  if (level === 'warning') return 'var(--warning-color)';
  return 'var(--text-secondary)';
}

function physicalLogDiffSummary(entry) {
  const missing = entry?.missingSquares || [];
  const extra = entry?.extraSquares || [];
  if (!missing.length && !extra.length) return '';
  return `Missing: ${missing.join(', ') || 'none'} | Extra: ${extra.join(', ') || 'none'}`;
}

export default function GameBoard() {
  const socket = useSocket();

  // ── Authoritative game state lives in a ref, NEVER in useState ──
  // This is the key architectural decision that eliminates all stale-closure bugs.
  // Functions read directly from gameRef.current so they are always current.
  const gameRef = useRef(new Chess());

  // ── UI-only state (triggers re-renders for display) ──
  const [fen, setFen] = useState(gameRef.current.fen());
  const [history, setHistory] = useState([]);
  const [undoStack, setUndoStack] = useState([]);
  const [depth, setDepth] = useState(1);
  const [opponentProfile, setOpponentProfile] = useState('balanced');
  const [evalScore, setEvalScore] = useState('0.0');
  const [percentFill, setPercentFill] = useState(50);
  const [classification, setClassification] = useState('Waiting for move...');
  const [classColor, setClassColor] = useState('var(--text-secondary)');
  const [isEngineThinking, setIsEngineThinking] = useState(false);
  const [isCoachLoading, setIsCoachLoading] = useState(false);
  const [coachAdvice, setCoachAdvice] = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [diagSquare, setDiagSquare] = useState('');
  const [diagX, setDiagX] = useState('');
  const [diagY, setDiagY] = useState('');
  const [diagStatus, setDiagStatus] = useState('');
  const [magnetState, setMagnetState] = useState(0);
  const [optionSquares, setOptionSquares] = useState({});
  const [boardSize, setBoardSize] = useState(0);
  const [physicalState, setPhysicalState] = useState({
    active: false,
    phase: 'idle',
    setupMode: 'full',
    statusText: 'Physical board idle.',
    calibration: { ready: false, missingSquares: [], extraSquares: [] },
    board: { ready: true, missingSquares: [], extraSquares: [] },
    legalTargets: [],
    selectedSource: null,
    robotBusy: false,
    lastError: null,
    graveyardSlotCount: 0,
    nextGraveyardSlot: 0,
    canRedoPhysical: false,
    physicalRedoCount: 0,
    physicalMoveLog: []
  });
  const [physicalLogs, setPhysicalLogs] = useState([]);
  const [graveyardText, setGraveyardText] = useState(DEFAULT_GRAVEYARD_TEXT);
  const [physicalSetupMode, setPhysicalSetupMode] = useState('full');

  // ── Mutable refs for values needed inside stable callbacks ──
  const depthRef = useRef(1);
  const opponentProfileRef = useRef('balanced');
  const bestMoveRef = useRef(null);
  const lastMoveRef = useRef(null);
  const evalScoreRef = useRef('0.0');
  const isThinkingRef = useRef(false); // sync guard — updated immediately, not async
  const physicalModeRef = useRef(false);
  const lastPhysicalFenRef = useRef('');

  // ── Audio refs ──
  const canvasRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const animationRef = useRef(null);
  const boardSlotRef = useRef(null);

  // Helper: sync display state from the current game object
  const syncDisplay = useCallback(() => {
    const g = gameRef.current;
    setFen(g.fen());
    setHistory(g.history());
  }, []);

  // ── Difficulty label ──
  const depthLabel = (d) => {
    if (d === 1) return 'Complete Beginner';
    if (d === 2) return 'Beginner';
    if (d <= 5) return 'Casual';
    if (d <= 8) return 'Intermediate';
    if (d <= 11) return 'Advanced';
    return 'Expert';
  };

  // ── Evaluation via Stockfish ──
  const updateEvaluation = useCallback(async (fen, overrideDepth) => {
    const d = overrideDepth ?? depthRef.current;
    try {
      const response = await fetch(`/api/evaluate?fen=${encodeURIComponent(fen)}&depth=${d}`);
      const data = await response.json();
      if (!data.success) return;

      const best = data.bestmove ? data.bestmove.split(' ')[1] : null;
      bestMoveRef.current = best;

      let pct = 50;
      let displayStr = '0.0';

      if (data.mate) {
        displayStr = `M${Math.abs(data.mate)}`;
        pct = data.mate > 0 ? 100 : 0;
        setClassification(data.mate > 0 ? 'Mate for White' : 'Mate for Black');
        setClassColor(data.mate > 0 ? 'var(--success-color)' : 'var(--danger-color)');
      } else if (data.evaluation !== undefined) {
        const val = data.evaluation;
        displayStr = val > 0 ? `+${val}` : val.toString();
        pct = 50 + (Math.max(-5, Math.min(5, val)) / 5) * 50;

        if (val > 3) { setClassification('Winning'); setClassColor('var(--success-color)'); }
        else if (val > 1) { setClassification('Advantage'); setClassColor('var(--accent-hover)'); }
        else if (val < -3) { setClassification('Losing'); setClassColor('var(--danger-color)'); }
        else if (val < -1) { setClassification('Disadvantage'); setClassColor('var(--warning-color)'); }
        else { setClassification('Balanced'); setClassColor('var(--text-secondary)'); }
      }

      setEvalScore(displayStr);
      evalScoreRef.current = displayStr;
      setPercentFill(pct);
    } catch (err) {
      console.error('Stockfish eval error:', err);
    }
  }, []);

  // ── Engine move ──
  const makeEngineMove = useCallback(async () => {
    if (physicalModeRef.current) {
      isThinkingRef.current = false;
      setIsEngineThinking(false);
      return;
    }

    const g = gameRef.current;

    if (g.turn() !== 'b' || g.isGameOver()) {
      isThinkingRef.current = false;
      setIsEngineThinking(false);
      return;
    }

    const playFallbackMove = () => {
      const best = bestMoveRef.current;
      if (best) {
        const parsed = parseUciMove(best);
        if (parsed) {
          try {
            g.move(parsed);
            return true;
          } catch (error) {
            console.warn('[Engine fallback] Cached best move could not be applied:', best, error);
          }
        }
      }

      const moves = g.moves();
      if (moves.length > 0) {
        g.move(moves[Math.floor(Math.random() * moves.length)]);
        return true;
      }
      return false;
    };

    try {
      const response = await fetch('/api/engine-move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fen: g.fen(),
          level: depthRef.current,
          profile: opponentProfileRef.current
        })
      });
      const data = await response.json();

      if (!response.ok || !data.success || !data.move) {
        throw new Error(data.error || 'Engine move selection failed');
      }

      const parsed = parseUciMove(data.move);
      if (!parsed) throw new Error(`Invalid engine move: ${data.move}`);
      g.move(parsed);
      console.log(`[Engine Move] ${data.move} (${data.difficultyLabel}, ${data.profile}, ${data.selectionStyle})`);
    } catch (err) {
      console.error('Engine move selection error:', err);
      playFallbackMove();
    }

    syncDisplay();
    const newFen = g.fen();
    await updateEvaluation(newFen);

    if (g.isGameOver()) {
      isThinkingRef.current = false;
      setIsEngineThinking(false);
      return;
    }

    // After engine move it's White's turn again
    isThinkingRef.current = false;
    setIsEngineThinking(false);
  }, [syncDisplay, updateEvaluation]);

  // ── After user makes a move ──
  const onUserMove = useCallback(async (san) => {
    console.log('[onUserMove] Triggered with move:', san);
    isThinkingRef.current = true;
    setIsEngineThinking(true);
    lastMoveRef.current = san;

    const g = gameRef.current;
    const currentFen = g.fen();
    setUndoStack([]); // clear redo on new move

    console.log('[onUserMove] Awaiting updateEvaluation');
    await updateEvaluation(currentFen);
    console.log('[onUserMove] updateEvaluation done');

    if (g.isGameOver()) {
      console.log('[onUserMove] Game over detected');
      isThinkingRef.current = false;
      setIsEngineThinking(false);
      return;
    }

    if (g.turn() === 'b') {
      console.log('[onUserMove] Scheduling engine move');
      setTimeout(makeEngineMove, 600);
    } else {
      console.log('[onUserMove] Not black turn? Turn is:', g.turn());
      isThinkingRef.current = false;
      setIsEngineThinking(false);
    }
  }, [updateEvaluation, makeEngineMove]);

  // ── Drag & drop handler ──
  const getKingSquare = useCallback(() => {
    const g = gameRef.current;
    if (!g.isCheck() && !g.isCheckmate()) return null;
    const board = g.board();
    const turn = g.turn();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = board[r][c];
        if (piece && piece.type === 'k' && piece.color === turn) {
          return piece.square;
        }
      }
    }
    return null;
  }, []);

  const onDrop = useCallback((args) => {
    if (physicalModeRef.current) return false;

    setOptionSquares({});
    // react-chessboard v5 passes an object
    const { sourceSquare, targetSquare } = args;
    const g = gameRef.current;
    console.log(`[onDrop] Attempting ${sourceSquare} -> ${targetSquare}`);
    console.log(`[onDrop] isThinking: ${isThinkingRef.current}, gameOver: ${g.isGameOver()}, turn: ${g.turn()}`);

    // Block if engine is thinking or it's not white's turn
    if (isThinkingRef.current || g.isGameOver() || g.turn() !== 'w') {
      console.log('[onDrop] Blocked by state check');
      return false;
    }

    try {
      const move = g.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
      if (!move) {
        console.log('[onDrop] move() returned falsy');
        return false;
      }

      console.log('[onDrop] Move valid!', move.san);
      syncDisplay();
      onUserMove(move.san);
      return true;
    } catch (error) {
      console.error('[onDrop] Caught error during move:', error);
      return false;
    }
  }, [syncDisplay, onUserMove]);

  const onSquareClick = useCallback(({ square }) => {
    if (physicalModeRef.current) return;

    const g = gameRef.current;
    if (g.isGameOver() || isThinkingRef.current) return;

    // Check if the clicked square is one of the highlighted target squares
    if (optionSquares[square] && optionSquares[square].background !== 'rgba(255, 255, 0, 0.4)') {
      const sourceSq = Object.keys(optionSquares).find(sq => optionSquares[sq].background === 'rgba(255, 255, 0, 0.4)');
      if (sourceSq) {
        onDrop({ sourceSquare: sourceSq, targetSquare: square });
        setOptionSquares({});
        return;
      }
    }

    // Toggle off if clicking the same selected piece
    if (optionSquares[square] && optionSquares[square].background === 'rgba(255, 255, 0, 0.4)') {
      setOptionSquares({});
      return;
    }

    // Otherwise, generate options for the clicked square
    const piece = g.get(square);
    if (piece && piece.color === g.turn() && g.turn() === 'w') {
      const moves = g.moves({ square, verbose: true });
      if (moves.length === 0) {
        setOptionSquares({});
        return;
      }

      const newSquares = {};
      moves.forEach((move) => {
        newSquares[move.to] = {
          background: g.get(move.to) && g.get(move.to).color !== piece.color
            ? 'radial-gradient(circle, rgba(239,68,68,0.5) 85%, transparent 85%)' // Red for captures
            : 'radial-gradient(circle, rgba(0,0,0,.15) 25%, transparent 25%)',
          borderRadius: '50%'
        };
      });
      newSquares[square] = {
        background: 'rgba(255, 255, 0, 0.4)'
      };
      setOptionSquares(newSquares);
    } else {
      setOptionSquares({});
    }
  }, [onDrop, optionSquares]);

  const onPieceDrag = useCallback(({ square }) => {
    // Show possible moves as soon as the user starts dragging the piece
    if (!square) return;
    onSquareClick({ square });
  }, [onSquareClick]);

  const applyPhysicalState = useCallback((nextState = {}) => {
    setPhysicalState(prev => ({ ...prev, ...nextState }));
    const active = Boolean(nextState.active);
    physicalModeRef.current = active;

    if (nextState.fen && nextState.fen !== lastPhysicalFenRef.current) {
      try {
        gameRef.current = new Chess(nextState.fen);
        lastPhysicalFenRef.current = nextState.fen;
        setFen(nextState.fen);
        setHistory(Array.isArray(nextState.history) ? nextState.history : []);
        setUndoStack([]);
        setOptionSquares({});
        setCoachAdvice('');
        updateEvaluation(nextState.fen);
      } catch (err) {
        console.error('Failed to apply physical board FEN:', err);
      }
    }
  }, [updateEvaluation]);

  const handleStartPhysicalGame = useCallback(async () => {
    try {
      const graveyardSlots = parseGraveyardSlots(graveyardText);
      const response = await fetch('/api/physical/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            level: depthRef.current,
            profile: opponentProfileRef.current,
            setupMode: physicalSetupMode,
            graveyardSlots
          })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to start physical board mode.');
      applyPhysicalState(data.state);
    } catch (err) {
      console.error('Physical board start error:', err);
      setPhysicalState(prev => ({
        ...prev,
        active: true,
        phase: 'error',
        lastError: { message: err.message }
      }));
    }
  }, [applyPhysicalState, graveyardText, physicalSetupMode]);

  const handleRetryRobotMove = useCallback(async () => {
    try {
      const response = await fetch('/api/physical/retry-robot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to retry robot move.');
      applyPhysicalState(data.state);
    } catch (err) {
      console.error('Robot retry error:', err);
      setPhysicalState(prev => ({
        ...prev,
        statusText: err.message
      }));
    }
  }, [applyPhysicalState]);

  // ── Undo ──
  const handleUndo = useCallback(async () => {
    if (physicalModeRef.current) {
      try {
        const response = await fetch('/api/physical/undo-turn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        if (!response.ok || (!data.success && !data.recoverable)) {
          throw new Error(data.error || 'Failed to start physical undo.');
        }
        applyPhysicalState(data.state);
      } catch (err) {
        console.error('Physical undo error:', err);
        setPhysicalState(prev => ({
          ...prev,
          statusText: err.message
        }));
      }
      return;
    }

    const g = gameRef.current;
    if (g.history().length === 0 || isThinkingRef.current) return;

    const undoneMoves = [];
    const m1 = g.undo();
    if (m1) undoneMoves.push(m1);
    // If we ended up on black's turn, undo one more so it's always white's turn
    if (g.turn() !== 'w') {
      const m2 = g.undo();
      if (m2) undoneMoves.push(m2);
    }

    setUndoStack(prev => [...prev, undoneMoves]);
    syncDisplay();
    setCoachAdvice('');
    setIsSpeaking(false);
    updateEvaluation(g.fen());
  }, [applyPhysicalState, syncDisplay, updateEvaluation]);

  // ── Redo ──
  const handleRedo = useCallback(async () => {
    if (physicalModeRef.current) {
      try {
        const response = await fetch('/api/physical/redo-turn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        if (!response.ok || (!data.success && !data.recoverable)) {
          throw new Error(data.error || 'Failed to start physical redo.');
        }
        applyPhysicalState(data.state);
      } catch (err) {
        console.error('Physical redo error:', err);
        setPhysicalState(prev => ({
          ...prev,
          statusText: err.message
        }));
      }
      return;
    }

    const g = gameRef.current;
    if (isThinkingRef.current) return;

    setUndoStack(prev => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const undone = next.pop();
      for (let i = undone.length - 1; i >= 0; i--) {
        try {
          g.move(undone[i]);
        } catch (error) {
          console.error('[Redo] Failed to replay move:', undone[i], error);
        }
      }
      syncDisplay();
      updateEvaluation(g.fen());
      return next;
    });
  }, [applyPhysicalState, syncDisplay, updateEvaluation]);

  // ── Coach Me ──
  const handleCoachMe = useCallback(async () => {
    const g = gameRef.current;
    if (isThinkingRef.current || g.turn() !== 'w') return;
    setIsCoachLoading(true);
    setCoachAdvice('');

    try {
      const response = await fetch('/api/advice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fen: g.fen(),
          pgn: g.pgn(),
          evaluation: parseFloat(evalScoreRef.current) || 0,
          lastMove: lastMoveRef.current,
          bestMove: bestMoveRef.current
        })
      });
      const data = await response.json();
      setIsCoachLoading(false);
      if (data.success && data.audioChunks) {
        setCoachAdvice(data.advice);
        setIsSpeaking(true);
        playAudioChunks(data.audioChunks);
      }
    } catch (err) {
      console.error('Coach error:', err);
      setIsCoachLoading(false);
    }
  }, []);

  // ── ESP32 move from physical board ──
  useEffect(() => {
    if (!socket) return;
    const handleEspMove = (move) => {
      if (physicalModeRef.current) return;
      if (isThinkingRef.current) return;
      const g = gameRef.current;
      const from = move.substring(0, 2);
      const to = move.substring(2, 4);
      const promotion = move.length > 4 ? move.substring(4, 5) : 'q';
      try {
        const moveObj = g.move({ from, to, promotion });
        if (moveObj) {
          syncDisplay();
          onUserMove(moveObj.san);
        }
      } catch (e) {
        console.error('Invalid ESP32 move:', move, e);
      }
    };
    socket.on('esp-move', handleEspMove);
    return () => socket.off('esp-move', handleEspMove);
  }, [socket, syncDisplay, onUserMove]);

  useEffect(() => {
    if (!socket) return;

    const handlePhysicalState = (state) => applyPhysicalState(state);
    const handlePhysicalLog = (entry) => {
      setPhysicalLogs((prev) => {
        if (prev.some((item) => item.id === entry.id)) return prev;
        return [...prev, entry].slice(-120);
      });
    };

    socket.on('physical-status', handlePhysicalState);
    socket.on('physical-board', handlePhysicalState);
    socket.on('physical-move', handlePhysicalState);
    socket.on('physical-error', handlePhysicalState);
    socket.on('physical-log', handlePhysicalLog);

    return () => {
      socket.off('physical-status', handlePhysicalState);
      socket.off('physical-board', handlePhysicalState);
      socket.off('physical-move', handlePhysicalState);
      socket.off('physical-error', handlePhysicalState);
      socket.off('physical-log', handlePhysicalLog);
    };
  }, [socket, applyPhysicalState]);

  useEffect(() => {
    let cancelled = false;

    const loadPhysicalLogs = async () => {
      try {
        const response = await fetch('/api/physical/logs?limit=120');
        const data = await response.json();
        if (!cancelled && response.ok && data.success && Array.isArray(data.logs)) {
          setPhysicalLogs(data.logs);
        }
      } catch (err) {
        console.error('Failed to load physical logs:', err);
      }
    };

    loadPhysicalLogs();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Audio playback ──
  const playAudioChunks = async (chunks) => {
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const audioCtx = audioCtxRef.current;
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      if (!analyserRef.current) analyserRef.current = audioCtx.createAnalyser();
      const analyser = analyserRef.current;
      let startTime = audioCtx.currentTime;

      for (let i = 0; i < chunks.length; i++) {
        const bin = window.atob(chunks[i]);
        const bytes = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
        const decoded = await audioCtx.decodeAudioData(bytes.buffer);
        const source = audioCtx.createBufferSource();
        source.buffer = decoded;
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        source.start(startTime);
        startTime += decoded.duration;
        if (i === chunks.length - 1) source.onended = () => setIsSpeaking(false);
      }
      drawVisualizer();
    } catch (err) {
      console.error('Audio error:', err);
      setIsSpeaking(false);
    }
  };

  const drawVisualizer = () => {
    const canvas = canvasRef.current;
    if (!canvas || !analyserRef.current) return;
    const ctx = canvas.getContext('2d');
    const analyser = analyserRef.current;
    analyser.fftSize = 256;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const render = () => {
      if (!canvasRef.current) return;
      animationRef.current = requestAnimationFrame(render);
      analyser.getByteFrequencyData(dataArray);
      ctx.fillStyle = 'rgba(15,23,42,0.2)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const bw = (canvas.width / dataArray.length) * 2.5;
      let x = 0;
      dataArray.forEach(val => {
        const bh = val / 2.5;
        ctx.fillStyle = `rgb(${bh + 100},130,246)`;
        ctx.fillRect(x, canvas.height - bh, bw, bh);
        x += bw + 1;
      });
    };
    render();
  };

  useEffect(() => () => { if (animationRef.current) cancelAnimationFrame(animationRef.current); }, []);

  useLayoutEffect(() => {
    const slot = boardSlotRef.current;
    if (!slot) return;

    const syncBoardSize = () => {
      const rect = slot.getBoundingClientRect();
      const nextSize = Math.floor(Math.min(rect.width, rect.height));
      if (nextSize > 0) {
        setBoardSize(prev => (prev === nextSize ? prev : nextSize));
      }
    };

    syncBoardSize();

    const observer = new ResizeObserver(syncBoardSize);
    observer.observe(slot);
    window.addEventListener('resize', syncBoardSize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncBoardSize);
    };
  }, []);

  // ── Diagnostics ──
  const sendGantryCommand = async (payload) => {
    try {
      const res = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      setDiagStatus(data.message || data.error || 'Diagnostic command sent.');
      console.log('[Diagnostics]', data.message || data.error);
    } catch (err) {
      setDiagStatus(`Diagnostics error: ${err.message}`);
      console.error('Diagnostics error:', err);
    }
  };
  const handleHomeGantry = () => sendGantryCommand({ type: 'home' });
  const handleToggleMagnet = () => { const n = magnetState === 0 ? 1 : 0; setMagnetState(n); sendGantryCommand({ type: 'magnet', val: n }); };
  const handleGoSquare = () => {
    const resolved = parseDiagnosticSquare(diagSquare);
    if (resolved) {
      setDiagStatus(`Resolved ${diagSquare.trim()} to raw index ${resolved.index} (${resolved.square}).`);
      sendGantryCommand({ type: 'square', index: resolved.index });
    } else {
      alert('Enter a chess square like A1/G4 or a raw index from 0-63.');
    }
  };
  const handleDragSquare = () => {
    const resolved = parseDiagnosticSquare(diagSquare);
    if (resolved) {
      setDiagStatus(`Resolved ${diagSquare.trim()} to raw index ${resolved.index} (${resolved.square}) for drag.`);
      sendGantryCommand({ type: 'drag', index: resolved.index });
    } else {
      alert('Enter a chess square like A1/G4 or a raw index from 0-63.');
    }
  };
  const handleGoXY = () => { const x = parseInt(diagX), y = parseInt(diagY); if (!isNaN(x) && !isNaN(y)) sendGantryCommand({ type: 'xy', x, y }); else alert('Invalid XY values.'); };
  const handleAddGraveyardSlot = () => {
    const x = parseInt(diagX, 10);
    const y = parseInt(diagY, 10);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      alert('Enter valid X and Y coordinates before adding a graveyard slot.');
      return;
    }

    setGraveyardText((prev) => {
      const existingLines = prev.split('\n').filter((line) => line.trim().length > 0);
      const usedLabels = new Set(existingLines
        .map((line) => line.split(':')[0]?.trim().toUpperCase())
        .filter(Boolean));
      const laneLabels = [
        ...Array.from({ length: 8 }, (_, index) => `Z${index + 1}`),
        ...Array.from({ length: 8 }, (_, index) => `I${index + 1}`)
      ];
      const nextLabel = laneLabels.find((label) => !usedLabels.has(label)) || `Captured ${existingLines.length + 1}`;
      const nextLine = `${nextLabel}: ${x},${y}`;
      return existingLines.length > 0 ? `${existingLines.join('\n')}\n${nextLine}` : nextLine;
    });
    setDiagStatus(`Added graveyard slot at ${x},${y}. Recalibrate/start physical mode to use it.`);
  };

  // ── JSX ──
  const selectedProfile = PROFILE_OPTIONS.find((profile) => profile.value === opponentProfile) || PROFILE_OPTIONS[0];
  const calibration = physicalState.calibration || { ready: false, missingSquares: [], extraSquares: [] };
  const boardSync = physicalState.phase === 'setup'
    ? calibration
    : physicalState.board || { ready: true, missingSquares: [], extraSquares: [] };
  const physicalErrorMessage = physicalState.lastError?.message || null;
  const diagnosticSquareResolved = parseDiagnosticSquare(diagSquare);
  const visiblePhysicalLogs = physicalLogs.slice(-12).reverse();
  const physicalUndoDisabled = physicalState.active
    ? !physicalState.canUndoPhysical || physicalState.robotBusy || ['setup', 'piece_lifted', 'castle_pending_rook', 'sync_warning', 'error', 'undo_waiting_human_restore'].includes(physicalState.phase)
    : history.length === 0 || isEngineThinking;
  const physicalRedoDisabled = physicalState.active
    ? !physicalState.canRedoPhysical || physicalState.robotBusy || ['setup', 'piece_lifted', 'castle_pending_rook', 'sync_warning', 'error', 'undo_waiting_human_restore'].includes(physicalState.phase)
    : undoStack.length === 0 || isEngineThinking;
  const displayedMoveLog = physicalState.active
    ? (Array.isArray(physicalState.physicalMoveLog) ? physicalState.physicalMoveLog : [])
    : history.map((move, index) => ({ id: `virtual-${index}`, san: move, side: index % 2 === 0 ? 'human' : 'engine' }));

  const boardOptions = useMemo(() => {
    const styles = { ...optionSquares };

    if (physicalState.active) {
      if (physicalState.selectedSource) {
        styles[physicalState.selectedSource] = {
          background: 'rgba(59, 130, 246, 0.45)'
        };
      }

      (physicalState.legalTargets || []).forEach((target) => {
        styles[target.to] = {
          background: target.special
            ? 'radial-gradient(circle, rgba(168,85,247,0.65) 70%, transparent 72%)'
            : target.capture
              ? 'radial-gradient(circle, rgba(239,68,68,0.6) 70%, transparent 72%)'
              : 'radial-gradient(circle, rgba(34,197,94,0.45) 30%, transparent 32%)',
          borderRadius: '50%'
        };
      });
    }

    const kSq = getKingSquare();
    if (kSq) {
      styles[kSq] = {
        background: 'radial-gradient(ellipse at center, rgba(239, 68, 68, 0.8) 0%, rgba(239, 68, 68, 0.5) 40%, rgba(0,0,0,0) 80%)',
        borderRadius: '50%'
      };
    }
    return {
      position: fen,
      onPieceDrop: onDrop,
      onPieceDrag: onPieceDrag,
      onSquareClick: onSquareClick,
      darkSquareStyle: { backgroundColor: '#1e293b' },
      lightSquareStyle: { backgroundColor: '#e2e8f0' },
      squareStyles: styles
    };
  }, [fen, getKingSquare, onDrop, onPieceDrag, onSquareClick, optionSquares, physicalState]);

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="logo-container">
          <div className="logo-icon">♔</div>
          <h1>Companion Board</h1>
        </div>

        <div className="controls-section">
          <h2>Game Controls</h2>

          <div className="mode-toggle">
            <div className="mode-info" style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3>Difficulty</h3>
                <span style={{ fontSize: '0.8rem', color: 'var(--accent-color)', fontWeight: '600' }}>
                  {depthLabel(depth)}&nbsp;
                  <span style={{ opacity: 0.6 }}>(Level {depth})</span>
                </span>
              </div>
              <input
                type="range" min="1" max="15" value={depth}
                onChange={(e) => {
                  const d = parseInt(e.target.value);
                  setDepth(d);
                  depthRef.current = d;
                  updateEvaluation(gameRef.current.fen(), d);
                }}
                style={{ width: '100%', marginTop: '10px', cursor: 'pointer', accentColor: 'var(--accent-color)' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                <span>Beginner</span><span>Expert</span>
              </div>
              <div style={{ marginTop: '14px' }}>
                <label htmlFor="opponentProfile" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '6px', fontWeight: 600 }}>
                  Opponent Style
                </label>
                <select
                  id="opponentProfile"
                  value={opponentProfile}
                  onChange={(e) => {
                    setOpponentProfile(e.target.value);
                    opponentProfileRef.current = e.target.value;
                  }}
                  style={{
                    width: '100%',
                    minWidth: 0,
                    padding: '8px 10px',
                    borderRadius: '6px',
                    border: '1px solid var(--panel-border)',
                    background: '#0f172a',
                    color: 'var(--text-primary)',
                    fontWeight: 600
                  }}
                >
                  {PROFILE_OPTIONS.map((profile) => (
                    <option key={profile.value} value={profile.value}>{profile.label}</option>
                  ))}
                </select>
                <p style={{ margin: '6px 0 0', fontSize: '0.72rem', lineHeight: 1.35, color: 'var(--text-secondary)' }}>
                  {selectedProfile.description}
                </p>
              </div>
            </div>
          </div>

          <div className="mode-toggle">
            <div className="mode-info" style={{ width: '100%' }}>
              <h3>Live Mentor Mode</h3>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '10px' }}>Real-time voice &amp; move assistant.</p>
              <Link to="/mentor" className="btn btn-secondary" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
                Open Mentor Page
              </Link>
            </div>
          </div>

          <button
            onClick={handleCoachMe}
            className="btn btn-primary"
            disabled={isEngineThinking || isCoachLoading || isSpeaking}
            style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}
          >
            <span>{isCoachLoading ? 'Thinking...' : isSpeaking ? 'Speaking...' : 'Coach Me'}</span>
            {isCoachLoading && <div className="loader" style={{ marginLeft: '8px' }}></div>}
          </button>
        </div>

        <div className="status-section">
          <h2>Evaluation</h2>
          <div className="classification-badge" style={{ color: classColor }}>{classification}</div>
        </div>

        <div className="controls-section">
          <h2>Physical Board</h2>
          <label htmlFor="physicalSetupMode" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '6px', fontWeight: 600 }}>
            Setup Mode
          </label>
          <select
            id="physicalSetupMode"
            value={physicalSetupMode}
            onChange={(event) => setPhysicalSetupMode(event.target.value)}
            disabled={physicalState.robotBusy}
            style={{
              width: '100%',
              marginBottom: '10px',
              padding: '8px 10px',
              borderRadius: '6px',
              border: '1px solid var(--panel-border)',
              background: '#0f172a',
              color: 'var(--text-primary)',
              fontSize: '0.8rem',
              boxSizing: 'border-box'
            }}
          >
            <option value="full">Full Starting Set</option>
            <option value="partial">Partial Starting Set</option>
          </select>
          <button
            onClick={handleStartPhysicalGame}
            className="btn btn-primary"
            disabled={physicalState.robotBusy}
            style={{ width: '100%', marginBottom: '10px' }}
          >
            {physicalState.active ? 'Recalibrate Board' : physicalSetupMode === 'partial' ? 'Start Partial Game' : 'Start Physical Game'}
          </button>

          <div style={{
            padding: '10px',
            borderRadius: '6px',
            border: '1px solid var(--panel-border)',
            background: '#0f172a',
            marginBottom: '10px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700 }}>Status</span>
              <span style={{
                fontSize: '0.75rem',
                color: physicalState.phase === 'error' ? 'var(--danger-color)' : boardSync.ready ? 'var(--success-color)' : 'var(--warning-color)',
                fontWeight: 700,
                textTransform: 'uppercase'
              }}>
                {physicalState.phase || 'idle'}
              </span>
            </div>
            <p style={{ margin: '6px 0 0', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.35 }}>
              {physicalState.statusText || 'Physical board idle.'}
            </p>
            {physicalErrorMessage && (
              <p style={{ margin: '6px 0 0', fontSize: '0.75rem', color: 'var(--danger-color)', lineHeight: 1.35 }}>
                {physicalErrorMessage}
              </p>
            )}
            {physicalState.active && (
              <div style={{ marginTop: '8px', fontSize: '0.72rem', color: 'var(--text-secondary)', lineHeight: 1.35 }}>
                <div>Missing: {boardSync.missingSquares?.length ? boardSync.missingSquares.slice(0, 8).join(', ') : 'none'}</div>
                <div>Extra: {boardSync.extraSquares?.length ? boardSync.extraSquares.slice(0, 8).join(', ') : 'none'}</div>
                <div>Mode: {physicalState.setupMode === 'partial' ? 'partial' : 'full'}</div>
                <div>Graveyard: {physicalState.graveyardSlotCount || 0} slots</div>
              </div>
            )}
          </div>

          {physicalState.phase === 'sync_warning' && physicalState.pendingRobotJob && (
            <button
              onClick={handleRetryRobotMove}
              className="btn btn-primary"
              style={{ width: '100%', marginBottom: '10px' }}
            >
              Retry Robot Move
            </button>
          )}

          <label htmlFor="graveyardSlots" style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '6px', fontWeight: 600 }}>
            Graveyard Slots
          </label>
          <textarea
            id="graveyardSlots"
            value={graveyardText}
            onChange={(event) => setGraveyardText(event.target.value)}
            placeholder={'Z1: -2500,3000\nZ2: -2500,7000\nI1: 33500,3000'}
            rows={3}
            style={{
              width: '100%',
              minWidth: 0,
              resize: 'vertical',
              padding: '8px 10px',
              borderRadius: '6px',
              border: '1px solid var(--panel-border)',
              background: '#0f172a',
              color: 'var(--text-primary)',
              fontSize: '0.75rem',
              boxSizing: 'border-box'
            }}
          />
          <p style={{ margin: '6px 0 0', fontSize: '0.7rem', lineHeight: 1.35, color: 'var(--text-secondary)' }}>
            Use Z1-Z8 on the a-side lane and I1-I8 on the h-side lane. Captures require at least one slot.
          </p>
        </div>

        <div className="controls-section">
          <h2>Physical Log</h2>
          <div style={{
            height: '190px',
            overflowY: 'auto',
            borderRadius: '6px',
            border: '1px solid var(--panel-border)',
            background: '#0f172a',
            padding: '8px',
            boxSizing: 'border-box'
          }}>
            {visiblePhysicalLogs.length === 0 ? (
              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.35 }}>
                No physical board events yet.
              </p>
            ) : visiblePhysicalLogs.map((entry) => {
              const diffSummary = physicalLogDiffSummary(entry);
              return (
                <div key={entry.id || `${entry.timestamp}-${entry.type}`} style={{
                  padding: '7px 0',
                  borderBottom: '1px solid rgba(148, 163, 184, 0.16)'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.68rem', color: physicalLogColor(entry.level), fontWeight: 800, textTransform: 'uppercase' }}>
                      {entry.level || 'info'}
                    </span>
                    <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                      {formatPhysicalLogTime(entry.timestamp)}
                    </span>
                  </div>
                  <div style={{ marginTop: '3px', fontSize: '0.74rem', color: 'var(--text-primary)', lineHeight: 1.3 }}>
                    {entry.message || entry.type}
                  </div>
                  <div style={{ marginTop: '2px', fontSize: '0.68rem', color: 'var(--text-secondary)', lineHeight: 1.3 }}>
                    {entry.type}{entry.commandId ? ` | ${entry.commandId}` : ''}
                  </div>
                  {diffSummary && (
                    <div style={{ marginTop: '3px', fontSize: '0.68rem', color: 'var(--warning-color)', lineHeight: 1.3 }}>
                      {diffSummary}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="controls-section">
          <h2>Gantry Diagnostics</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
            <button onClick={handleHomeGantry} className="btn btn-secondary" style={{ padding: '8px', fontSize: '0.85rem' }}>Home Gantry</button>
            <button onClick={handleToggleMagnet} className={`btn ${magnetState === 1 ? 'btn-primary' : 'btn-secondary'}`} style={{ padding: '8px', fontSize: '0.85rem' }}>
              Magnet: {magnetState === 1 ? 'ON' : 'OFF'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: '5px', marginBottom: '6px', alignItems: 'center' }}>
            <input type="text" placeholder="Square e.g. A1 or raw 56" value={diagSquare} onChange={(e) => setDiagSquare(e.target.value)}
              style={{ flex: 1, padding: '6px', fontSize: '0.8rem', borderRadius: '4px', border: '1px solid var(--panel-border)', background: '#0f172a', color: 'white' }} />
            <button onClick={handleGoSquare} className="btn btn-primary" style={{ padding: '6px 10px', fontSize: '0.8rem', margin: 0, width: 'auto' }}>Go</button>
            <button onClick={handleDragSquare} className="btn btn-primary" style={{ padding: '6px 10px', fontSize: '0.8rem', margin: 0, width: 'auto', background: 'var(--success-color)' }}>Drag</button>
          </div>
          <p style={{ margin: '0 0 10px', fontSize: '0.7rem', lineHeight: 1.35, color: 'var(--text-secondary)' }}>
            {diagnosticSquareResolved
              ? `${diagSquare.trim()} resolves to raw index ${diagnosticSquareResolved.index} (${diagnosticSquareResolved.square}).`
              : 'Type a chess square such as A1/G4, or a raw physical index from 0-63.'}
          </p>
          <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
            <input type="number" placeholder="X steps" value={diagX} onChange={(e) => setDiagX(e.target.value)}
              style={{ flex: 1, minWidth: 0, padding: '6px', fontSize: '0.8rem', borderRadius: '4px', border: '1px solid var(--panel-border)', background: '#0f172a', color: 'white' }} />
            <input type="number" placeholder="Y steps" value={diagY} onChange={(e) => setDiagY(e.target.value)}
              style={{ flex: 1, minWidth: 0, padding: '6px', fontSize: '0.8rem', borderRadius: '4px', border: '1px solid var(--panel-border)', background: '#0f172a', color: 'white' }} />
            <button onClick={handleGoXY} className="btn btn-primary" style={{ padding: '6px 10px', fontSize: '0.8rem', margin: 0, width: 'auto' }}>Go XY</button>
          </div>
          <button
            onClick={handleAddGraveyardSlot}
            className="btn btn-secondary"
            style={{ width: '100%', marginTop: '8px', padding: '8px', fontSize: '0.85rem' }}
          >
            Add XY as Graveyard Slot
          </button>
          {diagStatus && (
            <p style={{ margin: '6px 0 0', fontSize: '0.7rem', lineHeight: 1.35, color: 'var(--text-secondary)' }}>
              {diagStatus}
            </p>
          )}
        </div>

        <div className="connection-status">
          <div className={`indicator ${socket && socket.connected ? 'online' : 'offline'}`}></div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {socket && socket.connected ? 'Connected to Physical Board' : 'Disconnected'}
          </span>
        </div>
      </aside>

      <main className="board-area">
        <div className="board-wrapper">
          <div className="eval-bar-container" style={boardSize ? { height: `${boardSize}px` } : undefined}>
            <div className="eval-bar-fill" style={{ height: `${percentFill}%` }}></div>
            <span className="eval-score-text">{evalScore}</span>
          </div>
          <div className="board-square-wrapper" ref={boardSlotRef}>
            <div className="chessboard-stage" style={boardSize ? { width: `${boardSize}px`, height: `${boardSize}px` } : undefined}>
              <Chessboard options={boardOptions} />
              
              {/* Game Over Overlay */}
              {gameRef.current.isGameOver() && (
                <div style={{
                  position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                  backgroundColor: 'rgba(0, 0, 0, 0.65)',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  zIndex: 10, borderRadius: '4px'
                }}>
                  <h2 style={{ 
                    color: '#ef4444', 
                    fontSize: '3rem', 
                    fontWeight: 'bold', 
                    textShadow: '0 4px 10px rgba(0,0,0,0.8)',
                    marginBottom: '1rem',
                    textTransform: 'uppercase',
                    letterSpacing: '2px',
                    textAlign: 'center'
                  }}>
                    {gameRef.current.isCheckmate() ? 'Checkmate!' : (gameRef.current.isDraw() ? 'Draw!' : 'Game Over')}
                  </h2>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="board-footer" style={{ gap: '10px' }}>
          {coachAdvice && (
            <div style={{ padding: '1rem', background: 'rgba(59,130,246,0.1)', borderRadius: '12px', border: '1px solid var(--accent-color)', width: '100%', boxSizing: 'border-box' }}>
              <p style={{ fontStyle: 'italic', fontSize: '0.9rem', color: 'var(--text-primary)' }}>{coachAdvice}</p>
              <canvas ref={canvasRef} width="250" height="30" style={{ marginTop: '8px', width: '100%', height: '30px' }}></canvas>
            </div>
          )}

          <div className="move-history" style={{ width: '100%', boxSizing: 'border-box' }}>
            <div className="move-history-header">
              <h3 style={{ margin: 0 }}>Move Log</h3>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={handleUndo} className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '1rem', borderRadius: '6px', width: 'auto' }} disabled={physicalUndoDisabled}>↩ {physicalState.active ? 'Undo Turn' : 'Undo'}</button>
                <button onClick={handleRedo} className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '1rem', borderRadius: '6px', width: 'auto' }} disabled={physicalRedoDisabled}>Redo ↪</button>
              </div>
            </div>
            <div className="move-list-scroll">
              <ul id="moveList">
                {displayedMoveLog.map((entry, index) => (
                  <li
                    key={entry.id || `${entry.side || 'move'}-${index}`}
                    className={index === displayedMoveLog.length - 1 ? 'current-move' : ''}
                    title={entry.side ? `${entry.side}: ${entry.from || ''}${entry.to ? `-${entry.to}` : ''}` : ''}
                  >
                    {(index % 2 === 0 ? Math.floor(index / 2 + 1) + '. ' : '') + (entry.san || entry.move || '')}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
