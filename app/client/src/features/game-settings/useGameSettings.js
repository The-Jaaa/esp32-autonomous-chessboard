import { useCallback, useEffect, useState } from 'react';
import { useSocket } from '../../context/useSocket';

const INITIAL_SETTINGS = {
  defaults: { humanColor: 'white', difficultyLevel: 1 },
  activePhysical: null
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Settings request failed (${response.status}).`);
  return body;
}

export function useGameSettings() {
  const socket = useSocket();
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const applySettings = useCallback((payload = {}) => {
    if (!payload.defaults) return;
    setSettings({
      defaults: payload.defaults,
      activePhysical: payload.activePhysical || null
    });
    setError('');
  }, []);

  const reload = useCallback(async () => {
    try {
      applySettings(await request('/api/game-settings'));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!socket) return undefined;
    socket.on('game-settings-updated', applySettings);
    socket.on('connect', reload);
    return () => {
      socket.off('game-settings-updated', applySettings);
      socket.off('connect', reload);
    };
  }, [socket, applySettings, reload]);

  const updateDefaults = useCallback(async (patch) => {
    try {
      const result = await request('/api/game-settings', {
        method: 'PATCH',
        body: JSON.stringify(patch)
      });
      applySettings(result);
      return result;
    } catch (requestError) {
      setError(requestError.message);
      throw requestError;
    }
  }, [applySettings]);

  const updateDifficulty = useCallback(async (difficultyLevel, physicalSessionGeneration = null) => {
    const defaultsResult = await updateDefaults({ difficultyLevel });
    if (!Number.isInteger(physicalSessionGeneration)) return defaultsResult;
    try {
      const result = await request('/api/physical/settings', {
        method: 'PATCH',
        body: JSON.stringify({ difficultyLevel, expectedSessionGeneration: physicalSessionGeneration })
      });
      applySettings(result);
      return result;
    } catch (requestError) {
      setError(requestError.message);
      throw requestError;
    }
  }, [applySettings, updateDefaults]);

  return { ...settings, loading, error, reload, updateDefaults, updateDifficulty };
}
