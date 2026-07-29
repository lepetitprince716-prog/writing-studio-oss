import { z } from 'zod';
import type { AssertSchemaMatch, SchemaMatches } from './internal/schema-assert.js';

/** Safety projection selected at the WorldGraph interface. Omission always means writer. */
export type GraphView = 'writer' | 'planner';

export type GraphVisibility = 'public' | 'authorOnly';
export type GraphConfidence = 'confirmed' | 'inferred' | 'question';

/**
 * Visual families are deliberately finite and presentation-oriented. Semantic
 * node and relation type IDs remain project-defined strings.
 */
export type GraphVisualFamily =
  | 'character'
  | 'faction'
  | 'place'
  | 'item'
  | 'event'
  | 'skill'
  | 'species'
  | 'rule'
  | 'foreshadow'
  | 'custom'
  | 'unknown';

/** Stable manuscript order; chapterNo is display metadata and may repeat. */
export interface StoryPoint {
  docId: string;
  order: number;
  label: string;
  chapterNo: number | null;
}

/** A resolved Obsidian wikilink. `heading` and display `label` may be absent. */
export interface GraphSourceRef {
  docId: string;
  heading: string | null;
  label: string | null;
}

/** `null` means unknown; it never means the beginning of the story. */
export type GraphStoryTime = '@start' | StoryPoint | null;

export interface NodeTypeDefinition {
  id: string;
  name: string;
  visualFamily: GraphVisualFamily;
}

export interface RelationTypeDefinition {
  id: string;
  name: string;
  visualFamily: GraphVisualFamily;
  directed: boolean;
  /** Human-readable description when traversing a directed edge backwards. */
  reverseName: string | null;
}

export interface WorldNode {
  id: string;
  name: string;
  aliases: string[];
  typeId: string;
  activeFrom: GraphStoryTime;
  revealedAt: GraphStoryTime;
  /** Exclusive: the node is inactive at this point and all later points. */
  inactiveFrom: GraphStoryTime;
  visibility: GraphVisibility;
  confidence: GraphConfidence;
  sources: GraphSourceRef[];
  /** True only for a zero-match endpoint synthesized as `implicit:<hash>`. */
  implicit: boolean;
}

export interface WorldEdge {
  id: string;
  sourceId: string;
  relationTypeId: string;
  targetId: string;
  activeFrom: GraphStoryTime;
  revealedAt: GraphStoryTime;
  /** Exclusive: the relationship is inactive at this point and all later points. */
  inactiveFrom: GraphStoryTime;
  visibility: GraphVisibility;
  confidence: GraphConfidence;
  sources: GraphSourceRef[];
}

export type GraphDiagnosticCode =
  | 'MISSING_COLUMN'
  | 'INVALID_VALUE'
  | 'DUPLICATE_ID'
  | 'AMBIGUOUS_NAME'
  | 'UNDECLARED_TYPE'
  | 'IMPLICIT_NODE'
  | 'ORPHAN_NODE'
  | 'INVALID_STORY_POINT'
  | 'STOP_POINT_UNSET'
  | 'INVERTED_TIME_RANGE'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_HEADING_NOT_FOUND'
  | 'SOURCE_HEADING_AMBIGUOUS'
  | 'MISSING_SAFETY_FIELD'
  | 'GRAPH_TOO_LARGE';

export type GraphDiagnosticSeverity = 'warning' | 'error';
export type GraphDiagnosticEntityKind =
  | 'graph'
  | 'nodeType'
  | 'relationType'
  | 'node'
  | 'edge'
  | 'source';

export interface GraphDiagnostic {
  code: GraphDiagnosticCode;
  severity: GraphDiagnosticSeverity;
  entityKind: GraphDiagnosticEntityKind;
  entityId: string | null;
  /** Vault-relative source file. */
  file: string;
  /** One-based Markdown line, when the parser can identify it. */
  line: number | null;
  /** One-based data row within its Markdown table, excluding the header. */
  tableRow: number | null;
  message: string;
}

