/**
 * Content tree scanner: walks the manuscript root according to the
 * configured level patterns and leaf pattern, producing a ChapterTree.
 * Supports Chinese-lowercase numerals in directory names (第一部/第二篇)
 * and arabic chapter numbers (第51章.md).
 */

import { readdirSync, existsSync, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ChapterTree,
  ChapterTreeNode,
  ContentTreeLevel,
  DocumentMeta,
  ProjectConfig,
} from '@writing-studio/contract';
import { numberFromPattern, parseNumber, patternToRegex } from './content-pattern.js';
import { readDocument, resolveDocPath } from './vault.js';

export { parseCnNumber } from './content-pattern.js';

export interface NextChapterLocation {
  dir: string;
  chapterNo: number;
}

interface DirEntry {
  dirName: string;
  num: number;
  name: string;
}

export interface ChapterDocumentRef {
  docId: string;
  chapterNo: number;
}

function matchDirs(parent: string, level: ContentTreeLevel): DirEntry[] {
  if (!existsSync(parent)) return [];
  const regex = patternToRegex(level.dirPattern);
  const entries: DirEntry[] = [];
  for (const entry of readdirSync(parent)) {
    const entryPath = join(parent, entry);
    if (lstatSync(entryPath).isSymbolicLink() || !statSync(entryPath).isDirectory()) continue;
    const m = entry.match(regex);
    if (!m?.groups?.['num']) continue;
    const num = parseNumber(m.groups['num'], level.numberStyle);
    if (num === null) continue;
    entries.push({ dirName: entry, num, name: m.groups['name'] ?? '' });
  }
  return entries.sort((a, b) => a.num - b.num || a.dirName.localeCompare(b.dirName));
}

function matchChapters(
  vaultRoot: string,
  config: ProjectConfig,
  dirAbs: string,
  dirRel: string,
): DocumentMeta[] {
  if (!existsSync(dirAbs)) return [];
  const leaf = config.contentTree.leaf;
  const regex = patternToRegex(leaf.filePattern);
  const chapters: DocumentMeta[] = [];
  for (const entry of readdirSync(dirAbs)) {
    const m = entry.match(regex);
    if (!m?.groups?.['num']) continue;
    if (numberFromPattern(entry, leaf.filePattern, leaf.numberStyle) === null) continue;
    try {
      chapters.push(readDocument(vaultRoot, config, `${dirRel}/${entry}`).meta);
    } catch {
      // unreadable file: skip rather than break the whole tree
    }
  }
  return chapters.sort((a, b) =>
    (a.chapterNo ?? 0) - (b.chapterNo ?? 0) || a.docId.localeCompare(b.docId),
  );
}

function scanChapterRefs(
  config: ProjectConfig,
  levels: ContentTreeLevel[],
  dirAbs: string,
  dirRel: string,
): ChapterDocumentRef[] {
  const [currentLevel, ...rest] = levels;
  if (currentLevel) {
    return matchDirs(dirAbs, currentLevel).flatMap((directory) =>
      scanChapterRefs(
        config,
        rest,
        join(dirAbs, directory.dirName),
        `${dirRel}/${directory.dirName}`,
      ));
  }
  if (!existsSync(dirAbs)) return [];
  return readdirSync(dirAbs).flatMap((entry) => {
    try {
      const entryPath = join(dirAbs, entry);
      if (
        lstatSync(entryPath).isSymbolicLink()
        || !statSync(entryPath).isFile()
      ) return [];
      const chapterNo = numberFromPattern(
        entry,
        config.contentTree.leaf.filePattern,
        config.contentTree.leaf.numberStyle,
      );
      return chapterNo === null ? [] : [{ docId: `${dirRel}/${entry}`, chapterNo }];
    } catch {
      return [];
    }
  });
}

function buildNode(
  vaultRoot: string,
  config: ProjectConfig,
  levels: ContentTreeLevel[],
  dirAbs: string,
  dirRel: string,
  name: string,
  levelName: string,
): ChapterTreeNode {
  const [currentLevel, ...rest] = levels;
  if (!currentLevel) {
    return {
      name,
      levelName,
      children: [],
      chapters: matchChapters(vaultRoot, config, dirAbs, dirRel),
    };
  }
  const children = matchDirs(dirAbs, currentLevel).map((d) =>
    buildNode(
      vaultRoot,
      config,
      rest,
      join(dirAbs, d.dirName),
      `${dirRel}/${d.dirName}`,
      d.dirName,
      currentLevel.levelName,
    ),
  );
  return { name, levelName, children, chapters: [] };
}

export function buildChapterTree(vaultRoot: string, config: ProjectConfig): ChapterTree {
  const rootRel = config.contentTree.root;
  const rootPath = resolveDocPath(vaultRoot, rootRel);
  const root = buildNode(
    vaultRoot,
    config,
    config.contentTree.levels,
    rootPath,
    rootRel,
    rootRel,
    'root',
  );
  return { root };
}

/** Scan only configured chapter paths and numbers; no manuscript content is read. */
export function listChapterDocumentRefs(
  vaultRoot: string,
  config: ProjectConfig,
): ChapterDocumentRef[] {
  const rootRel = config.contentTree.root;
  return scanChapterRefs(
    config,
    config.contentTree.levels,
    resolveDocPath(vaultRoot, rootRel),
    rootRel,
  );
}

function collectLeafNodes(
  node: ChapterTreeNode,
  depth: number,
  targetDepth: number,
  path: string,
): Array<{ dir: string; chapters: DocumentMeta[] }> {
  if (depth === targetDepth) return [{ dir: path, chapters: node.chapters }];
  return node.children.flatMap((child) =>
    collectLeafNodes(child, depth + 1, targetDepth, `${path}/${child.name}`));
}

/**
 * Resolve the next number and target leaf from the configured content tree.
 * An override is accepted only when it exactly names an existing leaf.
 */
export function nextChapterLocation(
  vaultRoot: string,
  config: ProjectConfig,
  dirOverride?: string,
): NextChapterLocation {
  const tree = buildChapterTree(vaultRoot, config);
  const leaves = collectLeafNodes(
    tree.root,
    0,
    config.contentTree.levels.length,
    config.contentTree.root,
  );
  if (leaves.length === 0) {
    throw new Error('content tree has no existing leaf directory');
  }
  const requested = dirOverride
    ? leaves.find((leaf) => leaf.dir === dirOverride)
    : undefined;
  if (dirOverride && !requested) {
    throw new Error('chapter directory is not an existing content-tree leaf');
  }
  const allChapters = leaves.flatMap((leaf) =>
    leaf.chapters.map((chapter) => ({ leaf, chapter })));
  const latest = allChapters.reduce<typeof allChapters[number] | null>((current, candidate) => {
    if (!current) return candidate;
    const currentNo = current.chapter.chapterNo ?? -1;
    const candidateNo = candidate.chapter.chapterNo ?? -1;
    return candidateNo > currentNo
      || (candidateNo === currentNo && candidate.chapter.docId > current.chapter.docId)
      ? candidate
      : current;
  }, null);
  const target = requested ?? latest?.leaf ?? leaves.at(-1)!;
  const max = config.contentTree.leaf.numberingScope === 'book'
    ? allChapters.reduce((value, item) => Math.max(value, item.chapter.chapterNo ?? 0), 0)
    : target.chapters.reduce((value, chapter) => Math.max(value, chapter.chapterNo ?? 0), 0);
  return { dir: target.dir, chapterNo: max + 1 };
}
