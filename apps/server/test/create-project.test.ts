import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { projectConfigSchema, type ProjectConfig } from '@writing-studio/contract';
import { buildApp } from '../src/app.js';
import {
  createProject,
  type CreateProjectResult,
  ZH_CN_TEMPLATE_REPLACEMENTS,
} from '../src/cli/create-project.js';
import { validateProjectConfig } from '../src/cli/validate-config.js';
import { loadProjects } from '../src/config.js';
import { WorldGraphModule } from '../src/graph/index.js';
import { SidebarService } from '../src/sidebar/index.js';
import { createChapter } from '../src/vault.js';
import { json } from './support/http-helpers.js';
import { withoutRuntimeNoise } from './support/process-helpers.js';

const SERVER_ROOT = resolve(import.meta.dirname, '..');
const BASIC_VAULT = resolve(SERVER_ROOT, '../../examples/basic-vault');

function withTempDir(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'writing-studio-create-project-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readConfig(vaultRoot: string): ProjectConfig {
  return projectConfigSchema.parse(
    JSON.parse(readFileSync(join(vaultRoot, '.writing-studio/project.json'), 'utf8')),
  );
}

test('basic English vault validates cleanly and all six writing-status sections parse', () => {
  const validate = validateProjectConfig(BASIC_VAULT);
  assert.deepEqual(validate, { valid: true, errors: [], warnings: [] });

  const config = readConfig(BASIC_VAULT);
  const payload = new SidebarService().getSource(
    { vaultRoot: BASIC_VAULT, config },
    'writing_status',
    'planner',
  );
  assert.equal(payload?.parser, 'heading-sections');
  assert.equal(payload?.kind, 'writingStatus');
  if (payload?.parser !== 'heading-sections' || payload.kind !== 'writingStatus') return;
  assert.notEqual(payload.data.stopPoint.trim(), '');
  assert.ok(payload.data.storylines.length > 0);
  assert.ok(payload.data.activeForeshadow.length > 0);
  assert.ok(payload.data.characterOneLiners.length > 0);
  assert.ok(payload.data.redLines.length > 0);
  assert.notEqual(payload.data.expressionBaseline.trim(), '');

  const graph = new WorldGraphModule(new SidebarService());
  assert.deepEqual(graph.getSnapshot(
    { vaultRoot: BASIC_VAULT, config, dataDir: join(BASIC_VAULT, '.panel-data') },
    'planner',
  ).diagnostics, []);
  assert.deepEqual(graph.getSnapshot(
    { vaultRoot: BASIC_VAULT, config, dataDir: join(BASIC_VAULT, '.panel-data') },
    'writer',
  ).diagnostics, []);
});

