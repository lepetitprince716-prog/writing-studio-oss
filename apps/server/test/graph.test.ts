import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import chokidar from 'chokidar';
import { json } from './support/http-helpers.js';
import {
  type Project,
  type ProjectConfig,
  projectConfigSchema,
  worldGraphSnapshotSchema,
} from '@writing-studio/contract';
import { buildApp } from '../src/app.js';
import { WorldGraphModule } from '../src/graph/index.js';
import { SidebarService } from '../src/sidebar/index.js';
import { tcpListenerSkipReason } from './support/tcp-probe.js';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

// Probe whether chokidar can observe filesystem events in this environment
// (same pattern as apps/server/test/ws-watch.test.ts). The graph-watcher
// tests below register a skip reason at registration time when it cannot.
let graphWatchSkipReason: string | false = false;
{
  const probeDir = mkdtempSync(join(tmpdir(), 'graph-watch-probe-'));
  const watcherOk = await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    const watcher = chokidar.watch(probeDir, { ignoreInitial: true });
    watcher.on('error', () => settle(false));
    setTimeout(() => { watcher.close().then(() => settle(true), () => settle(false)); }, 50);
  });
  rmSync(probeDir, { recursive: true, force: true });
  if (!watcherOk) {
    graphWatchSkipReason = 'chokidar watcher probe failed in this environment';
  }
}
const tcpListenSkipReason = await tcpListenerSkipReason();

const PROJECT_ID = 'graph-project';
const RELATIONS_FILE = '关系网.md';

const GRAPH_MARKDOWN = [
  '# 关系网',
  '',
  '## 节点类型',
  '| ID | 名称 | 视觉族 |',
  '| --- | --- | --- |',
  '| character | 人物 | character |',
  '',
  '## 关系类型',
  '| ID | 名称 | 视觉族 | 有向 | 反向名称 |',
  '| --- | --- | --- | --- | --- |',
  '| ally | 盟友 | custom | false | 盟友 |',
  '| enemy | 敌对 | custom | true | 敌视者 |',
  '',
  '## 节点',
  '| ID | 名称 | 别名 | 类型 | 生效章 | 揭示章 | 失效章 | 可见性 | 置信 | 出处 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| char:a | 阿尔法 | A | character | @start | 1 | | public | confirmed | [[公开.md#证据]]；[[公开.md#证据]]；[[公开.md#\\|空标题]]；[[公开.md#假标题]]；[[秘密.md#秘密]]；[[正文/第3章.md#第3章：未来标题]] |',
  '| char:b | 贝塔 | B | character | @start | 2 | | public | confirmed | [[公开.md#证据\\|公开证据]] |',
  '| char:secret | 秘密人物 | | character | @start | 1 | | authorOnly | confirmed | [[秘密.md#秘密]] |',
  '| char:future | 未来人物 | | character | @start | 3 | | public | confirmed | [[正文/第3章.md#第3章：未来标题]] |',
  '',
  '## 关系',
  '| ID | 源 | 关系 | 目标 | 生效章 | 揭示章 | 失效章 | 可见性 | 置信 | 出处 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| rel:public | @char:a | ally | @char:b | 2 | 2 | 3 | public | confirmed | [[正文/第2章.md#第2章：第二标题]] |',
  '| rel:secret | @char:a | enemy | @char:secret | 1 | 1 | | authorOnly | confirmed | [[秘密.md#秘密]] |',
  '| rel:future | @char:a | ally | @char:future | 3 | 3 | | public | confirmed | [[正文/第3章.md#第3章：未来标题]] |',
  '| rel:guess | @char:a | ally | @char:b | 1 | 1 | | public | inferred | [[公开.md#证据]] |',
  '| rel:implicit | @char:a | ally | 未登记端点 | 1 | 1 | | public | confirmed | [[公开.md#证据]] |',
].join('\n');

function config(stopChapter = 2): ProjectConfig {
  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    displayName: 'Graph Project',
    contentTree: {
      root: '正文',
      levels: [],
      leaf: {
        filePattern: '第{num}章.md',
        numberStyle: 'arabic',
        numberingScope: 'book',
        titleStripRegex: '^第\\d+章[：:]?\\s*',
      },
    },
    draftsDir: '草稿',
    sidebarSources: [{
      id: 'writing_status',
      label: '状态',
      file: '状态.md',
      order: 1,
      parser: 'heading-sections',
      parserConfig: {
        kind: 'writingStatus',
        lastRefreshedRegex: '最后刷新：([^；]+)',
        stopChapterRegex: '停点第(\\d+)章',
      },
    }],
    graph: {
      schemaVersion: 1,
      relationsFile: RELATIONS_FILE,
      stopSourceId: 'writing_status',
    },
    aiProfiles: {
      writer: {
        description: 'writer',
        readable: ['正文/**', '公开.md', RELATIONS_FILE],
        forbidden: ['秘密.md'],
        allowVaultBrowsing: false,
      },
      planner: {
        description: 'planner',
        readable: ['**'],
        forbidden: [],
        allowVaultBrowsing: true,
      },
      defaultProfile: 'writer',
    },
    defaultAgentId: 'echo',
  };
}

interface Fixture {
  root: string;
  dataDir: string;
  registryPath: string;
  vaultRoot: string;
  project: Project;
}

