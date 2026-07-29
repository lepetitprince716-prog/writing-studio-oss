/**
 * AgentBackend adapter contract. Implemented in apps/server;
 * consumed by the panel via the WS event stream (see events.ts).
 *
 * Design invariants (do not weaken without a dual-signed contract change):
 * 1. The panel message table is the single source of truth for thread history.
 *    Native CLI sessions are acceleration caches only.
 * 2. Agents never write files. Rewrite output is returned as text/structured
 *    data and persisted by the panel after user confirmation.
 * 3. Every adapter spawns its CLI with read-only permissions
 *    (claude --allowedTools, codex --sandbox read-only, opencode agent def).
 */

import type { AgentId, Message } from './models.js';
import type { PromptBundle } from './prompts.js';

/** Per-(thread, agent) native-session cache record. */
export interface AgentSessionRef {
  agentId: AgentId;
  /** claude --resume uuid / codex exec resume id / opencode --session id. */
  nativeSessionId: string | null;
  /**
   * Count (not a zero-based index) of panel messages this native session has already seen.
   * If it equals the current history length, native resume is valid;
   * otherwise the adapter must replay history into a fresh session.
   */
  lastSyncedMessageCount: number;
  createdAt: number;
  lastUsedAt: number;
}

/**
 * File policy used to construct an isolated, read-only planner projection.
 * Paths are vault-relative POSIX globs. `forbidden` always takes precedence.
 */
export interface VaultReadPolicy {
  readable: string[];
  forbidden: string[];
}

export interface ThreadRunContext {
  threadId: string;
  /**
   * Absolute panel-owned data root. Native permission profiles use this to
   * deny the message database and private CLI credentials at the OS boundary.
   */
  dataDir?: string | undefined;
  /**
   * Absolute vault root. Writer-profile runs (`allowVaultBrowsing=false`) MUST
   * use an isolated working directory outside this vault, not this path as
   * their child-process cwd; they receive only the supplied context block.
   */
  vaultRoot: string;
  /**
   * Full panel-side history, oldest first, excluding the `userMessage` passed
   * to `send` for this run.
   */
  history: Message[];
  /**
   * Generation threads replay only the latest assistant candidate; ordinary
   * threads use the bounded chronological replay.
   */
  historyReplayMode?: 'bounded' | 'latest-candidate' | undefined;
  session: AgentSessionRef | null;
  /**
   * Pre-built context block injected by the panel (profile-filtered excerpts:
   * anchored selection, document excerpt, canon snippets). The adapter treats
   * this as opaque text prepended to the prompt.
   */
  contextBlock: string;
  /** Whether the agent may browse the vault with read tools (planner profile). */
  allowVaultBrowsing: boolean;
  /**
   * Effective profile policy for a planner run. Adapters must never use the
   * original vault as their cwd: they receive only a temporary projection
   * containing regular files admitted by this policy.
   */
  vaultReadPolicy: VaultReadPolicy | null;
  systemPrompt: string | null;
  /** Resolved project prompt bundle; required so project overrides cannot be silently dropped. */
  promptBundle: PromptBundle;
}

export interface SendOptions {
  model: string | null;
  /** Wall-clock timeout for this run. */
  timeoutMs: number;
  /** Native support: claude only. Others enforced softly by the adapter. */
  maxBudgetUsd: number | null;
  /** When set, the run must produce a structured result matching this schema. */
  responseSchema: Record<string, unknown> | null;
  /** Abort → SIGTERM → grace 3s → SIGKILL (process group). */
  signal: AbortSignal;
}

export type AgentErrorCode =
  | 'cli_not_found'
  | 'cli_not_authenticated'
  | 'network_error'
  | 'parse_error'
  | 'budget_exceeded'
  | 'timeout'
  | 'cancelled'
  | 'busy'
  | 'sandbox_unavailable'
  | 'process_error';

export type StopReason = 'end_turn' | 'max_budget' | 'cancelled' | 'timeout' | 'error';

export interface RewriteResponse {
  rewritten_text: string;
  notes?: string;
}

export interface ConflictFinding {
  claimInText: string;
  textQuote: string;
  canonSource: {
    docId: string;
    heading: string;
  };
  conflictType: 'character' | 'setting' | 'timeline' | 'other';
  severity: 'high' | 'medium' | 'low';
  explanation: string;
}

export interface ConflictCheckResponse {
  findings: ConflictFinding[];
}

export type StructuredAgentResponse = RewriteResponse | ConflictCheckResponse;

export type AgentEvent =
  | { type: 'session'; nativeSessionId: string }
  | { type: 'model'; modelId: string }
  | { type: 'delta'; text: string }
  | {
      type: 'tool';
      tool: string;
      status: 'requested' | 'denied' | 'completed' | 'failed';
      detail?: unknown;
    }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | {
      type: 'structured';
      data: StructuredAgentResponse | null;
      valid: boolean;
      /** Raw model text the structured payload was parsed from. */
      raw: string;
    }
  | { type: 'result'; content: string }
  | {
      type: 'done';
      stopReason: StopReason;
      nativeSessionId: string | null;
      strategyUsed: 'native-resume' | 'history-replay';
    }
  | {
      type: 'error';
      code: AgentErrorCode;
      message: string;
      retryable: boolean;
      /** Bounded, ANSI-free diagnostic emitted by the CLI itself. */
      detail?: string;
    };

/**
 * One selectable model for an agent CLI, as passed to its `--model` flag.
 * The catalog is advisory: the CLI remains the final validator, so a stale
 * catalog degrades to a CLI-side error instead of blocking the run.
 */
export interface AgentModelOption {
  /** Value passed verbatim as the CLI `--model` argument. */
  id: string;
  /** Human-readable label, e.g. "Sonnet 4.6". */
  label: string;
  isDefault?: boolean | undefined;
}

export interface AgentAvailability {
  agentId: AgentId;
  ok: boolean;
  /** Profiles whose filesystem/tool boundary is currently enforceable. */
  supportedProfiles: Array<'writer' | 'planner'>;
  version: string | null;
  binaryPath: string;
  error: string | null;
  /**
   * Selectable models for this agent. Feature gate: while absent, the server
   * does not support per-run model selection for this agent, and the panel
   * must hide the model selector and omit `model` from message requests.
   */
  models?: AgentModelOption[] | undefined;
}

export interface AgentBackend {
  readonly id: AgentId;
  readonly displayName: string;
  probeAvailability(): Promise<AgentAvailability>;
  /**
   * Run one user turn. The returned stream always terminates with a single
   * `done` or `error` event; consumers must never hang on user cancellation.
   */
  send(
    ctx: ThreadRunContext,
    userMessage: string,
    opts: SendOptions,
  ): AsyncIterable<AgentEvent>;
}

/** Canonical structured-output schema for rewrite runs. */
export const REWRITE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    rewritten_text: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['rewritten_text'],
  additionalProperties: false,
};

/** Canonical structured-output schema for semantic conflict checks. */
export const CONFLICT_CHECK_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claimInText: { type: 'string', minLength: 1 },
          textQuote: { type: 'string', minLength: 1 },
          canonSource: {
            type: 'object',
            properties: {
              docId: { type: 'string', minLength: 1 },
              heading: { type: 'string', minLength: 1 },
            },
            required: ['docId', 'heading'],
            additionalProperties: false,
          },
          conflictType: { enum: ['character', 'setting', 'timeline', 'other'] },
          severity: { enum: ['high', 'medium', 'low'] },
          explanation: { type: 'string', minLength: 1 },
        },
        required: [
          'claimInText',
          'textQuote',
          'canonSource',
          'conflictType',
          'severity',
          'explanation',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
};
