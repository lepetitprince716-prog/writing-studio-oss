import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import Ajv from 'ajv';
import type {
  AgentAvailability,
  AgentBackend,
  AgentErrorCode,
  AgentEvent,
  AgentId,
  AgentModelOption,
  StructuredAgentResponse,
  SendOptions,
  ThreadRunContext,
} from '@writing-studio/contract';
import { buildPrompt } from './history.js';
import { sandboxUnavailableReason } from './sandbox.js';
import { processSupervisor, SupervisorError } from './supervisor.js';
import { binaryPath, strictEnvironment, stripAnsiAndNulls } from './workspace.js';

export {
  binaryPath,
  combineCleanup,
  createPlannerProjection,
  isolatedWorkspace,
  schemaFiles,
  strictEnvironment,
  writerScratch,
} from './workspace.js';
export type { IsolatedWorkspace } from './workspace.js';

export interface ParsedLine {
  events: AgentEvent[];
  nativeSessionId?: string;
  text?: string;
  /** CLI-owned diagnostic fields only; never inferred from ordinary output. */
  diagnostic?: {
    detail: string;
    classification: string;
  };
}

export interface CommandBuild {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  cleanup?: () => Promise<void>;
  readOutput?: () => Promise<string | null>;
}

export interface BackendDefinition {
  id: Exclude<AgentId, 'echo'>;
  displayName: string;
  pathEnv: string;
  defaultPath: string;
  makeCommand(input: {
    ctx: ThreadRunContext;
    opts: SendOptions;
    prompt: string;
    sessionId: string | null;
    freshSessionId: string;
    responseSchema: Record<string, unknown> | null;
  }): Promise<CommandBuild>;
  parseLine(line: unknown): ParsedLine | null;
  /** Whether writer runs still need the macOS filesystem sandbox wrapper. */
  requiresFilesystemSandbox?: boolean | (() => boolean);
  /** Optional advisory model discovery; failures must degrade to an empty list. */
  probeModels?: (binary: string) => Promise<import('@writing-studio/contract').AgentModelOption[]>;
  /**
   * A fresh UUID is only a usable native session when this adapter actually
   * passes it to its CLI as the session identity (Claude's `--session-id`).
   * Codex/OpenCode create their own IDs, so an unreported fresh UUID must
   * never be exposed or persisted as though it were resumable.
   */
  freshSessionIdIsStable?: boolean;
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(trimmed) as unknown; } catch { /* try final object below */ }
  const start = trimmed.lastIndexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(trimmed.slice(start)) as unknown; } catch { return null; }
}

function errorCode(message: string): AgentErrorCode {
  if (/non-JSON|structured response/i.test(message)) return 'parse_error';
  if (/\bENOENT\b|executable.+(?:not found|unavailable)|spawn.+not found/i.test(message)) return 'cli_not_found';
  if (/auth|login|credential/i.test(message)) return 'cli_not_authenticated';
  if (/budget|max[_ -]?budget|spending limit/i.test(message)) return 'budget_exceeded';
  if (/ECONN|ENOTFOUND|network|fetch failed|socket hang up/i.test(message)) return 'network_error';
  if (/timed? out|ETIMEDOUT/i.test(message)) return 'timeout';
  if (/abort|cancelled/i.test(message)) return 'cancelled';
  if (/sandbox-exec|filesystem sandbox|sandbox profile/i.test(message)) return 'sandbox_unavailable';
  return 'process_error';
}

function cleanDiagnostic(value: string): string {
  return stripAnsiAndNulls(value).trim().slice(-300);
}

class CliDiagnosticError extends Error {
  readonly detail: string;

  constructor(detail: string, readonly classification: string) {
    super(classification);
    this.name = 'CliDiagnosticError';
    this.detail = cleanDiagnostic(detail);
  }
}

function classifyError(error: unknown): AgentErrorCode {
  if (error instanceof SupervisorError) {
    if (error.reason === 'busy') return 'busy';
    if (error.reason === 'cancelled') return 'cancelled';
  }
  return errorCode(
    error instanceof CliDiagnosticError
      ? error.classification
      : error instanceof Error ? error.message : String(error),
  );
}

