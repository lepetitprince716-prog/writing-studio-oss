import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { describeListenFailure, installProcessGuards } from '../src/index.js';
import { tcpListenerSkipReason } from './support/tcp-probe.js';

type ProcessEvent = 'unhandledRejection' | 'uncaughtException';
const tcpListenSkipReason = await tcpListenerSkipReason();

function removeNewListeners(event: ProcessEvent, baseline: Function[]): void {
  // process.listeners(event) rejects the ProcessEvent union, so narrow per
  // literal; inference from each call keeps the listener type process.off needs.
  const current = event === 'unhandledRejection'
    ? process.listeners('unhandledRejection')
    : process.listeners('uncaughtException');
  for (const listener of current) {
    if (!baseline.includes(listener)) process.off(event, listener);
  }
}

test('installProcessGuards registers one listener per fatal process event', () => {
  const unhandledBefore = process.listeners('unhandledRejection');
  const uncaughtBefore = process.listeners('uncaughtException');
  const logger = { error: () => undefined };
  try {
    for (const listener of unhandledBefore) process.off('unhandledRejection', listener);
    for (const listener of uncaughtBefore) process.off('uncaughtException', listener);

    installProcessGuards(logger);
    assert.equal(process.listenerCount('unhandledRejection'), 1);
    assert.equal(process.listenerCount('uncaughtException'), 1);

    installProcessGuards(logger);
    assert.equal(process.listenerCount('unhandledRejection'), 1);
    assert.equal(process.listenerCount('uncaughtException'), 1);
  } finally {
    removeNewListeners('unhandledRejection', unhandledBefore);
    removeNewListeners('uncaughtException', uncaughtBefore);
    for (const listener of unhandledBefore) process.on('unhandledRejection', listener);
    for (const listener of uncaughtBefore) process.on('uncaughtException', listener);
  }
});

test('uncaughtException guard closes gracefully then exits, with a fallback when close fails', async () => {
  const unhandledBefore = process.listeners('unhandledRejection');
  const uncaughtBefore = process.listeners('uncaughtException');
  try {
    for (const listener of unhandledBefore) process.off('unhandledRejection', listener);
    for (const listener of uncaughtBefore) process.off('uncaughtException', listener);

    // Path 1: close resolves → exit(1) after close.
    const events: string[] = [];
    let resolveExit = (): void => undefined;
    const exited = new Promise<void>((r) => { resolveExit = r; });
    installProcessGuards(
      { error: () => { events.push('log'); } },
      async () => { events.push('close'); },
      ((code: number) => { events.push(`exit:${code}`); resolveExit(); return undefined as never; }) as (code: number) => never,
    );
    const handler = process.listeners('uncaughtException').at(-1) as (error: Error) => void;
    handler(new Error('boom'));
    await exited;
    assert.deepEqual(events, ['log', 'close', 'exit:1']);

    // Path 2: close rejects → second log entry, still exit(1).
    const failEvents: string[] = [];
    let resolveFailExit = (): void => undefined;
    const failExited = new Promise<void>((r) => { resolveFailExit = r; });
    installProcessGuards(
      { error: () => { failEvents.push('log'); } },
      async () => { throw new Error('close failed'); },
      ((code: number) => { failEvents.push(`exit:${code}`); resolveFailExit(); return undefined as never; }) as (code: number) => never,
    );
    const failHandler = process.listeners('uncaughtException').at(-1) as (error: Error) => void;
    failHandler(new Error('boom'));
    await failExited;
    assert.deepEqual(failEvents, ['log', 'log', 'exit:1']);
  } finally {
    removeNewListeners('unhandledRejection', unhandledBefore);
    removeNewListeners('uncaughtException', uncaughtBefore);
    for (const listener of unhandledBefore) process.on('unhandledRejection', listener);
    for (const listener of uncaughtBefore) process.on('uncaughtException', listener);
  }
});

test('describeListenFailure makes common bind failures actionable', () => {
  assert.equal(
    describeListenFailure({ code: 'EADDRINUSE' }, 8787),
    'port 8787 already in use — a previous writing-studio server may still be running; stop it or set WRITING_STUDIO_PORT',
  );
  assert.equal(
    describeListenFailure({ code: 'EACCES' }, 8787),
    'permission denied for port 8787 — choose an allowed port or set WRITING_STUDIO_PORT',
  );
  assert.equal(describeListenFailure(new Error('other failure'), 8787), undefined);
});

test('a real address collision reports the actionable EADDRINUSE message', { skip: tcpListenSkipReason }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'writing-studio-address-collision-'));
  let first: FastifyInstance | undefined;
  let second: FastifyInstance | undefined;
  try {
    first = await buildApp({ dataDir: join(root, 'first'), watchSidebar: false });
    second = await buildApp({ dataDir: join(root, 'second'), watchSidebar: false });
    // Bind the same host the registration gate probes; the Fastify default
    // (localhost) may resolve to ::1, which some environments deny separately.
    const address = new URL(await first.listen({ port: 0, host: '127.0.0.1' }));
    const port = Number(address.port);
    let listenError: unknown;
    try {
      await second.listen({ port, host: '127.0.0.1' });
    } catch (error) {
      listenError = error;
    }
    assert.ok(listenError, 'second listener unexpectedly acquired the occupied port');
    assert.equal((listenError as NodeJS.ErrnoException).code, 'EADDRINUSE');
    assert.equal(
      describeListenFailure(listenError, port),
      `port ${port} already in use — a previous writing-studio server may still be running; stop it or set WRITING_STUDIO_PORT`,
    );
  } finally {
    await Promise.all([first?.close(), second?.close()]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('/health returns the standard envelope without binding a port', async () => {
  const root = mkdtempSync(join(tmpdir(), 'writing-studio-health-route-'));
  let app: FastifyInstance | undefined;
  try {
    app = await buildApp({ dataDir: join(root, 'data'), watchSidebar: false });
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { ok: boolean; data: { uptime: number; projects: number } };
    assert.equal(body.ok, true);
    assert.equal(typeof body.data.uptime, 'number');
    assert.ok(body.data.uptime >= 0);
    assert.equal(body.data.projects, 0);
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
