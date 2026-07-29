import type { AgentEvent } from '@writing-studio/contract';
import { binaryPath, CliBackend, isolatedWorkspace, strictEnvironment, type BackendDefinition, type ParsedLine } from './adapter.js';
import { wrapOutsideVault } from './sandbox.js';

function errorString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  return typeof row['message'] === 'string' ? row['message']
    : typeof row['text'] === 'string' ? row['text']
      : undefined;
}

export function parseOpenCode(value: unknown): ParsedLine | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const type = typeof row['type'] === 'string' ? row['type'] : '';
  const part = row['part'] && typeof row['part'] === 'object' ? row['part'] as Record<string, unknown> : null;
  const errorField = errorString(row['error']) ?? errorString(part?.['error']);
  const isError = row['is_error'] === true || part?.['is_error'] === true || errorField !== undefined;
  const nativeSessionId = typeof row['sessionID'] === 'string' ? row['sessionID']
    : typeof row['session_id'] === 'string' ? row['session_id']
      : typeof part?.['sessionID'] === 'string' ? part['sessionID']
        : typeof part?.['session_id'] === 'string' ? part['session_id'] : undefined;
  const events: AgentEvent[] = [];
  const delta = row['delta'];
  const text = typeof delta === 'string' ? delta
    : delta && typeof delta === 'object' && typeof (delta as Record<string, unknown>)['text'] === 'string'
      ? (delta as Record<string, unknown>)['text'] as string
      : typeof row['text'] === 'string' ? row['text']
        : typeof part?.['text'] === 'string' ? part['text'] : undefined;
  // OpenCode sometimes sends one complete delta, which is valid streaming text.
  if (!isError && text && (type.includes('message') || type.includes('delta') || type === 'text')) events.push({ type: 'delta', text });
  const usage = row['usage'];
  if (usage && typeof usage === 'object') {
    const u = usage as Record<string, unknown>;
    const inputTokens = typeof u['input'] === 'number' ? u['input'] : undefined;
    const outputTokens = typeof u['output'] === 'number' ? u['output'] : undefined;
    if (inputTokens !== undefined || outputTokens !== undefined) events.push({ type: 'usage', ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) });
  }
  const diagnosticDetail = isError
    ? errorString(row['message']) ?? errorString(part?.['message']) ?? errorField
    : undefined;
  return {
    events,
    ...(nativeSessionId ? { nativeSessionId } : {}),
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
  id: 'opencode',
  displayName: 'OpenCode',
  pathEnv: 'WRITING_STUDIO_OPENCODE_PATH',
  defaultPath: 'opencode',
  async makeCommand({ ctx, opts, prompt, sessionId }) {
    const binary = binaryPath('WRITING_STUDIO_OPENCODE_PATH', 'opencode');
    const workspace = await isolatedWorkspace(ctx, 'opencode');
    const args = ['run', '--format', 'json', '--pure', '--dir', workspace.cwd, '--agent', ctx.allowVaultBrowsing ? 'reader' : 'text'];
    if (sessionId) args.push('--session', sessionId);
    if (opts.model) args.push('--model', opts.model);
    // OpenCode runs small_model for title/summary work before the primary
    // stream, so an explicit model has to pin both routes or the small one
    // silently falls back to whatever the user's global config names. With no
    // model given, both keys are omitted and the global config decides.
    const pinnedModel = opts.model;
    const config = JSON.stringify({
      share: 'disabled', autoupdate: false, plugin: [], mcp: {},
      ...(pinnedModel ? { model: pinnedModel, small_model: pinnedModel } : {}),
      agent: {
        reader: { permission: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' } },
        text: { permission: { '*': 'deny' } },
      },
    });
    try {
      const wrapped = wrapOutsideVault({ file: binary, args }, ctx.vaultRoot);
      return {
        ...wrapped, cwd: workspace.cwd,
        env: strictEnvironment({ OPENCODE_CONFIG_CONTENT: config, OPENCODE_DISABLE_AUTOUPDATE: 'true' }),
        prompt: `${prompt}\n`, ...(workspace.cleanup ? { cleanup: workspace.cleanup } : {}),
      };
    } catch (error) {
      await workspace.cleanup?.();
      throw error;
    }
  },
  parseLine: parseOpenCode,
};

export const opencodeBackend = new CliBackend(definition);