function publicError(code: AgentErrorCode): { message: string; retryable: boolean } {
  switch (code) {
    case 'cli_not_found': return { message: 'agent CLI is not installed or executable', retryable: false };
    case 'cli_not_authenticated': return { message: 'agent CLI is not authenticated', retryable: false };
    case 'network_error': return { message: 'agent CLI network request failed', retryable: true };
    case 'parse_error': return { message: 'agent CLI returned an unsupported output format', retryable: false };
    case 'budget_exceeded': return { message: 'agent CLI budget limit was reached', retryable: false };
    case 'timeout': return { message: 'agent CLI timed out', retryable: true };
    case 'cancelled': return { message: 'agent run was cancelled', retryable: true };
    case 'busy': return { message: 'agent process limit is busy; retry shortly', retryable: true };
    case 'sandbox_unavailable': return { message: 'required OS filesystem sandbox is unavailable or rejected this CLI run', retryable: false };
    case 'process_error': return { message: 'agent CLI exited unexpectedly', retryable: true };
  }
}

function usableResume(ctx: ThreadRunContext): string | null {
  if (ctx.historyReplayMode === 'latest-candidate') return null;
  const session = ctx.session;
  return session?.nativeSessionId && session.lastSyncedMessageCount === ctx.history.length
    ? session.nativeSessionId
    : null;
}

/** Common JSONL runner. Backend-specific code owns only CLI grammar and event mapping. */
export class CliBackend implements AgentBackend {
  readonly id: Exclude<AgentId, 'echo'>;
  readonly displayName: string;

  constructor(private readonly definition: BackendDefinition) {
    this.id = definition.id;
    this.displayName = definition.displayName;
  }

