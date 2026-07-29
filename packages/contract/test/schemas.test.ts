import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  createChapterRequestSchema,
  createDraftRequestSchema,
  createRevisionRequestSchema,
  createThreadRequestSchema,
  conflictCheckRequestSchema,
  conflictCheckResponseSchema,
  deleteDraftParamsSchema,
  deleteDraftResponseSchema,
  documentMetaSchema,
  draftListResponseSchema,
  patchThreadRequestSchema,
  postMessageRequestSchema,
  projectConfigSchema,
  renameChapterTitleRequestSchema,
  renameChapterTitleResponseSchema,
  restoreDraftParamsSchema,
  restoreDraftResponseSchema,
  trashEntrySchema,
  trashListResponseSchema,
  lintFindingSchema,
  lintRequestSchema,
  lintResponseSchema,
  provenanceResponseSchema,
  sidebarQuerySchema,
} from '../src/schemas.ts';
import {
  DEFAULT_GRAPH_MARKDOWN_ALIASES,
  graphQuerySchema,
  graphSourceExcerptSchema,
  graphSourceQuerySchema,
  worldGraphSnapshotSchema,
  type WorldGraphSnapshot,
} from '../src/graph.ts';
import type { Run } from '../src/models.ts';

function validProjectConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'sample',
    displayName: '示例项目',
    contentTree: {
      root: '正文',
      levels: [],
      leaf: {
        filePattern: '第{num}章.md',
        numberStyle: 'arabic',
        numberingScope: 'book',
        titleStripRegex: '^第\\d+章\\s*',
      },
    },
    draftsDir: '草稿',
    sidebarSources: [
      {
        id: 'setting_index',
        label: '设定索引',
        file: '设定索引.md',
        parser: 'markdown-table',
        parserConfig: {
          sectionHeadingLevels: [2, 3],
          columnAliases: {
            term: ['术语'],
            source: ['定义出处'],
            firstAppearance: ['首次正文出现'],
            blankLink: ['关联留白'],
            status: ['状态'],
            serial: ['编号'],
          },
        },
        order: 1,
      },
      {
        id: 'writing_status',
        label: '写作状态',
        file: '写作状态.md',
        parser: 'heading-sections',
        parserConfig: {
          kind: 'writingStatus',
          lastRefreshedRegex: '最后刷新：([0-9-]+)',
          stopChapterRegex: '对应停点第(\\d+)章',
        },
        order: 2,
      },
      {
        id: 'characters',
        label: '角色',
        file: '角色设定.md',
        parser: 'heading-sections',
        parserConfig: {
          kind: 'characters',
          cardHeadingLevel: 2,
          sectionHeadingLevel: 3,
          authorOnlyMarkers: ['作者侧'],
        },
        order: 3,
      },
      {
        id: 'foreshadowing',
        label: '伏笔',
        file: '伏笔.md',
        parser: 'heading-sections',
        parserConfig: {
          kind: 'foreshadowing',
          itemHeadingLevel: 3,
          itemIdRegex: '^(F\\d+)：(.+)$',
          statusFieldRegex: '\\*\\*回收状态\\*\\*[:：]\\s*(.+)$',
        },
        order: 4,
      },
      {
        id: 'notes',
        label: '笔记',
        file: '笔记.md',
        parser: 'plain',
        parserConfig: {},
        order: 5,
      },
    ],
    aiProfiles: {
      writer: {
        description: 'writer',
        readable: ['写作状态.md'],
        forbidden: ['后续剧情规划.md'],
        allowVaultBrowsing: false,
      },
      planner: {
        description: 'planner',
        readable: ['**/*.md'],
        forbidden: [],
        allowVaultBrowsing: true,
      },
      defaultProfile: 'writer',
    },
    defaultAgentId: 'codex',
  };
}

test('project config accepts the implemented sidebar parser variants', () => {
  const result = projectConfigSchema.safeParse(validProjectConfig());
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.sidebarSources.every((source) => source.injection === 'always'), true);
  assert.deepEqual(result.data.context, { excludeTerms: [] });
});

test('project config accepts only the optional built-in locale presets', () => {
  const legacy = projectConfigSchema.parse(validProjectConfig());
  assert.equal(legacy.localePreset, undefined);

  const english = validProjectConfig();
  english['localePreset'] = 'en';
  assert.equal(projectConfigSchema.parse(english).localePreset, 'en');

  const unsupported = validProjectConfig();
  unsupported['localePreset'] = 'fr';
  assert.equal(projectConfigSchema.safeParse(unsupported).success, false);
});

