import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProjectConfig } from '@writing-studio/contract';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { tcpListenerSkipReason } from './support/tcp-probe.js';

const projectId = 'boundary-project';
const tcpListenSkipReason = await tcpListenerSkipReason();

function config(): ProjectConfig {
  return {
    schemaVersion: 1,
    id: projectId,
    displayName: 'Boundary Project',
    contentTree: {
      root: '正文', levels: [],
      leaf: { filePattern: '第{num}章.md', numberStyle: 'arabic', numberingScope: 'book', titleStripRegex: null },
    },
    draftsDir: '草稿',
    sidebarSources: [],
    aiProfiles: {
      writer: { description: 'writer', readable: [], forbidden: [], allowVaultBrowsing: false },
      planner: { description: 'planner', readable: [], forbidden: [], allowVaultBrowsing: true },
      defaultProfile: 'writer',
    },
    defaultAgentId: 'echo',
  };
}

async function websocketUpgrade(port: number, origin?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let response = '';
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      // Do not resolve the upgrade helper until its raw TCP peer is actually
      // closed; otherwise app.close can race a just-upgraded connection.
      socket.once('close', () => {
        resolvePromise(value);
      });
      socket.destroy();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once('error', (error) => {
      fail(error);
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('\r\n\r\n')) finish(response);
    });
    socket.on('end', () => finish(response));
    // A rejected upgrade may close with a TCP reset and no `end` event.
    socket.on('close', () => finish(response));
    socket.write([
      `GET /ws?projectId=${projectId} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ...(origin === undefined ? [] : [`Origin: ${origin}`]),
      '', '',
    ].join('\r\n'));
  });
}

/** Open a real upgrade then drop TCP without a WebSocket close handshake. */
async function abruptWebSocketUpgrade(port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let response = '';
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once('error', fail);
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (!response.includes('\r\n\r\n')) return;
      if (!response.startsWith('HTTP/1.1 101 ')) {
        fail(new Error(`expected 101 upgrade, got ${response.slice(0, 80)}`));
        return;
      }
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise();
    });
    socket.write([
      `GET /ws?projectId=${projectId} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '', '',
    ].join('\r\n'));
  });
}

async function openWebSocket(url: string, origin?: string): Promise<WebSocket> {
  // Node's WebSocket implementation accepts the Undici `headers` option at
  // runtime, while the current ambient DOM type exposes only `protocols`.
  const socket = new WebSocket(
    url,
    ...(origin === undefined ? [] : [{ headers: { origin } } as never]),
  );
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.removeEventListener('error', fail);
      resolvePromise();
    };
    const fail = (): void => {
      if (settled) return;
      settled = true;
      reject(new Error('websocket connection failed'));
    };
    socket.addEventListener('open', finish, { once: true });
    socket.addEventListener('error', fail, { once: true });
  });
  return socket;
}

function socketClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    // A forced server termination can emit error before close. Close is the
    // terminal signal we assert, so leave error non-fatal and wait for it.
    socket.addEventListener('error', () => undefined, { once: true });
    socket.addEventListener('close', finish, { once: true });
  });
}

async function beforeDeadline<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

