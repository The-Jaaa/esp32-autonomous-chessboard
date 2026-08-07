import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  BookOpen,
  Check,
  ChevronLeft,
  Ellipsis,
  Gauge,
  GraduationCap,
  Lightbulb,
  Mic,
  MicOff,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Pause,
  Puzzle,
  RefreshCcw,
  Radio,
  Repeat2,
  Search,
  Settings2,
  Square,
  Swords,
  Trash2,
  Volume2,
  X
} from 'lucide-react';
import { useSocket } from '../../context/useSocket';
import { mentorApi } from './mentor-api';
import { useMentorLive } from './useMentorLive';
import { GameSettingsControls } from '../game-settings/GameSettingsControls';
import { useGameSettings } from '../game-settings/useGameSettings';
import './mentor.css';

const SUGGESTIONS = [
  { title: 'Analyze a game', prompt: 'Help me analyze a recent game and identify the decisions I should learn from.' },
  { title: 'Learn an opening', prompt: 'Teach me an opening step by step, including its plans and common mistakes.' },
  { title: 'Solve a puzzle', prompt: 'Give me a tactical puzzle appropriate for an improving club player.' },
  { title: 'Practice a position', prompt: 'Set up a useful practice position and coach me through the ideas.' }
];
const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ANNOTATION_COLORS = {
  idea: '#4f8fe8',
  good: '#65b96e',
  warning: '#e1ae4b',
  danger: '#df665b',
  special: '#9b72d4'
};

function upsertMessage(messages, nextMessage) {
  if (!nextMessage) return messages;
  const index = messages.findIndex((message) => message.id === nextMessage.id);
  if (index < 0) return [...messages, nextMessage].sort((a, b) => a.sequence - b.sequence);
  const copy = [...messages];
  copy[index] = { ...copy[index], ...nextMessage };
  return copy;
}

function upsertToolCall(messages, toolCall) {
  if (!toolCall) return messages;
  return messages.map((message) => {
    if (message.id !== toolCall.assistantMessageId) return message;
    const existing = message.toolCalls || [];
    const index = existing.findIndex((item) => item.id === toolCall.id);
    const next = index < 0
      ? [...existing, toolCall]
      : existing.map((item, itemIndex) => itemIndex === index ? { ...item, ...toolCall } : item);
    return { ...message, toolCalls: next.sort((a, b) => a.ordinal - b.ordinal) };
  });
}

function groupConversations(conversations) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const key = (date) => new Date(date).toDateString();
  const groups = new Map();

  conversations.forEach((conversation) => {
    const dateKey = key(conversation.updatedAt);
    const label = dateKey === key(today)
      ? 'Today'
      : dateKey === key(yesterday)
        ? 'Yesterday'
        : new Date(conversation.updatedAt).toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric'
        });
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(conversation);
  });
  return [...groups.entries()];
}

