import { useEffect, useState } from 'react';
import { useSocket } from '../context/useSocket';

export function AutonomousPanel({ onState }) {
  const socket = useSocket();
  const [state, setState] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [placed, setPlaced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    const update = value => { if (!disposed) { setState(value); onState(value); } };
    const refresh = async () => {
      try {
        const response = await fetch('/api/exhibition/autonomous/status');
        if (!response.ok) throw new Error('Cannot read autonomous status. Restart the updated backend.');
        update((await response.json()).autonomous);
      } catch (err) { if (!disposed) setError(err.message); }
    };
    refresh();
    const poll = setInterval(refresh, 2000);
    socket?.on('autonomous-status', update);
    return () => { disposed = true; clearInterval(poll); socket?.off('autonomous-status', update); };
  }, [socket, onState]);
  async function request(action) {
    setBusy(true); setError('');
    try {
      const start = action === 'start';
      const response = await fetch(`/api/exhibition/autonomous/${start ? 'start' : 'control'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(start ? { confirmedStartingPieces: confirmed, confirmedEmptyGraveyard: confirmed }
          : { action, runId: state.runId, expectedRevision: state.revision, confirmedPiecesPlaced: placed, recoveryId: state.recovery?.id })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Autonomous request failed.');
      setState(data.autonomous); onState(data.autonomous);
      if (start) setConfirmed(false);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const available = !state || ['available', 'manual_ready'].includes(state.state);
  const controllable = ['playing', 'restoring', 'paused', 'recovery'].includes(state?.state);
  return <section id="autonomous-game" className="controls-section autonomous-panel" aria-label="Autonomous exhibition">
    <h2>Autonomous Game</h2>
    <p>Tal–Shamkovich, 1965 · Castling, captures and physical promotion.</p>
    <p>Music and Spectrum continue. The robot restores all pieces and repeats.</p>
    <p role="status"><strong>{state?.state || 'Loading'}</strong> · Cycle {state?.cycle || 0}</p>
    {available ? <>
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> Correct pieces are on their starting squares and all graveyard slots are empty.</label>
      <button className="btn btn-primary" disabled={!state || !confirmed || busy} onClick={() => request('start')}>Start Autonomous Game</button>
    </> : <>
      <button className="btn btn-secondary" disabled={busy || !controllable} onClick={() => request(state.state === 'paused' ? 'resume' : 'pause')}>
        {state.state === 'paused' ? 'Resume Autonomous Game' : 'Pause Autonomous Game'}</button>
      <button className="btn btn-secondary" disabled={busy || !controllable} onClick={() => request('restore-and-exit')}>Restore &amp; Exit</button>
      <button className="btn btn-secondary" disabled={busy || !controllable} onClick={() => request('manual-takeover')}>Manual Takeover</button>
    </>}
    <p>{state?.message}</p>
    {state?.state === 'manual_ready' && state.resetGuidance && <p>Use the setup lights to restore the correct starting pieces and empty the graveyard. Start Physical Game is now available for normal play.</p>}
    {(state?.state === 'recovery' || state?.waitingForSync) && <p>Movement is held. Highlighted squares show the placement mismatch; music can keep playing.</p>}
    {state?.recovery && <div className="autonomous-recovery" role="status">
      <p>{!state.recovery.recoverable ? 'Automatic continuation is blocked. Follow the recovery instructions or use Home for Manual Reset.' : state.recovery.correctionReady ? 'Robot stopped; correction is available.' : 'Wait for the robot to stop before correcting pieces.'}</p>
      <p>Affected squares: {[...(state.recovery.missingSquares || []), ...(state.recovery.extraSquares || [])].join(', ') || 'none currently detected'}</p>
      {state.recovery.requiresConfirmation && <>
        <p>Storage slots are not sensed. Put the named piece in {state.recovery.to}, then confirm its placement.</p>
        <button className="btn btn-primary" disabled={busy || state.recovery.stage !== 'confirmation' || !state.recovery.correctionReady}
          onClick={() => request('confirm-recovery-placement')}>Confirm piece in {state.recovery.to}</button>
      </>}
    </div>}
    {state?.totalSteps > 0 && <p>{state.direction === 'restore' ? 'Restore' : 'Play'}: {state.step} / {state.totalSteps} transfers</p>}
    {state?.current && <p>{state.current.san}: {state.current.from} → {state.current.to}</p>}
    <p>During automatic restoration, lift an unrelated piece to request takeover. Hold it and wait for <strong>Manual reset ready</strong> before moving more pieces. Keep clear during motion.</p>
    {state?.state === 'recovery' && <>
      <p>To arrange the pieces with setup lights, first home the gantry. Leave the pieces where they are and wait for Manual reset ready before rearranging them.</p>
      <label><input type="checkbox" checked={placed} onChange={e => setPlaced(e.target.checked)} /> Every piece is resting on the board or in storage, and the gantry area is clear.</label>
      <button className="btn btn-secondary" disabled={busy || !placed} onClick={() => request('prepare-manual-reset')}>Home for Manual Reset</button>
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I have manually restored the correct starting pieces and cleared the graveyard.</label>
      <button className="btn btn-secondary" disabled={busy || !confirmed} onClick={() => request('confirm-manual-reset')}>Confirm Manual Reset</button>
    </>}
    <a href="/api/exhibition/autonomous/script" target="_blank" rel="noreferrer">View game PGN</a>
    {error && <p role="alert">{error}</p>}
  </section>;
}
