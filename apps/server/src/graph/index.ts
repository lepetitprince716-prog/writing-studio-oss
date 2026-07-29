/**
 * WorldGraphModule is the single deep Module for graph parsing, story-time
 * resolution, safety projection, diagnostics, caching, source excerpts and
 * invalidation watching. Callers cross only this Interface; its parsing and
 * filesystem seams stay private to the implementation.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, relative, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type {
  GraphConfidence,
  GraphDiagnosticCode,
  GraphDiagnosticEntityKind,
  GraphSourceExcerpt,
  GraphSourceRef,
  GraphStoryTime,
  GraphView,
  GraphVisibility,
  GraphVisualFamily,
  NodeTypeDefinition,
  Project,
  RelationTypeDefinition,
  StoryPoint,
  WorldEdge,
  WorldGraphSnapshot,
  WorldNode,
} from '@writing-studio/contract';
import {
  graphDocIdSchema,
  WORLD_GRAPH_DIAGNOSTIC_LIMIT,
  WORLD_GRAPH_HARD_LIMITS,
  WORLD_GRAPH_SOURCE_EXCERPT_MAX_CHARS,
} from '@writing-studio/contract';
import { isProfileReadablePath } from '../context.js';
import { StudioError } from '../errors.js';
import { SidebarService } from '../sidebar/index.js';
import { writingStatusHeadings } from '../sidebar/locales/index.js';
import { buildChapterTree } from '../tree.js';
import { resolveDocPath, sha256 } from '../vault.js';
import {
  graphNameKey,
  implicitNodeId,
  markdownHeadings,
  normalize,
  parseGraphMarkdown,
  type GraphAliases,
  type ParsedEdge,
  type ParsedNode,
  type ParserDiagnostic,
  type ParserLocation,
} from './parser.js';

const MAX_GRAPH_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_EXCERPT_CHARS = WORLD_GRAPH_SOURCE_EXCERPT_MAX_CHARS;
const MAX_DIAGNOSTICS = WORLD_GRAPH_DIAGNOSTIC_LIMIT;
const MAX_NODES = WORLD_GRAPH_HARD_LIMITS.nodes;
const MAX_EDGES = WORLD_GRAPH_HARD_LIMITS.edges;
const RECOVERY_POLL_MS = 250;

const VISUAL_FAMILIES = new Set<GraphVisualFamily>([
  'character', 'faction', 'place', 'item', 'event', 'skill', 'species',
  'rule', 'foreshadow', 'custom', 'unknown',
]);

type GraphConfig = NonNullable<Project['config']['graph']>;

interface GraphInputs {
  config: GraphConfig;
  relationsMarkdown: string;
  storyPoints: StoryPoint[];
  baseFingerprint: string;
}

interface CacheEntry {
  baseFingerprint: string;
  dependencies: Map<string, string>;
  snapshot: WorldGraphSnapshot;
}

interface BuiltPlannerGraph {
  stopPoint: StoryPoint | null;
  stopState: WorldGraphSnapshot['stopState'];
  storyPoints: StoryPoint[];
  nodeTypes: NodeTypeDefinition[];
  relationTypes: RelationTypeDefinition[];
  nodes: WorldNode[];
  edges: WorldEdge[];
  diagnostics: ParserDiagnostic[];
  dependencies: Set<string>;
  writerBlockedNodeIds: Set<string>;
  writerBlockedEdgeIds: Set<string>;
}

interface ResolvedTime {
  value: GraphStoryTime;
  valid: boolean;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function graphConfig(project: Project): GraphConfig {
  const config = project.config.graph;
  if (!config) throw new StudioError('NOT_FOUND', 'world graph is not configured');
  return config;
}

function readRegularFile(
  vaultRoot: string,
  docId: string,
  maxBytes: number,
): { content: string; hash: string } {
  const path = resolveDocPath(vaultRoot, docId);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new StudioError('INVALID_CONFIG', 'configured graph source is unavailable or too large');
    }
    const content = readFileSync(descriptor, 'utf8');
    return { content, hash: sha256(content) };
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw new StudioError('INVALID_CONFIG', 'configured graph source is unavailable', { cause: error });
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function tryDependencyHash(vaultRoot: string, docId: string): string {
  try {
    return readRegularFile(vaultRoot, docId, MAX_SOURCE_BYTES).hash;
  } catch {
    return 'unavailable';
  }
}

function flattenStoryPoints(project: Project): StoryPoint[] {
  const tree = buildChapterTree(project.vaultRoot, project.config);
  const points: StoryPoint[] = [];
  const visit = (node: typeof tree.root): void => {
    for (const chapter of node.chapters) {
      points.push({
        docId: chapter.docId,
        order: points.length,
        label: chapter.title,
        chapterNo: chapter.chapterNo,
      });
    }
    for (const child of node.children) visit(child);
  };
  visit(tree.root);
  return points;
}

function sourceConfigFile(project: Project, sourceId: string): string | null {
  return project.config.sidebarSources.find((source) => source.id === sourceId)?.file ?? null;
}

function prepareInputs(project: Project): GraphInputs {
  const config = graphConfig(project);
  const relations = readRegularFile(project.vaultRoot, config.relationsFile, MAX_GRAPH_BYTES);
  const storyPoints = flattenStoryPoints(project);
  const configuredFiles = new Set<string>([config.relationsFile]);
  const stopFile = sourceConfigFile(project, config.stopSourceId);
  if (stopFile) configuredFiles.add(stopFile);
  for (const source of config.typeSources ?? []) {
    const file = sourceConfigFile(project, source.sourceId);
    if (file) configuredFiles.add(file);
  }
  const sourceHashes = [...configuredFiles].sort().map((docId) => [
    docId,
    docId === config.relationsFile ? relations.hash : tryDependencyHash(project.vaultRoot, docId),
  ]);
  return {
    config,
    relationsMarkdown: relations.content,
    storyPoints,
    baseFingerprint: stableHash({ config, storyPoints, sourceHashes }),
  };
}

function dependencyMap(project: Project, docIds: Iterable<string>): Map<string, string> {
  return new Map([...new Set(docIds)].sort().map((docId) => [
    docId,
    tryDependencyHash(project.vaultRoot, docId),
  ]));
}

function sameDependencies(project: Project, dependencies: Map<string, string>): boolean {
  for (const [docId, expected] of dependencies) {
    if (tryDependencyHash(project.vaultRoot, docId) !== expected) return false;
  }
  return true;
}

function addDiagnostic(
  diagnostics: ParserDiagnostic[],
  code: string,
  severity: ParserDiagnostic['severity'],
  message: string,
  location?: Partial<ParserLocation> & {
    entityKind?: ParserDiagnostic['entityKind'];
    entityId?: string | null;
  },
): void {
  diagnostics.push({
    code,
    severity,
    entityKind: location?.entityKind ?? 'graph',
    entityId: location?.entityId ?? null,
    file: location?.file ?? '',
    line: location?.line ?? null,
    tableRow: location?.tableRow ?? null,
    message,
  });
}

function parserLocation(
  entity: { id: string; location: ParserLocation },
  entityKind: NonNullable<ParserDiagnostic['entityKind']>,
): Partial<ParserLocation> & { entityKind: ParserDiagnostic['entityKind']; entityId: string } {
  return { ...entity.location, entityKind, entityId: entity.id };
}

function chapterTarget(raw: string): string {
  const wiki = /^\[\[([^\]]+)\]\]$/.exec(raw.trim());
  const target = (wiki?.[1] ?? raw).split('|', 1)[0] ?? '';
  return (target.split('#', 1)[0] ?? '').trim();
}

function storyPointByDocId(storyPoints: StoryPoint[], rawTarget: string): StoryPoint | null {
  const target = rawTarget.replace(/^\.\//, '');
  const candidates = target.endsWith('.md') ? [target] : [target, `${target}.md`];
  for (const candidate of candidates) {
    const match = storyPoints.find((point) => point.docId === candidate);
    if (match) return match;
  }
  return null;
}

function resolveStoryTime(
  rawValue: string,
  storyPoints: StoryPoint[],
  project: Project,
  diagnostics: ParserDiagnostic[],
  location: Partial<ParserLocation> & {
    entityKind?: ParserDiagnostic['entityKind'];
    entityId?: string | null;
  },
  field: string,
): ResolvedTime {
  const raw = normalize(rawValue);
  if (!raw) return { value: null, valid: true };
  if (raw === '@start') return { value: '@start', valid: true };
  const target = chapterTarget(raw);
  const exact = storyPointByDocId(storyPoints, target);
  if (exact) return { value: exact, valid: true };
  const numeric = /^(?:第)?(\d+)(?:章)?$/u.exec(target);
  if (numeric && project.config.contentTree.leaf.numberingScope === 'book') {
    const chapterNo = Number(numeric[1]);
    const matches = storyPoints.filter((point) => point.chapterNo === chapterNo);
    if (matches.length === 1) return { value: matches[0]!, valid: true };
  }
  addDiagnostic(
    diagnostics,
    'INVALID_STORY_POINT',
    'error',
    `${field} does not resolve to a unique chapter`,
    location,
  );
  return { value: null, valid: false };
}

function storyOrder(value: GraphStoryTime): number | null {
  if (value === '@start') return -1;
  return value?.order ?? null;
}

function invalidInterval(activeFrom: GraphStoryTime, inactiveFrom: GraphStoryTime): boolean {
  const active = storyOrder(activeFrom);
  const inactive = storyOrder(inactiveFrom);
  return active !== null && inactive !== null && inactive <= active;
}

function sourceDocIdCandidates(rawTarget: string): string[] {
  const target = rawTarget.replace(/^\.\//, '').trim();
  if (!graphDocIdSchema.safeParse(target).success) return [];
  return target.endsWith('.md') ? [target] : [target, `${target}.md`];
}

function resolveSourceDocId(vaultRoot: string, rawTarget: string): string | null {
  for (const candidate of sourceDocIdCandidates(rawTarget)) {
    try {
      const path = resolveDocPath(vaultRoot, candidate);
      if (!existsSync(path)) continue;
      const physicalDocId = relative(realpathSync.native(vaultRoot), realpathSync.native(path))
        .split(sep)
        .join('/');
      if (graphDocIdSchema.safeParse(physicalDocId).success) return physicalDocId;
    } catch {
      // Try the remaining exact spelling; never fall back to basename search.
    }
  }
  return null;
}

function unresolvedSourceDependency(vaultRoot: string, rawTarget: string): string | null {
  const candidates = sourceDocIdCandidates(rawTarget);
  const candidate = candidates.at(-1);
  if (!candidate) return null;
  try {
    resolveDocPath(vaultRoot, candidate);
    return candidate;
  } catch {
    return null;
  }
}

function parseSourceRefs(
  project: Project,
  rawSources: string,
  diagnostics: ParserDiagnostic[],
  location: Partial<ParserLocation> & {
    entityKind?: ParserDiagnostic['entityKind'];
    entityId?: string | null;
  },
  dependencies: Set<string>,
): GraphSourceRef[] {
  const refs: GraphSourceRef[] = [];
  const seen = new Set<string>();
  if (!rawSources.trim()) return refs;
  for (const rawRef of rawSources.split(/[;；]/u).map((part) => part.trim()).filter(Boolean)) {
    const match = /^\[\[([^\]]+)\]\]$/.exec(rawRef);
    if (!match?.[1]) {
      addDiagnostic(diagnostics, 'INVALID_SOURCE_REF', 'warning', 'source must be an exact Obsidian wikilink', location);
      continue;
    }
    const [destination = '', labelPart] = match[1].split('|', 2);
    const hashIndex = destination.indexOf('#');
    const rawDocId = hashIndex >= 0 ? destination.slice(0, hashIndex) : destination;
    const heading = hashIndex >= 0 ? normalize(destination.slice(hashIndex + 1)) : null;
    if (hashIndex >= 0 && !heading) {
      addDiagnostic(diagnostics, 'INVALID_SOURCE_REF', 'warning', 'source heading fragment cannot be empty', location);
      continue;
    }
    if (sourceDocIdCandidates(rawDocId).length === 0) {
      addDiagnostic(
        diagnostics,
        'INVALID_SOURCE_REF',
        'warning',
        'source document must use a canonical vault-relative POSIX docId',
        location,
      );
      continue;
    }
    const unresolvedDependency = unresolvedSourceDependency(project.vaultRoot, rawDocId);
    if (unresolvedDependency) dependencies.add(unresolvedDependency);
    const docId = resolveSourceDocId(project.vaultRoot, rawDocId);
    if (!docId) {
      addDiagnostic(diagnostics, 'SOURCE_NOT_FOUND', 'warning', 'source document does not exist', location);
      continue;
    }
    dependencies.add(docId);
    let markdown: string;
    try {
      markdown = readRegularFile(project.vaultRoot, docId, MAX_SOURCE_BYTES).content;
    } catch {
      addDiagnostic(diagnostics, 'SOURCE_UNAVAILABLE', 'warning', 'source document is unavailable', location);
      continue;
    }
    if (heading) {
      const count = markdownHeadings(markdown).filter((candidate) => candidate.text === heading).length;
      if (count === 0) {
        addDiagnostic(diagnostics, 'SOURCE_HEADING_NOT_FOUND', 'warning', 'source heading does not exist', location);
        continue;
      }
      if (count > 1) {
        addDiagnostic(diagnostics, 'SOURCE_HEADING_AMBIGUOUS', 'warning', 'source heading is duplicated', location);
        continue;
      }
    }
    const ref: GraphSourceRef = {
      docId,
      heading,
      label: normalize(labelPart ?? '') || heading || basename(docId, '.md'),
    };
    const key = `${ref.docId}\u0000${ref.heading ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function visualFamily(
  raw: string,
  fallback: GraphVisualFamily,
  diagnostics: ParserDiagnostic[],
  entityKind: 'nodeType' | 'relationType',
  entityId: string,
  file: string,
): GraphVisualFamily {
  if (VISUAL_FAMILIES.has(raw as GraphVisualFamily)) return raw as GraphVisualFamily;
  addDiagnostic(diagnostics, 'UNKNOWN_VISUAL_FAMILY', 'warning', 'unknown visual family uses a safe fallback', {
    entityKind, entityId, file,
  });
  return fallback;
}

function derivedNodeId(sourceId: string, name: string): string {
  return `derived:${createHash('sha256').update(`${sourceId}\u0000${graphNameKey(name)}`).digest('hex').slice(0, 16)}`;
}

function longestSectionType(
  section: string,
  mapping: Record<string, string> | undefined,
): { typeId: string | null; conflicting: boolean } {
  if (!mapping) return { typeId: null, conflicting: false };
  const normalizedSection = normalize(section);
  const matches = Object.entries(mapping)
    .map(([prefix, typeId]) => ({ prefix: normalize(prefix), typeId }))
    .filter(({ prefix }) => normalizedSection === prefix || normalizedSection.startsWith(`${prefix} >`))
    .sort((left, right) => right.prefix.length - left.prefix.length || left.prefix.localeCompare(right.prefix));
  const longest = matches[0];
  if (!longest) return { typeId: null, conflicting: false };
  const conflicting = matches.some((candidate) =>
    candidate.prefix.length === longest.prefix.length && candidate.typeId !== longest.typeId,
  );
  return { typeId: conflicting ? null : longest.typeId, conflicting };
}

function derivedNodes(
  project: Project,
  config: GraphConfig,
  sidebar: SidebarService,
  explicitNodes: ParsedNode[],
  diagnostics: ParserDiagnostic[],
): ParsedNode[] {
  const result: ParsedNode[] = [];
  const claimedNames = new Set(explicitNodes.flatMap((node) => [node.name, ...node.aliases]).map(graphNameKey));
  for (const typeSource of config.typeSources ?? []) {
    const source = project.config.sidebarSources.find((candidate) => candidate.id === typeSource.sourceId);
    if (!source) continue;
    const location: ParserLocation = { file: source.file, line: null, tableRow: null };
    let payload: ReturnType<SidebarService['getSource']>;
    try {
      payload = sidebar.getSource(project, typeSource.sourceId, 'planner');
    } catch {
      addDiagnostic(diagnostics, 'TYPE_SOURCE_UNAVAILABLE', 'warning', 'configured type source is unavailable', {
        ...location, entityKind: 'graph', entityId: null,
      });
      continue;
    }
    if (!payload) continue;
    const candidates: Array<{ name: string; aliases: string[]; typeId: string; sources: string }> = [];
    if (payload.parser === 'markdown-table') {
      for (const entry of payload.entries) {
        const sectionType = longestSectionType(entry.section, typeSource.sectionTypeIds);
        if (sectionType.conflicting) {
          addDiagnostic(diagnostics, 'TYPE_SOURCE_CONFLICT', 'warning', 'equally specific section type mappings conflict', {
            ...location, entityKind: 'node', entityId: null,
          });
        }
        const typeId = sectionType.typeId
          ?? typeSource.defaultTypeId
          ?? 'unknown';
        candidates.push({
          name: entry.term,
          aliases: [],
          typeId,
          sources: entry.source.includes('[[') ? entry.source : '',
        });
      }
    } else if (payload.parser === 'heading-sections' && payload.kind === 'characters') {
      for (const card of payload.data) {
        candidates.push({
          name: card.name,
          aliases: [],
          typeId: typeSource.defaultTypeId ?? 'character',
          sources: `[[${source.file}#${card.name}]]`,
        });
      }
    } else if (payload.parser === 'heading-sections' && payload.kind === 'foreshadowing') {
      const headingsById = new Map<string, string>();
      if (
        source.parser === 'heading-sections'
        && source.parserConfig.kind === 'foreshadowing'
      ) {
        try {
          const markdown = readRegularFile(project.vaultRoot, source.file, MAX_SOURCE_BYTES).content;
          for (const heading of markdownHeadings(markdown)) {
            if (heading.depth !== source.parserConfig.itemHeadingLevel) continue;
            const match = new RegExp(source.parserConfig.itemIdRegex).exec(heading.text);
            if (match?.[1]) headingsById.set(normalize(match[1]), heading.text);
          }
        } catch {
          // The sidebar payload already exists, so keep the derived node but
          // omit an imprecise whole-file source link.
        }
      }
      for (const item of payload.data) {
        const sourceHeading = headingsById.get(normalize(item.id));
        candidates.push({
          name: item.title || item.id,
          aliases: item.title ? [item.id] : [],
          typeId: typeSource.defaultTypeId ?? 'foreshadow',
          sources: sourceHeading ? `[[${source.file}#${sourceHeading}]]` : '',
        });
      }
    }
    for (const candidate of candidates) {
      const name = normalize(candidate.name);
      if (!name) continue;
      const key = graphNameKey(name);
      if (claimedNames.has(key)) {
        if (!explicitNodes.some((node) => [node.name, ...node.aliases].some((value) => graphNameKey(value) === key))) {
          addDiagnostic(diagnostics, 'TYPE_SOURCE_CONFLICT', 'warning', 'later type source entry was ignored', {
            ...location, entityKind: 'node', entityId: null,
          });
        }
        continue;
      }
      claimedNames.add(key);
      result.push({
        id: derivedNodeId(typeSource.sourceId, name),
        name,
        aliases: candidate.aliases,
        typeId: candidate.typeId,
        activeFrom: '',
        revealedAt: '',
        inactiveFrom: '',
        visibility: 'authorOnly',
        confidence: 'confirmed',
        sources: candidate.sources,
        origin: 'derived',
        location,
      });
    }
  }
  return result;
}

function withoutFencedCode(markdown: string): string {
  let fence: { marker: '`' | '~'; length: number } | null = null;
  return markdown.split(/\r?\n/u).map((line) => {
    if (fence) {
      const candidate = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1];
      if (
        candidate
        && candidate[0] === fence.marker
        && candidate.length >= fence.length
      ) {
        fence = null;
      }
      return '';
    }
    const candidate = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (candidate) {
      fence = {
        marker: candidate[0] as '`' | '~',
        length: candidate.length,
      };
      return '';
    }
    return line;
  }).join('\n');
}

function markdownSectionBody(markdown: string, headingName: string): string {
  const headings = markdownHeadings(markdown);
  const start = headings.find((heading) =>
    heading.depth === 2
    && (
      heading.text === headingName
      || heading.text.startsWith(`${headingName}（`)
      || heading.text.startsWith(`${headingName} (`)
    ),
  );
  if (!start) return '';
  const end = headings.find((heading) =>
    heading.lineIndex > start.lineIndex && heading.depth <= start.depth,
  );
  return markdown
    .split(/\r?\n/u)
    .slice(start.lineIndex + 1, end?.lineIndex)
    .join('\n');
}

function resolveStopPoint(
  project: Project,
  config: GraphConfig,
  sidebar: SidebarService,
  storyPoints: StoryPoint[],
  diagnostics: ParserDiagnostic[],
  strict: boolean,
): Pick<BuiltPlannerGraph, 'stopPoint' | 'stopState'> {
  const source = project.config.sidebarSources.find((candidate) => candidate.id === config.stopSourceId);
  let payload: ReturnType<SidebarService['getSource']>;
  try {
    payload = sidebar.getSource(project, config.stopSourceId, 'planner');
  } catch {
    payload = undefined;
  }
  const fail = (message: string): Pick<BuiltPlannerGraph, 'stopPoint' | 'stopState'> => {
    if (strict) throw new StudioError('GRAPH_STOP_POINT_INVALID', message);
    addDiagnostic(diagnostics, 'GRAPH_STOP_POINT_INVALID', 'error', message, {
      file: source?.file ?? config.relationsFile,
    });
    return { stopPoint: null, stopState: 'resolved' };
  };
  if (
    !source
    || source.parser !== 'heading-sections'
    || source.parserConfig.kind !== 'writingStatus'
    || !payload
    || payload.parser !== 'heading-sections'
    || payload.kind !== 'writingStatus'
  ) {
    return fail('graph stop source is unavailable or has the wrong parser kind');
  }
  let stopMarkdown: string;
  try {
    stopMarkdown = readRegularFile(project.vaultRoot, source.file, MAX_SOURCE_BYTES).content;
  } catch {
    return fail('graph stop source is unavailable');
  }
  const safeStopMarkdown = withoutFencedCode(stopMarkdown);
  let numericStopMatches = 0;
  try {
    numericStopMatches = [...safeStopMarkdown.matchAll(
      new RegExp(source.parserConfig.stopChapterRegex, 'gm'),
    )].length;
  } catch {
    return fail('graph stop source pattern is invalid');
  }
  if (numericStopMatches > 1) {
    return fail('graph stop source contains multiple numeric stop references');
  }

  // A precise wikilink in the stop-point body wins. This gives per-level
  // projects a non-ambiguous path while retaining the existing numeric field
  // for book-wide numbering.
  const stopHeading = normalize(
    source.parserConfig.sectionHeadings?.stopPoint
      ?? writingStatusHeadings(project.config.localePreset).stopPoint,
  );
  const rawStopBody = markdownSectionBody(stopMarkdown, stopHeading);
  const exactRefs = markdownSectionBody(safeStopMarkdown, stopHeading).match(/\[\[[^\]]+\]\]/g) ?? [];
  if (exactRefs.length > 1) {
    return fail('graph stop source contains multiple chapter references');
  }
  const exactRef = exactRefs[0];
  if (exactRef) {
    const resolved = resolveStoryTime(
      exactRef,
      storyPoints,
      project,
      [],
      { file: source.file },
      'stopPoint',
    );
    if (resolved.valid && resolved.value !== null && resolved.value !== '@start') {
      return { stopPoint: resolved.value, stopState: 'resolved' };
    }
    return fail('graph stop source does not resolve to a unique chapter document');
  }

  const stopChapter = payload.data.stopChapter;
  // "Unset" is deliberately narrower than "unresolved": only an absent or
  // whitespace-only raw section body plus no numeric stop marker qualifies.
  // Comments, fenced code, and any other visible text remain fail-closed.
  if (stopChapter === null && rawStopBody.trim().length === 0) {
    addDiagnostic(
      diagnostics,
      'STOP_POINT_UNSET',
      'warning',
      'graph stop point has not been set',
      { file: source.file },
    );
    return { stopPoint: null, stopState: 'unset' };
  }
  if (
    stopChapter === null
    || project.config.contentTree.leaf.numberingScope !== 'book'
  ) {
    return fail('graph stop source must identify an exact chapter');
  }
  const matches = storyPoints.filter((point) => point.chapterNo === stopChapter);
  if (matches.length !== 1) return fail('graph stop source does not resolve to a unique chapter');
  return { stopPoint: matches[0]!, stopState: 'resolved' };
}

function buildPlannerGraph(
  project: Project,
  inputs: GraphInputs,
  sidebar: SidebarService,
  strictStop: boolean,
): BuiltPlannerGraph {
  const parsed = parseGraphMarkdown(
    inputs.config.relationsFile,
    inputs.relationsMarkdown,
    inputs.config.aliases as GraphAliases | undefined,
  );
  const diagnostics = parsed.diagnostics;
  const dependencies = new Set<string>();
  const writerBlockedNodeIds = new Set<string>();
  const writerBlockedEdgeIds = new Set<string>();

  const parsedNodes = [
    ...parsed.nodes,
    ...derivedNodes(project, inputs.config, sidebar, parsed.nodes, diagnostics),
  ];

  const nodeTypes = new Map<string, NodeTypeDefinition>();
  for (const definition of parsed.nodeTypes) {
    nodeTypes.set(definition.id, {
      id: definition.id,
      name: definition.name,
      visualFamily: visualFamily(
        definition.visualFamily,
        'unknown',
        diagnostics,
        'nodeType',
        definition.id,
        inputs.config.relationsFile,
      ),
    });
  }
  const relationTypes = new Map<string, RelationTypeDefinition>();
  for (const definition of parsed.relationTypes) {
    relationTypes.set(definition.id, {
      id: definition.id,
      name: definition.name,
      visualFamily: visualFamily(
        definition.visualFamily,
        'custom',
        diagnostics,
        'relationType',
        definition.id,
        inputs.config.relationsFile,
      ),
      directed: definition.directed,
      reverseName: definition.reverseName,
    });
  }

  const nodes = new Map<string, WorldNode>();
  for (const node of parsedNodes) {
    if (nodes.has(node.id)) {
      addDiagnostic(diagnostics, 'DUPLICATE_ID', 'error', `duplicate node ID: ${node.id}`, parserLocation(node, 'node'));
      continue;
    }
    if (!nodeTypes.has(node.typeId)) {
      nodeTypes.set(node.typeId, {
        id: node.typeId,
        name: node.typeId,
        visualFamily: 'unknown',
      });
      addDiagnostic(diagnostics, 'UNDECLARED_NODE_TYPE', 'warning', 'undeclared node type uses unknown visual family', parserLocation(node, 'node'));
    }
    const activeFrom = resolveStoryTime(
      node.activeFrom,
      inputs.storyPoints,
      project,
      diagnostics,
      parserLocation(node, 'node'),
      'activeFrom',
    );
    const revealedAt = resolveStoryTime(
      node.revealedAt,
      inputs.storyPoints,
      project,
      diagnostics,
      parserLocation(node, 'node'),
      'revealedAt',
    );
    const inactiveFrom = resolveStoryTime(
      node.inactiveFrom,
      inputs.storyPoints,
      project,
      diagnostics,
      parserLocation(node, 'node'),
      'inactiveFrom',
    );
    if (!inactiveFrom.valid) writerBlockedNodeIds.add(node.id);
    if (invalidInterval(activeFrom.value, inactiveFrom.value)) {
      addDiagnostic(diagnostics, 'INVERTED_TIME_INTERVAL', 'error', 'inactiveFrom must be after activeFrom', parserLocation(node, 'node'));
      continue;
    }
    nodes.set(node.id, {
      id: node.id,
      name: node.name,
      aliases: [...new Set(node.aliases)].sort(),
      typeId: node.typeId,
      activeFrom: activeFrom.value,
      revealedAt: revealedAt.value,
      inactiveFrom: inactiveFrom.value,
      visibility: node.visibility as GraphVisibility,
      confidence: node.confidence as GraphConfidence,
      sources: parseSourceRefs(
        project,
        node.sources,
        diagnostics,
        parserLocation(node, 'node'),
        dependencies,
      ),
      implicit: node.origin === 'implicit',
    });
  }

  const nameIndex = new Map<string, string[]>();
  for (const node of nodes.values()) {
    for (const name of [node.name, ...node.aliases]) {
      const key = graphNameKey(name);
      const ids = nameIndex.get(key) ?? [];
      if (!ids.includes(node.id)) ids.push(node.id);
      nameIndex.set(key, ids);
    }
  }
  for (const [key, ids] of nameIndex) {
    if (ids.length > 1) {
      addDiagnostic(diagnostics, 'AMBIGUOUS_NAME', 'warning', 'name or alias resolves to multiple nodes', {
        file: inputs.config.relationsFile,
        entityKind: 'graph',
        entityId: key,
      });
    }
  }

  const implicitByKey = new Map<string, string>();
  const resolveEndpoint = (raw: string, edge: ParsedEdge): string | null => {
    const normalized = normalize(raw);
    const explicitId = normalized.startsWith('@') ? normalized.slice(1) : null;
    if (explicitId !== null && nodes.has(explicitId)) return explicitId;
    const ids = new Set<string>();
    if (explicitId === null) {
      if (nodes.has(normalized)) ids.add(normalized);
      for (const id of nameIndex.get(graphNameKey(normalized)) ?? []) ids.add(id);
    }
    if (ids.size === 1) return [...ids][0]!;
    if (ids.size > 1) {
      addDiagnostic(diagnostics, 'AMBIGUOUS_ENDPOINT', 'error', 'relation endpoint name is ambiguous', parserLocation(edge, 'edge'));
      return null;
    }
    const displayName = explicitId || normalized;
    const key = graphNameKey(displayName);
    const existing = implicitByKey.get(key);
    if (existing) return existing;
    const id = implicitNodeId(displayName);
    if (nodes.has(id)) {
      addDiagnostic(diagnostics, 'DUPLICATE_ID', 'error', 'implicit node ID collides with an existing node', parserLocation(edge, 'edge'));
      return null;
    }
    implicitByKey.set(key, id);
    if (!nodeTypes.has('unknown')) {
      nodeTypes.set('unknown', { id: 'unknown', name: 'Unknown', visualFamily: 'unknown' });
    }
    nodes.set(id, {
      id,
      name: displayName,
      aliases: [],
      typeId: 'unknown',
      activeFrom: null,
      revealedAt: null,
      inactiveFrom: null,
      visibility: 'public',
      confidence: 'question',
      sources: [],
      implicit: true,
    });
    nameIndex.set(key, [id]);
    addDiagnostic(diagnostics, 'IMPLICIT_NODE', 'warning', 'relation endpoint created an implicit node', parserLocation(edge, 'edge'));
    return id;
  };

  const edges: WorldEdge[] = [];
  for (const edge of parsed.edges) {
    const sourceId = resolveEndpoint(edge.source, edge);
    const targetId = resolveEndpoint(edge.target, edge);
    if (!sourceId || !targetId) continue;
    if (!relationTypes.has(edge.relationTypeId)) {
      relationTypes.set(edge.relationTypeId, {
        id: edge.relationTypeId,
        name: edge.relationTypeId,
        visualFamily: 'custom',
        directed: true,
        reverseName: null,
      });
      addDiagnostic(diagnostics, 'UNDECLARED_RELATION_TYPE', 'warning', 'undeclared relation type defaults to directed custom', parserLocation(edge, 'edge'));
    }
    const activeFrom = resolveStoryTime(
      edge.activeFrom,
      inputs.storyPoints,
      project,
      diagnostics,
      parserLocation(edge, 'edge'),
      'activeFrom',
    );
    const revealedAt = resolveStoryTime(
      edge.revealedAt,
      inputs.storyPoints,
      project,
      diagnostics,
      parserLocation(edge, 'edge'),
      'revealedAt',
    );
    const inactiveFrom = resolveStoryTime(
      edge.inactiveFrom,
      inputs.storyPoints,
      project,
      diagnostics,
      parserLocation(edge, 'edge'),
      'inactiveFrom',
    );
    if (!inactiveFrom.valid) writerBlockedEdgeIds.add(edge.id);
    if (invalidInterval(activeFrom.value, inactiveFrom.value)) {
      addDiagnostic(diagnostics, 'INVERTED_TIME_INTERVAL', 'error', 'inactiveFrom must be after activeFrom', parserLocation(edge, 'edge'));
      continue;
    }
    edges.push({
      id: edge.id,
      sourceId,
      relationTypeId: edge.relationTypeId,
      targetId,
      activeFrom: activeFrom.value,
      revealedAt: revealedAt.value,
      inactiveFrom: inactiveFrom.value,
      visibility: edge.visibility as GraphVisibility,
      confidence: edge.confidence as GraphConfidence,
      sources: parseSourceRefs(
        project,
        edge.sources,
        diagnostics,
        parserLocation(edge, 'edge'),
        dependencies,
      ),
    });
  }

  const incident = new Set(edges.flatMap((edge) => [edge.sourceId, edge.targetId]));
  for (const node of nodes.values()) {
    if (!incident.has(node.id)) {
      addDiagnostic(diagnostics, 'ISOLATED_NODE', 'warning', 'node has no relations', {
        file: inputs.config.relationsFile,
        entityKind: 'node',
        entityId: node.id,
      });
    }
  }

  if (nodes.size > MAX_NODES || edges.length > MAX_EDGES) {
    throw new StudioError('GRAPH_TOO_LARGE', 'world graph exceeds the server safety limit');
  }

  const stop = resolveStopPoint(
    project,
    inputs.config,
    sidebar,
    inputs.storyPoints,
    diagnostics,
    strictStop,
  );
  return {
    ...stop,
    storyPoints: inputs.storyPoints,
    nodeTypes: [...nodeTypes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    relationTypes: [...relationTypes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: edges.sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics,
    dependencies,
    writerBlockedNodeIds,
    writerBlockedEdgeIds,
  };
}

function isKnownAt(time: GraphStoryTime, stopOrder: number): boolean {
  if (time === '@start') return true;
  return time !== null && time.order <= stopOrder;
}

function isActiveAt(
  activeFrom: GraphStoryTime,
  inactiveFrom: GraphStoryTime,
  stopOrder: number,
): boolean {
  if (!isKnownAt(activeFrom, stopOrder)) return false;
  if (inactiveFrom === null) return true;
  if (inactiveFrom === '@start') return false;
  return inactiveFrom.order > stopOrder;
}

function writerNodeAllowed(node: WorldNode, stopOrder: number): boolean {
  return (
    !node.implicit
    && node.visibility === 'public'
    && node.confidence === 'confirmed'
    && isKnownAt(node.revealedAt, stopOrder)
    && isActiveAt(node.activeFrom, node.inactiveFrom, stopOrder)
  );
}

function writerEdgeAllowed(edge: WorldEdge, stopOrder: number): boolean {
  return (
    edge.visibility === 'public'
    && edge.confidence === 'confirmed'
    && isKnownAt(edge.revealedAt, stopOrder)
    && isActiveAt(edge.activeFrom, edge.inactiveFrom, stopOrder)
  );
}

function writerSources(
  project: Project,
  refs: GraphSourceRef[],
  storyPoints: StoryPoint[],
  stopOrder: number,
): GraphSourceRef[] {
  const chapterOrders = new Map(storyPoints.map((point) => [point.docId, point.order]));
  return refs.filter((ref) => {
    const chapterOrder = chapterOrders.get(ref.docId);
    return (
      isProfileReadablePath(project, 'writer', ref.docId)
      && (chapterOrder === undefined || chapterOrder <= stopOrder)
    );
  });
}

function projectWriter(project: Project, planner: BuiltPlannerGraph): BuiltPlannerGraph {
  if (planner.stopState === 'unset') {
    // With no explicit stop point, even projecting entities revealed at
    // `@start` would loosen the spoiler boundary. The empty set is the only
    // zero-leakage writer projection; stopState carries the empty-state meaning
    // without opening the planner-diagnostic channel.
    return {
      stopPoint: null,
      stopState: 'unset',
      storyPoints: [],
      nodeTypes: [],
      relationTypes: [],
      nodes: [],
      edges: [],
      diagnostics: [],
      dependencies: planner.dependencies,
      writerBlockedNodeIds: new Set(),
      writerBlockedEdgeIds: new Set(),
    };
  }
  const stopPoint = planner.stopPoint;
  if (!stopPoint) throw new StudioError('GRAPH_STOP_POINT_INVALID', 'graph stop source is invalid');
  const allowedNodes = new Map(
    planner.nodes
      .filter((node) =>
        !planner.writerBlockedNodeIds.has(node.id)
        && writerNodeAllowed(node, stopPoint.order),
      )
      .map((node) => [node.id, {
        ...node,
        inactiveFrom: node.inactiveFrom !== null
          && node.inactiveFrom !== '@start'
          && node.inactiveFrom.order > stopPoint.order
          ? null
          : node.inactiveFrom,
        sources: writerSources(project, node.sources, planner.storyPoints, stopPoint.order),
      }]),
  );
  const edges = planner.edges
    .filter((edge) =>
      !planner.writerBlockedEdgeIds.has(edge.id)
      && writerEdgeAllowed(edge, stopPoint.order)
      && allowedNodes.has(edge.sourceId)
      && allowedNodes.has(edge.targetId),
    )
    .map((edge) => ({
      ...edge,
      inactiveFrom: edge.inactiveFrom !== null
        && edge.inactiveFrom !== '@start'
        && edge.inactiveFrom.order > stopPoint.order
        ? null
        : edge.inactiveFrom,
      sources: writerSources(project, edge.sources, planner.storyPoints, stopPoint.order),
    }));

  const usedNodeTypes = new Set([...allowedNodes.values()].map((node) => node.typeId));
  const usedRelationTypes = new Set(edges.map((edge) => edge.relationTypeId));
  return {
    stopPoint,
    stopState: 'resolved',
    storyPoints: planner.storyPoints.filter((point) => point.order <= stopPoint.order),
    nodeTypes: planner.nodeTypes.filter((definition) => usedNodeTypes.has(definition.id)),
    relationTypes: planner.relationTypes.filter((definition) => usedRelationTypes.has(definition.id)),
    nodes: [...allowedNodes.values()],
    edges,
    diagnostics: [],
    dependencies: planner.dependencies,
    writerBlockedNodeIds: new Set(),
    writerBlockedEdgeIds: new Set(),
  };
}

function snapshot(view: GraphView, graph: BuiltPlannerGraph): WorldGraphSnapshot {
  const diagnosticCode = (code: string): GraphDiagnosticCode => {
    switch (code) {
      case 'MISSING_COLUMNS':
      case 'MISSING_RELATIONS_SECTION':
        return 'MISSING_COLUMN';
      case 'DUPLICATE_ID':
        return 'DUPLICATE_ID';
      case 'AMBIGUOUS_NAME':
      case 'AMBIGUOUS_ENDPOINT':
        return 'AMBIGUOUS_NAME';
      case 'UNDECLARED_NODE_TYPE':
      case 'UNDECLARED_RELATION_TYPE':
        return 'UNDECLARED_TYPE';
      case 'IMPLICIT_NODE':
        return 'IMPLICIT_NODE';
      case 'ISOLATED_NODE':
        return 'ORPHAN_NODE';
      case 'INVALID_STORY_POINT':
      case 'GRAPH_STOP_POINT_INVALID':
        return 'INVALID_STORY_POINT';
      case 'STOP_POINT_UNSET':
        return 'STOP_POINT_UNSET';
      case 'INVERTED_TIME_INTERVAL':
        return 'INVERTED_TIME_RANGE';
      case 'SOURCE_HEADING_NOT_FOUND':
        return 'SOURCE_HEADING_NOT_FOUND';
      case 'SOURCE_HEADING_AMBIGUOUS':
        return 'SOURCE_HEADING_AMBIGUOUS';
      case 'INVALID_SAFETY_FIELDS':
        return 'MISSING_SAFETY_FIELD';
      case 'SOURCE_NOT_FOUND':
      case 'SOURCE_UNAVAILABLE':
      case 'INVALID_SOURCE_REF':
        return 'SOURCE_NOT_FOUND';
      default:
        return 'INVALID_VALUE';
    }
  };
  const diagnosticEntityKind = (kind: ParserDiagnostic['entityKind']): GraphDiagnosticEntityKind =>
    kind ?? 'graph';
  const validEntityId = (id: string | null): string | null =>
    id && id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id) ? id : null;
  const diagnosticPriority = (diagnostic: ParserDiagnostic): number => {
    if (
      diagnostic.code === 'GRAPH_STOP_POINT_INVALID'
      || diagnostic.code === 'INVALID_SAFETY_FIELDS'
    ) return 0;
    if (diagnostic.severity === 'error') return 1;
    if (diagnostic.code !== 'ISOLATED_NODE') return 2;
    return 3;
  };
  const diagnostics = view === 'planner'
    ? graph.diagnostics
      .map((diagnostic, index) => ({ diagnostic, index }))
      .sort((left, right) =>
        diagnosticPriority(left.diagnostic) - diagnosticPriority(right.diagnostic)
        || left.index - right.index,
      )
      .slice(0, MAX_DIAGNOSTICS)
      .map(({ diagnostic }) => ({
        code: diagnosticCode(diagnostic.code),
        severity: diagnostic.severity,
        entityKind: diagnosticEntityKind(diagnostic.entityKind),
        entityId: validEntityId(diagnostic.entityId),
        file: diagnostic.file,
        line: diagnostic.line,
        tableRow: diagnostic.tableRow,
        message: diagnostic.message,
      }))
    : [];
  const core = {
    view,
    stopState: graph.stopState,
    stopPoint: graph.stopPoint,
    storyPoints: graph.storyPoints,
    nodeTypes: graph.nodeTypes,
    relationTypes: graph.relationTypes,
    nodes: graph.nodes,
    edges: graph.edges,
    counts: {
      nodeTypes: graph.nodeTypes.length,
      relationTypes: graph.relationTypes.length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
    },
    diagnostics,
    diagnosticCount: view === 'planner' ? graph.diagnostics.length : 0,
  };
  return { ...core, version: stableHash(core) };
}

function excerptForHeading(markdown: string, heading: string | null): string {
  if (!heading) return markdown;
  const matches = markdownHeadings(markdown).filter((candidate) => candidate.text === normalize(heading));
  if (matches.length === 0) throw new StudioError('NOT_FOUND', 'source heading not found');
  if (matches.length > 1) throw new StudioError('INVALID_CONFIG', 'source heading is ambiguous');
  const match = matches[0]!;
  const lines = markdown.split(/\r?\n/);
  const next = markdownHeadings(markdown).find((candidate) =>
    candidate.lineIndex > match.lineIndex && candidate.depth <= match.depth,
  );
  return lines.slice(match.lineIndex, next?.lineIndex ?? lines.length).join('\n');
}

function boundExcerpt(markdown: string): { markdown: string; truncated: boolean } {
  if (markdown.length <= MAX_EXCERPT_CHARS) return { markdown, truncated: false };
  const marker = '\n[truncated]';
  return { markdown: `${markdown.slice(0, MAX_EXCERPT_CHARS - marker.length)}${marker}`, truncated: true };
}

/** Public Interface for all graph behavior used by routes, WebSocket wiring and tests. */
export class WorldGraphModule {
  private readonly cache = new Map<GraphView, CacheEntry>();
  private watcher: FSWatcher | null = null;
  private storyWatcher: FSWatcher | null = null;
  private storyDebounce: NodeJS.Timeout | null = null;
  private recoveryPoll: NodeJS.Timeout | null = null;
  private watchedPaths = new Map<string, string>();
  private observedHashes = new Map<string, string>();
  private observedStoryFingerprint: string | null = null;

