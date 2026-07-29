import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@writing-studio/contract';
import { binaryPath, CliBackend, isolatedWorkspace, strictEnvironment, type BackendDefinition, type ParsedLine } from './adapter.js';
import { wrapOutsideVault } from './sandbox.js';

/**
 * Sandboxed children cannot read the macOS Keychain, so headless Claude runs
 * need the long-lived token from `claude setup-token`. Sources, in order: the
 * server's own environment, then a 0600 file under the private data dir. The
 * value is forwarded to Claude children only and is never logged.
 */
function headlessOauthToken(): string | undefined {
  const fromEnv = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (fromEnv) return fromEnv;
  const dataDir = process.env['WRITING_STUDIO_DATA_DIR'];
  if (!dataDir) return undefined;
  try {
    const raw = readFileSync(join(dataDir, 'claude-oauth-token'), 'utf8').trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

function stringAt(value: unknown, path: string[]): string | undefined {
  let cursor: unknown = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

function errorString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row['message'] === 'string') return row['message'];
  if (Array.isArray(row['content'])) {
    const text = row['content']
      .flatMap((part) => (
        part && typeof part === 'object' && typeof (part as Record<string, unknown>)['text'] === 'string'
          ? [(part as Record<string, unknown>)['text'] as string]
          : []
      ))
      .join('\n');
    return text || undefined;
  }
  return undefined;
}

export function parseClaude(value: unknown): ParsedLine | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const type = typeof item['type'] === 'string' ? item['type'] : '';
  const subtype = typeof item['subtype'] === 'string' ? item['subtype'] : '';
  const session = stringAt(item, ['session_id']) ?? stringAt(item, ['sessionId'])
    ?? stringAt(item, ['event', 'session_id']) ?? stringAt(item, ['event', 'sessionId'])
    ?? stringAt(item, ['stream_event', 'event', 'session_id']) ?? stringAt(item, ['stream_event', 'event', 'sessionId']);
  const errorField = errorString(item['error']);
  const isError = item['is_error'] === true || errorField !== undefined;
  const events: AgentEvent[] = [];
  const reportedModel = type === 'system' && subtype === 'init'
    ? stringAt(item, ['model'])
    : type === 'assistant' ? stringAt(item, ['message', 'model']) : undefined;
  if (reportedModel && reportedModel.length <= 200) {
    events.push({ type: 'model', modelId: reportedModel });
  }
  const partialText = stringAt(item, ['event', 'delta', 'text']) ?? stringAt(item, ['stream_event', 'event', 'delta', 'text']);
  const text = partialText ?? stringAt(item, ['delta', 'text']) ?? stringAt(item, ['text'])
    ?? (type === 'result' ? stringAt(item, ['result']) : undefined);
  if (!isError && text && (partialText !== undefined || type.includes('delta') || type === 'assistant' || type === 'content_block_delta')) {
    events.push({ type: 'delta', text });
  }
  const usage = item['usage'];
  if (usage && typeof usage === 'object') {
    const row = usage as Record<string, unknown>;
    const inputTokens = typeof row['input_tokens'] === 'number' ? row['input_tokens'] : undefined;
    const outputTokens = typeof row['output_tokens'] === 'number' ? row['output_tokens'] : undefined;
    if (inputTokens !== undefined || outputTokens !== undefined) events.push({ type: 'usage', ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) });
  }
  const final = type === 'result' ? stringAt(item, ['result']) : undefined;
  const diagnosticDetail = isError
    ? final ?? errorString(item['message']) ?? errorField
    : undefined;
  return {
    events,
    ...(session ? { nativeSessionId: session } : {}),
    ...(final && !events.some((event) => event.type === 'delta') ? { text: final } : {}),
    ...(diagnosticDetail
      ? {
          diagnostic: {
            detail: diagnosticDetail,
            classification: [errorField, diagnosticDetail].filter(Boolean).join(' '),
          },
        }
      : {}),
  };
}

const definition: BackendDefinition = {
  id: 'claude',
  displayName: 'Claude Code',
  pathEnv: 'WRITING_STUDIO_CLAUDE_PATH',
  defaultPath: 'claude',
  freshSessionIdIsStable: true,
  async makeCommand({ ctx, opts, prompt, sessionId, freshSessionId, responseSchema }) {
    const file = binaryPath('WRITING_STUDIO_CLAUDE_PATH', 'claude');
    const args = [
      '--print', '--output-format', 'stream-json',
      '--permission-mode', 'dontAsk', '--no-chrome', '--disable-slash-commands',
      '--safe-mode', '--include-partial-messages', '--verbose',
    ];
    if (ctx.allowVaultBrowsing) args.push('--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob');
    else args.push('--tools', '');
    if (ctx.systemPrompt) args.push('--append-system-prompt', ctx.systemPrompt);
    if (opts.model) args.push('--model', opts.model);
    if (opts.maxBudgetUsd !== null) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
    if (responseSchema) args.push('--json-schema', JSON.stringify(responseSchema));
    if (sessionId) args.push('--resume', sessionId);
    else args.push('--session-id', freshSessionId || randomUUID());
    const workspace = await isolatedWorkspace(ctx, 'claude');
    try {
      const command = wrapOutsideVault({ file, args }, ctx.vaultRoot);
      return {
        ...command, cwd: workspace.cwd,
        env: strictEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: headlessOauthToken() }),
        prompt: `${prompt}\n`,
        ...(workspace.cleanup ? { cleanup: workspace.cleanup } : {}),
      };
    } catch (error) {
      await workspace.cleanup?.();
      throw error;
    }
  },
  parseLine: parseClaude,
};

export const claudeBackend = new CliBackend(definition);