test('project prompt overrides are additive and strict', () => {
  const configured = validProjectConfig();
  configured['prompts'] = {
    overrides: {
      writerAnswerRule: 'Only use confirmed evidence.',
    },
  };
  const parsed = projectConfigSchema.parse(configured);
  assert.equal(parsed.prompts?.overrides?.writerAnswerRule, 'Only use confirmed evidence.');

  configured['prompts'] = { overrides: { unknownPrompt: 'rejected' } };
  assert.equal(projectConfigSchema.safeParse(configured).success, false);

  configured['prompts'] = { overrides: {}, unknownSection: true };
  assert.equal(projectConfigSchema.safeParse(configured).success, false);
});

test('project lint config is additive, strict, and rejects invalid regex patterns', () => {
  const legacy = projectConfigSchema.parse(validProjectConfig());
  assert.equal(legacy.lint, undefined);

  const configured = validProjectConfig();
  configured['lint'] = {
    styleRules: [{
      ruleId: 'project.repetition',
      pattern: '(示例词).+\\1',
      message: '避免近距离重复。',
      severity: 'info',
      category: 'style',
    }],
    disableBuiltinStyleRules: ['style.empty-preface'],
    idiomStackList: ['大惊失色', '惊慌失措'],
  };
  const parsed = projectConfigSchema.parse(configured);
  assert.equal(parsed.lint?.styleRules?.[0]?.ruleId, 'project.repetition');
  assert.deepEqual(parsed.lint?.idiomStackList, ['大惊失色', '惊慌失措']);

  (configured['lint'] as { styleRules: Array<Record<string, unknown>> })
    .styleRules[0]!['pattern'] = '(';
  assert.equal(projectConfigSchema.safeParse(configured).success, false);

  configured['lint'] = { unknownSection: true };
  assert.equal(projectConfigSchema.safeParse(configured).success, false);

  // Duplicate ruleIds would make the merge map silently drop all but the last.
  const duplicated = validProjectConfig();
  duplicated['lint'] = {
    styleRules: [
      {
        ruleId: 'project.dup', pattern: '甲', message: 'a', severity: 'info', category: 'style',
      },
      {
        ruleId: 'project.dup', pattern: '乙', message: 'b', severity: 'info', category: 'style',
      },
    ],
  };
  const rejected = projectConfigSchema.safeParse(duplicated);
  assert.equal(rejected.success, false);
  if (!rejected.success) {
    assert.equal(
      rejected.error.issues.some((issue) =>
        issue.message.includes('lint style rule id must be unique: project.dup')),
      true,
    );
  }
});

test('project config accepts an optional chapter title template additively', () => {
  const legacy = projectConfigSchema.parse(validProjectConfig());
  assert.equal(legacy.contentTree.leaf.titleTemplate, undefined);

  const configured = validProjectConfig();
  const contentTree = configured['contentTree'] as {
    leaf: Record<string, unknown>;
  };
  contentTree.leaf['titleTemplate'] = 'Chapter {num}: {title} {foo}';
  assert.equal(
    projectConfigSchema.parse(configured).contentTree.leaf.titleTemplate,
    'Chapter {num}: {title} {foo}',
  );

  contentTree.leaf['titleTemplate'] = null;
  assert.equal(projectConfigSchema.parse(configured).contentTree.leaf.titleTemplate, null);
});

test('agentId contracts accept the additive Grok backend', () => {
  const config = validProjectConfig();
  config['defaultAgentId'] = 'grok';
  assert.equal(projectConfigSchema.safeParse(config).success, true);
  assert.equal(createThreadRequestSchema.safeParse({
    projectId: 'sample',
    docId: '正文/第1章.md',
    kind: 'ask',
    agentId: 'grok',
  }).success, true);
  assert.equal(patchThreadRequestSchema.safeParse({ agentId: 'grok' }).success, true);
});

test('lint and provenance additive contracts stay strict and aligned', () => {
  assert.equal(lintRequestSchema.safeParse({ docId: '正文/第1章.md' }).success, true);
  assert.equal(lintRequestSchema.safeParse({ docId: '../secret.md' }).success, false);

  const finding = {
    ruleId: 'style.empty-preface',
    category: 'style',
    message: '直接陈述事实。',
    offset: 4,
    length: 7,
    severity: 'warning',
  };
  assert.equal(lintFindingSchema.safeParse(finding).success, true);
  assert.equal(lintFindingSchema.safeParse({ ...finding, extra: true }).success, false);
  assert.equal(lintResponseSchema.safeParse({
    docId: '正文/第1章.md',
    sha256: 'a'.repeat(64),
    findings: [finding],
  }).success, true);

  assert.equal(provenanceResponseSchema.safeParse({
    docId: '正文/第1章.md',
    title: '开始',
    summary: {
      aiDraftWordCount: 12,
      authorChangedChars: 5,
      revisionCount: 2,
      timeSpanMs: 1_000,
    },
    revisions: [{
      revisionId: 'r1',
      kind: 'ai_original',
      createdAt: 1,
      wordCount: 12,
      addedChars: 0,
      deletedChars: 0,
    }],
  }).success, true);
});