function makeFixture(options: { stopChapter?: number; graphMarkdown?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'writing-studio-graph-'));
  const dataDir = join(root, 'data');
  const vaultRoot = join(root, 'vault');
  const cfg = config(options.stopChapter ?? 2);
  mkdirSync(join(vaultRoot, '.writing-studio'), { recursive: true });
  mkdirSync(join(vaultRoot, '正文'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(vaultRoot, '.writing-studio', 'project.json'), JSON.stringify(cfg));
  for (const chapterNo of [1, 2, 3]) {
    writeFileSync(
      join(vaultRoot, '正文', `第${chapterNo}章.md`),
      `# 第${chapterNo}章：${chapterNo === 1 ? '第一标题' : chapterNo === 2 ? '第二标题' : '未来标题'}\n\n正文 ${chapterNo}。\n`,
    );
  }
  writeFileSync(join(vaultRoot, '状态.md'), `> 最后刷新：今天；对应停点第${options.stopChapter ?? 2}章\n\n## 停点\n当前停点。\n`);
  writeFileSync(join(vaultRoot, '公开.md'), [
    '```md',
    '# 假标题',
    '```',
    '不应按代码块里的假标题授权。',
    '# 证据',
    '',
    '公开证据。',
    '',
    '# 其他',
    '',
    '不应进入标题摘录。',
    '',
  ].join('\n'));
  writeFileSync(join(vaultRoot, '秘密.md'), '# 秘密\n\n作者秘密。\n');
  writeFileSync(join(vaultRoot, RELATIONS_FILE), options.graphMarkdown ?? GRAPH_MARKDOWN);
  const registryPath = join(dataDir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({
    projects: [{ id: PROJECT_ID, vaultRoot, enabled: true }],
  }));
  return {
    root,
    dataDir,
    registryPath,
    vaultRoot,
    project: { config: cfg, vaultRoot, dataDir: join(dataDir, PROJECT_ID) },
  };
}

