/** Pure Markdown-to-sidebar DTO transformations. */

import type {
  CharacterCard,
  CharacterCardSection,
  ForeshadowEntry,
  ProjectConfig,
  SettingIndexEntry,
  SidebarPayload,
  SidebarSource,
  WritingStatusDto,
} from '@writing-studio/contract';
import { writingStatusHeadings } from './locales/index.js';
import type { WritingStatusSectionHeadings } from './locales/types.js';
import type { MdNode, SidebarRole } from './types.js';

interface CharacterSection extends CharacterCardSection {
  nodes: MdNode[];
}

interface ParsedCharacterCard extends Omit<CharacterCard, 'sections'> {
  headingNode: MdNode;
  sections: CharacterSection[];
}

function nodeText(node: MdNode): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(nodeText).join('');
}

function nodeTextWithMarkers(node: MdNode): string {
  if (typeof node.value === 'string') return node.value;
  const content = (node.children ?? []).map(nodeTextWithMarkers).join('');
  if (node.type === 'strong') return `**${content}**`;
  if (node.type === 'emphasis') return `*${content}*`;
  return content;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function nodeBody(nodes: MdNode[]): string {
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.type === 'list') {
      for (const item of node.children ?? []) {
        const text = normalizeText(nodeText(item));
        if (text) lines.push(text);
      }
    } else if (node.type === 'table') {
      for (const row of node.children ?? []) {
        const cells = (row.children ?? []).map((cell) => normalizeText(nodeText(cell)));
        if (cells.length) lines.push(cells.join(' | '));
      }
    } else {
      const text = normalizeText(nodeText(node));
      if (text) lines.push(text);
    }
  }
  return lines.join('\n');
}

function configRecord(config: unknown): Record<string, unknown> {
  return config !== null && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
}

