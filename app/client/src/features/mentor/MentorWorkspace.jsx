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
    get_activity_state: 'Read activity state',
    propose_activity: 'Validate activity',
    start_activity: 'Start activity',
    request_prediction: 'Request prediction',
    request_hint: 'Give hint',
    end_activity: 'End activity',
    engine_fallback: `Engine fallback ${args.uci || ''}`.trim(),
    activity_fallback: `Reviewed continuation ${args.uci || ''}`.trim()
  };
  return labels[toolCall.name] || toolCall.name.replaceAll('_', ' ');
}

function activityPhaseLabel(activity) {
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

function ActivityBar({ activity, busy, onStart, onPause, onResume, onHint, onEnd, onProfile }) {
  if (!activity) {
    return (
      <div className="mentor-activity-bar is-idle">
        <div><GraduationCap size={17} /><span><strong>Guided practice</strong><small>Start a game, drill, puzzle, or lesson</small></span></div>
        <div className="mentor-activity-actions">
          <button onClick={onProfile} title="Learner profile" aria-label="Learner profile"><Settings2 size={15} /></button>
          <button className="is-primary" onClick={onStart}><Play size={14} /> Start activity</button>
        </div>
      </div>
    );
  }
  const progress = activity.totalSteps ? Math.min(100, Math.round((activity.stepIndex / activity.totalSteps) * 100)) : 0;
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
        {['opening_drill', 'puzzle', 'guided_lesson'].includes(activity.type) && (
          <button onClick={onHint} disabled={busy} title="Request hint" aria-label="Request hint"><Lightbulb size={15} /></button>
        )}
        {activity.status === 'paused'
          ? <button onClick={onResume} disabled={busy} title="Resume activity" aria-label="Resume activity"><Play size={15} /></button>
          : <button onClick={onPause} disabled={busy} title="Pause activity" aria-label="Pause activity"><Pause size={15} /></button>}
        <button onClick={onEnd} disabled={busy} title="End activity" aria-label="End activity"><X size={15} /></button>
      </div>
    </div>
  );
}

