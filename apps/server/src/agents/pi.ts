import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@writing-studio/contract';
import {
  binaryPath,
  CliBackend,
  isolatedWorkspace,
  strictEnvironment,
  type BackendDefinition,
  type ParsedLine,
} from './adapter.js';
import { processSupervisor } from './supervisor.js';
import { createCachedBinaryProbe } from './model-catalog-cache.js';

const DEFAULT_PI_PATH = join(homedir(), '.local', 'bin', 'pi');

function objectAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === 'object'
    ? nested as Record<string, unknown>
    : null;
}

function textContent(message: Record<string, unknown>): string {
  const content = message['content'];
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object'))
    .filter((item) => item['type'] === 'text' && typeof item['text'] === 'string')
    .map((item) => item['text'] as string)
    .join('');
}

function usageEvent(message: Record<string, unknown>): AgentEvent | null {
  const usage = objectAt(message, 'usage');
  if (!usage) return null;
  const inputTokens = typeof usage['input'] === 'number' ? usage['input'] : undefined;
  const outputTokens = typeof usage['output'] === 'number' ? usage['output'] : undefined;
  const cost = objectAt(usage, 'cost');
  const costUsd = typeof cost?.['total'] === 'number' ? cost['total'] : undefined;
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return null;
  return {
    type: 'usage',
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function assertMessageSucceeded(message: Record<string, unknown>): void {
  const stopReason = message['stopReason'];
  if (stopReason !== 'error' && stopReason !== 'aborted') return;
  const detail = typeof message['errorMessage'] === 'string'
    ? message['errorMessage']
    : `pi request ${stopReason}`;
  throw new Error(detail);
}

/** Map pi 0.80.x JSON-mode events to the shared panel event stream. */
export function parsePiLine(value: unknown): ParsedLine | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const type = typeof item['type'] === 'string' ? item['type'] : '';
  if (type === 'session' && typeof item['id'] === 'string') {
    return { events: [], nativeSessionId: item['id'] };
  }
  if (type === 'message_update') {
    const update = objectAt(item, 'assistantMessageEvent');
    if (!update) return null;
    if (update['type'] === 'text_delta' && typeof update['delta'] === 'string') {
      return { events: [{ type: 'delta', text: update['delta'] }] };
    }
    if (update['type'] === 'error') {
      const error = objectAt(update, 'error');
      if (error) assertMessageSucceeded(error);
    }
    return null;
  }
  if (type === 'message_end') {
    const message = objectAt(item, 'message');
    if (!message || message['role'] !== 'assistant') return null;
    assertMessageSucceeded(message);
    const usage = usageEvent(message);
    const text = textContent(message);
    return {
      events: usage ? [usage] : [],
      ...(text ? { text } : {}),
    };
  }
  return null;
}

function piEnvironment(): NodeJS.ProcessEnv {
  const environment = strictEnvironment();
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_BASE_URL',
    'AZURE_OPENAI_RESOURCE_NAME',
    'AZURE_OPENAI_API_VERSION',
    'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
    'GEMINI_API_KEY',
    'ZAI_API_KEY',
    'ZAI_CODING_CN_API_KEY',
    'DEEPSEEK_API_KEY',
    'OPENROUTER_API_KEY',
    'GROQ_API_KEY',
    'XAI_API_KEY',
    'MISTRAL_API_KEY',
    'MINIMAX_API_KEY',
    'MOONSHOT_API_KEY',
    'OPENCODE_API_KEY',
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function parseModelTable(output: string): Array<{ id: string; label: string }> {
  const models: Array<{ id: string; label: string }> = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/).slice(1)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\S+/);
    if (!match?.[1] || !match[2]) continue;
    const id = `${match[1]}/${match[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
    if (models.length >= 100) break;
  }
  return models;
}

const probePiModels = createCachedBinaryProbe<{ id: string; label: string }>(async (binary) => {
  let stdout = '';
  const controller = new AbortController();
  for await (const chunk of processSupervisor.run({
    file: binary,
    args: ['--list-models'],
    cwd: tmpdir(),
    env: piEnvironment(),
    stdin: '',
    // pi cold start plus a ~100-row catalog can exceed 5s under load.
    timeoutMs: 15_000,
    signal: controller.signal,
  })) {
    if (chunk.type === 'stdout') stdout += chunk.text;
    if (chunk.type === 'exit' && chunk.code !== 0) {
      throw new Error('pi model catalog probe failed');
    }
  }
  return parseModelTable(stdout);
});

const definition: BackendDefinition = {
  id: 'pi',
  displayName: 'Pi',
  pathEnv: 'WRITING_STUDIO_PI_PATH',
  defaultPath: DEFAULT_PI_PATH,
  freshSessionIdIsStable: true,
  requiresFilesystemSandbox: false,
  probeModels: probePiModels,
  async makeCommand({ ctx, opts, prompt, sessionId, freshSessionId }) {
    const file = binaryPath('WRITING_STUDIO_PI_PATH', DEFAULT_PI_PATH);
    const args = [
      '--print',
      '--mode',
      'json',
      '--no-tools',
      '--no-context-files',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-approve',
      '--session-id',
      sessionId ?? freshSessionId,
    ];
    if (ctx.systemPrompt) args.push('--system-prompt', ctx.systemPrompt);
    if (opts.model) args.push('--model', opts.model);
    const workspace = await isolatedWorkspace(ctx, 'pi');
    return {
      file,
      args,
      cwd: workspace.cwd,
      env: piEnvironment(),
      prompt,
      ...(workspace.cleanup ? { cleanup: workspace.cleanup } : {}),
    };
  },
  parseLine: parsePiLine,
};

export const piBackend = new CliBackend(definition);
