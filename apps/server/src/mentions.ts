import { createHash } from 'node:crypto';
import type { MentionLocation, Project, SidebarPayload } from '@writing-studio/contract';
import { WorldGraphModule } from './graph/index.js';
import { SidebarService } from './sidebar/index.js';
import { listChapterDocumentRefs } from './tree.js';
import { readDocument } from './vault.js';

export interface AliasEntry {
  canonical: string;
  aliases: string[];
  sourceFile: string;
  sourceHeading: string;
  /** Internal routing data; never exposed by the mentions endpoint. */
  sourceId: string;
}

interface ChapterScan {
  sha: string;
  aliasesFingerprint: string;
  matches: Map<string, { count: number; firstOffset: number }>;
}

const aliasCache = new Map<string, AliasEntry[]>();
const chapterCache = new Map<string, ChapterScan>();

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function cleanAlias(value: string): string | null {
  const alias = value.trim();
  return alias.length >= 2 ? alias : null;
}

function uniqueAliases(values: string[]): string[] {
  return [...new Set(values.map(cleanAlias).filter((value): value is string => value !== null))];
}

function canonicalKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function aliasesFromPayload(sourceFile: string, payload: SidebarPayload): AliasEntry[] {
  if (payload.parser === 'heading-sections' && payload.kind === 'characters') {
    return payload.data.flatMap((card) => {
      const bareName = card.name.replace(/[（(].*$/u, '').trim();
      const aliases = uniqueAliases([
        card.name,
        bareName,
      ]);
      const headings = card.sections.filter((section) => !section.authorOnly).map((section) => section.heading);
      return aliases.length === 0 ? [] : (headings.length > 0 ? headings : [card.name]).map((sourceHeading) => ({
        canonical: card.name,
        aliases,
        sourceFile,
        sourceHeading,
        sourceId: payload.sourceId,
      }));
    });
  }
  if (payload.parser === 'markdown-table') {
    return payload.entries.flatMap((entry) => {
      const aliases = uniqueAliases([entry.term]);
      return aliases.length === 0 ? [] : [{
        canonical: entry.term,
        aliases,
        sourceFile,
        sourceHeading: entry.section,
        sourceId: payload.sourceId,
      }];
    });
  }
  if (payload.parser === 'heading-sections' && payload.kind === 'foreshadowing') {
    return payload.data.flatMap((entry) => {
      const aliases = uniqueAliases([entry.title, entry.id]);
      return aliases.length === 0 ? [] : [{
        canonical: entry.title,
        aliases,
        sourceFile,
        sourceHeading: entry.title,
        sourceId: payload.sourceId,
      }];
    });
  }
  return [];
}

/**
 * Builds only writer-projected aliases. The cache key deliberately mirrors the
 * sidebar content-addressing shape: stable source path plus a projection hash.
 */
export function writerAliasEntries(project: Project, sidebars = new SidebarService()): AliasEntry[] {
  const projected = project.config.sidebarSources
    .map((source) => {
      try {
        const result = sidebars.getSourceWithCacheKey(project, source.id, 'writer');
        return { source, payload: result?.payload, contentKey: result?.cacheKey };
      } catch {
        return { source, payload: undefined, contentKey: undefined };
      }
    })
    .filter((item): item is {
      source: Project['config']['sidebarSources'][number];
      payload: SidebarPayload;
      contentKey: string | undefined;
    } => Boolean(item.payload));
  const sidebarKey = projected.map(({ source, contentKey }) => {
    const key = contentKey ?? source.file;
    return `${key}\0${digest({ parser: source.parser, parserConfig: source.parserConfig })}`;
  });
  let graphEntries: AliasEntry[] = [];
  let graphKey = '';
  if (project.config.graph) {
    try {
      const graph = new WorldGraphModule(sidebars).getSnapshot(project, 'writer');
      graphKey = `${project.config.graph.relationsFile}\0${graph.version}`;
      graphEntries = graph.nodes.flatMap((node) => {
        const aliases = uniqueAliases([node.name, ...node.aliases]);
        return aliases.length === 0 ? [] : [{
          canonical: node.name,
          aliases,
          sourceFile: project.config.graph!.relationsFile,
          sourceHeading: node.name,
          sourceId: 'graph',
        }];
      });
    } catch {
      // Graph writer projection is fail-closed: an invalid/missing stop point
      // cannot contribute aliases to a writer request.
      graphEntries = [];
    }
  }
  const cacheKey = digest([...sidebarKey, graphKey]);
  const cached = aliasCache.get(cacheKey);
  if (cached) return structuredClone(cached);
  const entries = projected.flatMap(({ source, payload }) => aliasesFromPayload(source.file, payload));
  const combined = [...entries, ...graphEntries];
  // The graph often carries the real in-prose nickname while the character
  // card H2 carries the formal display name. When their canonical names agree,
  // share the union so a graph nickname can trigger the corresponding
  // writer-safe character card section instead of routing only to `graph`.
  const aliasesByCanonical = new Map<string, string[]>();
  for (const entry of combined) {
    const key = canonicalKey(entry.canonical);
    aliasesByCanonical.set(key, uniqueAliases([
      ...(aliasesByCanonical.get(key) ?? []),
      ...entry.aliases,
    ]));
  }
  const result = combined.map((entry) => ({
    ...entry,
    aliases: aliasesByCanonical.get(canonicalKey(entry.canonical)) ?? entry.aliases,
  }));
  aliasCache.set(cacheKey, result);
  return structuredClone(result);
}

export function matchedAliases(
  entries: AliasEntry[],
  text: string,
  excluded: string[],
): AliasEntry[] {
  const excludedSet = new Set(excluded);
  return entries.filter((entry) => entry.aliases.some((alias) =>
    alias.length >= 2 && !excludedSet.has(alias) && text.includes(alias)));
}

function countExact(content: string, aliases: string[]): { count: number; firstOffset: number } | null {
  const spans: Array<{ start: number; end: number }> = [];
  for (const alias of aliases) {
    let offset = content.indexOf(alias);
    while (offset !== -1) {
      spans.push({ start: offset, end: offset + alias.length });
      offset = content.indexOf(alias, offset + alias.length);
    }
  }
  // A full canonical name often contains its short alias at the same offset.
  // Treat that as one mention: prefer the longest span, then discard any
  // shorter occurrence that overlaps an already-counted mention.
  spans.sort((left, right) =>
    left.start - right.start
    || (right.end - right.start) - (left.end - left.start));
  const mentions: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    if (mentions.some((mention) => span.start < mention.end && span.end > mention.start)) continue;
    mentions.push(span);
  }
  return mentions.length === 0
    ? null
    : { count: mentions.length, firstOffset: mentions[0]!.start };
}