test('mention injection config accepts strict policies and exclusion terms', () => {
  const config = validProjectConfig();
  const sources = config['sidebarSources'] as Array<Record<string, unknown>>;
  sources[0]!['injection'] = 'mention';
  config['context'] = { excludeTerms: ['风', '白'] };
  const parsed = projectConfigSchema.parse(config);
  assert.equal(parsed.sidebarSources[0]?.injection, 'mention');
  assert.deepEqual(parsed.context.excludeTerms, ['风', '白']);

  sources[0]!['injection'] = 'sometimes';
  assert.equal(projectConfigSchema.safeParse(config).success, false);
  sources[0]!['injection'] = 'mention';
  config['context'] = { excludeTerms: [], extra: true };
  assert.equal(projectConfigSchema.safeParse(config).success, false);
});

test('project config accepts strict optional WorldGraph config and localized aliases', () => {
  const config = validProjectConfig();
  config['graph'] = {
    schemaVersion: 1,
    relationsFile: '关系网.md',
    stopSourceId: 'writing_status',
    typeSources: [
      {
        sourceId: 'setting_index',
        sectionTypeIds: { '一、地理': 'place' },
      },
      {
        sourceId: 'characters',
        defaultTypeId: 'character',
      },
    ],
    aliases: {
      sections: { relations: ['关系', 'Relationships'] },
      relations: { revealedAt: ['揭示章', 'Revealed in'] },
    },
  };

  const result = projectConfigSchema.safeParse(config);
  assert.equal(result.success, true, result.success ? undefined : result.error.message);
});

test('the generic basic-vault WorldGraph configuration stays schema-valid', () => {
  const configUrl = new URL('../../../examples/basic-vault/.writing-studio/project.json', import.meta.url);
  const raw: unknown = JSON.parse(readFileSync(configUrl, 'utf8'));
  const result = projectConfigSchema.safeParse(raw);
  assert.equal(result.success, true, result.success ? undefined : result.error.message);
});

test('WorldGraph config rejects unsafe paths, invalid sources, duplicates, and unknown keys', () => {
  const withGraph = () => {
    const config = validProjectConfig();
    config['graph'] = {
      schemaVersion: 1,
      relationsFile: '关系网.md',
      stopSourceId: 'writing_status',
      typeSources: [{ sourceId: 'characters', defaultTypeId: 'character' }],
    };
    return config;
  };

  const unsafePath = withGraph();
  (unsafePath['graph'] as { relationsFile: string }).relationsFile = '../关系网.md';
  assert.equal(projectConfigSchema.safeParse(unsafePath).success, false);

  for (const unsafeDocId of [
    'canon//关系网.md',
    'canon/./关系网.md',
    'canon\\关系网.md',
    'canon/\u0085关系网.md',
    'canon/\u2028关系网.md',
  ]) {
    const unsafeGraphPath = withGraph();
    (unsafeGraphPath['graph'] as { relationsFile: string }).relationsFile = unsafeDocId;
    assert.equal(projectConfigSchema.safeParse(unsafeGraphPath).success, false, unsafeDocId);
  }

  const nonMarkdownFile = withGraph();
  (nonMarkdownFile['graph'] as { relationsFile: string }).relationsFile = '.writing-studio/project.json';
  assert.equal(projectConfigSchema.safeParse(nonMarkdownFile).success, false);

  const missingStop = withGraph();
  (missingStop['graph'] as { stopSourceId: string }).stopSourceId = 'missing';
  assert.equal(projectConfigSchema.safeParse(missingStop).success, false);

  const wrongStopKind = withGraph();
  (wrongStopKind['graph'] as { stopSourceId: string }).stopSourceId = 'characters';
  assert.equal(projectConfigSchema.safeParse(wrongStopKind).success, false);

  const duplicateTypeSource = withGraph();
  (duplicateTypeSource['graph'] as { typeSources: unknown[] }).typeSources.push({
    sourceId: 'characters',
    defaultTypeId: 'character',
  });
  assert.equal(projectConfigSchema.safeParse(duplicateTypeSource).success, false);

  const unsupportedTypeSource = withGraph();
  (unsupportedTypeSource['graph'] as { typeSources: Array<{ sourceId: string }> }).typeSources[0]!
    .sourceId = 'notes';
  assert.equal(projectConfigSchema.safeParse(unsupportedTypeSource).success, false);

  const noTypeMapping = withGraph();
  (noTypeMapping['graph'] as { typeSources: unknown[] }).typeSources = [{ sourceId: 'characters' }];
  assert.equal(projectConfigSchema.safeParse(noTypeMapping).success, false);

  const emptyAlias = withGraph();
  (emptyAlias['graph'] as { aliases?: object }).aliases = { relations: { source: [] } };
  assert.equal(projectConfigSchema.safeParse(emptyAlias).success, false);

  const unknownKey = withGraph();
  (unknownKey['graph'] as Record<string, unknown>)['proposalQueue'] = true;
  assert.equal(projectConfigSchema.safeParse(unknownKey).success, false);
});

