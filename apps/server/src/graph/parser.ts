/**
 * Pure GFM table parsing for the WorldGraph Markdown source.
 *
 * This file is intentionally an implementation detail of WorldGraphModule.
 * REST routes and callers consume only the module snapshot interface.
 */

import { createHash } from 'node:crypto';
import { WORLD_GRAPH_HARD_LIMITS } from '@writing-studio/contract';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { StudioError } from '../errors.js';

export type GraphVisibility = 'public' | 'authorOnly';
export type GraphConfidence = 'confirmed' | 'inferred' | 'question';

export interface ParserLocation {
  file: string;
  line: number | null;
  tableRow: number | null;
}

export interface ParserDiagnostic extends ParserLocation {
  code: string;
  severity: 'error' | 'warning';
  entityKind: 'graph' | 'node' | 'edge' | 'nodeType' | 'relationType' | null;
  entityId: string | null;
  message: string;
}

export interface ParsedNodeType {
  id: string;
  name: string;
  visualFamily: string;
}

export interface ParsedRelationType {
  id: string;
  name: string;
  visualFamily: string;
  directed: boolean;
  reverseName: string | null;
}

export interface ParsedNode {
  id: string;
  name: string;
  aliases: string[];
  typeId: string;
  activeFrom: string;
  revealedAt: string;
  inactiveFrom: string;
  visibility: GraphVisibility;
  confidence: GraphConfidence;
  sources: string;
  origin: 'explicit' | 'derived' | 'implicit';
  location: ParserLocation;
}

export interface ParsedEdge {
  id: string;
  source: string;
  relationTypeId: string;
  target: string;
  activeFrom: string;
  revealedAt: string;
  inactiveFrom: string;
  visibility: GraphVisibility;
  confidence: GraphConfidence;
  sources: string;
  location: ParserLocation;
}

export interface GraphAliases {
  sections?: {
    nodeTypes?: string[];
    relationTypes?: string[];
    nodes?: string[];
    relations?: string[];
  };
  nodeTypes?: {
    id?: string[];
    name?: string[];
    visualFamily?: string[];
  };
  relationTypes?: {
    id?: string[];
    name?: string[];
    visualFamily?: string[];
    directed?: string[];
    reverseName?: string[];
  };
  nodes?: {
    id?: string[];
    name?: string[];
    aliases?: string[];
    typeId?: string[];
    activeFrom?: string[];
    revealedAt?: string[];
    inactiveFrom?: string[];
    visibility?: string[];
    confidence?: string[];
    sources?: string[];
  };
  relations?: {
    id?: string[];
    source?: string[];
    relationTypeId?: string[];
    targetId?: string[];
    activeFrom?: string[];
    revealedAt?: string[];
    inactiveFrom?: string[];
    visibility?: string[];
    confidence?: string[];
    sources?: string[];
  };
}

interface ParsedGraphTables {
  nodeTypes: ParsedNodeType[];
  relationTypes: ParsedRelationType[];
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  diagnostics: ParserDiagnostic[];
}

interface MdPosition {
  start?: { line?: number };
}

interface MdNode {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
  position?: MdPosition;
}

interface MarkdownHeading {
  lineIndex: number;
  depth: number;
  text: string;
}

type AliasTable = Record<string, string[]>;

const DEFAULT_SECTIONS = {
  nodeTypes: ['节点类型', 'Node Types', 'NodeTypes'],
  relationTypes: ['关系类型', 'Relation Types', 'RelationTypes'],
  nodes: ['节点', 'Nodes', 'Entities'],
  relations: ['关系', 'Relations', 'Edges'],
};

const DEFAULT_NODE_TYPE_COLUMNS: AliasTable = {
  id: ['ID', '标识'],
  name: ['名称', 'Name', 'Label'],
  visualFamily: ['视觉族', 'Visual Family', 'VisualFamily'],
};

const DEFAULT_RELATION_TYPE_COLUMNS: AliasTable = {
  id: ['ID', '标识'],
  name: ['名称', 'Name', 'Label'],
  visualFamily: ['视觉族', 'Visual Family', 'VisualFamily'],
  directed: ['有向', 'Directed'],
  reverseName: ['反向名称', 'Reverse Name', 'Inverse Name', 'ReverseName'],
};

