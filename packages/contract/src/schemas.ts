/**
 * Runtime validation for external inputs. The critical boundary is the
 * vault-side `.writing-studio/project.json` (hand-editable), plus the two
 * REST bodies that mutate vault files.
 */

import { z } from 'zod';
// Self-referencing subpath on purpose: Node 22 type stripping runs contract
// tests without mapping './agent-ids.js' back to the .ts source, so a relative
// specifier breaks `node --test`. Do not "normalize" this to a relative import.
import { AGENT_IDS } from '@writing-studio/contract/agent-ids';
import type {
  GraphMarkdownAliases,
  GraphTypeSourceConfig,
  ProjectGraphConfig,
} from './graph.js';
import type {
  DocumentMeta,
  LintFinding,
  LintResponse,
  LintStyleRuleConfig,
  ProjectLintConfig,
  ProvenanceResponse,
  ProvenanceRevision,
  ProvenanceSummary,
} from './models.js';
import type {
  DeleteDraftResponse,
  DraftListResponse,
  LintRequest,
  RestoreDraftResponse,
  TrashEntry,
  TrashListResponse,
} from './api.js';
import type { AssertSchemaMatch, SchemaMatches } from './internal/schema-assert.js';

const numberStyleSchema = z.enum(['arabic', 'cnLower']);
const agentIdSchema = z.enum(AGENT_IDS);
const sidebarViewSchema = z.enum(['writer', 'planner']);

/**
 * Complete model-facing prompt vocabulary. Locale packs must provide every
 * key; project overrides may replace individual values.
 */
export const promptBundleSchema = z.object({
  chatPersonaSystemIntro: z.string(),
  chatPersonaContextBoundary: z.string(),
  contextSourceSafety: z.string(),
  chatPersonaCanonBoundary: z.string(),
  chatPersonaAuthorBoundary: z.string(),
  chatPersonaMemoryCutoff: z.string(),
  canonRepairSystemIntro: z.string(),
  canonRepairVaultBoundary: z.string(),
  canonRepairHeadingRule: z.string(),
  canonRepairOutputRule: z.string(),
  generationSystemIntro: z.string(),
  generationChapterInstruction: z.string(),
  generationEvidenceRule: z.string(),
  conflictCheckSystemIntro: z.string(),
  conflictCheckInstruction: z.string(),
  conflictCheckJsonRule: z.string(),
  conflictCheckCanonSourceRule: z.string(),
  conflictCheckEmptyRule: z.string(),
  writerSystemIntro: z.string(),
  writerAnswerRule: z.string(),
  plannerSystemIntro: z.string(),
  plannerFactRule: z.string(),
  lostSelectionNotice: z.string(),
  conflictCheckUserMessage: z.string(),
  historyOmittedNotice: z.string(),
  historyUserLabel: z.string(),
  historyAssistantLabel: z.string(),
  historyLatestCandidateLabel: z.string(),
  historySystemLabel: z.string(),
  historyContextLabel: z.string(),
  historyConversationLabel: z.string(),
  historyCurrentUserLabel: z.string(),
  structuredOutputInstruction: z.string(),
  schemaCorrection: z.string(),
}).strict();

export const promptBundleOverrideSchema = promptBundleSchema.partial().strict();

export type PromptBundle = z.infer<typeof promptBundleSchema>;
export type PromptBundleOverride = z.infer<typeof promptBundleOverrideSchema>;

/**
 * Stored vault paths always use POSIX separators. Globs are permitted for AI
 * profile allow/deny lists, but no path may be absolute or contain a traversal
 * segment that could escape the vault after expansion.
 */
export const vaultRelativePathSchema = z.string().min(1).refine(
  (value) => {
    if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value) || value.includes('\\')) return false;
    if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
    return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  },
  { message: 'must be a non-empty vault-relative POSIX path without traversal segments' },
);

function vaultGlobPattern(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
        continue;
      }
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'su');
}

function matchesVaultPolicy(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => vaultGlobPattern(pattern).test(path));
}

function matchesForbiddenVaultPolicy(path: string, patterns: string[]): boolean {
  const foldedPath = path.normalize('NFKC').toLocaleLowerCase('en-US');
  return patterns.some((pattern) =>
    vaultGlobPattern(pattern.normalize('NFKC').toLocaleLowerCase('en-US')).test(foldedPath));
}