export interface WorldGraphCounts {
  nodeTypes: number;
  relationTypes: number;
  nodes: number;
  edges: number;
}

/**
 * Complete semantic snapshot for one safety projection. Layout, colors, node
 * size, sampling, and camera state are intentionally frontend-only.
 */
export interface WorldGraphSnapshot {
  view: GraphView;
  /** Stable SHA-256 of this projection, not of the planner source graph. */
  version: string;
  stopState: 'resolved' | 'unset';
  stopPoint: StoryPoint | null;
  storyPoints: StoryPoint[];
  nodeTypes: NodeTypeDefinition[];
  relationTypes: RelationTypeDefinition[];
  nodes: WorldNode[];
  edges: WorldEdge[];
  counts: WorldGraphCounts;
  /** At most 200 diagnostics from this projection. */
  diagnostics: GraphDiagnostic[];
  /** Count before the 200-item diagnostic response cap. */
  diagnosticCount: number;
}

export interface GraphQuery {
  view: GraphView;
}

export interface GraphSourceQuery {
  view: GraphView;
  heading?: string | undefined;
}

/** Bounded, read-only Markdown returned for a graph evidence link. */
export interface GraphSourceExcerpt {
  source: GraphSourceRef;
  markdown: string;
  truncated: boolean;
}

export interface GraphTypeSourceConfig {
  /** Existing ProjectConfig.sidebarSources id. */
  sourceId: string;
  /** Type assigned when no section-specific mapping matches. */
  defaultTypeId?: string | undefined;
  /** Sidebar section path prefix to semantic node type ID; longest match wins. */
  sectionTypeIds?: Record<string, string> | undefined;
}

export interface GraphSectionAliases {
  nodeTypes?: string[] | undefined;
  relationTypes?: string[] | undefined;
  nodes?: string[] | undefined;
  relations?: string[] | undefined;
}

export interface GraphNodeTypeColumnAliases {
  id?: string[] | undefined;
  name?: string[] | undefined;
  visualFamily?: string[] | undefined;
}

export interface GraphRelationTypeColumnAliases extends GraphNodeTypeColumnAliases {
  directed?: string[] | undefined;
  reverseName?: string[] | undefined;
}

export interface GraphNodeColumnAliases {
  id?: string[] | undefined;
  name?: string[] | undefined;
  aliases?: string[] | undefined;
  typeId?: string[] | undefined;
  activeFrom?: string[] | undefined;
  revealedAt?: string[] | undefined;
  inactiveFrom?: string[] | undefined;
  visibility?: string[] | undefined;
  confidence?: string[] | undefined;
  sources?: string[] | undefined;
}

export interface GraphRelationColumnAliases {
  id?: string[] | undefined;
  source?: string[] | undefined;
  relationTypeId?: string[] | undefined;
  targetId?: string[] | undefined;
  activeFrom?: string[] | undefined;
  revealedAt?: string[] | undefined;
  inactiveFrom?: string[] | undefined;
  visibility?: string[] | undefined;
  confidence?: string[] | undefined;
  sources?: string[] | undefined;
}

/** Optional additions are merged after, not instead of, the built-in aliases. */
export interface GraphMarkdownAliases {
  sections?: GraphSectionAliases | undefined;
  nodeTypes?: GraphNodeTypeColumnAliases | undefined;
  relationTypes?: GraphRelationTypeColumnAliases | undefined;
  nodes?: GraphNodeColumnAliases | undefined;
  relations?: GraphRelationColumnAliases | undefined;
}

export interface ProjectGraphConfig {
  schemaVersion: 1;
  relationsFile: string;
  /** Existing writingStatus sidebar source used to resolve the writer stop point. */
  stopSourceId: string;
  /** Optional structured sidebar sources that contribute node type hints. */
  typeSources?: GraphTypeSourceConfig[] | undefined;
  /** Optional localized Markdown section/header aliases. */
  aliases?: GraphMarkdownAliases | undefined;
}