const localVault = process.env['WRITING_STUDIO_LOCAL_VAULT'];
const realProjectConfigPath = localVault
  ? join(localVault, '.writing-studio', 'project.json')
  : '';

test(
  'project config accepts a real local vault project configuration when present',
  { skip: !realProjectConfigPath || !existsSync(realProjectConfigPath) },
  () => {
    const raw: unknown = JSON.parse(readFileSync(realProjectConfigPath, 'utf8'));
    const result = projectConfigSchema.safeParse(raw);
    assert.equal(result.success, true, result.success ? undefined : result.error.message);
  },
);

test('project config rejects unsafe, invalid, or unimplemented config values', () => {
  const unsafePath = validProjectConfig();
  (unsafePath['draftsDir'] as string) = '../outside';
  assert.equal(projectConfigSchema.safeParse(unsafePath).success, false);

  const invalidRegex = validProjectConfig();
  const tree = invalidRegex['contentTree'] as { leaf: { titleStripRegex: string } };
  tree.leaf.titleStripRegex = '[';
  assert.equal(projectConfigSchema.safeParse(invalidRegex).success, false);

  const duplicateId = validProjectConfig();
  const sources = duplicateId['sidebarSources'] as Array<{ id: string }>;
  sources[1]!.id = sources[0]!.id;
  assert.equal(projectConfigSchema.safeParse(duplicateId).success, false);

  const yamlCard = validProjectConfig();
  const yamlSource = (yamlCard['sidebarSources'] as Array<Record<string, unknown>>)[0]!;
  yamlSource['parser'] = 'yaml-card';
  assert.equal(projectConfigSchema.safeParse(yamlCard).success, false);

  const invalidHeadingLevel = validProjectConfig();
  const characterConfig = ((invalidHeadingLevel['sidebarSources'] as Array<Record<string, unknown>>)[2]!
    ['parserConfig'] as { cardHeadingLevel: number });
  characterConfig.cardHeadingLevel = 7;
  assert.equal(projectConfigSchema.safeParse(invalidHeadingLevel).success, false);

  const emptyAlias = validProjectConfig();
  const tableConfig = ((emptyAlias['sidebarSources'] as Array<Record<string, unknown>>)[0]!
    ['parserConfig'] as { columnAliases: { term: string[] } });
  tableConfig.columnAliases.term = [];
  assert.equal(projectConfigSchema.safeParse(emptyAlias).success, false);

  const unknownKey = validProjectConfig();
  unknownKey['unexpected'] = true;
  assert.equal(projectConfigSchema.safeParse(unknownKey).success, false);

  const genericContext = validProjectConfig();
  const genericWriter = (genericContext['aiProfiles'] as {
    writer: { readable: string[]; contextSources?: string[] };
  }).writer;
  genericWriter.readable.push('角色设定.md');
  genericWriter.contextSources = ['characters'];
  assert.equal(projectConfigSchema.safeParse(genericContext).success, true);

  const unknownContext = structuredClone(genericContext);
  ((unknownContext['aiProfiles'] as { writer: { contextSources: string[] } }).writer).contextSources = ['missing'];
  assert.equal(projectConfigSchema.safeParse(unknownContext).success, false);

  const plainContext = structuredClone(genericContext);
  ((plainContext['aiProfiles'] as { writer: { contextSources: string[] } }).writer).contextSources = ['notes'];
  assert.equal(projectConfigSchema.safeParse(plainContext).success, false);

  const unreadableContext = structuredClone(genericContext);
  ((unreadableContext['aiProfiles'] as {
    writer: { readable: string[]; contextSources: string[] };
  }).writer).readable = ['写作状态.md'];
  assert.equal(projectConfigSchema.safeParse(unreadableContext).success, false);

  const forbiddenContext = structuredClone(genericContext);
  ((forbiddenContext['aiProfiles'] as {
    writer: { forbidden: string[]; contextSources: string[] };
  }).writer).forbidden = ['角色*.md'];
  assert.equal(projectConfigSchema.safeParse(forbiddenContext).success, false);

  const foldedForbiddenContext = structuredClone(genericContext);
  ((foldedForbiddenContext['aiProfiles'] as {
    writer: { forbidden: string[]; contextSources: string[] };
  }).writer).forbidden = ['角色设定.MD'];
  assert.equal(projectConfigSchema.safeParse(foldedForbiddenContext).success, false);

  const c1Path = validProjectConfig();
  c1Path['draftsDir'] = 'drafts/\u0085unsafe';
  assert.equal(projectConfigSchema.safeParse(c1Path).success, false);
});