const compilableRegexSchema = z.string().refine(
  (value) => {
    try {
      new RegExp(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be a compilable JavaScript regular expression' },
);

const lintStyleRuleSchema = z.object({
  ruleId: z.string().min(1),
  pattern: compilableRegexSchema.refine(
    (value) => {
      try {
        new RegExp(value, 'gu');
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be compilable with the global Unicode lint flags' },
  ),
  message: z.string().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  category: z.literal('style'),
}).strict();

const projectLintConfigSchema = z.object({
  styleRules: z.array(lintStyleRuleSchema).superRefine((rules, ctx) => {
    // Same uniqueness guard as sidebarSources: with duplicates, the merge map
    // would silently drop every rule but the last one.
    const ids = new Set<string>();
    for (const [index, rule] of rules.entries()) {
      if (ids.has(rule.ruleId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'ruleId'],
          message: `lint style rule id must be unique: ${rule.ruleId}`,
        });
      }
      ids.add(rule.ruleId);
    }
  }).optional(),
  disableBuiltinStyleRules: z.array(z.string().min(1)).optional(),
  idiomStackList: z.array(z.string().min(1)).optional(),
}).strict();

const headingLevelSchema = z.number().int().min(1).max(6);
const aliasListSchema = z.array(z.string().min(1)).min(1);

const contentTreeLevelSchema = z.object({
  levelName: z.string().min(1),
  dirPattern: vaultRelativePathSchema.refine((value) => value.includes('{num}'), {
    message: 'must include {num}',
  }),
  numberStyle: numberStyleSchema,
  indexFile: vaultRelativePathSchema.nullable(),
}).strict();

const contentTreeLeafSchema = z.object({
  filePattern: vaultRelativePathSchema.refine((value) => value.includes('{num}'), {
    message: 'must include {num}',
  }),
  numberStyle: numberStyleSchema,
  titleTemplate: z.string().nullable().optional(),
  numberingScope: z.enum(['book', 'perLevel']),
  titleStripRegex: compilableRegexSchema.nullable(),
}).strict();

const contentTreeSchema = z.object({
  root: vaultRelativePathSchema,
  levels: z.array(contentTreeLevelSchema).max(2),
  leaf: contentTreeLeafSchema,
}).strict();

const sidebarSourceBaseSchema = {
  id: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string().min(1),
  file: vaultRelativePathSchema,
  order: z.number().int(),
  injection: z.enum(['always', 'mention']).default('always'),
};

const markdownTableParserConfigSchema = z.object({
  sectionHeadingLevels: z.array(headingLevelSchema),
  columnAliases: z.object({
    term: aliasListSchema,
    source: aliasListSchema,
    firstAppearance: aliasListSchema,
    blankLink: aliasListSchema,
    status: aliasListSchema,
    serial: aliasListSchema,
  }).strict(),
  writerHiddenFields: z.array(z.enum([
    'term', 'source', 'firstAppearance', 'blankLink', 'status', 'serial',
  ])).optional(),
}).strict();

const charactersParserConfigSchema = z.object({
  kind: z.literal('characters'),
  cardHeadingLevel: headingLevelSchema,
  sectionHeadingLevel: headingLevelSchema,
  authorOnlyMarkers: z.array(z.string().min(1)),
}).strict();

const writingStatusParserConfigSchema = z.object({
  kind: z.literal('writingStatus'),
  lastRefreshedRegex: compilableRegexSchema,
  stopChapterRegex: compilableRegexSchema,
  sectionHeadings: z.object({
    stopPoint: z.string().min(1).optional(),
    storylines: z.string().min(1).optional(),
    activeForeshadow: z.string().min(1).optional(),
    characterOneLiners: z.string().min(1).optional(),
    redLines: z.string().min(1).optional(),
    expressionBaseline: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();

const foreshadowingParserConfigSchema = z.object({
  kind: z.literal('foreshadowing'),
  itemHeadingLevel: headingLevelSchema,
  itemIdRegex: compilableRegexSchema,
  statusFieldRegex: compilableRegexSchema,
  writerVisible: z.boolean().optional(),
}).strict();

const sidebarSourceSchema = z.union([
  z.object({
    ...sidebarSourceBaseSchema,
    parser: z.literal('markdown-table'),
    parserConfig: markdownTableParserConfigSchema,
  }).strict(),
  z.object({
    ...sidebarSourceBaseSchema,
    parser: z.literal('heading-sections'),
    parserConfig: writingStatusParserConfigSchema,
  }).strict(),
  z.object({
    ...sidebarSourceBaseSchema,
    parser: z.literal('heading-sections'),
    parserConfig: charactersParserConfigSchema,
  }).strict(),
  z.object({
    ...sidebarSourceBaseSchema,
    parser: z.literal('heading-sections'),
    parserConfig: foreshadowingParserConfigSchema,
  }).strict(),
  z.object({
    ...sidebarSourceBaseSchema,
    parser: z.literal('plain'),
    parserConfig: z.object({}).strict(),
  }).strict(),
]);

const aiProfileSchema = z.object({
  description: z.string(),
  readable: z.array(vaultRelativePathSchema),
  forbidden: z.array(vaultRelativePathSchema),
  contextSources: z.array(z.string().regex(/^[a-z0-9_]+$/)).max(16).optional(),
  allowVaultBrowsing: z.boolean(),
}).strict();

const aiProfilesSchema = z.object({
  writer: aiProfileSchema,
  planner: aiProfileSchema,
  defaultProfile: z.enum(['writer', 'planner']),
}).strict();

const projectContextConfigSchema = z.object({
  excludeTerms: z.array(z.string().min(1)).default([]),
}).strict();

const graphConfigIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const optionalGraphAliasObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict().optional();

export const graphTypeSourceConfigSchema = z.object({
  sourceId: z.string().regex(/^[a-z0-9_]+$/),
  defaultTypeId: graphConfigIdSchema.optional(),
  sectionTypeIds: z.record(z.string().min(1), graphConfigIdSchema).optional(),
}).strict().superRefine((source, ctx) => {
  if (source.defaultTypeId === undefined && Object.keys(source.sectionTypeIds ?? {}).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'must define defaultTypeId or at least one sectionTypeIds entry',
    });
  }
});

export const graphMarkdownAliasesSchema = z.object({
  sections: optionalGraphAliasObject({
    nodeTypes: aliasListSchema.optional(),
    relationTypes: aliasListSchema.optional(),
    nodes: aliasListSchema.optional(),
    relations: aliasListSchema.optional(),
  }),
  nodeTypes: optionalGraphAliasObject({
    id: aliasListSchema.optional(),
    name: aliasListSchema.optional(),
    visualFamily: aliasListSchema.optional(),
  }),
  relationTypes: optionalGraphAliasObject({
    id: aliasListSchema.optional(),
    name: aliasListSchema.optional(),
    visualFamily: aliasListSchema.optional(),
    directed: aliasListSchema.optional(),
    reverseName: aliasListSchema.optional(),
  }),
  nodes: optionalGraphAliasObject({
    id: aliasListSchema.optional(),
    name: aliasListSchema.optional(),
    aliases: aliasListSchema.optional(),
    typeId: aliasListSchema.optional(),
    activeFrom: aliasListSchema.optional(),
    revealedAt: aliasListSchema.optional(),
    inactiveFrom: aliasListSchema.optional(),
    visibility: aliasListSchema.optional(),
    confidence: aliasListSchema.optional(),
    sources: aliasListSchema.optional(),
  }),
  relations: optionalGraphAliasObject({
    id: aliasListSchema.optional(),
    source: aliasListSchema.optional(),
    relationTypeId: aliasListSchema.optional(),
    targetId: aliasListSchema.optional(),
    activeFrom: aliasListSchema.optional(),
    revealedAt: aliasListSchema.optional(),
    inactiveFrom: aliasListSchema.optional(),
    visibility: aliasListSchema.optional(),
    confidence: aliasListSchema.optional(),
    sources: aliasListSchema.optional(),
  }),
}).strict();

export const projectGraphConfigSchema = z.object({
  schemaVersion: z.literal(1),
  relationsFile: vaultRelativePathSchema.refine((value) => value.toLowerCase().endsWith('.md'), {
    message: 'must reference a Markdown file',
  }),
  stopSourceId: z.string().regex(/^[a-z0-9_]+$/),
  typeSources: z.array(graphTypeSourceConfigSchema).optional(),
  aliases: graphMarkdownAliasesSchema.optional(),
}).strict();

type _GraphTypeSourceConfigSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof graphTypeSourceConfigSchema, GraphTypeSourceConfig>
>;
type _GraphMarkdownAliasesSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof graphMarkdownAliasesSchema, GraphMarkdownAliases>
>;
type _ProjectGraphConfigSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof projectGraphConfigSchema, ProjectGraphConfig>
>;
type _LintStyleRuleSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof lintStyleRuleSchema, LintStyleRuleConfig>
>;
type _ProjectLintConfigSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof projectLintConfigSchema, ProjectLintConfig>
>;

export const projectConfigSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  displayName: z.string().min(1),
  localePreset: z.enum(['zh-CN', 'en']).optional(),
  prompts: z.object({
    overrides: promptBundleOverrideSchema.optional(),
  }).strict().optional(),
  lint: projectLintConfigSchema.optional(),
  contentTree: contentTreeSchema,
  draftsDir: vaultRelativePathSchema,
  sidebarSources: z.array(sidebarSourceSchema).superRefine((sources, ctx) => {
    const ids = new Set<string>();
    for (const [index, source] of sources.entries()) {
      if (ids.has(source.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `sidebar source id must be unique: ${source.id}`,
        });
      }
      ids.add(source.id);
    }
  }),
  graph: projectGraphConfigSchema.optional(),
  context: projectContextConfigSchema.default({ excludeTerms: [] }),
  aiProfiles: aiProfilesSchema,
  defaultAgentId: agentIdSchema,
  reviewScripts: z
    .object({
      pythonExecutable: z.string().min(1),
      impactScan: vaultRelativePathSchema.optional(),
      mechanicalReview: vaultRelativePathSchema.optional(),
    }).strict()
    .optional(),
}).strict().superRefine((config, ctx) => {
  const sources = new Map(config.sidebarSources.map((source) => [source.id, source]));
  for (const profileName of ['writer', 'planner'] as const) {
    const profile = config.aiProfiles[profileName];
    const contextSourceIds = new Set<string>();
    for (const [index, sourceId] of (profile.contextSources ?? []).entries()) {
      const source = sources.get(sourceId);
      if (contextSourceIds.has(sourceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['aiProfiles', profileName, 'contextSources', index],
          message: `context source id must be unique: ${sourceId}`,
        });
      }
      contextSourceIds.add(sourceId);
      if (!source) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['aiProfiles', profileName, 'contextSources', index],
          message: `unknown sidebar source: ${sourceId}`,
        });
      } else if (profileName === 'writer' && source.parser === 'plain') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['aiProfiles', profileName, 'contextSources', index],
          message: 'plain sidebar sources cannot be auto-injected into writer context',
        });
      } else if (
        profileName === 'writer'
        && !matchesVaultPolicy(source.file, profile.readable)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['aiProfiles', profileName, 'contextSources', index],
          message: `writer context source is not readable: ${source.file}`,
        });
      } else if (
        profileName === 'writer'
        && matchesForbiddenVaultPolicy(source.file, profile.forbidden)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['aiProfiles', profileName, 'contextSources', index],
          message: `writer context source is forbidden: ${source.file}`,
        });
      }
    }
  }

  if (config.graph) {
    const stopSource = sources.get(config.graph.stopSourceId);
    if (
      !stopSource
      || stopSource.parser !== 'heading-sections'
      || stopSource.parserConfig.kind !== 'writingStatus'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['graph', 'stopSourceId'],
        message: 'must reference an existing writingStatus sidebar source',
      });
    }

    const typeSourceIds = new Set<string>();
    for (const [index, typeSource] of (config.graph.typeSources ?? []).entries()) {
      const source = sources.get(typeSource.sourceId);
      if (typeSourceIds.has(typeSource.sourceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['graph', 'typeSources', index, 'sourceId'],
          message: `graph type source id must be unique: ${typeSource.sourceId}`,
        });
      }
      typeSourceIds.add(typeSource.sourceId);

      const unsupported = !source
        || source.parser === 'plain'
        || (
          source.parser === 'heading-sections'
          && source.parserConfig.kind === 'writingStatus'
        );
      if (unsupported) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['graph', 'typeSources', index, 'sourceId'],
          message: 'must reference an existing structured node-bearing sidebar source',
        });
      }
    }
  }
});

