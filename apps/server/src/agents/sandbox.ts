import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export function sandboxExecutable(): string {
  return process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] ?? DEFAULT_SANDBOX_EXEC;
}

/** Module-level cache: executable path → unavailable reason or null (available). */
const _sandboxProbeCache = new Map<string, string | null>();

/**
 * The compatibility wrappers are only safe when macOS Sandbox is actually
 * available. Keep the check shared with availability probing so the UI never
 * advertises a writer profile that will necessarily fail at send time.
 */
export function sandboxUnavailableReason(): string | null {
  if (process.platform !== 'darwin') {
    return 'required filesystem sandbox is unavailable on this platform';
  }
  const executable = sandboxExecutable();
  try {
    if (!statSync(executable).isFile()) {
      return `required sandbox-exec is unavailable: ${executable}`;
    }
    accessSync(executable, constants.X_OK);
  } catch {
    return `required sandbox-exec is unavailable: ${executable}`;
  }
  if (_sandboxProbeCache.has(executable)) {
    return _sandboxProbeCache.get(executable) ?? null;
  }
  try {
    execFileSync(executable, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore', timeout: 2000 });
    _sandboxProbeCache.set(executable, null);
    return null;
  } catch {
    const reason = `required sandbox-exec is unavailable: ${executable}`;
    _sandboxProbeCache.set(executable, reason);
    return reason;
  }
}

function requireSandboxExecutable(): string {
  const reason = sandboxUnavailableReason();
  if (reason) throw new Error(reason);
  return sandboxExecutable();
}

export function panelPort(): number {
  const value = Number.parseInt(process.env['WRITING_STUDIO_PORT'] ?? '', 10);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : 8787;
}

export function webPort(): number {
  const value = Number.parseInt(process.env['WRITING_STUDIO_WEB_PORT'] ?? '', 10);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : 5183;
}

function escape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function resolved(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function readRule(path: string): string {
  return `(allow file-read* (subpath "${escape(resolved(path))}"))`;
}

function writeRule(path: string): string {
  return `(allow file-write* (subpath "${escape(resolved(path))}"))`;
}

export interface FilesystemSandboxOptions {
  /** The isolated writer scratch or planner projection. */
  workspaceRoot: string;
  /** Original vault, denied explicitly as defense in depth. */
  vaultRoot: string;
  /** Ephemeral schema/output locations, never an arbitrary host directory. */
  extraReadRoots?: string[];
  extraWriteRoots?: string[];
}

/**
 * Fail-closed filesystem sandbox for every external agent. `deny default`
 * removes host-file authority and only a small runtime set plus explicit
 * isolated roots are restored. This means writers cannot read HOME or another
 * vault, and planners can read only their copied projection.
 */
export function wrapIsolatedFilesystem(
  command: { file: string; args: string[] },
  options: FilesystemSandboxOptions,
): { file: string; args: string[] } {
  if (process.platform !== 'darwin') {
    throw new Error('required filesystem sandbox is unavailable on this platform');
  }
  const executable = requireSandboxExecutable();

  const commandPath = resolved(command.file);
  const runtimeReadRoots = [
    // OS binaries/libraries required by shebangs, dyld and Node builtins.
    '/bin', '/sbin', '/usr/bin', '/usr/lib', '/System', '/Library/Frameworks', '/dev',
    '/private/var/db/timezone',
    // Exact CLI package directory and Node runtime, not the whole user HOME.
    dirname(commandPath),
    dirname(resolved(process.execPath)),
    // Node's executable loads libnode from its installation prefix.
    dirname(dirname(resolved(process.execPath))),
  ];
  const workspace = resolved(options.workspaceRoot);
  const vault = resolved(options.vaultRoot);
  const extraRead = options.extraReadRoots ?? [];
  const extraWrite = options.extraWriteRoots ?? [];
  // Sandboxing uses deny-overrides semantics: start from deny-default and add
  // precisely the capabilities needed for a local CLI process. Network stays
  // available for an authenticated CLI, except panel/Vite loopback endpoints.
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    ...runtimeReadRoots.map(readRule),
    readRule(workspace),
    ...extraRead.map(readRule),
    // A workspace is ephemeral. It may host CLI-private temp state but never
    // the original vault; schema output is restricted to its own temp dir.
    writeRule(workspace),
    ...extraWrite.map(writeRule),
    `(deny file-read* (subpath "${escape(vault)}"))`,
    `(deny file-write* (subpath "${escape(vault)}"))`,
    '(allow network-outbound)',
    `(deny network-outbound (remote ip "localhost:${panelPort()}"))`,
    `(deny network-outbound (remote ip "localhost:${webPort()}"))`,
  ].join(' ');
  return { file: executable, args: ['-p', profile, command.file, ...command.args] };
}

/**
 * Codex writer wrapper. Codex keeps its authentication/session state under
 * ~/.codex and needs its normal runtime/network reads, so this profile starts
 * from allow-default and removes host write authority before restoring only
 * the isolated writer roots. Sensitive reads, the vault, and panel endpoints
 * remain explicit final denies.
 */
export function wrapCodexWriter(
  command: { file: string; args: string[] },
  options: FilesystemSandboxOptions,
): { file: string; args: string[] } {
  if (process.platform !== 'darwin') {
    throw new Error('required filesystem sandbox is unavailable on this platform');
  }
  const executable = requireSandboxExecutable();
  const workspace = resolved(options.workspaceRoot);
  const vault = resolved(options.vaultRoot);
  const codexHome = resolved(join(homedir(), '.codex'));
  const temporaryRoot = resolved(tmpdir());
  const extraRead = options.extraReadRoots ?? [];
  const extraWrite = options.extraWriteRoots ?? [];
  const panelDataDir = process.env['WRITING_STUDIO_DATA_DIR'];
  const sensitiveReadRoots = [
    join(homedir(), '.ssh'),
    join(homedir(), '.aws'),
    join(homedir(), '.gnupg'),
    join(homedir(), '.kube'),
    join(homedir(), '.docker'),
    join(homedir(), '.claude'),
    join(homedir(), 'Library', 'Keychains'),
    // The panel's private state dir holds the headless Claude OAuth token and
    // the message database; a shell-capable Codex child must never read it.
    ...(panelDataDir ? [panelDataDir] : []),
  ];
  const deviceWriteRoots = ['/dev/null', '/dev/tty', '/dev/stdout', '/dev/stderr'];
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write* (subpath "/"))',
    writeRule(workspace),
    writeRule(codexHome),
    writeRule(temporaryRoot),
    ...extraWrite.map(writeRule),
    ...deviceWriteRoots.map(writeRule),
    ...extraRead.map(readRule),
    ...sensitiveReadRoots.map((path) => `(deny file-read* (subpath "${escape(resolved(path))}"))`),
    `(deny file-read* (subpath "${escape(vault)}"))`,
    `(deny file-write* (subpath "${escape(vault)}"))`,
    `(deny network-outbound (remote ip "localhost:${panelPort()}"))`,
    `(deny network-outbound (remote ip "localhost:${webPort()}"))`,
  ].join(' ');
  return { file: executable, args: ['-p', profile, command.file, ...command.args] };
}