function configString(config: unknown, name: string): string | null {
  const value = configRecord(config)[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function configNumber(config: unknown, name: string): number | null {
  const value = configRecord(config)[name];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function configStrings(config: unknown, name: string): string[] {
  const value = configRecord(config)[name];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function topLevelSections(nodes: MdNode[], depth: number): Array<{ heading: MdNode; nodes: MdNode[] }> {
  const sections: Array<{ heading: MdNode; nodes: MdNode[] }> = [];
  let active: { heading: MdNode; nodes: MdNode[] } | null = null;
  for (const node of nodes) {
    if (node.type === 'heading' && node.depth === depth) {
      active = { heading: node, nodes: [] };
      sections.push(active);
    } else if (active) active.nodes.push(node);
  }
  return sections;
}

function sectionsBeforeNextAtOrAbove(
  nodes: MdNode[], depth: number,
): Array<{ heading: MdNode; nodes: MdNode[] }> {
  const sections: Array<{ heading: MdNode; nodes: MdNode[] }> = [];
  let active: { heading: MdNode; nodes: MdNode[] } | null = null;
  for (const node of nodes) {
    if (node.type === 'heading' && (node.depth ?? 7) <= depth) {
      if (node.depth === depth) {
        active = { heading: node, nodes: [] };
        sections.push(active);
      } else active = null;
    } else if (active) active.nodes.push(node);
  }
  return sections;
}

function tableRows(table: MdNode): string[][] {
  return (table.children ?? []).map((row) =>
    (row.children ?? []).map((cell) => normalizeText(nodeText(cell))),
  );
}

function parseMarkdownTable(source: SidebarSource, tree: MdNode, role: SidebarRole): SidebarPayload {
  const config = configRecord(source.parserConfig);
  const levels = config['sectionHeadingLevels'];
  const sectionLevels = Array.isArray(levels) && levels.every((level) => Number.isInteger(level))
    ? new Set(levels as number[]) : new Set<number>();
  const aliases = config['columnAliases'];
  const columnAliases = aliases && typeof aliases === 'object' && !Array.isArray(aliases)
    ? aliases as Record<string, unknown> : {};
  const configuredHidden = config['writerHiddenFields'];
  const writerHiddenFields = new Set(
    Array.isArray(configuredHidden) && configuredHidden.every((field) => typeof field === 'string')
      ? configuredHidden as string[]
      : ['blankLink'],
  );
  const sectionParts: string[] = [];
  const entries: SettingIndexEntry[] = [];

  for (const node of tree.children ?? []) {
    if (node.type === 'heading' && typeof node.depth === 'number' && sectionLevels.has(node.depth)) {
      const depth = node.depth;
      const index = [...sectionParts.keys()].findIndex((position) => position >= depth - 2);
      if (index >= 0) sectionParts.splice(index);
      sectionParts[depth - 2] = normalizeText(nodeText(node));
      continue;
    }
    if (node.type !== 'table') continue;
    const [header, ...rows] = tableRows(node);
    if (!header) continue;
    const columnIndex = (field: string): number => {
      const candidates = configStrings(columnAliases, field);
      return header.findIndex((label) => candidates.includes(label));
    };
    const termIndex = columnIndex('term');
    const sourceIndex = columnIndex('source');
    if (termIndex < 0 || sourceIndex < 0) continue;
    const valueAt = (row: string[], field: string): string | null => {
      const index = columnIndex(field);
      return index >= 0 ? (row[index] ?? '') : null;
    };
    for (const row of rows) {
      const hide = (field: string, value: string): string =>
        role === 'writer' && writerHiddenFields.has(field) ? '' : value;
      entries.push({
        section: sectionParts.filter(Boolean).join(' > '),
        term: hide('term', row[termIndex] ?? ''),
        source: hide('source', row[sourceIndex] ?? ''),
        firstAppearance: hide('firstAppearance', valueAt(row, 'firstAppearance') ?? ''),
        blankLink: hide('blankLink', valueAt(row, 'blankLink') ?? ''),
        status: hide('status', valueAt(row, 'status') ?? ''),
        serial: role === 'writer' && writerHiddenFields.has('serial') ? null : valueAt(row, 'serial'),
      });
    }
  }
  return { sourceId: source.id, parser: 'markdown-table', entries };
}

function parseWritingStatus(
  source: SidebarSource,
  tree: MdNode,
  localePreset: ProjectConfig['localePreset'],
): SidebarPayload {
  const config = configRecord(source.parserConfig);
  const configuredHeadings = configRecord(config['sectionHeadings']);
  const localeHeadings = writingStatusHeadings(localePreset);
  const heading = (name: keyof WritingStatusSectionHeadings): string =>
    configString(configuredHeadings, name) ?? localeHeadings[name];
  const sectionHeadings: WritingStatusSectionHeadings = {
    stopPoint: heading('stopPoint'),
    storylines: heading('storylines'),
    activeForeshadow: heading('activeForeshadow'),
    characterOneLiners: heading('characterOneLiners'),
    redLines: heading('redLines'),
    expressionBaseline: heading('expressionBaseline'),
  };
  const rootText = nodeBody(tree.children ?? []);
  const matchConfigRegex = (name: string): string | null => {
    const pattern = configString(config, name);
    if (!pattern) return null;
    try { return new RegExp(pattern, 'm').exec(rootText)?.[1] ?? null; } catch { return null; }
  };
  const h2 = topLevelSections(tree.children ?? [], 2);
  const section = (heading: string): MdNode[] => h2.find((candidate) => {
    const actual = normalizeText(nodeText(candidate.heading));
    return actual === heading || actual.startsWith(`${heading}（`) || actual.startsWith(`${heading} (`);
  })?.nodes ?? [];
  const listItems = (nodes: MdNode[]): string[] => nodes.flatMap((node) => node.type === 'list'
    ? (node.children ?? []).map((item) => normalizeText(nodeText(item))).filter(Boolean) : []);
  const namedLines = (nodes: MdNode[]): string[] => nodes.flatMap((node) => {
    if (node.type === 'list') {
      return (node.children ?? []).map((item) => normalizeText(nodeTextWithMarkers(item))).filter(Boolean);
    }
    if (node.type === 'paragraph') {
      const line = normalizeText(nodeTextWithMarkers(node));
      return line ? [line] : [];
    }
    return [];
  });
  const namedItems = (nodes: MdNode[], contentKey: 'body' | 'text') => namedLines(nodes).map((line) => {
    const boldMatch = /^\*\*(.+?)\*\*(?:（[^）]*）)?[：:]\s*(.+)$/.exec(line);
    const match = boldMatch ?? /^(.+?)[：:]\s*(.+)$/.exec(line.replace(/^\*\*|\*\*$/g, ''));
    const name = match?.[1];
    const content = match?.[2];
    if (name !== undefined && content !== undefined) {
      return { name: name.replace(/^\*\*|\*\*$/g, '').trim(), [contentKey]: content.trim() };
    }
    return { name: line, [contentKey]: '' };
  });
  const activeTable = section(heading('activeForeshadow')).find((node) => node.type === 'table');
  const rows = activeTable ? tableRows(activeTable).slice(1) : [];
  const data: WritingStatusDto = {
    sectionHeadings,
    lastRefreshed: matchConfigRegex('lastRefreshedRegex'),
    stopChapter: (() => {
      const value = matchConfigRegex('stopChapterRegex');
      return value && /^\d+$/.test(value) ? Number(value) : null;
    })(),
    stopPoint: nodeBody(section(heading('stopPoint'))),
    storylines: namedItems(section(heading('storylines')), 'body') as WritingStatusDto['storylines'],
    activeForeshadow: rows.map((row) => ({ id: row[0] ?? '', content: row[1] ?? '', status: row[2] ?? '' })),
    characterOneLiners: namedItems(
      section(heading('characterOneLiners')), 'text',
    ) as WritingStatusDto['characterOneLiners'],
    redLines: listItems(section(heading('redLines'))),
    expressionBaseline: nodeBody(section(heading('expressionBaseline'))),
  };
  return { sourceId: source.id, parser: 'heading-sections', kind: 'writingStatus', data };
}

function hasMarker(node: MdNode, markers: string[]): boolean {
  const text = nodeText(node).toLocaleLowerCase();
  return markers.some((marker) => text.includes(marker.toLocaleLowerCase()));
}

function withoutMarkedNodes(nodes: MdNode[], markers: string[]): MdNode[] {
  const result: MdNode[] = [];
  for (const node of nodes) {
    if (node.type === 'list') {
      const children = (node.children ?? []).filter((item) => !hasMarker(item, markers));
      if (children.length > 0) result.push({ ...node, children });
    } else if (!hasMarker(node, markers)) result.push(node);
  }
  return result;
}

function parseCharacters(source: SidebarSource, tree: MdNode): ParsedCharacterCard[] {
  const config = configRecord(source.parserConfig);
  const cardHeadingLevel = configNumber(config, 'cardHeadingLevel');
  const sectionHeadingLevel = configNumber(config, 'sectionHeadingLevel');
  if (cardHeadingLevel === null || sectionHeadingLevel === null) return [];
  const markers = configStrings(config, 'authorOnlyMarkers');
  return sectionsBeforeNextAtOrAbove(tree.children ?? [], cardHeadingLevel).map((card) => ({
    name: normalizeText(nodeText(card.heading)), headingNode: card.heading,
    sections: sectionsBeforeNextAtOrAbove(card.nodes, sectionHeadingLevel).map((section) => ({
      heading: normalizeText(nodeText(section.heading)), body: nodeBody(section.nodes),
      authorOnly: hasMarker(section.heading, markers), nodes: section.nodes,
    })),
  }));
}

function characterPayload(source: SidebarSource, tree: MdNode, role: SidebarRole): SidebarPayload {
  const markers = configStrings(source.parserConfig, 'authorOnlyMarkers');
  const data: CharacterCard[] = parseCharacters(source, tree)
    .filter((card) => role === 'planner' || !hasMarker(card.headingNode, markers))
    .map((card) => ({
      name: card.name,
      sections: card.sections.filter((section) => role === 'planner' || !section.authorOnly).map((section) => ({
        heading: section.heading, authorOnly: section.authorOnly,
        body: role === 'writer' ? nodeBody(withoutMarkedNodes(section.nodes, markers)) : section.body,
      })).filter((section) => role === 'planner' || Boolean(section.body)),
    })).filter((card) => role === 'planner' || card.sections.length > 0);
  return { sourceId: source.id, parser: 'heading-sections', kind: 'characters', data };
}

function parseForeshadowing(source: SidebarSource, tree: MdNode, role: SidebarRole): SidebarPayload {
  const config = configRecord(source.parserConfig);
  const itemHeadingLevel = configNumber(config, 'itemHeadingLevel');
  const itemPattern = configString(config, 'itemIdRegex');
  const statusPattern = configString(config, 'statusFieldRegex');
  if (itemHeadingLevel === null || !itemPattern) {
    return { sourceId: source.id, parser: 'heading-sections', kind: 'foreshadowing', data: [] };
  }
  let itemRegex: RegExp;
  try { itemRegex = new RegExp(itemPattern); } catch {
    return { sourceId: source.id, parser: 'heading-sections', kind: 'foreshadowing', data: [] };
  }
  let statusRegex: RegExp | null = null;
  if (statusPattern) try { statusRegex = new RegExp(statusPattern, 'm'); } catch { statusRegex = null; }
  // The project writer profile forbids the full tracker. Its public subset is
  // already represented by WritingStatusDto.activeForeshadow, so a writer
  // projection must fail closed rather than guess from textual markers.
  if (role === 'writer' && config['writerVisible'] !== true) {
    return { sourceId: source.id, parser: 'heading-sections', kind: 'foreshadowing', data: [] };
  }
  const data: ForeshadowEntry[] = [];
  for (const item of sectionsBeforeNextAtOrAbove(tree.children ?? [], itemHeadingLevel)) {
    const match = itemRegex.exec(normalizeText(nodeText(item.heading)));
    if (!match) continue;
    const body = nodeBody(item.nodes);
    const sourceBody = item.nodes.map(nodeTextWithMarkers).join('\n');
    data.push({
      id: match[1] ?? '', title: match[2] ?? '', body,
      status: statusRegex?.exec(sourceBody)?.[1]?.trim() ?? null,
    });
  }
  return { sourceId: source.id, parser: 'heading-sections', kind: 'foreshadowing', data };
}

export function parsePayload(
  source: SidebarSource,
  tree: MdNode,
  markdown: string,
  role: SidebarRole,
  localePreset?: ProjectConfig['localePreset'],
): SidebarPayload {
  if (source.parser === 'markdown-table') return parseMarkdownTable(source, tree, role);
  if (source.parser === 'plain') return { sourceId: source.id, parser: 'plain', markdown };
  const kind = configString(source.parserConfig, 'kind');
  if (kind === 'writingStatus') return parseWritingStatus(source, tree, localePreset);
  if (kind === 'characters') return characterPayload(source, tree, role);
  if (kind === 'foreshadowing') return parseForeshadowing(source, tree, role);
  return { sourceId: source.id, parser: 'plain', markdown: '' };
}

export function filterSidebarPayload(payload: SidebarPayload, query: string | undefined): SidebarPayload {
  if (payload.parser !== 'markdown-table' || !query?.trim()) return structuredClone(payload);
  const needle = query.trim().toLocaleLowerCase();
  return {
    ...structuredClone(payload),
    entries: payload.entries.filter((entry) =>
      entry.term.toLocaleLowerCase().includes(needle) || entry.source.toLocaleLowerCase().includes(needle),
    ),
  };
}