/** Chapter-only reverse index, with unchanged chapter SHA entries reused. */
export function chapterMentions(project: Project, canonical: string): MentionLocation[] {
  const entries = writerAliasEntries(project);
  if (!entries.some((entry) => entry.canonical === canonical)) return [];
  const aliasesFingerprint = digest(entries.map((entry) => ({
    canonical: entry.canonical,
    aliases: uniqueAliases(entry.aliases).sort(),
  })));
  const aliasesByCanonical = new Map<string, string[]>();
  for (const entry of entries) {
    aliasesByCanonical.set(entry.canonical, uniqueAliases([
      ...(aliasesByCanonical.get(entry.canonical) ?? []),
      ...entry.aliases,
    ]));
  }
  return listChapterDocumentRefs(project.vaultRoot, project.config).flatMap((chapter) => {
    let document: ReturnType<typeof readDocument>;
    try {
      document = readDocument(project.vaultRoot, project.config, chapter.docId);
    } catch {
      return [];
    }
    const key = `${project.vaultRoot}\0${chapter.docId}`;
    let cached = chapterCache.get(key);
    if (!cached || cached.sha !== document.meta.sha256 || cached.aliasesFingerprint !== aliasesFingerprint) {
      const matches = new Map<string, { count: number; firstOffset: number }>();
      for (const [candidate, aliases] of aliasesByCanonical) {
        const match = countExact(document.content, aliases);
        if (match) matches.set(candidate, match);
      }
      cached = {
        sha: document.meta.sha256,
        aliasesFingerprint,
        matches,
      };
      chapterCache.set(key, cached);
    }
    const match = cached.matches.get(canonical);
    return match ? [{ docId: chapter.docId, chapterNo: chapter.chapterNo, ...match }] : [];
  });
}
