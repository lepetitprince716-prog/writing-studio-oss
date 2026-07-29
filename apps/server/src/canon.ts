/**
 * Canon repair section boundaries.
 *
 * A repair may target only one complete writer-visible H2/H3 section. The
 * raw Markdown heading is part of the anchor, and adoption may change nothing
 * outside that anchor or rename the heading.
 */

import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import type {
  Anchor,
  CanonSectionRef,
  Project,
  SidebarPayload,
  SidebarSource,
  Thread,
} from '@writing-studio/contract';
import { createAnchor, resolveAnchor } from './anchors.js';
import { StudioError } from './errors.js';
import type { SidebarService } from './sidebar/index.js';
import { writingStatusHeadings } from './sidebar/locales/index.js';

type Position = { start?: { offset?: number }; end?: { offset?: number } };
type Node = {
  type: string;
  depth?: number;
  value?: string;
  children?: Node[];
  position?: Position;
};

interface MarkdownSection {
  depth: 2 | 3;
  heading: string;
  headingPath: string[];
  start: number;
  end: number;
}

const parser = unified().use(remarkParse).use(remarkGfm);

function text(node: Node): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(text).join('');
}

function normalized(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function sections(markdown: string): MarkdownSection[] {
  const root = parser.parse(markdown) as Node;
  const children = root.children ?? [];
  const result: MarkdownSection[] = [];
  let h2: string | null = null;
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index]!;
    if (node.type !== 'heading' || (node.depth !== 2 && node.depth !== 3)) continue;
    const heading = normalized(text(node));
    if (!heading) continue;
    if (node.depth === 2) h2 = heading;
    const start = node.position?.start?.offset;
    if (start === undefined) continue;
    let end = markdown.length;
    for (let next = index + 1; next < children.length; next += 1) {
      const candidate = children[next]!;
      if (
        candidate.type === 'heading'
        && typeof candidate.depth === 'number'
        && candidate.depth <= node.depth
      ) {
        end = candidate.position?.start?.offset ?? end;
        break;
      }
    }
    result.push({
      depth: node.depth,
      heading,
      headingPath: node.depth === 3 && h2 ? [h2, heading] : [heading],
      start,
      end,
    });
  }
  return result;
}

function configRecord(config: unknown): Record<string, unknown> {
  return config !== null && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
}

function pathKey(path: string[]): string {
  return JSON.stringify(path);
}

function markdownTableSectionFullyProjected(source: SidebarSource, exact: string): boolean {
  const config = configRecord(source.parserConfig);
  const hidden = config['writerHiddenFields'];
  if (!Array.isArray(hidden) || hidden.length > 0) return false;
  const aliases = configRecord(config['columnAliases']);
  const fields = ['term', 'source', 'firstAppearance', 'blankLink', 'status', 'serial'];
  const root = parser.parse(exact) as Node;
  const body = (root.children ?? []).slice(1);
  if (body.length === 0 || body.some((node) => node.type !== 'table')) return false;
  return body.every((table) => {
    const header = table.children?.[0];
    const labels = (header?.children ?? []).map((cell) => normalized(text(cell)));
    if (labels.length === 0) return false;
    const mapped = labels.map((label) => fields.filter((field) => {
      const candidates = aliases[field];
      return Array.isArray(candidates)
        && candidates.every((candidate) => typeof candidate === 'string')
        && candidates.includes(label);
    }));
    return (
      mapped.every((matches) => matches.length === 1)
      && new Set(mapped.map((matches) => matches[0]!)).size === labels.length
      && (table.children ?? []).every(
        (row) => (row.children ?? []).length === labels.length,
      )
    );
  });
}

function hasOnlyProjectedStringData(exact: string): boolean {
  const root = parser.parse(exact) as Node;
  const visit = (node: Node): boolean => {
    const record = node as Node & Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (
        key !== 'type'
        && key !== 'value'
        && key !== 'children'
        && key !== 'position'
        && typeof value === 'string'
        && value.length > 0
      ) return false;
    }
    return (node.children ?? []).every(visit);
  };
  return visit(root);
}

function payloadVisiblePaths(
  source: SidebarSource,
  payload: SidebarPayload,
  localePreset: Project['config']['localePreset'],
): Set<string> {
  const config = configRecord(source.parserConfig);
  if (source.parser === 'plain') return new Set();
  if (source.parser === 'markdown-table') {
    const hidden = config['writerHiddenFields'];
    // The parser's compatibility default hides blankLink. A raw table section
    // is complete writer context only when the config explicitly hides no
    // fields; otherwise anchoring it would expose or delete filtered columns.
    if (!Array.isArray(hidden) || hidden.length > 0) return new Set();
    return new Set(
      payload.parser === 'markdown-table'
        ? payload.entries.map((entry) => pathKey(entry.section.split(' > ').filter(Boolean)))
        : [],
    );
  }
  if (payload.parser !== 'heading-sections') return new Set();
  if (payload.kind === 'characters') {
    return new Set(payload.data.flatMap((card) =>
      card.sections
        .filter((section) => !section.authorOnly && Boolean(section.body))
        .map((section) => pathKey([card.name, section.heading]))));
  }
  if (payload.kind === 'writingStatus') {
    const configured = configRecord(config['sectionHeadings']);
    const locale = writingStatusHeadings(localePreset);
    const name = (key: string, fallback: string): string =>
      typeof configured[key] === 'string' ? configured[key] as string : fallback;
    // Only these fields are projected with nodeBody over the complete source
    // section. The list/table-derived fields intentionally omit raw nodes and
    // therefore cannot safely expose their whole Markdown section as an anchor.
    return new Set([
      name('stopPoint', locale.stopPoint),
      name('expressionBaseline', locale.expressionBaseline),
    ].map((heading) => pathKey([heading])));
  }
  if (payload.kind === 'foreshadowing') {
    if (config['writerVisible'] !== true) return new Set();
    return new Set(payload.data.flatMap((entry) => [
      pathKey([`${entry.id}：${entry.title}`]),
      pathKey([`${entry.id}: ${entry.title}`]),
      pathKey([entry.title]),
    ]));
  }
  return new Set();
}

