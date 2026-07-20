const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_TITLE = 'New chat';
const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function mapConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessagePreview: row.last_message_preview || '',
    messageCount: Number(row.message_count || 0)
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    requestId: row.request_id,
    role: row.role,
    kind: row.kind,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapChessSession(row) {
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    initialFen: row.initial_fen,
    currentFen: row.current_fen,
    pgn: row.pgn,
    orientation: row.orientation,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapBoardEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: Number(row.sequence),
    type: row.event_type,
    actionId: row.action_id,
    payload: JSON.parse(row.payload_json),
    beforeFen: row.before_fen,
    afterFen: row.after_fen,
    createdAt: row.created_at
  };
}

function mapToolCall(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    requestId: row.request_id,
    assistantMessageId: row.assistant_message_id,
    providerCallId: row.provider_call_id,
    ordinal: Number(row.ordinal),
    name: row.tool_name,
    arguments: JSON.parse(row.arguments_json || '{}'),
    status: row.status,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error_text || null,
    progressCurrent: Number(row.progress_current || 0),
    progressTotal: Number(row.progress_total || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAnnotations(row, revision = 0) {
  if (!row || Number(row.position_revision) !== Number(revision)) {
    return { highlights: [], arrows: [] };
  }
  return {
    highlights: JSON.parse(row.highlights_json || '[]'),
    arrows: JSON.parse(row.arrows_json || '[]')
  };
}

function titleFromMessage(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return DEFAULT_TITLE;
  return normalized.length <= 48
    ? normalized
    : `${normalized.slice(0, 45).trimEnd()}...`;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

class MentorStore {
  constructor(options = {}) {
    this.dbPath = options.dbPath || path.join(__dirname, '..', 'data', 'mentor.sqlite');
    this.now = options.now || Date.now;
    this.createId = options.createId || randomUUID;

    if (this.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (this.dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.migrate();
    this.recoverInterruptedMessages();
    this.recoverInterruptedToolCalls();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mentor_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    const migrations = [{
      version: 1,
      sql: `
        CREATE TABLE mentor_conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE mentor_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES mentor_conversations(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          request_id TEXT,
          role TEXT NOT NULL CHECK(role IN ('user', 'model', 'system')),
          kind TEXT NOT NULL DEFAULT 'text',
          content TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK(status IN ('pending', 'streaming', 'complete', 'failed', 'cancelled')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(conversation_id, sequence),
          UNIQUE(conversation_id, request_id, role)
        );

        CREATE INDEX mentor_messages_conversation_sequence
          ON mentor_messages(conversation_id, sequence);
        CREATE INDEX mentor_conversations_updated
          ON mentor_conversations(updated_at DESC);
      `
    }, {
      version: 2,
      sql: `
        CREATE TABLE mentor_chess_sessions (
          conversation_id TEXT PRIMARY KEY REFERENCES mentor_conversations(id) ON DELETE CASCADE,
          initial_fen TEXT NOT NULL,
          current_fen TEXT NOT NULL,
          pgn TEXT NOT NULL DEFAULT '',
          orientation TEXT NOT NULL DEFAULT 'white' CHECK(orientation IN ('white', 'black')),
          revision INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE mentor_board_events (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES mentor_conversations(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          event_type TEXT NOT NULL CHECK(event_type IN ('move', 'set_position', 'reset', 'orientation')),
          action_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          before_fen TEXT NOT NULL,
          after_fen TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(conversation_id, sequence),
          UNIQUE(conversation_id, action_id)
        );

        CREATE INDEX mentor_board_events_conversation_sequence
          ON mentor_board_events(conversation_id, sequence);

        INSERT INTO mentor_chess_sessions(
          conversation_id, initial_fen, current_fen, pgn, orientation,
          revision, created_at, updated_at
        )
        SELECT id, '${STANDARD_FEN}', '${STANDARD_FEN}', '', 'white', 0, created_at, updated_at
        FROM mentor_conversations;
      `
    }, {
      version: 3,
      sql: `
        CREATE TABLE mentor_tool_calls (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES mentor_conversations(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL,
          assistant_message_id TEXT NOT NULL REFERENCES mentor_messages(id) ON DELETE CASCADE,
          provider_call_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          tool_name TEXT NOT NULL,
          arguments_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'failed', 'cancelled')),
          result_json TEXT,
          error_text TEXT,
          progress_current INTEGER NOT NULL DEFAULT 0,
          progress_total INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(conversation_id, request_id, provider_call_id),
          UNIQUE(assistant_message_id, ordinal)
        );

        CREATE INDEX mentor_tool_calls_conversation_message
          ON mentor_tool_calls(conversation_id, assistant_message_id, ordinal);

        CREATE TABLE mentor_board_annotations (
          conversation_id TEXT PRIMARY KEY REFERENCES mentor_conversations(id) ON DELETE CASCADE,
          position_revision INTEGER NOT NULL,
          highlights_json TEXT NOT NULL DEFAULT '[]',
          arrows_json TEXT NOT NULL DEFAULT '[]',
          updated_at INTEGER NOT NULL
        );
      `
    }];

    const applied = new Set(
      this.db.prepare('SELECT version FROM mentor_migrations').all().map((row) => row.version)
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.exec(migration.sql);
        this.db.prepare(
          'INSERT INTO mentor_migrations(version, applied_at) VALUES (?, ?)'
        ).run(migration.version, this.now());
        this.db.exec('COMMIT;');
      } catch (error) {
        this.db.exec('ROLLBACK;');
        throw error;
      }
    }
  }

  recoverInterruptedMessages() {
    const timestamp = this.now();
    return this.db.prepare(`
      UPDATE mentor_messages
      SET status = 'failed', updated_at = ?
      WHERE role = 'model' AND status IN ('pending', 'streaming')
    `).run(timestamp).changes;
  }

  recoverInterruptedToolCalls() {
    const timestamp = this.now();
    return this.db.prepare(`
      UPDATE mentor_tool_calls
      SET status = 'failed',
          error_text = 'Tool execution was interrupted by a backend restart.',
          updated_at = ?
      WHERE status IN ('pending', 'running')
    `).run(timestamp).changes;
  }

  createConversation({ title = DEFAULT_TITLE } = {}) {
    const timestamp = this.now();
    const conversation = {
      id: this.createId(),
      title: String(title || DEFAULT_TITLE).trim().slice(0, 80) || DEFAULT_TITLE,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastMessagePreview: '',
      messageCount: 0
    };
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`
        INSERT INTO mentor_conversations(id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(conversation.id, conversation.title, timestamp, timestamp);
      this.db.prepare(`
        INSERT INTO mentor_chess_sessions(
          conversation_id, initial_fen, current_fen, pgn, orientation,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, '', 'white', 0, ?, ?)
      `).run(conversation.id, STANDARD_FEN, STANDARD_FEN, timestamp, timestamp);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return conversation;
  }

  listConversations({ query = '', limit = 100 } = {}) {
    const normalizedQuery = String(query || '').trim();
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const pattern = `%${escapeLike(normalizedQuery)}%`;
    return this.db.prepare(`
      SELECT
        c.*,
        COALESCE((
          SELECT substr(m.content, 1, 120)
          FROM mentor_messages m
          WHERE m.conversation_id = c.id AND m.content <> ''
          ORDER BY m.sequence DESC
          LIMIT 1
        ), '') AS last_message_preview,
        (SELECT count(*) FROM mentor_messages m WHERE m.conversation_id = c.id) AS message_count
      FROM mentor_conversations c
      WHERE (? = '' OR c.title LIKE ? ESCAPE '\\' COLLATE NOCASE)
      ORDER BY c.updated_at DESC, c.id ASC
      LIMIT ?
    `).all(normalizedQuery, pattern, safeLimit).map(mapConversation);
  }

  getConversation(id) {
    const row = this.db.prepare(`
      SELECT
        c.*,
        COALESCE((
          SELECT substr(m.content, 1, 120)
          FROM mentor_messages m
          WHERE m.conversation_id = c.id AND m.content <> ''
          ORDER BY m.sequence DESC LIMIT 1
        ), '') AS last_message_preview,
        (SELECT count(*) FROM mentor_messages m WHERE m.conversation_id = c.id) AS message_count
      FROM mentor_conversations c
      WHERE c.id = ?
    `).get(id);
    if (!row) return null;
    return {
      ...mapConversation(row),
      messages: this.listMessages(id)
    };
  }

  updateConversation(id, { title }) {
    const normalized = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!normalized) return null;
    const result = this.db.prepare(`
      UPDATE mentor_conversations SET title = ?, updated_at = ? WHERE id = ?
    `).run(normalized, this.now(), id);
    return result.changes ? this.getConversation(id) : null;
  }

  deleteConversation(id) {
    return this.db.prepare('DELETE FROM mentor_conversations WHERE id = ?').run(id).changes > 0;
  }

  listMessages(conversationId) {
    return this.db.prepare(`
      SELECT * FROM mentor_messages
      WHERE conversation_id = ?
      ORDER BY sequence ASC
    `).all(conversationId).map(mapMessage);
  }

  getMessage(id) {
    return mapMessage(this.db.prepare('SELECT * FROM mentor_messages WHERE id = ?').get(id));
  }

  getRequestMessages(conversationId, requestId) {
    return this.db.prepare(`
      SELECT * FROM mentor_messages
      WHERE conversation_id = ? AND request_id = ?
      ORDER BY sequence ASC
    `).all(conversationId, requestId).map(mapMessage);
  }

  getMessageByRequestRole(conversationId, requestId, role) {
    return mapMessage(this.db.prepare(`
      SELECT * FROM mentor_messages
      WHERE conversation_id = ? AND request_id = ? AND role = ?
    `).get(conversationId, requestId, role));
  }

  createMessagePair(conversationId, {
    requestId,
    text,
    kind = 'text',
    assistantContent = '',
    assistantStatus = 'pending'
  }) {
    const existing = this.getRequestMessages(conversationId, requestId);
    if (existing.length) {
      return {
        duplicate: true,
        userMessage: existing.find((message) => message.role === 'user') || null,
        assistantMessage: existing.find((message) => message.role === 'model') || null
      };
    }

    const conversation = this.getConversation(conversationId);
    if (!conversation) return null;
    if (!['text', 'voice'].includes(kind)) {
      throw new Error(`Unsupported mentor message kind: ${kind}`);
    }
    if (!['pending', 'streaming', 'complete', 'failed', 'cancelled'].includes(assistantStatus)) {
      throw new Error(`Unsupported assistant message status: ${assistantStatus}`);
    }

    const timestamp = this.now();
    const userId = this.createId();
    const assistantId = this.createId();
    const nextSequence = Number(this.db.prepare(`
      SELECT COALESCE(max(sequence), 0) + 1 AS next_sequence
      FROM mentor_messages WHERE conversation_id = ?
    `).get(conversationId).next_sequence);

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const insert = this.db.prepare(`
        INSERT INTO mentor_messages(
          id, conversation_id, sequence, request_id, role, kind,
          content, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        userId, conversationId, nextSequence, requestId,
        'user', kind, text, 'complete', timestamp, timestamp
      );
      insert.run(
        assistantId, conversationId, nextSequence + 1, requestId,
        'model', kind, assistantContent, assistantStatus, timestamp, timestamp
      );
      const nextTitle = conversation.messageCount === 0 && conversation.title === DEFAULT_TITLE
        ? titleFromMessage(text)
        : conversation.title;
      this.db.prepare(`
        UPDATE mentor_conversations SET title = ?, updated_at = ? WHERE id = ?
      `).run(nextTitle, timestamp, conversationId);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }

    return {
      duplicate: false,
      userMessage: this.getMessage(userId),
      assistantMessage: this.getMessage(assistantId)
    };
  }

  appendMessageContent(id, delta) {
    const timestamp = this.now();
    this.db.prepare(`
      UPDATE mentor_messages
      SET content = content || ?, status = 'streaming', updated_at = ?
      WHERE id = ? AND status IN ('pending', 'streaming')
    `).run(delta, timestamp, id);
    return this.getMessage(id);
  }

  replaceMessageContent(id, content) {
    const timestamp = this.now();
    this.db.prepare(`
      UPDATE mentor_messages
      SET content = ?, updated_at = ?
      WHERE id = ?
    `).run(String(content || ''), timestamp, id);
    return this.getMessage(id);
  }

  setMessageStatus(id, status) {
    const allowed = new Set(['pending', 'streaming', 'complete', 'failed', 'cancelled']);
    if (!allowed.has(status)) throw new Error(`Unsupported message status: ${status}`);
    this.db.prepare(`
      UPDATE mentor_messages SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, this.now(), id);
    return this.getMessage(id);
  }

  createToolCall({
    conversationId,
    requestId,
    assistantMessageId,
    providerCallId,
    ordinal,
    name,
    arguments: args = {},
    progressTotal = 0
  }) {
    const existing = this.getToolCallByProvider(conversationId, requestId, providerCallId);
    if (existing) return { duplicate: true, toolCall: existing };
    const id = this.createId();
    const timestamp = this.now();
    this.db.prepare(`
      INSERT INTO mentor_tool_calls(
        id, conversation_id, request_id, assistant_message_id, provider_call_id,
        ordinal, tool_name, arguments_json, status, progress_total, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      id,
      conversationId,
      requestId,
      assistantMessageId,
      providerCallId,
      ordinal,
      name,
      JSON.stringify(args || {}),
      progressTotal,
      timestamp,
      timestamp
    );
    return { duplicate: false, toolCall: this.getToolCall(id) };
  }

  getToolCall(id) {
    return mapToolCall(this.db.prepare('SELECT * FROM mentor_tool_calls WHERE id = ?').get(id));
  }

  getToolCallByProvider(conversationId, requestId, providerCallId) {
    return mapToolCall(this.db.prepare(`
      SELECT * FROM mentor_tool_calls
      WHERE conversation_id = ? AND request_id = ? AND provider_call_id = ?
    `).get(conversationId, requestId, providerCallId));
  }

  listToolCalls(conversationId) {
    return this.db.prepare(`
      SELECT * FROM mentor_tool_calls
      WHERE conversation_id = ?
      ORDER BY created_at ASC, ordinal ASC
    `).all(conversationId).map(mapToolCall);
  }

  updateToolCall(id, patch = {}) {
    const current = this.getToolCall(id);
    if (!current) return null;
    const allowed = new Set(['pending', 'running', 'complete', 'failed', 'cancelled']);
    const status = patch.status || current.status;
    if (!allowed.has(status)) throw new Error(`Unsupported tool status: ${status}`);
    const result = Object.prototype.hasOwnProperty.call(patch, 'result') ? patch.result : current.result;
    const error = Object.prototype.hasOwnProperty.call(patch, 'error') ? patch.error : current.error;
    const progressCurrent = Number.isInteger(patch.progressCurrent)
      ? patch.progressCurrent
      : current.progressCurrent;
    const progressTotal = Number.isInteger(patch.progressTotal)
      ? patch.progressTotal
      : current.progressTotal;
    this.db.prepare(`
      UPDATE mentor_tool_calls
      SET status = ?, result_json = ?, error_text = ?, progress_current = ?,
          progress_total = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      result === null ? null : JSON.stringify(result),
      error || null,
      progressCurrent,
      progressTotal,
      this.now(),
      id
    );
    return this.getToolCall(id);
  }

  getBoardAnnotations(conversationId, revision) {
    const row = this.db.prepare(`
      SELECT * FROM mentor_board_annotations WHERE conversation_id = ?
    `).get(conversationId);
    return mapAnnotations(row, revision);
  }

  setBoardAnnotations(conversationId, { expectedRevision, highlights, arrows }) {
    const current = this.getChessSession(conversationId);
    if (!current) return { status: 'not_found' };
    if (current.revision !== expectedRevision) return { status: 'stale', session: current };
    this.db.prepare(`
      INSERT INTO mentor_board_annotations(
        conversation_id, position_revision, highlights_json, arrows_json, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        position_revision = excluded.position_revision,
        highlights_json = excluded.highlights_json,
        arrows_json = excluded.arrows_json,
        updated_at = excluded.updated_at
    `).run(
      conversationId,
      expectedRevision,
      JSON.stringify(highlights),
      JSON.stringify(arrows),
      this.now()
    );
    return { status: 'committed' };
  }

  touchConversation(conversationId) {
    this.db.prepare(`
      UPDATE mentor_conversations SET updated_at = ? WHERE id = ?
    `).run(this.now(), conversationId);
    return this.getConversation(conversationId);
  }

  contextMessages(conversationId, maximumCharacters = 24000) {
    const messages = this.db.prepare(`
      SELECT role, content
      FROM mentor_messages
      WHERE conversation_id = ? AND status = 'complete' AND content <> ''
      ORDER BY sequence DESC
    `).all(conversationId);

    const selected = [];
    let characters = 0;
    for (const message of messages) {
      const remaining = maximumCharacters - characters;
      if (remaining <= 0) break;
      const content = message.content.length > remaining
        ? message.content.slice(-remaining)
        : message.content;
      selected.push({ role: message.role, content });
      characters += content.length;
      if (content.length < message.content.length) break;
    }
    return selected.reverse();
  }

  getChessSession(conversationId) {
    return mapChessSession(this.db.prepare(`
      SELECT * FROM mentor_chess_sessions WHERE conversation_id = ?
    `).get(conversationId));
  }

  listBoardEvents(conversationId) {
    return this.db.prepare(`
      SELECT * FROM mentor_board_events
      WHERE conversation_id = ?
      ORDER BY sequence ASC
    `).all(conversationId).map(mapBoardEvent);
  }

  getBoardEventByAction(conversationId, actionId) {
    return mapBoardEvent(this.db.prepare(`
      SELECT * FROM mentor_board_events
      WHERE conversation_id = ? AND action_id = ?
    `).get(conversationId, actionId));
  }

  commitBoardMutation({
    conversationId,
    expectedRevision,
    eventType,
    actionId,
    payload,
    beforeFen,
    afterFen,
    pgn,
    orientation,
    initialFen
  }) {
    const duplicateEvent = this.getBoardEventByAction(conversationId, actionId);
    if (duplicateEvent) {
      return {
        status: 'duplicate',
        event: duplicateEvent,
        session: this.getChessSession(conversationId)
      };
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const current = this.getChessSession(conversationId);
      if (!current) {
        this.db.exec('ROLLBACK;');
        return { status: 'not_found' };
      }
      if (current.revision !== expectedRevision) {
        this.db.exec('ROLLBACK;');
        return { status: 'stale', session: current };
      }

      const timestamp = this.now();
      const nextSequence = Number(this.db.prepare(`
        SELECT COALESCE(max(sequence), 0) + 1 AS next_sequence
        FROM mentor_board_events WHERE conversation_id = ?
      `).get(conversationId).next_sequence);
      const eventId = this.createId();
      this.db.prepare(`
        INSERT INTO mentor_board_events(
          id, conversation_id, sequence, event_type, action_id,
          payload_json, before_fen, after_fen, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        conversationId,
        nextSequence,
        eventType,
        actionId,
        JSON.stringify(payload || {}),
        beforeFen,
        afterFen,
        timestamp
      );
      this.db.prepare(`
        UPDATE mentor_chess_sessions
        SET initial_fen = ?, current_fen = ?, pgn = ?, orientation = ?,
            revision = revision + 1, updated_at = ?
        WHERE conversation_id = ?
      `).run(
        initialFen || current.initialFen,
        afterFen,
        pgn,
        orientation || current.orientation,
        timestamp,
        conversationId
      );
      if (eventType === 'orientation') {
        this.db.prepare(`
          UPDATE mentor_board_annotations
          SET position_revision = ?, updated_at = ?
          WHERE conversation_id = ? AND position_revision = ?
        `).run(expectedRevision + 1, timestamp, conversationId, expectedRevision);
      } else {
        this.db.prepare(`
          DELETE FROM mentor_board_annotations WHERE conversation_id = ?
        `).run(conversationId);
      }
      this.db.prepare(`
        UPDATE mentor_conversations SET updated_at = ? WHERE id = ?
      `).run(timestamp, conversationId);
      this.db.exec('COMMIT;');
      return {
        status: 'committed',
        event: mapBoardEvent(this.db.prepare(
          'SELECT * FROM mentor_board_events WHERE id = ?'
        ).get(eventId)),
        session: this.getChessSession(conversationId)
      };
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = {
  DEFAULT_TITLE,
  MentorStore,
  STANDARD_FEN,
  titleFromMessage
};
