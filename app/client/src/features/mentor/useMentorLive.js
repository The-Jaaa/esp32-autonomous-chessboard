import { useCallback, useEffect, useRef, useState } from 'react';
import {
  extractSampleRate,
  floatAudioToPcmBase64,
  pcm16ToAudioBuffer
} from './mentor-live-audio';

const ACTIVE_STATUSES = new Set(['connecting', 'listening', 'muted', 'thinking', 'speaking', 'interrupted']);

function initialState() {
  return {
    sessionId: null,
    status: 'inactive',
    muted: false,
    turnActive: false
  };
}

export function useMentorLive({ socket, conversationId, onMessage, onError, onConversationChanged }) {
  const [liveState, setLiveState] = useState(initialState);
  const [partialUser, setPartialUser] = useState(null);
  const [partialAssistant, setPartialAssistant] = useState(null);
  const sessionRef = useRef(null);
  const startingRef = useRef(false);
  const startAttemptRef = useRef(0);
  const statusRef = useRef('inactive');
  const mutedRef = useRef(false);
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
      if (!sessionRef.current || sessionRef.current !== sessionId || mutedRef.current || !socket?.connected) return;
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
        socket.emit('mentor-live-start', { conversationId }, resolve);
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
      updateState({ sessionId: result.sessionId, status: 'listening', muted: false });
      return true;
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      startingRef.current = false;
      cleanupLocal('failed');
      callbacksRef.current.onError?.(error.message);
      return false;
    }
  }, [cleanupLocal, conversationId, socket, startMicrophone, updateState]);

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
      updateState({ sessionId: payload.sessionId, status });
    };
    const onUserTranscript = (payload) => {
      if (!matches(payload)) return;
      if (payload.isFinal) {
        setPartialUser(null);
        if (payload.message) callbacksRef.current.onMessage?.(payload.message);
        callbacksRef.current.onConversationChanged?.();
      } else {
        setPartialUser({ id: payload.turnId, text: payload.text });
        updateState({ turnActive: true });
      }
    };
    const onAssistantTranscript = (payload) => {
      if (!matches(payload)) return;
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
        updateState({ turnActive: true, status: payload.text ? 'speaking' : 'thinking' });
      }
    };
    const onInterrupted = (payload) => {
      if (!matches(payload)) return;
      clearPlayback(false);
      updateState({ status: 'interrupted' });
    };
    const onErrorEvent = (payload) => {
      if (payload?.conversationId && payload.conversationId !== conversationId) return;
      callbacksRef.current.onError?.(payload?.error || 'Live mentor failed.');
      if (payload?.sessionId && payload.sessionId === sessionRef.current) cleanupLocal('failed');
    };
    const onClosed = (payload) => {
      if (!matches(payload)) return;
      cleanupLocal('inactive');
    };
    const onDisconnect = () => cleanupLocal('failed');

    socket.on('mentor-live-status', onStatus);
    socket.on('mentor-live-user-transcript', onUserTranscript);
    socket.on('mentor-live-assistant-transcript', onAssistantTranscript);
    socket.on('mentor-live-audio', playAudio);
    socket.on('mentor-live-interrupted', onInterrupted);
    socket.on('mentor-live-error', onErrorEvent);
    socket.on('mentor-live-closed', onClosed);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('mentor-live-status', onStatus);
      socket.off('mentor-live-user-transcript', onUserTranscript);
      socket.off('mentor-live-assistant-transcript', onAssistantTranscript);
      socket.off('mentor-live-audio', playAudio);
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
    start,
    stop,
    toggleMute,
    sendText
  };
}
