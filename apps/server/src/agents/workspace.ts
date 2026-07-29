import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { ThreadRunContext } from '@writing-studio/contract';

export interface IsolatedWorkspace {
  /** The only project-content root a CLI process may read. */
  cwd: string;
  /** Remove ephemeral, potentially sensitive planner copies after the run. */
  cleanup?: () => Promise<void>;
}

export function strictEnvironment(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const key of [
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  ]) {
    const value = process.env[key];
    if (value !== undefined) picked[key] = value;
  }
  // `extra` is itself an allowlist: each adapter names exactly the variables
  // its CLI needs, so no ambient environment can leak through this path.
  for (const key of Object.keys(extra)) {
    const value = extra[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

export function binaryPath(pathEnv: string, fallback: string): string {
  return process.env[pathEnv] ?? fallback;
}

export function stripAnsiAndNulls(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\0', '');
}

function globPattern(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

function allowedByPolicy(path: string, policy: NonNullable<ThreadRunContext['vaultReadPolicy']>): boolean {
  return policy.readable.some((pattern) => globPattern(pattern).test(path))
    && !policy.forbidden.some((pattern) => globPattern(pattern).test(path));
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Construct a private, read-only copy of the planner's admitted vault files.
 * Symlinks are ignored rather than followed; this makes a readable glob unable
 * to escape the vault through a linked file or directory. `forbidden` wins
 * even when a broader readable glob also matches.
 */
export async function createPlannerProjection(
  vaultRoot: string,
  policy: NonNullable<ThreadRunContext['vaultReadPolicy']>,
): Promise<IsolatedWorkspace> {
  const sourceRoot = await realpath(vaultRoot);
  const projection = await mkdtemp(join(tmpdir(), 'writing-studio-planner-'));
  const copyOne = async (absolutePath: string, relativePath: string): Promise<void> => {
    const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return;
      const resolved = await realpath(absolutePath);
      if (!contained(sourceRoot, resolved)) return;
      const destination = join(projection, relativePath);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, await handle.readFile(), { mode: 0o600, flag: 'wx' });
    } finally {
      await handle.close();
    }
  };
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(sourceRoot, absolutePath).split(sep).join('/');
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && allowedByPolicy(relativePath, policy)) {
        await copyOne(absolutePath, relativePath);
      }
    }
  };
  try {
    await visit(sourceRoot);
    return { cwd: projection, cleanup: () => rm(projection, { recursive: true, force: true }) };
  } catch (error) {
    await rm(projection, { recursive: true, force: true });
    throw error;
  }
}

/** Build an isolated workspace for every CLI run, never a vault cwd. */
export async function isolatedWorkspace(
  ctx: ThreadRunContext,
  agentId: string,
): Promise<IsolatedWorkspace> {
  if (ctx.allowVaultBrowsing) {
    if (!ctx.vaultReadPolicy) throw new Error('planner run is missing its vault read policy');
    return createPlannerProjection(ctx.vaultRoot, ctx.vaultReadPolicy);
  }
  return { cwd: await writerScratch(ctx.threadId, agentId) };
}

export function combineCleanup(...cleanup: Array<(() => Promise<void>) | undefined>): (() => Promise<void>) | undefined {
  const actions = cleanup.filter((action): action is () => Promise<void> => action !== undefined);
  return actions.length === 0 ? undefined : async () => {
    await Promise.allSettled(actions.map(async (action) => action()));
  };
}

/** Stable vault-external cwd, isolated by panel thread and backend id. */
export async function writerScratch(threadId: string, agentId: string): Promise<string> {
  const token = createHash('sha256').update(`${threadId}\0${agentId}`).digest('hex').slice(0, 24);
  const path = join(tmpdir(), 'writing-studio-scratch', `${agentId}-${token}`);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

export async function schemaFiles(schema: Record<string, unknown>): Promise<{
  dir: string;
  schemaPath: string;
  outputPath: string;
  cleanup: () => Promise<void>;
  readOutput: () => Promise<string | null>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'writing-studio-agent-'));
  const schemaPath = join(dir, 'response.schema.json');
  const outputPath = join(dir, 'response.json');
  await writeFile(schemaPath, JSON.stringify(schema), 'utf8');
  return {
    dir, schemaPath, outputPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
    async readOutput(): Promise<string | null> {
      try { return await readFile(outputPath, 'utf8'); } catch { return null; }
    },
  };
}