  constructor(private readonly sidebar: SidebarService) {}

  getSnapshot(project: Project, view: GraphView = 'writer'): WorldGraphSnapshot {
    const inputs = prepareInputs(project);
    const cached = this.cache.get(view);
    if (
      cached
      && cached.baseFingerprint === inputs.baseFingerprint
      && sameDependencies(project, cached.dependencies)
    ) {
      return structuredClone(cached.snapshot);
    }

    // A writer request makes stop-point validity part of the Module's
    // interface and fails closed before any partial DTO can leave the seam.
    const planner = buildPlannerGraph(project, inputs, this.sidebar, view === 'writer');
    const projected = view === 'writer' ? projectWriter(project, planner) : planner;
    const result = snapshot(view, projected);
    this.cache.set(view, {
      baseFingerprint: inputs.baseFingerprint,
      dependencies: dependencyMap(project, planner.dependencies),
      snapshot: result,
    });
    return structuredClone(result);
  }

  getSourceExcerpt(
    project: Project,
    docId: string,
    heading: string | undefined,
    view: GraphView = 'writer',
  ): GraphSourceExcerpt {
    graphConfig(project);
    const normalizedHeading = heading?.trim() || null;
    if (!graphDocIdSchema.safeParse(docId).success) {
      throw new StudioError('NOT_FOUND', 'graph source not found');
    }
    const authorized = this.getSnapshot(project, view);
    const sourceIsInProjection = [...authorized.nodes, ...authorized.edges]
      .flatMap((entity) => entity.sources)
      .some((source) => source.docId === docId && source.heading === normalizedHeading);
    if (!sourceIsInProjection || !isProfileReadablePath(project, view, docId)) {
      // NOT_FOUND deliberately avoids distinguishing a forbidden source from
      // a missing one at this read-only seam.
      throw new StudioError('NOT_FOUND', 'graph source not found');
    }
    let sourceFile: { content: string; hash: string };
    try {
      sourceFile = readRegularFile(project.vaultRoot, docId, MAX_SOURCE_BYTES);
    } catch {
      throw new StudioError('NOT_FOUND', 'graph source not found');
    }
    const selected = excerptForHeading(sourceFile.content, normalizedHeading);
    const bounded = boundExcerpt(selected);
    return {
      source: {
        docId,
        heading: normalizedHeading,
        label: normalizedHeading || basename(docId, '.md'),
      },
      markdown: bounded.markdown,
      truncated: bounded.truncated,
    };
  }