export const WORLD_GRAPH_HARD_LIMITS = Object.freeze({ nodes: 5_000, edges: 15_000 });
export const WORLD_GRAPH_RENDER_BUDGET = Object.freeze({ nodes: 1_000, edges: 3_000 });
export const WORLD_GRAPH_DIAGNOSTIC_LIMIT = 200;
export const WORLD_GRAPH_SOURCE_EXCERPT_MAX_CHARS = 12_000;

export const DEFAULT_GRAPH_MARKDOWN_ALIASES = Object.freeze({
  sections: {
    nodeTypes: ['节点类型', 'Node Types', 'Node types'],
    relationTypes: ['关系类型', 'Relation Types', 'Relation types'],
    nodes: ['节点', 'Nodes'],
    relations: ['关系', 'Relations'],
  },
  nodeTypes: {
    id: ['ID', 'Id', 'id'],
    name: ['名称', 'Name'],
    visualFamily: ['视觉族', 'Visual family', 'Visual Family'],
  },
  relationTypes: {
    id: ['ID', 'Id', 'id'],
    name: ['名称', 'Name'],
    visualFamily: ['视觉族', 'Visual family', 'Visual Family'],
    directed: ['有向', 'Directed'],
    reverseName: ['反向名称', 'Reverse name', 'Reverse Name'],
  },
  nodes: {
    id: ['ID', 'Id', 'id'],
    name: ['名称', 'Name'],
    aliases: ['别名', 'Aliases'],
    typeId: ['类型', 'Type', 'Type ID', 'Type id'],
    activeFrom: ['生效章', 'Active from', 'Active From'],
    revealedAt: ['揭示章', 'Revealed at', 'Revealed At'],
    inactiveFrom: ['失效章', 'Inactive from', 'Inactive From'],
    visibility: ['可见性', 'Visibility'],
    confidence: ['置信', 'Confidence'],
    sources: ['出处', 'Sources', 'Source'],
  },
  relations: {
    id: ['ID', 'Id', 'id'],
    source: ['源', 'Source'],
    relationTypeId: ['关系', 'Relation', 'Relation type', 'Relation Type'],
    targetId: ['目标', 'Target'],
    activeFrom: ['生效章', 'Active from', 'Active From'],
    revealedAt: ['揭示章', 'Revealed at', 'Revealed At'],
    inactiveFrom: ['失效章', 'Inactive from', 'Inactive From'],
    visibility: ['可见性', 'Visibility'],
    confidence: ['置信', 'Confidence'],
    sources: ['出处', 'Sources', 'Source'],
  },
} satisfies Required<GraphMarkdownAliases>);

export const graphViewSchema = z.enum(['writer', 'planner']);
export const graphVisibilitySchema = z.enum(['public', 'authorOnly']);
export const graphConfidenceSchema = z.enum(['confirmed', 'inferred', 'question']);
export const graphVisualFamilySchema = z.enum([
  'character',
  'faction',
  'place',
  'item',
  'event',
  'skill',
  'species',
  'rule',
  'foreshadow',
  'custom',
  'unknown',
]);

/** Stable ASCII identifier for nodes, edges, and project-defined semantic types. */
export const graphIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const graphDocIdSchema = z.string().min(1).refine(
  (value) => {
    if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value) || value.includes('\\')) return false;
    if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
    return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  },
  { message: 'must be a non-empty vault-relative POSIX docId without traversal segments' },
);

export const storyPointSchema = z.object({
  docId: graphDocIdSchema,
  order: z.number().int().nonnegative(),
  label: z.string().min(1),
  chapterNo: z.number().int().positive().nullable(),
}).strict();

export const graphSourceRefSchema = z.object({
  docId: graphDocIdSchema,
  heading: z.string().min(1).nullable(),
  label: z.string().min(1).nullable(),
}).strict();

export const graphStoryTimeSchema = z.union([z.literal('@start'), storyPointSchema]).nullable();

export const nodeTypeDefinitionSchema = z.object({
  id: graphIdSchema,
  name: z.string().min(1),
  visualFamily: graphVisualFamilySchema,
}).strict();

