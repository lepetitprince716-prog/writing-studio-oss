import type { AgentEvent } from '@writing-studio/contract';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { binaryPath, CliBackend, combineCleanup, isolatedWorkspace, schemaFiles, strictEnvironment, type BackendDefinition, type ParsedLine } from './adapter.js';
import { panelPort, webPort, wrapCodexWriter } from './sandbox.js';

const NATIVE_PERMISSION_PROFILE = 'writing-studio-native';

export type CodexSandboxMode = 'seatbelt' | 'native';

export interface NativeCodexPermissionOptions {
  workspaceRoot: string;
  vaultRoot: string;
  dataDir: string;
  panelPort: number;
  webPort: number;
  extraWriteRoots?: string[];
}

export function codexSandboxMode(value = process.env['WRITING_STUDIO_CODEX_SANDBOX']): CodexSandboxMode {
  return value === 'native' ? 'native' : 'seatbelt';
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlInlineTable(entries: Iterable<readonly [string, string]>): string {
  return `{${[...entries].map(([key, value]) => `${tomlString(key)}=${value}`).join(',')}}`;
}

/**
 * Build a per-invocation Codex permission profile. The native network policy
 * cannot distinguish loopback ports: its local/private guard blocks all
 * loopback, including both panel ports named in the description.
 */
export function nativeCodexPermissionOverrides(options: NativeCodexPermissionOptions): string[] {
  const filesystem = new Map<string, string>([
    [':root', tomlString('read')],
    [':minimal', tomlString('read')],
    [':workspace_roots', tomlInlineTable([['.', tomlString('write')]])],
    [':tmpdir', tomlString('write')],
    [options.workspaceRoot, tomlString('write')],
    [join(homedir(), '.codex'), tomlString('write')],
  ]);
  for (const root of options.extraWriteRoots ?? []) filesystem.set(root, tomlString('write'));
  for (const root of [
    join(homedir(), '.ssh'),
    join(homedir(), '.aws'),
    join(homedir(), '.gnupg'),
    join(homedir(), '.kube'),
    join(homedir(), '.docker'),
    join(homedir(), '.claude'),
    join(homedir(), 'Library', 'Keychains'),
    options.dataDir,
    options.vaultRoot,
  ]) filesystem.set(root, tomlString('deny'));

  const description = `Writing Studio writer; local/private guard blocks loopback ports ${options.panelPort} and ${options.webPort}`;
  const profile = [
    `description=${tomlString(description)}`,
    `filesystem=${tomlInlineTable(filesystem)}`,
    'network={enabled=true,allow_local_binding=false,allow_upstream_proxy=true,domains={"*"="allow"}}',
  ].join(',');
  return [
    '-c', `features.network_proxy=true`,
    '-c', `default_permissions=${tomlString(NATIVE_PERMISSION_PROFILE)}`,
    '-c', `permissions.${NATIVE_PERMISSION_PROFILE}={${profile}}`,
  ];
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'message']) {
    const candidate = object[key];
    if (typeof candidate === 'string') return candidate;
  }
  return undefined;
}

function parseCodex(value: unknown): ParsedLine | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const type = typeof row['type'] === 'string' ? row['type'] : '';
  const events: AgentEvent[] = [];
  const nativeSessionId = typeof row['thread_id'] === 'string' ? row['thread_id']
    : typeof row['threadId'] === 'string' ? row['threadId'] : undefined;
  const item = row['item'];
  const text = (type.includes('item') || type.includes('message')) ? textOf(item) ?? textOf(row['delta']) : undefined;
  if (text) events.push({ type: 'delta', text });
  const usage = row['usage'];
  if (usage && typeof usage === 'object') {
    const u = usage as Record<string, unknown>;
    const inputTokens = typeof u['input_tokens'] === 'number' ? u['input_tokens'] : undefined;
    const outputTokens = typeof u['output_tokens'] === 'number' ? u['output_tokens'] : undefined;
    if (inputTokens !== undefined || outputTokens !== undefined) events.push({ type: 'usage', ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) });
  }
  return { events, ...(nativeSessionId ? { nativeSessionId } : {}) };
}

const definition: BackendDefinition = {
  id: 'codex',
  displayName: 'Codex CLI',
  pathEnv: 'WRITING_STUDIO_CODEX_PATH',
  defaultPath: 'codex',
  async makeCommand({ ctx, opts, prompt, sessionId, responseSchema }) {
    const binary = binaryPath('WRITING_STUDIO_CODEX_PATH', 'codex');
    const workspace = await isolatedWorkspace(ctx, 'codex');
    const files = responseSchema ? await schemaFiles(responseSchema) : null;
    const sandboxMode = codexSandboxMode();
    if (sandboxMode === 'native' && !ctx.dataDir) {
      await files?.cleanup();
      await workspace.cleanup?.();
      throw new Error('native Codex sandbox requires the panel data directory');
    }
    // Global flags deliberately precede `exec`; Codex otherwise treats them as prompt args.
    const args = sandboxMode === 'native'
      ? ['--ask-for-approval', 'never', '--cd', workspace.cwd, 'exec']
      : ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never', '--cd', workspace.cwd, 'exec'];
    if (sessionId) args.push('resume', sessionId);
    args.push('--ignore-user-config', '--ignore-rules', '--json', '--skip-git-repo-check');
    if (sandboxMode === 'native') {
      args.push(...nativeCodexPermissionOverrides({
        workspaceRoot: workspace.cwd,
        vaultRoot: ctx.vaultRoot,
        dataDir: ctx.dataDir!,
        panelPort: panelPort(),
        webPort: webPort(),
        ...(files ? { extraWriteRoots: [files.dir] } : {}),
      }));
    }
    if (opts.model) args.push('--model', opts.model);
    if (files) args.push('--output-schema', files.schemaPath, '-o', files.outputPath);
    args.push('-'); // Codex's documented stdin-prompt sentinel.
    try {
      const wrapped = sandboxMode === 'native'
        ? { file: binary, args }
        : wrapCodexWriter({ file: binary, args }, {
            workspaceRoot: workspace.cwd,
            vaultRoot: ctx.vaultRoot,
            ...(files ? { extraReadRoots: [files.dir], extraWriteRoots: [files.dir] } : {}),
          });
      const cleanup = combineCleanup(files?.cleanup, workspace.cleanup);
      return {
        ...wrapped, cwd: workspace.cwd, env: strictEnvironment(), prompt: `${prompt}\n`,
        ...(cleanup ? { cleanup } : {}),
        ...(files ? { readOutput: files.readOutput } : {}),
      };
    } catch (error) {
      await files?.cleanup();
      await workspace.cleanup?.();
      throw error;
    }
  },
  parseLine: parseCodex,
  requiresFilesystemSandbox: () => codexSandboxMode() === 'seatbelt',
};

export const codexBackend = new CliBackend(definition);