  invalidate(): void {
    this.cache.clear();
  }

  /**
   * Record a successful panel write before broadcasting graph.updated. This
   * suppresses the watcher echo while preserving SHA-based external changes.
   */
  notePanelWrite(project: Project): void {
    const config = graphConfig(project);
    const path = resolveDocPath(project.vaultRoot, config.relationsFile);
    this.observedHashes.set(path, tryDependencyHash(project.vaultRoot, config.relationsFile));
    this.invalidate();
  }

  startWatching(project: Project, onUpdated: () => void, onError?: (error: Error) => void): void {
    if (this.watcher || this.storyWatcher) throw new Error('WorldGraph watcher is already running');
    const config = graphConfig(project);
    const docIds = new Set<string>([config.relationsFile]);
    const stopFile = sourceConfigFile(project, config.stopSourceId);
    if (stopFile) docIds.add(stopFile);
    for (const typeSource of config.typeSources ?? []) {
      const file = sourceConfigFile(project, typeSource.sourceId);
      if (file) docIds.add(file);
    }
    this.watchedPaths.clear();
    this.observedHashes.clear();
    for (const docId of docIds) {
      const path = resolveDocPath(project.vaultRoot, docId);
      this.watchedPaths.set(path, docId);
      this.observedHashes.set(path, tryDependencyHash(project.vaultRoot, docId));
    }
    const watchPaths = new Set<string>();
    for (const path of this.watchedPaths.keys()) {
      watchPaths.add(path);
      watchPaths.add(dirname(path));
    }
    this.watcher = chokidar.watch([...watchPaths], {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    });
    this.watcher.on('all', (_event, changedPath) => {
      this.consumeWatchChange(project, changedPath, onUpdated, onError);
    });

    // StoryPoint identity includes chapter docId/order/label. Watch only the
    // configured manuscript tree (never the whole vault) and re-hash that
    // semantic projection after an event, so ordinary body edits and duplicate
    // filesystem events do not generate graph invalidations.
    const storyRoot = resolveDocPath(project.vaultRoot, project.config.contentTree.root);
    this.observedStoryFingerprint = stableHash(flattenStoryPoints(project));
    this.storyWatcher = chokidar.watch(storyRoot, {
      ignoreInitial: true,
      depth: project.config.contentTree.levels.length + 1,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    });
    this.storyWatcher.on('all', () => {
      if (this.storyDebounce) clearTimeout(this.storyDebounce);
      this.storyDebounce = setTimeout(() => {
        this.storyDebounce = null;
        this.consumeStoryChange(project, onUpdated, onError);
      }, 150);
      this.storyDebounce.unref?.();
    });
    this.recoveryPoll = setInterval(() => {
      for (const path of this.watchedPaths.keys()) {
        this.consumeWatchChange(project, path, onUpdated, onError);
      }
    }, RECOVERY_POLL_MS);
    this.recoveryPoll.unref?.();
  }

