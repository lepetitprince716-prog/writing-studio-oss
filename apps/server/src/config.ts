/** Registry and vault-side project configuration loading. */

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  projectConfigSchema,
  type Project,
  type ProjectListItem,
} from '@writing-studio/contract';
import { z } from 'zod';
import { asErrorMessage, StudioError } from './errors.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/**
 * Keep the checkout usable as-is, while allowing a clone to keep its panel
 * data and registry somewhere else.  Neither default contains a user path.
 */
export const DEFAULT_DATA_DIR = resolve(process.env['WRITING_STUDIO_DATA_DIR'] ?? join(REPO_ROOT, 'data'));

const registryEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
    vaultRoot: z.string().min(1),
    enabled: z.boolean(),
  })
  .strict();

export const registrySchema = z
  .object({ projects: z.array(registryEntrySchema) })
  .strict()
  .superRefine((registry, ctx) => {
    const seen = new Set<string>();
    registry.projects.forEach((entry, index) => {
      if (seen.has(entry.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['projects', index, 'id'],
          message: `duplicate project id: ${entry.id}`,
        });
      }
      seen.add(entry.id);
    });
  });

export type LoadedProject =
  | { status: 'ready'; id: string; project: Project }
  | {
      status: 'invalid';
      id: string;
      displayName: string;
      vaultRoot: string;
      dataDir: string;
      error: string;
    };

export interface RegistryLocation {
  /** Directory containing per-project panel data. */
  dataDir: string;
  /** Registry used for this process. Missing is a supported bootstrap state. */
  registryPath: string;
  exists: boolean;
}

function expandHome(path: string): string {
  if (path === '~') return process.env['HOME'] ?? path;
  if (path.startsWith('~/')) return join(process.env['HOME'] ?? '~', path.slice(2));
  return path;
}

/**
 * Absolute registry entries keep their traditional behavior. Relative entries
 * are deliberately rooted at the registry itself, not process.cwd(), so a
 * checked-out example remains portable when the server is launched elsewhere.
 */
function resolveVaultRoot(registryPath: string, vaultRoot: string): string {
  return resolve(dirname(registryPath), expandHome(vaultRoot));
}

function readRegistry(registryPath: string): z.infer<typeof registryEntrySchema>[] {
  if (!existsSync(registryPath)) return [];
  try {
    return registrySchema.parse(JSON.parse(readFileSync(registryPath, 'utf8'))).projects;
  } catch (error) {
    throw new StudioError('INVALID_CONFIG', `invalid registry: ${asErrorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * Resolve configuration without reading or creating anything.  Callers that
 * render a setup screen can use `exists` to distinguish "no projects yet"
 * from an intentionally empty `{ projects: [] }` registry.
 */
export function resolveRegistryLocation(options?: {
  dataDir?: string;
  registryPath?: string;
}): RegistryLocation {
  const dataDir = resolve(options?.dataDir ?? DEFAULT_DATA_DIR);
  const registryPath = resolve(
    options?.registryPath ?? process.env['WRITING_STUDIO_REGISTRY_PATH'] ?? join(dataDir, 'registry.json'),
  );
  return { dataDir, registryPath, exists: existsSync(registryPath) };
}

export function loadProjects(options?: {
  dataDir?: string;
  registryPath?: string;
}): Map<string, LoadedProject> {
  const { dataDir: dataRoot, registryPath } = resolveRegistryLocation(options);
  const projects = new Map<string, LoadedProject>();

  for (const entry of readRegistry(registryPath)) {
    if (!entry.enabled) continue;
    const unresolvedVaultRoot = resolveVaultRoot(registryPath, entry.vaultRoot);
    const dataDir = join(dataRoot, entry.id);
    let vaultRoot = unresolvedVaultRoot;

    try {
      if (!existsSync(unresolvedVaultRoot) || !statSync(unresolvedVaultRoot).isDirectory()) {
        throw new Error(`vault root is not a directory: ${unresolvedVaultRoot}`);
      }
      vaultRoot = realpathSync(unresolvedVaultRoot);
      const configPath = join(vaultRoot, '.writing-studio', 'project.json');
      const config = projectConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
      if (config.id !== entry.id) {
        throw new Error(`registry id ${entry.id} does not match project config id ${config.id}`);
      }
      if (config.aiProfiles.writer.allowVaultBrowsing) {
        throw new Error('writer profile must set allowVaultBrowsing=false');
      }
      mkdirSync(dataDir, { recursive: true });
      projects.set(entry.id, {
        status: 'ready',
        id: entry.id,
        project: { config, vaultRoot, dataDir },
      });
    } catch (error) {
      projects.set(entry.id, {
        status: 'invalid',
        id: entry.id,
        displayName: entry.id,
        vaultRoot,
        dataDir,
        error: asErrorMessage(error),
      });
    }
  }
  return projects;
}

export function projectListItems(projects: Map<string, LoadedProject>): ProjectListItem[] {
  return [...projects.values()].map((loaded) =>
    loaded.status === 'ready'
      ? { status: 'ready', project: loaded.project }
      : {
          status: 'invalid',
          id: loaded.id,
          displayName: loaded.displayName,
          vaultRoot: loaded.vaultRoot,
          dataDir: loaded.dataDir,
          error: loaded.error,
        },
  );
}

export function requireReadyProject(
  projects: Map<string, LoadedProject>,
  projectId: string,
): Project {
  const loaded = projects.get(projectId);
  if (!loaded) throw new StudioError('NOT_FOUND', `unknown project: ${projectId}`);
  if (loaded.status === 'invalid') {
    throw new StudioError('INVALID_CONFIG', `project ${projectId} is invalid: ${loaded.error}`);
  }
  return loaded.project;
}

export function getPort(): number {
  const raw = process.env['WRITING_STUDIO_PORT'];
  const port = raw ? Number.parseInt(raw, 10) : 8787;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new StudioError('INVALID_CONFIG', `invalid WRITING_STUDIO_PORT: ${raw}`);
  }
  return port;
}

export const DEFAULT_RUN_TIMEOUT_MS = 300_000;
export const DEFAULT_GENERATE_TIMEOUT_MS = 600_000;

function parseTimeoutMs(raw: string | undefined, envName: string, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new StudioError(
      'INVALID_CONFIG',
      `invalid ${envName}: ${raw}`,
    );
  }
  return timeoutMs;
}

/** Resolve the ordinary per-run timeout once at server startup. */
export function getRunTimeoutMs(
  raw = process.env['WRITING_STUDIO_RUN_TIMEOUT_MS'],
): number {
  return parseTimeoutMs(raw, 'WRITING_STUDIO_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS);
}

/** Resolve the whole-chapter generation timeout once at server startup. */
export function getGenerateTimeoutMs(
  raw = process.env['WRITING_STUDIO_GENERATE_TIMEOUT_MS'],
): number {
  return parseTimeoutMs(
    raw,
    'WRITING_STUDIO_GENERATE_TIMEOUT_MS',
    DEFAULT_GENERATE_TIMEOUT_MS,
  );
}
