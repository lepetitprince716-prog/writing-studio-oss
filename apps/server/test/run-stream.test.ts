import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type {
  AgentBackend,
  AgentEvent,
  AgentId,
  AgentStreamEnvelope,
  ProjectConfig,
  SendOptions,
  ThreadRunContext,
} from '@writing-studio/contract';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { tcpListenerSkipReason } from './support/tcp-probe.js';
import { closeSocket, openSocket } from './support/ws-helpers.js';

const PROJECT_ID = 'stream-project';
const DOC_ID = '正文/第1章.md';
const tcpListenSkipReason = await tcpListenerSkipReason();

function projectConfig(): ProjectConfig {
  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    displayName: 'Stream Project',
    contentTree: {
      root: '正文', levels: [],
      leaf: { filePattern: '第{num}章.md', numberStyle: 'arabic', numberingScope: 'book', titleStripRegex: null },
    },
    draftsDir: '草稿',
    sidebarSources: [{
      id: 'characters',
      label: 'Characters',
      file: '角色.md',
      parser: 'heading-sections',
      parserConfig: {
        kind: 'characters',
        cardHeadingLevel: 2,
        sectionHeadingLevel: 3,
        authorOnlyMarkers: ['作者侧'],
      },
      order: 1,
    }],
    aiProfiles: {
      writer: { description: 'writer', readable: ['正文/**'], forbidden: [], allowVaultBrowsing: false },
      planner: { description: 'planner', readable: ['正文/**'], forbidden: [], allowVaultBrowsing: true },
      defaultProfile: 'writer',
    },
    defaultAgentId: 'echo',
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(15);
  }
}

function customEcho(events: AgentEvent[]): AgentBackend {
  return {
    id: 'echo', displayName: 'test echo',
    async probeAvailability() {
      return {
        agentId: 'echo',
        ok: true,
        supportedProfiles: ['writer', 'planner'],
        version: 'test',
        binaryPath: '(test)',
        error: null,
      };
    },
    async *send() {
      for (const event of events) yield event;
    },
  };
}

function terminalBackend(id: AgentId, calls: SendOptions[] = []): AgentBackend {
  return {
    id,
    displayName: `${id} terminal test backend`,
    async probeAvailability() {
      return {
        agentId: id,
        ok: true,
        supportedProfiles: ['writer', 'planner'],
        version: 'test',
        binaryPath: '(test)',
        error: null,
      };
    },
    async *send(_context, _message, options) {
      calls.push(options);
      const nativeSessionId = `${id}-session-${calls.length}`;
      yield { type: 'session', nativeSessionId };
      yield { type: 'result', content: `${id} result` };
      yield { type: 'done', stopReason: 'end_turn', nativeSessionId, strategyUsed: 'history-replay' };
    },
  };
}

interface AppFixture {
  root: string;
  dataDir: string;
  registryPath: string;
  vaultRoot: string;
}

async function makeFixture(): Promise<AppFixture> {
  const root = await mkdtemp(join(tmpdir(), 'writing-studio-run-stream-'));
  const dataDir = join(root, 'data');
  const vaultRoot = join(root, 'vault');
  const registryPath = join(dataDir, 'registry.json');
  await mkdir(join(vaultRoot, '.writing-studio'), { recursive: true });
  await mkdir(join(vaultRoot, '正文'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(vaultRoot, '.writing-studio', 'project.json'), JSON.stringify(projectConfig()), 'utf8');
  await writeFile(join(vaultRoot, DOC_ID), '# 第1章\n\n流式测试正文。\n', 'utf8');
  await writeFile(join(vaultRoot, '角色.md'), [
    '## 角色D',
    '### 公开经历',
    '她只知道已公开的过去。',
    '### 作者侧·未公开',
    'AUTHOR_ONLY：角色D不知道的未来秘密。',
    '## 角色E',
    '### 公开经历',
    '另一名角色的公开信息。',
  ].join('\n'), 'utf8');
  await writeFile(registryPath, JSON.stringify({ projects: [{ id: PROJECT_ID, vaultRoot, enabled: true }] }), 'utf8');
  return { root, dataDir, registryPath, vaultRoot };
}

async function start(app: FastifyInstance): Promise<string> {
  return app.listen({ port: 0, host: '127.0.0.1' });
}

async function createThread(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST', url: '/api/threads', payload: { projectId: PROJECT_ID, docId: DOC_ID, kind: 'ask' },
  });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { data: { id: string } }).data.id;
}

