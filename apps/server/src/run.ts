import type {
  AgentAvailability,
  AgentBackend,
  AgentEvent,
  AgentId,
  StructuredAgentResponse,
  ContextManifest,
} from '@writing-studio/contract';
import {
  CONFLICT_CHECK_RESPONSE_SCHEMA,
  REWRITE_RESPONSE_SCHEMA,
  conflictCheckResponseSchema,
} from '@writing-studio/contract';
import type { LoadedProject } from './config.js';
import { requireReadyProject } from './config.js';
import { buildThreadContext } from './context.js';
import { resolvePromptBundle } from './prompts/index.js';
import type { StoreManager } from './db/store.js';
import { stripAnsiAndNulls } from './agents/workspace.js';
import { StudioError, asErrorMessage } from './errors.js';
import { readDocument } from './vault.js';
import { broadcast } from './ws.js';

interface ActiveRun {
  runId: string;
  controller: AbortController;
  completion: Promise<void>;
}

function terminalError(message: string): Extract<AgentEvent, { type: 'error' }> {
  return { type: 'error', code: 'process_error', message, retryable: true };
}

function boundedErrorEvent(
  event: Extract<AgentEvent, { type: 'error' }>,
): Extract<AgentEvent, { type: 'error' }> {
  const detail = event.detail && stripAnsiAndNulls(event.detail).trim().slice(-300);
  const { detail: _originalDetail, ...base } = event;
  return detail ? { ...base, detail } : base;
}

function timeoutTerminal(
  nativeSessionId: string | null,
  strategyUsed: 'native-resume' | 'history-replay',
): Extract<AgentEvent, { type: 'done' }> {
  return { type: 'done', stopReason: 'timeout', nativeSessionId, strategyUsed };
}

export class AgentCatalog {
  private cached: { at: number; values: AgentAvailability[] } | null = null;

  constructor(readonly backends: Map<AgentId, AgentBackend>) {}

  get(agentId: AgentId): AgentBackend {
    const backend = this.backends.get(agentId);
    if (!backend) throw new StudioError('AGENT_UNAVAILABLE', `agent is not configured: ${agentId}`);
    return backend;
  }

  async listAvailability(maxAgeMs = 30_000): Promise<AgentAvailability[]> {
    if (this.cached && Date.now() - this.cached.at < maxAgeMs) return this.cached.values;
    // Probe serially: concurrent probes compete for the process supervisor's
    // limited slots, so with four CLI backends the last one deterministically
    // fails 'busy' and the failure gets cached as unavailable.
    const values: AgentAvailability[] = [];
    for (const backend of this.backends.values()) {
      try {
        values.push(await backend.probeAvailability());
      } catch (error) {
        values.push({
          agentId: backend.id,
          ok: false,
          supportedProfiles: [],
          version: null,
          binaryPath: '(probe failed)',
          error: asErrorMessage(error),
        } satisfies AgentAvailability);
      }
    }
    this.cached = { at: Date.now(), values };
    return values;
  }
}