  async close(): Promise<void> {
    const watcher = this.watcher;
    const storyWatcher = this.storyWatcher;
    this.watcher = null;
    this.storyWatcher = null;
    if (this.recoveryPoll) clearInterval(this.recoveryPoll);
    this.recoveryPoll = null;
    if (this.storyDebounce) clearTimeout(this.storyDebounce);
    this.storyDebounce = null;
    this.watchedPaths.clear();
    this.observedHashes.clear();
    this.observedStoryFingerprint = null;
    this.invalidate();
    await Promise.allSettled([
      ...(watcher ? [watcher.close()] : []),
      ...(storyWatcher ? [storyWatcher.close()] : []),
    ]);
  }

  private consumeWatchChange(
    project: Project,
    path: string,
    onUpdated: () => void,
    onError?: (error: Error) => void,
  ): void {
    const docId = this.watchedPaths.get(path);
    if (!docId) return;
    let nextHash: string;
    try {
      nextHash = readRegularFile(project.vaultRoot, docId, MAX_SOURCE_BYTES).hash;
    } catch {
      // Preserve the prior SHA. An atomic replacement or recreated file must
      // still produce exactly one invalidation when it becomes readable.
      try {
        onError?.(new Error('world graph watcher could not read a configured source'));
      } catch {
        // Logging callbacks cannot destabilize the watcher.
      }
      return;
    }
    if (this.observedHashes.get(path) === nextHash) return;
    this.observedHashes.set(path, nextHash);
    this.invalidate();
    try {
      onUpdated();
    } catch {
      try {
        onError?.(new Error('world graph watcher callback failed'));
      } catch {
        // Ignore nested callback failure.
      }
    }
  }

  private consumeStoryChange(
    project: Project,
    onUpdated: () => void,
    onError?: (error: Error) => void,
  ): void {
    let nextFingerprint: string;
    try {
      nextFingerprint = stableHash(flattenStoryPoints(project));
    } catch {
      try {
        onError?.(new Error('world graph watcher could not read the chapter tree'));
      } catch {
        // Logging callbacks cannot destabilize the watcher.
      }
      return;
    }
    if (this.observedStoryFingerprint === nextFingerprint) return;
    this.observedStoryFingerprint = nextFingerprint;
    this.invalidate();
    try {
      onUpdated();
    } catch {
      try {
        onError?.(new Error('world graph watcher callback failed'));
      } catch {
        // Ignore nested callback failure.
      }
    }
  }
}