const DEFAULT_NODE_COLUMNS: AliasTable = {
  id: ['ID', '标识'],
  name: ['名称', 'Name'],
  aliases: ['别名', 'Aliases', 'Alias'],
  typeId: ['类型', '类型ID', 'Type', 'Type ID', 'Kind'],
  activeFrom: ['生效章', 'Active From', 'ActiveFrom'],
  revealedAt: ['揭示章', 'Revealed At', 'RevealedAt'],
  inactiveFrom: ['失效章', 'Inactive From', 'InactiveFrom'],
  visibility: ['可见性', 'Visibility'],
  confidence: ['置信', 'Confidence'],
  sources: ['出处', 'Sources', 'Source', 'Evidence'],
};

const DEFAULT_RELATION_COLUMNS: AliasTable = {
  id: ['ID', '标识'],
  source: ['源', 'Source', 'From'],
  relationTypeId: ['关系', '关系类型', 'Relation', 'Relation Type', 'Type'],
  targetId: ['目标', 'Target', 'To'],
  activeFrom: ['生效章', 'Active From', 'ActiveFrom'],
  revealedAt: ['揭示章', 'Revealed At', 'RevealedAt'],
  inactiveFrom: ['失效章', 'Inactive From', 'InactiveFrom'],
  visibility: ['可见性', 'Visibility'],
  confidence: ['置信', 'Confidence'],
  sources: ['出处', 'Sources', 'Source Ref', 'Evidence'],
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function validId(value: string): boolean {
  return value.length <= 128 && ID_PATTERN.test(value);
}

export function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizedKey(value: string): string {
  return normalize(value).toLocaleLowerCase();
}

function nodeText(node: MdNode): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(nodeText).join('');
}

function tableRows(table: MdNode): string[][] {
  return (table.children ?? []).map((row) =>
    (row.children ?? []).map((cell) => normalize(nodeText(cell))),
  );
}

function mergeAliases(defaults: AliasTable, configured: Record<string, string[] | undefined> | undefined): AliasTable {
  const result: AliasTable = {};
  for (const [field, aliases] of Object.entries(defaults)) {
    result[field] = [...aliases, ...(configured?.[field] ?? [])];
  }
  return result;
}

function sectionNames(
  key: keyof typeof DEFAULT_SECTIONS,
  aliases: GraphAliases | undefined,
): Set<string> {
  return new Set([...DEFAULT_SECTIONS[key], ...(aliases?.sections?.[key] ?? [])].map(normalizedKey));
}

/**
 * Split a candidate GFM table row without parsing its inline Markdown. This is
 * deliberately limited to table structure, so the hard-limit check runs
 * before remark-gfm expands a very large table into an mdast tree.
 */
function gfmTableCells(line: string): string[] | null {
  if (/^(?: {4}|\t)/u.test(line)) return null;
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;

  const isEscaped = (index: number): boolean => {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && trimmed[cursor] === '\\'; cursor -= 1) {
      backslashes += 1;
    }
    return backslashes % 2 === 1;
  };
  const cells: string[] = [];
  let cell = '';
  let pipeCount = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (character === '|' && !isEscaped(index)) {
      cells.push(cell.trim());
      cell = '';
      pipeCount += 1;
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  if (pipeCount === 0) return null;
  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|') && !isEscaped(trimmed.length - 1)) cells.pop();
  return cells.length > 0 ? cells : null;
}

function isGfmDelimiterRow(cells: string[] | null, expectedColumns: number): boolean {
  return cells !== null
    && cells.length === expectedColumns
    && cells.every((cell) => /^:?-+:?$/u.test(cell));
}