function ConversationItem({ conversation, active, onOpen, onRename, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(conversation.title);

  const saveRename = () => {
    const trimmed = title.trim();
    if (trimmed && trimmed !== conversation.title) onRename(conversation.id, trimmed);
    setRenaming(false);
    setMenuOpen(false);
  };

  return (
    <div className={`mentor-history-item ${active ? 'is-active' : ''}`}>
      {renaming ? (
        <form className="mentor-history-rename" onSubmit={(event) => { event.preventDefault(); saveRename(); }}>
          <input
            aria-label="Conversation title"
            value={title}
            maxLength={80}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
          <button type="submit" title="Save title" aria-label="Save title"><Check size={16} /></button>
          <button type="button" title="Cancel rename" aria-label="Cancel rename" onClick={() => setRenaming(false)}><X size={16} /></button>
        </form>
      ) : (
        <>
          <button className="mentor-history-open" onClick={() => onOpen(conversation.id)}>
            <span>{conversation.title}</span>
          </button>
          <button
            className="mentor-icon-button mentor-history-menu-button"
            title="Conversation actions"
            aria-label="Conversation actions"
            onClick={() => setMenuOpen((value) => !value)}
          >
            <Ellipsis size={17} />
          </button>
          {menuOpen && (
            <div className="mentor-history-menu">
              <button onClick={() => { setRenaming(true); setMenuOpen(false); }}><Pencil size={15} /> Rename</button>
              <button className="is-danger" onClick={() => onDelete(conversation.id)}><Trash2 size={15} /> Delete</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function toolLabel(toolCall) {
  const args = toolCall.arguments || {};
  const labels = {
    get_board_state: 'Read board state',
    analyze_position: `Analyze position (${args.mode || 'quick'})`,
    analyze_move: args.uci ? `Analyze ${args.uci}` : 'Analyze latest move',
    play_move: `Move ${args.uci || ''}`.trim(),
    play_line: `Demonstrate ${(args.moves || []).length} moves`,
    load_position: 'Load teaching position',
    reset_board: 'Reset board',
    set_orientation: `Show ${args.orientation || ''} perspective`.trim(),
    annotate_board: 'Annotate board',
    set_game_preferences: 'Update game preferences',
    get_activity_state: 'Read activity state',
    propose_activity: 'Validate activity',
    start_activity: 'Start activity',
    request_prediction: 'Request prediction',
    request_hint: 'Give hint',
    end_activity: 'End activity',
    resolve_opening_drill: 'Update opening drill',
    engine_fallback: `Engine fallback ${args.uci || ''}`.trim(),
    activity_fallback: `Reviewed continuation ${args.uci || ''}`.trim()
  };
  return labels[toolCall.name] || toolCall.name.replaceAll('_', ' ');
}

function activityPhaseLabel(activity) {
  const pauseLabels = {
    line_complete: 'Line complete',
    repeat_restore: 'Restore starting setup',
    route_blocked: 'Route blocked'
  };
  if (pauseLabels[activity?.state?.pauseReason]) return pauseLabels[activity.state.pauseReason];
  const labels = {
    learner_turn: 'Your turn',
    mentor_turn: 'Mentor turn',
    mentor_thinking: 'Mentor thinking',
    awaiting_prediction: 'Prediction requested',
    paused: 'Paused',
    complete: 'Complete',
    game_over: 'Game over'
  };
  return labels[activity?.phase] || 'Ready';
}

function activityTypeLabel(type) {
  return {
    practice_game: 'Practice game',
    opening_drill: 'Opening drill',
    puzzle: 'Puzzle',
    guided_lesson: 'Guided lesson'
  }[type] || 'Activity';
}

function ActivityBar({
  activity,
  busy,
  disabled = false,
  physical = false,
  openingLock = false,
  onStart,
  onPause,
  onResume,
  onHint,
  onEnd,
  onProfile,
  onPhysicalAction
}) {
  if (!activity) {
    return (
      <div className="mentor-activity-bar is-idle">
        <div><GraduationCap size={17} /><span><strong>{openingLock ? 'Opening lesson finished' : 'Guided practice'}</strong><small>{openingLock
          ? 'The physical position is locked until you resume normal play'
          : physical ? 'Practice a reviewed opening on the real board' : 'Start a game, drill, puzzle, or lesson'}</small></span></div>
        <div className="mentor-activity-actions">
          <button onClick={onProfile} title="Learner profile" aria-label="Learner profile"><Settings2 size={15} /></button>
          {openingLock
            ? <button className="is-primary" onClick={() => onPhysicalAction('resume')} disabled={busy}><Play size={14} /> Resume play</button>
            : <button className="is-primary" onClick={onStart} disabled={busy || disabled}><Play size={14} /> Start activity</button>}
        </div>
      </div>
    );
  }
  const progress = activity.totalSteps ? Math.min(100, Math.round((activity.stepIndex / activity.totalSteps) * 100)) : 0;
  const pauseReason = activity.state?.pauseReason || null;
  return (
    <div className={`mentor-activity-bar is-active is-${activity.phase}`} data-activity-phase={activity.phase}>
      <div className="mentor-activity-main">
        <span className="mentor-activity-icon"><GraduationCap size={16} /></span>
        <span>
          <strong>{activity.title}</strong>
          <small>{activityPhaseLabel(activity)} · {activityTypeLabel(activity.type)} · You play {activity.learnerColor}</small>
        </span>
      </div>
      {activity.totalSteps > 0 && <span className="mentor-activity-progress"><i style={{ width: `${progress}%` }} /></span>}
      <div className="mentor-activity-actions">
        {physical && pauseReason === 'line_complete' && <>
          <button onClick={() => onPhysicalAction('repeat')} disabled={busy} title="Repeat opening">Repeat</button>
          <button onClick={() => onPhysicalAction('continue')} disabled={busy} title="Continue as a normal game">Continue</button>
          <button onClick={() => onPhysicalAction('finish')} disabled={busy} title="Finish lesson">Finish</button>
        </>}
        {physical && pauseReason === 'route_blocked' && (
          <button className="is-primary" onClick={() => onPhysicalAction('retry')} disabled={busy} title="Retry exact opening move"><RefreshCcw size={14} /> Retry</button>
        )}
        {(!physical || !pauseReason) && ['opening_drill', 'puzzle', 'guided_lesson'].includes(activity.type) && (
          <button onClick={onHint} disabled={busy} title="Request hint" aria-label="Request hint"><Lightbulb size={15} /></button>
        )}
        {!physical && (activity.status === 'paused'
          ? <button onClick={onResume} disabled={busy} title="Resume activity" aria-label="Resume activity"><Play size={15} /></button>
          : <button onClick={onPause} disabled={busy} title="Pause activity" aria-label="Pause activity"><Pause size={15} /></button>)}
        {physical && !pauseReason && (activity.status === 'paused'
          ? <button onClick={onResume} disabled={busy} title="Resume activity" aria-label="Resume activity"><Play size={15} /></button>
          : <button onClick={onPause} disabled={busy} title="Pause activity" aria-label="Pause activity"><Pause size={15} /></button>)}
        {(!physical || pauseReason !== 'line_complete') && (
          <button onClick={onEnd} disabled={busy} title="End activity" aria-label="End activity"><X size={15} /></button>
        )}
      </div>
    </div>
  );
}

function ActivityDialog({ catalog, boardRevision, physical = false, onClose, onStart }) {
  const [type, setType] = useState(physical ? 'opening_drill' : 'practice_game');
  const [sourceId, setSourceId] = useState('');
  const [learnerColor, setLearnerColor] = useState('white');
  const [startFrom, setStartFrom] = useState('standard');
  const items = useMemo(() => catalog.filter((item) => item.type === type
    && (!physical || item.supportsPhysical)), [catalog, physical, type]);
  const openingFamilies = useMemo(() => items.reduce((groups, item) => {
    const family = item.family || 'Other openings';
    if (!groups[family]) groups[family] = [];
    groups[family].push(item);
    return groups;
  }, {}), [items]);
  useEffect(() => {
    setSourceId(items[0]?.id || '');
    if (items[0]?.fixedLearnerColor) setLearnerColor(items[0].fixedLearnerColor);
  }, [type, items]);
  const selected = items.find((item) => item.id === sourceId);
  const submit = (event) => {
    event.preventDefault();
    onStart({
      type,
      sourceId: type === 'practice_game' ? undefined : sourceId,
      learnerColor: selected?.fixedLearnerColor || learnerColor,
      startFrom: type === 'practice_game' ? startFrom : undefined,
      expectedRevision: boardRevision
    });
  };
  return (
    <div className="mentor-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="mentor-dialog mentor-activity-dialog" onSubmit={submit}>
        <header><div><span>ACTIVITY</span><h2>{physical ? 'Practice an opening' : 'Start guided practice'}</h2></div><button type="button" onClick={onClose} title="Close"><X size={18} /></button></header>
        <div className="mentor-dialog-body">
          {!physical && <div className="mentor-mode-grid">
            {[
              ['practice_game', Swords, 'Practice game'],
              ['opening_drill', BookOpen, 'Opening drill'],
              ['puzzle', Puzzle, 'Puzzle'],
              ['guided_lesson', GraduationCap, 'Guided lesson']
            ].map(([value, Icon, label]) => (
              <button type="button" className={type === value ? 'is-selected' : ''} key={value} onClick={() => setType(value)}>
                <Icon size={17} /><span>{label}</span>
              </button>
            ))}
          </div>}
          {physical && <p className="mentor-activity-description"><strong>Physical opening drill</strong><span>You play White from the full standard setup. Black follows the reviewed line exactly.</span></p>}
          {type !== 'practice_game' && (
            <label>Activity
              <select value={sourceId} onChange={(event) => {
                const next = items.find((item) => item.id === event.target.value);
                setSourceId(event.target.value);
                if (next?.fixedLearnerColor) setLearnerColor(next.fixedLearnerColor);
              }}>
                {physical
                  ? Object.entries(openingFamilies).map(([family, familyItems]) => (
                      <optgroup key={family} label={family}>
                        {familyItems.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                      </optgroup>
                    ))
                  : items.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
          )}
          {selected && <p className="mentor-activity-description"><strong>{selected.goal}</strong><span>{selected.moveCount} guided plies</span></p>}
          {type === 'practice_game' && (
            <label>Starting position
              <select value={startFrom} onChange={(event) => setStartFrom(event.target.value)}>
                <option value="standard">Standard position</option>
                <option value="current">Current board</option>
              </select>
            </label>
          )}
          {!physical && !selected?.fixedLearnerColor && (
            <fieldset><legend>Your color</legend><div className="mentor-segmented">
              <button type="button" className={learnerColor === 'white' ? 'is-selected' : ''} onClick={() => setLearnerColor('white')}>White</button>
              <button type="button" className={learnerColor === 'black' ? 'is-selected' : ''} onClick={() => setLearnerColor('black')}>Black</button>
            </div></fieldset>
          )}
        </div>
        <div className="mentor-dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={type !== 'practice_game' && !sourceId}>Start</button></div>
      </form>
    </div>
  );
}

function ProfileDialog({ progress, onClose, onSave }) {
  const [skillBand, setSkillBand] = useState(progress?.profile?.skillBand || 'Beginner');
  const [goals, setGoals] = useState((progress?.profile?.goals || []).join('\n'));
  const submit = (event) => {
    event.preventDefault();
    onSave(skillBand, goals.split('\n').map((goal) => goal.trim()).filter(Boolean));
  };
  return (
    <div className="mentor-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="mentor-dialog mentor-profile-dialog" onSubmit={submit}>
        <header><div><span>LEARNER</span><h2>Profile and progress</h2></div><button type="button" onClick={onClose} title="Close"><X size={18} /></button></header>
        <div className="mentor-dialog-body">
          <fieldset><legend>Current level</legend><div className="mentor-segmented">
            {['Beginner', 'Intermediate', 'Advanced'].map((band) => <button type="button" key={band} className={skillBand === band ? 'is-selected' : ''} onClick={() => setSkillBand(band)}>{band}</button>)}
          </div></fieldset>
          <label>Goals<textarea value={goals} onChange={(event) => setGoals(event.target.value)} rows={3} placeholder="One goal per line" /></label>
          <div className="mentor-mastery-list">
            {(progress?.topics || []).map((topic) => <div key={topic.topic}><span>{topic.topic.replaceAll('_', ' ')}</span><i><b style={{ width: `${topic.mastery}%` }} /></i><strong>{topic.mastery}</strong></div>)}
            {!progress?.topics?.length && <p>Complete an activity to begin tracking topic mastery.</p>}
          </div>
        </div>
        <div className="mentor-dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit">Save profile</button></div>
      </form>
    </div>
  );
}

function PromotionDialog({ color, target, onChoose, onClose }) {
  const pieces = [['q', 'Queen'], ['r', 'Rook'], ['b', 'Bishop'], ['n', 'Knight']];
  return (
    <div className="mentor-modal-backdrop" role="presentation">
      <div className="mentor-dialog mentor-promotion-dialog" role="dialog" aria-modal="true" aria-label="Choose promotion piece">
        <header><div><span>PROMOTION</span><h2>Promote on {target}</h2></div><button type="button" onClick={onClose} title="Cancel promotion"><X size={18} /></button></header>
        <div className="mentor-promotion-options">
          {pieces.map(([piece, label]) => <button key={piece} onClick={() => onChoose(piece)}><span>{color === 'w' ? piece.toUpperCase() : piece}</span><strong>{label}</strong></button>)}
        </div>
      </div>
    </div>
  );
}

function formatEngineScore(score) {
  if (!score) return '--';
  if (score.type === 'mate') return `${score.value < 0 ? '-' : ''}M${Math.abs(score.value)}`;
  const pawns = score.value / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

function formatClassification(value) {
  if (!value) return '';
  return value.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase());
}

function liveStatusText(live) {
  if (live.status === 'failed') return 'Live voice failed';
  if (live.micGated) return 'Speaking through board';
  if (live.status === 'tool_running') return live.toolLabel || 'Using mentor tool';
  const labels = {
    connecting: 'Live voice connecting',
    listening: 'Live voice listening',
    muted: 'Live voice muted',
    thinking: 'Live voice thinking',
    speaking: 'Live voice speaking',
    interrupted: 'Live voice interrupted',
    switching_source: 'Switching to physical board',
    reconnecting: 'Reconnecting Live voice'
  };
  return labels[live.status] || 'Live voice';
}

function LiveAudioControls({ live }) {
  const selectedDevice = live.speakerDevices.find((device) => device.id === live.deviceId);
  const boardStatus = live.speakerStatus === 'fallback'
    ? 'Browser fallback'
    : live.speakerStatus === 'playing'
      ? 'Board playing'
      : selectedDevice
        ? `Board ${selectedDevice.status}`
        : 'Board unavailable';
  const controlsDisabled = live.isActive || live.status === 'connecting';

  return (
    <div className="mentor-audio-output" aria-label="Live mentor audio output">
      <span className="mentor-audio-output-label"><Volume2 size={15} /> Voice output</span>
      <div className="mentor-audio-segments" role="group" aria-label="Voice output mode">
        {['auto', 'board', 'browser'].map((mode) => (
          <button
            key={mode}
            type="button"
            className={live.outputMode === mode ? 'is-selected' : ''}
            onClick={() => live.setOutputMode(mode)}
            disabled={controlsDisabled}
          >{mode[0].toUpperCase() + mode.slice(1)}</button>
        ))}
      </div>
      {live.outputMode !== 'browser' && (
        <>
          <select
            value={live.deviceId}
            onChange={(event) => live.setDeviceId(event.target.value)}
            disabled={controlsDisabled || live.speakerDevices.length <= 1}
            aria-label="Board speaker"
          >
            {!selectedDevice && <option value={live.deviceId}>{live.deviceId}</option>}
            {live.speakerDevices.map((device) => (
              <option key={device.id} value={device.id}>{device.id}</option>
            ))}
          </select>
          <label className="mentor-board-volume" title="Board speaker volume">
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={live.boardVolume}
              onChange={(event) => live.setBoardVolume(event.target.value)}
              disabled={controlsDisabled}
              aria-label="Board speaker volume"
            />
            <span>{live.boardVolume}%</span>
          </label>
        </>
      )}
      <span className={`mentor-speaker-state is-${live.speakerStatus}`}>
        {live.outputMode === 'browser' ? 'Browser audio' : boardStatus}
      </span>
      {live.micGated && (
        <button className="mentor-interrupt-output" type="button" onClick={live.interruptOutput}>
          Interrupt response
        </button>
      )}
    </div>
  );
}

function AnalysisResult({ result }) {
  if (!result || !['position_analysis', 'move_analysis'].includes(result.kind)) return null;
  if (result.kind === 'move_analysis') {
    const best = result.bestAlternative;
    return (
      <div className="mentor-analysis-result">
        <div className="mentor-analysis-headline">
          <span className={`mentor-quality is-${result.classification}`}>{formatClassification(result.classification)}</span>
          <strong>{result.move?.san || result.move?.uci}</strong>
          <span>{formatEngineScore(result.before?.score)} to {formatEngineScore(result.after?.score)}</span>
        </div>
        <div className="mentor-analysis-meta">
          {result.centipawnLoss !== null && result.centipawnLoss !== undefined && <span>{result.centipawnLoss} cp loss</span>}
          {result.mateImpact && <span>{formatClassification(result.mateImpact)}</span>}
          {best?.moveSan && <span>Best: {best.moveSan}</span>}
          <span>{result.mode} · {result.telemetry?.elapsedMs || 0} ms</span>
        </div>
        {best?.pvSan?.length > 0 && <p>{best.pvSan.join(' ')}</p>}
      </div>
    );
  }

  return (
    <div className="mentor-analysis-result">
      <div className="mentor-analysis-headline">
        <strong>{formatEngineScore(result.score)}</strong>
        {result.bestMove?.san && <span>Best: {result.bestMove.san}</span>}
        {result.wdl && <span>W {result.wdl.whitePercent}% · D {result.wdl.drawPercent}% · B {result.wdl.blackPercent}%</span>}
      </div>
      <ol className="mentor-engine-lines">
        {(result.lines || []).slice(0, 3).map((line) => (
          <li key={`${line.rank}:${line.move}`}>
            <span>{line.rank}.</span>
            <strong>{line.moveSan || line.move}</strong>
            <span>{formatEngineScore(line.score)}</span>
            <small>{line.pvSan?.join(' ')}</small>
          </li>
        ))}
      </ol>
      <div className="mentor-analysis-meta">
        <span>Depth {result.telemetry?.depth || 0}</span>
        <span>{result.telemetry?.nodes?.toLocaleString?.() || 0} nodes</span>
        <span>{result.mode} · {result.telemetry?.elapsedMs || 0} ms</span>
      </div>
    </div>
  );
}

function ToolCallCard({ toolCall }) {
  const active = ['pending', 'running'].includes(toolCall.status);
  const failed = toolCall.status === 'failed';
  const cancelled = toolCall.status === 'cancelled';
  return (
    <div className={`mentor-tool-card is-${toolCall.status} ${toolCall.name.startsWith('analyze_') ? 'is-analysis' : ''}`} data-tool-name={toolCall.name}>
      <span className="mentor-tool-icon">
        {active ? <LoaderCircle size={14} /> : failed || cancelled ? <X size={14} /> : toolCall.name.startsWith('analyze_') ? <Gauge size={14} /> : <Check size={14} />}
      </span>
      <span className="mentor-tool-copy">
        <strong>{toolLabel(toolCall)}</strong>
        {toolCall.progressTotal > 1 && (
          <small>{toolCall.progressCurrent} of {toolCall.progressTotal} {toolCall.name === 'analyze_move' ? 'analysis passes' : 'moves'}</small>
        )}
        {(failed || cancelled) && toolCall.error && <small>{toolCall.error}</small>}
        {toolCall.status === 'complete' && <AnalysisResult result={toolCall.result} />}
      </span>
    </div>
  );
}

function Message({ message }) {
  const isUser = message.role === 'user';
  return (
    <article className={`mentor-message ${isUser ? 'is-user' : 'is-model'} ${message.kind === 'voice' ? 'is-voice' : ''} ${message.kind === 'activity' ? 'is-activity' : ''} ${message.kind === 'physical' ? 'is-physical' : ''}`}>
      {!isUser && <div className="mentor-message-avatar"><Bot size={18} /></div>}
      <div className="mentor-message-content">
        {message.kind === 'voice' && <span className="mentor-message-kind"><Mic size={11} /> Voice</span>}
        {message.kind === 'activity' && <span className="mentor-message-kind"><GraduationCap size={11} /> Activity</span>}
        {message.kind === 'physical' && <span className="mentor-message-kind"><Radio size={11} /> Physical board</span>}
        {!!message.toolCalls?.length && (
          <div className="mentor-tool-list">
            {message.toolCalls.map((toolCall) => <ToolCallCard key={toolCall.id} toolCall={toolCall} />)}
          </div>
        )}
        {message.content || (message.status === 'streaming' || message.status === 'pending' ? (
          <span className="mentor-thinking-dots" aria-label="Mentor is thinking"><i /><i /><i /></span>
        ) : '')}
        {message.status === 'failed' && <span className="mentor-message-state">Response failed</span>}
        {message.status === 'cancelled' && <span className="mentor-message-state">Response stopped</span>}
      </div>
    </article>
  );
}

export default function MentorWorkspace() {
  const socket = useSocket();
  const gameSettings = useGameSettings();
  const navigate = useNavigate();
  const { conversationId } = useParams();
  const [conversations, setConversations] = useState([]);
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [activeRequestId, setActiveRequestId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [socketReady, setSocketReady] = useState(false);
  const [boardState, setBoardState] = useState(null);
  const [physicalBoard, setPhysicalBoard] = useState({ binding: null, state: null });
  const [physicalAvailability, setPhysicalAvailability] = useState(null);
  const [physicalBusy, setPhysicalBusy] = useState(false);
  const [coachingStatus, setCoachingStatus] = useState(null);
  const [freshnessNow, setFreshnessNow] = useState(Date.now());
  const [previewFen, setPreviewFen] = useState(null);
  const [pendingBoardAction, setPendingBoardAction] = useState(null);
  const [fenDialogOpen, setFenDialogOpen] = useState(false);
  const [fenDraft, setFenDraft] = useState('');
  const [activity, setActivity] = useState(null);
  const [progress, setProgress] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [activityDialogOpen, setActivityDialogOpen] = useState(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [activityBusy, setActivityBusy] = useState(false);
  const [promotionPending, setPromotionPending] = useState(null);
  const messageScrollRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const streamPollRef = useRef(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const manualOrientationRef = useRef(false);

  const scrollToLatest = useCallback((behavior = 'auto') => {
    const scrollArea = messageScrollRef.current;
    if (!scrollArea) return;
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    scrollArea.scrollTo({ top: scrollArea.scrollHeight, behavior });
  }, []);

  const onMessageScroll = useCallback((event) => {
    const scrollArea = event.currentTarget;
    const distanceFromBottom = scrollArea.scrollHeight - scrollArea.clientHeight - scrollArea.scrollTop;
    const isNearBottom = distanceFromBottom <= 72;
    stickToBottomRef.current = isNearBottom;
    setShowJumpToLatest(!isNearBottom);
  }, []);

  const refreshList = useCallback(async (search = '') => {
    const result = await mentorApi.listConversations(search);
    setConversations(result.conversations);
    return result.conversations;
  }, []);

  const onLiveMessage = useCallback((message) => {
    setMessages((current) => upsertMessage(current, message));
  }, []);
  const onLiveError = useCallback((message) => setError(message), []);
  const onLiveConversationChanged = useCallback(() => {
    refreshList('').catch((refreshError) => setError(refreshError.message));
  }, [refreshList]);
  const live = useMentorLive({
    socket,
    conversationId,
    onMessage: onLiveMessage,
    onError: onLiveError,
    onConversationChanged: onLiveConversationChanged
  });
  const physicalAttached = physicalBoard?.binding?.status === 'active' && Boolean(physicalBoard?.state);
  const workspaceState = physicalAttached ? physicalBoard.state : boardState;
  const mentorRequestBusy = Boolean(activeRequestId || live.toolBusy);
  const openingLineComplete = physicalAttached && activity?.state?.pauseReason === 'line_complete';
  const displayedLiveStatus = openingLineComplete && live.status === 'thinking' ? 'listening' : live.status;
  const activityMoveLocked = Boolean(activity && activity.phase !== 'learner_turn');
  const boardInteractionLocked = Boolean(physicalAttached || mentorRequestBusy || pendingBoardAction || activityMoveLocked || activityBusy);
  const boardSetupLocked = Boolean(physicalAttached || mentorRequestBusy || pendingBoardAction || activity || activityBusy);

  const selectPhysicalPromotion = useCallback(async (piece) => {
    const promotion = physicalBoard?.state?.physical?.pendingPromotion;
    if (!promotion) return;
    setPhysicalBusy(true);
    try {
      const response = await fetch('/api/physical/promotion/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          piece,
          transactionId: promotion.id,
          expectedSessionGeneration: physicalBoard.state.sessionGeneration
        })
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Promotion selection failed.');
    } catch (promotionError) {
      setError(promotionError.message);
    } finally {
      setPhysicalBusy(false);
    }
  }, [physicalBoard]);

  useEffect(() => {
    if (!physicalAttached) return undefined;
    setFreshnessNow(Date.now());
    const timer = window.setInterval(() => setFreshnessNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [physicalAttached]);

  const createConversation = useCallback(async () => {
    const result = await mentorApi.createConversation();
    await refreshList('');
    navigate(`/mentor/${result.conversation.id}`);
    return result.conversation;
  }, [navigate, refreshList]);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      try {
        const list = await refreshList('');
        if (cancelled) return;
        if (!conversationId) {
          if (list.length) navigate(`/mentor/${list[0].id}`, { replace: true });
          else await createConversation();
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    initialize();
    return () => { cancelled = true; };
  }, [conversationId, createConversation, navigate, refreshList]);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    setLoading(true);
    mentorApi.getConversation(conversationId)
      .then(({ conversation: nextConversation }) => {
        if (cancelled) return;
        setConversation(nextConversation);
        setMessages(nextConversation.messages || []);
        setBoardState(nextConversation.chess);
        setPhysicalBoard(nextConversation.physicalBoard || { binding: null, state: null });
        setCoachingStatus(null);
        setActivity(nextConversation.activity || null);
        setProgress(nextConversation.progress || null);
        setPreviewFen(null);
        setPendingBoardAction(null);
        setPromotionPending(null);
        const active = nextConversation.messages?.find((message) =>
          message.role === 'model' && ['pending', 'streaming'].includes(message.status));
        setActiveRequestId(active?.requestId || null);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    mentorApi.getPhysicalBoard()
      .then((result) => { if (!cancelled) setPhysicalAvailability(result); })
      .catch((loadError) => { if (!cancelled) setError(loadError.message); });
    return () => { cancelled = true; };
  }, [conversationId]);

  useEffect(() => {
    if (!socket || !conversationId) return;
    setSocketReady(false);
    const subscribe = () => {
      socket.emit('mentor-subscribe', { conversationId }, (result) => {
        setSocketReady(result?.success === true);
        if (!result?.success && result?.error) setError(result.error);
      });
    };
    const onDisconnect = () => setSocketReady(false);
    if (socket.connected) subscribe();
    socket.on('connect', subscribe);
    socket.on('disconnect', onDisconnect);

    const matches = (payload) => payload.conversationId === conversationId;
    const onStart = (payload) => {
      if (!matches(payload)) return;
      setMessages((current) => upsertMessage(current, payload.message));
      setActiveRequestId(payload.requestId);
    };
    const onDelta = (payload) => {
      if (!matches(payload)) return;
      setMessages((current) => current.map((message) => message.id === payload.messageId
        ? { ...message, content: `${message.content || ''}${payload.delta}`, status: 'streaming' }
        : message));
    };
    const onTerminal = (payload) => {
      if (!matches(payload)) return;
      if (streamPollRef.current) clearTimeout(streamPollRef.current);
      setMessages((current) => upsertMessage(current, payload.message));
      setActiveRequestId(null);
      setCoachingStatus(null);
      if (payload.error) setError(payload.error);
      refreshList('');
    };
    const onBoardUpdated = (payload) => {
      if (!matches(payload)) return;
      setBoardState(payload.state);
      setPreviewFen(null);
      setPendingBoardAction((current) => current?.actionId === payload.actionId ? null : current);
    };
    const onToolUpdated = (payload) => {
      if (!matches(payload)) return;
      setMessages((current) => upsertToolCall(current, payload.toolCall));
    };
    const onActivityUpdated = (payload) => {
      if (!matches(payload)) return;
      const next = payload.activity;
      setActivity(next && ['active', 'paused'].includes(next.status) ? next : null);
    };
    const onPhysicalBindingUpdated = (payload) => {
      if (!matches(payload)) return;
      setPhysicalBoard(payload.physicalBoard || { binding: null, state: null });
    };
    const onPhysicalBoardUpdated = (payload) => {
      if (!matches(payload)) return;
      setPhysicalBoard((current) => ({ ...current, state: payload.state }));
      if (payload.state?.physical) {
        setPhysicalAvailability((current) => ({
          ...current,
          available: true,
          serverInstanceId: payload.state.physical.serverInstanceId,
          sessionGeneration: payload.state.physical.sessionGeneration,
          stateRevision: payload.state.physical.stateRevision,
          phase: payload.state.physical.phase,
          statusText: payload.state.physical.statusText,
          boundConversationId: conversationId
        }));
      }
    };
    const onProgressUpdated = (payload) => setProgress(payload);
    const onCoachingUpdated = (payload) => {
      if (!matches(payload)) return;
      setCoachingStatus(payload);
    };

    socket.on('mentor-message-start', onStart);
    socket.on('mentor-message-delta', onDelta);
    socket.on('mentor-message-complete', onTerminal);
    socket.on('mentor-message-cancelled', onTerminal);
    socket.on('mentor-message-failed', onTerminal);
    socket.on('mentor-board-updated', onBoardUpdated);
    socket.on('mentor-tool-started', onToolUpdated);
    socket.on('mentor-tool-progress', onToolUpdated);
    socket.on('mentor-tool-completed', onToolUpdated);
    socket.on('mentor-tool-failed', onToolUpdated);
    socket.on('mentor-tool-cancelled', onToolUpdated);
    socket.on('mentor-activity-updated', onActivityUpdated);
    socket.on('mentor-progress-updated', onProgressUpdated);
    socket.on('mentor-physical-binding-updated', onPhysicalBindingUpdated);
    socket.on('mentor-physical-board-updated', onPhysicalBoardUpdated);
    socket.on('mentor-physical-coaching-updated', onCoachingUpdated);
    return () => {
      if (streamPollRef.current) clearTimeout(streamPollRef.current);
      socket.emit('mentor-unsubscribe', { conversationId });
      socket.off('connect', subscribe);
      socket.off('disconnect', onDisconnect);
      socket.off('mentor-message-start', onStart);
      socket.off('mentor-message-delta', onDelta);
      socket.off('mentor-message-complete', onTerminal);
      socket.off('mentor-message-cancelled', onTerminal);
      socket.off('mentor-message-failed', onTerminal);
      socket.off('mentor-board-updated', onBoardUpdated);
      socket.off('mentor-tool-started', onToolUpdated);
      socket.off('mentor-tool-progress', onToolUpdated);
      socket.off('mentor-tool-completed', onToolUpdated);
      socket.off('mentor-tool-failed', onToolUpdated);
      socket.off('mentor-tool-cancelled', onToolUpdated);
      socket.off('mentor-activity-updated', onActivityUpdated);
      socket.off('mentor-progress-updated', onProgressUpdated);
      socket.off('mentor-physical-binding-updated', onPhysicalBindingUpdated);
      socket.off('mentor-physical-board-updated', onPhysicalBoardUpdated);
      socket.off('mentor-physical-coaching-updated', onCoachingUpdated);
    };
  }, [conversationId, refreshList, socket]);

  const openActivityDialog = useCallback(async () => {
    try {
      if (!catalog.length) {
        const result = await mentorApi.getCatalog();
        setCatalog(result.catalog || []);
      }
      setActivityDialogOpen(true);
    } catch (loadError) {
      setError(loadError.message);
    }
  }, [catalog.length]);

  const startActivity = async (options) => {
    if (!conversationId || !workspaceState) return;
    setActivityBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await mentorApi.startActivity(conversationId, options);
      setActivity(result.activity);
      if (physicalAttached) {
        setPhysicalBoard((current) => ({ ...(current || {}), state: result.state }));
      } else {
        setBoardState(result.state);
      }
      setPreviewFen(null);
      setActivityDialogOpen(false);
    } catch (activityError) {
      setError(activityError.message);
    } finally {
      setActivityBusy(false);
    }
  };

  const resolvePhysicalOpening = async (action) => {
    if (!conversationId || activityBusy) return;
    setActivityBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await mentorApi.resolvePhysicalOpening(conversationId, action);
      const nextActivity = result.activity?.id && ['active', 'paused'].includes(result.activity.status)
        ? result.activity
        : null;
      setActivity(nextActivity);
      if (result.physicalBoard) setPhysicalBoard(result.physicalBoard);
      if (action === 'repeat') setNotice('Restore the complete standard setup. The drill restarts after it stays stable.');
      if (action === 'continue') setNotice('Opening drill complete. Normal physical play resumed.');
      if (action === 'finish') setNotice('Opening lesson finished. The board will wait until you resume play.');
    } catch (activityError) {
      setError(activityError.message);
    } finally {
      setActivityBusy(false);
    }
  };

  const updateActivity = async (operation) => {
    if (!activity || activityBusy) return;
    setActivityBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await operation(activity.id);
      setActivity(result?.activity && ['active', 'paused'].includes(result.activity.status) ? result.activity : null);
      if (result?.hint) setNotice(`Hint ${result.level}: ${result.hint}`);
    } catch (activityError) {
      setError(activityError.message);
    } finally {
      setActivityBusy(false);
    }
  };

  const saveProfile = async (skillBand, goals) => {
    setActivityBusy(true);
    try {
      const result = await mentorApi.updateProfile(skillBand, goals);
      setProgress(result);
      setProfileDialogOpen(false);
    } catch (profileError) {
      setError(profileError.message);
    } finally {
      setActivityBusy(false);
    }
  };

  const stopLiveForWorkspaceChange = async () => {
    if (!live.isActive) return;
    await live.stop();
  };

  const attachPhysicalBoard = async () => {
    if (!conversationId || physicalBusy || physicalAttached) return;
    setPhysicalBusy(true);
    setError('');
    try {
      await stopLiveForWorkspaceChange();
      const availability = await mentorApi.getPhysicalBoard();
      setPhysicalAvailability(availability);
      if (!availability.available) throw new Error('Start the physical game from the Companion Board first.');
      const result = await mentorApi.attachPhysicalBoard(
        conversationId,
        availability.serverInstanceId,
        availability.sessionGeneration
      );
      setPhysicalBoard(result.physicalBoard);
    } catch (physicalError) {
      setError(physicalError.message);
    } finally {
      setPhysicalBusy(false);
    }
  };

  const detachPhysicalBoard = async () => {
    if (!conversationId || physicalBusy || !physicalAttached) return;
    setPhysicalBusy(true);
    setError('');
    try {
      await stopLiveForWorkspaceChange();
      const result = await mentorApi.detachPhysicalBoard(conversationId);
      setPhysicalBoard(result.physicalBoard || { binding: null, state: null });
      setPreviewFen(null);
      setPendingBoardAction(null);
      setPhysicalAvailability(await mentorApi.getPhysicalBoard());
    } catch (physicalError) {
      setError(physicalError.message);
    } finally {
      setPhysicalBusy(false);
    }
  };

  const togglePhysicalCoaching = async () => {
    if (!conversationId || !physicalAttached || physicalBusy) return;
    setPhysicalBusy(true);
    setError('');
    try {
      const currentMode = physicalBoard.binding?.coachingMode;
      const result = await mentorApi.setPhysicalCoaching(
        conversationId,
        currentMode === 'selective' ? 'off' : 'selective'
      );
      setPhysicalBoard(result.physicalBoard);
      setCoachingStatus(null);
    } catch (physicalError) {
      setError(physicalError.message);
    } finally {
      setPhysicalBusy(false);
    }
  };

  const reconcileStream = useCallback((id, requestId, attempt = 0) => {
    streamPollRef.current = setTimeout(async () => {
      try {
        const result = await mentorApi.getConversation(id);
        const requestMessages = (result.conversation.messages || [])
          .filter((message) => message.requestId === requestId);
        setMessages((current) => requestMessages.reduce(upsertMessage, current));
        const assistant = requestMessages.find((message) => message.role === 'model');
        if (assistant && ['complete', 'failed', 'cancelled'].includes(assistant.status)) {
          setActiveRequestId(null);
          await refreshList('');
          return;
        }
        if (attempt < 120) reconcileStream(id, requestId, attempt + 1);
      } catch (pollError) {
        if (attempt < 120) reconcileStream(id, requestId, attempt + 1);
        else setError(pollError.message);
      }
    }, 300);
  }, [refreshList]);

  useEffect(() => {
    if (!stickToBottomRef.current) return undefined;
    const frame = requestAnimationFrame(() => {
      if (stickToBottomRef.current) scrollToLatest('auto');
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, scrollToLatest]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      refreshList(query).catch((searchError) => setError(searchError.message));
    }, 180);
    return () => clearTimeout(timeout);
  }, [query, refreshList]);

  const sendMessage = async (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed || !conversationId || mentorRequestBusy || !socketReady) return;
    const requestId = crypto.randomUUID();
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    setDraft('');
    setError('');
    try {
      if (live.isActive) {
        const result = await live.sendText(requestId, trimmed);
        setMessages((current) => {
          let next = upsertMessage(current, result.userMessage);
          next = upsertMessage(next, result.assistantMessage);
          return next;
        });
        await refreshList('');
        return;
      }
      setActiveRequestId(requestId);
      const result = await mentorApi.sendMessage(conversationId, requestId, trimmed);
      setMessages((current) => {
        let next = upsertMessage(current, result.userMessage);
        next = upsertMessage(next, result.assistantMessage);
        return next;
      });
      reconcileStream(conversationId, requestId);
      await refreshList('');
    } catch (sendError) {
      setActiveRequestId(null);
      setError(sendError.message);
    }
  };

  const renameConversation = async (id, title) => {
    try {
      const result = await mentorApi.renameConversation(id, title);
      if (id === conversationId) setConversation(result.conversation);
      await refreshList(query);
    } catch (renameError) {
      setError(renameError.message);
    }
  };

  const deleteConversation = async (id) => {
    try {
      await mentorApi.deleteConversation(id);
      const list = await refreshList(query);
      if (id === conversationId) {
        if (list.length) navigate(`/mentor/${list[0].id}`);
        else await createConversation();
      }
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  const stopStreaming = () => {
    if (!socket || !activeRequestId) return;
    socket.emit('mentor-message-cancel', { conversationId, requestId: activeRequestId });
  };

  const commitBoardAction = useCallback(async (actionId, operation) => {
    setPendingBoardAction((current) => current || { actionId });
    setError('');
    try {
      const result = await operation();
      setBoardState(result.state);
      setPreviewFen(null);
      setPendingBoardAction(null);
      return true;
    } catch (boardError) {
      if (boardError.state) setBoardState(boardError.state);
      setPreviewFen(null);
      setPendingBoardAction(null);
      setError(boardError.message);
      return false;
    }
  }, []);

  const submitBoardMove = useCallback((sourceSquare, targetSquare, promotion) => {
    if (!boardState) return false;
    const preview = new Chess(boardState.fen);
    let move;
    try {
      move = preview.move({ from: sourceSquare, to: targetSquare, promotion });
    } catch {
      return false;
    }
    if (!move) return false;

    const actionId = crypto.randomUUID();
    setPreviewFen(preview.fen());
    setPendingBoardAction({ actionId, uci: `${move.from}${move.to}${move.promotion || ''}` });
    commitBoardAction(actionId, () => mentorApi.move(
      conversationId,
      `${move.from}${move.to}${move.promotion || ''}`,
      boardState.revision,
      actionId
    ));
    return true;
  }, [boardState, commitBoardAction, conversationId]);

  const onBoardMove = useCallback((args) => {
    if (!boardState || boardInteractionLocked || boardState.gameStatus.isGameOver) return false;
    const { sourceSquare, targetSquare } = args;
    const game = new Chess(boardState.fen);
    const piece = game.get(sourceSquare);
    const promotion = piece?.type === 'p' && ['1', '8'].includes(targetSquare[1]);
    if (promotion) {
      const legalPromotion = game.moves({ verbose: true }).some((move) =>
        move.from === sourceSquare && move.to === targetSquare && move.promotion);
      if (!legalPromotion) return false;
      setPromotionPending({ sourceSquare, targetSquare, color: piece.color });
      return false;
    }
    return submitBoardMove(sourceSquare, targetSquare);
  }, [boardInteractionLocked, boardState, submitBoardMove]);

  const choosePromotion = useCallback((piece) => {
    if (!promotionPending) return;
    const { sourceSquare, targetSquare } = promotionPending;
    setPromotionPending(null);
    submitBoardMove(sourceSquare, targetSquare, piece);
  }, [promotionPending, submitBoardMove]);

  const flipBoard = () => {
    if (!workspaceState || mentorRequestBusy || pendingBoardAction || activityBusy) return;
    manualOrientationRef.current = true;
    if (physicalAttached) {
      setPhysicalBusy(true);
      mentorApi.setPhysicalOrientation(
        conversationId,
        workspaceState.orientation === 'white' ? 'black' : 'white',
        workspaceState.revision
      ).then((result) => {
        setPhysicalBoard(result.physicalBoard);
      }).catch((orientationError) => {
        if (orientationError.state) {
          setPhysicalBoard((current) => ({ ...current, state: orientationError.state }));
        }
        setError(orientationError.message);
      }).finally(() => setPhysicalBusy(false));
      return;
    }
    const actionId = crypto.randomUUID();
    const orientation = boardState.orientation === 'white' ? 'black' : 'white';
    commitBoardAction(actionId, () => mentorApi.setOrientation(
      conversationId,
      orientation,
      boardState.revision,
      actionId
    ));
  };

  const updateSharedColor = async (humanColor) => {
    try {
      await gameSettings.updateDefaults({ humanColor });
      if (manualOrientationRef.current || !workspaceState) return;
      if (physicalAttached) {
        const result = await mentorApi.setPhysicalOrientation(
          conversationId,
          humanColor,
          workspaceState.revision
        );
        setPhysicalBoard(result.physicalBoard);
      } else if (boardState?.orientation !== humanColor) {
        const actionId = crypto.randomUUID();
        const result = await mentorApi.setOrientation(conversationId, humanColor, boardState.revision, actionId);
        setBoardState(result.state);
      }
    } catch (settingsError) {
      setError(settingsError.message);
    }
  };

  const updateSharedDifficulty = async (difficultyLevel) => {
    try {
      await gameSettings.updateDifficulty(
        difficultyLevel,
        physicalAttached ? workspaceState.sessionGeneration : null
      );
    } catch (settingsError) {
      setError(settingsError.message);
    }
  };

  const resetBoard = () => {
    if (!boardState || boardSetupLocked) return;
    const actionId = crypto.randomUUID();
    commitBoardAction(actionId, () => mentorApi.resetBoard(
      conversationId,
      boardState.revision,
      actionId
    ));
  };

  const loadFen = async (event) => {
    event.preventDefault();
    if (!boardState || boardSetupLocked) return;
    const actionId = crypto.randomUUID();
    const success = await commitBoardAction(actionId, () => mentorApi.loadPosition(
      conversationId,
      fenDraft,
      boardState.revision,
      actionId
    ));
    if (success) setFenDialogOpen(false);
  };

  const grouped = useMemo(() => groupConversations(conversations), [conversations]);
  const annotationSquareStyles = useMemo(() => {
    const styles = Object.fromEntries(
      (workspaceState?.annotations?.highlights || []).map(({ square, role }) => [
        square,
        { boxShadow: `inset 0 0 0 5px ${ANNOTATION_COLORS[role] || ANNOTATION_COLORS.idea}` }
      ])
    );
    if (!physicalAttached) return styles;
    const physical = workspaceState.physical;
    for (const square of physical?.board?.missingSquares || []) {
      styles[square] = { boxShadow: 'inset 0 0 0 6px #ef4444', backgroundColor: 'rgba(239, 68, 68, 0.45)' };
    }
    for (const square of physical?.board?.extraSquares || []) {
      styles[square] = { boxShadow: 'inset 0 0 0 6px #f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.45)' };
    }
    if (physical?.selectedSource) {
      styles[physical.selectedSource] = { boxShadow: 'inset 0 0 0 6px #3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.4)' };
    }
    for (const target of physical?.legalTargets || []) {
      const square = target.to || target.square;
      if (!square) continue;
      const color = target.special ? '#a855f7' : target.capture ? '#ef4444' : '#22c55e';
      styles[square] = { boxShadow: `inset 0 0 0 6px ${color}` };
    }
    if (workspaceState.gameStatus?.inCheck && workspaceState.gameStatus?.checkedKingSquare) {
      styles[workspaceState.gameStatus.checkedKingSquare] = {
        boxShadow: 'inset 0 0 0 7px #dc2626',
        backgroundColor: 'rgba(220, 38, 38, 0.5)'
      };
    }
    return styles;
  }, [physicalAttached, workspaceState]);
  const annotationArrows = useMemo(() => (workspaceState?.annotations?.arrows || []).map((arrow) => ({
    startSquare: arrow.from,
    endSquare: arrow.to,
    color: ANNOTATION_COLORS[arrow.role] || ANNOTATION_COLORS.idea
  })), [workspaceState?.annotations?.arrows]);
  const currentAnalysis = useMemo(() => messages
    .flatMap((message) => message.toolCalls || [])
    .filter((toolCall) => toolCall.status === 'complete'
      && toolCall.result?.analyzedFen === workspaceState?.fen
      && (toolCall.result?.sourceKey
        ? toolCall.result.sourceKey === workspaceState?.sourceKey
        : workspaceState?.source !== 'physical')
      && ['position_analysis', 'move_analysis'].includes(toolCall.result?.kind))
    .at(-1)?.result || null, [messages, workspaceState?.fen, workspaceState?.source, workspaceState?.sourceKey]);
  const evaluationPercent = useMemo(() => {
    const score = currentAnalysis?.score;
    if (!score) return 50;
    if (score.type === 'mate') return score.value > 0 ? 100 : 0;
    return Math.max(0, Math.min(100, 50 + (score.value / 20)));
  }, [currentAnalysis]);

  return (
    <main className="mentor-shell">
      <aside className="mentor-sidebar">
        <div className="mentor-brand"><span>CM</span><strong>Chess Mentor</strong></div>
        <button className="mentor-new-chat" onClick={createConversation}><Plus size={18} /> New chat</button>
        <label className="mentor-search">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats" />
        </label>
        <nav className="mentor-history" aria-label="Conversation history">
          {grouped.map(([label, items]) => (
            <section key={label} className="mentor-history-group">
              <h2>{label}</h2>
              {items.map((item) => (
                <ConversationItem
                  key={item.id}
                  conversation={item}
                  active={item.id === conversationId}
                  onOpen={(id) => navigate(`/mentor/${id}`)}
                  onRename={renameConversation}
                  onDelete={deleteConversation}
                />
              ))}
            </section>
          ))}
        </nav>
        <div className="mentor-sidebar-footer">
          <Link to="/"><ChevronLeft size={17} /> Companion board</Link>
        </div>
      </aside>

      <section className="mentor-conversation">
        <header className="mentor-conversation-header">
          <div><span>MENTOR</span><h1>{conversation?.title || 'New chat'}</h1></div>
          <span className="mentor-model-label">{live.isActive ? 'Gemini 3.1 Flash Live' : 'Gemini 3.5 Flash'}</span>
        </header>
        <div className="mentor-message-scroll-wrap">
          <div className="mentor-message-scroll" ref={messageScrollRef} onScroll={onMessageScroll}>
            {!loading && messages.length === 0 ? (
              <div className="mentor-empty-state">
                <div className="mentor-empty-mark"><Bot size={28} /></div>
                <h2>What would you like to work on?</h2>
                <p>Choose a starting point or ask your own chess question.</p>
                <div className="mentor-suggestions">
                  {SUGGESTIONS.map((suggestion) => (
                    <button key={suggestion.title} disabled={!socketReady || mentorRequestBusy} onClick={() => sendMessage(suggestion.prompt)}>
                      <strong>{suggestion.title}</strong>
                      <span>{suggestion.prompt}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : messages.map((message) => <Message key={message.id} message={message} />)}
            {live.partialUser && (
              <Message message={{
                id: `partial-user-${live.partialUser.id}`,
                role: 'user',
                kind: 'voice',
                content: live.partialUser.text,
                status: 'streaming'
              }} />
            )}
            {live.partialAssistant && (
              <Message message={{
                id: `partial-model-${live.partialAssistant.id}`,
                role: 'model',
                kind: 'voice',
                content: live.partialAssistant.text,
                status: 'streaming'
              }} />
            )}
          </div>
          {showJumpToLatest && (
            <button
              className="mentor-jump-latest"
              type="button"
              onClick={() => scrollToLatest()}
              title="Jump to latest message"
              aria-label="Jump to latest message"
            >
              <ArrowDown size={18} />
            </button>
          )}
        </div>
        <div className="mentor-composer-wrap">
          {notice && <div className="mentor-notice"><span>{notice}</span><button onClick={() => setNotice('')} title="Dismiss notice"><X size={15} /></button></div>}
          {error && <div className="mentor-error"><span>{error}</span><button onClick={() => setError('')} title="Dismiss error"><X size={15} /></button></div>}
          <LiveAudioControls live={live} />
          {(live.isActive || live.status === 'failed') && (
            <div className={`mentor-live-status is-${displayedLiveStatus}`}>
              <span className="mentor-live-status-dot" />
              <strong>{openingLineComplete && live.status === 'thinking' ? 'Opening line complete' : liveStatusText(live)}</strong>
              {live.isActive && <span>{live.micGated ? 'Microphone pauses until playback ends or you interrupt' : live.toolBusy ? 'Microphone and Stop remain available' : 'Speak naturally or type below'}</span>}
            </div>
          )}
          <div className="mentor-composer">
            <textarea
              value={draft}
              placeholder={socketReady ? (live.isActive ? 'Speak or type to your chess mentor' : 'Ask your chess mentor') : 'Connecting to mentor...'}
              disabled={!socketReady}
              rows={1}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
            />
            <div className="mentor-composer-actions">
              {!live.isActive ? (
                <button
                  className="mentor-live-button"
                  onClick={live.start}
                  disabled={!socketReady || !!activeRequestId || live.status === 'connecting'}
                  title="Start Live voice"
                  aria-label="Start Live voice"
                ><Mic size={17} /></button>
              ) : (
                <>
                  <button
                    className={`mentor-live-button ${live.muted ? 'is-muted' : 'is-active'}`}
                    onClick={live.toggleMute}
                    title={live.muted ? 'Unmute microphone' : 'Mute microphone'}
                    aria-label={live.muted ? 'Unmute microphone' : 'Mute microphone'}
                  >{live.muted ? <MicOff size={17} /> : <Mic size={17} />}</button>
                  <button className="mentor-live-stop" onClick={() => live.stop()} title="Stop Live voice" aria-label="Stop Live voice"><Square size={13} fill="currentColor" /></button>
                </>
              )}
              {activeRequestId ? (
                <button className="mentor-send-button" onClick={stopStreaming} title="Stop response" aria-label="Stop response"><Square size={15} fill="currentColor" /></button>
              ) : (
                <button className="mentor-send-button" onClick={() => sendMessage()} disabled={!draft.trim() || !socketReady || live.status === 'connecting' || live.toolBusy} title="Send message" aria-label="Send message"><ArrowUp size={19} /></button>
              )}
            </div>
          </div>
          <p>Mentor responses can be inaccurate. Verify critical analysis on the board.</p>
        </div>
      </section>

      <aside className="mentor-board-panel">
        <header>
          <div><span>WORKSPACE</span><h2>{physicalAttached ? 'Physical board' : 'Position board'}</h2></div>
          <div className="mentor-board-tools">
            <button onClick={() => setProfileDialogOpen(true)} disabled={activityBusy} title="Learner profile" aria-label="Learner profile"><Settings2 size={16} /></button>
            <button onClick={flipBoard} disabled={!workspaceState || mentorRequestBusy || !!pendingBoardAction || activityBusy || physicalBusy} title="Flip board" aria-label="Flip board"><Repeat2 size={17} /></button>
            <button onClick={() => { setFenDraft(boardState?.fen || ''); setFenDialogOpen(true); }} disabled={!boardState || boardSetupLocked} title="Load FEN" aria-label="Load FEN"><Pencil size={16} /></button>
            <button onClick={resetBoard} disabled={!boardState || boardSetupLocked} title="Reset board" aria-label="Reset board"><RefreshCcw size={16} /></button>
          </div>
        </header>
        <div className="mentor-board-source" role="group" aria-label="Board source">
          <button className={!physicalAttached ? 'is-active' : ''} onClick={detachPhysicalBoard} disabled={!physicalAttached || physicalBusy}>Virtual</button>
          <button className={physicalAttached ? 'is-active' : ''} onClick={attachPhysicalBoard} disabled={physicalAttached || physicalBusy || mentorRequestBusy || !!activity}>
            <Radio size={13} /> Physical
          </button>
        </div>
        <GameSettingsControls
          compact
          defaults={gameSettings.defaults}
          activeHumanColor={physicalAttached ? workspaceState?.humanColor : gameSettings.defaults.humanColor}
          activeGame={Boolean(physicalAttached || activity)}
          activeSearch={Boolean(physicalAttached && (workspaceState?.activeSearchLevel || workspaceState?.difficultyPending))}
          disabled={physicalBusy}
          onColorChange={updateSharedColor}
          onLevelChange={updateSharedDifficulty}
        />
        {physicalAttached ? (
          <>
            <div className={`mentor-physical-status is-${workspaceState.physical.phase}`}>
              <span className="mentor-physical-status-dot" />
              <div>
                <strong>{workspaceState.physical.robotBusy ? 'Robot working' : workspaceState.physical.phase.replaceAll('_', ' ')}</strong>
                <small>{workspaceState.physical.statusText}</small>
              </div>
              <span>{workspaceState.physical.lastSnapshotAt
                ? `${Math.max(0, Math.round((freshnessNow - workspaceState.physical.lastSnapshotAt) / 1000))}s`
                : 'No sensor data'}</span>
            </div>
            <button
              className={`mentor-coaching-toggle ${physicalBoard.binding?.coachingMode === 'selective' ? 'is-active' : ''}`}
              type="button"
              onClick={togglePhysicalCoaching}
              disabled={physicalBusy}
              aria-pressed={physicalBoard.binding?.coachingMode === 'selective'}
            >
              <span>{coachingStatus?.text || (physicalBoard.binding?.coachingMode === 'selective' ? 'Selective coaching on' : physicalBoard.binding?.coachingMode === 'prompt_pending' ? 'Coaching choice pending' : 'Coaching paused')}</span>
              <strong>{physicalBoard.binding?.coachingMode === 'selective' ? 'On' : 'Off'}</strong>
            </button>
            {workspaceState.physical.pendingPromotion && (
              <div className="mentor-promotion-panel">
                <strong>Promotion on {workspaceState.physical.pendingPromotion.to}</strong>
                <span>{workspaceState.physical.statusText}</span>
                <div>
                  {['q', 'r', 'b', 'n'].map((piece) => (
                    <button
                      key={piece}
                      type="button"
                      className={workspaceState.physical.pendingPromotion.selectedPiece === piece ? 'is-active' : ''}
                      disabled={workspaceState.physical.pendingPromotion.actor !== 'human' || physicalBusy}
                      onClick={() => selectPhysicalPromotion(piece)}
                    >{piece.toUpperCase()}</button>
                  ))}
                </div>
                <small>Board letter: {(workspaceState.physical.pendingPromotion.displayedPiece || '-').toUpperCase()} · {Math.min(500, workspaceState.physical.pendingPromotion.stableForMs || 0)} / 500 ms stable</small>
              </div>
            )}
          </>
        ) : physicalBoard?.binding?.status === 'stale' ? (
          <div className="mentor-physical-status is-stale"><span className="mentor-physical-status-dot" /><div><strong>Previous physical session ended</strong><small>Attach the new game explicitly when it is ready.</small></div></div>
        ) : !physicalAvailability?.available ? (
          <div className="mentor-physical-unavailable"><span>No active physical game.</span><Link to="/">Open Companion Board</Link></div>
        ) : null}
        <ActivityBar
          activity={activity}
          busy={activityBusy || mentorRequestBusy}
          disabled={false}
          physical={physicalAttached}
          openingLock={Boolean(workspaceState?.physical?.openingLock)}
          onStart={openActivityDialog}
          onProfile={() => setProfileDialogOpen(true)}
          onPause={() => updateActivity((id) => mentorApi.pauseActivity(conversationId, id))}
          onResume={() => updateActivity((id) => mentorApi.resumeActivity(conversationId, id))}
          onHint={() => updateActivity((id) => mentorApi.requestHint(conversationId, id))}
          onEnd={() => updateActivity((id) => mentorApi.endActivity(conversationId, id))}
          onPhysicalAction={resolvePhysicalOpening}
        />
        <div className="mentor-board-stage">
          <div
            className={`mentor-eval-bar is-${workspaceState?.orientation || 'white'} ${currentAnalysis ? 'has-analysis' : ''}`}
            title={currentAnalysis ? `Stockfish evaluation ${formatEngineScore(currentAnalysis.score)}` : 'Position not analyzed'}
            aria-label={currentAnalysis ? `Stockfish evaluation ${formatEngineScore(currentAnalysis.score)}` : 'Position not analyzed'}
          >
            <span className="mentor-eval-white" style={{ height: `${evaluationPercent}%` }} />
            <strong>{formatEngineScore(currentAnalysis?.score)}</strong>
          </div>
          <div className="mentor-board-frame">
            <Chessboard options={{
              position: physicalAttached ? workspaceState?.fen : previewFen || workspaceState?.fen || STANDARD_FEN,
              boardOrientation: workspaceState?.orientation || 'white',
              animationDurationInMs: 350,
              arrows: annotationArrows,
              squareStyles: annotationSquareStyles,
              allowDrawingArrows: false,
              onPieceDrop: onBoardMove,
              allowDragging: !!workspaceState && !boardInteractionLocked && !workspaceState.gameStatus.isGameOver,
              darkSquareStyle: { backgroundColor: '#1e293b' },
              lightSquareStyle: { backgroundColor: '#e2e8f0' }
            }} />
          </div>
        </div>
        <div className="mentor-board-summary">
          <div><span>Turn</span><strong>{workspaceState?.turnName || 'White'}</strong></div>
          <div><span>Status</span><strong>{live.toolBusy ? live.toolLabel : pendingBoardAction ? 'Saving move...' : activity ? activityPhaseLabel(activity) : workspaceState?.gameStatus.resultText || 'Ready'}</strong></div>
        </div>
        <div className="mentor-move-list">
          <div className="mentor-move-list-header"><span>MOVE LIST</span><strong>{workspaceState?.history.length || 0} plies</strong></div>
          <ol>
            {(workspaceState?.history || []).reduce((rows, move, index) => {
              if (index % 2 === 0) rows.push([move]);
              else rows.at(-1).push(move);
              return rows;
            }, []).map((pair, index) => (
              <li key={pair[0].ply}>
                <span>{index + 1}.</span>
                <button title={pair[0].uci}>{pair[0].san}</button>
                <button title={pair[1]?.uci || ''}>{pair[1]?.san || ''}</button>
              </li>
            ))}
          </ol>
        </div>
      </aside>

      {fenDialogOpen && (
        <div className="mentor-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setFenDialogOpen(false);
        }}>
          <form className="mentor-fen-dialog" onSubmit={loadFen}>
            <header><div><span>POSITION</span><h2>Load FEN</h2></div><button type="button" onClick={() => setFenDialogOpen(false)} title="Close"><X size={18} /></button></header>
            <label htmlFor="mentor-fen-input">Forsyth-Edwards Notation</label>
            <textarea id="mentor-fen-input" value={fenDraft} onChange={(event) => setFenDraft(event.target.value)} rows={4} autoFocus />
            <div className="mentor-dialog-actions">
              <button type="button" onClick={() => setFenDialogOpen(false)}>Cancel</button>
              <button type="submit">Load position</button>
            </div>
          </form>
        </div>
      )}
      {activityDialogOpen && workspaceState && (
        <ActivityDialog
          catalog={catalog}
          boardRevision={workspaceState.revision}
          physical={physicalAttached}
          onClose={() => setActivityDialogOpen(false)}
          onStart={startActivity}
        />
      )}
      {profileDialogOpen && (
        <ProfileDialog progress={progress} onClose={() => setProfileDialogOpen(false)} onSave={saveProfile} />
      )}
      {promotionPending && (
        <PromotionDialog
          color={promotionPending.color}
          target={promotionPending.targetSquare}
          onChoose={choosePromotion}
          onClose={() => setPromotionPending(null)}
        />
      )}
    </main>
  );
}
