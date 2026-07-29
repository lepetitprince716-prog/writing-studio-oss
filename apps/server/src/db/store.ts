import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { AgentSessionRef, ContextManifest } from '@writing-studio/contract';
import type {
  Anchor,
  AgentId,
  CanonThreadTarget,
  ChatPersona,
  Message,
  Revision,
  RevisionWithContent,
  Run,
  Thread,
  ThreadKind,
} from '@writing-studio/contract';
import { sha256 } from '../vault.js';
import { createAnchor, resolveAnchor } from '../anchors.js';
import { MIGRATIONS } from './schema.js';

type SqliteDatabase = Database.Database;

interface StoreLogger {
  error(bindings: { err: unknown; databasePath: string }, message: string): void;
}

type ThreadRow = Omit<Thread, 'anchor' | 'persona' | 'origin' | 'canon'> & {
  anchor_json: string | null;
  persona_json: string | null;
  origin: string | null;
  canon_json: string | null;
  project_id: string;
  doc_id: string;
  agent_id: AgentId;
  created_at: number;
  updated_at: number;
};
type MessageRow = Omit<Message, 'threadId' | 'agentId' | 'structured' | 'createdAt'> & { thread_id: string; agent_id: AgentId | null; structured_json: string | null; created_at: number };
type RevisionRow = Omit<Revision, 'projectId' | 'docId' | 'sha256' | 'sourceThreadId' | 'createdAt'> & { project_id: string; doc_id: string; sha256: string; source_thread_id: string | null; created_at: number };

export class StoreValidationError extends Error {}

const AGENT_IDS = new Set<AgentId>(['claude', 'codex', 'opencode', 'pi', 'grok', 'echo']);
const REVISION_KINDS = new Set<Revision['kind']>(['ai_original', 'user_edit', 'manual_snapshot']);

function decodeJson<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T;
}

function mapThread(row: ThreadRow): Thread {
  const persona = decodeJson<ChatPersona>(row.persona_json);
  const origin = row.origin === 'generate' || row.origin === 'check' || row.origin === 'canon'
    ? row.origin
    : null;
  const canon = decodeJson<CanonThreadTarget>(row.canon_json);
  return {
    id: row.id,
    projectId: row.project_id,
    docId: row.doc_id,
    kind: row.kind,
    anchor: decodeJson<Anchor>(row.anchor_json),
    ...(persona ? { persona } : {}),
    ...(origin ? { origin } : {}),
    ...(canon ? { canon } : {}),
    agentId: row.agent_id,
    profile: row.profile,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    agentId: row.agent_id,
    content: row.content,
    structured: decodeJson<Message['structured']>(row.structured_json),
    createdAt: row.created_at,
  };
}

function mapRevision(row: RevisionRow): Revision {
  return {
    id: row.id,
    projectId: row.project_id,
    docId: row.doc_id,
    kind: row.kind,
    sha256: row.sha256,
    sourceThreadId: row.source_thread_id,
    label: row.label,
    createdAt: row.created_at,
  };
}

export class ProjectStore {
  readonly db: SqliteDatabase;
  readonly databasePath: string;

