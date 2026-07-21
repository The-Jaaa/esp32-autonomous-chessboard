import { useCallback, useEffect, useRef, useState } from 'react';
import {
  extractSampleRate,
  floatAudioToPcmBase64,
  pcm16ToAudioBuffer
} from './mentor-live-audio';

const ACTIVE_STATUSES = new Set([
  'connecting',
  'listening',
  'muted',
  'thinking',
  'speaking',
  'interrupted',
  'tool_running'
]);

const LIVE_AUDIO_PREFERENCES_KEY = 'mentor-live-audio-preferences-v1';
const DEFAULT_AUDIO_PREFERENCES = Object.freeze({
  outputMode: 'auto',
  deviceId: 'main-board',
  boardVolume: 50
});

function loadAudioPreferences() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(LIVE_AUDIO_PREFERENCES_KEY) || '{}');
    return {
      outputMode: ['auto', 'board', 'browser'].includes(stored.outputMode)
        ? stored.outputMode
        : DEFAULT_AUDIO_PREFERENCES.outputMode,
      deviceId: typeof stored.deviceId === 'string' && stored.deviceId
        ? stored.deviceId
        : DEFAULT_AUDIO_PREFERENCES.deviceId,
      boardVolume: Number.isFinite(Number(stored.boardVolume))
        ? Math.max(0, Math.min(100, Math.round(Number(stored.boardVolume))))
        : DEFAULT_AUDIO_PREFERENCES.boardVolume
    };
  } catch {
    return { ...DEFAULT_AUDIO_PREFERENCES };
  }
}

function initialState() {
  return {
    sessionId: null,
    status: 'inactive',
    muted: false,
    turnActive: false,
    toolBusy: false,
    toolName: null,
    toolLabel: null,
    toolCallIds: [],
    resolvedOutput: 'browser',
    speakerStatus: 'inactive',
    micGated: false
  };
}