export const relationTypeDefinitionSchema = z.object({
  id: graphIdSchema,
  name: z.string().min(1),
  visualFamily: graphVisualFamilySchema,
  directed: z.boolean(),
  reverseName: z.string().min(1).nullable(),
}).strict();

export const worldNodeSchema = z.object({
  id: graphIdSchema,
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  typeId: graphIdSchema,
  activeFrom: graphStoryTimeSchema,
  revealedAt: graphStoryTimeSchema,
  inactiveFrom: graphStoryTimeSchema,
  visibility: graphVisibilitySchema,
  confidence: graphConfidenceSchema,
  sources: z.array(graphSourceRefSchema),
  implicit: z.boolean(),
}).strict();

export const worldEdgeSchema = z.object({
  id: graphIdSchema,
  sourceId: graphIdSchema,
  relationTypeId: graphIdSchema,
  targetId: graphIdSchema,
  activeFrom: graphStoryTimeSchema,
  revealedAt: graphStoryTimeSchema,
  inactiveFrom: graphStoryTimeSchema,
  visibility: graphVisibilitySchema,
  confidence: graphConfidenceSchema,
  sources: z.array(graphSourceRefSchema),
}).strict();

export const graphDiagnosticCodeSchema = z.enum([
  'MISSING_COLUMN',
  'INVALID_VALUE',
  'DUPLICATE_ID',
  'AMBIGUOUS_NAME',
  'UNDECLARED_TYPE',
  'IMPLICIT_NODE',
  'ORPHAN_NODE',
  'INVALID_STORY_POINT',
  'STOP_POINT_UNSET',
  'INVERTED_TIME_RANGE',
  'SOURCE_NOT_FOUND',
  'SOURCE_HEADING_NOT_FOUND',
  'SOURCE_HEADING_AMBIGUOUS',
  'MISSING_SAFETY_FIELD',
  'GRAPH_TOO_LARGE',
]);

export const graphDiagnosticSchema = z.object({
  code: graphDiagnosticCodeSchema,
  severity: z.enum(['warning', 'error']),
  entityKind: z.enum(['graph', 'nodeType', 'relationType', 'node', 'edge', 'source']),
  entityId: graphIdSchema.nullable(),
  file: graphDocIdSchema,
  line: z.number().int().positive().nullable(),
  tableRow: z.number().int().positive().nullable(),
  message: z.string().min(1),
}).strict();

export const worldGraphCountsSchema = z.object({
  nodeTypes: z.number().int().nonnegative(),
  relationTypes: z.number().int().nonnegative(),
  nodes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
}).strict();

