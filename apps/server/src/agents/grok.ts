import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import type { AgentEvent, AgentModelOption } from '@writing-studio/contract';
import {
  binaryPath,
  CliBackend,
  combineCleanup,
  isolatedWorkspace,
  strictEnvironment,
  type BackendDefinition,
  type ParsedLine,
} from './adapter.js';
import { wrapGrokWriter } from './sandbox.js';
import { processSupervisor } from './supervisor.js';
import { createCachedBinaryProbe } from './model-catalog-cache.js';

const ALL_GROK_TOOLS = [
  'run_terminal_cmd',
  'grep',
  'read_file',
  'search_replace',
  'list_dir',
  'web_search',
  'web_fetch',
  'todo_write',
  'task',
  'Agent',
].join(',');
const GROK_DENY_RULES = ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'WebFetch', 'MCPTool'];

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  return typeof row[key] === 'string' ? row[key] as string : undefined;
}

function usageEvent(value: unknown): AgentEvent | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  const inputTokens = typeof usage['inputTokens'] === 'number'
    ? usage['inputTokens']
    : typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : undefined;
  const outputTokens = typeof usage['outputTokens'] === 'number'
    ? usage['outputTokens']
    : typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return null;
  return {
    type: 'usage',
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/** Map Grok 0.2.x streaming-json and final json records to shared events. */
export function parseGrok(value: unknown): ParsedLine | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const type = stringField(row, 'type') ?? '';
  const sessionId = stringField(row, 'sessionId') ?? stringField(row, 'session_id');
  if (type === 'text' && typeof row['data'] === 'string') {
    return { events: [{ type: 'delta', text: row['data'] }], ...(sessionId ? { nativeSessionId: sessionId } : {}) };
  }
  if (type === 'end') {
    const usage = usageEvent(row['usage']);
    return {
      events: usage ? [usage] : [],
      ...(sessionId ? { nativeSessionId: sessionId } : {}),
    };
  }
  if (type === 'error') {
    const detail = stringField(row, 'message') ?? stringField(row, 'data') ?? 'Grok CLI error';
    return {
      events: [],
      ...(sessionId ? { nativeSessionId: sessionId } : {}),
      diagnostic: { detail, classification: detail },
    };
  }
  // `--json-schema` implies final JSON mode: one object containing text and
  // sessionId rather than the streaming `text` / `end` records.
  const text = stringField(row, 'text');
  const usage = usageEvent(row['usage']);
  if (text !== undefined || sessionId || usage) {
    return {
      events: usage ? [usage] : [],
      ...(sessionId ? { nativeSessionId: sessionId } : {}),
      ...(text !== undefined ? { text } : {}),
    };
  }
  // Thought records are intentionally not exposed as user-visible deltas.
  return null;
}

function parseModelCatalog(output: string): AgentModelOption[] {
  const defaultModel = output.match(/^Default model:\s*(\S+)/m)?.[1];
  const available = output.split(/^Available models:\s*$/m)[1] ?? '';
  const models: AgentModelOption[] = [];
  const seen = new Set<string>();
  for (const line of available.split(/\r?\n/)) {
    const match = line.match(/^\s*\*\s+(\S+)(?:\s+\(default\))?\s*$/);
    const id = match?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id, ...(id === defaultModel ? { isDefault: true } : {}) });
    if (models.length >= 100) break;
  }
  return models;
}

const probeGrokModels = createCachedBinaryProbe<AgentModelOption>(async (binary) => {
  let stdout = '';
  const controller = new AbortController();
  for await (const chunk of processSupervisor.run({
    file: binary,
    args: ['models'],
    cwd: tmpdir(),
    env: strictEnvironment(),
    stdin: '',
    timeoutMs: 15_000,
    signal: controller.signal,
  })) {
    if (chunk.type === 'stdout') stdout += chunk.text;
    if (chunk.type === 'exit' && chunk.code !== 0) throw new Error('Grok model catalog probe failed');
  }
  return parseModelCatalog(stdout);
});

const definition: BackendDefinition = {
  id: 'grok',
  displayName: 'Grok CLI',
  pathEnv: 'WRITING_STUDIO_GROK_PATH',
  defaultPath: 'grok',
  freshSessionIdIsStable: true,
  probeModels: probeGrokModels,
  async makeCommand({ ctx, opts, prompt, sessionId, freshSessionId, responseSchema }) {
    const file = binaryPath('WRITING_STUDIO_GROK_PATH', 'grok');
    const workspace = await isolatedWorkspace(ctx, 'grok');
    const promptPath = join(workspace.cwd, 'prompt.txt');
    const promptCleanup = () => rm(promptPath, { force: true });
    const cleanup = combineCleanup(promptCleanup, workspace.cleanup);
    try {
      await promptCleanup();
      await writeFile(promptPath, prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      await cleanup?.();
      throw error;
    }
    const args = [
      '--prompt-file',
      promptPath,
      '--output-format',
      responseSchema ? 'json' : 'streaming-json',
      '--permission-mode',
      'dontAsk',
      '--tools',
      '',
      '--disallowed-tools',
      ALL_GROK_TOOLS,
      '--disable-web-search',
      '--no-subagents',
      '--no-memory',
      '--no-plan',
      '--verbatim',
      '--max-turns',
      '1',
    ];
    for (const rule of GROK_DENY_RULES) args.push('--deny', rule);
    if (ctx.systemPrompt) args.push('--system-prompt-override', ctx.systemPrompt);
    if (opts.model) args.push('--model', opts.model);
    if (responseSchema) args.push('--json-schema', JSON.stringify(responseSchema));
    if (sessionId) args.push('--resume', sessionId);
    else args.push('--session-id', freshSessionId);
    try {
      const command = wrapGrokWriter(
        { file, args },
        { workspaceRoot: workspace.cwd, vaultRoot: ctx.vaultRoot },
      );
      return {
        ...command,
        cwd: workspace.cwd,
        env: strictEnvironment(),
        prompt: '',
        ...(cleanup ? { cleanup } : {}),
      };
    } catch (error) {
      await cleanup?.();
      throw error;
    }
  },
  parseLine: parseGrok,
};

export const grokBackend = new CliBackend(definition);
