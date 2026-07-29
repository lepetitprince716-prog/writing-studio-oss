/** Sidebar service: cache ownership, file watching, and public API. */

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { dirname } from 'node:path';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import type { SidebarPayload, SidebarSource } from '@writing-studio/contract';
import { writerVisibleCanonSections } from '../canon.js';
import { resolveDocPath, sha256 } from '../vault.js';
import { filterSidebarPayload, parsePayload } from './parsers.js';
import type { MdNode, SidebarProject, SidebarRole, SidebarUpdated } from './types.js';

interface CachedSource {
  tree: MdNode;
  payloads: Map<string, SidebarPayload>;
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const RECOVERY_POLL_MS = 250;

type SidebarWatchErrorHandler = (error: Error) => void;

function readSource(path: string, allowMissing = false): { markdown: string; sha: string } {
  let descriptor: number | null = null;
  try {
    // O_NOFOLLOW rejects a source switched to a symlink between path
    // resolution and open.  The descriptor is then revalidated, so a
    // directory/device cannot be parsed and the read is bounded.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error('invalid sidebar source');
    const markdown = readFileSync(descriptor, 'utf8');
    return { markdown, sha: sha256(markdown) };
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { markdown: '', sha: sha256('') };
    }
    // Do not surface a filesystem error (or accidental source content) from a
    // watcher callback. Callers only need to know the source was unavailable.
    throw new Error('sidebar source is unavailable');
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function sourceFingerprint(source: SidebarSource, localePreset: SidebarProject['config']['localePreset']): string {
  return JSON.stringify({
    id: source.id,
    parser: source.parser,
    parserConfig: source.parserConfig,
    localePreset,
  });
}

/**
 * Owns sidebar parsing and the optional watcher. Cached payloads are planner
 * projections; writer projections are always derived from an AST clone.
 */
export class SidebarService {
  private readonly cache = new Map<string, CachedSource>();
  private readonly observedSha = new Map<string, string>();
  private watcher: FSWatcher | null = null;
  private recoveryPoll: NodeJS.Timeout | null = null;
  private watchedSources = new Map<string, SidebarSource[]>();

  getAll(project: SidebarProject, role: SidebarRole = 'writer'): SidebarPayload[] {
    return [...project.config.sidebarSources]
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((source) => this.getSource(project, source.id, role))
      .filter((payload): payload is SidebarPayload => payload !== undefined);
  }

  getSource(
    project: SidebarProject,
    sourceId: string,
    role: SidebarRole = 'writer',
    query?: string,
  ): SidebarPayload | undefined {
    return this.getSourceWithCacheKey(project, sourceId, role, query)?.payload;
  }

  /**
   * Return a projection and the exact content key from the same file read.
   * Derived indexes use this seam so an editor write cannot pair an old
   * payload with a newly-read SHA.
   */
  getSourceWithCacheKey(
    project: SidebarProject,
    sourceId: string,
    role: SidebarRole = 'writer',
    query?: string,
  ): { payload: SidebarPayload; cacheKey: string } | undefined {
    const source = project.config.sidebarSources.find((candidate) => candidate.id === sourceId);
    if (!source) return undefined;
    const path = resolveDocPath(project.vaultRoot, source.file);
    const { markdown, sha } = readSource(path);
    const cacheKey = `${path}\u0000${sha}`;
    let cached = this.cache.get(cacheKey);
    if (!cached) {
      cached = { tree: markdownParser.parse(markdown) as MdNode, payloads: new Map() };
      this.cache.set(cacheKey, cached);
    }
    const localePreset = project.config.localePreset;
    const fingerprint = sourceFingerprint(source, localePreset);
    let plannerPayload = cached.payloads.get(fingerprint);
    if (!plannerPayload) {
      plannerPayload = parsePayload(source, cached.tree, markdown, 'planner', localePreset);
      cached.payloads.set(fingerprint, plannerPayload);
    }
    const writerPayload = parsePayload(
      source,
      structuredClone(cached.tree),
      markdown,
      'writer',
      localePreset,
    );
    const writerSections = writerVisibleCanonSections(
      project,
      source.file,
      markdown,
      sha,
      writerPayload,
    );
    const payload = {
      ...(role === 'writer' ? writerPayload : structuredClone(plannerPayload)),
      writerSections,
    } as SidebarPayload;
    return { payload: filterSidebarPayload(payload, query), cacheKey };
  }

  startWatching(project: SidebarProject, onUpdated: SidebarUpdated, onError?: SidebarWatchErrorHandler): void {
    if (this.watcher) throw new Error('Sidebar watcher is already running');
    this.watchedSources = new Map();
    for (const source of project.config.sidebarSources) {
      const path = resolveDocPath(project.vaultRoot, source.file);
      const sources = this.watchedSources.get(path) ?? [];
      sources.push(source);
      this.watchedSources.set(path, sources);
      try {
        this.observedSha.set(path, readSource(path, true).sha);
      } catch (error) {
        // Do not mark a failed read as an observed state: the next valid write
        // must be eligible to notify clients.
        this.reportError(onError, error);
      }
    }
    // Watch parent directories as well as exact paths. A direct-file watch can
    // be dropped by chokidar after an unlink, while editors commonly replace a
    // Markdown file through unlink/rename and expect the later recovery event.
    const watchPaths = new Set<string>();
    for (const path of this.watchedSources.keys()) {
      watchPaths.add(path);
      watchPaths.add(dirname(path));
    }
    this.watcher = chokidar.watch([...watchPaths], {
      ignoreInitial: true,
      // Parent directories are present only so an atomically replaced source
      // can be rediscovered. Never recurse into the vault: doing so watches
      // thousands of unrelated files and can exhaust a GUI-launched process's
      // file-descriptor limit before an agent CLI is spawned.
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    });
    this.watcher.on('all', (_event, changedPath) => {
      this.consumeWatchChange(changedPath, onUpdated, onError);
    });
    // A configured source may live below a parent directory that is absent at
    // startup or replaced wholesale by an editor. Directory event watches
    // cannot reliably reattach across that gap without recursively observing
    // the vault. Poll only the exact configured files as a bounded recovery
    // path; observedSha still suppresses duplicate notifications.
    this.recoveryPoll = setInterval(() => {
      for (const path of this.watchedSources.keys()) {
        this.consumeWatchChange(path, onUpdated, onError);
      }
    }, RECOVERY_POLL_MS);
    this.recoveryPoll.unref?.();
  }

  async close(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    if (this.recoveryPoll) clearInterval(this.recoveryPoll);
    this.recoveryPoll = null;
    this.watchedSources.clear();
    this.observedSha.clear();
    if (watcher) await watcher.close();
  }

  private reportError(onError: SidebarWatchErrorHandler | undefined, _error: unknown): void {
    try {
      // Intentionally generic: watcher errors must not expose document text or
      // filesystem details through an application logger.
      onError?.(new Error('sidebar watcher could not read a configured source'));
    } catch {
      // Logging itself is never allowed to destabilize the watcher.
    }
  }

  private consumeWatchChange(
    path: string,
    onUpdated: SidebarUpdated,
    onError?: SidebarWatchErrorHandler,
  ): void {
    // Chokidar and timers do not await listeners. Always consume the promise
    // so a delete/replace race cannot become an unhandled rejection.
    void this.handleWatchChange(path, onUpdated, onError).catch((error: unknown) => {
      this.reportError(onError, error);
    });
  }

  private async handleWatchChange(
    path: string,
    onUpdated: SidebarUpdated,
    onError?: SidebarWatchErrorHandler,
  ): Promise<void> {
    const sources = this.watchedSources.get(path);
    if (!sources) return;
    let sha: string;
    try {
      sha = readSource(path).sha;
    } catch (error) {
      // Preserve the prior SHA. A later recovery can then produce one update.
      this.reportError(onError, error);
      return;
    }
    if (this.observedSha.get(path) === sha) return;
    this.observedSha.set(path, sha);
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${path}\u0000`)) this.cache.delete(key);
    }
    for (const source of sources) {
      try {
        onUpdated(source.id);
      } catch (error) {
        this.reportError(onError, error);
      }
    }
  }
}
