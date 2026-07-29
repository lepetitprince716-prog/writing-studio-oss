import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProjectConfig, ServerEnvelope } from '@writing-studio/contract';
import type { FastifyInstance } from 'fastify';
import chokidar from 'chokidar';
import { buildApp } from '../src/app.js';
import { tcpListenerSkipReason } from './support/tcp-probe.js';
import { closeSocket, openSocket } from './support/ws-helpers.js';

// Probe whether TCP listener and chokidar watcher are available in this environment.
let _wsWatchSkipReason = await tcpListenerSkipReason();
{
  if (!_wsWatchSkipReason) {
    // Probe against a fresh empty directory: watching the shared tmpdir root
    // recursively can be slow or hit fd limits on hosts with a crowded tmpdir.
    const probeDir = await mkdtemp(join(tmpdir(), 'ws-watch-probe-'));
    const watcherOk = await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
      const watcher = chokidar.watch(probeDir, { ignoreInitial: true });
      watcher.on('error', () => settle(false));
      setTimeout(() => { watcher.close().then(() => settle(true), () => settle(false)); }, 50);
    });
    await rm(probeDir, { recursive: true, force: true });
    if (!watcherOk) {
      _wsWatchSkipReason = 'chokidar watcher probe failed in this environment';
    }
  }
}

const projectId = 'watch-project';

function config(): ProjectConfig {
  return {
    schemaVersion: 1,
    id: projectId,
    displayName: 'Watch Project',
    contentTree: {
      root: '正文',
      levels: [],
      leaf: {
        filePattern: '第{num}章.md', numberStyle: 'arabic', numberingScope: 'book', titleStripRegex: null,
      },
    },
    draftsDir: '草稿',
    sidebarSources: [{
      id: 'canon', label: '正典', file: '正典.md', parser: 'plain', parserConfig: {}, order: 1,
    }],
    aiProfiles: {
      writer: { description: 'writer', readable: [], forbidden: [], allowVaultBrowsing: false },
      planner: { description: 'planner', readable: [], forbidden: [], allowVaultBrowsing: true },
      defaultProfile: 'writer',
    },
    defaultAgentId: 'echo',
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(20);
  }
}

test('real websocket sidebar watcher sequences external SHA changes and suppresses identical content', { skip: _wsWatchSkipReason }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'writing-studio-ws-watch-'));
  const dataDir = join(root, 'data');
  const vaultRoot = join(root, 'vault');
  const registryPath = join(dataDir, 'registry.json');
  const canonPath = join(vaultRoot, '正典.md');
  let app: FastifyInstance | undefined;
  let socket: WebSocket | undefined;
  try {
    await mkdir(join(vaultRoot, '.writing-studio'), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(canonPath, '初始正典\n', 'utf8');
    await writeFile(join(vaultRoot, '.writing-studio', 'project.json'), JSON.stringify(config()), 'utf8');
    await writeFile(registryPath, JSON.stringify({
      projects: [{ id: projectId, vaultRoot, enabled: true }],
    }), 'utf8');

    app = await buildApp({ dataDir, registryPath });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const events: ServerEnvelope[] = [];
    socket = await openSocket(`${address.replace(/^http/, 'ws')}/ws?projectId=${projectId}`);
    socket.addEventListener('message', (event) => {
      events.push(JSON.parse(String(event.data)) as ServerEnvelope);
    });

    // Give chokidar a brief readiness window; the asserted change itself must
    // still be delivered in under one second.
    await delay(150);
    await writeFile(canonPath, '第一次外部修改\n', 'utf8');
    await waitFor(() => events.length >= 1, 1_000, 'first sidebar.updated');
    await writeFile(canonPath, '第二次外部修改\n', 'utf8');
    await waitFor(() => events.length >= 2, 1_000, 'second sidebar.updated');

    assert.deepEqual(events.map((event) => event.seq), [1, 2]);
    assert.deepEqual(events.map((event) => event.kind), ['sidebar.updated', 'sidebar.updated']);
    assert.deepEqual(
      events.map((event) => event.kind === 'sidebar.updated' ? event.sourceId : null),
      ['canon', 'canon'],
    );

    await writeFile(canonPath, '第二次外部修改\n', 'utf8');
    await delay(350);
    assert.equal(events.length, 2, 'identical external write must not emit a watcher event');
  } finally {
    if (socket) await closeSocket(socket);
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('sidebar watcher survives a missing or non-regular source and reports exactly one recovered update', { skip: _wsWatchSkipReason }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'writing-studio-ws-watch-recovery-'));
  const dataDir = join(root, 'data');
  const vaultRoot = join(root, 'vault');
  const registryPath = join(dataDir, 'registry.json');
  const canonPath = join(vaultRoot, '正典.md');
  let app: FastifyInstance | undefined;
  let socket: WebSocket | undefined;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await mkdir(join(vaultRoot, '.writing-studio'), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(canonPath, '初始正典\n', 'utf8');
    await writeFile(join(vaultRoot, '.writing-studio', 'project.json'), JSON.stringify(config()), 'utf8');
    await writeFile(registryPath, JSON.stringify({
      projects: [{ id: projectId, vaultRoot, enabled: true }],
    }), 'utf8');

    app = await buildApp({ dataDir, registryPath });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const events: ServerEnvelope[] = [];
    socket = await openSocket(`${address.replace(/^http/, 'ws')}/ws?projectId=${projectId}`);
    socket.addEventListener('message', (event) => {
      events.push(JSON.parse(String(event.data)) as ServerEnvelope);
    });

    await delay(150);
    // A watcher may be scheduled after an unlink but before an editor writes
    // its replacement. It must leave the prior SHA untouched and stay alive.
    await rm(canonPath);
    await delay(250);
    assert.equal(events.length, 0);

    // A transient directory at the configured file path is likewise invalid.
    await mkdir(canonPath);
    await delay(250);
    assert.equal(events.length, 0);

    await rm(canonPath, { recursive: true, force: true });
    // Let the directory removal become a distinct filesystem event before the
    // replacement arrives, matching editors that perform atomic replacement.
    await delay(150);
    await writeFile(canonPath, '恢复后的正典\n', 'utf8');
    await waitFor(() => events.length === 1, 1_000, 'recovered sidebar.updated');
    assert.deepEqual(events.map((event) => event.seq), [1]);
    assert.deepEqual(events.map((event) => event.kind), ['sidebar.updated']);
    assert.equal(unhandled.length, 0, 'read races must not escape as unhandled rejections');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    if (socket) await closeSocket(socket);
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