test('localhost Host and Origin gate protects REST and WebSocket upgrades', { timeout: 5_000, skip: tcpListenSkipReason }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'writing-studio-local-boundary-'));
  const dataDir = join(root, 'data');
  const vaultRoot = join(root, 'vault');
  const registryPath = join(dataDir, 'registry.json');
  let app: FastifyInstance | undefined;
  try {
    await mkdir(join(vaultRoot, '.writing-studio'), { recursive: true });
    await mkdir(join(vaultRoot, '正文'), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(vaultRoot, '.writing-studio', 'project.json'), JSON.stringify(config()));
    await writeFile(registryPath, JSON.stringify({
      projects: [{ id: projectId, vaultRoot, enabled: true }],
    }));

    app = await buildApp({ dataDir, registryPath, watchSidebar: false });

    // This is intentionally a DNS-rebinding/browser boundary, not process
    // authentication. A local CLI has no Origin and remains supported.
    const noOrigin = await beforeDeadline(app.inject({
      method: 'GET', url: '/api/projects', headers: { host: '127.0.0.1:8787' },
    }), 'originless REST');
    assert.equal(noOrigin.statusCode, 200);
    const viteOrigin = await beforeDeadline(app.inject({
      method: 'GET', url: '/api/projects',
      headers: { host: 'localhost:8787', origin: 'http://localhost:5183' },
    }), 'Vite REST');
    assert.equal(viteOrigin.statusCode, 200);
    const sameOrigin = await beforeDeadline(app.inject({
      method: 'GET', url: '/api/projects',
      headers: { host: '[::1]:8787', origin: 'https://[::1]:8787' },
    }), 'IPv6 REST');
    assert.equal(sameOrigin.statusCode, 200);

    const evilHost = await beforeDeadline(app.inject({
      method: 'GET', url: '/api/projects', headers: { host: 'evil.example:8787' },
    }), 'evil Host REST');
    assert.equal(evilHost.statusCode, 403);
    assert.deepEqual(evilHost.json(), {
      ok: false, error: { code: 'LOCAL_ONLY', message: 'localhost access required' },
    });
    const evilOrigin = await beforeDeadline(app.inject({
      method: 'GET', url: '/api/projects',
      headers: { host: '127.0.0.1:8787', origin: 'https://evil.example' },
    }), 'evil Origin REST');
    assert.equal(evilOrigin.statusCode, 403);
    assert.deepEqual(evilOrigin.json(), {
      ok: false, error: { code: 'LOCAL_ONLY', message: 'localhost access required' },
    });

    const address = new URL(await beforeDeadline(
      app.listen({ port: 0, host: '127.0.0.1' }),
      'boundary app listen',
    ));
    const port = Number(address.port);
    // Exercise the Host/Origin gate with a direct RFC 6455 handshake. This
    // keeps a security-boundary assertion independent from the scheduling of
    // Node's global WebSocket client; real client lifecycle is covered by the
    // dedicated shutdown tests below.
    const originlessUpgrade = await beforeDeadline(
      websocketUpgrade(port),
      'originless WebSocket upgrade',
    );
    assert.match(originlessUpgrade, /^HTTP\/1\.1 101 /);

    const viteUpgrade = await beforeDeadline(
      websocketUpgrade(port, 'http://localhost:5183'),
      'Vite WebSocket upgrade',
    );
    assert.match(viteUpgrade, /^HTTP\/1\.1 101 /);

    const rejectedUpgrade = await beforeDeadline(
      websocketUpgrade(port, 'https://evil.example'),
      'evil-origin rejection',
    );
    assert.match(rejectedUpgrade, /^HTTP\/1\.1 403 /);
    assert.match(rejectedUpgrade, /"code":"LOCAL_ONLY"/);
    await beforeDeadline(app.close(), 'boundary app close');
    app = undefined;
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('app.close drains an open valid WebSocket before closing stores', { skip: tcpListenSkipReason }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'writing-studio-ws-close-'));
  const dataDir = join(root, 'data');
  const vaultRoot = join(root, 'vault');
  const registryPath = join(dataDir, 'registry.json');
  let app: FastifyInstance | undefined;
  let socket: WebSocket | undefined;
  try {
    await mkdir(join(vaultRoot, '.writing-studio'), { recursive: true });
    await mkdir(join(vaultRoot, '正文'), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(vaultRoot, '.writing-studio', 'project.json'), JSON.stringify(config()));
    await writeFile(registryPath, JSON.stringify({
      projects: [{ id: projectId, vaultRoot, enabled: true }],
    }));
    app = await buildApp({ dataDir, registryPath, watchSidebar: false });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    socket = await openWebSocket(`${address.replace(/^http/, 'ws')}/ws?projectId=${projectId}`);
    const closed = socketClose(socket);
    await beforeDeadline(app.close(), 'app.close with active WebSocket');
    app = undefined;
    await beforeDeadline(closed, 'WebSocket close after app.close');
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('app.close is bounded after an abruptly dropped raw WebSocket upgrade', { skip: tcpListenSkipReason }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'writing-studio-ws-abrupt-close-'));
  const dataDir = join(root, 'data');
  const vaultRoot = join(root, 'vault');
  const registryPath = join(dataDir, 'registry.json');
  let app: FastifyInstance | undefined;
  try {
    await mkdir(join(vaultRoot, '.writing-studio'), { recursive: true });
    await mkdir(join(vaultRoot, '正文'), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(vaultRoot, '.writing-studio', 'project.json'), JSON.stringify(config()));
    await writeFile(registryPath, JSON.stringify({
      projects: [{ id: projectId, vaultRoot, enabled: true }],
    }));
    app = await buildApp({ dataDir, registryPath, watchSidebar: false });
    const address = new URL(await app.listen({ port: 0, host: '127.0.0.1' }));
    await beforeDeadline(abruptWebSocketUpgrade(Number(address.port)), 'abrupt WebSocket upgrade');
    await beforeDeadline(app.close(), 'app.close after abrupt WebSocket upgrade');
    app = undefined;
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
