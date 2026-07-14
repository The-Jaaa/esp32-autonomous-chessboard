import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { useSocket } from '../context/useSocket';
import { Mic, MicOff, MessageSquare, Volume2, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

const extractSampleRate = (mimeType) => {
  const match = /rate=(\d+)/i.exec(mimeType || '');
  return match ? parseInt(match[1], 10) : null;
};

const base64ToBytes = (base64Str) => {
  const binaryString = window.atob(base64Str);
  const bytes = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index++) {
    bytes[index] = binaryString.charCodeAt(index);
  }
  return bytes;
};

const pcm16ToAudioBuffer = (audioCtx, base64Str, sampleRate) => {
  const bytes = base64ToBytes(base64Str);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const audioBuffer = audioCtx.createBuffer(1, sampleCount, sampleRate);
  const channelData = audioBuffer.getChannelData(0);

  for (let index = 0; index < sampleCount; index++) {
    channelData[index] = view.getInt16(index * 2, true) / 32768;
  }

  return audioBuffer;
};

const fetchEngineContext = async (positionFen) => {
  const response = await fetch(`/api/evaluate?fen=${encodeURIComponent(positionFen)}&depth=5`);
  const data = await response.json();
  if (!data.success) throw new Error(data.error || 'Engine evaluation failed');

  return {
    evaluation: data.evaluation,
    bestMove: data.bestmove ? data.bestmove.split(' ')[1] : null,
    mate: data.mate
  };
};

const getGamePhase = (gameCopy) => {
  if (gameCopy.isCheckmate()) return 'checkmate';
  if (gameCopy.isDraw()) return 'draw';
  if (gameCopy.isGameOver()) return 'game over';
  const ply = gameCopy.history().length;
  if (ply < 16) return 'opening';
  if (ply < 50) return 'middlegame';
  return 'endgame';
};