export const putDocumentRequestSchema = z.object({
  content: z.string(),
  baseSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceThreadId: z.string().uuid().optional(),
}).strict();

export const renameChapterTitleRequestSchema = z.object({
  title: z.string()
    .trim()
    .min(1)
    .max(60)
    .refine((value) => !/[\r\n\u2028\u2029]/u.test(value), {
      message: 'chapter title must be a single line',
    }),
  baseSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

/** Runtime half of the additive DocumentMeta response contract. */
export const documentMetaSchema: z.ZodType<DocumentMeta> = z.object({
  docId: vaultRelativePathSchema,
  projectId: z.string().min(1),
  kind: z.enum(['chapter', 'draft', 'canon']),
  title: z.string(),
  chapterNo: z.number().int().nonnegative().nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
}).strict();

export const renameChapterTitleResponseSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  doc: documentMetaSchema,
}).strict();

/** GET /api/projects/:pid/drafts response. */
export const draftListResponseSchema: z.ZodType<DraftListResponse> = z.array(documentMetaSchema);

export const deleteDraftParamsSchema = z.object({
  pid: z.string().min(1),
  docId: vaultRelativePathSchema,
}).strict();

export const deleteDraftResponseSchema: z.ZodType<DeleteDraftResponse> = z.object({
  docId: vaultRelativePathSchema,
  // `.trash` is intentionally not an exposed document path, but is returned
  // so the local author can recover the moved file.
  trashedDocId: vaultRelativePathSchema,
}).strict();

