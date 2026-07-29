import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AGENT_IDS as CONTRACT_AGENT_IDS } from '@writing-studio/contract';
import Database from 'better-sqlite3';
import { ProjectStore, StoreManager, StoreValidationError } from '../src/db/store.js';
import { MIGRATIONS } from '../src/db/schema.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'writing-studio-db-'));
}

function thread(store: ProjectStore) {
  return store.createThread({ docId: '正文/第1章.md', kind: 'ask', anchor: null, agentId: 'echo', profile: 'writer' });
}

function backupNames(dataDir: string): string[] {
  return readdirSync(dataDir).filter((entry) => entry.startsWith('panel.sqlite3.bak-')).sort();
}

function createVersionOneDatabase(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const database = new Database(join(dataDir, 'panel.sqlite3'));
  try {
    database.exec(MIGRATIONS[0]!.sql);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, 1);
  } finally {
    database.close();
  }
}

test('database agent-id guard stays exhaustive with the contract ids', () => {
  const source = readFileSync(new URL('../src/db/store.ts', import.meta.url), 'utf8');
  const guard = source.match(
    /const AGENT_IDS = new Set<AgentId>\(\[([^\]]+)\]\);/u,
  );
  assert.ok(guard?.[1], 'database AGENT_IDS guard must remain an explicit fail-closed set');
  const databaseAgentIds = [...guard[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  assert.deepEqual(databaseAgentIds, [...CONTRACT_AGENT_IDS]);
});

test('ProjectStore persists thread/message/revision state across reopen', () => {
  const root = tempRoot();
  try {
    let store = new ProjectStore('alpha', join(root, 'alpha'));
    const created = thread(store);
    const first = store.appendMessage(created.id, 'user', 'hello', null);
    const second = store.appendMessage(created.id, 'assistant', 'world', 'echo');
    const revision = store.createRevision({ docId: created.docId, kind: 'manual_snapshot', content: 'snapshot', sourceThreadId: created.id, label: 'first' });
    store.upsertSession(created.id, { agentId: 'echo', nativeSessionId: 'native-1', lastSyncedMessageCount: 2 });
    store.close();

    store = new ProjectStore('alpha', join(root, 'alpha'));
    assert.equal(store.getThread(created.id)?.projectId, 'alpha');
    assert.deepEqual(store.getMessages(created.id).map((message) => message.id), [first.id, second.id]);
    assert.equal(store.getRevision(revision.id)?.content, 'snapshot');
    assert.equal(store.getSession(created.id, 'echo')?.lastSyncedMessageCount, 2);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('revision listing preserves insertion order within the same millisecond', () => {
  const root = tempRoot();
  const realNow = Date.now;
  try {
    const store = new ProjectStore('alpha', join(root, 'alpha'));
    const created = thread(store);
    Date.now = () => 1_700_000_000_000;
    // Six inserts: random UUIDs land in lexicographic order by luck 1/720 of
    // the time, so an id-based tiebreak regression cannot slip through green.
    const contents = Array.from({ length: 6 }, (_, index) => `第${index + 1}次写入`);
    const ids = contents.map((content) =>
      store.createRevision({ docId: created.docId, kind: 'manual_snapshot', content, sourceThreadId: null, label: null }).id);

    const listed = store.listRevisions(created.docId);
    assert.equal(new Set(listed.map((revision) => revision.createdAt)).size, 1);
    assert.deepEqual(listed.map((revision) => revision.id), ids);
    assert.deepEqual(
      store.listRevisionsWithContent(created.docId).map((revision) => revision.content),
      contents,
    );
    store.close();
  } finally {
    Date.now = realNow;
    rmSync(root, { recursive: true, force: true });
  }
});

test('projects are isolated and StoreManager resolves global UUIDs after reopen', () => {
  const root = tempRoot();
  try {
    let manager = new StoreManager(root);
    const alpha = manager.get('alpha');
    const beta = manager.get('beta');
    const alphaThread = thread(alpha);
    const betaThread = thread(beta);
    const revision = beta.createRevision({ docId: betaThread.docId, kind: 'manual_snapshot', content: 'beta content', sourceThreadId: betaThread.id, label: null });
    const run = beta.createRun(betaThread.id, 'echo');
    beta.finishRun(run.id, 'cancelled', 'cancelled');
    assert.equal(alpha.getThread(betaThread.id), undefined);
    assert.equal(alpha.listThreadsForDoc(betaThread.docId).length, 1);
    manager.close();

    manager = new StoreManager(root);
    assert.equal(manager.findThread(alphaThread.id)?.thread.projectId, 'alpha');
    assert.equal(manager.findRevision(revision.id)?.revision.projectId, 'beta');
    assert.deepEqual(manager.findRun(run.id)?.run, {
      ...run,
      status: 'cancelled',
      errorCode: 'cancelled',
      finishedAt: manager.findRun(run.id)?.run.finishedAt,
    });
    assert.equal(typeof manager.findRun(run.id)?.run.finishedAt, 'number');
    manager.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('content is deduplicated and immutable while revisions are immutable', () => {
  const root = tempRoot();
  try {
    const store = new ProjectStore('alpha', join(root, 'alpha'));
    const one = store.createRevision({ docId: 'a.md', kind: 'manual_snapshot', content: 'same', sourceThreadId: null, label: null });
    const same = store.createRevision({ docId: 'a.md', kind: 'user_edit', content: 'same', sourceThreadId: null, label: 'ignored because dedupe' });
    assert.equal(one.id, same.id);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM contents').get() as { count: number }).count, 1);
    assert.throws(() => store.db.prepare('UPDATE contents SET content = ? WHERE sha256 = ?').run('mutated', one.sha256), /immutable/);
    assert.throws(() => store.db.prepare('DELETE FROM revisions WHERE id = ?').run(one.id), /immutable/);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('running runs are recovered as process_error on startup', () => {
  const root = tempRoot();
  try {
    let store = new ProjectStore('alpha', join(root, 'alpha'));
    const created = thread(store);
    const run = store.createRun(created.id, 'echo');
    store.close();
    store = new ProjectStore('alpha', join(root, 'alpha'));
    assert.deepEqual(store.getRun(run.id) && { status: store.getRun(run.id)!.status, error: store.getRun(run.id)!.errorCode }, { status: 'failed', error: 'process_error' });
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed runs persist bounded CLI error detail for REST recovery', () => {
  const root = tempRoot();
  try {
    const store = new ProjectStore('alpha', join(root, 'alpha'));
    const created = thread(store);
    const run = store.createRun(created.id, 'claude');
    store.finishRun(run.id, 'failed', 'cli_not_authenticated', 'OAuth session expired');
    assert.equal(store.getRun(run.id)?.errorDetail, 'OAuth session expired');
    assert.deepEqual(
      store.db.prepare('SELECT error_code, error_detail FROM runs WHERE id = ?').get(run.id),
      { error_code: 'cli_not_authenticated', error_detail: 'OAuth session expired' },
    );
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual CLI model id is optional and persists on the public run record', () => {
  const root = tempRoot();
  try {
    const store = new ProjectStore('alpha', join(root, 'alpha'));
    const created = thread(store);
    const run = store.createRun(created.id, 'claude');
    assert.equal(store.getRun(run.id)?.modelId, undefined);
    store.setRunModelId(run.id, 'claude-sonnet-test');
    assert.equal(store.getRun(run.id)?.modelId, 'claude-sonnet-test');
    assert.deepEqual(
      store.db.prepare('SELECT model_id FROM runs WHERE id = ?').get(run.id),
      { model_id: 'claude-sonnet-test' },
    );
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('thread patch is whitelisted and revisions validate project thread ownership', () => {
  const root = tempRoot();
  try {
    const alpha = new ProjectStore('alpha', join(root, 'alpha'));
    const beta = new ProjectStore('beta', join(root, 'beta'));
    const alphaThread = thread(alpha);
    const betaThread = thread(beta);
    assert.throws(() => alpha.patchThread(alphaThread.id, { projectId: 'beta' } as never), StoreValidationError);
    assert.throws(() => alpha.patchThread(alphaThread.id, {}), StoreValidationError);
    assert.equal(alpha.patchThread(alphaThread.id, { status: 'resolved' })?.status, 'resolved');
    assert.throws(() => alpha.createRevision({ docId: 'a.md', kind: 'manual_snapshot', content: 'x', sourceThreadId: betaThread.id, label: null }), StoreValidationError);
    alpha.close(); beta.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('chat persona and run model persist privately across reopen', () => {
  const root = tempRoot();
  try {
    let store = new ProjectStore('alpha', join(root, 'alpha'));
    const chat = store.createThread({
      docId: '角色.md',
      kind: 'chat',
      anchor: null,
      agentId: 'echo',
      profile: 'writer',
      persona: { characterName: '公开角色' },
    });
    const run = store.createRun(chat.id, 'echo', 'echo-verbose');
    const generation = store.createThread({
      docId: '正文/第2章.md',
      kind: 'rewrite',
      anchor: null,
      agentId: 'pi',
      profile: 'writer',
      origin: 'generate',
    });
    const check = store.createThread({
      docId: '正文/第2章.md',
      kind: 'ask',
      anchor: null,
      agentId: 'echo',
      profile: 'writer',
      origin: 'check',
    });
    assert.equal(store.listThreadsByKind('chat')[0]?.persona?.characterName, '公开角色');
    assert.equal(
      (store.db.prepare('SELECT model FROM runs WHERE id = ?').get(run.id) as { model: string }).model,
      'echo-verbose',
    );
    store.close();

    store = new ProjectStore('alpha', join(root, 'alpha'));
    assert.deepEqual(store.getThread(chat.id)?.persona, { characterName: '公开角色' });
    assert.equal(store.getThread(generation.id)?.origin, 'generate');
    assert.equal(store.getThread(generation.id)?.agentId, 'pi');
    assert.equal(store.getThread(check.id)?.origin, 'check');
    assert.equal('model' in (store.getRun(run.id) ?? {}), false);
    assert.throws(
      () => store.createThread({
        docId: '正文/第1章.md',
        kind: 'ask',
        anchor: null,
        agentId: 'echo',
        profile: 'writer',
        persona: { characterName: '不应出现' },
      }),
      StoreValidationError,
    );
    assert.throws(
      () => store.createThread({
        docId: '角色.md',
        kind: 'chat',
        anchor: null,
        agentId: 'echo',
        profile: 'planner',
        persona: { characterName: '公开角色' },
      }),
      StoreValidationError,
    );
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('latest migration upgrades an existing version 1 database in place', () => {
  const root = tempRoot();
  const projectDir = join(root, 'alpha');
  const databasePath = join(projectDir, 'panel.sqlite3');
  try {
    mkdirSync(projectDir, { recursive: true });
    const legacy = new Database(databasePath);
    legacy.exec(MIGRATIONS[0]!.sql);
    legacy.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, 1);
    legacy.close();

    const store = new ProjectStore('alpha', projectDir);
    const threadColumns = store.db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>;
    const runColumns = store.db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
    assert.ok(threadColumns.some((column) => column.name === 'persona_json'));
    assert.ok(threadColumns.some((column) => column.name === 'origin'));
    assert.ok(threadColumns.some((column) => column.name === 'canon_json'));
    assert.ok(runColumns.some((column) => column.name === 'model'));
    assert.ok(runColumns.some((column) => column.name === 'context_manifest_json'));
    assert.ok(runColumns.some((column) => column.name === 'error_detail'));
    assert.ok(runColumns.some((column) => column.name === 'model_id'));
    assert.deepEqual(
      (store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>),
      [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }],
    );
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses a database created by a newer writing-studio version', () => {
  const root = tempRoot();
  const projectDir = join(root, 'alpha');
  try {
    const store = new ProjectStore('alpha', projectDir);
    store.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(999, Date.now());
    store.close();

    assert.throws(
      () => new ProjectStore('alpha', projectDir),
      (error: unknown) => error instanceof Error
        && error.message.includes(projectDir)
        && error.message.includes('newer writing-studio version')
        && error.message.includes('upgrade writing-studio or restore this database from a backup')
        && error.message.includes('remove panel.sqlite3-wal and panel.sqlite3-shm first'),
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('backs up only an existing database with pending migrations and keeps ordinary startup backup-free', () => {
  const root = tempRoot();
  const currentDir = join(root, 'current');
  const legacyDir = join(root, 'legacy');
  try {
    let current = new ProjectStore('current', currentDir);
    assert.deepEqual(backupNames(currentDir), []);
    current.close();
    current = new ProjectStore('current', currentDir);
    assert.deepEqual(backupNames(currentDir), []);
    current.close();

    createVersionOneDatabase(legacyDir);
    const legacy = new ProjectStore('legacy', legacyDir);
    assert.equal(backupNames(legacyDir).length, 1);
    const [backupName] = backupNames(legacyDir);
    assert.ok(backupName?.startsWith('panel.sqlite3.bak-1-'), backupName);
    const snapshot = new Database(join(legacyDir, backupName!), { readonly: true });
    try {
      assert.deepEqual(
        snapshot.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
        [{ version: 1 }],
      );
      const snapshotThreadColumns = snapshot.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>;
      assert.ok(!snapshotThreadColumns.some((column) => column.name === 'persona_json'));
    } finally {
      snapshot.close();
    }
    const created = thread(legacy);
    assert.equal(legacy.getThread(created.id)?.projectId, 'legacy');
    legacy.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('prunes migration backups to the three newest names', () => {
  const root = tempRoot();
  const projectDir = join(root, 'alpha');
  // Mixed version widths: name order would misrank bak-10 below bak-2/bak-9,
  // so this list only passes when pruning orders by the trailing timestamp.
  const fakeBackups = [
    'panel.sqlite3.bak-9-0000000000000',
    'panel.sqlite3.bak-2-0000000000001',
    'panel.sqlite3.bak-10-0000000000002',
    'panel.sqlite3.bak-1-0000000000003',
  ];
  try {
    createVersionOneDatabase(projectDir);
    for (const backup of fakeBackups) writeFileSync(join(projectDir, backup), 'placeholder');

    const store = new ProjectStore('alpha', projectDir);
    const backups = backupNames(projectDir);
    const newBackup = backups.find((backup) => !fakeBackups.includes(backup));
    assert.equal(backups.length, 3);
    assert.ok(newBackup);
    assert.deepEqual(backups, [...fakeBackups.slice(-2), newBackup].sort());
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
