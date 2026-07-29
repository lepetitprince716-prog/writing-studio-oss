export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ask', 'rewrite', 'chat')),
        anchor_json TEXT,
        agent_id TEXT NOT NULL,
        profile TEXT NOT NULL CHECK (profile IN ('writer', 'planner')),
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS threads_project_doc_idx ON threads(project_id, doc_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS contents (
        sha256 TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        message_index INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        agent_id TEXT,
        content TEXT NOT NULL,
        structured_json TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(thread_id, message_index)
      );
      CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(thread_id, message_index);

      CREATE TABLE IF NOT EXISTS revisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ai_original', 'user_edit', 'manual_snapshot')),
        sha256 TEXT NOT NULL REFERENCES contents(sha256),
        source_thread_id TEXT REFERENCES threads(id),
        label TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(project_id, doc_id, sha256)
      );
      CREATE INDEX IF NOT EXISTS revisions_project_doc_idx ON revisions(project_id, doc_id, created_at);

      CREATE TABLE IF NOT EXISTS agent_sessions (
        thread_id TEXT NOT NULL REFERENCES threads(id),
        agent_id TEXT NOT NULL,
        native_session_id TEXT,
        last_synced_message_count INTEGER NOT NULL CHECK (last_synced_message_count >= 0),
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
        error_code TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS runs_project_thread_idx ON runs(project_id, thread_id, created_at DESC);

      CREATE TRIGGER IF NOT EXISTS contents_no_update
      BEFORE UPDATE ON contents BEGIN SELECT RAISE(ABORT, 'contents are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS contents_no_delete
      BEFORE DELETE ON contents BEGIN SELECT RAISE(ABORT, 'contents are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revisions_no_update
      BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revisions_no_delete
      BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE threads ADD COLUMN persona_json TEXT;
      ALTER TABLE runs ADD COLUMN model TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE threads ADD COLUMN origin TEXT;
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE runs ADD COLUMN context_manifest_json TEXT;
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE threads ADD COLUMN canon_json TEXT;
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE runs ADD COLUMN error_detail TEXT;
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE runs ADD COLUMN model_id TEXT;
    `,
  },
];