export const trashEntrySchema: z.ZodType<TrashEntry> = z.object({
  trashedDocId: vaultRelativePathSchema,
  originalName: z.string().min(1),
  deletedAt: z.string().datetime(),
  title: z.string(),
}).strict();

export const trashListResponseSchema: z.ZodType<TrashListResponse> = z.array(trashEntrySchema);

export const restoreDraftParamsSchema = z.object({
  pid: z.string().min(1),
  docId: vaultRelativePathSchema,
}).strict();

export const restoreDraftResponseSchema: z.ZodType<RestoreDraftResponse> = z.object({
  trashedDocId: vaultRelativePathSchema,
  docId: vaultRelativePathSchema,
}).strict();

export const createDraftRequestSchema = z.object({
  title: z.string().trim().min(1),
}).strict();

export const createChapterRequestSchema = z.object({
  title: z.string().trim().min(1).max(60),
  dirOverride: vaultRelativePathSchema.optional(),
}).strict();

export const createRevisionRequestSchema = z.object({
  kind: z.enum(['ai_original', 'user_edit', 'manual_snapshot']),
  content: z.string(),
  sourceThreadId: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
}).strict();

export const lintRequestSchema = z.object({
  docId: vaultRelativePathSchema,
}).strict();

export const lintFindingSchema = z.object({
  ruleId: z.string().min(1),
  category: z.enum(['style', 'sensitive']),
  message: z.string().min(1),
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  severity: z.enum(['info', 'warning', 'error']),
}).strict();