function isFence(line: string): boolean {
  return /^ {0,3}(?:`{3,}|~{3,})/u.test(line);
}

function firstGfmTableDataRows(lines: string[], startLine: number, endLine: number): number {
  let fenced = false;
  for (let lineIndex = startLine; lineIndex < endLine - 1; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if (isFence(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const header = gfmTableCells(line);
    if (!header || !isGfmDelimiterRow(gfmTableCells(lines[lineIndex + 1] ?? ''), header.length)) continue;

    let rows = 0;
    for (let dataIndex = lineIndex + 2; dataIndex < endLine; dataIndex += 1) {
      const dataLine = lines[dataIndex] ?? '';
      if (isFence(dataLine) || !gfmTableCells(dataLine)) break;
      rows += 1;
    }
    return rows;
  }
  return 0;
}

/**
 * Reject an oversized explicit table before remark-gfm performs its costly
 * full-table parse. Heading discovery still uses remark-parse so fences and
 * other Markdown block boundaries remain authoritative.
 */
function preflightHardGraphLimit(markdown: string, aliases: GraphAliases | undefined): void {
  const headingTree = unified().use(remarkParse).parse(markdown) as MdNode;
  const lines = markdown.split(/\r?\n/u);
  const limits = [
    { section: 'nodes' as const, limit: WORLD_GRAPH_HARD_LIMITS.nodes },
    { section: 'relations' as const, limit: WORLD_GRAPH_HARD_LIMITS.edges },
  ];
  const headings = (headingTree.children ?? []).filter((node) =>
    node.type === 'heading'
    && node.depth === 2
    && typeof node.position?.start?.line === 'number',
  );

  for (const { section, limit } of limits) {
    const names = sectionNames(section, aliases);
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index]!;
      if (!names.has(normalizedKey(nodeText(heading)))) continue;
      const startLine = heading.position!.start!.line!;
      const endLine = headings[index + 1]?.position?.start?.line
        ? headings[index + 1]!.position!.start!.line! - 1
        : lines.length;
      if (firstGfmTableDataRows(lines, startLine, endLine) > limit) {
        throw new StudioError('GRAPH_TOO_LARGE', 'world graph exceeds the server safety limit');
      }
    }
  }
}

function findSectionTable(root: MdNode, names: Set<string>): { heading: MdNode; table: MdNode } | null {
  let active: MdNode | null = null;
  for (const node of root.children ?? []) {
    if (node.type === 'heading' && node.depth === 2) {
      active = names.has(normalizedKey(nodeText(node))) ? node : null;
      continue;
    }
    if (active && node.type === 'table') return { heading: active, table: node };
  }
  return null;
}

function makeLocation(file: string, row: MdNode | undefined, tableRow: number | null): ParserLocation {
  return {
    file,
    line: row?.position?.start?.line ?? null,
    tableRow,
  };
}

function columnMap(
  file: string,
  table: MdNode,
  aliases: AliasTable,
  required: string[],
  diagnostics: ParserDiagnostic[],
  entityKind: ParserDiagnostic['entityKind'],
): Map<string, number> | null {
  const rows = tableRows(table);
  const header = rows[0] ?? [];
  const indexes = new Map<string, number>();
  for (const [field, candidates] of Object.entries(aliases)) {
    for (const candidate of candidates) {
      const expected = normalizedKey(candidate);
      const index = header.findIndex((label) => normalizedKey(label) === expected);
      if (index >= 0) {
        indexes.set(field, index);
        break;
      }
    }
  }
  const missing = required.filter((field) => !indexes.has(field));
  if (missing.length === 0) return indexes;
  diagnostics.push({
    code: 'MISSING_COLUMNS',
    severity: 'error',
    entityKind,
    entityId: null,
    ...makeLocation(file, table, null),
    message: `table is missing required columns: ${missing.join(', ')}`,
  });
  return null;
}

function rowValue(row: string[], indexes: Map<string, number>, field: string): string {
  const index = indexes.get(field);
  return index === undefined ? '' : (row[index] ?? '');
}

function parseVisibility(value: string): GraphVisibility | null {
  const key = normalizedKey(value).replaceAll('-', '');
  if (key === 'public') return 'public';
  if (key === 'authoronly') return 'authorOnly';
  return null;
}

function parseConfidence(value: string): GraphConfidence | null {
  const key = normalizedKey(value);
  if (key === 'confirmed' || key === 'inferred' || key === 'question') return key;
  return null;
}

function parseDirected(value: string): boolean | null {
  const key = normalizedKey(value);
  if (['true', 'yes', '1', '是', '有向'].includes(key)) return true;
  if (['false', 'no', '0', '否', '无向'].includes(key)) return false;
  return null;
}

function pushInvalidRow(
  diagnostics: ParserDiagnostic[],
  location: ParserLocation,
  entityKind: NonNullable<ParserDiagnostic['entityKind']>,
  entityId: string | null,
  code: string,
  message: string,
): void {
  diagnostics.push({
    code,
    severity: 'error',
    entityKind,
    entityId,
    ...location,
    message,
  });
}

function parseNodeTypes(
  file: string,
  section: { table: MdNode } | null,
  aliases: GraphAliases | undefined,
  diagnostics: ParserDiagnostic[],
): ParsedNodeType[] {
  if (!section) return [];
  const indexes = columnMap(
    file,
    section.table,
    mergeAliases(DEFAULT_NODE_TYPE_COLUMNS, aliases?.nodeTypes),
    ['id', 'name', 'visualFamily'],
    diagnostics,
    'nodeType',
  );
  if (!indexes) return [];
  const rows = tableRows(section.table);
  const result: ParsedNodeType[] = [];
  const ids = new Set<string>();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    const rowNode = section.table.children?.[index];
    const location = makeLocation(file, rowNode, index);
    const id = rowValue(row, indexes, 'id');
    const name = rowValue(row, indexes, 'name');
    if (!validId(id) || !name) {
      pushInvalidRow(diagnostics, location, 'nodeType', id || null, 'INVALID_NODE_TYPE', 'node type requires a stable ASCII ID and name');
      continue;
    }
    if (ids.has(id)) {
      pushInvalidRow(diagnostics, location, 'nodeType', id, 'DUPLICATE_ID', `duplicate node type ID: ${id}`);
      continue;
    }
    ids.add(id);
    result.push({ id, name, visualFamily: rowValue(row, indexes, 'visualFamily') || 'unknown' });
  }
  return result;
}

function parseRelationTypes(
  file: string,
  section: { table: MdNode } | null,
  aliases: GraphAliases | undefined,
  diagnostics: ParserDiagnostic[],
): ParsedRelationType[] {
  if (!section) return [];
  const indexes = columnMap(
    file,
    section.table,
    mergeAliases(DEFAULT_RELATION_TYPE_COLUMNS, aliases?.relationTypes),
    ['id', 'name', 'visualFamily', 'directed', 'reverseName'],
    diagnostics,
    'relationType',
  );
  if (!indexes) return [];
  const rows = tableRows(section.table);
  const result: ParsedRelationType[] = [];
  const ids = new Set<string>();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    const location = makeLocation(file, section.table.children?.[index], index);
    const id = rowValue(row, indexes, 'id');
    const name = rowValue(row, indexes, 'name');
    const directed = parseDirected(rowValue(row, indexes, 'directed'));
    if (!validId(id) || !name || directed === null) {
      pushInvalidRow(diagnostics, location, 'relationType', id || null, 'INVALID_RELATION_TYPE', 'relation type requires a stable ASCII ID, name, and valid directed flag');
      continue;
    }
    if (ids.has(id)) {
      pushInvalidRow(diagnostics, location, 'relationType', id, 'DUPLICATE_ID', `duplicate relation type ID: ${id}`);
      continue;
    }
    ids.add(id);
    result.push({
      id,
      name,
      visualFamily: rowValue(row, indexes, 'visualFamily') || 'custom',
      directed,
      reverseName: rowValue(row, indexes, 'reverseName') || null,
    });
  }
  return result;
}

function parseNodes(
  file: string,
  section: { table: MdNode } | null,
  aliases: GraphAliases | undefined,
  diagnostics: ParserDiagnostic[],
): ParsedNode[] {
  if (!section) return [];
  const indexes = columnMap(
    file,
    section.table,
    mergeAliases(DEFAULT_NODE_COLUMNS, aliases?.nodes),
    ['id', 'name', 'aliases', 'typeId', 'activeFrom', 'revealedAt', 'inactiveFrom', 'visibility', 'confidence', 'sources'],
    diagnostics,
    'node',
  );
  if (!indexes) return [];
  const rows = tableRows(section.table);
  const result: ParsedNode[] = [];
  const ids = new Set<string>();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    const location = makeLocation(file, section.table.children?.[index], index);
    const id = rowValue(row, indexes, 'id');
    const name = rowValue(row, indexes, 'name');
    const typeId = rowValue(row, indexes, 'typeId') || 'unknown';
    const visibility = parseVisibility(rowValue(row, indexes, 'visibility'));
    const confidence = parseConfidence(rowValue(row, indexes, 'confidence'));
    if (!validId(id) || !name || !validId(typeId)) {
      pushInvalidRow(diagnostics, location, 'node', id || null, 'INVALID_NODE', 'node requires stable ASCII ID/type and a name');
      continue;
    }
    if (!visibility || !confidence) {
      pushInvalidRow(diagnostics, location, 'node', id, 'INVALID_SAFETY_FIELDS', 'node requires visibility public|authorOnly and confidence confirmed|inferred|question');
      continue;
    }
    if (ids.has(id)) {
      pushInvalidRow(diagnostics, location, 'node', id, 'DUPLICATE_ID', `duplicate node ID: ${id}`);
      continue;
    }
    ids.add(id);
    result.push({
      id,
      name,
      aliases: rowValue(row, indexes, 'aliases').split(/[、,，;；]/u).map(normalize).filter(Boolean),
      typeId,
      activeFrom: rowValue(row, indexes, 'activeFrom'),
      revealedAt: rowValue(row, indexes, 'revealedAt'),
      inactiveFrom: rowValue(row, indexes, 'inactiveFrom'),
      visibility,
      confidence,
      sources: rowValue(row, indexes, 'sources'),
      origin: 'explicit',
      location,
    });
  }
  return result;
}

function parseEdges(
  file: string,
  section: { table: MdNode } | null,
  aliases: GraphAliases | undefined,
  diagnostics: ParserDiagnostic[],
): ParsedEdge[] {
  if (!section) {
    diagnostics.push({
      code: 'MISSING_RELATIONS_SECTION', severity: 'error', entityKind: 'graph', entityId: null,
      file, line: null, tableRow: null, message: 'required relations section is missing',
    });
    return [];
  }
  const indexes = columnMap(
    file,
    section.table,
    mergeAliases(DEFAULT_RELATION_COLUMNS, aliases?.relations),
    ['id', 'source', 'relationTypeId', 'targetId', 'activeFrom', 'revealedAt', 'inactiveFrom', 'visibility', 'confidence', 'sources'],
    diagnostics,
    'edge',
  );
  if (!indexes) return [];
  const rows = tableRows(section.table);
  const result: ParsedEdge[] = [];
  const ids = new Set<string>();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    const location = makeLocation(file, section.table.children?.[index], index);
    const id = rowValue(row, indexes, 'id');
    const source = rowValue(row, indexes, 'source');
    const relationTypeId = rowValue(row, indexes, 'relationTypeId');
    const target = rowValue(row, indexes, 'targetId');
    const visibility = parseVisibility(rowValue(row, indexes, 'visibility'));
    const confidence = parseConfidence(rowValue(row, indexes, 'confidence'));
    if (!validId(id) || !source || !target || !validId(relationTypeId)) {
      pushInvalidRow(diagnostics, location, 'edge', id || null, 'INVALID_RELATION', 'relation requires stable ASCII ID/type and non-empty endpoints');
      continue;
    }
    if (!visibility || !confidence) {
      pushInvalidRow(diagnostics, location, 'edge', id, 'INVALID_SAFETY_FIELDS', 'relation requires visibility public|authorOnly and confidence confirmed|inferred|question');
      continue;
    }
    if (ids.has(id)) {
      pushInvalidRow(diagnostics, location, 'edge', id, 'DUPLICATE_ID', `duplicate relation ID: ${id}`);
      continue;
    }
    ids.add(id);
    result.push({
      id,
      source,
      relationTypeId,
      target,
      activeFrom: rowValue(row, indexes, 'activeFrom'),
      revealedAt: rowValue(row, indexes, 'revealedAt'),
      inactiveFrom: rowValue(row, indexes, 'inactiveFrom'),
      visibility,
      confidence,
      sources: rowValue(row, indexes, 'sources'),
      location,
    });
  }
  return result;
}

export function implicitNodeId(name: string): string {
  const digest = createHash('sha256').update(normalizedKey(name)).digest('hex').slice(0, 16);
  return `implicit:${digest}`;
}

export function graphNameKey(name: string): string {
  return normalizedKey(name);
}

export function parseGraphMarkdown(
  file: string,
  markdown: string,
  aliases?: GraphAliases,
): ParsedGraphTables {
  preflightHardGraphLimit(markdown, aliases);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as MdNode;
  const diagnostics: ParserDiagnostic[] = [];
  const nodeTypeSection = findSectionTable(tree, sectionNames('nodeTypes', aliases));
  const relationTypeSection = findSectionTable(tree, sectionNames('relationTypes', aliases));
  const nodeSection = findSectionTable(tree, sectionNames('nodes', aliases));
  const relationSection = findSectionTable(tree, sectionNames('relations', aliases));
  return {
    nodeTypes: parseNodeTypes(file, nodeTypeSection, aliases, diagnostics),
    relationTypes: parseRelationTypes(file, relationTypeSection, aliases, diagnostics),
    nodes: parseNodes(file, nodeSection, aliases, diagnostics),
    edges: parseEdges(file, relationSection, aliases, diagnostics),
    diagnostics,
  };
}

/**
 * Return only headings recognized by the Markdown parser. A line-regex would
 * incorrectly treat `# text` inside fenced code as an evidence boundary.
 */
export function markdownHeadings(markdown: string): MarkdownHeading[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as MdNode;
  return (tree.children ?? [])
    .filter((node) =>
      node.type === 'heading'
      && typeof node.depth === 'number'
      && typeof node.position?.start?.line === 'number',
    )
    .map((node) => ({
      lineIndex: node.position!.start!.line! - 1,
      depth: node.depth!,
      text: normalize(nodeText(node)),
    }));
}