test('write and sidebar request schemas reject incomplete or unexpected input', () => {
  assert.deepEqual(sidebarQuerySchema.parse({}), { view: 'writer' });
  assert.deepEqual(sidebarQuerySchema.parse({ view: 'planner', q: '角色A' }), {
    view: 'planner',
    q: '角色A',
  });
  assert.equal(sidebarQuerySchema.safeParse({ view: 'writer', extra: true }).success, false);

  assert.equal(createDraftRequestSchema.safeParse({ title: '第一稿' }).success, true);
  assert.equal(createDraftRequestSchema.safeParse({ title: ' ', extra: true }).success, false);
  const draft = {
    docId: '草稿/2026-07-23_第一稿.md',
    projectId: 'sample',
    kind: 'draft' as const,
    title: '第一稿',
    chapterNo: null,
    sha256: 'a'.repeat(64),
    bytes: 20,
    mtimeMs: 1,
  };
  assert.deepEqual(documentMetaSchema.parse(draft), draft);
  assert.deepEqual(draftListResponseSchema.parse([draft]), [draft]);
  assert.equal(draftListResponseSchema.safeParse([{ ...draft, extra: true }]).success, false);
  assert.equal(
    createRevisionRequestSchema.safeParse({ kind: 'ai_original', content: '正文' }).success,
    true,
  );
  assert.equal(createRevisionRequestSchema.safeParse({ kind: 'unknown', content: '正文' }).success, false);
  assert.equal(patchThreadRequestSchema.safeParse({}).success, false);
  assert.equal(patchThreadRequestSchema.safeParse({ status: 'resolved' }).success, true);

  assert.deepEqual(postMessageRequestSchema.parse({ content: 'safe', model: 'provider/model-1.2:stable' }), {
    content: 'safe', model: 'provider/model-1.2:stable',
  });
  for (const unsafeModel of ['-x', '--model=evil', 'name with spaces', 'x;rm', 'x'.repeat(121)]) {
    assert.equal(
      postMessageRequestSchema.safeParse({ content: 'safe', model: unsafeModel }).success,
      false,
      unsafeModel,
    );
  }
});

test('chapter generation requests are trimmed and origin is restricted to doc-level rewrites', () => {
  assert.deepEqual(
    createChapterRequestSchema.parse({ title: '  章节标题A  ', dirOverride: '正文/第二部_部名A' }),
    { title: '章节标题A', dirOverride: '正文/第二部_部名A' },
  );
  assert.equal(createChapterRequestSchema.safeParse({ title: 'x'.repeat(61) }).success, false);
  assert.equal(createChapterRequestSchema.safeParse({ title: ' ', dirOverride: '../正文' }).success, false);

  const base = {
    projectId: 'sample',
    docId: '正文/第1章.md',
    kind: 'rewrite',
    origin: 'generate',
  };
  assert.equal(createThreadRequestSchema.safeParse(base).success, true);
  assert.equal(createThreadRequestSchema.safeParse({ ...base, profile: 'writer' }).success, true);
  assert.equal(createThreadRequestSchema.safeParse({ ...base, profile: 'planner' }).success, false);
  assert.equal(createThreadRequestSchema.safeParse({ ...base, kind: 'ask' }).success, false);
  assert.equal(createThreadRequestSchema.safeParse({
    ...base,
    anchor: {
      docSha: 'a'.repeat(64),
      start: 0,
      end: 1,
      prefix: '',
      exact: 'x',
      suffix: '',
    },
  }).success, false);
});

test('chapter title rename contract is additive, strict, and single-line', () => {
  const sha = 'a'.repeat(64);
  assert.deepEqual(
    renameChapterTitleRequestSchema.parse({ title: '  章节标题A  ', baseSha256: sha }),
    { title: '章节标题A', baseSha256: sha },
  );
  for (const title of ['', 'x'.repeat(61), '上\n下', '上\u2028下', '上\u2029下']) {
    assert.equal(
      renameChapterTitleRequestSchema.safeParse({ title, baseSha256: sha }).success,
      false,
      JSON.stringify(title),
    );
  }
  const doc = {
    docId: '正文/第1章.md',
    projectId: 'sample',
    kind: 'chapter' as const,
    title: '章节标题A',
    chapterNo: 1,
    sha256: sha,
    bytes: 12,
    mtimeMs: 1,
  };
  assert.deepEqual(renameChapterTitleResponseSchema.parse({ sha256: sha, doc }), {
    sha256: sha,
    doc,
  });
  assert.equal(
    renameChapterTitleResponseSchema.safeParse({ sha256: sha, doc, extra: true }).success,
    false,
  );
});

