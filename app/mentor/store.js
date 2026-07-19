const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_TITLE = 'New chat';

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
    this.db.prepare(`
      INSERT INTO mentor_conversations(id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(conversation.id, conversation.title, timestamp, timestamp);
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

  createMessagePair(conversationId, { requestId, text }) {
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
        ) VALUES (?, ?, ?, ?, ?, 'text', ?, ?, ?, ?)
      `);
      insert.run(
        userId, conversationId, nextSequence, requestId,
        'user', text, 'complete', timestamp, timestamp
      );
      insert.run(
        assistantId, conversationId, nextSequence + 1, requestId,
        'model', '', 'pending', timestamp, timestamp
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

  setMessageStatus(id, status) {
    const allowed = new Set(['pending', 'streaming', 'complete', 'failed', 'cancelled']);
    if (!allowed.has(status)) throw new Error(`Unsupported message status: ${status}`);
    this.db.prepare(`
      UPDATE mentor_messages SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, this.now(), id);
    return this.getMessage(id);
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

  close() {
    this.db.close();
  }
}

module.exports = {
  DEFAULT_TITLE,
  MentorStore,
  titleFromMessage
};