export const worldGraphSnapshotSchema = z.object({
  view: graphViewSchema,
  version: z.string().regex(/^[0-9a-f]{64}$/),
  stopState: z.enum(['resolved', 'unset']),
  stopPoint: storyPointSchema.nullable(),
  storyPoints: z.array(storyPointSchema),
  nodeTypes: z.array(nodeTypeDefinitionSchema),
  relationTypes: z.array(relationTypeDefinitionSchema),
  nodes: z.array(worldNodeSchema).max(WORLD_GRAPH_HARD_LIMITS.nodes),
  edges: z.array(worldEdgeSchema).max(WORLD_GRAPH_HARD_LIMITS.edges),
  counts: worldGraphCountsSchema,
  diagnostics: z.array(graphDiagnosticSchema).max(WORLD_GRAPH_DIAGNOSTIC_LIMIT),
  diagnosticCount: z.number().int().nonnegative(),
}).strict().superRefine((snapshot, ctx) => {
  const expectedCounts = {
    nodeTypes: snapshot.nodeTypes.length,
    relationTypes: snapshot.relationTypes.length,
    nodes: snapshot.nodes.length,
    edges: snapshot.edges.length,
  };
  for (const key of Object.keys(expectedCounts) as Array<keyof WorldGraphCounts>) {
    if (snapshot.counts[key] !== expectedCounts[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['counts', key],
        message: `must equal projected ${key} length`,
      });
    }
  }
  if (snapshot.diagnosticCount < snapshot.diagnostics.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['diagnosticCount'],
      message: 'must be at least the returned diagnostics length',
    });
  }
  if (snapshot.stopState === 'unset' && snapshot.stopPoint !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stopPoint'],
      message: 'unset snapshots cannot have a stop point',
    });
  }
  if (
    snapshot.view === 'writer'
    && snapshot.stopState === 'resolved'
    && snapshot.stopPoint === null
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stopPoint'],
      message: 'resolved writer snapshots require a stop point',
    });
  }
  if (snapshot.view === 'writer' && snapshot.stopState === 'unset') {
    // Type catalogs carry author-authored vocabulary (faction names, relation
    // verbs) and are spoiler surface like nodes/edges: unset must empty them.
    for (const key of ['storyPoints', 'nodes', 'edges', 'nodeTypes', 'relationTypes'] as const) {
      if (snapshot[key].length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `unset writer snapshots require an empty ${key} projection`,
        });
      }
    }
    if (snapshot.diagnostics.length > 0 || snapshot.diagnosticCount !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['diagnostics'],
        message: 'writer snapshots cannot expose planner diagnostics',
      });
    }
  }
  if (
    snapshot.view === 'writer'
    && snapshot.stopState === 'resolved'
    && snapshot.stopPoint !== null
  ) {
    const stopOrder = snapshot.stopPoint.order;
    const storyPointKey = (point: StoryPoint): string =>
      JSON.stringify([point.docId, point.order, point.label, point.chapterNo]);
    const projectedStoryPoints = new Set(snapshot.storyPoints.map(storyPointKey));
    const projectedStoryPointDocIds = new Set<string>();
    if (!projectedStoryPoints.has(storyPointKey(snapshot.stopPoint))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stopPoint'],
        message: 'writer stopPoint must be present in the projected storyPoints',
      });
    }
    for (const [index, point] of snapshot.storyPoints.entries()) {
      if (point.order !== index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['storyPoints', index, 'order'],
          message: 'writer storyPoints must be the contiguous prefix of manuscript order',
        });
      }
      if (projectedStoryPointDocIds.has(point.docId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['storyPoints', index, 'docId'],
          message: 'writer storyPoint docIds must be unique',
        });
      }
      projectedStoryPointDocIds.add(point.docId);
      if (point.order > stopOrder) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['storyPoints', index],
          message: 'writer storyPoints cannot extend beyond the stop point',
        });
      }
    }

    const validateKnownTime = (
      time: GraphStoryTime,
      path: Array<string | number>,
      field: 'activeFrom' | 'revealedAt',
    ): void => {
      if (time === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `writer ${field} must be known`,
        });
        return;
      }
      if (time === '@start') return;
      if (time.order > stopOrder || !projectedStoryPoints.has(storyPointKey(time))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `writer ${field} must resolve within the projected storyPoints`,
        });
      }
    };

    const projectedNodeTypeIds = new Set(snapshot.nodeTypes.map((definition) => definition.id));
    const projectedRelationTypeIds = new Set(snapshot.relationTypes.map((definition) => definition.id));
    if (projectedNodeTypeIds.size !== snapshot.nodeTypes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodeTypes'],
        message: 'writer node type IDs must be unique',
      });
    }
    if (projectedRelationTypeIds.size !== snapshot.relationTypes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relationTypes'],
        message: 'writer relation type IDs must be unique',
      });
    }

    const usedNodeTypes = new Set<string>();
    const projectedNodeIds = new Set<string>();
    for (const [index, node] of snapshot.nodes.entries()) {
      if (projectedNodeIds.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'id'],
          message: 'writer node IDs must be unique',
        });
      }
      projectedNodeIds.add(node.id);
      usedNodeTypes.add(node.typeId);
      if (!projectedNodeTypeIds.has(node.typeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'typeId'],
          message: 'writer nodes must reference a projected node type',
        });
      }
      if (node.visibility !== 'public') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'visibility'],
          message: 'writer nodes must be public',
        });
      }
      if (node.confidence !== 'confirmed') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'confidence'],
          message: 'writer nodes must be confirmed',
        });
      }
      if (node.implicit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'implicit'],
          message: 'writer nodes cannot be implicit',
        });
      }
      validateKnownTime(node.activeFrom, ['nodes', index, 'activeFrom'], 'activeFrom');
      validateKnownTime(node.revealedAt, ['nodes', index, 'revealedAt'], 'revealedAt');
      if (node.inactiveFrom !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'inactiveFrom'],
          message: 'writer node inactiveFrom must redact non-current story points',
        });
      }
    }

    const usedRelationTypes = new Set<string>();
    const projectedEdgeIds = new Set<string>();
    for (const [index, edge] of snapshot.edges.entries()) {
      if (projectedEdgeIds.has(edge.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index, 'id'],
          message: 'writer edge IDs must be unique',
        });
      }
      projectedEdgeIds.add(edge.id);
      usedRelationTypes.add(edge.relationTypeId);
      if (!projectedRelationTypeIds.has(edge.relationTypeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index, 'relationTypeId'],
          message: 'writer edges must reference a projected relation type',
        });
      }
      if (edge.visibility !== 'public') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index, 'visibility'],
          message: 'writer edges must be public',
        });
      }
      if (edge.confidence !== 'confirmed') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index, 'confidence'],
          message: 'writer edges must be confirmed',
        });
      }
      if (!projectedNodeIds.has(edge.sourceId) || !projectedNodeIds.has(edge.targetId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index],
          message: 'writer edges must reference projected endpoints',
        });
      }
      validateKnownTime(edge.activeFrom, ['edges', index, 'activeFrom'], 'activeFrom');
      validateKnownTime(edge.revealedAt, ['edges', index, 'revealedAt'], 'revealedAt');
      if (edge.inactiveFrom !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index, 'inactiveFrom'],
          message: 'writer edge inactiveFrom must redact non-current story points',
        });
      }
    }

    for (const [index, definition] of snapshot.nodeTypes.entries()) {
      if (!usedNodeTypes.has(definition.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodeTypes', index],
          message: 'writer node type catalog must contain only projected types',
        });
      }
    }
    for (const [index, definition] of snapshot.relationTypes.entries()) {
      if (!usedRelationTypes.has(definition.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relationTypes', index],
          message: 'writer relation type catalog must contain only projected types',
        });
      }
    }
    if (snapshot.diagnostics.length > 0 || snapshot.diagnosticCount !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['diagnostics'],
        message: 'writer snapshots cannot expose planner diagnostics',
      });
    }
  }
});

