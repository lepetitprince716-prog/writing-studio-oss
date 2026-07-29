import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Project, ProjectConfig } from '@writing-studio/contract';
import { WorldGraphModule } from '../src/graph/index.js';
import { SidebarService } from '../src/sidebar/index.js';

const RELATIONS_FILE = '关系网.md';

function graphMarkdown(nodeRows: string[], edgeRows: string[] = []): string {
  return [
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
    '',
    '## 节点',
    '| ID | 名称 | 别名 | 类型 | 生效章 | 揭示章 | 失效章 | 可见性 | 置信 | 出处 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...nodeRows,
    '',
    '## 关系',
    '| ID | 源 | 关系 | 目标 | 生效章 | 揭示章 | 失效章 | 可见性 | 置信 | 出处 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...edgeRows,
  ].join('\n');
}

interface Fixture {
  root: string;
  project: Project;
}

function makeFixture(graph: string, status: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'writing-studio-graph-security-'));
  const vaultRoot = join(root, 'vault');
  const dataDir = join(root, 'data');
  mkdirSync(join(vaultRoot, '.writing-studio'), { recursive: true });
  mkdirSync(join(vaultRoot, '正文'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const config: ProjectConfig = {
    schemaVersion: 1,
    id: 'graph-security',
    displayName: 'Graph Security',
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
        readable: ['正文/**', RELATIONS_FILE],
        forbidden: [],
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

  for (const chapterNo of [1, 2, 3]) {
    writeFileSync(
      join(vaultRoot, '正文', `第${chapterNo}章.md`),
      `# 第${chapterNo}章：测试\n\n正文。\n`,
    );
  }
  writeFileSync(join(vaultRoot, '.writing-studio', 'project.json'), JSON.stringify(config));
  writeFileSync(join(vaultRoot, RELATIONS_FILE), graph);
  writeFileSync(join(vaultRoot, '状态.md'), status);

  return {
    root,
    project: { config, vaultRoot, dataDir },
  };
}

test('writer stop point ignores chapter wikilinks inside fenced code', () => {
  const graph = graphMarkdown([
    '| char:past | 已揭示 | | character | @start | 1 | | public | confirmed | |',
    '| char:future | 未来 | | character | @start | 3 | | public | confirmed | |',
  ]);
  const fixture = makeFixture(graph, [
    '> 最后刷新：今天；对应停点第2章',
    '',
    '## 停点',
    '以下只是格式示例：',
    '```md',
    '[[正文/第3章.md]]',
    '```',
  ].join('\n'));
  try {
    const writer = new WorldGraphModule(new SidebarService()).getSnapshot(fixture.project, 'writer');
    assert.equal(writer.stopPoint?.chapterNo, 2);
    assert.deepEqual(writer.nodes.map((node) => node.id), ['char:past']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an invalid inactiveFrom never becomes an open-ended writer entity', () => {
  const graph = graphMarkdown([
    '| char:good | 正常 | | character | @start | 1 | | public | confirmed | |',
    '| char:target | 目标 | | character | @start | 1 | | public | confirmed | |',
    '| char:bad | 无效失效章 | | character | @start | 1 | 999 | public | confirmed | |',
  ], [
    '| rel:bad | @char:good | ally | @char:target | @start | 1 | 999 | public | confirmed | |',
  ]);
  const fixture = makeFixture(graph, '> 最后刷新：今天；对应停点第2章\n\n## 停点\n当前停点。\n');
  try {
    const module = new WorldGraphModule(new SidebarService());
    const planner = module.getSnapshot(fixture.project, 'planner');
    const writer = module.getSnapshot(fixture.project, 'writer');
    assert.equal(planner.nodes.some((node) => node.id === 'char:bad'), true);
    assert.equal(planner.edges.some((edge) => edge.id === 'rel:bad'), true);
    assert.equal(planner.diagnostics.some((item) => item.code === 'INVALID_STORY_POINT'), true);
    assert.deepEqual(writer.nodes.map((node) => node.id), ['char:good', 'char:target']);
    assert.deepEqual(writer.edges, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a bare endpoint is rejected when an ID and a name are both candidates', () => {
  const graph = graphMarkdown([
    '| char:alpha | 阿尔法 | | character | @start | 1 | | public | confirmed | |',
    '| char:collision | char:alpha | | character | @start | 1 | | public | confirmed | |',
    '| char:target | 目标 | | character | @start | 1 | | public | confirmed | |',
  ], [
    '| rel:ambiguous | char:alpha | ally | @char:target | @start | 1 | | public | confirmed | |',
  ]);
  const fixture = makeFixture(graph, '> 最后刷新：今天；对应停点第2章\n\n## 停点\n当前停点。\n');
  try {
    const planner = new WorldGraphModule(new SidebarService()).getSnapshot(fixture.project, 'planner');
    assert.deepEqual(planner.edges, []);
    assert.equal(planner.diagnostics.some((item) => item.code === 'AMBIGUOUS_NAME'), true);
    assert.equal(planner.diagnostics.some((item) =>
      item.code === 'AMBIGUOUS_NAME'
      && item.severity === 'error'
      && item.entityKind === 'edge'
      && item.entityId === 'rel:ambiguous'), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('diagnostic cap keeps a late stop-point error ahead of orphan noise', () => {
  const rows = Array.from({ length: 205 }, (_, index) =>
    `| node:${index} | Node ${index} | | character | @start | 1 | | public | confirmed | |`,
  );
  const fixture = makeFixture(
    graphMarkdown(rows),
    '> 最后刷新：今天；未配置停点\n\n## 停点\n当前停点未知。\n',
  );
  try {
    const planner = new WorldGraphModule(new SidebarService()).getSnapshot(fixture.project, 'planner');
    assert.equal(planner.diagnosticCount, 206);
    assert.equal(planner.diagnostics.length, 200);
    assert.equal(planner.diagnostics.some((item) => item.code === 'INVALID_STORY_POINT'), true);
    assert.equal(
      planner.diagnostics.filter((item) => item.code === 'ORPHAN_NODE').length,
      199,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
