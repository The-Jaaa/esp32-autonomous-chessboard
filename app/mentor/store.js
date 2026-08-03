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

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapActivity(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    type: row.activity_type,
    status: row.status,
    phase: row.phase,
    title: row.title,
    goal: row.goal || '',
    learnerColor: row.learner_color,
    mentorColor: row.mentor_color,
    sourceId: row.source_id || null,
    startFen: row.start_fen,
    startRevision: Number(row.start_revision),
    boardRevision: Number(row.board_revision),
    stepIndex: Number(row.step_index),
    totalSteps: Number(row.total_steps),
    attempts: Number(row.attempts),
    hints: Number(row.hints),
    generation: Number(row.generation),
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: row.lease_expires_at || null,
    pendingRequestId: row.pending_request_id || null,
    predictionPrompt: row.prediction_prompt || null,
    config: parseJson(row.config_json),
    state: parseJson(row.state_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null
  };
}

function mapActivityEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    activityId: row.activity_id,
    conversationId: row.conversation_id,
    sequence: Number(row.sequence),
    type: row.event_type,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at
  };
}

function mapLearnerProfile(row) {
  if (!row) return null;
  return {
    skillBand: row.skill_band,
    goals: parseJson(row.goals_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapTopicProgress(row) {
  if (!row) return null;
  return {
    topic: row.topic,
    mastery: Number(row.mastery),
    completions: Number(row.completions),
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

function mapPhysicalBinding(row) {
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    boardId: row.board_id,
    serverInstanceId: row.server_instance_id,
    sessionGeneration: Number(row.session_generation),
    stateRevision: Number(row.state_revision || 0),
    status: row.status,
    orientation: row.orientation,
    annotatedFen: row.annotated_fen || null,
    analyzedFen: row.analyzed_fen || null,
    annotations: {
      highlights: parseJson(row.highlights_json, []),
      arrows: parseJson(row.arrows_json, [])
    },
    lastEventKey: row.last_event_key || null,
    coachingMode: row.coaching_mode || 'off',
    coachingOrigin: row.coaching_origin || null,
    coachingPromptedAt: row.coaching_prompted_at || null,
    lastCoachedRevision: row.last_coached_revision === null || row.last_coached_revision === undefined
      ? null
      : Number(row.last_coached_revision),
    lastCoachedMoveId: row.last_coached_move_id || null,
    fullTurnsSinceSummary: Number(row.full_turns_since_summary || 0),
    lastCoachingTrigger: row.last_coaching_trigger || null,
    lastCoachingFen: row.last_coaching_fen || null,
    lastObservedRobotMoveId: row.last_observed_robot_move_id || null,
    adviceFingerprints: parseJson(row.advice_fingerprints_json, []),
    attachedAt: row.attached_at,
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
    this.recoverInterruptedToolCalls();
    this.recoverInterruptedActivities();
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
    }, {
      version: 4,
      sql: `
        CREATE TABLE mentor_activities (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES mentor_conversations(id) ON DELETE CASCADE,
          activity_type TEXT NOT NULL CHECK(activity_type IN ('practice_game', 'opening_drill', 'puzzle', 'guided_lesson')),
          status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'complete', 'cancelled')),
          phase TEXT NOT NULL CHECK(phase IN ('learner_turn', 'mentor_turn', 'mentor_thinking', 'awaiting_prediction', 'paused', 'complete', 'game_over')),
          title TEXT NOT NULL,
          goal TEXT NOT NULL DEFAULT '',
          learner_color TEXT NOT NULL CHECK(learner_color IN ('white', 'black')),
          mentor_color TEXT NOT NULL CHECK(mentor_color IN ('white', 'black')),
          source_id TEXT,
          start_fen TEXT NOT NULL,
          start_revision INTEGER NOT NULL,
          board_revision INTEGER NOT NULL,
          step_index INTEGER NOT NULL DEFAULT 0,
          total_steps INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          hints INTEGER NOT NULL DEFAULT 0,
          generation INTEGER NOT NULL DEFAULT 1,
          pending_request_id TEXT,
          prediction_prompt TEXT,
          config_json TEXT NOT NULL DEFAULT '{}',
          state_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER
        );

        CREATE UNIQUE INDEX mentor_activities_one_active
          ON mentor_activities(conversation_id)
          WHERE status IN ('active', 'paused');

        CREATE INDEX mentor_activities_conversation_updated
          ON mentor_activities(conversation_id, updated_at DESC);

        CREATE TABLE mentor_activity_events (
          id TEXT PRIMARY KEY,
          activity_id TEXT NOT NULL REFERENCES mentor_activities(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES mentor_conversations(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          UNIQUE(activity_id, sequence)
        );

        CREATE INDEX mentor_activity_events_activity_sequence
          ON mentor_activity_events(activity_id, sequence);
      `
    }, {
      version: 5,
      sql: `
        ALTER TABLE mentor_activities ADD COLUMN lease_owner TEXT;
        ALTER TABLE mentor_activities ADD COLUMN lease_expires_at INTEGER;

        CREATE INDEX mentor_activities_lease
          ON mentor_activities(status, phase, lease_expires_at);
      `
    }, {
      version: 6,
      sql: `
        CREATE TABLE mentor_learner_profile (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          skill_band TEXT NOT NULL CHECK(skill_band IN ('Beginner', 'Intermediate', 'Advanced')),
          goals_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE mentor_topic_progress (
          topic TEXT PRIMARY KEY,
          mastery INTEGER NOT NULL DEFAULT 0 CHECK(mastery BETWEEN 0 AND 100),
          completions INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE mentor_progress_awards (
          activity_id TEXT PRIMARY KEY REFERENCES mentor_activities(id) ON DELETE CASCADE,
          points INTEGER NOT NULL,
          topics_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        INSERT INTO mentor_learner_profile(id, skill_band, goals_json, created_at, updated_at)
        VALUES (1, 'Beginner', '[]', ${this.now()}, ${this.now()});
      `
    }, {
      version: 7,
      sql: `
        CREATE TABLE mentor_physical_bindings (
          conversation_id TEXT PRIMARY KEY REFERENCES mentor_conversations(id) ON DELETE CASCADE,
          board_id TEXT NOT NULL DEFAULT 'main-board',
          server_instance_id TEXT NOT NULL,
          session_generation INTEGER NOT NULL,
          state_revision INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK(status IN ('active', 'stale', 'detached')),
          orientation TEXT NOT NULL DEFAULT 'white' CHECK(orientation IN ('white', 'black')),
          annotated_fen TEXT,
          highlights_json TEXT NOT NULL DEFAULT '[]',
          arrows_json TEXT NOT NULL DEFAULT '[]',
          last_event_key TEXT,
          attached_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX mentor_physical_bindings_one_active_board
          ON mentor_physical_bindings(board_id)
          WHERE status = 'active';
      `
    }, {
      version: 8,
      sql: `
        ALTER TABLE mentor_physical_bindings ADD COLUMN analyzed_fen TEXT;
      `
    }, {
      version: 9,
      sql: `
        ALTER TABLE mentor_physical_bindings ADD COLUMN coaching_mode TEXT NOT NULL DEFAULT 'off'
          CHECK(coaching_mode IN ('off', 'prompt_pending', 'selective'));
        ALTER TABLE mentor_physical_bindings ADD COLUMN coaching_origin TEXT;
        ALTER TABLE mentor_physical_bindings ADD COLUMN coaching_prompted_at INTEGER;
        ALTER TABLE mentor_physical_bindings ADD COLUMN last_coached_revision INTEGER;
        ALTER TABLE mentor_physical_bindings ADD COLUMN last_coached_move_id TEXT;
        ALTER TABLE mentor_physical_bindings ADD COLUMN full_turns_since_summary INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE mentor_physical_bindings ADD COLUMN last_coaching_trigger TEXT;
        ALTER TABLE mentor_physical_bindings ADD COLUMN last_coaching_fen TEXT;
        ALTER TABLE mentor_physical_bindings ADD COLUMN last_observed_robot_move_id TEXT;
        ALTER TABLE mentor_physical_bindings ADD COLUMN advice_fingerprints_json TEXT NOT NULL DEFAULT '[]';

        CREATE TABLE mentor_physical_actions (
          conversation_id TEXT NOT NULL REFERENCES mentor_conversations(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL,
          action_type TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('complete', 'failed')),
          result_json TEXT,
          error_code TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(conversation_id, request_id)
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

  recoverInterruptedActivities() {
    const timestamp = this.now();
    return this.db.prepare(`
      UPDATE mentor_activities
      SET phase = 'mentor_turn', pending_request_id = NULL,
          generation = generation + 1, lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE status = 'active' AND phase = 'mentor_thinking'
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
    assistantStatus = 'pending',
    suppressTitle = false
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
    if (!['text', 'voice', 'activity', 'physical'].includes(kind)) {
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
      const nextTitle = !suppressTitle && conversation.messageCount === 0 && conversation.title === DEFAULT_TITLE
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

  listToolCallsForRequest(conversationId, requestId) {
    return this.db.prepare(`
      SELECT * FROM mentor_tool_calls
      WHERE conversation_id = ? AND request_id = ?
      ORDER BY ordinal ASC, created_at ASC
    `).all(conversationId, requestId).map(mapToolCall);
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

  getPhysicalBinding(conversationId) {
    return mapPhysicalBinding(this.db.prepare(`
      SELECT * FROM mentor_physical_bindings WHERE conversation_id = ?
    `).get(conversationId));
  }

  getActivePhysicalBinding(boardId = 'main-board') {
    return mapPhysicalBinding(this.db.prepare(`
      SELECT * FROM mentor_physical_bindings
      WHERE board_id = ? AND status = 'active'
    `).get(boardId));
  }

  attachPhysicalBinding(conversationId, {
    boardId = 'main-board',
    serverInstanceId,
    sessionGeneration,
    stateRevision = 0,
    orientation = 'white',
    coachingMode = 'prompt_pending',
    coachingOrigin = 'manual'
  }) {
    const existing = this.getActivePhysicalBinding(boardId);
    if (existing && existing.conversationId !== conversationId) {
      return { status: 'conflict', binding: existing };
    }
    const timestamp = this.now();
    this.db.prepare(`
      INSERT INTO mentor_physical_bindings(
        conversation_id, board_id, server_instance_id, session_generation,
        state_revision, status, orientation, annotated_fen, analyzed_fen,
        highlights_json, arrows_json, last_event_key, coaching_mode, coaching_origin,
        coaching_prompted_at, last_coached_revision, last_coached_move_id,
        full_turns_since_summary, last_coaching_trigger, last_coaching_fen,
        last_observed_robot_move_id, advice_fingerprints_json, attached_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, NULL, '[]', '[]', NULL, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL, '[]', ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        board_id = excluded.board_id,
        server_instance_id = excluded.server_instance_id,
        session_generation = excluded.session_generation,
        state_revision = excluded.state_revision,
        status = 'active',
        orientation = excluded.orientation,
        annotated_fen = NULL,
        analyzed_fen = NULL,
        highlights_json = '[]',
        arrows_json = '[]',
        last_event_key = NULL,
        coaching_mode = excluded.coaching_mode,
        coaching_origin = excluded.coaching_origin,
        coaching_prompted_at = NULL,
        last_coached_revision = NULL,
        last_coached_move_id = NULL,
        full_turns_since_summary = 0,
        last_coaching_trigger = NULL,
        last_coaching_fen = NULL,
        last_observed_robot_move_id = NULL,
        advice_fingerprints_json = '[]',
        attached_at = excluded.attached_at,
        updated_at = excluded.updated_at
    `).run(
      conversationId,
      boardId,
      serverInstanceId,
      sessionGeneration,
      stateRevision,
      orientation,
      coachingMode,
      coachingOrigin,
      timestamp,
      timestamp
    );
    return { status: 'active', binding: this.getPhysicalBinding(conversationId) };
  }

  updatePhysicalBinding(conversationId, patch = {}) {
    const current = this.getPhysicalBinding(conversationId);
    if (!current) return null;
    const next = {
      stateRevision: Number.isInteger(patch.stateRevision) ? patch.stateRevision : current.stateRevision,
      status: patch.status || current.status,
      orientation: patch.orientation || current.orientation,
      annotatedFen: Object.prototype.hasOwnProperty.call(patch, 'annotatedFen')
        ? patch.annotatedFen
        : current.annotatedFen,
      analyzedFen: Object.prototype.hasOwnProperty.call(patch, 'analyzedFen')
        ? patch.analyzedFen
        : current.analyzedFen,
      annotations: patch.annotations || current.annotations,
      lastEventKey: Object.prototype.hasOwnProperty.call(patch, 'lastEventKey')
        ? patch.lastEventKey
        : current.lastEventKey,
      coachingMode: patch.coachingMode || current.coachingMode,
      coachingOrigin: Object.prototype.hasOwnProperty.call(patch, 'coachingOrigin')
        ? patch.coachingOrigin
        : current.coachingOrigin,
      coachingPromptedAt: Object.prototype.hasOwnProperty.call(patch, 'coachingPromptedAt')
        ? patch.coachingPromptedAt
        : current.coachingPromptedAt,
      lastCoachedRevision: Object.prototype.hasOwnProperty.call(patch, 'lastCoachedRevision')
        ? patch.lastCoachedRevision
        : current.lastCoachedRevision,
      lastCoachedMoveId: Object.prototype.hasOwnProperty.call(patch, 'lastCoachedMoveId')
        ? patch.lastCoachedMoveId
        : current.lastCoachedMoveId,
      fullTurnsSinceSummary: Number.isInteger(patch.fullTurnsSinceSummary)
        ? patch.fullTurnsSinceSummary
        : current.fullTurnsSinceSummary,
      lastCoachingTrigger: Object.prototype.hasOwnProperty.call(patch, 'lastCoachingTrigger')
        ? patch.lastCoachingTrigger
        : current.lastCoachingTrigger,
      lastCoachingFen: Object.prototype.hasOwnProperty.call(patch, 'lastCoachingFen')
        ? patch.lastCoachingFen
        : current.lastCoachingFen,
      lastObservedRobotMoveId: Object.prototype.hasOwnProperty.call(patch, 'lastObservedRobotMoveId')
        ? patch.lastObservedRobotMoveId
        : current.lastObservedRobotMoveId,
      adviceFingerprints: Array.isArray(patch.adviceFingerprints)
        ? patch.adviceFingerprints
        : current.adviceFingerprints
    };
    this.db.prepare(`
      UPDATE mentor_physical_bindings
      SET state_revision = ?, status = ?, orientation = ?, annotated_fen = ?, analyzed_fen = ?,
          highlights_json = ?, arrows_json = ?, last_event_key = ?, coaching_mode = ?,
          coaching_origin = ?, coaching_prompted_at = ?, last_coached_revision = ?,
          last_coached_move_id = ?, full_turns_since_summary = ?, last_coaching_trigger = ?,
          last_coaching_fen = ?, last_observed_robot_move_id = ?, advice_fingerprints_json = ?,
          updated_at = ?
      WHERE conversation_id = ?
    `).run(
      next.stateRevision,
      next.status,
      next.orientation,
      next.annotatedFen,
      next.analyzedFen,
      JSON.stringify(next.annotations.highlights || []),
      JSON.stringify(next.annotations.arrows || []),
      next.lastEventKey,
      next.coachingMode,
      next.coachingOrigin,
      next.coachingPromptedAt,
      next.lastCoachedRevision,
      next.lastCoachedMoveId,
      next.fullTurnsSinceSummary,
      next.lastCoachingTrigger,
      next.lastCoachingFen,
      next.lastObservedRobotMoveId,
      JSON.stringify(next.adviceFingerprints.slice(-8)),
      this.now(),
      conversationId
    );
    return this.getPhysicalBinding(conversationId);
  }

  getPhysicalAction(conversationId, requestId) {
    const row = this.db.prepare(`
      SELECT * FROM mentor_physical_actions WHERE conversation_id = ? AND request_id = ?
    `).get(conversationId, requestId);
    if (!row) return null;
    return {
      conversationId: row.conversation_id,
      requestId: row.request_id,
      actionType: row.action_type,
      status: row.status,
      result: parseJson(row.result_json, null),
      errorCode: row.error_code || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  savePhysicalAction(conversationId, requestId, actionType, result, errorCode = null) {
    const timestamp = this.now();
    this.db.prepare(`
      INSERT INTO mentor_physical_actions(
        conversation_id, request_id, action_type, status, result_json, error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, request_id) DO NOTHING
    `).run(
      conversationId,
      requestId,
      actionType,
      errorCode ? 'failed' : 'complete',
      result === undefined ? null : JSON.stringify(result),
      errorCode,
      timestamp,
      timestamp
    );
    return this.getPhysicalAction(conversationId, requestId);
  }

  detachPhysicalBinding(conversationId, status = 'detached') {
    const current = this.getPhysicalBinding(conversationId);
    if (!current) return null;
    return this.updatePhysicalBinding(conversationId, {
      status,
      annotatedFen: null,
      analyzedFen: null,
      annotations: { highlights: [], arrows: [] },
      lastEventKey: null
    });
  }

  createActivity({
    conversationId,
    type,
    title,
    goal = '',
    learnerColor,
    mentorColor,
    sourceId = null,
    startFen,
    startRevision,
    boardRevision = startRevision,
    phase,
    totalSteps = 0,
    config = {},
    state = {}
  }) {
    if (this.getActiveActivity(conversationId)) {
      const error = new Error('This conversation already has an active mentor activity.');
      error.code = 'activity_already_active';
      throw error;
    }
    const id = this.createId();
    const timestamp = this.now();
    this.db.prepare(`
      INSERT INTO mentor_activities(
        id, conversation_id, activity_type, status, phase, title, goal,
        learner_color, mentor_color, source_id, start_fen, start_revision,
        board_revision, total_steps, config_json, state_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      conversationId,
      type,
      phase,
      title,
      goal,
      learnerColor,
      mentorColor,
      sourceId,
      startFen,
      startRevision,
      boardRevision,
      totalSteps,
      JSON.stringify(config || {}),
      JSON.stringify(state || {}),
      timestamp,
      timestamp
    );
    const activity = this.getActivity(id);
    this.appendActivityEvent(id, conversationId, 'started', { phase, boardRevision });
    return activity;
  }

  getActivity(id) {
    return mapActivity(this.db.prepare('SELECT * FROM mentor_activities WHERE id = ?').get(id));
  }

  getActiveActivity(conversationId) {
    return mapActivity(this.db.prepare(`
      SELECT * FROM mentor_activities
      WHERE conversation_id = ? AND status IN ('active', 'paused')
      ORDER BY updated_at DESC LIMIT 1
    `).get(conversationId));
  }

  listActivities(conversationId) {
    return this.db.prepare(`
      SELECT * FROM mentor_activities WHERE conversation_id = ?
      ORDER BY created_at ASC
    `).all(conversationId).map(mapActivity);
  }

  updateActivity(id, patch = {}) {
    const current = this.getActivity(id);
    if (!current) return null;
    const next = {
      status: patch.status || current.status,
      phase: patch.phase || current.phase,
      boardRevision: Number.isInteger(patch.boardRevision) ? patch.boardRevision : current.boardRevision,
      stepIndex: Number.isInteger(patch.stepIndex) ? patch.stepIndex : current.stepIndex,
      totalSteps: Number.isInteger(patch.totalSteps) ? patch.totalSteps : current.totalSteps,
      attempts: Number.isInteger(patch.attempts) ? patch.attempts : current.attempts,
      hints: Number.isInteger(patch.hints) ? patch.hints : current.hints,
      generation: Number.isInteger(patch.generation) ? patch.generation : current.generation,
      pendingRequestId: Object.prototype.hasOwnProperty.call(patch, 'pendingRequestId')
        ? patch.pendingRequestId
        : current.pendingRequestId,
      predictionPrompt: Object.prototype.hasOwnProperty.call(patch, 'predictionPrompt')
        ? patch.predictionPrompt
        : current.predictionPrompt,
      config: Object.prototype.hasOwnProperty.call(patch, 'config') ? patch.config : current.config,
      state: Object.prototype.hasOwnProperty.call(patch, 'state') ? patch.state : current.state,
      completedAt: Object.prototype.hasOwnProperty.call(patch, 'completedAt')
        ? patch.completedAt
        : current.completedAt
    };
    this.db.prepare(`
      UPDATE mentor_activities
      SET status = ?, phase = ?, board_revision = ?, step_index = ?, total_steps = ?,
          attempts = ?, hints = ?, generation = ?, pending_request_id = ?,
          prediction_prompt = ?, config_json = ?, state_json = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.status,
      next.phase,
      next.boardRevision,
      next.stepIndex,
      next.totalSteps,
      next.attempts,
      next.hints,
      next.generation,
      next.pendingRequestId,
      next.predictionPrompt,
      JSON.stringify(next.config || {}),
      JSON.stringify(next.state || {}),
      next.completedAt,
      this.now(),
      id
    );
    return this.getActivity(id);
  }

  claimActivityLease(id, owner, ttlMs = 90000) {
    const timestamp = this.now();
    const expiresAt = timestamp + Math.max(1000, Number(ttlMs) || 90000);
    const result = this.db.prepare(`
      UPDATE mentor_activities
      SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
        AND (lease_owner IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
    `).run(owner, expiresAt, timestamp, id, timestamp, owner);
    return result.changes === 1 ? this.getActivity(id) : null;
  }

  releaseActivityLease(id, owner) {
    const result = this.db.prepare(`
      UPDATE mentor_activities
      SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND lease_owner = ?
    `).run(this.now(), id, owner);
    return result.changes === 1;
  }

  appendActivityEvent(activityId, conversationId, type, payload = {}) {
    const sequence = Number(this.db.prepare(`
      SELECT COALESCE(max(sequence), 0) + 1 AS next_sequence
      FROM mentor_activity_events WHERE activity_id = ?
    `).get(activityId).next_sequence);
    const id = this.createId();
    this.db.prepare(`
      INSERT INTO mentor_activity_events(
        id, activity_id, conversation_id, sequence, event_type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, activityId, conversationId, sequence, type, JSON.stringify(payload || {}), this.now());
    return mapActivityEvent(this.db.prepare(
      'SELECT * FROM mentor_activity_events WHERE id = ?'
    ).get(id));
  }

  listActivityEvents(activityId) {
    return this.db.prepare(`
      SELECT * FROM mentor_activity_events WHERE activity_id = ? ORDER BY sequence ASC
    `).all(activityId).map(mapActivityEvent);
  }

  getLearnerProfile() {
    return mapLearnerProfile(this.db.prepare(
      'SELECT * FROM mentor_learner_profile WHERE id = 1'
    ).get());
  }

  updateLearnerProfile({ skillBand, goals }) {
    const current = this.getLearnerProfile();
    const nextBand = skillBand || current.skillBand;
    if (!['Beginner', 'Intermediate', 'Advanced'].includes(nextBand)) {
      throw new Error('Skill band must be Beginner, Intermediate, or Advanced.');
    }
    const nextGoals = goals === undefined ? current.goals : goals;
    if (!Array.isArray(nextGoals) || nextGoals.length > 8
      || nextGoals.some((goal) => typeof goal !== 'string' || !goal.trim() || goal.length > 120)) {
      throw new Error('Goals must be an array of up to eight short strings.');
    }
    this.db.prepare(`
      UPDATE mentor_learner_profile
      SET skill_band = ?, goals_json = ?, updated_at = ? WHERE id = 1
    `).run(nextBand, JSON.stringify(nextGoals.map((goal) => goal.trim())), this.now());
    return this.getLearnerProfile();
  }

  listTopicProgress() {
    return this.db.prepare(`
      SELECT * FROM mentor_topic_progress ORDER BY mastery ASC, topic ASC
    `).all().map(mapTopicProgress);
  }

  awardActivityProgress(activityId, topics, points) {
    const normalizedTopics = [...new Set((topics || []).filter(Boolean))];
    if (!normalizedTopics.length) return { awarded: false, progress: this.listTopicProgress() };
    const normalizedPoints = Math.max(0, Math.min(100, Number(points) || 0));
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const duplicate = this.db.prepare(
        'SELECT activity_id FROM mentor_progress_awards WHERE activity_id = ?'
      ).get(activityId);
      if (duplicate) {
        this.db.exec('COMMIT;');
        return { awarded: false, progress: this.listTopicProgress() };
      }
      const timestamp = this.now();
      this.db.prepare(`
        INSERT INTO mentor_progress_awards(activity_id, points, topics_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(activityId, normalizedPoints, JSON.stringify(normalizedTopics), timestamp);
      const update = this.db.prepare(`
        INSERT INTO mentor_topic_progress(topic, mastery, completions, updated_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(topic) DO UPDATE SET
          mastery = min(100, mentor_topic_progress.mastery + excluded.mastery),
          completions = mentor_topic_progress.completions + 1,
          updated_at = excluded.updated_at
      `);
      normalizedTopics.forEach((topic) => update.run(topic, normalizedPoints, timestamp));
      this.db.exec('COMMIT;');
      return { awarded: true, points: normalizedPoints, progress: this.listTopicProgress() };
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
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