function ActivityDialog({ catalog, boardRevision, onClose, onStart }) {
  const [type, setType] = useState('practice_game');
  const [sourceId, setSourceId] = useState('');
  const [learnerColor, setLearnerColor] = useState('white');
  const [startFrom, setStartFrom] = useState('standard');
  const items = useMemo(() => catalog.filter((item) => item.type === type), [catalog, type]);
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
        <header><div><span>ACTIVITY</span><h2>Start guided practice</h2></div><button type="button" onClick={onClose} title="Close"><X size={18} /></button></header>
        <div className="mentor-dialog-body">
          <div className="mentor-mode-grid">
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
          </div>
          {type !== 'practice_game' && (
            <label>Activity
              <select value={sourceId} onChange={(event) => {
                const next = items.find((item) => item.id === event.target.value);
                setSourceId(event.target.value);
                if (next?.fixedLearnerColor) setLearnerColor(next.fixedLearnerColor);
              }}>
                {items.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
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
          {!selected?.fixedLearnerColor && (
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
    interrupted: 'Live voice interrupted'
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
    <article className={`mentor-message ${isUser ? 'is-user' : 'is-model'} ${message.kind === 'voice' ? 'is-voice' : ''} ${message.kind === 'activity' ? 'is-activity' : ''}`}>
      {!isUser && <div className="mentor-message-avatar"><Bot size={18} /></div>}
      <div className="mentor-message-content">
        {message.kind === 'voice' && <span className="mentor-message-kind"><Mic size={11} /> Voice</span>}
        {message.kind === 'activity' && <span className="mentor-message-kind"><GraduationCap size={11} /> Activity</span>}
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
  const mentorRequestBusy = Boolean(activeRequestId || live.toolBusy);
  const activityMoveLocked = Boolean(activity && activity.phase !== 'learner_turn');
  const boardInteractionLocked = Boolean(mentorRequestBusy || pendingBoardAction || activityMoveLocked || activityBusy);
  const boardSetupLocked = Boolean(mentorRequestBusy || pendingBoardAction || activity || activityBusy);

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
    const onProgressUpdated = (payload) => setProgress(payload);

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
    if (!conversationId || !boardState) return;
    setActivityBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await mentorApi.startActivity(conversationId, options);
      setActivity(result.activity);
      setBoardState(result.state);
      setPreviewFen(null);
      setActivityDialogOpen(false);
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
    if (!boardState || mentorRequestBusy || pendingBoardAction || activityBusy) return;
    const actionId = crypto.randomUUID();
    const orientation = boardState.orientation === 'white' ? 'black' : 'white';
    commitBoardAction(actionId, () => mentorApi.setOrientation(
      conversationId,
      orientation,
      boardState.revision,
      actionId
    ));
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
  const annotationSquareStyles = useMemo(() => Object.fromEntries(
    (boardState?.annotations?.highlights || []).map(({ square, role }) => [
      square,
      { boxShadow: `inset 0 0 0 5px ${ANNOTATION_COLORS[role] || ANNOTATION_COLORS.idea}` }
    ])
  ), [boardState?.annotations?.highlights]);
  const annotationArrows = useMemo(() => (boardState?.annotations?.arrows || []).map((arrow) => ({
    startSquare: arrow.from,
    endSquare: arrow.to,
    color: ANNOTATION_COLORS[arrow.role] || ANNOTATION_COLORS.idea
  })), [boardState?.annotations?.arrows]);
  const currentAnalysis = useMemo(() => messages
    .flatMap((message) => message.toolCalls || [])
    .filter((toolCall) => toolCall.status === 'complete'
      && toolCall.result?.analyzedFen === boardState?.fen
      && ['position_analysis', 'move_analysis'].includes(toolCall.result?.kind))
    .at(-1)?.result || null, [boardState?.fen, messages]);
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
            <div className={`mentor-live-status is-${live.status}`}>
              <span className="mentor-live-status-dot" />
              <strong>{liveStatusText(live)}</strong>
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
          <div><span>WORKSPACE</span><h2>Position board</h2></div>
          <div className="mentor-board-tools">
            <button onClick={() => setProfileDialogOpen(true)} disabled={activityBusy} title="Learner profile" aria-label="Learner profile"><Settings2 size={16} /></button>
            <button onClick={flipBoard} disabled={!boardState || mentorRequestBusy || !!pendingBoardAction || activityBusy} title="Flip board" aria-label="Flip board"><Repeat2 size={17} /></button>
            <button onClick={() => { setFenDraft(boardState?.fen || ''); setFenDialogOpen(true); }} disabled={!boardState || boardSetupLocked} title="Load FEN" aria-label="Load FEN"><Pencil size={16} /></button>
            <button onClick={resetBoard} disabled={!boardState || boardSetupLocked} title="Reset board" aria-label="Reset board"><RefreshCcw size={16} /></button>
          </div>
        </header>
        <ActivityBar
          activity={activity}
          busy={activityBusy || mentorRequestBusy}
          onStart={openActivityDialog}
          onProfile={() => setProfileDialogOpen(true)}
          onPause={() => updateActivity((id) => mentorApi.pauseActivity(conversationId, id))}
          onResume={() => updateActivity((id) => mentorApi.resumeActivity(conversationId, id))}
          onHint={() => updateActivity((id) => mentorApi.requestHint(conversationId, id))}
          onEnd={() => updateActivity((id) => mentorApi.endActivity(conversationId, id))}
        />
        <div className="mentor-board-stage">
          <div
            className={`mentor-eval-bar is-${boardState?.orientation || 'white'} ${currentAnalysis ? 'has-analysis' : ''}`}
            title={currentAnalysis ? `Stockfish evaluation ${formatEngineScore(currentAnalysis.score)}` : 'Position not analyzed'}
            aria-label={currentAnalysis ? `Stockfish evaluation ${formatEngineScore(currentAnalysis.score)}` : 'Position not analyzed'}
          >
            <span className="mentor-eval-white" style={{ height: `${evaluationPercent}%` }} />
            <strong>{formatEngineScore(currentAnalysis?.score)}</strong>
          </div>
          <div className="mentor-board-frame">
            <Chessboard options={{
              position: previewFen || boardState?.fen || STANDARD_FEN,
              boardOrientation: boardState?.orientation || 'white',
              animationDurationInMs: 350,
              arrows: annotationArrows,
              squareStyles: annotationSquareStyles,
              allowDrawingArrows: false,
              onPieceDrop: onBoardMove,
              allowDragging: !!boardState && !boardInteractionLocked && !boardState.gameStatus.isGameOver,
              darkSquareStyle: { backgroundColor: '#1e293b' },
              lightSquareStyle: { backgroundColor: '#e2e8f0' }
            }} />
          </div>
        </div>
        <div className="mentor-board-summary">
          <div><span>Turn</span><strong>{boardState?.turnName || 'White'}</strong></div>
          <div><span>Status</span><strong>{live.toolBusy ? live.toolLabel : pendingBoardAction ? 'Saving move...' : activity ? activityPhaseLabel(activity) : boardState?.gameStatus.resultText || 'Ready'}</strong></div>
        </div>
        <div className="mentor-move-list">
          <div className="mentor-move-list-header"><span>MOVE LIST</span><strong>{boardState?.history.length || 0} plies</strong></div>
          <ol>
            {(boardState?.history || []).reduce((rows, move, index) => {
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
      {activityDialogOpen && boardState && (
        <ActivityDialog
          catalog={catalog}
          boardRevision={boardState.revision}
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