  constructor(readonly projectId: string, private readonly dataDir: string, private readonly logger?: StoreLogger) {
    mkdirSync(dataDir, { recursive: true });
    this.databasePath = join(dataDir, 'panel.sqlite3');
    const databaseExistedBeforeOpen = existsSync(this.databasePath);
    this.db = new Database(this.databasePath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.migrate(databaseExistedBeforeOpen);
    this.recoverOrphanedRuns();
  }

  private migrate(databaseExistedBeforeOpen: boolean): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const applied = new Set((this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((row) => row.version));
    const maximumApplied = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
    const maximumKnown = Math.max(0, ...MIGRATIONS.map((migration) => migration.version));
    const maximumAppliedVersion = maximumApplied.version ?? 0;
    if (maximumAppliedVersion > maximumKnown) {
      const error = new Error(
        `database at ${this.databasePath} was created by a newer writing-studio version; upgrade writing-studio or restore this database from a backup (remove panel.sqlite3-wal and panel.sqlite3-shm first)`,
      );
      this.db.close();
      throw error;
    }

    const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version));
    if (databaseExistedBeforeOpen && pending.length > 0) {
      this.backupBeforeMigration(maximumAppliedVersion);
    }
    for (const migration of pending) {
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, Date.now());
      })();
    }
  }

  private backupBeforeMigration(maximumAppliedVersion: number): void {
    const backupName = `panel.sqlite3.bak-${maximumAppliedVersion}-${Date.now()}`;
    try {
      // pragma reports contention in its result row instead of throwing.
      const [checkpoint] = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
      if (checkpoint?.busy) {
        this.reportBackupError(
          new Error('wal_checkpoint(TRUNCATE) reported busy'),
          'database backup may be missing recent commits; continuing migration',
        );
      }
      copyFileSync(this.databasePath, join(this.dataDir, backupName));
    } catch (error) {
      // Keep migrations available even when a filesystem backup is unavailable.
      this.reportBackupError(error, 'database backup before migration failed; continuing migration');
      return;
    }

    try {
      // The version segment is variable-width, so raw name order misranks version 10+;
      // order by the trailing epoch timestamp. Malformed names sort oldest.
      const backups = readdirSync(this.dataDir)
        .filter((entry) => entry.startsWith('panel.sqlite3.bak-'))
        .map((name) => ({ name, at: Number(name.slice(name.lastIndexOf('-') + 1)) }))
        .sort((a, b) => (Number.isFinite(a.at) ? a.at : -1) - (Number.isFinite(b.at) ? b.at : -1));
      for (const backup of backups.slice(0, -3)) {
        rmSync(join(this.dataDir, backup.name));
      }
    } catch (error) {
      // A successful backup is still useful even if old backups cannot be pruned.
      this.reportBackupError(error, 'database backup pruning failed; continuing migration');
    }
  }

  private reportBackupError(error: unknown, message: string): void {
    const bindings = { err: error, databasePath: this.databasePath };
    if (this.logger) {
      this.logger.error(bindings, message);
      return;
    }
    console.error(bindings, message);
  }

  private assertThreadProject(threadId: string): Thread {
    const thread = this.getThread(threadId);
    if (!thread) throw new StoreValidationError(`unknown thread: ${threadId}`);
    return thread;
  }

  createThread(input: {
    docId: string;
    kind: ThreadKind;
    anchor: Anchor | null;
    agentId: AgentId;
    profile: 'writer' | 'planner';
    persona?: ChatPersona | null;
    origin?: 'generate' | 'check' | 'canon' | null;
    canon?: CanonThreadTarget | null;
    title?: string;
  }): Thread {
    if (!AGENT_IDS.has(input.agentId)) throw new StoreValidationError('invalid thread agentId');
    const persona = input.persona ?? null;
    const origin = input.origin ?? null;
    const canon = input.canon ?? null;
    if (input.kind === 'chat') {
      if (!persona) throw new StoreValidationError('chat threads require a persona');
      if (input.profile !== 'writer') throw new StoreValidationError('chat threads must use the writer profile');
    } else if (persona) {
      throw new StoreValidationError('persona is only valid for chat threads');
    }
    if (origin === 'generate' && (input.kind !== 'rewrite' || input.anchor !== null)) {
      throw new StoreValidationError('generate origin requires an unanchored rewrite thread');
    }
    if (origin === 'check' && (input.kind !== 'ask' || input.anchor !== null || input.profile !== 'writer')) {
      throw new StoreValidationError('check origin requires an unanchored writer ask thread');
    }
    if (
      origin === 'canon'
      && (
        input.kind !== 'rewrite'
        || input.anchor === null
        || input.profile !== 'writer'
        || canon === null
      )
    ) {
      throw new StoreValidationError('canon origin requires an anchored writer rewrite and target metadata');
    }
    if (origin !== 'canon' && canon !== null) {
      throw new StoreValidationError('canon metadata is only valid for canon origin');
    }
    const now = Date.now();
    const thread: Thread = {
      id: randomUUID(), projectId: this.projectId, docId: input.docId, kind: input.kind, anchor: input.anchor,
      ...(persona ? { persona } : {}),
      ...(origin ? { origin } : {}),
      ...(canon ? { canon } : {}),
      agentId: input.agentId, profile: input.profile,
      title: input.title
        ?? (
          persona
            ? `与 ${persona.characterName} 对话`
            : canon
              ? `修补正典：${canon.headingPath.join(' / ')}`
              : input.anchor ? input.anchor.exact.slice(0, 30) : `${input.kind} thread`
        ),
      status: 'open', createdAt: now, updatedAt: now,
    };
    this.db.prepare(`INSERT INTO threads (id, project_id, doc_id, kind, anchor_json, persona_json, origin, canon_json, agent_id, profile, title, status, created_at, updated_at)
      VALUES (@id, @projectId, @docId, @kind, @anchor, @personaJson, @origin, @canonJson, @agentId, @profile, @title, @status, @createdAt, @updatedAt)`).run({
        ...thread,
        anchor: thread.anchor ? JSON.stringify(thread.anchor) : null,
        personaJson: persona ? JSON.stringify(persona) : null,
        origin,
        canonJson: canon ? JSON.stringify(canon) : null,
      });
    return thread;
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ? AND project_id = ?').get(id, this.projectId) as ThreadRow | undefined;
    return row ? mapThread(row) : undefined;
  }

  listThreadsForDoc(docId: string): Thread[] {
    return (this.db.prepare('SELECT * FROM threads WHERE project_id = ? AND doc_id = ? ORDER BY updated_at DESC, id').all(this.projectId, docId) as ThreadRow[]).map(mapThread);
  }

  listThreadsByKind(kind: ThreadKind): Thread[] {
    return (this.db.prepare(
      'SELECT * FROM threads WHERE project_id = ? AND kind = ? ORDER BY updated_at DESC, id',
    ).all(this.projectId, kind) as ThreadRow[]).map(mapThread);
  }

  patchThread(id: string, patch: Partial<Pick<Thread, 'status' | 'agentId' | 'title'>>): Thread | undefined {
    const allowed = new Set(['status', 'agentId', 'title']);
    const entries = Object.entries(patch);
    if (entries.length === 0 || entries.some(([key, value]) => !allowed.has(key) || value === undefined)) {
      throw new StoreValidationError('thread patch must contain only status, agentId, or title');
    }
    if (patch.status !== undefined && patch.status !== 'open' && patch.status !== 'resolved') {
      throw new StoreValidationError('invalid thread status');
    }
    if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.length === 0)) {
      throw new StoreValidationError('thread title must be non-empty');
    }
    if (patch.agentId !== undefined && !AGENT_IDS.has(patch.agentId)) {
      throw new StoreValidationError('invalid thread agentId');
    }
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of entries) {
      if (key === 'status') { fields.push('status = ?'); values.push(value); }
      if (key === 'agentId') { fields.push('agent_id = ?'); values.push(value); }
      if (key === 'title') { fields.push('title = ?'); values.push(value); }
    }
    fields.push('updated_at = ?'); values.push(Date.now(), id, this.projectId);
    const result = this.db.prepare(`UPDATE threads SET ${fields.join(', ')} WHERE id = ? AND project_id = ?`).run(...values);
    return result.changes === 0 ? undefined : this.getThread(id);
  }

  getMessages(threadId: string): Message[] {
    this.assertThreadProject(threadId);
    return (this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY message_index').all(threadId) as MessageRow[]).map(mapMessage);
  }

  appendMessage(threadId: string, role: Message['role'], content: string, agentId: AgentId | null, structured: Message['structured'] = null): Message {
    this.assertThreadProject(threadId);
    if ((role !== 'user' && role !== 'assistant') || (agentId !== null && !AGENT_IDS.has(agentId))) {
      throw new StoreValidationError('invalid message role or agentId');
    }
    const now = Date.now();
    const id = randomUUID();
    this.db.transaction(() => {
      const next = this.db.prepare('SELECT COALESCE(MAX(message_index), -1) + 1 AS next_index FROM messages WHERE thread_id = ?').get(threadId) as { next_index: number };
      this.db.prepare(`INSERT INTO messages (id, thread_id, message_index, role, agent_id, content, structured_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, threadId, next.next_index, role, agentId, content, structured === null ? null : JSON.stringify(structured), now);
      this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ? AND project_id = ?').run(now, threadId, this.projectId);
    })();
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
    if (!row) throw new Error('message insert failed');
    return mapMessage(row);
  }

  createRevision(input: { docId: string; kind: Revision['kind']; content: string; sourceThreadId: string | null; label: string | null }): Revision {
    if (!REVISION_KINDS.has(input.kind)) throw new StoreValidationError('invalid revision kind');
    if (input.sourceThreadId) this.assertThreadProject(input.sourceThreadId);
    const contentSha = sha256(input.content);
    const existing = this.db.prepare('SELECT * FROM revisions WHERE project_id = ? AND doc_id = ? AND sha256 = ?').get(this.projectId, input.docId, contentSha) as RevisionRow | undefined;
    if (existing) return mapRevision(existing);
    const revision: Revision = { id: randomUUID(), projectId: this.projectId, docId: input.docId, kind: input.kind, sha256: contentSha, sourceThreadId: input.sourceThreadId, label: input.label, createdAt: Date.now() };
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO contents (sha256, content, created_at) VALUES (?, ?, ?)').run(contentSha, input.content, revision.createdAt);
      this.db.prepare(`INSERT INTO revisions (id, project_id, doc_id, kind, sha256, source_thread_id, label, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(revision.id, revision.projectId, revision.docId, revision.kind, revision.sha256, revision.sourceThreadId, revision.label, revision.createdAt);
    })();
    return revision;
  }

  listRevisions(docId: string): Revision[] {
    // Equal timestamps use insertion rowid; revisions are append-only. Re-review if the table gains
    // an explicit INTEGER PRIMARY KEY or if VACUUM semantics change.
    return (this.db.prepare('SELECT * FROM revisions WHERE project_id = ? AND doc_id = ? ORDER BY created_at, rowid').all(this.projectId, docId) as RevisionRow[]).map(mapRevision);
  }

  listRevisionsWithContent(docId: string): RevisionWithContent[] {
    const rows = this.db.prepare(`SELECT r.*, c.content
      FROM revisions r JOIN contents c ON c.sha256 = r.sha256
      WHERE r.project_id = ? AND r.doc_id = ?
      ORDER BY r.created_at, r.rowid`).all(this.projectId, docId) as Array<RevisionRow & { content: string }>;
    return rows.map((row) => ({ ...mapRevision(row), content: row.content }));
  }

  getRevision(id: string): RevisionWithContent | undefined {
    const row = this.db.prepare(`SELECT r.*, c.content FROM revisions r JOIN contents c ON c.sha256 = r.sha256
      WHERE r.id = ? AND r.project_id = ?`).get(id, this.projectId) as (RevisionRow & { content: string }) | undefined;
    return row ? { ...mapRevision(row), content: row.content } : undefined;
  }

  getSession(threadId: string, agentId: AgentId): AgentSessionRef | undefined {
    this.assertThreadProject(threadId);
    const row = this.db.prepare('SELECT * FROM agent_sessions WHERE thread_id = ? AND agent_id = ?').get(threadId, agentId) as { agent_id: AgentId; native_session_id: string | null; last_synced_message_count: number; created_at: number; last_used_at: number } | undefined;
    return row && { agentId: row.agent_id, nativeSessionId: row.native_session_id, lastSyncedMessageCount: row.last_synced_message_count, createdAt: row.created_at, lastUsedAt: row.last_used_at };
  }

  upsertSession(threadId: string, session: Omit<AgentSessionRef, 'agentId' | 'createdAt' | 'lastUsedAt'> & { agentId: AgentId }): AgentSessionRef {
    this.assertThreadProject(threadId);
    if (!AGENT_IDS.has(session.agentId)) throw new StoreValidationError('invalid session agentId');
    if (!Number.isInteger(session.lastSyncedMessageCount) || session.lastSyncedMessageCount < 0) throw new StoreValidationError('lastSyncedMessageCount must be a non-negative integer');
    const now = Date.now();
    this.db.prepare(`INSERT INTO agent_sessions (thread_id, agent_id, native_session_id, last_synced_message_count, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, agent_id) DO UPDATE SET native_session_id = excluded.native_session_id,
        last_synced_message_count = excluded.last_synced_message_count, last_used_at = excluded.last_used_at`).run(threadId, session.agentId, session.nativeSessionId, session.lastSyncedMessageCount, now, now);
    return this.getSession(threadId, session.agentId)!;
  }

  createRun(threadId: string, agentId: AgentId, model: string | null = null): Run {
    this.assertThreadProject(threadId);
    if (!AGENT_IDS.has(agentId)) throw new StoreValidationError('invalid run agentId');
    const run: Run = {
      id: randomUUID(),
      projectId: this.projectId,
      threadId,
      agentId,
      status: 'running',
      errorCode: null,
      errorDetail: null,
      createdAt: Date.now(),
      finishedAt: null,
    };
    this.db.prepare('INSERT INTO runs (id, project_id, thread_id, agent_id, model, status, error_code, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      run.id,
      run.projectId,
      run.threadId,
      run.agentId,
      model,
      run.status,
      null,
      run.createdAt,
      null,
    );
    return run;
  }

  /** Private diagnostics only. The public Run mapper intentionally omits it. */
  setRunManifest(id: string, manifest: ContextManifest): void {
    const result = this.db.prepare(
      'UPDATE runs SET context_manifest_json = ? WHERE id = ? AND project_id = ? AND status = ?',
    ).run(JSON.stringify(manifest), id, this.projectId, 'running');
    if (result.changes !== 1) throw new StoreValidationError('run is not active or does not belong to this project');
  }

  setRunModelId(id: string, modelId: string): void {
    const result = this.db.prepare(
      'UPDATE runs SET model_id = ? WHERE id = ? AND project_id = ? AND status = ?',
    ).run(modelId, id, this.projectId, 'running');
    if (result.changes !== 1) throw new StoreValidationError('run is not active or does not belong to this project');
  }

  finishRun(
    id: string,
    status: Exclude<Run['status'], 'running'>,
    errorCode: string | null = null,
    errorDetail: string | null = null,
  ): Run | undefined {
    const result = this.db.prepare(
      'UPDATE runs SET status = ?, error_code = ?, error_detail = ?, finished_at = ? WHERE id = ? AND project_id = ? AND status = ?',
    ).run(status, errorCode, errorDetail, Date.now(), id, this.projectId, 'running');
    if (result.changes === 0) return undefined;
    return this.getRun(id);
  }

  /**
   * Commit all panel-side effects of a backend `done` atomically. The caller
   * must broadcast that terminal event only after this returns successfully.
   */
  finalizeRun(input: {
    runId: string;
    threadId: string;
    agentId: AgentId;
    status: Exclude<Run['status'], 'running'>;
    errorCode: string | null;
    errorDetail: string | null;
    assistant: { content: string; structured: Message['structured'] } | null;
    session: { nativeSessionId: string; lastSyncedMessageCount: number } | null;
  }): void {
    this.assertThreadProject(input.threadId);
    if (!AGENT_IDS.has(input.agentId)) throw new StoreValidationError('invalid run agentId');
    if (input.session && (!Number.isInteger(input.session.lastSyncedMessageCount) || input.session.lastSyncedMessageCount < 0)) {
      throw new StoreValidationError('lastSyncedMessageCount must be a non-negative integer');
    }
    const now = Date.now();
    this.db.transaction(() => {
      if (input.assistant) {
        const next = this.db.prepare('SELECT COALESCE(MAX(message_index), -1) + 1 AS next_index FROM messages WHERE thread_id = ?').get(input.threadId) as { next_index: number };
        this.db.prepare(`INSERT INTO messages (id, thread_id, message_index, role, agent_id, content, structured_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          randomUUID(), input.threadId, next.next_index, 'assistant', input.agentId,
          input.assistant.content,
          input.assistant.structured === null ? null : JSON.stringify(input.assistant.structured),
          now,
        );
        this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ? AND project_id = ?').run(now, input.threadId, this.projectId);
      }
      if (input.session) {
        this.db.prepare(`INSERT INTO agent_sessions (thread_id, agent_id, native_session_id, last_synced_message_count, created_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id, agent_id) DO UPDATE SET native_session_id = excluded.native_session_id,
            last_synced_message_count = excluded.last_synced_message_count, last_used_at = excluded.last_used_at`).run(
          input.threadId, input.agentId, input.session.nativeSessionId,
          input.session.lastSyncedMessageCount, now, now,
        );
      } else {
        // `done.nativeSessionId === null` is an explicit invalidation, not an
        // instruction to leave a possibly stale resumable CLI session behind.
        this.db.prepare('DELETE FROM agent_sessions WHERE thread_id = ? AND agent_id = ?')
          .run(input.threadId, input.agentId);
      }
      const run = this.db.prepare(`UPDATE runs SET status = ?, error_code = ?, error_detail = ?, finished_at = ?
        WHERE id = ? AND project_id = ? AND thread_id = ? AND agent_id = ? AND status = ?`).run(
        input.status, input.errorCode, input.errorDetail, now, input.runId, this.projectId,
        input.threadId, input.agentId, 'running',
      );
      if (run.changes !== 1) throw new StoreValidationError('run is not active or does not belong to this thread');
    })();
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ? AND project_id = ?').get(id, this.projectId) as {
      id: string;
      project_id: string;
      thread_id: string;
      agent_id: AgentId;
      status: Run['status'];
      error_code: string | null;
      error_detail: string | null;
      model_id: string | null;
      created_at: number;
      finished_at: number | null;
    } | undefined;
    return row && {
      id: row.id,
      projectId: row.project_id,
      threadId: row.thread_id,
      agentId: row.agent_id,
      status: row.status,
      errorCode: row.error_code,
      errorDetail: row.error_detail,
      ...(row.model_id ? { modelId: row.model_id } : {}),
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    };
  }

  recoverOrphanedRuns(): number {
    return this.db.prepare("UPDATE runs SET status = 'failed', error_code = 'process_error', finished_at = ? WHERE status = 'running'").run(Date.now()).changes;
  }

  updateAnchorsForDocument(docId: string, docSha: string, content: string): number {
    const rows = this.db.prepare("SELECT * FROM threads WHERE project_id = ? AND doc_id = ? AND status = 'open' AND anchor_json IS NOT NULL").all(this.projectId, docId) as ThreadRow[];
    const update = this.db.prepare('UPDATE threads SET anchor_json = ?, updated_at = ? WHERE id = ? AND project_id = ?');
    const now = Date.now();
    let updated = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        const anchor = decodeJson<Anchor>(row.anchor_json)!;
        const resolution = resolveAnchor(anchor, content);
        if (resolution.status === 'lost') continue;
        const next = createAnchor(docSha, content, resolution.start, resolution.end);
        update.run(JSON.stringify(next), now, row.id, this.projectId);
        updated += 1;
      }
    })();
    return updated;
  }

  replaceThreadAnchor(id: string, docId: string, anchor: Anchor): void {
    const result = this.db.prepare(
      "UPDATE threads SET anchor_json = ?, updated_at = ? WHERE id = ? AND project_id = ? AND doc_id = ? AND status = 'open'",
    ).run(JSON.stringify(anchor), Date.now(), id, this.projectId, docId);
    if (result.changes !== 1) {
      throw new StoreValidationError('thread anchor target is unavailable');
    }
  }

  close(): void { this.db.close(); }
}

export class StoreManager {
  private readonly stores = new Map<string, ProjectStore>();
  private readonly allowedProjectIds: Set<string> | null;

  constructor(
    private readonly dataRoot: string,
    allowedProjectIds?: Iterable<string>,
    private readonly logger?: StoreLogger,
  ) {
    this.allowedProjectIds = allowedProjectIds ? new Set(allowedProjectIds) : null;
  }

  get(projectId: string): ProjectStore {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(projectId)) {
      throw new StoreValidationError(`invalid project id: ${projectId}`);
    }
    if (this.allowedProjectIds && !this.allowedProjectIds.has(projectId)) {
      throw new StoreValidationError(`project is not registered: ${projectId}`);
    }
    let store = this.stores.get(projectId);
    if (!store) {
      store = new ProjectStore(projectId, join(this.dataRoot, projectId), this.logger);
      this.stores.set(projectId, store);
    }
    return store;
  }

  findThread(id: string): { store: ProjectStore; thread: Thread } | undefined {
    const found = this.findAcross((store) => store.getThread(id));
    return found && { store: found.store, thread: found.value };
  }

  findRevision(id: string): { store: ProjectStore; revision: RevisionWithContent } | undefined {
    const found = this.findAcross((store) => store.getRevision(id));
    return found && { store: found.store, revision: found.value };
  }

  findRun(id: string): { store: ProjectStore; run: Run } | undefined {
    const found = this.findAcross((store) => store.getRun(id));
    return found && { store: found.store, run: found.value };
  }

  private findAcross<T>(
    get: (store: ProjectStore) => T | undefined,
  ): { store: ProjectStore; value: T } | undefined {
    this.openPersistedStores();
    for (const store of this.stores.values()) {
      const value = get(store);
      if (value) return { store, value };
    }
    return undefined;
  }

  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }

  private openPersistedStores(): void {
    try {
      for (const entry of readdirSync(this.dataRoot, { withFileTypes: true })) {
        if (
          entry.isDirectory()
          && /^[a-z0-9][a-z0-9-]{1,63}$/.test(entry.name)
          && (!this.allowedProjectIds || this.allowedProjectIds.has(entry.name))
        ) this.get(entry.name);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