test('createProject scaffolds zh-CN and English vaults, appends registry, and creates localized chapter one', () => {
  withTempDir((root) => {
    const dataDir = join(root, 'data');
    const zhVault = join(root, 'zh-vault');
    const enVault = join(root, 'en-vault');
    const zh = createProject({
      id: 'zh-project',
      displayName: '中文项目',
      vaultRoot: zhVault,
      locale: 'zh-CN',
      dataDir,
    });
    const en = createProject({
      id: 'en-project',
      displayName: 'English Project',
      vaultRoot: enVault,
      locale: 'en',
      dataDir,
    });

    assert.deepEqual(zh.validate, { valid: true, errors: [], warnings: [] });
    assert.deepEqual(en.validate, { valid: true, errors: [], warnings: [] });
    const zhConfig = readConfig(zhVault);
    const enConfig = readConfig(enVault);
    assert.equal(zhConfig.localePreset, undefined);
    assert.equal(zhConfig.contentTree.root, ZH_CN_TEMPLATE_REPLACEMENTS.contentRoot);
    assert.equal(zhConfig.contentTree.leaf.titleTemplate, undefined);
    assert.equal(enConfig.localePreset, 'en');
    assert.equal(enConfig.contentTree.leaf.titleTemplate, 'Chapter {num}: {title}');
    const zhSetting = zhConfig.sidebarSources.find((source) => source.id === 'setting_index');
    const zhCharacters = zhConfig.sidebarSources.find((source) => source.id === 'characters');
    const zhStatus = zhConfig.sidebarSources.find((source) => source.id === 'writing_status');
    assert.equal(zhSetting?.label, '设定索引');
    assert.equal(zhSetting?.file, '设定索引.md');
    assert.equal(zhCharacters?.label, '角色');
    assert.equal(zhCharacters?.file, '角色.md');
    assert.equal(zhStatus?.label, '写作状态');
    assert.equal(zhStatus?.file, '写作状态.md');
    assert.equal(zhConfig.graph?.relationsFile, '关系网.md');
    assert.equal(zhConfig.aiProfiles.writer.description, '仅可读取公开正文与公开参考卡片。');
    assert.equal(zhConfig.aiProfiles.planner.description, '作者规划视图。');
    if (zhSetting?.parser !== 'markdown-table') {
      assert.fail('zh setting source must remain a markdown table');
    }
    assert.deepEqual(zhSetting.parserConfig.columnAliases, {
      term: ['术语'],
      source: ['定义出处'],
      firstAppearance: ['首次正文出现'],
      blankLink: ['关联留白'],
      status: ['状态'],
      serial: ['编号'],
    });
    assert.equal(zhSetting.parserConfig.writerHiddenFields, undefined);
    const enSetting = enConfig.sidebarSources.find((source) => source.id === 'setting_index');
    if (enSetting?.parser !== 'markdown-table') {
      assert.fail('en setting source must remain a markdown table');
    }
    assert.equal(enSetting.parserConfig.writerHiddenFields, undefined);
    if (zhCharacters?.parser !== 'heading-sections'
      || zhCharacters.parserConfig.kind !== 'characters') {
      assert.fail('zh characters source must remain a character section source');
    }
    assert.deepEqual(zhCharacters.parserConfig.authorOnlyMarkers, ['作者侧']);
    if (zhStatus?.parser !== 'heading-sections'
      || zhStatus.parserConfig.kind !== 'writingStatus') {
      assert.fail('zh writing status source must remain a writingStatus source');
    }
    assert.equal(zhStatus.parserConfig.lastRefreshedRegex, '最后刷新：([0-9-]+)');
    assert.equal(zhStatus.parserConfig.stopChapterRegex, '对应停点第(\\d+)章');
    assert.deepEqual(
      zhConfig.graph?.typeSources?.find((source) => source.sourceId === 'setting_index')
        ?.sectionTypeIds,
      { 地点: 'place' },
    );

    const zhStatusMarkdown = readFileSync(join(zhVault, '写作状态.md'), 'utf8');
    const zhSettingMarkdown = readFileSync(join(zhVault, '设定索引.md'), 'utf8');
    const zhCharactersMarkdown = readFileSync(join(zhVault, '角色.md'), 'utf8');
    const zhGraphMarkdown = readFileSync(join(zhVault, '关系网.md'), 'utf8');
    const enCharactersMarkdown = readFileSync(join(enVault, 'characters.md'), 'utf8');
    const enFiles = [
      readFileSync(join(enVault, 'writing-status.md'), 'utf8'),
      readFileSync(join(enVault, 'setting-index.md'), 'utf8'),
      enCharactersMarkdown,
      readFileSync(join(enVault, 'relationship-graph.md'), 'utf8'),
    ].join('\n');
    for (const markdown of [zhStatusMarkdown, zhSettingMarkdown, zhCharactersMarkdown, zhGraphMarkdown, enFiles]) {
      assert.doesNotMatch(markdown, /Window desk|The Writer|A distant bell|The journey has begun/);
      assert.doesNotMatch(markdown, /^> (?:Story stop|Last refreshed):/m);
    }
    assert.match(zhSettingMarkdown, /\| 编号 \| 术语 \| 定义出处 \| 首次正文出现 \| 关联留白 \| 状态 \|/);
    assert.doesNotMatch(zhSettingMarkdown, /\| S-01 \|/);
    assert.match(
      zhSettingMarkdown,
      /^<!-- writing-studio:骨架 —— 填入内容后请删除本行 -->/u,
    );
    assert.equal(
      [zhStatusMarkdown, zhCharactersMarkdown, zhGraphMarkdown, enFiles]
        .filter((markdown) => markdown.includes('writing-studio:')).length,
      2,
    );
    assert.equal(
      [zhStatusMarkdown, zhSettingMarkdown, zhCharactersMarkdown, zhGraphMarkdown, enFiles]
        .join('\n').match(/writing-studio:/gu)?.length,
      4,
    );
    assert.equal(zhCharactersMarkdown, [
      '<!-- writing-studio:骨架 —— 填入内容后请删除本行 -->',
      '<!--',
      '结构示例（复制到注释外使用；每个角色一张 ## 卡片）：',
      '## 角色名',
      '### 角色定位',
      '一句话定位。',
      '-->',
      '',
    ].join('\n'));
    assert.equal(enCharactersMarkdown, [
      '<!-- writing-studio:scaffold — delete this line after adding content -->',
      '<!--',
      'Structure example (copy outside this comment; use one ## card per character):',
      '## Character name',
      '### Role',
      'One-sentence role.',
      '-->',
      '',
    ].join('\n'));
    for (const role of ['writer', 'planner'] as const) {
      const characters = new SidebarService().getSource(
        { vaultRoot: zhVault, config: zhConfig },
        'characters',
        role,
      );
      assert.equal(characters?.parser, 'heading-sections');
      assert.equal(characters?.kind, 'characters');
      if (characters?.parser === 'heading-sections' && characters.kind === 'characters') {
        assert.equal(characters.data.length, 0);
      }
    }
    assert.match(zhGraphMarkdown, /## 节点类型/);
    assert.match(
      zhGraphMarkdown,
      /本文件是语义关系的唯一来源；vault 中其它 wikilink 只是证据链接，不会自动生成边。/,
    );
    assert.match(zhGraphMarkdown, /\| 标识 \| 名称 \| 视觉族 \|/);
    assert.doesNotMatch(zhGraphMarkdown, /\| --- \| --- \| --- \|\n##/);
    assert.doesNotMatch(zhGraphMarkdown, /\| character \||\| near \||\| char:writer \||\| rel:r001 \|/);
    assert.doesNotMatch(zhStatusMarkdown, /^\| \| 待填写 \| 待填写 \|$/m);
    assert.doesNotMatch(zhStatusMarkdown, /\[\[/);
    assert.equal(existsSync(join(zhVault, 'setting-index.md')), false);
    assert.equal(existsSync(join(zhVault, 'writing-status.md')), false);

    for (const [vaultRoot, config, id] of [
      [zhVault, zhConfig, 'zh-project'],
      [enVault, enConfig, 'en-project'],
    ] as const) {
      const graph = new WorldGraphModule(new SidebarService());
      const project = { vaultRoot, config, dataDir: join(dataDir, id) };
      const planner = graph.getSnapshot(project, 'planner');
      const writer = graph.getSnapshot(project, 'writer');
      assert.equal(planner.stopState, 'unset');
      assert.equal(planner.stopPoint, null);
      assert.deepEqual(
        planner.diagnostics.map(({ code, severity }) => ({ code, severity })),
        [{ code: 'STOP_POINT_UNSET', severity: 'warning' }],
      );
      assert.equal(writer.stopState, 'unset');
      assert.equal(writer.stopPoint, null);
      assert.deepEqual(writer.nodes, []);
      assert.deepEqual(writer.edges, []);
      assert.deepEqual(writer.storyPoints, []);
      assert.deepEqual(writer.diagnostics, []);
    }

    const zhChapter = createChapter(zhVault, zhConfig, '章节标题A');
    const enChapter = createChapter(enVault, enConfig, 'Opening');
    assert.equal(zhChapter.docId, '正文/第一部_开端/第1章.md');
    assert.equal(enChapter.docId, 'manuscript/Part-1_Beginning/Chapter-1.md');
    assert.equal(readFileSync(join(zhVault, zhChapter.docId), 'utf8'), '# 第1章 章节标题A\n\n');
    assert.equal(readFileSync(join(enVault, enChapter.docId), 'utf8'), '# Chapter 1: Opening\n\n');

    const zhWritingStatus = new SidebarService().getSource(
      { vaultRoot: zhVault, config: zhConfig },
      'writing_status',
      'planner',
    );
    assert.equal(zhWritingStatus?.parser, 'heading-sections');
    assert.equal(zhWritingStatus?.kind, 'writingStatus');
    if (zhWritingStatus?.parser !== 'heading-sections'
      || zhWritingStatus.kind !== 'writingStatus') return;
    assert.equal(zhWritingStatus.data.stopPoint.trim(), '');
    assert.ok(zhWritingStatus.data.storylines.length > 0);
    assert.equal(zhWritingStatus.data.activeForeshadow.length, 0);
    assert.ok(zhWritingStatus.data.characterOneLiners.length > 0);
    assert.ok(zhWritingStatus.data.redLines.length > 0);
    assert.notEqual(zhWritingStatus.data.expressionBaseline.trim(), '');

    for (const [vaultRoot, config, id] of [
      [zhVault, zhConfig, 'zh-project'],
      [enVault, enConfig, 'en-project'],
    ] as const) {
      const graph = new WorldGraphModule(new SidebarService());
      const project = { vaultRoot, config, dataDir: join(dataDir, id) };
      const planner = graph.getSnapshot(project, 'planner');
      const writer = graph.getSnapshot(project, 'writer');
      assert.equal(planner.stopState, 'unset', 'creating chapter one must not guess a stop point');
      assert.equal(planner.stopPoint, null);
      assert.deepEqual(
        planner.diagnostics.map((diagnostic) => diagnostic.code),
        ['STOP_POINT_UNSET'],
      );
      assert.equal(writer.stopState, 'unset');
      assert.equal(writer.stopPoint, null);
      assert.deepEqual(writer.nodes, []);
      assert.deepEqual(writer.edges, []);
      assert.deepEqual(writer.storyPoints, []);
      assert.deepEqual(writer.diagnostics, []);
    }

    const registry = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8')) as {
      projects: Array<{ id: string; vaultRoot: string; enabled: boolean }>;
    };
    assert.deepEqual(registry.projects, [
      { id: 'zh-project', vaultRoot: zhVault, enabled: true },
      { id: 'en-project', vaultRoot: enVault, enabled: true },
    ]);
  });
});

test('newly scaffolded vault serves unset planner and writer graph snapshots immediately', async () => {
  const root = mkdtempSync(join(tmpdir(), 'writing-studio-create-project-graph-'));
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const dataDir = join(root, 'data');
    const vaultRoot = join(root, 'vault');
    const result = createProject({
      id: 'graph-ready-project',
      displayName: 'Graph Ready Project',
      vaultRoot,
      locale: 'en',
      dataDir,
    });
    app = await buildApp({
      dataDir,
      registryPath: result.registryPath,
      watchSidebar: false,
    });

    const plannerResponse = await app.inject({
      method: 'GET',
      url: '/api/projects/graph-ready-project/graph?view=planner',
    });
    assert.equal(plannerResponse.statusCode, 200, plannerResponse.body);
    const planner = json(plannerResponse).data;
    assert.equal(planner.stopState, 'unset');
    assert.equal(planner.stopPoint, null);
    assert.deepEqual(
      planner.diagnostics.map(({ code, severity }: { code: string; severity: string }) => ({
        code,
        severity,
      })),
      [{ code: 'STOP_POINT_UNSET', severity: 'warning' }],
    );

    const writerResponse = await app.inject({
      method: 'GET',
      url: '/api/projects/graph-ready-project/graph?view=writer',
    });
    assert.equal(writerResponse.statusCode, 200, writerResponse.body);
    const writer = json(writerResponse).data;
    assert.equal(writer.stopState, 'unset');
    assert.equal(writer.stopPoint, null);
    assert.deepEqual(writer.nodes, []);
    assert.deepEqual(writer.edges, []);
    assert.deepEqual(writer.storyPoints, []);
    assert.deepEqual(writer.diagnostics, []);
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('copying the character example outside its comment creates a graph-derived card', () => {
  withTempDir((root) => {
    const vaultRoot = join(root, 'vault');
    const dataDir = join(root, 'data');
    createProject({
      id: 'character-example',
      displayName: 'Character Example',
      vaultRoot,
      locale: 'zh-CN',
      dataDir,
    });
    const config = readConfig(vaultRoot);
    writeFileSync(join(vaultRoot, '角色.md'), [
      '## 角色I',
      '### 角色定位',
      '负责勘察遗迹。',
      '',
    ].join('\n'));

    const characters = new SidebarService().getSource(
      { vaultRoot, config },
      'characters',
      'planner',
    );
    assert.equal(characters?.parser, 'heading-sections');
    assert.equal(characters?.kind, 'characters');
    if (characters?.parser !== 'heading-sections' || characters.kind !== 'characters') return;
    assert.ok(characters.data.length >= 1);

    const graph = new WorldGraphModule(new SidebarService()).getSnapshot(
      { vaultRoot, config, dataDir: join(dataDir, 'character-example') },
      'planner',
    );
    assert.ok(graph.diagnostics.some((diagnostic) =>
      diagnostic.code === 'UNDECLARED_TYPE' && diagnostic.file === '角色.md',
    ));
  });
});

test('registry environment override is shared by createProject and loadProjects', () => {
  withTempDir((root) => {
    const previous = process.env['WRITING_STUDIO_REGISTRY_PATH'];
    const registryPath = join(root, 'custom', 'projects.json');
    const dataDir = join(root, 'data');
    process.env['WRITING_STUDIO_REGISTRY_PATH'] = registryPath;
    try {
      const result = createProject({
        id: 'env-registry-project',
        displayName: 'Environment Registry',
        vaultRoot: join(root, 'vault'),
        locale: 'en',
        dataDir,
      });
      assert.equal(result.registryPath, registryPath);
      assert.equal(existsSync(join(dataDir, 'registry.json')), false);
      const loaded = loadProjects({ dataDir });
      assert.equal(loaded.get('env-registry-project')?.status, 'ready');
    } finally {
      if (previous === undefined) delete process.env['WRITING_STUDIO_REGISTRY_PATH'];
      else process.env['WRITING_STUDIO_REGISTRY_PATH'] = previous;
    }
  });
});

test('filesystem failures while preparing the target preserve their cause', () => {
  withTempDir((root) => {
    const parentFile = join(root, 'not-a-directory');
    writeFileSync(parentFile, 'keep');
    assert.throws(
      () => createProject({
        id: 'fs-error-project',
        displayName: 'FS Error',
        vaultRoot: join(parentFile, 'vault'),
        locale: 'en',
        dataDir: join(root, 'data'),
      }),
      (error) => error instanceof Error
        && error.name === 'CreateProjectError'
        && error.message.startsWith('无法准备目标路径：')
        && error.cause instanceof Error,
    );
    assert.equal(readFileSync(parentFile, 'utf8'), 'keep');
  });
});

test('duplicate ids and non-empty targets are rejected before leaving scaffold artifacts', () => {
  withTempDir((root) => {
    const dataDir = join(root, 'data');
    createProject({
      id: 'existing-project',
      displayName: 'Existing',
      vaultRoot: join(root, 'existing-vault'),
      locale: 'en',
      dataDir,
    });
    const duplicateTarget = join(root, 'duplicate-target');
    assert.throws(
      () => createProject({
        id: 'existing-project',
        displayName: 'Duplicate',
        vaultRoot: duplicateTarget,
        locale: 'en',
        dataDir,
      }),
      /已存在项目 id/,
    );
    assert.equal(existsSync(duplicateTarget), false);

    const nonEmptyTarget = join(root, 'non-empty');
    mkdirSync(nonEmptyTarget);
    writeFileSync(join(nonEmptyTarget, 'keep.txt'), 'keep');
    assert.throws(
      () => createProject({
        id: 'another-project',
        displayName: 'Another',
        vaultRoot: nonEmptyTarget,
        locale: 'en',
        dataDir,
      }),
      /不是空目录/,
    );
    assert.deepEqual(readdirSync(nonEmptyTarget), ['keep.txt']);
    assert.equal(readFileSync(join(nonEmptyTarget, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(existsSync(join(nonEmptyTarget, '.writing-studio')), false);
  });
});

test('CLI keeps JSON shape stable and uses exit codes 0, 1, and 2 by failure class', () => {
  withTempDir((root) => {
    const vaultRoot = join(root, 'cli-vault');
    const dataDir = join(root, 'data');
    const run = (args: string[]) => spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/create-project.ts', ...args],
      {
        cwd: SERVER_ROOT,
        encoding: 'utf8',
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      },
    );
    const success = run([
      '--id', 'cli-project',
      '--name', 'CLI Project',
      '--vault', vaultRoot,
      '--locale', 'en',
      '--data-dir', dataDir,
      '--json',
    ]);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(withoutRuntimeNoise(success.stderr), '');
    const result = JSON.parse(success.stdout) as CreateProjectResult;
    assert.deepEqual(Object.keys(result), ['created', 'vaultRoot', 'registryPath', 'validate']);
    assert.equal(result.created, true);
    assert.equal(result.vaultRoot, vaultRoot);
    assert.deepEqual(result.validate, { valid: true, errors: [], warnings: [] });

    const plainSuccess = run([
      '--id', 'plain-cli-project',
      '--name', 'Plain CLI Project',
      '--vault', join(root, 'plain-cli-vault'),
      '--locale', 'en',
      '--data-dir', dataDir,
    ]);
    assert.equal(plainSuccess.status, 0, plainSuccess.stderr);
    assert.equal(
      plainSuccess.stdout.trimEnd().split('\n').at(-1),
      '尚无停点：在写作状态的停点段填入章节引用后，writer 投影才可用。',
    );

    const operationalFailure = run([
      '--id', 'cli-project',
      '--name', 'Duplicate',
      '--vault', join(root, 'duplicate'),
      '--data-dir', dataDir,
      '--json',
    ]);
    assert.equal(operationalFailure.status, 1);
    assert.equal(operationalFailure.stdout, '');
    assert.deepEqual(
      Object.keys(JSON.parse(withoutRuntimeNoise(operationalFailure.stderr)) as object),
      ['created', 'error'],
    );

    const argumentFailure = run(['--id', 'bad', '--unknown', '--json']);
    assert.equal(argumentFailure.status, 2);
    assert.equal(argumentFailure.stdout, '');
    assert.deepEqual(
      Object.keys(JSON.parse(withoutRuntimeNoise(argumentFailure.stderr)) as object),
      ['created', 'error'],
    );

    const help = run(['--json', '--unknown', '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^用法：/);
    assert.equal(withoutRuntimeNoise(help.stderr), '');
  });
});