test('chat persona accepts an optional positive memory cutoff chapter', () => {
  const base = {
    projectId: 'sample',
    docId: '角色设定.md',
    kind: 'chat',
    persona: { characterName: '角色A' },
  };
  assert.deepEqual(createThreadRequestSchema.parse(base).persona, {
    characterName: '角色A',
  });
  assert.deepEqual(
    createThreadRequestSchema.parse({
      ...base,
      persona: { characterName: '角色A', memoryCutoffChapter: 75 },
    }).persona,
    { characterName: '角色A', memoryCutoffChapter: 75 },
  );
  for (const memoryCutoffChapter of [0, -1, 1.5]) {
    assert.equal(createThreadRequestSchema.safeParse({
      ...base,
      persona: { characterName: '角色A', memoryCutoffChapter },
    }).success, false);
  }
});

test('conflict checks are ask-only and findings require verifiable canon citations', () => {
  const checkThread = {
    projectId: 'sample',
    docId: '正文/第1章.md',
    kind: 'ask',
    origin: 'check',
  };
  assert.equal(createThreadRequestSchema.safeParse(checkThread).success, true);
  assert.equal(createThreadRequestSchema.safeParse({ ...checkThread, kind: 'rewrite' }).success, false);
  assert.equal(createThreadRequestSchema.safeParse({ ...checkThread, kind: 'chat' }).success, false);
  assert.equal(createThreadRequestSchema.safeParse({ ...checkThread, profile: 'planner' }).success, false);
  assert.deepEqual(
    conflictCheckRequestSchema.parse({ agentId: 'claude', model: 'claude-sonnet-4-6' }),
    { agentId: 'claude', model: 'claude-sonnet-4-6' },
  );
  assert.equal(conflictCheckRequestSchema.safeParse({ extra: true }).success, false);

  const response = {
    findings: [{
      claimInText: '角色C从未离开故乡。',
      textQuote: '她这一生从未踏出过故乡。',
      canonSource: { docId: '角色设定.md', heading: '角色C / 经历' },
      conflictType: 'character',
      severity: 'high',
      explanation: '角色卡记载她曾前往地点A。',
    }],
  };
  assert.equal(conflictCheckResponseSchema.safeParse(response).success, true);
  assert.equal(conflictCheckResponseSchema.safeParse({ findings: [] }).success, true);
  assert.equal(conflictCheckResponseSchema.safeParse({
    findings: [{ ...response.findings[0], severity: 'critical' }],
  }).success, false);
  assert.equal(conflictCheckResponseSchema.safeParse({
    findings: [{ ...response.findings[0], canonSource: { docId: '../秘密.md', heading: '' } }],
  }).success, false);
  assert.equal(conflictCheckResponseSchema.safeParse({
    findings: [{ ...response.findings[0], extra: true }],
  }).success, false);
});

test('canon repair threads are double-bound to an anchored writer-visible heading path', () => {
  const anchor = {
    docSha: 'a'.repeat(64),
    start: 10,
    end: 30,
    prefix: 'before',
    exact: '### 身份\n公开事实。\n',
    suffix: 'after',
  };
  const request = {
    projectId: 'sample',
    docId: '角色设定.md',
    kind: 'rewrite',
    origin: 'canon',
    profile: 'writer',
    anchor,
    headingPath: ['角色C', '身份'],
    evidence: {
      docId: '正文/第1章.md',
      textQuote: '她第一次越过了地点A。',
    },
  };
  assert.equal(createThreadRequestSchema.safeParse(request).success, true);
  assert.equal(createThreadRequestSchema.safeParse({ ...request, anchor: undefined }).success, false);
  assert.equal(createThreadRequestSchema.safeParse({ ...request, headingPath: undefined }).success, false);
  assert.equal(createThreadRequestSchema.safeParse({ ...request, kind: 'ask' }).success, false);
  assert.equal(createThreadRequestSchema.safeParse({ ...request, profile: 'planner' }).success, false);
  assert.equal(createThreadRequestSchema.safeParse({
    ...request,
    origin: undefined,
  }).success, false);
});