export const graphQuerySchema = z.object({
  view: graphViewSchema.default('writer'),
}).strict();

export const graphSourceQuerySchema = z.object({
  view: graphViewSchema.default('writer'),
  heading: z.string().min(1).optional(),
}).strict();

export const graphSourceExcerptSchema = z.object({
  source: graphSourceRefSchema,
  markdown: z.string().max(WORLD_GRAPH_SOURCE_EXCERPT_MAX_CHARS),
  truncated: z.boolean(),
}).strict();

type _StoryPointSchemaMatches = AssertSchemaMatch<SchemaMatches<typeof storyPointSchema, StoryPoint>>;
type _GraphSourceRefSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof graphSourceRefSchema, GraphSourceRef>
>;
type _NodeTypeDefinitionSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof nodeTypeDefinitionSchema, NodeTypeDefinition>
>;
type _RelationTypeDefinitionSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof relationTypeDefinitionSchema, RelationTypeDefinition>
>;
type _WorldNodeSchemaMatches = AssertSchemaMatch<SchemaMatches<typeof worldNodeSchema, WorldNode>>;
type _WorldEdgeSchemaMatches = AssertSchemaMatch<SchemaMatches<typeof worldEdgeSchema, WorldEdge>>;
type _GraphDiagnosticSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof graphDiagnosticSchema, GraphDiagnostic>
>;
type _WorldGraphSnapshotSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof worldGraphSnapshotSchema, WorldGraphSnapshot>
>;
type _GraphSourceExcerptSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof graphSourceExcerptSchema, GraphSourceExcerpt>
>;