function markerUnsafe(source: SidebarSource, exact: string): boolean {
  const config = configRecord(source.parserConfig);
  const markers = config['authorOnlyMarkers'];
  const normalizedExact = exact.toLocaleLowerCase();
  return Array.isArray(markers)
    && markers.some((marker) =>
      typeof marker === 'string' && normalizedExact.includes(marker.toLocaleLowerCase()));
}

function sourceForDoc(
  project: { config: Pick<Project['config'], 'sidebarSources'> },
  docId: string,
): SidebarSource {
  const matches = project.config.sidebarSources.filter((source) => source.file === docId);
  if (matches.length !== 1) {
    throw new StudioError('VALIDATION', 'canon repair target must be one configured sidebar source');
  }
  return matches[0]!;
}

export function writerVisibleCanonSections(
  project: { config: Pick<Project['config'], 'sidebarSources' | 'localePreset'> },
  docId: string,
  markdown: string,
  sha: string,
  writerPayload: SidebarPayload,
): CanonSectionRef[] {
  const source = sourceForDoc(project, docId);
  const visible = payloadVisiblePaths(source, writerPayload, project.config.localePreset);
  const all = sections(markdown);
  const duplicates = new Map<string, number>();
  for (const section of all) {
    const key = pathKey(section.headingPath);
    duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
  }
  return all.flatMap((section) => {
    const exact = markdown.slice(section.start, section.end);
    const fullyVisible = source.parser === 'plain'
      || visible.has(pathKey(section.headingPath))
      || (
        section.depth === 3
        && visible.has(pathKey([section.headingPath[0]!]))
      );
    if (
      !fullyVisible
      || duplicates.get(pathKey(section.headingPath)) !== 1
      || markerUnsafe(source, exact)
      || !hasOnlyProjectedStringData(exact)
      || (
        source.parser === 'markdown-table'
        && !markdownTableSectionFullyProjected(source, exact)
      )
    ) return [];
    const anchor = createAnchor(sha, markdown, section.start, section.end);
    return [{
      headingPath: section.headingPath,
      // These refs cross the writer-safe DTO boundary. Adjacent quote context
      // can belong to an AUTHOR_ONLY sibling, so only the complete target
      // section itself is exposed. The server reconstructs the durable anchor.
      anchor: { ...anchor, prefix: '', suffix: '' },
    }];
  });
}

export function resolveWriterVisibleCanonSection(
  project: Project,
  sidebars: SidebarService,
  docId: string,
  markdown: string,
  sha: string,
  headingPath: string[],
): CanonSectionRef {
  const writerPayload = sidebars.getSource(project, sourceForDoc(project, docId).id, 'writer');
  if (!writerPayload) throw new StudioError('VALIDATION', 'canon repair section is unavailable');
  const matches = writerVisibleCanonSections(project, docId, markdown, sha, writerPayload)
    .filter((section) => pathKey(section.headingPath) === pathKey(headingPath));
  if (matches.length !== 1) {
    // One generic response prevents hidden/filtered/ambiguous headings from
    // becoming a visibility oracle.
    throw new StudioError('VALIDATION', 'canon repair section is unavailable');
  }
  return matches[0]!;
}

function headingLine(exact: string): string {
  return exact.slice(0, exact.indexOf('\n') < 0 ? exact.length : exact.indexOf('\n'));
}

/** Enforce the persisted canon anchor again at the final PUT boundary. */
export function assertCanonAdoption(
  thread: Thread,
  currentContent: string,
  nextContent: string,
): { start: number; end: number } {
  if (thread.origin !== 'canon' || !thread.canon || !thread.anchor) {
    throw new StudioError('VALIDATION', 'source thread is not a canon repair');
  }
  const resolution = resolveAnchor(thread.anchor, currentContent);
  if (resolution.status !== 'exact') {
    throw new StudioError('STALE_WRITE', 'canon repair section moved; reopen the repair');
  }
  const before = currentContent.slice(0, resolution.start);
  const after = currentContent.slice(resolution.end);
  if (!nextContent.startsWith(before) || !nextContent.endsWith(after)) {
    throw new StudioError('VALIDATION', 'canon adoption may change only the anchored section');
  }
  const nextExact = nextContent.slice(before.length, nextContent.length - after.length);
  if (headingLine(nextExact) !== headingLine(thread.anchor.exact)) {
    throw new StudioError('VALIDATION', 'canon adoption cannot rename the section heading');
  }
  const parsed = sections(nextExact);
  const originalParsed = sections(thread.anchor.exact);
  const originalDepth = originalParsed[0]?.depth;
  if (
    parsed.length === 0
    || originalDepth === undefined
    || pathKey(parsed[0]!.headingPath.slice(-1)) !== pathKey(thread.canon.headingPath.slice(-1))
    || parsed.filter((section) => section.depth <= originalDepth).length !== 1
  ) {
    throw new StudioError('VALIDATION', 'canon adoption must preserve the anchored heading');
  }
  return { start: before.length, end: nextContent.length - after.length };
}