export const lintResponseSchema = z.object({
  docId: vaultRelativePathSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  findings: z.array(lintFindingSchema),
}).strict();

type _LintRequestSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof lintRequestSchema, LintRequest>
>;
type _LintFindingSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof lintFindingSchema, LintFinding>
>;
type _LintResponseSchemaMatches = AssertSchemaMatch<
  SchemaMatches<typeof lintResponseSchema, LintResponse>
>;

export const provenanceRevisionSchema: z.ZodType<ProvenanceRevision> = z.object({
  revisionId: z.string().min(1),
  kind: z.enum(['ai_original', 'user_edit', 'manual_snapshot']),
  createdAt: z.number().int().nonnegative(),
  wordCount: z.number().int().nonnegative(),
  addedChars: z.number().int().nonnegative(),
  deletedChars: z.number().int().nonnegative(),
}).strict();

export const provenanceSummarySchema: z.ZodType<ProvenanceSummary> = z.object({
  aiDraftWordCount: z.number().int().nonnegative(),
  authorChangedChars: z.number().int().nonnegative(),
  revisionCount: z.number().int().nonnegative(),
  timeSpanMs: z.number().int().nonnegative(),
}).strict();

export const provenanceResponseSchema: z.ZodType<ProvenanceResponse> = z.object({
  docId: vaultRelativePathSchema,
  title: z.string(),
  summary: provenanceSummarySchema,
  revisions: z.array(provenanceRevisionSchema),
}).strict();

/**
 * Model id passed verbatim as a CLI `--model` argument. No leading dash and a
 * conservative character set, so a request value can never be parsed as an
 * extra CLI flag. Slashes/colons cover provider-scoped ids (opencode).
 */
export const agentModelIdSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/);

export const postMessageRequestSchema = z.object({
  content: z.string().min(1),
  agentId: agentIdSchema.optional(),
  model: agentModelIdSchema.optional(),
  wantRewrite: z.boolean().optional(),
}).strict();