test('WorldGraph query and DTO schemas preserve fail-closed defaults and projection invariants', () => {
  assert.deepEqual(graphQuerySchema.parse({}), { view: 'writer' });
  assert.deepEqual(graphSourceQuerySchema.parse({ heading: 'Evidence' }), {
    view: 'writer',
    heading: 'Evidence',
  });
  assert.equal(graphQuerySchema.safeParse({ view: 'planner', extra: true }).success, false);

  const stopPoint = {
    docId: 'manuscript/Part-1_Beginning/Chapter-1.md',
    order: 0,
    label: 'Chapter 1',
    chapterNo: 1,
  };
  const snapshot: WorldGraphSnapshot = {
    view: 'writer',
    version: 'a'.repeat(64),
    stopState: 'resolved',
    stopPoint,
    storyPoints: [stopPoint],
    nodeTypes: [{ id: 'character', name: 'Character', visualFamily: 'character' }],
    relationTypes: [],
    nodes: [{
      id: 'char:writer',
      name: 'The Writer',
      aliases: [],
      typeId: 'character',
      activeFrom: '@start',
      revealedAt: stopPoint,
      inactiveFrom: null,
      visibility: 'public',
      confidence: 'confirmed',
      sources: [{ docId: stopPoint.docId, heading: null, label: 'Chapter 1' }],
      implicit: false,
    }],
    edges: [],
    counts: { nodeTypes: 1, relationTypes: 0, nodes: 1, edges: 0 },
    diagnostics: [],
    diagnosticCount: 0,
  };
  assert.equal(worldGraphSnapshotSchema.safeParse(snapshot).success, true);

  const missingWriterStop = structuredClone(snapshot);
  missingWriterStop.stopPoint = null;
  assert.equal(worldGraphSnapshotSchema.safeParse(missingWriterStop).success, false);

  const writerUnset = structuredClone(snapshot);
  writerUnset.stopState = 'unset';
  writerUnset.stopPoint = null;
  writerUnset.storyPoints = [];
  writerUnset.nodeTypes = [];
  writerUnset.relationTypes = [];
  writerUnset.nodes = [];
  writerUnset.edges = [];
  writerUnset.counts = { nodeTypes: 0, relationTypes: 0, nodes: 0, edges: 0 };
  assert.equal(worldGraphSnapshotSchema.safeParse(writerUnset).success, true);

  const writerUnsetWithNode = structuredClone(writerUnset);
  writerUnsetWithNode.nodeTypes = structuredClone(snapshot.nodeTypes);
  writerUnsetWithNode.nodes = structuredClone(snapshot.nodes);
  writerUnsetWithNode.counts = { nodeTypes: 1, relationTypes: 0, nodes: 1, edges: 0 };
  assert.equal(worldGraphSnapshotSchema.safeParse(writerUnsetWithNode).success, false);

  const writerUnsetWithTypeCatalog = structuredClone(writerUnset);
  writerUnsetWithTypeCatalog.nodeTypes = structuredClone(snapshot.nodeTypes);
  writerUnsetWithTypeCatalog.counts = {
    ...writerUnset.counts,
    nodeTypes: writerUnsetWithTypeCatalog.nodeTypes.length,
  };
  assert.equal(worldGraphSnapshotSchema.safeParse(writerUnsetWithTypeCatalog).success, false);

  const plannerUnset = structuredClone(snapshot);
  plannerUnset.view = 'planner';
  plannerUnset.stopState = 'unset';
  plannerUnset.stopPoint = null;
  assert.equal(worldGraphSnapshotSchema.safeParse(plannerUnset).success, true);

  const plannerUnsetWithStop = structuredClone(plannerUnset);
  plannerUnsetWithStop.stopPoint = stopPoint;
  assert.equal(worldGraphSnapshotSchema.safeParse(plannerUnsetWithStop).success, false);

  const futurePoint = {
    docId: 'manuscript/Part-1_Beginning/Chapter-2.md',
    order: 1,
    label: 'Chapter 2',
    chapterNo: 2,
  };
  const writerSafetyMutations: Array<(candidate: typeof snapshot) => void> = [
    (candidate) => { candidate.nodes[0]!.visibility = 'authorOnly'; },
    (candidate) => { candidate.nodes[0]!.confidence = 'question'; },
    (candidate) => { candidate.nodes[0]!.implicit = true; },
    (candidate) => { candidate.nodes[0]!.activeFrom = null; },
    (candidate) => { candidate.nodes[0]!.revealedAt = futurePoint; },
    (candidate) => { candidate.nodes[0]!.inactiveFrom = futurePoint; },
    (candidate) => { candidate.storyPoints.push(futurePoint); },
    (candidate) => {
      candidate.storyPoints.push({ ...futurePoint, order: stopPoint.order });
    },
    (candidate) => {
      candidate.nodeTypes = [];
      candidate.counts.nodeTypes = 0;
    },
    (candidate) => {
      candidate.nodeTypes.push({ id: 'secret', name: 'Future type', visualFamily: 'unknown' });
      candidate.counts.nodeTypes = 2;
    },
    (candidate) => {
      candidate.edges.push({
        id: 'rel:hidden-type',
        sourceId: 'char:writer',
        relationTypeId: 'secret-relation',
        targetId: 'char:writer',
        activeFrom: '@start',
        revealedAt: stopPoint,
        inactiveFrom: null,
        visibility: 'public',
        confidence: 'confirmed',
        sources: [],
      });
      candidate.counts.edges = 1;
    },
    (candidate) => {
      candidate.diagnostics.push({
        code: 'ORPHAN_NODE',
        severity: 'warning',
        entityKind: 'node',
        entityId: 'char:writer',
        file: '关系网.md',
        line: 1,
        tableRow: 1,
        message: 'planner-only diagnostic',
      });
      candidate.diagnosticCount = 1;
    },
  ];
  for (const mutate of writerSafetyMutations) {
    const unsafeWriter = structuredClone(snapshot);
    mutate(unsafeWriter);
    assert.equal(worldGraphSnapshotSchema.safeParse(unsafeWriter).success, false);
  }

  const staleCounts = structuredClone(snapshot);
  staleCounts.counts.nodes = 2;
  assert.equal(worldGraphSnapshotSchema.safeParse(staleCounts).success, false);

  assert.equal(graphSourceExcerptSchema.safeParse({
    source: { docId: stopPoint.docId, heading: 'Evidence', label: null },
    markdown: 'A bounded excerpt.',
    truncated: false,
  }).success, true);
  for (const unsafeDocId of [
    'private//secret.md',
    'private/./secret.md',
    'private\\secret.md',
    'private/a\nb.md',
    'private/a\u0085b.md',
  ]) {
    assert.equal(graphSourceExcerptSchema.safeParse({
      source: { docId: unsafeDocId, heading: 'Evidence', label: null },
      markdown: 'must not cross the boundary',
      truncated: false,
    }).success, false, unsafeDocId);
  }

  assert.ok(DEFAULT_GRAPH_MARKDOWN_ALIASES.sections.relations.includes('关系'));
  assert.ok(DEFAULT_GRAPH_MARKDOWN_ALIASES.relations.revealedAt.includes('Revealed at'));
});