  async probeAvailability(): Promise<AgentAvailability> {
    const path = binaryPath(this.definition.pathEnv, this.definition.defaultPath);
    try {
      let output = '';
      const controller = new AbortController();
      for await (const chunk of processSupervisor.run({
        file: path, args: ['--version'], cwd: tmpdir(), env: strictEnvironment(), stdin: '',
        timeoutMs: 5_000, signal: controller.signal,
      })) {
        if (chunk.type === 'stdout') output += chunk.text;
        if (chunk.type === 'exit' && chunk.code !== 0) throw new Error(chunk.stderr || `exit ${chunk.code}`);
      }
      // Every external writer that relies on a macOS profile is advertised
      // only when sandbox-exec is usable on this host.
      const requiresFilesystemSandbox = typeof this.definition.requiresFilesystemSandbox === 'function'
        ? this.definition.requiresFilesystemSandbox()
        : this.definition.requiresFilesystemSandbox !== false;
      const disabledReason = !requiresFilesystemSandbox
        ? null
        : sandboxUnavailableReason();
      const supportedProfiles = disabledReason === null ? ['writer'] as Array<'writer' | 'planner'> : [];
      let models: AgentModelOption[] | undefined;
      try {
        models = await this.definition.probeModels?.(path);
      } catch {
        models = [];
      }
      return {
        agentId: this.id,
        ok: supportedProfiles.length > 0,
        supportedProfiles,
        version: output.trim().slice(0, 200) || null,
        binaryPath: path,
        error: disabledReason,
        ...(models === undefined ? {} : { models }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = errorCode(message);
      return {
        agentId: this.id,
        ok: false,
        supportedProfiles: [],
        version: null,
        binaryPath: path,
        error: code === 'cli_not_found'
          ? `agent CLI is not installed or executable: ${path}`
          : message,
      };
    }
  }

  async *send(ctx: ThreadRunContext, userMessage: string, opts: SendOptions): AsyncIterable<AgentEvent> {
    const definition = this.definition;
    // Planner vault browsing remains fail-closed for every external CLI.
    if (ctx.allowVaultBrowsing) {
      yield {
        type: 'error',
        code: 'sandbox_unavailable',
        message: 'this agent/profile is disabled until its filesystem boundary can be enforced',
        retryable: false,
      };
      return;
    }
    const resumed = usableResume(ctx);
    const strategyUsed = resumed ? 'native-resume' : 'history-replay';
    const freshSessionId = randomUUID();
    let currentSessionId: string | null = resumed
      ?? (definition.freshSessionIdIsStable ? freshSessionId : null);
    let sessionSent = false;
    let terminal = false;
    let sessionInvalidated = false;
    const schema = opts.responseSchema;
    const validate = schema ? new Ajv({ allErrors: true, strict: false }).compile(schema) : null;

    const emitSession = function* (): Generator<AgentEvent> {
      if (!sessionSent && currentSessionId) {
        sessionSent = true;
        yield { type: 'session', nativeSessionId: currentSessionId };
      }
    };

    const runAttempt = async function* (prompt: string, retry: boolean): AsyncGenerator<AgentEvent, { content: string; clean: boolean }> {
      const command = await definition.makeCommand({
        ctx, opts, prompt, sessionId: retry ? currentSessionId : resumed, freshSessionId,
        responseSchema: schema,
      });
      let stdoutBuffer = '';
      let content = '';
      let clean = false;
      let lastDiagnostic: ParsedLine['diagnostic'];
      const rememberDiagnostic = (outcome: ParsedLine | null): void => {
        if (outcome?.diagnostic) lastDiagnostic = outcome.diagnostic;
      };
      try {
        for await (const chunk of processSupervisor.run({
          file: command.file, args: command.args, cwd: command.cwd, env: command.env,
          stdin: command.prompt, timeoutMs: opts.timeoutMs, signal: opts.signal,
        })) {
          if (chunk.type === 'stderr') continue; // retained only for safe terminal diagnostics
          if (chunk.type === 'stdout') {
            stdoutBuffer += chunk.text;
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.trim()) continue;
              let parsed: unknown;
              try { parsed = JSON.parse(line); }
              catch {
                throw new CliDiagnosticError(line, `non-JSON CLI output: ${line.slice(0, 160)}`);
              }
              const outcome = definition.parseLine(parsed);
              if (!outcome) continue;
              rememberDiagnostic(outcome);
              if (outcome.nativeSessionId && !sessionSent) currentSessionId = outcome.nativeSessionId;
              yield* emitSession();
              for (const event of outcome.events) {
                if (event.type === 'delta') content += event.text;
                yield event;
              }
              // CLI final-result records usually repeat already streamed deltas.
              if (outcome.text && content.length === 0) content += outcome.text;
            }
          } else if (chunk.type === 'exit') {
            if (chunk.aborted || chunk.timedOut) {
              yield* emitSession();
              yield {
                type: 'done', stopReason: chunk.timedOut ? 'timeout' : 'cancelled',
                nativeSessionId: sessionInvalidated ? null : currentSessionId,
                strategyUsed,
              };
              terminal = true;
              return { content, clean: false };
            }
            if (chunk.code !== 0) {
              if (!chunk.stderr && stdoutBuffer.trim()) {
                try {
                  rememberDiagnostic(definition.parseLine(JSON.parse(stdoutBuffer) as unknown));
                } catch {
                  // A truncated final record is not a safe diagnostic source.
                }
              }
              if (chunk.stderr) throw new CliDiagnosticError(chunk.stderr, chunk.stderr);
              if (lastDiagnostic) {
                throw new CliDiagnosticError(lastDiagnostic.detail, lastDiagnostic.classification);
              }
              throw new CliDiagnosticError(
                `CLI exited (code ${chunk.code ?? 'signal'}) with no stderr/stdout diagnostic output`,
                `CLI exited ${chunk.code ?? 'by signal'}`,
              );
            }
            clean = true;
          }
        }
        if (stdoutBuffer.trim()) {
          let parsed: unknown;
          try { parsed = JSON.parse(stdoutBuffer); }
          catch {
            throw new CliDiagnosticError(stdoutBuffer, `truncated/non-JSON CLI output: ${stdoutBuffer.slice(0, 160)}`);
          }
          const outcome = definition.parseLine(parsed);
          if (outcome) {
            rememberDiagnostic(outcome);
            if (outcome.nativeSessionId && !sessionSent) currentSessionId = outcome.nativeSessionId;
            yield* emitSession();
            for (const event of outcome.events) {
              if (event.type === 'delta') content += event.text;
              yield event;
            }
            if (outcome.text && content.length === 0) content += outcome.text;
          }
        }
        if (lastDiagnostic) {
          throw new CliDiagnosticError(lastDiagnostic.detail, lastDiagnostic.classification);
        }
        const output = await command.readOutput?.();
        if (output?.trim()) content = output.trim();
        return { content, clean };
      } finally {
        await command.cleanup?.();
      }
    };

    try {
      const prompts = ctx.promptBundle;
      const firstPrompt = buildPrompt({
        history: ctx.history,
        replay: !resumed,
        replayMode: ctx.historyReplayMode,
        contextBlock: ctx.contextBlock,
        systemPrompt: ctx.systemPrompt,
        userMessage,
        structured: schema !== null,
        prompts,
      });
      if (schema && validate) {
        const collect = async (attempt: AsyncGenerator<AgentEvent, { content: string; clean: boolean }>) => {
          const events: AgentEvent[] = [];
          let item = await attempt.next();
          while (!item.done) { events.push(item.value); item = await attempt.next(); }
          return { events, result: item.value };
        };
        // A schema run is transactional to the UI: discard a malformed first
        // attempt entirely, then publish exactly one repaired stream.
        const first = await collect(runAttempt(firstPrompt, false));
        if (terminal) {
          for (const event of first.events) yield event;
          return;
        }
        let result = first.result;
        const data = extractJson(result.content);
        if (data !== null && validate(data)) {
          for (const event of first.events) yield event;
          yield { type: 'structured', data: data as StructuredAgentResponse, valid: true, raw: result.content };
        } else {
          // The first malformed response is an internal repair attempt, not UI output.
          // The repair consumes a hidden native turn. Even if it succeeds, a
          // later panel turn cannot safely resume without replaying that hidden
          // exchange, so deliberately invalidate the session at completion.
          sessionInvalidated = true;
          const correction = prompts.schemaCorrection;
          const retry = await collect(runAttempt(correction, true));
          if (terminal) {
            // Preserve the one session event, never reveal malformed content.
            const session = first.events.find((event) => event.type === 'session');
            if (session) yield session;
            for (const event of retry.events) yield event;
            return;
          }
          result = retry.result;
          const session = first.events.find((event) => event.type === 'session');
          if (session) yield session;
          for (const event of retry.events) if (event.type !== 'session') yield event;
          const corrected = extractJson(result.content);
          if (corrected === null || !validate(corrected)) {
            yield { type: 'structured', data: null, valid: false, raw: result.content };
          } else {
            yield { type: 'structured', data: corrected as StructuredAgentResponse, valid: true, raw: result.content };
          }
        }
        yield* emitSession();
        yield { type: 'result', content: result.content };
        yield {
          type: 'done', stopReason: 'end_turn',
          nativeSessionId: sessionInvalidated ? null : currentSessionId,
          strategyUsed,
        };
        terminal = true;
        return;
      }
      let attempt = runAttempt(firstPrompt, false);
      let first = await attempt.next();
      while (!first.done) { yield first.value; first = await attempt.next(); }
      const result = first.value;
      if (terminal) return;
      yield* emitSession();
      yield { type: 'result', content: result.content };
      yield {
        type: 'done', stopReason: 'end_turn',
        nativeSessionId: sessionInvalidated ? null : currentSessionId,
        strategyUsed,
      };
      terminal = true;
    } catch (error) {
      if (!terminal) {
        const code = classifyError(error);
        const safe = publicError(code);
        const detail = error instanceof CliDiagnosticError ? error.detail : '';
        yield {
          type: 'error',
          code,
          message: safe.message,
          retryable: safe.retryable,
          ...(detail ? { detail } : {}),
        };
      }
    }
  }
}