/**
 * Grok writer wrapper. Grok has a native sandbox, so the inner sandbox is left
 * disabled and this outer macOS profile is the sole filesystem boundary. It
 * permits Grok's authenticated session state while denying other credential
 * stores, the original vault, and the panel endpoints.
 */
export function wrapGrokWriter(
  command: { file: string; args: string[] },
  options: FilesystemSandboxOptions,
): { file: string; args: string[] } {
  if (process.platform !== 'darwin') {
    throw new Error('required filesystem sandbox is unavailable on this platform');
  }
  const executable = requireSandboxExecutable();
  const workspace = resolved(options.workspaceRoot);
  const vault = resolved(options.vaultRoot);
  const grokHome = resolved(join(homedir(), '.grok'));
  const temporaryRoot = resolved(tmpdir());
  const extraRead = options.extraReadRoots ?? [];
  const extraWrite = options.extraWriteRoots ?? [];
  const panelDataDir = process.env['WRITING_STUDIO_DATA_DIR'];
  const sensitiveReadRoots = [
    join(homedir(), '.ssh'),
    join(homedir(), '.aws'),
    join(homedir(), '.gnupg'),
    join(homedir(), '.kube'),
    join(homedir(), '.docker'),
    join(homedir(), '.claude'),
    join(homedir(), '.codex'),
    join(homedir(), 'Library', 'Keychains'),
    ...(panelDataDir ? [panelDataDir] : []),
  ];
  const deviceWriteRoots = ['/dev/null', '/dev/tty', '/dev/stdout', '/dev/stderr'];
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write* (subpath "/"))',
    writeRule(workspace),
    writeRule(grokHome),
    writeRule(temporaryRoot),
    ...extraWrite.map(writeRule),
    ...deviceWriteRoots.map(writeRule),
    ...extraRead.map(readRule),
    ...sensitiveReadRoots.map((path) => `(deny file-read* (subpath "${escape(resolved(path))}"))`),
    `(deny file-read* (subpath "${escape(vault)}"))`,
    `(deny file-write* (subpath "${escape(vault)}"))`,
    `(deny network-outbound (remote ip "localhost:${panelPort()}"))`,
    `(deny network-outbound (remote ip "localhost:${webPort()}"))`,
  ].join(' ');
  return { file: executable, args: ['-p', profile, command.file, ...command.args] };
}

/**
 * Compatibility wrapper for the two writer CLIs whose native tool policies
 * deny file reads. It is intentionally limited to denying the vault and panel
 * ports; it is not an OS host-file allowlist and must never be used for Codex
 * writer or any planner run.
 */
export function wrapOutsideVault(
  command: { file: string; args: string[] },
  vaultRoot: string,
): { file: string; args: string[] } {
  if (process.platform !== 'darwin') {
    throw new Error('required filesystem sandbox is unavailable on this platform');
  }
  const executable = requireSandboxExecutable();
  const vault = resolved(vaultRoot);
  const profile = [
    '(version 1)', '(allow default)',
    `(deny file-read* (subpath "${escape(vault)}"))`,
    `(deny file-write* (subpath "${escape(vault)}"))`,
    `(deny network-outbound (remote ip "localhost:${panelPort()}"))`,
    `(deny network-outbound (remote ip "localhost:${webPort()}"))`,
  ].join(' ');
  return { file: executable, args: ['-p', profile, command.file, ...command.args] };
}
