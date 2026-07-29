/**
 * Vault file I/O with path-escape protection, sha-based optimistic locking
 * and atomic writes (temp file + rename). No panel metadata ever enters
 * vault files.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  renameSync,
  statSync,
  lstatSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { resolve, join, sep, dirname, isAbsolute } from 'node:path';
import type {
  DeleteDraftResponse,
  DocumentMeta,
  DocKind,
  ProjectConfig,
  RestoreDraftResponse,
  TrashEntry,
} from '@writing-studio/contract';
import { numberFromPattern, renderNumber, renderTitleTemplate } from './content-pattern.js';
import { StudioError } from './errors.js';
import { nextChapterLocation } from './tree.js';

export class VaultError extends StudioError {}

/**
 * A narrow seam for deterministic write-race tests. Production callers leave
 * this undefined; it runs only after the replacement file is durable and
 * immediately before the target is revalidated.
 */
export interface WriteDocumentOptions {
  beforeFinalCheck?: () => void;
}

type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function fileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new VaultError('PATH_ESCAPE', 'document is not a regular vault file');
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** Resolves a vault-relative docId to an absolute path, rejecting escapes. */
export function resolveDocPath(vaultRoot: string, docId: string): string {
  if (
    docId.includes('\0') ||
    isAbsolute(docId) ||
    docId.replaceAll('\\', '/').split('/').some((part) => part === '..')
  ) {
    throw new VaultError('PATH_ESCAPE', `docId escapes vault: ${docId}`);
  }
  const root = realpathSync(vaultRoot);
  const abs = resolve(root, docId);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new VaultError('PATH_ESCAPE', `docId escapes vault: ${docId}`);
  }

  // A symlink that still resolves inside the vault can otherwise alias an
  // allowed document/context path to a forbidden file. Reject every existing
  // path component, not only links that escape the vault.
  let cursor = root;
  for (const part of docId.replaceAll('\\', '/').split('/')) {
    if (!part) continue;
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new VaultError('PATH_ESCAPE', `docId contains a symbolic link: ${docId}`);
    }
  }

  const existing = existsSync(abs) ? realpathSync(abs) : null;
  if (existing && existing !== root && !existing.startsWith(root + sep)) {
    throw new VaultError('PATH_ESCAPE', `docId resolves outside vault: ${docId}`);
  }

  const parent = existsSync(dirname(abs)) ? realpathSync(dirname(abs)) : null;
  if (parent && parent !== root && !parent.startsWith(root + sep)) {
    throw new VaultError('PATH_ESCAPE', `docId parent resolves outside vault: ${docId}`);
  }
  return abs;
}

/**
 * Keep the REST document surface smaller than generic vault path resolution:
 * only manuscript/draft Markdown or an explicitly declared sidebar file can
 * be opened and overwritten. Config, VCS, and arbitrary vault files remain
 * available only to their dedicated internal code paths.
 */
function assertDocumentPathAllowed(config: ProjectConfig, docId: string): void {
  if (docId.includes('\\')) {
    throw new VaultError('PATH_ESCAPE', `document path must use POSIX separators: ${docId}`);
  }
  const segments = docId.split('/');
  if (
    !docId.endsWith('.md')
    || segments.some((segment) => segment.length === 0 || segment.startsWith('.'))
  ) {
    throw new VaultError('PATH_ESCAPE', `document is not an exposed markdown file: ${docId}`);
  }

  const inDirectory = (directory: string): boolean => docId.startsWith(`${directory}/`);
  const declaredSidebarSource = config.sidebarSources.some((source) => source.file === docId);
  const declaredGraphSource = config.graph?.relationsFile === docId;
  if (
    !inDirectory(config.contentTree.root)
    && !inDirectory(config.draftsDir)
    && !declaredSidebarSource
    && !declaredGraphSource
  ) {
    throw new VaultError('PATH_ESCAPE', `document is not declared by project config: ${docId}`);
  }
}

function classifyDoc(config: ProjectConfig, docId: string): DocKind {
  const posix = docId.split(sep).join('/');
  if (posix.startsWith(config.contentTree.root + '/')) return 'chapter';
  if (posix.startsWith(config.draftsDir + '/')) return 'draft';
  return 'canon';
}

interface ChapterTitleLine {
  index: number;
  line: string;
  title: string;
}