test('generic example vault produces contract-valid planner and writer snapshots', () => {
  const vaultRoot = fileURLToPath(new URL('../../../examples/basic-vault/', import.meta.url));
  const dataRoot = mkdtempSync(join(tmpdir(), 'writing-studio-generic-graph-'));
  try {
    const exampleConfig = projectConfigSchema.parse(JSON.parse(
      readFileSync(join(vaultRoot, '.writing-studio', 'project.json'), 'utf8'),
    ));
    const project: Project = {
      config: exampleConfig,
      vaultRoot,
      dataDir: join(dataRoot, exampleConfig.id),
    };
    const module = new WorldGraphModule(new SidebarService());
    const planner = module.getSnapshot(project, 'planner');
    const writer = module.getSnapshot(project, 'writer');

    worldGraphSnapshotSchema.parse(planner);
    worldGraphSnapshotSchema.parse(writer);
    assert.deepEqual(planner.counts, {
      nodeTypes: 2,
      relationTypes: 1,
      nodes: 2,
      edges: 1,
    });
    assert.deepEqual(writer.counts, planner.counts);
    assert.equal(planner.diagnosticCount, 0);
    assert.equal(writer.diagnosticCount, 0);
    assert.notEqual(planner.version, writer.version);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('planner parsing and writer projection keep cache order isolated and remove future/author fields', () => {
  const fixture = makeFixture();
  try {
    const writerFirstModule = new WorldGraphModule(new SidebarService());
    const writer = writerFirstModule.getSnapshot(fixture.project, 'writer');
    worldGraphSnapshotSchema.parse(writer);
    assert.equal(writer.view, 'writer');
    assert.deepEqual(writer.storyPoints.map((point) => point.chapterNo), [1, 2]);
    assert.deepEqual(writer.nodes.map((node) => node.id), ['char:a', 'char:b']);
    assert.deepEqual(writer.edges.map((edge) => edge.id), ['rel:public']);
    assert.equal(writer.edges[0]?.inactiveFrom, null, 'future inactiveFrom must be redacted');
    assert.deepEqual(writer.nodes[0]?.sources.map((source) => source.docId), ['公开.md']);
    assert.equal(writer.nodes.find((node) => node.id === 'char:b')?.sources[0]?.label, '公开证据');
    assert.deepEqual(writer.diagnostics, []);
    assert.equal(writer.diagnosticCount, 0);
    assert.equal(JSON.stringify(writer).includes('秘密'), false);

    // A caller cannot mutate the cached snapshot returned by the Module.
    writer.nodes[0]!.name = 'mutated by caller';
    assert.equal(writerFirstModule.getSnapshot(fixture.project, 'writer').nodes[0]?.name, '阿尔法');

    const plannerAfterWriter = writerFirstModule.getSnapshot(fixture.project, 'planner');
    worldGraphSnapshotSchema.parse(plannerAfterWriter);
    assert.equal(plannerAfterWriter.nodes.some((node) => node.name === '秘密人物'), true);
    assert.equal(plannerAfterWriter.nodes.some((node) => node.name === '未来人物'), true);
    assert.equal(plannerAfterWriter.edges.some((edge) => edge.id === 'rel:secret'), true);
    assert.equal(plannerAfterWriter.edges.some((edge) => edge.id === 'rel:future'), true);
    assert.equal(plannerAfterWriter.diagnostics.some((item) => item.code === 'IMPLICIT_NODE'), true);
    assert.equal(plannerAfterWriter.diagnostics.some((item) => item.code === 'SOURCE_HEADING_NOT_FOUND'), true);
    assert.equal(
      plannerAfterWriter.nodes.find((node) => node.id === 'char:a')?.sources.some((source) => source.docId === '正文/第3章.md'),
      true,
    );
    assert.notEqual(plannerAfterWriter.version, writerFirstModule.getSnapshot(fixture.project, 'writer').version);

    const plannerFirstModule = new WorldGraphModule(new SidebarService());
    const plannerFirst = plannerFirstModule.getSnapshot(fixture.project, 'planner');
    const writerAfterPlanner = plannerFirstModule.getSnapshot(fixture.project, 'writer');
    assert.equal(plannerFirst.version, plannerAfterWriter.version);
    assert.equal(writerAfterPlanner.version, writerFirstModule.getSnapshot(fixture.project, 'writer').version);

    // Evidence files are cache dependencies even though they are not watched
    // graph inputs. A heading change must invalidate diagnostics and version.
    writeFileSync(join(fixture.vaultRoot, '公开.md'), '# 已改名\n\n证据移动。\n');
    const afterEvidenceChange = writerFirstModule.getSnapshot(fixture.project, 'planner');
    assert.notEqual(afterEvidenceChange.version, plannerAfterWriter.version);
    assert.equal(
      afterEvidenceChange.diagnostics.some((item) => item.code === 'SOURCE_HEADING_NOT_FOUND'),
      true,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('non-canonical source docIds cannot bypass writer forbidden paths or authorize excerpts', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    mkdirSync(join(fixture.vaultRoot, 'private'), { recursive: true });
    writeFileSync(join(fixture.vaultRoot, 'private', 'Secret.md'), '# 秘密\n\n不得泄漏。\n');
    symlinkSync('Secret.md', join(fixture.vaultRoot, 'private', 'link.md'));
    const caseAlias = existsSync(join(fixture.vaultRoot, 'private', 'secret.md'))
      ? 'private/secret.md'
      : 'private/Secret.md';
    const graphMarkdown = GRAPH_MARKDOWN.replace(
      '[[公开.md#证据\\|公开证据]] |',
      [
        '[[公开.md#证据\\|公开证据]]',
        `[[${caseAlias.replace('/', '//')}#秘密]]`,
        `[[${caseAlias.replace('/', '/./')}#秘密]]`,
        `[[${caseAlias}#秘密]]`,
        '[[private/link.md#秘密]]',
      ].join('；') + ' |',
    );
    writeFileSync(join(fixture.vaultRoot, RELATIONS_FILE), graphMarkdown);
    fixture.project.config.aiProfiles.writer.readable = [
      '正文/**',
      '公开.md',
      'private/**',
      RELATIONS_FILE,
    ];
    fixture.project.config.aiProfiles.writer.forbidden = ['private/secret.md'];
    writeFileSync(
      join(fixture.vaultRoot, '.writing-studio', 'project.json'),
      JSON.stringify(fixture.project.config),
    );

    const module = new WorldGraphModule(new SidebarService());
    const planner = module.getSnapshot(fixture.project, 'planner');
    worldGraphSnapshotSchema.parse(planner);
    assert.equal(
      planner.diagnostics.filter((item) =>
        item.code === 'SOURCE_NOT_FOUND'
        && item.message.includes('canonical vault-relative POSIX docId')).length,
      2,
      JSON.stringify(planner.diagnostics),
    );
    assert.equal(JSON.stringify(planner).includes(caseAlias.replace('/', '//')), false);
    assert.equal(JSON.stringify(planner).includes(caseAlias.replace('/', '/./')), false);
    assert.equal(JSON.stringify(planner).includes('private/link.md'), false);
    assert.equal(
      planner.nodes.find((node) => node.id === 'char:b')?.sources
        .some((source) => source.docId === 'private/Secret.md'),
      true,
    );

    const writer = module.getSnapshot(fixture.project, 'writer');
    worldGraphSnapshotSchema.parse(writer);
    assert.equal(JSON.stringify(writer).includes('private'), false);

    app = await buildApp({
      dataDir: fixture.dataDir,
      registryPath: fixture.registryPath,
      watchSidebar: false,
    });
    for (const docId of [
      caseAlias.replace('/', '//'),
      caseAlias.replace('/', '/./'),
      caseAlias,
      'private/Secret.md',
      'private/link.md',
      'private\\Secret.md',
    ]) {
      const excerpt: InjectResponse = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJECT_ID}/sources/${encodeURIComponent(docId)}?heading=${encodeURIComponent('秘密')}`,
      });
      assert.equal(excerpt.statusCode, 404, docId);
    }

    const publicSourceUrl =
      `/api/projects/${PROJECT_ID}/sources/${encodeURIComponent('公开.md')}?heading=${encodeURIComponent('证据')}`;
    const publicBeforeReplacement = await app.inject({ method: 'GET', url: publicSourceUrl });
    assert.equal(publicBeforeReplacement.statusCode, 200);
    rmSync(join(fixture.vaultRoot, '公开.md'));
    symlinkSync('private/Secret.md', join(fixture.vaultRoot, '公开.md'));
    const publicAfterReplacement = await app.inject({ method: 'GET', url: publicSourceUrl });
    assert.equal(publicAfterReplacement.statusCode, 404, 'a cached source replaced by a symlink fails closed');
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('ambiguous aliases reject the edge and per-level numeric story references never guess', () => {
  const markdown = GRAPH_MARKDOWN
    .replace('| char:b | 贝塔 | B |', '| char:b | 贝塔 | 重名 |')
    .replace('| char:secret | 秘密人物 | |', '| char:secret | 秘密人物 | 重名 |')
    .replace('| rel:guess | @char:a | ally | @char:b | 1 | 1 | | public | inferred |', '| rel:guess | @char:a | ally | 重名 | 1 | 1 | | public | inferred |');
  const fixture = makeFixture({ graphMarkdown: markdown });
  try {
    fixture.project.config.contentTree.leaf.numberingScope = 'perLevel';
    const planner = new WorldGraphModule(new SidebarService()).getSnapshot(fixture.project, 'planner');
    assert.equal(planner.edges.some((edge) => edge.id === 'rel:guess'), false);
    assert.equal(planner.diagnostics.some((item) => item.code === 'AMBIGUOUS_NAME'), true);
    assert.equal(planner.diagnostics.some((item) => item.code === 'INVALID_STORY_POINT'), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('custom section aliases append to built-ins and typeSources use normalized longest section prefixes', () => {
  const markdown = GRAPH_MARKDOWN.replace('## 关系\n', '## Connections\n');
  const fixture = makeFixture({ graphMarkdown: markdown });
  try {
    writeFileSync(join(fixture.vaultRoot, 'settings.md'), [
      '## Places',
      '### Coast',
      '| Term | Source | First | Relation | Status | ID |',
      '| --- | --- | --- | --- | --- | --- |',
      '| Place name | world.md | Chapter 1 | | confirmed | P1 |',
    ].join('\n'));
    writeFileSync(join(fixture.vaultRoot, 'foreshadow.md'), [
      '# Tracker',
      '### F01：Foreshadow title',
      'Content: ringing',
      'Status: open',
    ].join('\n'));
    fixture.project.config.sidebarSources.push({
      id: 'settings',
      label: 'Settings',
      file: 'settings.md',
      order: 2,
      parser: 'markdown-table',
      parserConfig: {
        sectionHeadingLevels: [2, 3],
        columnAliases: {
          term: ['Term'],
          source: ['Source'],
          firstAppearance: ['First'],
          blankLink: ['Relation'],
          status: ['Status'],
          serial: ['ID'],
        },
      },
    });
    fixture.project.config.sidebarSources.push({
      id: 'foreshadow',
      label: 'Foreshadowing',
      file: 'foreshadow.md',
      order: 3,
      parser: 'heading-sections',
      parserConfig: {
        kind: 'foreshadowing',
        itemHeadingLevel: 3,
        itemIdRegex: '^(F\\d+)[：:]\\s*(.+)$',
        statusFieldRegex: 'Status:\\s*(.+)',
      },
    });
    if (!fixture.project.config.graph) throw new Error('graph fixture is missing config');
    fixture.project.config.graph.aliases = { sections: { relations: ['Connections'] } };
    fixture.project.config.graph.typeSources = [
      {
        sourceId: 'settings',
        sectionTypeIds: { '  Places  ': 'place' },
      },
      { sourceId: 'foreshadow', defaultTypeId: 'foreshadow' },
    ];
    const planner = new WorldGraphModule(new SidebarService()).getSnapshot(fixture.project, 'planner');
    assert.equal(planner.edges.some((edge) => edge.id === 'rel:public'), true);
    const place = planner.nodes.find((node) => node.name === 'Place name');
    assert.equal(place?.typeId, 'place');
    assert.equal(place?.implicit, false);
    assert.equal(place?.visibility, 'authorOnly');
    const foreshadow = planner.nodes.find((node) => node.name === 'Foreshadow title');
    assert.equal(foreshadow?.sources[0]?.docId, 'foreshadow.md');
    assert.equal(foreshadow?.sources[0]?.heading, 'F01:Foreshadow title');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('overlong IDs are diagnosed and never escape the contract-valid snapshot', () => {
  const overlongId = `r${'x'.repeat(128)}`;
  const fixture = makeFixture({
    graphMarkdown: GRAPH_MARKDOWN.replace('| rel:public |', `| ${overlongId} |`),
  });
  try {
    const planner = new WorldGraphModule(new SidebarService()).getSnapshot(fixture.project, 'planner');
    worldGraphSnapshotSchema.parse(planner);
    assert.equal(planner.edges.some((edge) => edge.id === overlongId), false);
    assert.equal(planner.diagnostics.some((item) => item.code === 'INVALID_VALUE'), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('structured diagnostics cover missing columns, duplicate IDs, undeclared types, inverted time, safety gaps, and duplicate headings', () => {
  const diagnosticMarkdown = GRAPH_MARKDOWN
    .replace(
      '| char:b | 贝塔 | B | character | @start | 2 | | public | confirmed | [[公开.md#证据\\|公开证据]] |',
      [
        '| char:b | 贝塔 | B | character | @start | 2 | | public | confirmed | [[公开.md#证据\\|公开证据]] |',
        '| char:a | 重复阿尔法 | | character | @start | 1 | | public | confirmed | |',
        '| char:broken-time | 倒置时间 | | mystery | 3 | 1 | 2 | public | confirmed | |',
      ].join('\n'),
    )
    .replace(
      '| rel:guess | @char:a | ally | @char:b | 1 | 1 | | public | inferred | [[公开.md#证据]] |',
      [
        '| rel:unknown-type | @char:a | undocumented | @char:b | 1 | 1 | | public | confirmed | [[公开.md#证据]] |',
        '| rel:missing-safety | @char:a | ally | @char:b | 1 | 1 | | | confirmed | [[公开.md#证据]] |',
      ].join('\n'),
    );
  const fixture = makeFixture({ graphMarkdown: diagnosticMarkdown });
  const missingColumnFixture = makeFixture({
    graphMarkdown: GRAPH_MARKDOWN.replace(
      '| ID | 源 | 关系 | 目标 | 生效章 | 揭示章 | 失效章 | 可见性 | 置信 | 出处 |',
      '| ID | 源 | 关系 | 目标 | 生效章 | 揭示章 | 失效章 | 可见性 | 出处 |',
    ),
  });
  try {
    writeFileSync(join(fixture.vaultRoot, '公开.md'), '# 证据\n\n第一处。\n\n# 证据\n\n第二处。\n');
    const diagnostics = new WorldGraphModule(new SidebarService())
      .getSnapshot(fixture.project, 'planner').diagnostics;
    const codes = new Set(diagnostics.map((item) => item.code));
    assert.equal(codes.has('DUPLICATE_ID'), true);
    assert.equal(codes.has('UNDECLARED_TYPE'), true);
    assert.equal(codes.has('INVERTED_TIME_RANGE'), true);
    assert.equal(codes.has('MISSING_SAFETY_FIELD'), true);
    assert.equal(codes.has('SOURCE_HEADING_AMBIGUOUS'), true);
    assert.equal(
      diagnostics.every((item) => item.file.length > 0 && item.line !== undefined && item.tableRow !== undefined),
      true,
    );

    const missingColumn = new WorldGraphModule(new SidebarService())
      .getSnapshot(missingColumnFixture.project, 'planner');
    assert.equal(missingColumn.diagnostics.some((item) => item.code === 'MISSING_COLUMN'), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(missingColumnFixture.root, { recursive: true, force: true });
  }
});

test('a previously missing evidence file invalidates cached source diagnostics when it appears', () => {
  const fixture = makeFixture({
    graphMarkdown: GRAPH_MARKDOWN.replace(
      '[[公开.md#证据]]；[[公开.md#证据]]',
      '[[公开.md#证据]]；[[后来.md#证据]]',
    ),
  });
  try {
    const module = new WorldGraphModule(new SidebarService());
    const before = module.getSnapshot(fixture.project, 'planner');
    assert.equal(
      before.nodes.find((node) => node.id === 'char:a')?.sources.some((source) => source.docId === '后来.md'),
      false,
    );
    writeFileSync(join(fixture.vaultRoot, '后来.md'), '# 证据\n\n后来补上的证据。\n');
    const after = module.getSnapshot(fixture.project, 'planner');
    assert.notEqual(after.version, before.version);
    assert.equal(
      after.nodes.find((node) => node.id === 'char:a')?.sources.some((source) => source.docId === '后来.md'),
      true,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('graph REST defaults to writer, bounds source excerpts, and relationsFile alone joins document allowlist', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    app = await buildApp({ dataDir: fixture.dataDir, registryPath: fixture.registryPath, watchSidebar: false });
    const defaultGraph = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/graph` });
    assert.equal(defaultGraph.statusCode, 200, defaultGraph.body);
    assert.equal(json(defaultGraph).data.view, 'writer');
    assert.equal(JSON.stringify(json(defaultGraph).data).includes('秘密人物'), false);
    const planner = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/graph?view=planner` });
    assert.equal(planner.statusCode, 200, planner.body);
    assert.equal(JSON.stringify(json(planner).data).includes('秘密人物'), true);

    const source = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/sources/${encodeURIComponent('公开.md')}?heading=${encodeURIComponent('证据')}`,
    });
    assert.equal(source.statusCode, 200, source.body);
    assert.match(json(source).data.markdown, /公开证据/);
    assert.doesNotMatch(json(source).data.markdown, /不应进入/);
    const overBroadSource = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/sources/${encodeURIComponent('公开.md')}`,
    });
    assert.equal(overBroadSource.statusCode, 404, 'a heading ref cannot authorize the whole file');
    const fencedHeading = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/sources/${encodeURIComponent('公开.md')}?heading=${encodeURIComponent('假标题')}`,
    });
    assert.equal(fencedHeading.statusCode, 404, 'a fenced-code hash line is not a Markdown heading');
    const futureSource = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/sources/${encodeURIComponent('正文/第3章.md')}?heading=${encodeURIComponent('第3章：未来标题')}`,
    });
    assert.equal(futureSource.statusCode, 404, 'writer projection cannot authorize a future chapter excerpt');
    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/sources/${encodeURIComponent('秘密.md')}`,
    });
    assert.equal(forbidden.statusCode, 404);

    const relationsPath = `/api/projects/${PROJECT_ID}/documents/${encodeURIComponent(RELATIONS_FILE)}`;
    const relationDocument = await app.inject({ method: 'GET', url: relationsPath });
    assert.equal(relationDocument.statusCode, 200, relationDocument.body);
    const relationBody = json(relationDocument).data;
    const saved = await app.inject({
      method: 'PUT',
      url: relationsPath,
      payload: { content: `${relationBody.content}\n`, baseSha256: relationBody.doc.sha256 },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const stale = await app.inject({
      method: 'PUT',
      url: relationsPath,
      payload: { content: relationBody.content, baseSha256: relationBody.doc.sha256 },
    });
    assert.equal(stale.statusCode, 409);
    const revision = await app.inject({
      method: 'POST',
      url: `${relationsPath}/revisions`,
      payload: { kind: 'manual_snapshot', content: `${relationBody.content}\n`, label: 'graph snapshot' },
    });
    assert.equal(revision.statusCode, 200, revision.body);
    const revisions = await app.inject({ method: 'GET', url: `${relationsPath}/revisions` });
    assert.equal(revisions.statusCode, 200, revisions.body);
    assert.equal(json(revisions).data.length, 1);
    const arbitrary = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/documents/${encodeURIComponent('公开.md')}`,
    });
    assert.equal(arbitrary.statusCode, 400, 'graph sources do not gain document PUT/GET authority');
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('writer endpoint fails closed when the configured stop point is missing', async () => {
  const fixture = makeFixture({ stopChapter: 99 });
  let app: FastifyInstance | undefined;
  try {
    app = await buildApp({ dataDir: fixture.dataDir, registryPath: fixture.registryPath, watchSidebar: false });
    const writer = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/graph` });
    assert.equal(writer.statusCode, 422, writer.body);
    assert.equal(json(writer).error.code, 'GRAPH_STOP_POINT_INVALID');
    const planner = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/graph?view=planner` });
    assert.equal(planner.statusCode, 200, planner.body);
    assert.equal(json(planner).data.stopPoint, null);
    assert.equal(json(planner).data.diagnostics.some((item: { code: string }) => item.code === 'INVALID_STORY_POINT'), true);
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('empty stop-point body is a legal unset state with full planner and empty writer projections', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    writeFileSync(join(fixture.vaultRoot, '状态.md'), [
      '# 写作状态',
      '',
      '## 停点',
      '',
    ].join('\n'));
    app = await buildApp({
      dataDir: fixture.dataDir,
      registryPath: fixture.registryPath,
      watchSidebar: false,
    });

    const plannerResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/graph?view=planner`,
    });
    assert.equal(plannerResponse.statusCode, 200, plannerResponse.body);
    const planner = worldGraphSnapshotSchema.parse(json(plannerResponse).data);
    assert.equal(planner.stopState, 'unset');
    assert.equal(planner.stopPoint, null);
    assert.deepEqual(planner.counts, {
      nodeTypes: 2,
      relationTypes: 2,
      nodes: 5,
      edges: 5,
    });
    assert.deepEqual(
      planner.diagnostics
        .filter((diagnostic) => diagnostic.code === 'STOP_POINT_UNSET')
        .map(({ code, severity }) => ({ code, severity })),
      [{ code: 'STOP_POINT_UNSET', severity: 'warning' }],
    );

    const writerResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/graph?view=writer`,
    });
    assert.equal(writerResponse.statusCode, 200, writerResponse.body);
    const writer = worldGraphSnapshotSchema.parse(json(writerResponse).data);
    assert.equal(writer.stopState, 'unset');
    assert.equal(writer.stopPoint, null);
    assert.deepEqual(writer.storyPoints, []);
    assert.deepEqual(writer.nodeTypes, []);
    assert.deepEqual(writer.relationTypes, []);
    assert.deepEqual(writer.nodes, []);
    assert.deepEqual(writer.edges, []);
    assert.deepEqual(writer.diagnostics, []);
    assert.equal(writer.diagnosticCount, 0);
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('visible prose, comments, and fenced code in the stop-point body remain invalid', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    app = await buildApp({
      dataDir: fixture.dataDir,
      registryPath: fixture.registryPath,
      watchSidebar: false,
    });
    for (const body of [
      '稍后再填写。',
      '<!-- 稍后再填写。 -->',
      ['```md', '稍后再填写。', '```'].join('\n'),
    ]) {
      writeFileSync(join(fixture.vaultRoot, '状态.md'), [
        '# 写作状态',
        '',
        '## 停点',
        body,
      ].join('\n'));
      const writer: InjectResponse = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJECT_ID}/graph?view=writer`,
      });
      assert.equal(writer.statusCode, 422, writer.body);
      assert.equal(json(writer).error.code, 'GRAPH_STOP_POINT_INVALID');
      const planner: InjectResponse = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJECT_ID}/graph?view=planner`,
      });
      assert.equal(planner.statusCode, 200, planner.body);
      assert.equal(json(planner).data.stopState, 'resolved');
      assert.equal(
        json(planner).data.diagnostics.some(
          (diagnostic: { code: string }) => diagnostic.code === 'INVALID_STORY_POINT',
        ),
        true,
      );
    }
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('author-written dangling stop-point wikilink remains fail-closed', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    writeFileSync(join(fixture.vaultRoot, '状态.md'), [
      '# 写作状态',
      '',
      '## 停点',
      '[[正文/第99章.md]]',
    ].join('\n'));
    app = await buildApp({
      dataDir: fixture.dataDir,
      registryPath: fixture.registryPath,
      watchSidebar: false,
    });
    const writer = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/graph?view=writer`,
    });
    assert.equal(writer.statusCode, 422, writer.body);
    assert.equal(json(writer).error.code, 'GRAPH_STOP_POINT_INVALID');
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('numeric stopChapter 99 with an empty body remains resolved-invalid and fail-closed', async () => {
  const fixture = makeFixture({ stopChapter: 99 });
  let app: FastifyInstance | undefined;
  try {
    writeFileSync(join(fixture.vaultRoot, '状态.md'), [
      '> 最后刷新：今天；对应停点第99章',
      '',
      '## 停点',
      '',
    ].join('\n'));
    app = await buildApp({
      dataDir: fixture.dataDir,
      registryPath: fixture.registryPath,
      watchSidebar: false,
    });
    const writer = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/graph?view=writer`,
    });
    assert.equal(writer.statusCode, 422, writer.body);
    assert.equal(json(writer).error.code, 'GRAPH_STOP_POINT_INVALID');
    const planner = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/graph?view=planner`,
    });
    assert.equal(planner.statusCode, 200, planner.body);
    assert.equal(json(planner).data.stopState, 'resolved');
    assert.equal(json(planner).data.stopPoint, null);
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('writer endpoint rejects multiple stop-point wikilinks instead of choosing the first', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    writeFileSync(join(fixture.vaultRoot, '状态.md'), [
      '> 最后刷新：今天；对应停点第2章',
      '',
      '## 停点',
      '[[正文/第3章.md]] 与 [[正文/第2章.md]]',
    ].join('\n'));
    app = await buildApp({ dataDir: fixture.dataDir, registryPath: fixture.registryPath, watchSidebar: false });
    const writer = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/graph` });
    assert.equal(writer.statusCode, 422, writer.body);
    assert.equal(json(writer).error.code, 'GRAPH_STOP_POINT_INVALID');
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('writer endpoint rejects repeated numeric stop markers in the raw stop source', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    writeFileSync(join(fixture.vaultRoot, '状态.md'), [
      '> 最后刷新：今天；对应停点第2章',
      '> 旧副本：对应停点第1章',
      '',
      '## 停点',
      '当前停点。',
    ].join('\n'));
    app = await buildApp({ dataDir: fixture.dataDir, registryPath: fixture.registryPath, watchSidebar: false });
    const writer = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/graph` });
    assert.equal(writer.statusCode, 422, writer.body);
    assert.equal(json(writer).error.code, 'GRAPH_STOP_POINT_INVALID');
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('graph watcher hashes content, suppresses identical writes, and recovers after replacement', { skip: graphWatchSkipReason }, async () => {
  const fixture = makeFixture();
  const module = new WorldGraphModule(new SidebarService());
  const events: number[] = [];
  try {
    module.startWatching(fixture.project, () => events.push(Date.now()));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const relationPath = join(fixture.vaultRoot, RELATIONS_FILE);
    writeFileSync(relationPath, `${GRAPH_MARKDOWN}\n<!-- changed -->\n`);
    await waitFor(() => events.length === 1, 1_000);
    writeFileSync(relationPath, `${GRAPH_MARKDOWN}\n<!-- changed -->\n`);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(events.length, 1);

    rmSync(relationPath);
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(relationPath, `${GRAPH_MARKDOWN}\n<!-- recovered -->\n`);
    await waitFor(() => events.length === 2, 1_000);

    writeFileSync(join(fixture.vaultRoot, '正文', '第2章.md'), '# 第2章：改名后的标题\n\n正文不变。\n');
    await waitFor(() => events.length === 3, 1_000);
  } finally {
    await module.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('graph watcher emits a payload-free graph.updated WebSocket invalidation', { skip: graphWatchSkipReason || tcpListenSkipReason }, async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  let socket: WebSocket | undefined;
  try {
    app = await buildApp({ dataDir: fixture.dataDir, registryPath: fixture.registryPath });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws?projectId=${PROJECT_ID}`);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener('open', () => resolve(), { once: true });
      socket!.addEventListener('error', () => reject(new Error('websocket connection failed')), { once: true });
    });
    const events: unknown[] = [];
    socket.addEventListener('message', (event) => events.push(JSON.parse(String(event.data))));
    await new Promise((resolve) => setTimeout(resolve, 150));
    writeFileSync(join(fixture.vaultRoot, RELATIONS_FILE), `${GRAPH_MARKDOWN}\n<!-- ws -->\n`);
    await waitFor(() => events.length === 1, 1_000);
    assert.deepEqual(events, [{ kind: 'graph.updated', seq: 1 }]);
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket!.addEventListener('close', () => resolve(), { once: true });
        socket!.close();
      });
    }
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('story watcher emits graph.updated over a real WebSocket when an external chapter appears', { skip: graphWatchSkipReason || tcpListenSkipReason }, async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  let socket: WebSocket | undefined;
  try {
    app = await buildApp({ dataDir: fixture.dataDir, registryPath: fixture.registryPath });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws?projectId=${PROJECT_ID}`);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener('open', () => resolve(), { once: true });
      socket!.addEventListener('error', () => reject(new Error('websocket connection failed')), { once: true });
    });
    const events: unknown[] = [];
    socket.addEventListener('message', (event) => events.push(JSON.parse(String(event.data))));
    await new Promise((resolve) => setTimeout(resolve, 150));

    writeFileSync(
      join(fixture.vaultRoot, '正文', '第4章.md'),
      '# 第4章：外部新增\n\n新的正文。\n',
    );

    await waitFor(() => events.length === 1, 1_000);
    assert.deepEqual(events, [{ kind: 'graph.updated', seq: 1 }]);
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket!.addEventListener('close', () => resolve(), { once: true });
        socket!.close();
      });
    }
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('graph watcher recovers a nested relationsFile after its parent directory is replaced', { skip: graphWatchSkipReason }, async () => {
  const fixture = makeFixture();
  const module = new WorldGraphModule(new SidebarService());
  const nestedDir = join(fixture.vaultRoot, 'canon');
  const nestedFile = join(nestedDir, '关系网.md');
  const events: number[] = [];
  try {
    mkdirSync(nestedDir);
    writeFileSync(nestedFile, GRAPH_MARKDOWN);
    if (!fixture.project.config.graph) throw new Error('graph fixture is missing config');
    fixture.project.config.graph.relationsFile = 'canon/关系网.md';
    module.startWatching(fixture.project, () => events.push(Date.now()));
    await new Promise((resolve) => setTimeout(resolve, 150));
    rmSync(nestedDir, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(events.length, 0, 'temporary parent loss is not a graph change until recovery');
    mkdirSync(nestedDir);
    writeFileSync(nestedFile, `${GRAPH_MARKDOWN}\n<!-- recovered parent -->\n`);
    await waitFor(() => events.length === 1, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(events.length, 1);
  } finally {
    await module.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('planner diagnostics are capped without leaking their total into writer projection', () => {
  const nodeRows = Array.from({ length: 205 }, (_, index) =>
    `| node:${index} | Node ${index} | | character | @start | 1 | | public | confirmed | |`,
  );
  const noisyGraph = [
    '# 关系网',
    '## 节点类型',
    '| ID | 名称 | 视觉族 |',
    '| - | - | - |',
    '| character | Character | character |',
    '## 节点',
    '| ID | 名称 | 别名 | 类型 | 生效章 | 揭示章 | 失效章 | 可见性 | 置信 | 出处 |',
    '| - | - | - | - | - | - | - | - | - | - |',
    ...nodeRows,
    '## 关系',
    '| ID | 源 | 关系 | 目标 | 生效章 | 揭示章 | 失效章 | 可见性 | 置信 | 出处 |',
    '| - | - | - | - | - | - | - | - | - | - |',
  ].join('\n');
  const fixture = makeFixture({ graphMarkdown: noisyGraph });
  try {
    const module = new WorldGraphModule(new SidebarService());
    const planner = module.getSnapshot(fixture.project, 'planner');
    assert.equal(planner.diagnostics.length, 200);
    assert.equal(planner.diagnosticCount, 205);
    assert.equal(planner.diagnostics.every((item) => item.code === 'ORPHAN_NODE'), true);

    const writer = module.getSnapshot(fixture.project, 'writer');
    assert.deepEqual(writer.diagnostics, []);
    assert.equal(writer.diagnosticCount, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('server hard graph limit fails loudly before full GFM table parsing', () => {
  const nodeRows = Array.from({ length: 5_001 }, (_, index) =>
    `| node:${index} | Node ${index} | | character | @start | 1 | | public | confirmed | |`,
  );
  const hugeGraph = [
    '# 关系网',
    '## 节点类型',
    '| ID | 名称 | 视觉族 |',
    '| - | - | - |',
    '| character | Character | character |',
    '## 实体节点',
    '| ID | 名称 | 别名 | 类型 | 生效章 | 揭示章 | 失效章 | 可见性 | 置信 | 出处 |',
    '| - | - | - | - | - | - | - | - | - | - |',
    ...nodeRows,
    '## 关系',
    '| ID | 源 | 关系 | 目标 | 生效章 | 揭示章 | 失效章 | 可见性 | 置信 | 出处 |',
    '| - | - | - | - | - | - | - | - | - | - |',
  ].join('\n');
  const fixture = makeFixture({ graphMarkdown: hugeGraph });
  try {
    if (!fixture.project.config.graph) throw new Error('graph fixture is missing config');
    fixture.project.config.graph.aliases = { sections: { nodes: ['实体节点'] } };
    const startedAt = Date.now();
    assert.throws(
      () => new WorldGraphModule(new SidebarService()).getSnapshot(fixture.project, 'planner'),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && (error as Error & { code: string }).code === 'GRAPH_TOO_LARGE',
    );
    assert.ok(Date.now() - startedAt < 4_000, 'oversized graph must fail before full GFM table parsing');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('server relation hard limit fails before full GFM table parsing', () => {
  const relationRows = Array.from({ length: 15_001 }, (_, index) =>
    `| rel:${index} | node:a | knows | node:b | @start | 1 | | public | confirmed | |`,
  );
  const hugeGraph = [
    '# World graph',
    '## Relation Types',
    '| ID | Name | Visual Family | Directed | Reverse Name |',
    '| - | - | - | - | - |',
    '| knows | Knows | custom | true | |',
    '## Edges',
    '| ID | Source | Relation | Target | Active From | Revealed At | Inactive From | Visibility | Confidence | Sources |',
    '| - | - | - | - | - | - | - | - | - | - |',
    ...relationRows,
  ].join('\n');
  const fixture = makeFixture({ graphMarkdown: hugeGraph });
  try {
    const startedAt = Date.now();
    assert.throws(
      () => new WorldGraphModule(new SidebarService()).getSnapshot(fixture.project, 'planner'),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && (error as Error & { code: string }).code === 'GRAPH_TOO_LARGE',
    );
    assert.ok(Date.now() - startedAt < 4_000, 'oversized relations must fail before full GFM table parsing');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for graph watcher');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
