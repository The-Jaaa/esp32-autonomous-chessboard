import { useEffect, useRef, useState } from 'react';
import { useSocket } from '../context/useSocket';

export function ExhibitionPanel({ physicalActive, onOwnershipChange }) {
  const socket = useSocket();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [brightness, setBrightness] = useState(100);
  const timer = useRef(null);
  const serverBrightness = useRef(null);
  useEffect(() => {
    let disposed = false;
    const update = data => {
      if (disposed) return;
      setStatus(data);
      if (serverBrightness.current !== data.desired.brightnessPercent) {
        serverBrightness.current = data.desired.brightnessPercent;
        setBrightness(data.desired.brightnessPercent);
      }
      onOwnershipChange(data.desired.enabled || data.reported?.exhibitionEnabled === true);
    };
    const refresh = async () => {
      try {
        const response = await fetch('/api/exhibition/status');
        if (!response.ok) throw new Error('Cannot read exhibition status.');
        update(await response.json());
      } catch (err) { if (!disposed) setError(err.message); }
    };
    refresh();
    const poll = setInterval(refresh, 2000);
    socket?.on('exhibition-status', update);
    return () => { disposed = true; clearInterval(poll); clearTimeout(timer.current); socket?.off('exhibition-status', update); };
  }, [socket, onOwnershipChange]);
  async function change(settings) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/exhibition/light-show', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: status.desired.enabled, ...settings })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Light show request failed.');
      setStatus(data);
      onOwnershipChange(data.desired.enabled || data.reported?.exhibitionEnabled === true);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const desired = status?.desired;
  return <section className="controls-section exhibition-panel" aria-label="Exhibition">
    <h2>Exhibition</h2>
    <p role="status">Light show: <strong>{status?.state || 'Loading'}</strong></p>
    {status?.recoveryActive && <p>Placement warnings are showing instead of the light show. Start/Stop changes the light-show setting; warnings stay visible until recovery is resolved. Follow the correction instructions in Autonomous Game, or use Home for Manual Reset to end the demonstration.</p>}
    {status && !status.connected && <p>The board is disconnected. A running show continues locally.</p>}
    {status?.connected && !status.supported && <p>Update board firmware to enable the light show.</p>}
    {physicalActive && <p>End the physical game before starting the light show.</p>}
    <label>Pattern<select aria-label="Light-show pattern" disabled={!desired || busy}
      value={desired?.pattern || 'auto'} onChange={e => change({ pattern: e.target.value })}>
      <option value="auto">Auto — change every 30 seconds</option>
      <option value="wave">Colour wave</option><option value="chessboard">Chessboard pulse</option>
      <option value="music" disabled={!status?.spectrumSupported}>Spectrum</option>
      <option value="sweep">Sweep</option><option value="breathing">Breathing glow</option>
    </select></label>
    {desired?.pattern === 'music' && <p>Play music through the board's Spotify relay. Eight frequency bars rise from rank 1 to rank 8, from bass on A to treble on H. Mixed mentor speech also appears. Speed follows the audio.</p>}
    {status?.connected && status.supported && !status.spectrumSupported && <p>Update board firmware to enable Spectrum.</p>}
    <label>Speed<select aria-label="Light-show speed" disabled={!desired || busy || desired.pattern === 'music'}
      value={desired?.speed || 'normal'} onChange={e => change({ speed: e.target.value })}>
      <option value="slow">Slow</option><option value="normal">Normal</option><option value="fast">Fast</option>
    </select></label>
    <label>Brightness: {brightness}%<input aria-label="Light-show brightness" type="range" min="10" max="100"
      disabled={!desired || busy} value={brightness} onChange={e => {
        const value = Number(e.target.value);
        setBrightness(value);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => change({ brightnessPercent: value }), 200);
      }} /></label>
    <button className="btn btn-primary" disabled={!desired || busy || (!desired.enabled
      && (physicalActive || !status.connected || !status.supported || (desired.pattern === 'music' && !status.spectrumSupported)))}
      onClick={() => { clearTimeout(timer.current); change({ enabled: !desired.enabled, brightnessPercent: brightness }); }}>
      {desired?.enabled ? 'Stop Light Show' : 'Start Light Show'}
    </button>
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function PhysicalEndButton({ state, onState }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!state.active) return null;
  async function end() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/physical/end', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          expectedSessionGeneration: state.sessionGeneration, expectedRevision: state.stateRevision
        }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Cannot end this game.');
      onState(data.state);
      setConfirming(false);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <div className="physical-end-control">
    {!confirming ? <button className="btn btn-secondary" disabled={busy || !['ready', 'game_over'].includes(state.phase)}
      onClick={() => setConfirming(true)}>End Physical Game</button>
      : <div role="group" aria-label="End physical game confirmation">
        <p>End this game? Pieces stay where they are; they will not return to their starting positions.</p>
        <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={end}>Confirm End Game</button>
      </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