/**
 * Finds the first valid H1 outside a backtick or tilde fence. This intentionally
 * implements only the repository's title-line contract, not full CommonMark:
 * indented fences are ignored and an unclosed fence extends to EOF. Other known
 * deviations all fail closed (no title found -> filename fallback / rename 422):
 * an indented closing fence is not recognized, a backtick fence whose info
 * string contains a backtick is still treated as a fence, and U+2028/U+2029 are
 * not line breaks here.
 */
function findChapterTitleLine(content: string): ChapterTitleLine | null {
  let offset = 0;
  let openFence: { marker: '`' | '~'; length: number } | null = null;

  while (offset < content.length) {
    const relativeLineEnd = content.slice(offset).search(/[\r\n]/u);
    const lineEnd = relativeLineEnd === -1 ? content.length : offset + relativeLineEnd;
    const line = content.slice(offset, lineEnd);
    const fence = line.match(/^(`{3,}|~{3,})([^\r\n]*)$/u);

    if (openFence) {
      const run = fence?.[1];
      if (
        run
        && run[0] === openFence.marker
        && run.length >= openFence.length
        && fence?.[2]?.trim() === ''
      ) {
        openFence = null;
      }
    } else if (fence?.[1]) {
      openFence = {
        marker: fence[1][0] as '`' | '~',
        length: fence[1].length,
      };
    } else {
      // Single-line H1 with real title text only: a bare `\s` would match
      // across newlines, while [^\S\r\n] and \S keep empty H1s invalid.
      const title = line.match(/^#[^\S\r\n]+(\S.*)$/u)?.[1];
      if (title !== undefined) return { index: offset, line, title };
    }

    if (lineEnd === content.length) break;
    offset = lineEnd + (
      content[lineEnd] === '\r' && content[lineEnd + 1] === '\n' ? 2 : 1
    );
  }
  return null;
}

export function extractTitle(content: string, titleStripRegex: string | null): string | null {
  const h1 = findChapterTitleLine(content);
  if (!h1) return null;
  let title = h1.title.trim();
  if (titleStripRegex) {
    try {
      title = title.replace(new RegExp(titleStripRegex), '').trim() || title;
    } catch {
      // invalid configured regex: keep raw title
    }
  }
  return title;
}

export function readDocument(
  vaultRoot: string,
  config: ProjectConfig,
  docId: string,
): { meta: DocumentMeta; content: string } {
  assertDocumentPathAllowed(config, docId);
  const abs = resolveDocPath(vaultRoot, docId);
  if (!existsSync(abs)) {
    throw new VaultError('NOT_FOUND', `document not found: ${docId}`);
  }
  if (!statSync(abs).isFile()) {
    throw new VaultError('NOT_FOUND', `document is not a file: ${docId}`);
  }
  const content = readFileSync(abs, 'utf8');
  const st = statSync(abs);
  const fileName = docId.split('/').at(-1) ?? docId;
  const chapterNo = classifyDoc(config, docId) === 'chapter'
    ? numberFromPattern(
        fileName,
        config.contentTree.leaf.filePattern,
        config.contentTree.leaf.numberStyle,
      )
    : null;
  const meta: DocumentMeta = {
    docId,
    projectId: config.id,
    kind: classifyDoc(config, docId),
    title: extractTitle(content, config.contentTree.leaf.titleStripRegex) ?? docId,
    chapterNo,
    sha256: sha256(content),
    bytes: st.size,
    mtimeMs: st.mtimeMs,
  };
  return { meta, content };
}

export function writeDocument(
  vaultRoot: string,
  config: ProjectConfig,
  docId: string,
  content: string,
  baseSha256: string,
  options: WriteDocumentOptions = {},
): DocumentMeta {
  assertDocumentPathAllowed(config, docId);
  const abs = resolveDocPath(vaultRoot, docId);
  if (!existsSync(abs)) {
    throw new VaultError('NOT_FOUND', `document not found: ${docId}`);
  }
  const originalIdentity = fileIdentity(abs);
  const originalMode = statSync(abs).mode;
  const current = readFileSync(abs, 'utf8');
  if (sha256(current) !== baseSha256) {
    throw new VaultError('STALE_WRITE', 'document changed on disk since it was loaded');
  }
  const tmp = join(dirname(abs), `.ws-write-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(tmp, 'wx', originalMode);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(tmp, originalMode);

    options.beforeFinalCheck?.();

    // `rename` is atomic, but it is not a compare-and-swap. Re-read the
    // target at the last possible point so an Obsidian/editor write (or a
    // replacement of the file at this path) becomes the existing stale-write
    // conflict instead of being silently overwritten.
    const finalIdentity = fileIdentity(abs);
    const finalContent = readFileSync(abs, 'utf8');
    if (
      !sameFileIdentity(originalIdentity, finalIdentity) ||
      sha256(finalContent) !== baseSha256
    ) {
      throw new VaultError('STALE_WRITE', 'document changed on disk during save');
    }
    renameSync(tmp, abs);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(tmp)) unlinkSync(tmp);
  }
  return readDocument(vaultRoot, config, docId).meta;
}

export function renameChapterTitle(
  vaultRoot: string,
  config: ProjectConfig,
  docId: string,
  title: string,
  baseSha256: string,
): { meta: DocumentMeta; content: string } {
  const normalizedTitle = title.trim();
  if (
    normalizedTitle.length === 0
    || normalizedTitle.length > 60
    || /[\r\n\u2028\u2029]/u.test(normalizedTitle)
  ) {
    throw new VaultError('VALIDATION', 'chapter title must be a single line of 1-60 characters');
  }
  if (config.contentTree.leaf.filePattern.includes('{title}')) {
    throw new VaultError(
      'UNPROCESSABLE',
      'chapter filename patterns containing {title} are not supported by title-only rename',
    );
  }

  const current = readDocument(vaultRoot, config, docId);
  if (current.meta.kind !== 'chapter' || current.meta.chapterNo === null) {
    throw new VaultError('UNPROCESSABLE', 'only documents in the configured chapter tree can be renamed');
  }
  const titleLine = findChapterTitleLine(current.content);
  if (!titleLine) {
    throw new VaultError(
      'UNPROCESSABLE',
      'chapter has no recognizable H1 title line; no content was changed',
    );
  }

  const heading = renderTitleTemplate(
    config.contentTree.leaf.titleTemplate,
    current.meta.chapterNo,
    normalizedTitle,
    config.contentTree.leaf.numberStyle,
  );
  if (/[\r\n\u2028\u2029]/u.test(heading)) {
    throw new VaultError('UNPROCESSABLE', 'titleTemplate does not render to a single title line');
  }
  // Splice by index so the located line is replaced exactly, with no
  // pattern matching that `$&`-style tokens or a same-text line inside a
  // fence could interact with.
  const content = current.content.slice(0, titleLine.index)
    + `# ${heading}`
    + current.content.slice(titleLine.index + titleLine.line.length);
  const meta = writeDocument(vaultRoot, config, docId, content, baseSha256);
  return { meta, content };
}

export function createDraft(
  vaultRoot: string,
  config: ProjectConfig,
  title: string,
): DocumentMeta {
  const dir = resolveDocPath(vaultRoot, config.draftsDir);
  mkdirSync(dir, { recursive: true });
  const realDir = realpathSync(dir);
  const realRoot = realpathSync(vaultRoot);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
    throw new VaultError('PATH_ESCAPE', `draft directory escapes vault: ${config.draftsDir}`);
  }
  const safeTitle = title.replace(/[/\\:*?"<>|]/g, '_').trim() || '未命名草稿';
  const date = new Date().toISOString().slice(0, 10);
  let docId = `${config.draftsDir}/${date}_${safeTitle}.md`;
  let n = 2;
  while (existsSync(resolveDocPath(vaultRoot, docId))) {
    docId = `${config.draftsDir}/${date}_${safeTitle}_${n}.md`;
    n += 1;
  }
  const abs = resolveDocPath(vaultRoot, docId);
  writeFileSync(abs, `# ${safeTitle}\n\n`, { encoding: 'utf8', flag: 'wx' });
  return readDocument(vaultRoot, config, docId).meta;
}

/** Lists direct Markdown children created under the configured draft directory. */
export function listDrafts(
  vaultRoot: string,
  config: ProjectConfig,
): DocumentMeta[] {
  const dir = resolveDocPath(vaultRoot, config.draftsDir);
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory()) {
    throw new VaultError('INVALID_CONFIG', `draft path is not a directory: ${config.draftsDir}`);
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => (
      entry.isFile()
      && !entry.name.startsWith('.')
      && entry.name.endsWith('.md')
    ))
    .map((entry) => {
      const document = readDocument(
        vaultRoot,
        config,
        `${config.draftsDir}/${entry.name}`,
      );
      const explicitTitle = extractTitle(
        document.content,
        config.contentTree.leaf.titleStripRegex,
      );
      return {
        ...document.meta,
        title: explicitTitle
          ?? entry.name.replace(/^\d{4}-\d{2}-\d{2}_/u, '').replace(/\.md$/u, ''),
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.docId.localeCompare(right.docId));
}

/** Atomically soft-delete one configured draft into its private `.trash`. */
export function deleteDraft(
  vaultRoot: string,
  config: ProjectConfig,
  docId: string,
): DeleteDraftResponse {
  if (!docId.startsWith(`${config.draftsDir}/`)) {
    throw new VaultError('VALIDATION', 'only documents in the configured draft directory can be deleted');
  }
  const source = resolveDocPath(vaultRoot, docId);
  if (!existsSync(source)) throw new VaultError('NOT_FOUND', `draft not found: ${docId}`);
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new VaultError('PATH_ESCAPE', 'draft is not a regular vault file');
  }
  const realRoot = realpathSync(vaultRoot);
  const realSource = realpathSync(source);
  if (!realSource.startsWith(realRoot + sep)) {
    throw new VaultError('PATH_ESCAPE', 'draft resolves outside the vault');
  }
  const document = readDocument(vaultRoot, config, docId);
  if (document.meta.kind !== 'draft') {
    throw new VaultError('VALIDATION', 'only drafts can be deleted');
  }

  const trashDir = resolveDocPath(vaultRoot, `${config.draftsDir}/.trash`);
  mkdirSync(trashDir, { recursive: true });
  const realTrash = realpathSync(trashDir);
  const realDraftDir = realpathSync(resolveDocPath(vaultRoot, config.draftsDir));
  if (
    !realDraftDir.startsWith(realRoot + sep)
    || !realTrash.startsWith(realDraftDir + sep)
  ) {
    throw new VaultError('PATH_ESCAPE', 'draft trash resolves outside the configured draft directory');
  }

  const originalName = docId.split('/').at(-1)!;
  let timestampOffset = 0;
  let trashedDocId: string;
  let destination: string;
  do {
    const timestamp = new Date(Date.now() + timestampOffset).toISOString();
    trashedDocId = `${config.draftsDir}/.trash/${timestamp}_${originalName}`;
    destination = resolveDocPath(vaultRoot, trashedDocId);
    timestampOffset += 1;
  } while (existsSync(destination));
  renameSync(source, destination);
  return { docId, trashedDocId };
}

const TRASH_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_/u;

function trashOriginalName(filename: string): string {
  return filename.replace(TRASH_TIMESTAMP_PREFIX, () => '');
}

/** Lists recoverable Markdown files without creating or mutating the trash directory. */
export function listTrash(
  vaultRoot: string,
  config: ProjectConfig,
): TrashEntry[] {
  const trashDocId = `${config.draftsDir}/.trash`;
  const trashDir = resolveDocPath(vaultRoot, trashDocId);
  if (!existsSync(trashDir)) return [];
  const trashStat = lstatSync(trashDir);
  if (trashStat.isSymbolicLink() || !trashStat.isDirectory()) {
    throw new VaultError('PATH_ESCAPE', 'draft trash is not a regular vault directory');
  }

  return readdirSync(trashDir, { withFileTypes: true })
    .flatMap((entry) => {
      if (!entry.isFile() || !entry.name.endsWith('.md')) return [];
      const originalName = trashOriginalName(entry.name);
      // Dot-prefixed restore targets are invisible to listDrafts and rejected
      // by the document path allowlist, so restoring one would strand it.
      if (originalName.startsWith('.')) return [];
      const path = join(trashDir, entry.name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        return [];
      }
      if (stat.isSymbolicLink() || !stat.isFile()) return [];
      const timestampPrefix = entry.name.match(TRASH_TIMESTAMP_PREFIX)?.[0];
      const timestamp = timestampPrefix?.slice(0, -1);
      const parsedTimestamp = timestamp ? new Date(timestamp) : null;
      const deletedAt = parsedTimestamp && !Number.isNaN(parsedTimestamp.getTime())
        ? parsedTimestamp.toISOString()
        : stat.mtime.toISOString();
      let title: string | null = null;
      try {
        title = extractTitle(
          readFileSync(path, 'utf8'),
          config.contentTree.leaf.titleStripRegex,
        );
      } catch {
        // The entry remains recoverable even when its title cannot be read.
      }
      return [{
        trashedDocId: `${trashDocId}/${entry.name}`,
        originalName,
        deletedAt,
        title: title ?? originalName.replace(/\.md$/u, () => ''),
      }];
    })
    .sort((left, right) => (
      right.deletedAt.localeCompare(left.deletedAt)
      || left.trashedDocId.localeCompare(right.trashedDocId)
    ));
}

/** Atomically restores one direct Markdown child of the configured draft trash. */
export function restoreDraft(
  vaultRoot: string,
  config: ProjectConfig,
  trashedDocId: string,
): RestoreDraftResponse {
  const trashPrefix = `${config.draftsDir}/.trash/`;
  if (!trashedDocId.startsWith(trashPrefix) || !trashedDocId.endsWith('.md')) {
    throw new VaultError('VALIDATION', 'only Markdown files in the configured draft trash can be restored');
  }
  const trashedName = trashedDocId.slice(trashPrefix.length);
  if (!trashedName || trashedName.includes('/') || trashedName.includes('\\')) {
    throw new VaultError('VALIDATION', 'trash document must be a direct file');
  }

  const source = resolveDocPath(vaultRoot, trashedDocId);
  if (!existsSync(source)) throw new VaultError('NOT_FOUND', `trashed draft not found: ${trashedDocId}`);
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new VaultError('PATH_ESCAPE', 'trashed draft is not a regular vault file');
  }

  const realRoot = realpathSync(vaultRoot);
  const realDraftDir = realpathSync(resolveDocPath(vaultRoot, config.draftsDir));
  const realTrash = realpathSync(resolveDocPath(vaultRoot, `${config.draftsDir}/.trash`));
  const realSource = realpathSync(source);
  if (
    !realDraftDir.startsWith(realRoot + sep)
    || !realTrash.startsWith(realDraftDir + sep)
    || !realSource.startsWith(realTrash + sep)
  ) {
    throw new VaultError('PATH_ESCAPE', 'trashed draft resolves outside the configured draft trash');
  }

  const originalName = trashOriginalName(trashedName);
  if (originalName.startsWith('.')) {
    throw new VaultError('VALIDATION', 'restored draft name must not start with a dot');
  }
  const docId = `${config.draftsDir}/${originalName}`;
  const destination = resolveDocPath(vaultRoot, docId);
  if (existsSync(destination)) {
    throw new VaultError('CONFLICT', `draft already exists: ${docId}`);
  }
  const realDestinationDir = realpathSync(dirname(destination));
  if (realDestinationDir !== realDraftDir) {
    throw new VaultError('PATH_ESCAPE', 'restore target resolves outside the configured draft directory');
  }

  renameSync(source, destination);
  return { trashedDocId, docId };
}

export function createChapter(
  vaultRoot: string,
  config: ProjectConfig,
  title: string,
  dirOverride?: string,
): DocumentMeta {
  const normalizedTitle = title.trim();
  if (
    normalizedTitle.length === 0
    || normalizedTitle.length > 60
    || /[\r\n\u2028\u2029]/u.test(normalizedTitle)
  ) {
    throw new VaultError('VALIDATION', 'chapter title must be a single line of 1-60 characters');
  }

  let location;
  try {
    location = nextChapterLocation(vaultRoot, config, dirOverride);
  } catch (error) {
    throw new VaultError(
      'VALIDATION',
      error instanceof Error ? error.message : 'invalid chapter directory',
      { cause: error },
    );
  }
  const leaf = config.contentTree.leaf;
  for (let chapterNo = location.chapterNo; chapterNo < location.chapterNo + 1_000; chapterNo += 1) {
    const fileName = leaf.filePattern.replace('{num}', renderNumber(chapterNo, leaf.numberStyle));
    const docId = `${location.dir}/${fileName}`;
    const abs = resolveDocPath(vaultRoot, docId);
    try {
      const heading = renderTitleTemplate(
        leaf.titleTemplate,
        chapterNo,
        normalizedTitle,
        leaf.numberStyle,
      );
      // Same single-line invariant the title input obeys above: a template must
      // not be able to smuggle extra lines into the new chapter file.
      if (/[\r\n\u2028\u2029]/u.test(heading)) {
        throw new VaultError('VALIDATION', 'titleTemplate must render to a single line');
      }
      writeFileSync(
        abs,
        `# ${heading}\n\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      return readDocument(vaultRoot, config, docId).meta;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new VaultError('VALIDATION', 'could not allocate a chapter number');
}