test('durable Run DTO exposes only recoverable public terminal state', () => {
  const run: Run = {
    id: 'run-1', projectId: 'sample', threadId: 'thread-1', agentId: 'echo',
    status: 'failed', errorCode: 'process_error', errorDetail: 'CLI detail',
    modelId: 'claude-sonnet-test', createdAt: 1, finishedAt: 2,
  };
  assert.deepEqual(run, {
    id: 'run-1', projectId: 'sample', threadId: 'thread-1', agentId: 'echo',
    status: 'failed', errorCode: 'process_error', errorDetail: 'CLI detail',
    modelId: 'claude-sonnet-test', createdAt: 1, finishedAt: 2,
  });
});

test('draft delete params and response preserve encoded relative-path recovery data', () => {
  assert.equal(deleteDraftParamsSchema.safeParse({
    pid: 'sample',
    docId: '草稿/2026-07-23_片段.md',
  }).success, true);
  assert.equal(deleteDraftParamsSchema.safeParse({
    pid: 'sample',
    docId: '../正文/第1章.md',
  }).success, false);
  assert.equal(deleteDraftResponseSchema.safeParse({
    docId: '草稿/2026-07-23_片段.md',
    trashedDocId: '草稿/.trash/2026-07-23T00:00:00.000Z_2026-07-23_片段.md',
  }).success, true);
});

test('trash list and restore schemas preserve additive recovery metadata', () => {
  const entry = {
    trashedDocId: '草稿/.trash/2026-07-23T00:00:00.000Z_2026-07-23_片段.md',
    originalName: '2026-07-23_片段.md',
    deletedAt: '2026-07-23T00:00:00.000Z',
    title: '片段',
  };
  assert.equal(trashEntrySchema.safeParse(entry).success, true);
  assert.equal(trashListResponseSchema.safeParse([entry]).success, true);
  assert.equal(restoreDraftParamsSchema.safeParse({
    pid: 'sample',
    docId: entry.trashedDocId,
  }).success, true);
  assert.equal(restoreDraftResponseSchema.safeParse({
    trashedDocId: entry.trashedDocId,
    docId: '草稿/2026-07-23_片段.md',
  }).success, true);
});