export function useMentorLive({ socket, conversationId, onMessage, onError, onConversationChanged }) {
  const [liveState, setLiveState] = useState(initialState);
  const [partialUser, setPartialUser] = useState(null);
  const [partialAssistant, setPartialAssistant] = useState(null);
  const [audioPreferences, setAudioPreferences] = useState(loadAudioPreferences);
  const [speakerDevices, setSpeakerDevices] = useState([]);
  const sessionRef = useRef(null);
  const startingRef = useRef(false);
  const startAttemptRef = useRef(0);
  const statusRef = useRef('inactive');
  const mutedRef = useRef(false);
  const speakerPlayingRef = useRef(false);
  const callbacksRef = useRef({ onMessage, onError, onConversationChanged });
  const micStreamRef = useRef(null);
  const micContextRef = useRef(null);
  const micSourceRef = useRef(null);
  const processorRef = useRef(null);
  const silentGainRef = useRef(null);
  const playbackContextRef = useRef(null);
  const playbackTimeRef = useRef(0);
  const playbackSourcesRef = useRef(new Set());
  const assistantMessageByTurnRef = useRef(new Map());

  useEffect(() => {
    callbacksRef.current = { onMessage, onError, onConversationChanged };
  }, [onConversationChanged, onError, onMessage]);

  useEffect(() => {
    window.localStorage.setItem(LIVE_AUDIO_PREFERENCES_KEY, JSON.stringify(audioPreferences));
  }, [audioPreferences]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch('/api/mentor/audio/devices');
        if (!response.ok) return;
        const body = await response.json();
        if (!cancelled) setSpeakerDevices(Array.isArray(body.devices) ? body.devices : []);
      } catch {
        // Device discovery is optional; Live browser audio remains available.
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const updateState = useCallback((patch) => {
    setLiveState((current) => {
      const next = { ...current, ...patch };
      statusRef.current = next.status;
      mutedRef.current = next.muted;
      return next;
    });
  }, []);

  const clearPlayback = useCallback((closeContext = false) => {
    for (const source of playbackSourcesRef.current) {
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    playbackSourcesRef.current.clear();
    playbackTimeRef.current = 0;
    if (closeContext && playbackContextRef.current) {
      playbackContextRef.current.close().catch(() => {});
      playbackContextRef.current = null;
    }
  }, []);

  const stopMicrophone = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      try { processorRef.current.disconnect(); } catch {}
      processorRef.current = null;
    }
    if (micSourceRef.current) {
      try { micSourceRef.current.disconnect(); } catch {}
      micSourceRef.current = null;
    }
    if (silentGainRef.current) {
      try { silentGainRef.current.disconnect(); } catch {}
      silentGainRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }
    if (micContextRef.current) {
      micContextRef.current.close().catch(() => {});
      micContextRef.current = null;
    }
  }, []);

  const cleanupLocal = useCallback((status = 'inactive') => {
    stopMicrophone();
    clearPlayback(true);
    sessionRef.current = null;
    startingRef.current = false;
    mutedRef.current = false;
    speakerPlayingRef.current = false;
    statusRef.current = status;
    setPartialUser(null);
    setPartialAssistant(null);
    assistantMessageByTurnRef.current.clear();
    setLiveState({ ...initialState(), status });
  }, [clearPlayback, stopMicrophone]);

  const startMicrophone = useCallback(async (stream, sessionId) => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContextClass();
    if (context.state === 'suspended') await context.resume();
    micStreamRef.current = stream;
    micContextRef.current = context;
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    micSourceRef.current = source;
    processorRef.current = processor;
    silentGainRef.current = silentGain;
    processor.onaudioprocess = (event) => {
      if (!sessionRef.current || sessionRef.current !== sessionId || mutedRef.current
          || speakerPlayingRef.current || !socket?.connected) return;
      const data = floatAudioToPcmBase64(event.inputBuffer.getChannelData(0), context.sampleRate);
      socket.emit('mentor-live-audio-input', { conversationId, sessionId, data });
    };
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
  }, [conversationId, socket]);

  const playAudio = useCallback(async (payload) => {
    if (!payload?.data || payload.sessionId !== sessionRef.current) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!playbackContextRef.current) playbackContextRef.current = new AudioContextClass();
    const context = playbackContextRef.current;
    if (context.state === 'suspended') await context.resume();
    const buffer = pcm16ToAudioBuffer(
      context,
      payload.data,
      payload.sampleRate || extractSampleRate(payload.mimeType)
    );
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime, playbackTimeRef.current);
    source.start(startAt);
    playbackTimeRef.current = startAt + buffer.duration;
    playbackSourcesRef.current.add(source);
    source.onended = () => {
      playbackSourcesRef.current.delete(source);
      try { source.disconnect(); } catch {}
    };
  }, []);

  const stop = useCallback((notifyServer = true) => {
    startAttemptRef.current += 1;
    const sessionId = sessionRef.current;
    if (notifyServer && socket && sessionId) {
      socket.emit('mentor-live-stop', { conversationId, sessionId });
    }
    cleanupLocal('inactive');
  }, [cleanupLocal, conversationId, socket]);

  const start = useCallback(async () => {
    if (!socket?.connected || !conversationId || ACTIVE_STATUSES.has(statusRef.current)) return false;
    const attempt = startAttemptRef.current + 1;
    startAttemptRef.current = attempt;
    startingRef.current = true;
    updateState({ status: 'connecting', muted: false, turnActive: false });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
      const result = await new Promise((resolve) => {
        socket.emit('mentor-live-start', {
          conversationId,
          outputMode: audioPreferences.outputMode,
          deviceId: audioPreferences.deviceId,
          boardVolume: audioPreferences.boardVolume
        }, resolve);
      });
      if (!result?.success) throw new Error(result?.error || 'Unable to start Live mentor.');
      if (startAttemptRef.current !== attempt) {
        socket.emit('mentor-live-stop', { conversationId, sessionId: result.sessionId });
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      sessionRef.current = result.sessionId;
      startingRef.current = false;
      await startMicrophone(stream, result.sessionId);
      updateState({
        sessionId: result.sessionId,
        status: 'listening',
        muted: false,
        resolvedOutput: result.resolvedOutput || 'browser',
        speakerStatus: result.speakerStatus || 'inactive',
        micGated: false
      });
      return true;
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      startingRef.current = false;
      cleanupLocal('failed');
      callbacksRef.current.onError?.(error.message);
      return false;
    }
  }, [audioPreferences, cleanupLocal, conversationId, socket, startMicrophone, updateState]);

  const setOutputMode = useCallback((outputMode) => {
    if (!['auto', 'board', 'browser'].includes(outputMode) || ACTIVE_STATUSES.has(statusRef.current)) return;
    setAudioPreferences((current) => ({ ...current, outputMode }));
  }, []);

  const setDeviceId = useCallback((deviceId) => {
    if (!deviceId || ACTIVE_STATUSES.has(statusRef.current)) return;
    setAudioPreferences((current) => ({ ...current, deviceId }));
  }, []);

  const setBoardVolume = useCallback((boardVolume) => {
    if (ACTIVE_STATUSES.has(statusRef.current)) return;
    const numeric = Number(boardVolume);
    if (!Number.isFinite(numeric)) return;
    const normalized = Math.max(0, Math.min(100, Math.round(numeric)));
    setAudioPreferences((current) => ({ ...current, boardVolume: normalized }));
  }, []);

  const interruptOutput = useCallback(() => new Promise((resolve) => {
    const sessionId = sessionRef.current;
    clearPlayback(false);
    speakerPlayingRef.current = false;
    updateState({ micGated: false, speakerStatus: 'cleared' });
    if (!socket || !sessionId) {
      resolve(false);
      return;
    }
    socket.emit('mentor-live-interrupt-output', { conversationId, sessionId }, (result) => {
      if (!result?.success) callbacksRef.current.onError?.(result?.error || 'Unable to interrupt speaker output.');
      resolve(Boolean(result?.success));
    });
  }), [clearPlayback, conversationId, socket, updateState]);

  const toggleMute = useCallback(() => {
    const sessionId = sessionRef.current;
    if (!socket || !sessionId) return;
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted;
    micStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !nextMuted; });
    if (nextMuted) {
      socket.emit('mentor-live-audio-end', { conversationId, sessionId });
    }
    updateState({ muted: nextMuted, status: nextMuted ? 'muted' : 'listening' });
  }, [conversationId, socket, updateState]);

  const sendText = useCallback((requestId, text) => new Promise((resolve, reject) => {
    const sessionId = sessionRef.current;
    if (!socket || !sessionId) {
      reject(new Error('Live mentor is not active.'));
      return;
    }
    if (statusRef.current === 'tool_running') {
      reject(new Error('Wait for the current Live mentor tool to finish, or stop the Live session.'));
      return;
    }
    socket.emit('mentor-live-text-input', {
      conversationId,
      sessionId,
      requestId,
      text
    }, (result) => {
      if (!result?.success) {
        reject(new Error(result?.error || 'Unable to send the Live mentor message.'));
        return;
      }
      updateState({ turnActive: true, status: 'thinking' });
      resolve(result);
    });
  }), [conversationId, socket, updateState]);

  useEffect(() => {
    if (!socket || !conversationId) return undefined;
    const matches = (payload) => {
      if (payload?.conversationId !== conversationId) return false;
      if (!payload.sessionId) return true;
      if (sessionRef.current) return payload.sessionId === sessionRef.current;
      return startingRef.current;
    };
    const onStatus = (payload) => {
      if (!matches(payload)) return;
      if (!sessionRef.current && payload.sessionId) sessionRef.current = payload.sessionId;
      const status = mutedRef.current && payload.status === 'listening' ? 'muted' : payload.status;
      const toolBusy = payload.status === 'tool_running';
      updateState({
        sessionId: payload.sessionId,
        status,
        toolBusy,
        toolName: toolBusy ? payload.toolName || null : null,
        toolLabel: toolBusy ? payload.toolLabel || 'Using mentor tool' : null,
        toolCallIds: toolBusy && Array.isArray(payload.toolCallIds) ? payload.toolCallIds : [],
        ...(payload.resolvedOutput ? { resolvedOutput: payload.resolvedOutput } : {})
      });
    };
    const onUserTranscript = (payload) => {
      if (!matches(payload)) {
        if (payload?.conversationId === conversationId && payload.isFinal && payload.message) {
          callbacksRef.current.onMessage?.(payload.message);
          callbacksRef.current.onConversationChanged?.();
        }
        return;
      }
      if (payload.isFinal) {
        setPartialUser(null);
        if (payload.message) callbacksRef.current.onMessage?.(payload.message);
        callbacksRef.current.onConversationChanged?.();
      } else if (payload.message) {
        setPartialUser(null);
        callbacksRef.current.onMessage?.(payload.message);
      } else {
        setPartialUser({ id: payload.turnId, text: payload.text });
        updateState({ turnActive: true });
      }
    };
    const onAssistantTranscript = (payload) => {
      if (!matches(payload)) {
        if (payload?.conversationId === conversationId && payload.isFinal && payload.message) {
          callbacksRef.current.onMessage?.(payload.message);
          callbacksRef.current.onConversationChanged?.();
        }
        return;
      }
      if (payload.isFinal) {
        assistantMessageByTurnRef.current.delete(payload.turnId);
        setPartialAssistant(null);
        if (payload.message) callbacksRef.current.onMessage?.(payload.message);
        updateState({ turnActive: false, status: mutedRef.current ? 'muted' : 'listening' });
        callbacksRef.current.onConversationChanged?.();
      } else {
        if (payload.message) {
          assistantMessageByTurnRef.current.set(payload.turnId, payload.message.id);
          callbacksRef.current.onMessage?.(payload.message);
          setPartialAssistant(null);
        } else {
          const messageId = assistantMessageByTurnRef.current.get(payload.turnId);
          if (messageId) {
            callbacksRef.current.onMessage?.({
              id: messageId,
              role: 'model',
              kind: 'voice',
              content: payload.text,
              status: 'streaming'
            });
            setPartialAssistant(null);
          } else {
            setPartialAssistant({ id: payload.turnId, text: payload.text });
          }
        }
        updateState({
          turnActive: true,
          status: payload.status === 'tool_running'
            ? 'tool_running'
            : payload.text ? 'speaking' : 'thinking'
        });
      }
    };
    const onInterrupted = (payload) => {
      if (!matches(payload)) return;
      clearPlayback(false);
      speakerPlayingRef.current = false;
      updateState({ micGated: false });
      updateState({ status: 'interrupted' });
    };
    const onSpeakerStatus = (payload) => {
      if (!matches(payload)) return;
      const playing = ['buffering', 'playing'].includes(payload.status)
        && payload.resolvedOutput === 'board';
      const stopped = [
        'cleared',
        'ended',
        'fallback',
        'degraded',
        'disconnected',
        'response_too_long'
      ].includes(payload.status);
      if (playing) speakerPlayingRef.current = true;
      else if (stopped) speakerPlayingRef.current = false;
      updateState({
        ...(payload.resolvedOutput ? { resolvedOutput: payload.resolvedOutput } : {}),
        speakerStatus: payload.status,
        micGated: speakerPlayingRef.current
      });
      if (payload.status === 'fallback') {
        callbacksRef.current.onError?.('Board speaker disconnected. Future audio will play in this browser.');
      }
    };
    const onErrorEvent = (payload) => {
      if (payload?.conversationId && payload.conversationId !== conversationId) return;
      callbacksRef.current.onError?.(payload?.error || 'Live mentor failed.');
      if (payload?.sessionId && payload.sessionId === sessionRef.current) cleanupLocal('failed');
    };
    const onClosed = (payload) => {
      if (!matches(payload)) return;
      cleanupLocal(payload?.failed ? 'failed' : 'inactive');
    };
    const onDisconnect = () => cleanupLocal('failed');

    socket.on('mentor-live-status', onStatus);
    socket.on('mentor-live-user-transcript', onUserTranscript);
    socket.on('mentor-live-assistant-transcript', onAssistantTranscript);
    socket.on('mentor-live-audio', playAudio);
    socket.on('mentor-speaker-status', onSpeakerStatus);
    socket.on('mentor-live-interrupted', onInterrupted);
    socket.on('mentor-live-error', onErrorEvent);
    socket.on('mentor-live-closed', onClosed);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('mentor-live-status', onStatus);
      socket.off('mentor-live-user-transcript', onUserTranscript);
      socket.off('mentor-live-assistant-transcript', onAssistantTranscript);
      socket.off('mentor-live-audio', playAudio);
      socket.off('mentor-speaker-status', onSpeakerStatus);
      socket.off('mentor-live-interrupted', onInterrupted);
      socket.off('mentor-live-error', onErrorEvent);
      socket.off('mentor-live-closed', onClosed);
      socket.off('disconnect', onDisconnect);
    };
  }, [clearPlayback, cleanupLocal, conversationId, playAudio, socket, updateState]);

  useEffect(() => () => stop(true), [stop]);

  useEffect(() => {
    const onBeforeUnload = () => {
      const sessionId = sessionRef.current;
      if (sessionId && socket) socket.emit('mentor-live-stop', { conversationId, sessionId });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [conversationId, socket]);

  return {
    ...liveState,
    isActive: ACTIVE_STATUSES.has(liveState.status),
    partialUser,
    partialAssistant,
    ...audioPreferences,
    speakerDevices,
    start,
    stop,
    toggleMute,
    sendText,
    interruptOutput,
    setOutputMode,
    setDeviceId,
    setBoardVolume
  };
}