export default function LiveMentor() {
  const socket = useSocket();
  const [game, setGame] = useState(new Chess());
  const [fen, setFen] = useState(game.fen());
  const [isMentorActive, setIsMentorActive] = useState(false);
  const [statusText, setStatusText] = useState('Disconnected');
  const [messages, setMessages] = useState([]);
  
  // Audio Context and Refs
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const animationRef = useRef(null);
  const canvasRef = useRef(null);
  const outputPlaybackTimeRef = useRef(0);
  
  // Microphone streaming refs
  const micStreamRef = useRef(null);
  const micContextRef = useRef(null);
  const micSourceRef = useRef(null);
  const processorNodeRef = useRef(null);
  const silentGainRef = useRef(null);
  const chatEndRef = useRef(null);
  const socketRef = useRef(null);
  const gameRef = useRef(game);
  const isMentorActiveRef = useRef(false);
  const currentEvaluationRef = useRef(null);
  const bestMoveRef = useRef(null);

  useEffect(() => {
    isMentorActiveRef.current = isMentorActive;
  }, [isMentorActive]);

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  // Auto-scroll chat panel to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const addLogMessage = useCallback((role, text) => {
    const sender = role === 'system'
      ? 'System'
      : role === 'user'
        ? 'Player'
        : role === 'voice'
          ? 'Player Voice'
          : 'Gemini Coach';

    setMessages((prev) => [
      ...prev,
      {
        role,
        sender,
        text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      }
    ]);
  }, []);

  // Toggle Live Mentor Mode
  const toggleMentorMode = () => {
    if (!socket) return;
    
    if (!isMentorActive) {
      setIsMentorActive(true);
      isMentorActiveRef.current = true;
      outputPlaybackTimeRef.current = 0;
      setStatusText('Connecting to Gemini Live...');
      setMessages([]);
      addLogMessage('system', 'Starting Live Mentor Session...');
      fetchEngineContext(fen)
        .then((context) => {
          currentEvaluationRef.current = context.evaluation;
          bestMoveRef.current = context.bestMove;
        })
        .catch((err) => {
          console.warn('Initial Live mentor engine context unavailable:', err);
        });
      socket.emit('start-live-mentor');
    } else {
      setIsMentorActive(false);
      isMentorActiveRef.current = false;
      setStatusText('Disconnected');
      socket.emit('stop-live-mentor');
      stopMicrophoneStreaming();
      stopBrowserAudio();
      addLogMessage('system', 'Stopped Live Mentor Session.');
    }
  };

  // Microphone capture and streaming
  const startMicrophoneStreaming = useCallback(async () => {
    try {
      if (micStreamRef.current) return;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
      micStreamRef.current = stream;

      const micContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      if (micContext.state === 'suspended') await micContext.resume();
      micContextRef.current = micContext;

      const source = micContext.createMediaStreamSource(stream);
      micSourceRef.current = source;
      const processorNode = micContext.createScriptProcessor(4096, 1, 1);
      processorNodeRef.current = processorNode;
      const silentGain = micContext.createGain();
      silentGain.gain.value = 0;
      silentGainRef.current = silentGain;

      processorNode.onaudioprocess = (e) => {
        const activeSocket = socketRef.current;
        if (!activeSocket || !isMentorActiveRef.current) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmVal = new Int16Array(inputData.length);
        
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmVal[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const buffer = pcmVal.buffer;
        const base64PCM = btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)));
        activeSocket.emit('live-mentor-audio-chunk', base64PCM);
      };

      source.connect(processorNode);
      processorNode.connect(silentGain);
      silentGain.connect(micContext.destination);
      addLogMessage('system', 'Microphone active. Voice streaming enabled.');
    } catch (err) {
      console.error("Failed to access mic:", err);
      addLogMessage('system', 'Failed to access mic. Verify system permissions.');
      setIsMentorActive(false);
      isMentorActiveRef.current = false;
      setStatusText('Microphone Access Error');
      socketRef.current?.emit('stop-live-mentor');
    }
  }, [addLogMessage]);

  const stopMicrophoneStreaming = useCallback(() => {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }
    if (micSourceRef.current) {
      micSourceRef.current.disconnect();
      micSourceRef.current = null;
    }
    if (processorNodeRef.current) {
      processorNodeRef.current.onaudioprocess = null;
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }
    if (silentGainRef.current) {
      silentGainRef.current.disconnect();
      silentGainRef.current = null;
    }
    if (micContextRef.current) {
      micContextRef.current.close();
      micContextRef.current = null;
    }
  }, []);

  const stopBrowserAudio = useCallback(() => {
    outputPlaybackTimeRef.current = 0;

    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {}
      analyserRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, []);

  const drawVisualizer = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyserRef.current) return;
    const canvasCtx = canvas.getContext('2d');
    const analyser = analyserRef.current;

    analyser.fftSize = 512;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    if (animationRef.current) return;

    const renderFrame = () => {
      if (!canvasRef.current) return;
      animationRef.current = requestAnimationFrame(renderFrame);

      analyser.getByteFrequencyData(dataArray);

      canvasCtx.fillStyle = 'rgba(15, 23, 42, 0.2)';
      canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 1.5;
        // Gradient color effect
        canvasCtx.fillStyle = `rgb(${barHeight + 60}, 120, 246)`;
        canvasCtx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }
    };

    renderFrame();
  }, []);

  const playLiveAudio = useCallback(async (base64Str, sampleRate = 24000) => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const audioCtx = audioCtxRef.current;
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      if (!analyserRef.current) {
        analyserRef.current = audioCtx.createAnalyser();
      }
      const analyser = analyserRef.current;

      const decodedData = pcm16ToAudioBuffer(audioCtx, base64Str, sampleRate);
      const source = audioCtx.createBufferSource();
      source.buffer = decodedData;

      source.connect(analyser);
      analyser.connect(audioCtx.destination);

      const startAt = Math.max(audioCtx.currentTime, outputPlaybackTimeRef.current);
      source.start(startAt);
      outputPlaybackTimeRef.current = startAt + decodedData.duration;

      drawVisualizer();
    } catch (error) {
      console.error('Live audio playback error:', error);
    }
  }, [drawVisualizer]);

  const sendMoveContext = useCallback(async (moveObj, gameCopy) => {
    const previousEvaluation = currentEvaluationRef.current;
    const context = {
      move: moveObj.san,
      fen: gameCopy.fen(),
      pgn: gameCopy.pgn(),
      previousEvaluation,
      bestMove: bestMoveRef.current,
      turn: gameCopy.turn() === 'w' ? 'White' : 'Black',
      gamePhase: getGamePhase(gameCopy)
    };

    try {
      const engineContext = await fetchEngineContext(gameCopy.fen());
      context.evaluation = engineContext.evaluation;
      context.bestMove = engineContext.bestMove;
      context.mate = engineContext.mate;
      currentEvaluationRef.current = engineContext.evaluation;
      bestMoveRef.current = engineContext.bestMove;
    } catch (err) {
      console.warn('Live mentor engine context unavailable:', err);
      addLogMessage('system', 'Engine context unavailable; sent move and FEN only.');
    }

    if (socketRef.current && isMentorActiveRef.current) {
      socketRef.current.emit('live-mentor-move', context);
    }
  }, [addLogMessage]);

  // Keep one stable subscription per socket while reading the latest game from a ref.
  useEffect(() => {
    if (!socket) return;

    const handleReady = () => {
      setStatusText('Listening (Speak Now)...');
      startMicrophoneStreaming();
    };

    const handleTranscript = (text) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'model') {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...last,
            text: `${last.text} ${text}`.trim(),
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          };
          return updated;
        }

        return [
          ...prev,
          {
            role: 'model',
            sender: 'Gemini Coach',
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          }
        ];
      });
    };

    const handleUserTranscript = (text) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'voice') {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...last,
            text: `${last.text} ${text}`.trim(),
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          };
          return updated;
        }

        return [
          ...prev,
          {
            role: 'voice',
            sender: 'Player Voice',
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          }
        ];
      });
    };

    const handleAudio = (payload) => {
      const data = typeof payload === 'string' ? payload : payload?.data;
      const sampleRate = typeof payload === 'string'
        ? 24000
        : payload?.sampleRate || extractSampleRate(payload?.mimeType) || 24000;
      if (data) playLiveAudio(data, sampleRate);
    };

    const handleClosed = () => {
      setStatusText('Session Closed');
      setIsMentorActive(false);
      isMentorActiveRef.current = false;
      stopMicrophoneStreaming();
      stopBrowserAudio();
      addLogMessage('system', 'Gemini Live Session Closed.');
    };

    const handleError = (error) => {
      console.error('[Live Mentor Socket Error]', error);
      setStatusText('Connection Error');
      addLogMessage('system', `Gemini Live error: ${error}`);
    };

    const handleEspMove = (move) => {
      const from = move.substring(0, 2);
      const to = move.substring(2, 4);
      const promotion = move.length > 4 ? move.substring(4, 5) : 'q';

      try {
        const gameCopy = new Chess(gameRef.current.fen());
        const moveObj = gameCopy.move({ from, to, promotion });
        if (moveObj) {
          gameRef.current = gameCopy;
          setGame(gameCopy);
          setFen(gameCopy.fen());
          addLogMessage('user', `Physical Move: ${moveObj.san}`);
          sendMoveContext(moveObj, gameCopy);
        }
      } catch (error) {
        console.error('Invalid move from ESP32:', move, error);
      }
    };

    socket.on('live-mentor-ready', handleReady);
    socket.on('live-mentor-transcript', handleTranscript);
    socket.on('live-mentor-user-transcript', handleUserTranscript);
    socket.on('live-mentor-audio', handleAudio);
    socket.on('live-mentor-closed', handleClosed);
    socket.on('live-mentor-error', handleError);
    socket.on('esp-move', handleEspMove);

    return () => {
      socket.off('live-mentor-ready', handleReady);
      socket.off('live-mentor-transcript', handleTranscript);
      socket.off('live-mentor-user-transcript', handleUserTranscript);
      socket.off('live-mentor-audio', handleAudio);
      socket.off('live-mentor-closed', handleClosed);
      socket.off('live-mentor-error', handleError);
      socket.off('esp-move', handleEspMove);
    };
  }, [
    addLogMessage,
    playLiveAudio,
    sendMoveContext,
    socket,
    startMicrophoneStreaming,
    stopBrowserAudio,
    stopMicrophoneStreaming
  ]);

  // Digital Board drag-and-drop move
  const onDrop = (dropArgs, maybeTargetSquare) => {
    const sourceSquare = typeof dropArgs === 'string' ? dropArgs : dropArgs?.sourceSquare;
    const targetSquare = typeof dropArgs === 'string' ? maybeTargetSquare : dropArgs?.targetSquare;

    if (game.isGameOver() || !isMentorActive || !sourceSquare || !targetSquare) return false;

    try {
      const gameCopy = new Chess(game.fen());
      const move = gameCopy.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: 'q'
      });

      if (move === null) return false;

      setGame(gameCopy);
      setFen(gameCopy.fen());
      
      // Log move in chat panel
      addLogMessage('user', `Played Move: ${move.san}`);

      sendMoveContext(move, gameCopy);

      return true;
    } catch {
      return false;
    }
  };

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopMicrophoneStreaming();
      stopBrowserAudio();
      if (socketRef.current) socketRef.current.emit('stop-live-mentor');
    };
  }, [stopBrowserAudio, stopMicrophoneStreaming]);

  return (
    <div className="app-container" style={{ flexDirection: 'column', gap: '1rem', height: '92vh', maxWidth: '1600px', width: '95%' }}>
      {/* Header Bar */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', paddingBottom: '10px', borderBottom: '1px solid var(--panel-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <Link to="/" className="btn btn-secondary" style={{ padding: '8px 12px', fontSize: '0.85rem', width: 'auto', display: 'flex', alignItems: 'center', gap: '5px' }}>
            <ArrowLeft size={16} /> Back to Board
          </Link>
          <h1 style={{ fontSize: '1.4rem', margin: 0, fontWeight: '700' }}>Live Multimodal Mentor</h1>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <span style={{ fontSize: '0.85rem', color: isMentorActive ? 'var(--accent-hover)' : 'var(--text-secondary)' }}>
            Status: <strong>{statusText}</strong>
          </span>
          <button 
            onClick={toggleMentorMode}
            className={`btn ${isMentorActive ? 'btn-secondary' : 'btn-primary'}`}
            style={{ width: 'auto', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}
          >
            {isMentorActive ? <MicOff size={16} /> : <Mic size={16} />}
            {isMentorActive ? 'Stop Mentor' : 'Start Mentor'}
          </button>
        </div>
      </header>

      {/* Main Splits Layout */}
      <div style={{ display: 'flex', flex: 1, gap: '2rem', minHeight: 0, width: '100%' }}>
        {/* Left Side: Scrolling Chat Panel */}
        <section 
          className="controls-section"
          style={{
            flex: '0 0 450px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            background: 'rgba(15, 23, 42, 0.6)',
            minHeight: 0, // critical for child scroll
            height: '100%'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--panel-border)', paddingBottom: '8px' }}>
            <MessageSquare size={18} color="var(--accent-color)" />
            <h2 style={{ margin: 0, fontSize: '1rem' }}>Mentor Interaction History</h2>
          </div>

          {/* Messages Scroll Container */}
          <div 
            style={{
              flex: 1,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              paddingRight: '5px'
            }}
          >
            {messages.length === 0 ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
                <Volume2 size={40} style={{ marginBottom: '10px', opacity: 0.3 }} />
                <p style={{ fontSize: '0.9rem' }}>Live Mentor mode logs voice input transcriptions, board moves, and Grandmaster advice in real-time. Start the mentor to begin.</p>
              </div>
            ) : (
              messages.map((msg, index) => (
                <div 
                  key={index}
                  style={{
                    alignSelf: msg.role === 'user' || msg.role === 'voice' ? 'flex-end' : msg.role === 'system' ? 'center' : 'flex-start',
                    maxWidth: msg.role === 'system' ? '90%' : '85%',
                    background: msg.role === 'user' || msg.role === 'voice' ? 'var(--accent-color)' : msg.role === 'system' ? 'rgba(255,255,255,0.05)' : 'rgba(30, 41, 59, 0.9)',
                    border: msg.role === 'system' ? '1px dashed var(--panel-border)' : '1px solid var(--panel-border)',
                    borderRadius: '12px',
                    padding: '10px 12px',
                    boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '15px', marginBottom: '4px' }}>
                    <strong style={{ fontSize: '0.75rem', color: msg.role === 'user' || msg.role === 'voice' ? '#fff' : 'var(--accent-hover)' }}>{msg.sender}</strong>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{msg.timestamp}</span>
                  </div>
                  <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: '1.4', wordBreak: 'break-word', color: '#fff' }}>{msg.text}</p>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>
        </section>

        {/* Center: Interactive Chessboard */}
        <section 
          className="board-wrapper" 
          style={{ 
            flex: 1, 
            background: 'rgba(15, 23, 42, 0.3)',
            display: 'flex', 
            justifyContent: 'center', 
            alignItems: 'center' 
          }}
        >
          <div style={{ width: '100%', maxWidth: '520px', aspectRatio: '1/1' }}>
            <Chessboard 
              options={{
                position: fen,
                onPieceDrop: onDrop,
                darkSquareStyle: { backgroundColor: '#1e293b' },
                lightSquareStyle: { backgroundColor: '#e2e8f0' }
              }}
            />
          </div>
        </section>
      </div>

      {/* Bottom Row: Large Audio Wave Visualizer */}
      <footer 
        className="status-section" 
        style={{ 
          width: '100%', 
          height: '90px', 
          display: 'flex', 
          flexDirection: 'column', 
          gap: '5px', 
          padding: '10px 20px', 
          margin: 0,
          background: 'rgba(15, 23, 42, 0.7)'
        }}
      >
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: '600', textTransform: 'uppercase' }}>
          Live Stream Audio visualizer
        </span>
        <canvas 
          ref={canvasRef} 
          width="1200" 
          height="50" 
          style={{ 
            width: '100%', 
            height: '45px', 
            borderRadius: '8px', 
            background: '#090d16',
            boxShadow: 'inset 0 0 10px rgba(0,0,0,0.5)'
          }}
        ></canvas>
      </footer>
    </div>
  );
}