export class RunCoordinator {
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly projects: Map<string, LoadedProject>,
    private readonly stores: StoreManager,
    readonly agents: AgentCatalog,
    private readonly panelDataDir: string,
    private readonly onInternalError: (error: unknown) => void = () => undefined,
    private readonly runTimeoutMs = 300_000,
    private readonly generateTimeoutMs = 600_000,
  ) {}

  start(
    threadId: string,
    userMessage: string,
    requestedAgentId: AgentId | undefined,
    wantRewrite: boolean,
    model?: string,
  ): { runId: string } {
    if (this.active.has(threadId)) {
      throw new StudioError('THREAD_BUSY', 'a run is already active for this thread');
    }
    const located = this.stores.findThread(threadId);
    if (!located) throw new StudioError('NOT_FOUND', 'thread not found');
    let thread = located.thread;
    if (thread.status !== 'open') throw new StudioError('VALIDATION', 'resolved thread cannot accept messages');
    if (wantRewrite && thread.kind !== 'rewrite') {
      throw new StudioError('VALIDATION', 'only rewrite threads can request structured rewrites');
    }
    if (requestedAgentId && requestedAgentId !== thread.agentId) {
      thread = located.store.patchThread(thread.id, { agentId: requestedAgentId }) ?? thread;
    }
    const backend = this.agents.get(thread.agentId);
    const project = requireReadyProject(this.projects, thread.projectId);
    const documentContent = thread.kind === 'chat'
      ? ''
      : readDocument(project.vaultRoot, project.config, thread.docId).content;
    const history = located.store.getMessages(thread.id);
    located.store.appendMessage(thread.id, 'user', userMessage, null);
    const run = located.store.createRun(thread.id, thread.agentId, model ?? null);
    const controller = new AbortController();

    const completion = this.execute({
      backend,
      controller,
      documentContent,
      history,
      model: model ?? null,
      project,
      runId: run.id,
      store: located.store,
      thread,
      userMessage,
      // Generation reuses the rewrite lifecycle, but its candidate is the
      // complete chapter Markdown rather than the rewrite JSON envelope.
      wantRewrite: thread.kind === 'rewrite' && thread.origin !== 'generate',
    });
    this.active.set(thread.id, { runId: run.id, controller, completion });
    void completion.finally(() => this.active.delete(thread.id));
    return { runId: run.id };
  }

  stop(threadId: string): boolean {
    const active = this.active.get(threadId);
    active?.controller.abort();
    return active !== undefined;
  }

  async shutdown(): Promise<void> {
    const runs = [...this.active.values()];
    for (const run of runs) run.controller.abort();
    await Promise.allSettled(runs.map((run) => run.completion));
  }

  private async execute(input: {
    backend: AgentBackend;
    controller: AbortController;
    documentContent: string;
    history: ReturnType<import('./db/store.js').ProjectStore['getMessages']>;
    model: string | null;
    project: ReturnType<typeof requireReadyProject>;
    runId: string;
    store: import('./db/store.js').ProjectStore;
    thread: ReturnType<import('./db/store.js').ProjectStore['getThread']> & {};
    userMessage: string;
    wantRewrite: boolean;
  }): Promise<void> {
    const { backend, controller, project, runId, store, thread, userMessage, wantRewrite } = input;
    let terminalSeen = false;
    let finalText = '';
    let structured: StructuredAgentResponse | null = null;
    let nativeSessionId: string | null = null;
    let terminal: AgentEvent | null = null;
    let terminalBroadcast = false;
    let timedOut = false;
    const timeoutMs = thread.origin === 'generate'
      ? this.generateTimeoutMs
      : this.runTimeoutMs;
    const timeout = setTimeout(() => {
      // A user stop owns the abort signal. Do not relabel a slower backend's
      // subsequent cleanup as a timeout merely because its deadline passes.
      if (controller.signal.aborted) return;
      timedOut = true;
      // All adapters share this signal. ProcessSupervisor still owns the
      // process-group shutdown, while non-CLI backends such as Echo receive
      // the same wall-clock deadline.
      controller.abort('timeout');
    }, timeoutMs);

    let manifest: ContextManifest | undefined;
    const emit = (event: AgentEvent): void => {
      broadcast(thread.projectId, {
        kind: 'agent',
        runId,
        threadId: thread.id,
        agentId: backend.id,
        event,
        ...(manifest ? { manifest } : {}),
      });
    };

    try {
      const builtContext = buildThreadContext(
        project,
        thread,
        input.documentContent,
        userMessage,
      );
      // Kept in the runs row for local diagnosis only; GET /api/runs remains
      // the deliberately minimal public Run DTO.
      store.setRunManifest(runId, builtContext.manifest);
      manifest = builtContext.manifest;
      const allowedCheckCanonDocIds = new Set<string>();
      if (thread.origin === 'check') {
        const serialized = JSON.parse(builtContext.contextBlock) as {
          sources?: Array<{ path?: unknown }>;
        };
        for (const source of serialized.sources ?? []) {
          if (typeof source.path === 'string' && source.path.startsWith('canon:')) {
            allowedCheckCanonDocIds.add(source.path.slice('canon:'.length));
          }
        }
      }
      const session = store.getSession(thread.id, backend.id) ?? null;
      const stream = backend.send(
        {
          threadId: thread.id,
          dataDir: this.panelDataDir,
          vaultRoot: project.vaultRoot,
          history: input.history,
          historyReplayMode: thread.origin === 'generate' ? 'latest-candidate' : 'bounded',
          session,
          contextBlock: builtContext.contextBlock,
          allowVaultBrowsing: builtContext.allowVaultBrowsing,
          vaultReadPolicy: builtContext.vaultReadPolicy,
          systemPrompt: builtContext.systemPrompt,
          promptBundle: resolvePromptBundle(project.config),
        },
        userMessage,
        {
          model: input.model,
          timeoutMs,
          maxBudgetUsd: null,
          responseSchema: thread.origin === 'check'
            ? CONFLICT_CHECK_RESPONSE_SCHEMA
            : wantRewrite ? REWRITE_RESPONSE_SCHEMA : null,
          signal: controller.signal,
        },
      );

      for await (const event of stream) {
        // A backend may translate our abort into `cancelled`, or even race a
        // normal terminal event. The coordinator owns the public deadline, so
        // it always wins once elapsed.
        if (timedOut) {
          terminalSeen = true;
          terminal = timeoutTerminal(
            nativeSessionId,
            input.history.length > 0 && nativeSessionId !== null ? 'native-resume' : 'history-replay',
          );
          break;
        }
        if (terminalSeen) break;
        if (event.type === 'session') nativeSessionId = event.nativeSessionId;
        if (event.type === 'model') store.setRunModelId(runId, event.modelId);
        if (event.type === 'result') finalText = event.content;
        if (event.type === 'structured' && event.valid) {
          if (thread.origin === 'check') {
            const parsed = conflictCheckResponseSchema.safeParse(event.data);
            structured = parsed.success && parsed.data.findings.every(
              (finding) => allowedCheckCanonDocIds.has(finding.canonSource.docId),
            )
              ? parsed.data
              : null;
          } else {
            structured = event.data;
          }
        }
        // A terminal null is intentional: e.g. a structured repair added a
        // hidden native turn, so the next visible turn must history-replay.
        if (event.type === 'done') nativeSessionId = event.nativeSessionId;
        if (event.type === 'done' || event.type === 'error') {
          terminalSeen = true;
          // `done` is buffered until assistant/session/run writes have all
          // committed. An error has no success state to expose, but its run
          // record is still finalized before the envelope is sent.
          if (event.type === 'done') {
            terminal = event;
            break;
          }
          const terminalEvent = boundedErrorEvent(event);
          terminal = terminalEvent;
          store.finishRun(runId, 'failed', terminalEvent.code, terminalEvent.detail ?? null);
          emit(terminalEvent);
          terminalBroadcast = true;
          break;
        }
        emit(event);
      }

      if (!terminalSeen) {
        const missingTerminal = timedOut
          ? timeoutTerminal(
            nativeSessionId,
            input.history.length > 0 && nativeSessionId !== null ? 'native-resume' : 'history-replay',
          )
          : terminalError('agent stream ended without a terminal event');
        terminal = missingTerminal;
        store.finishRun(
          runId,
          'failed',
          missingTerminal.type === 'error' ? missingTerminal.code : 'timeout',
          missingTerminal.type === 'error' ? missingTerminal.detail ?? null : null,
        );
        emit(missingTerminal);
        terminalBroadcast = true;
      }

      if (terminal?.type === 'done') {
        const status = terminal.stopReason === 'cancelled'
          ? 'cancelled'
          : terminal.stopReason === 'error' || terminal.stopReason === 'timeout'
            ? 'failed'
            : 'completed';
        const shouldPersistSession = Boolean(
          finalText
          && nativeSessionId
          && terminal.stopReason !== 'cancelled'
          && terminal.stopReason !== 'timeout'
          && terminal.stopReason !== 'error',
        );
        store.finalizeRun({
          runId,
          threadId: thread.id,
          agentId: backend.id,
          status,
          errorCode: status === 'failed' ? terminal.stopReason : null,
          errorDetail: null,
          assistant: finalText ? { content: finalText, structured } : null,
          session: shouldPersistSession && nativeSessionId
            ? { nativeSessionId, lastSyncedMessageCount: input.history.length + 2 }
            : null,
        });
        emit(terminal);
        terminalBroadcast = true;
      }
    } catch (error) {
      // A failed `finalizeRun` transaction rolls back any assistant/session
      // writes. Never leak a previously buffered success; publish one generic
      // terminal error after making a best-effort failed run record.
      try {
        store.finishRun(
          runId,
          timedOut ? 'failed' : controller.signal.aborted ? 'cancelled' : 'failed',
          timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'process_error',
        );
      } catch (finishError) {
        this.onInternalError(finishError);
      }
      if (!terminalBroadcast) {
        emit(timedOut
          ? timeoutTerminal(
            nativeSessionId,
            input.history.length > 0 && nativeSessionId !== null ? 'native-resume' : 'history-replay',
          )
          : terminalError(controller.signal.aborted ? 'agent run was cancelled' : 'agent process failed'));
        terminalBroadcast = true;
      }
      this.onInternalError(error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