async function startRun(
  app: FastifyInstance,
  threadId: string,
  agentId?: 'claude' | 'codex' | 'echo',
  model?: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST', url: `/api/threads/${threadId}/messages`, payload: {
      content: 'stream assertion',
      ...(agentId ? { agentId } : {}),
      ...(model ? { model } : {}),
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { data: { runId: string } }).data.runId;
}

async function withRunningApp(
  backend: AgentBackend | ReadonlyMap<AgentId, AgentBackend> | undefined,
  run: (app: FastifyInstance, events: AgentStreamEnvelope[], fixture: AppFixture) => Promise<void>,
  options: { runTimeoutMs?: number; generateTimeoutMs?: number } = {},
): Promise<void> {
  const fixture = await makeFixture();
  let app: FastifyInstance | undefined;
  let socket: WebSocket | undefined;
  try {
    app = await buildApp({
      dataDir: fixture.dataDir, registryPath: fixture.registryPath, watchSidebar: false,
      ...(backend ? {
        backends: backend instanceof Map
          ? backend
          : new Map([['echo', backend]]),
      } : {}),
      ...options,
    });
    const address = await start(app);
    const events: AgentStreamEnvelope[] = [];
    socket = await openSocket(`${address.replace(/^http/, 'ws')}/ws?projectId=${PROJECT_ID}`);
    socket.addEventListener('message', (event) => {
      const parsed = JSON.parse(String(event.data)) as AgentStreamEnvelope;
      if (parsed.kind === 'agent') events.push(parsed);
    });
    await run(app, events, fixture);
  } finally {
    await closeSocket(socket);
    await app?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test('echo emits an ordered AgentStreamEnvelope sequence with contiguous seq and one terminal', { skip: tcpListenSkipReason }, async () => {
  await withRunningApp(undefined, async (app, events, fixture) => {
    const threadId = await createThread(app);
    const runId = await startRun(app, threadId);
    await waitFor(() => events.some((event) => event.runId === runId && event.event.type === 'done'), 'echo terminal');
    const runEvents = events.filter((event) => event.runId === runId);
    assert.deepEqual(runEvents.map((event) => event.seq), runEvents.map((_event, index) => index + 1));
    const types = runEvents.map((event) => event.event.type);
    assert.equal(types[0], 'session');
    assert.equal(types.at(-2), 'result');
    assert.equal(types.at(-1), 'done');
    assert.ok(types.slice(1, -2).every((type) => type === 'delta'));
    assert.equal(runEvents.filter((event) => event.event.type === 'done' || event.event.type === 'error').length, 1);
    assert.equal(runEvents.every((event) => event.manifest?.length === 1), true);
    assert.deepEqual(runEvents.at(-1)?.manifest?.map((entry) => entry.sourceId), [
      `document:${DOC_ID}`,
    ]);
    const db = new Database(join(fixture.dataDir, PROJECT_ID, 'panel.sqlite3'), { readonly: true });
    try {
      const row = db.prepare('SELECT context_manifest_json FROM runs WHERE id = ?').get(runId) as {
        context_manifest_json: string | null;
      };
      assert.deepEqual(JSON.parse(row.context_manifest_json ?? 'null'), runEvents.at(-1)?.manifest);
    } finally {
      db.close();
    }
  });
});

test('message model is passed through verbatim, defaults to null, and remains internal to Run DTOs', { skip: tcpListenSkipReason }, async () => {
  const calls: SendOptions[] = [];
  await withRunningApp(terminalBackend('echo', calls), async (app, events, fixture) => {
    const threadId = await createThread(app);
    const selectedRunId = await startRun(app, threadId, undefined, 'echo-verbose');
    await waitFor(
      () => events.some((event) => event.runId === selectedRunId && event.event.type === 'done'),
      'selected-model terminal',
    );
    const defaultRunId = await startRun(app, threadId);
    await waitFor(
      () => events.some((event) => event.runId === defaultRunId && event.event.type === 'done'),
      'default-model terminal',
    );

    assert.deepEqual(calls.map((options) => options.model), ['echo-verbose', null]);
    const db = new Database(join(fixture.dataDir, PROJECT_ID, 'panel.sqlite3'), { readonly: true });
    try {
      assert.deepEqual(
        db.prepare('SELECT id, model FROM runs ORDER BY created_at, id').all(),
        [
          { id: selectedRunId, model: 'echo-verbose' },
          { id: defaultRunId, model: null },
        ],
      );
    } finally {
      db.close();
    }

    const publicRun = await app.inject({ method: 'GET', url: `/api/runs/${selectedRunId}` });
    assert.equal(publicRun.statusCode, 200, publicRun.body);
    assert.equal('model' in (publicRun.json() as { data: Record<string, unknown> }).data, false);
  });
});

test('an agent-reported actual model id is persisted and recoverable from the Run DTO', async () => {
  const backend: AgentBackend = {
    id: 'claude',
    displayName: 'model-id test backend',
    async probeAvailability() {
      return {
        agentId: 'claude',
        ok: true,
        supportedProfiles: ['writer'],
        version: 'test',
        binaryPath: '(test)',
        error: null,
      };
    },
    async *send() {
      yield { type: 'model', modelId: 'claude-sonnet-test' };
      yield { type: 'result', content: 'claude result' };
      yield {
        type: 'done',
        stopReason: 'end_turn',
        nativeSessionId: null,
        strategyUsed: 'history-replay',
      };
    },
  };
  const fixture = await makeFixture();
  const app = await buildApp({
    dataDir: fixture.dataDir,
    registryPath: fixture.registryPath,
    watchSidebar: false,
    backends: new Map([['claude', backend]]),
  });
  try {
    const runId = await startRun(app, await createThread(app), 'claude');
    await waitFor(
      async () => {
        const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
        return (response.json() as { data: { status: string } }).data.status === 'completed';
      },
      'actual-model terminal',
    );
    const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      (response.json() as { data: { modelId?: string } }).data.modelId,
      'claude-sonnet-test',
    );
    const db = new Database(join(fixture.dataDir, PROJECT_ID, 'panel.sqlite3'), { readonly: true });
    try {
      assert.deepEqual(
        db.prepare('SELECT model_id FROM runs WHERE id = ?').get(runId),
        { model_id: 'claude-sonnet-test' },
      );
    } finally {
      db.close();
    }
  } finally {
    await app.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('runTimeoutMs injection reaches the backend exactly', { skip: tcpListenSkipReason }, async () => {
  const calls: SendOptions[] = [];
  await withRunningApp(
    terminalBackend('echo', calls),
    async (app, events) => {
      const runId = await startRun(app, await createThread(app));
      await waitFor(
        () => events.some((event) => event.runId === runId && event.event.type === 'done'),
        'injected-timeout terminal',
      );
    },
    { runTimeoutMs: 1_234 },
  );
  assert.deepEqual(calls.map((options) => options.timeoutMs), [1_234]);
  assert.equal(calls[0]?.responseSchema, null);
});

test('conflict-check route reuses its ask thread and persists validated structured findings', async () => {
  const calls: SendOptions[] = [];
  const backend: AgentBackend = {
    id: 'echo',
    displayName: 'structured check backend',
    async probeAvailability() {
      return {
        agentId: 'echo', ok: true, supportedProfiles: ['writer'],
        version: 'test', binaryPath: '(test)', error: null,
      };
    },
    async *send(_context, _message, options) {
      calls.push(options);
      const data = {
        findings: [{
          claimInText: '角色D没去过地点A',
          textQuote: '没去过地点A',
          canonSource: {
            docId: calls.length === 1 ? '角色.md' : '未注入正典.md',
            heading: '角色D / 公开经历',
          },
          conflictType: 'character' as const,
          severity: 'high' as const,
          explanation: '角色卡记载她去过地点A。',
        }],
      };
      yield { type: 'structured', data, valid: true, raw: JSON.stringify(data) };
      yield { type: 'result', content: JSON.stringify(data) };
      yield {
        type: 'done', stopReason: 'end_turn', nativeSessionId: null,
        strategyUsed: 'history-replay',
      };
    },
  };
  const fixture = await makeFixture();
  const config = projectConfig();
  config.aiProfiles.writer.readable = ['正文/**', '角色.md'];
  config.aiProfiles.writer.contextSources = ['characters'];
  await writeFile(
    join(fixture.vaultRoot, '.writing-studio', 'project.json'),
    JSON.stringify(config),
    'utf8',
  );
  await writeFile(
    join(fixture.vaultRoot, DOC_ID),
    '# 第1章\n\n角色D没去过地点A。\n',
    'utf8',
  );
  const app = await buildApp({
    dataDir: fixture.dataDir,
    registryPath: fixture.registryPath,
    watchSidebar: false,
    backends: new Map([['echo', backend]]),
  });
  try {
    const startCheck = async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${PROJECT_ID}/documents/${encodeURIComponent(DOC_ID)}/conflict-check`,
        payload: {},
      });
      assert.equal(response.statusCode, 200, response.body);
      return (response.json() as { data: { threadId: string; runId: string } }).data;
    };
    const first = await startCheck();
    await waitFor(async () => {
      const response = await app.inject({ method: 'GET', url: `/api/runs/${first.runId}` });
      return (response.json() as { data: { status: string } }).data.status === 'completed';
    }, 'structured conflict check');
    const durable = await app.inject({ method: 'GET', url: `/api/threads/${first.threadId}` });
    const messages = (durable.json() as {
      data: { messages: Array<{ role: string; structured: unknown }> };
    }).data.messages;
    assert.deepEqual(
      messages.find((message) => message.role === 'assistant')?.structured,
      {
        findings: [{
          claimInText: '角色D没去过地点A',
          textQuote: '没去过地点A',
          canonSource: { docId: '角色.md', heading: '角色D / 公开经历' },
          conflictType: 'character',
          severity: 'high',
          explanation: '角色卡记载她去过地点A。',
        }],
      },
    );
    const second = await startCheck();
    assert.equal(second.threadId, first.threadId);
    await waitFor(async () => {
      const response = await app.inject({ method: 'GET', url: `/api/runs/${second.runId}` });
      return (response.json() as { data: { status: string } }).data.status === 'completed';
    }, 'reused conflict check');
    const secondDurable = await app.inject({ method: 'GET', url: `/api/threads/${second.threadId}` });
    const secondAssistant = [...(secondDurable.json() as {
      data: { messages: Array<{ role: string; structured: unknown }> };
    }).data.messages].reverse().find((message) => message.role === 'assistant');
    assert.equal(secondAssistant?.structured, null, 'invented canon docId must fall back to raw text');
    assert.equal(
      (calls[0]?.responseSchema as { required?: string[] } | undefined)?.required?.includes('findings'),
      true,
    );
  } finally {
    await app.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('echo conflict-check keeps raw assistant text when its structured shape is invalid', async () => {
  const fixture = await makeFixture();
  const app = await buildApp({
    dataDir: fixture.dataDir,
    registryPath: fixture.registryPath,
    watchSidebar: false,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/documents/${encodeURIComponent(DOC_ID)}/conflict-check`,
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const { threadId, runId } = (response.json() as {
      data: { threadId: string; runId: string };
    }).data;
    await waitFor(async () => {
      const run = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
      return (run.json() as { data: { status: string } }).data.status === 'completed';
    }, 'echo conflict fallback');
    const durable = await app.inject({ method: 'GET', url: `/api/threads/${threadId}` });
    const assistant = (durable.json() as {
      data: { messages: Array<{ role: string; content: string; structured: unknown }> };
    }).data.messages.find((message) => message.role === 'assistant');
    assert.equal(assistant?.structured, null);
    assert.match(assistant?.content ?? '', /echo 改写占位/);
  } finally {
    await app.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('generation threads receive the independent timeout budget', async () => {
  const calls: SendOptions[] = [];
  const fixture = await makeFixture();
  const app = await buildApp({
    dataDir: fixture.dataDir,
    registryPath: fixture.registryPath,
    watchSidebar: false,
    backends: new Map([['echo', terminalBackend('echo', calls)]]),
    runTimeoutMs: 9_999,
    generateTimeoutMs: 1_234,
  });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: {
        projectId: PROJECT_ID,
        docId: DOC_ID,
        kind: 'rewrite',
        origin: 'generate',
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const threadId = (created.json() as { data: { id: string } }).data.id;
    const runId = await startRun(app, threadId);
    await waitFor(
      () => calls.length === 1,
      `generation backend call ${runId}`,
    );
  } finally {
    await app.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.deepEqual(calls.map((options) => options.timeoutMs), [1_234]);
});

test('generation deadline persists timeout and releases the thread without a socket', async () => {
  const backend: AgentBackend = {
    id: 'echo',
    displayName: 'slow generation backend',
    async probeAvailability() {
      return {
        agentId: 'echo',
        ok: true,
        supportedProfiles: ['writer'],
        version: 'test',
        binaryPath: '(test)',
        error: null,
      };
    },
    async *send(_context, _message, options) {
      while (!options.signal.aborted) await delay(2);
      yield {
        type: 'done',
        stopReason: 'cancelled',
        nativeSessionId: null,
        strategyUsed: 'history-replay',
      };
    },
  };
  const fixture = await makeFixture();
  const app = await buildApp({
    dataDir: fixture.dataDir,
    registryPath: fixture.registryPath,
    watchSidebar: false,
    backends: new Map([['echo', backend]]),
    runTimeoutMs: 9_999,
    generateTimeoutMs: 5,
  });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: {
        projectId: PROJECT_ID,
        docId: DOC_ID,
        kind: 'rewrite',
        origin: 'generate',
      },
    });
    const threadId = (created.json() as { data: { id: string } }).data.id;
    const runId = await startRun(app, threadId);
    let recovered: { status: string; errorCode: string | null } | undefined;
    await waitFor(async () => {
      const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
      recovered = (response.json() as {
        data: { status: string; errorCode: string | null };
      }).data;
      return recovered.status !== 'running';
    }, 'generation timeout persistence');
    assert.equal(recovered?.status, 'failed');
    assert.equal(recovered?.errorCode, 'timeout');

    const retry = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: 'retry after timeout' },
    });
    assert.equal(retry.statusCode, 200, retry.body);
  } finally {
    await app.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('coordinator deadline stops Echo as timeout, fails the run, and clears the active thread', { skip: tcpListenSkipReason }, async () => {
  await withRunningApp(undefined, async (app, events, fixture) => {
    const threadId = await createThread(app);
    const firstRunId = await startRun(app, threadId);
    await waitFor(
      () => events.some((event) => event.runId === firstRunId && event.event.type === 'done'),
      'Echo timeout terminal',
    );
    await delay(20);

    const firstEvents = events.filter((event) => event.runId === firstRunId);
    const terminal = firstEvents.find((event) => event.event.type === 'done');
    assert.equal(terminal?.event.type, 'done');
    if (terminal?.event.type === 'done') assert.equal(terminal.event.stopReason, 'timeout');
    assert.equal(firstEvents.filter((event) => event.event.type === 'done' || event.event.type === 'error').length, 1);

    const db = new Database(join(fixture.dataDir, PROJECT_ID, 'panel.sqlite3'), { readonly: true });
    try {
      assert.deepEqual(
        db.prepare('SELECT status, error_code FROM runs WHERE id = ?').get(firstRunId),
        { status: 'failed', error_code: 'timeout' },
      );
    } finally {
      db.close();
    }

    // A second request proves the coordinator removed the timed-out run from
    // its in-memory active map instead of leaving the thread busy.
    const secondRunId = await startRun(app, threadId);
    assert.notEqual(secondRunId, firstRunId);
    await waitFor(
      () => events.some((event) => event.runId === secondRunId && event.event.type === 'done'),
      'second Echo timeout terminal',
    );
  }, { runTimeoutMs: 1 });
});

test('manual stop remains cancelled when backend cleanup outlasts the deadline', { skip: tcpListenSkipReason }, async () => {
  const backend: AgentBackend = {
    id: 'echo',
    displayName: 'slow cancellation cleanup',
    async probeAvailability() {
      return { agentId: 'echo', ok: true, supportedProfiles: ['writer'], version: 'test', binaryPath: '(test)', error: null };
    },
    async *send(_context, _message, options) {
      yield { type: 'session', nativeSessionId: 'slow-cancel-session' };
      await delay(30);
      assert.equal(options.signal.aborted, true);
      yield {
        type: 'done', stopReason: 'cancelled', nativeSessionId: 'slow-cancel-session', strategyUsed: 'history-replay',
      };
    },
  };
  await withRunningApp(backend, async (app, events, fixture) => {
    const threadId = await createThread(app);
    const runId = await startRun(app, threadId);
    const stopped = await app.inject({ method: 'POST', url: `/api/threads/${threadId}/stop` });
    assert.equal(stopped.statusCode, 200, stopped.body);
    assert.equal((stopped.json() as { data: { stopped: boolean } }).data.stopped, true);
    await waitFor(
      () => events.some((event) => event.runId === runId && event.event.type === 'done'),
      'manual cancellation terminal',
    );
    const terminal = events.find((event) => event.runId === runId && event.event.type === 'done');
    assert.equal(terminal?.event.type, 'done');
    if (terminal?.event.type === 'done') assert.equal(terminal.event.stopReason, 'cancelled');

    const db = new Database(join(fixture.dataDir, PROJECT_ID, 'panel.sqlite3'), { readonly: true });
    try {
      assert.deepEqual(
        db.prepare('SELECT status, error_code FROM runs WHERE id = ?').get(runId),
        { status: 'cancelled', error_code: null },
      );
    } finally {
      db.close();
    }
  }, { runTimeoutMs: 10 });
});

test('message model rejects CLI-flag injection before a run starts', { skip: tcpListenSkipReason }, async () => {
  const calls: SendOptions[] = [];
  await withRunningApp(terminalBackend('echo', calls), async (app) => {
    const threadId = await createThread(app);
    for (const model of ['--evil', '-x', 'x;rm', ' ', 'x'.repeat(121)]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/messages`,
        payload: { content: 'must be rejected', model },
      });
      assert.equal(response.statusCode, 400, `${model}: ${response.body}`);
      assert.equal((response.json() as { error: { code: string } }).error.code, 'VALIDATION');
    }
  });
  assert.deepEqual(calls, []);
});

test('agents endpoint returns a model list for every configured backend', { skip: tcpListenSkipReason }, async () => {
  const backends = new Map<AgentId, AgentBackend>([
    ['claude', terminalBackend('claude')],
    ['codex', terminalBackend('codex')],
    ['opencode', terminalBackend('opencode')],
    ['pi', terminalBackend('pi')],
    ['grok', terminalBackend('grok')],
    ['echo', terminalBackend('echo')],
  ]);
  await withRunningApp(backends, async (app) => {
    const response = await app.inject({ method: 'GET', url: '/api/agents' });
    assert.equal(response.statusCode, 200, response.body);
    const agents = (response.json() as { data: Array<{ agentId: AgentId; models?: unknown }> }).data;
    assert.deepEqual(agents.map((agent) => agent.agentId), ['claude', 'codex', 'opencode', 'pi', 'grok', 'echo']);
    assert.ok(agents.every((agent) => Array.isArray(agent.models)));
    assert.deepEqual(
      (agents.find((agent) => agent.agentId === 'claude')?.models as Array<{ id: string }>).map((model) => model.id),
      ['sonnet', 'opus', 'haiku'],
    );
    assert.deepEqual(
      (agents.find((agent) => agent.agentId === 'echo')?.models as Array<{ id: string }>).map((model) => model.id),
      ['echo-1', 'echo-verbose'],
    );
  });
});

test('chat persona context contains only the selected writer-safe card and never enables vault browsing', { skip: tcpListenSkipReason }, async () => {
  const contexts: ThreadRunContext[] = [];
  const backend: AgentBackend = {
    id: 'echo',
    displayName: 'chat context capture',
    async probeAvailability() {
      return {
        agentId: 'echo',
        ok: true,
        supportedProfiles: ['writer', 'planner'],
        version: 'test',
        binaryPath: '(test)',
        error: null,
      };
    },
    async *send(context) {
      contexts.push(context);
      yield { type: 'session', nativeSessionId: 'chat-context-session' };
      yield { type: 'result', content: 'roleplay response' };
      yield {
        type: 'done',
        stopReason: 'end_turn',
        nativeSessionId: 'chat-context-session',
        strategyUsed: 'history-replay',
      };
    },
  };
  await withRunningApp(backend, async (app, events) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: {
        projectId: PROJECT_ID,
        docId: '角色.md',
        kind: 'chat',
        persona: { characterName: '角色D' },
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const threadId = (created.json() as { data: { id: string } }).data.id;
    const runId = await startRun(app, threadId);
    await waitFor(
      () => events.some((event) => event.runId === runId && event.event.type === 'done'),
      'chat persona terminal',
    );
  });
  assert.equal(contexts.length, 1);
  const context = contexts[0]!;
  assert.equal(context.allowVaultBrowsing, false);
  assert.match(context.contextBlock, /角色D/);
  assert.match(context.contextBlock, /只知道已公开的过去/);
  assert.doesNotMatch(context.contextBlock, /AUTHOR_ONLY|未来秘密|角色E|另一名角色/);
});

test('a backend that ends without terminal event receives exactly one coordinator error envelope', { skip: tcpListenSkipReason }, async () => {
  const backend = customEcho([
    { type: 'session', nativeSessionId: 'test-session' },
    { type: 'delta', text: 'partial' },
  ]);
  await withRunningApp(backend, async (app, events) => {
    const runId = await startRun(app, await createThread(app));
    await waitFor(() => events.some((event) => event.runId === runId && event.event.type === 'error'), 'coordinator error');
    const runEvents = events.filter((event) => event.runId === runId);
    const terminals = runEvents.filter((event) => event.event.type === 'done' || event.event.type === 'error');
    assert.deepEqual(runEvents.map((event) => event.event.type), ['session', 'delta', 'error']);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.event.type, 'error');
    if (terminals[0]?.event.type === 'error') assert.equal(terminals[0].event.code, 'process_error');
  });
});

test('a backend that emits two terminal events broadcasts only its first terminal', { skip: tcpListenSkipReason }, async () => {
  const backend = customEcho([
    { type: 'session', nativeSessionId: 'test-session' },
    { type: 'result', content: 'first terminal wins' },
    { type: 'done', stopReason: 'end_turn', nativeSessionId: 'test-session', strategyUsed: 'history-replay' },
    { type: 'error', code: 'process_error', message: 'must be ignored', retryable: false },
  ]);
  await withRunningApp(backend, async (app, events) => {
    const runId = await startRun(app, await createThread(app));
    await waitFor(() => events.some((event) => event.runId === runId && event.event.type === 'done'), 'first terminal');
    await delay(80);
    const runEvents = events.filter((event) => event.runId === runId);
    assert.deepEqual(runEvents.map((event) => event.event.type), ['session', 'result', 'done']);
    assert.equal(runEvents.filter((event) => event.event.type === 'done' || event.event.type === 'error').length, 1);
  });
});

test('a terminal nativeSessionId null invalidates an earlier session event and forces the next run to replay', { skip: tcpListenSkipReason }, async () => {
  const calls: Array<{ historyLength: number; nativeSessionId: string | null }> = [];
  let turn = 0;
  const backend: AgentBackend = {
    id: 'echo', displayName: 'null terminal session test',
    async probeAvailability() {
      return {
        agentId: 'echo',
        ok: true,
        supportedProfiles: ['writer', 'planner'],
        version: 'test',
        binaryPath: '(test)',
        error: null,
      };
    },
    async *send(ctx, userMessage) {
      calls.push({ historyLength: ctx.history.length, nativeSessionId: ctx.session?.nativeSessionId ?? null });
      turn += 1;
      yield { type: 'session', nativeSessionId: `hidden-${turn}` };
      yield { type: 'result', content: `reply ${userMessage}` };
      yield { type: 'done', stopReason: 'end_turn', nativeSessionId: null, strategyUsed: 'history-replay' };
    },
  };
  await withRunningApp(backend, async (app, events, fixture) => {
    const threadId = await createThread(app);
    const seed = new Database(join(fixture.dataDir, PROJECT_ID, 'panel.sqlite3'));
    try {
      seed.prepare(`INSERT INTO agent_sessions
        (thread_id, agent_id, native_session_id, last_synced_message_count, created_at, last_used_at)
        VALUES (?, 'echo', 'stale-native-session', 0, 0, 0)`).run(threadId);
    } finally {
      seed.close();
    }
    for (let index = 0; index < 2; index += 1) {
      const runId = await startRun(app, threadId);
      await waitFor(() => events.some((event) => event.runId === runId && event.event.type === 'done'), `null terminal ${index}`);
    }
    const verify = new Database(join(fixture.dataDir, PROJECT_ID, 'panel.sqlite3'), { readonly: true });
    try {
      assert.equal((verify.prepare('SELECT COUNT(*) AS count FROM agent_sessions').get() as { count: number }).count, 0);
    } finally {
      verify.close();
    }
  });
  assert.deepEqual(calls, [
    { historyLength: 0, nativeSessionId: 'stale-native-session' },
    { historyLength: 2, nativeSessionId: null },
  ]);
});

test('a persistence failure rolls back success state and replaces buffered done with one error', { skip: tcpListenSkipReason }, async () => {
  const backend = customEcho([
    { type: 'session', nativeSessionId: 'should-not-persist' },
    { type: 'result', content: 'should-not-persist' },
    { type: 'done', stopReason: 'end_turn', nativeSessionId: 'should-not-persist', strategyUsed: 'history-replay' },
  ]);
  await withRunningApp(backend, async (app, events, fixture) => {
    const db = new Database(join(fixture.dataDir, PROJECT_ID, 'panel.sqlite3'));
    try {
      db.exec(`CREATE TRIGGER fail_completed_run
        BEFORE UPDATE OF status ON runs
        WHEN NEW.status = 'completed'
        BEGIN SELECT RAISE(ABORT, 'injected finalization failure'); END;`);
    } finally {
      db.close();
    }
    const threadId = await createThread(app);
    const runId = await startRun(app, threadId);
    await waitFor(() => events.some((event) => event.runId === runId && event.event.type === 'error'), 'persistence error');
    const runEvents = events.filter((event) => event.runId === runId);
    assert.deepEqual(runEvents.map((event) => event.event.type), ['session', 'result', 'error']);
    assert.equal(runEvents.filter((event) => event.event.type === 'done' || event.event.type === 'error').length, 1);
    const thread = await app.inject({ method: 'GET', url: `/api/threads/${threadId}` });
    assert.equal(thread.statusCode, 200);
    assert.equal((thread.json() as { data: { messages: unknown[] } }).data.messages.length, 1, 'assistant insert must have rolled back');
    const verify = new Database(join(fixture.dataDir, PROJECT_ID, 'panel.sqlite3'), { readonly: true });
    try {
      assert.deepEqual(
        verify.prepare('SELECT status, error_code FROM runs WHERE id = ?').get(runId),
        { status: 'failed', error_code: 'process_error' },
      );
      assert.equal((verify.prepare('SELECT COUNT(*) AS count FROM agent_sessions').get() as { count: number }).count, 0);
    } finally {
      verify.close();
    }
  });
});

function capturingBackend(
  id: 'claude' | 'codex',
  calls: Array<{ historyLength: number; nativeSessionId: string | null; lastSyncedMessageCount: number | null }>,
): AgentBackend {
  let turn = 0;
  return {
    id,
    displayName: `${id} test backend`,
    async probeAvailability() {
      return {
        agentId: id,
        ok: true,
        // Real claude/codex adapters report only ['writer'] (adapter.ts).
        supportedProfiles: ['writer'],
        version: 'test',
        binaryPath: '(test)',
        error: null,
      };
    },
    async *send(ctx, userMessage) {
      calls.push({
        historyLength: ctx.history.length,
        nativeSessionId: ctx.session?.nativeSessionId ?? null,
        lastSyncedMessageCount: ctx.session?.lastSyncedMessageCount ?? null,
      });
      turn += 1;
      const strategyUsed = ctx.session?.nativeSessionId && ctx.session.lastSyncedMessageCount === ctx.history.length
        ? 'native-resume'
        : 'history-replay';
      const nativeSessionId = `${id}-native-${turn}`;
      yield { type: 'session', nativeSessionId };
      yield { type: 'result', content: `${id} reply to ${userMessage}` };
      yield { type: 'done', stopReason: 'end_turn', nativeSessionId, strategyUsed };
    },
  };
}

test('RunCoordinator replays when switching agents and resumes only the caught-up native session', { skip: tcpListenSkipReason }, async () => {
  const claudeCalls: Array<{ historyLength: number; nativeSessionId: string | null; lastSyncedMessageCount: number | null }> = [];
  const codexCalls: Array<{ historyLength: number; nativeSessionId: string | null; lastSyncedMessageCount: number | null }> = [];
  const backends = new Map<'claude' | 'codex', AgentBackend>([
    ['claude', capturingBackend('claude', claudeCalls)],
    ['codex', capturingBackend('codex', codexCalls)],
  ]);
  await withRunningApp(backends, async (app, events) => {
    const create = await app.inject({
      method: 'POST', url: '/api/threads',
      payload: { projectId: PROJECT_ID, docId: DOC_ID, kind: 'ask', agentId: 'claude' },
    });
    assert.equal(create.statusCode, 200, create.body);
    const threadId = (create.json() as { data: { id: string } }).data.id;
    for (const agentId of [undefined, 'codex', 'claude', undefined] as const) {
      const runId = await startRun(app, threadId, agentId);
      await waitFor(() => events.some((event) => event.runId === runId && event.event.type === 'done'), `terminal ${runId}`);
    }
  });
  assert.deepEqual(claudeCalls, [
    { historyLength: 0, nativeSessionId: null, lastSyncedMessageCount: null },
    { historyLength: 4, nativeSessionId: 'claude-native-1', lastSyncedMessageCount: 2 },
    { historyLength: 6, nativeSessionId: 'claude-native-2', lastSyncedMessageCount: 6 },
  ]);
  assert.deepEqual(codexCalls, [
    { historyLength: 2, nativeSessionId: null, lastSyncedMessageCount: null },
  ]);
});