export const conflictCheckRequestSchema = z.object({
  agentId: agentIdSchema.optional(),
  model: agentModelIdSchema.optional(),
}).strict();

export const anchorSchema = z.object({
  docSha: z.string().regex(/^[0-9a-f]{64}$/),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  prefix: z.string(),
  exact: z.string().min(1),
  suffix: z.string(),
}).strict().refine((anchor) => anchor.end > anchor.start, {
  message: 'end must be greater than start',
  path: ['end'],
});

export const chatPersonaSchema = z.object({
  characterName: z.string().trim().min(1).max(80),
  memoryCutoffChapter: z.number().int().positive().optional(),
}).strict();

export const conflictFindingSchema = z.object({
  claimInText: z.string().min(1),
  textQuote: z.string().min(1),
  canonSource: z.object({
    docId: vaultRelativePathSchema,
    heading: z.string().trim().min(1),
  }).strict(),
  conflictType: z.enum(['character', 'setting', 'timeline', 'other']),
  severity: z.enum(['high', 'medium', 'low']),
  explanation: z.string().min(1),
}).strict();

export const conflictCheckResponseSchema = z.object({
  findings: z.array(conflictFindingSchema),
}).strict();

export const createThreadRequestSchema = z.object({
  projectId: z.string(),
  docId: vaultRelativePathSchema,
  kind: z.enum(['ask', 'rewrite', 'chat']),
  anchor: anchorSchema.optional(),
  agentId: agentIdSchema.optional(),
  profile: z.enum(['writer', 'planner']).optional(),
  persona: chatPersonaSchema.optional(),
  origin: z.enum(['generate', 'check', 'canon']).optional(),
  headingPath: z.array(z.string().trim().min(1).max(200)).min(1).max(2).optional(),
  evidence: z.object({
    docId: vaultRelativePathSchema,
    textQuote: z.string().min(1).max(4_000),
  }).strict().optional(),
}).strict().superRefine((request, ctx) => {
  if (request.kind === 'chat') {
    if (!request.persona) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['persona'],
        message: 'chat threads require a persona',
      });
    }
    if (request.anchor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['anchor'],
        message: 'chat threads cannot be anchored to manuscript text',
      });
    }
    if (request.profile && request.profile !== 'writer') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['profile'],
        message: 'chat threads always use the writer profile',
      });
    }
  } else if (request.persona) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['persona'],
      message: 'persona is only valid for chat threads',
    });
  }
  if (
    request.origin === 'generate'
    && (request.kind !== 'rewrite' || request.anchor !== undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['origin'],
      message: 'generate origin requires an unanchored rewrite thread',
    });
  }
  if (request.origin === 'generate' && request.profile && request.profile !== 'writer') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['profile'],
      message: 'generate origin always uses the writer profile',
    });
  }
  if (
    request.origin === 'check'
    && (request.kind !== 'ask' || request.anchor !== undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['origin'],
      message: 'check origin requires an unanchored ask thread',
    });
  }
  if (request.origin === 'check' && request.profile && request.profile !== 'writer') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['profile'],
      message: 'check origin always uses the writer profile',
    });
  }
  if (
    request.origin === 'canon'
    && (
      request.kind !== 'rewrite'
      || request.anchor === undefined
      || request.headingPath === undefined
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['origin'],
      message: 'canon origin requires an anchored rewrite with a headingPath',
    });
  }
  if (request.origin === 'canon' && request.profile && request.profile !== 'writer') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['profile'],
      message: 'canon origin always uses the writer profile',
    });
  }
  if (request.origin !== 'canon' && (request.headingPath || request.evidence)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['headingPath'],
      message: 'headingPath and evidence are only valid for canon origin',
    });
  }
});

export const projectThreadsQuerySchema = z.object({
  kind: z.literal('chat'),
}).strict();

export const patchThreadRequestSchema = z.object({
  status: z.enum(['open', 'resolved']).optional(),
  agentId: agentIdSchema.optional(),
  title: z.string().min(1).optional(),
}).strict().refine(
  (patch) => patch.status !== undefined || patch.agentId !== undefined || patch.title !== undefined,
  { message: 'must include at least one mutable thread field' },
);

/** `view` defaults to the writer-safe projection when omitted. */
export const sidebarQuerySchema = z.object({
  view: sidebarViewSchema.default('writer'),
  q: z.string().optional(),
}).strict();
