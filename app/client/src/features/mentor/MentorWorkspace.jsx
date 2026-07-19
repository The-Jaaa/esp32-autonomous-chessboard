import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Chessboard } from 'react-chessboard';
import {
  ArrowUp,
  Bot,
  Check,
  ChevronLeft,
  Ellipsis,
  Mic,
  Pencil,
  Plus,
  Search,
  Square,
  Trash2,
  X
} from 'lucide-react';
import { useSocket } from '../../context/useSocket';
import { mentorApi } from './mentor-api';
import './mentor.css';

const SUGGESTIONS = [
  { title: 'Analyze a game', prompt: 'Help me analyze a recent game and identify the decisions I should learn from.' },
  { title: 'Learn an opening', prompt: 'Teach me an opening step by step, including its plans and common mistakes.' },
  { title: 'Solve a puzzle', prompt: 'Give me a tactical puzzle appropriate for an improving club player.' },
  { title: 'Practice a position', prompt: 'Set up a useful practice position and coach me through the ideas.' }
];

function upsertMessage(messages, nextMessage) {
  if (!nextMessage) return messages;
  const index = messages.findIndex((message) => message.id === nextMessage.id);
  if (index < 0) return [...messages, nextMessage].sort((a, b) => a.sequence - b.sequence);
  const copy = [...messages];
  copy[index] = { ...copy[index], ...nextMessage };
  return copy;
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

function Message({ message }) {
  const isUser = message.role === 'user';
  return (
    <article className={`mentor-message ${isUser ? 'is-user' : 'is-model'}`}>
      {!isUser && <div className="mentor-message-avatar"><Bot size={18} /></div>}
      <div className="mentor-message-content">
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
  const [loading, setLoading] = useState(true);
  const messageEndRef = useRef(null);

  const refreshList = useCallback(async (search = '') => {
    const result = await mentorApi.listConversations(search);
    setConversations(result.conversations);
    return result.conversations;
  }, []);

  const createConversation = useCallback(async () => {
    const result = await mentorApi.createConversation();
    await refreshList('');
    navigate(`/mentor-v2/${result.conversation.id}`);
    return result.conversation;
  }, [navigate, refreshList]);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      try {
        const list = await refreshList('');
        if (cancelled) return;
        if (!conversationId) {
          if (list.length) navigate(`/mentor-v2/${list[0].id}`, { replace: true });
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
    setLoading(true);
    mentorApi.getConversation(conversationId)
      .then(({ conversation: nextConversation }) => {
        if (cancelled) return;
        setConversation(nextConversation);
        setMessages(nextConversation.messages || []);
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
    socket.emit('mentor-subscribe', { conversationId });

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
      setMessages((current) => upsertMessage(current, payload.message));
      setActiveRequestId(null);
      if (payload.error) setError(payload.error);
      refreshList('');
    };

    socket.on('mentor-message-start', onStart);
    socket.on('mentor-message-delta', onDelta);
    socket.on('mentor-message-complete', onTerminal);
    socket.on('mentor-message-cancelled', onTerminal);
    socket.on('mentor-message-failed', onTerminal);
    return () => {
      socket.emit('mentor-unsubscribe', { conversationId });
      socket.off('mentor-message-start', onStart);
      socket.off('mentor-message-delta', onDelta);
      socket.off('mentor-message-complete', onTerminal);
      socket.off('mentor-message-cancelled', onTerminal);
      socket.off('mentor-message-failed', onTerminal);
    };
  }, [conversationId, refreshList, socket]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      refreshList(query).catch((searchError) => setError(searchError.message));
    }, 180);
    return () => clearTimeout(timeout);
  }, [query, refreshList]);

  const sendMessage = async (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed || !conversationId || activeRequestId) return;
    const requestId = crypto.randomUUID();
    setDraft('');
    setError('');
    setActiveRequestId(requestId);
    try {
      const result = await mentorApi.sendMessage(conversationId, requestId, trimmed);
      setMessages((current) => {
        let next = upsertMessage(current, result.userMessage);
        next = upsertMessage(next, result.assistantMessage);
        return next;
      });
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
        if (list.length) navigate(`/mentor-v2/${list[0].id}`);
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

  const grouped = useMemo(() => groupConversations(conversations), [conversations]);

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
                  onOpen={(id) => navigate(`/mentor-v2/${id}`)}
                  onRename={renameConversation}
                  onDelete={deleteConversation}
                />
              ))}
            </section>
          ))}
        </nav>
        <div className="mentor-sidebar-footer">
          <Link to="/"><ChevronLeft size={17} /> Companion board</Link>
          <Link to="/mentor"><Mic size={17} /> Live voice mentor</Link>
        </div>
      </aside>

      <section className="mentor-conversation">
        <header className="mentor-conversation-header">
          <div><span>MENTOR</span><h1>{conversation?.title || 'New chat'}</h1></div>
          <span className="mentor-model-label">Gemini 3.5 Flash</span>
        </header>
        <div className="mentor-message-scroll">
          {!loading && messages.length === 0 ? (
            <div className="mentor-empty-state">
              <div className="mentor-empty-mark"><Bot size={28} /></div>
              <h2>What would you like to work on?</h2>
              <p>Choose a starting point or ask your own chess question.</p>
              <div className="mentor-suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion.title} onClick={() => sendMessage(suggestion.prompt)}>
                    <strong>{suggestion.title}</strong>
                    <span>{suggestion.prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : messages.map((message) => <Message key={message.id} message={message} />)}
          <div ref={messageEndRef} />
        </div>
        <div className="mentor-composer-wrap">
          {error && <div className="mentor-error"><span>{error}</span><button onClick={() => setError('')} title="Dismiss error"><X size={15} /></button></div>}
          <div className="mentor-composer">
            <textarea
              value={draft}
              placeholder="Ask your chess mentor"
              rows={1}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
            />
            {activeRequestId ? (
              <button className="mentor-send-button" onClick={stopStreaming} title="Stop response" aria-label="Stop response"><Square size={15} fill="currentColor" /></button>
            ) : (
              <button className="mentor-send-button" onClick={() => sendMessage()} disabled={!draft.trim()} title="Send message" aria-label="Send message"><ArrowUp size={19} /></button>
            )}
          </div>
          <p>Mentor responses can be inaccurate. Verify critical analysis on the board.</p>
        </div>
      </section>

      <aside className="mentor-board-panel">
        <header><div><span>WORKSPACE</span><h2>Position board</h2></div><span className="mentor-board-badge">Preview</span></header>
        <div className="mentor-board-frame">
          <Chessboard options={{
            position: 'start',
            allowDragging: false,
            darkSquareStyle: { backgroundColor: '#63714f' },
            lightSquareStyle: { backgroundColor: '#e5e1d5' }
          }} />
        </div>
        <div className="mentor-board-summary">
          <div><span>Turn</span><strong>White</strong></div>
          <div><span>Status</span><strong>Ready</strong></div>
        </div>
        <div className="mentor-board-note">
          <Bot size={18} />
          <p>The board becomes interactive in the next foundation milestone.</p>
        </div>
      </aside>
    </main>
  );
}
