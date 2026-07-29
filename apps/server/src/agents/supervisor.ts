import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripAnsiAndNulls } from './workspace.js';

const watchdogPath = fileURLToPath(new URL('./watchdog.mjs', import.meta.url));

export interface ProcessSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export type ProcessChunk =
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null; aborted: boolean; timedOut: boolean; stderr: string };

export class SupervisorError extends Error {
  constructor(public readonly reason: 'busy' | 'cancelled' | 'shutdown') {
    super(reason === 'busy' ? 'agent process supervisor is busy' : `agent process supervisor ${reason}`);
    this.name = 'SupervisorError';
  }
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private waiter: ((value: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) waiter({ value, done: false }); else this.values.push(value);
  }
  close(): void {
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.({ value: undefined, done: true });
  }
  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve) => { this.waiter = resolve; });
  }
}

function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try { process.kill(-child.pid!, signal); } catch { child.kill(signal); }
}

interface ManagedChild {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  terminate: () => void;
}

/** One server-wide, fail-fast process-group supervisor. */
export class ProcessSupervisor {
  private active = 0;
  private readonly children = new Map<ChildProcessWithoutNullStreams, ManagedChild>();
  private stopping = false;

  constructor(private readonly limit = 3) {}

  private acquire(signal: AbortSignal): void {
    if (this.stopping) throw new SupervisorError('shutdown');
    if (signal.aborted) throw new SupervisorError('cancelled');
    if (this.active >= this.limit) throw new SupervisorError('busy');
    this.active += 1;
  }

  async *run(spec: ProcessSpec): AsyncGenerator<ProcessChunk, void, void> {
    this.acquire(spec.signal);
    const queue = new AsyncQueue<ProcessChunk>();
    let child: ChildProcessWithoutNullStreams | null = null;
    let released = false;
    let aborting = false;
    let timedOut = false;
    let finished = false;
    let stderr = '';
    let grace: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let closed: Promise<void> | null = null;
    let onAbort: (() => void) | null = null;
    const release = (): void => {
      if (!released) { released = true; this.active -= 1; }
    };

    const stop = (reason: 'abort' | 'timeout'): void => {
      if (!child || finished || aborting) return;
      aborting = true;
      timedOut = reason === 'timeout';
      signalGroup(child, 'SIGTERM');
      grace = setTimeout(() => {
        if (child && !finished) signalGroup(child, 'SIGKILL');
      }, 3_000);
    };

    try {
      // The CLI itself is launched by an orphan-aware watchdog.  That detached
      // watchdog owns the CLI process group and proxies stdio, so a SIGKILL of
      // this server cannot strand a model process that keeps billing.
      child = spawn(process.execPath, [watchdogPath, String(process.pid), spec.file, ...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        detached: true,
        stdio: 'pipe',
      });
      const current = child;
      let resolveClosed!: () => void;
      const closePromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
      closed = closePromise;
      this.children.set(current, { child: current, closed: closePromise, terminate: () => stop('abort') });
      current.stdout.setEncoding('utf8');
      current.stderr.setEncoding('utf8');
      current.stdout.on('data', (text: string) => queue.push({ type: 'stdout', text }));
      current.stderr.on('data', (text: string) => {
        const cleaned = stripAnsiAndNulls(text);
        stderr = (stderr + cleaned).slice(-8_192);
        queue.push({ type: 'stderr', text: cleaned.slice(0, 2_048) });
      });
      // A terminated child can reject stdin writes after `end`; EPIPE is expected.
      current.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') {
          stderr = (stderr + stripAnsiAndNulls(error.message)).slice(-8_192);
        }
      });
      current.once('error', (error) => {
        stderr = (stderr + stripAnsiAndNulls(error.message)).slice(-8_192);
      });
      current.once('close', (code, signal) => {
        finished = true;
        if (timeout) clearTimeout(timeout);
        if (grace) clearTimeout(grace);
        this.children.delete(current);
        queue.push({ type: 'exit', code, signal, aborted: aborting && !timedOut, timedOut, stderr });
        queue.close();
        resolveClosed();
        release();
      });
      onAbort = () => stop('abort');
      spec.signal.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => stop('timeout'), Math.max(1, spec.timeoutMs));
      current.stdin.end(spec.stdin);
      for (;;) {
        const item = await queue.next();
        if (item.done) break;
        yield item.value;
      }
    } finally {
      if (onAbort) spec.signal.removeEventListener('abort', onAbort);
      // Async-generator consumers are allowed to stop after the first event.
      // Never leave a detached child group running in that case.
      if (child && !finished) {
        stop('abort');
        await closed;
      }
      if (timeout) clearTimeout(timeout);
      if (grace) clearTimeout(grace);
      if (!child) release();
    }
  }

  /** Stops every process group and resolves only after graceful-kill completion. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const children = [...this.children.values()];
    for (const managed of children) managed.terminate();
    await Promise.allSettled(children.map((managed) => managed.closed));
  }
}

export const processSupervisor = new ProcessSupervisor(3);
