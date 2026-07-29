import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { ProjectConfig } from '@writing-studio/contract';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/vault.js';
import { json } from './support/http-helpers.js';
import { captureJsonLogs } from './support/log-capture.js';

const PROJECT_ID = 'valid-project';
const DOC_ID = '正文/第一部_开端/第1章.md';
const INITIAL_DOCUMENT = '# 第1章：开始\n\n这里有一段可锚定的文字。\n';
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

function config(): ProjectConfig {
  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    displayName: 'Integration Project',
    contentTree: {
      root: '正文',
      levels: [{ levelName: 'part', dirPattern: '第{num}部_{name}', numberStyle: 'cnLower', indexFile: null }],
      leaf: { filePattern: '第{num}章.md', numberStyle: 'arabic', numberingScope: 'book', titleStripRegex: '^第\\d+章[：:]?\\s*' },
    },
    draftsDir: '草稿',
    sidebarSources: [
      {
        id: 'characters', label: '角色', file: '角色.md', parser: 'heading-sections', order: 1,
        parserConfig: {
          kind: 'characters', cardHeadingLevel: 2, sectionHeadingLevel: 3,
          authorOnlyMarkers: ['作者侧·未公开', 'AUTHOR_ONLY'],
        },
      },
      {
        id: 'setting_index', label: '设定', file: '设定索引.md', parser: 'markdown-table', order: 2,
        parserConfig: {
          sectionHeadingLevels: [2],
          columnAliases: {
            term: ['术语'], source: ['出处'], firstAppearance: ['首次'],
            blankLink: ['留白'], status: ['状态'], serial: ['编号'],
          },
          writerHiddenFields: [],
        },
      },
      {
        id: 'writing_status', label: '状态', file: '状态.md', parser: 'heading-sections', order: 3,
        parserConfig: {
          kind: 'writingStatus',
          lastRefreshedRegex: '刷新：(\\S+)',
          stopChapterRegex: '停章：(\\d+)',
        },
      },
    ],
    aiProfiles: {
      writer: { description: 'writer', readable: ['正文/**', '角色.md', '设定索引.md', '状态.md', '后续.md'], forbidden: ['后续.md'], allowVaultBrowsing: false },
      planner: { description: 'planner', readable: ['正文/**'], forbidden: [], allowVaultBrowsing: true },
      defaultProfile: 'writer',
    },
    defaultAgentId: 'echo',
  };
}

interface Fixture {
  root: string;
  dataDir: string;
  registryPath: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'writing-studio-app-'));
  const dataDir = join(root, 'data');
  const vault = join(root, 'vault');
  const invalidVault = join(root, 'invalid-vault');
  const cfg = config();
  mkdirSync(join(vault, '.writing-studio'), { recursive: true });
  mkdirSync(join(vault, '正文', '第一部_开端'), { recursive: true });
  mkdirSync(join(vault, '.git'), { recursive: true });
  mkdirSync(join(invalidVault, '.writing-studio'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(vault, '.writing-studio', 'project.json'), JSON.stringify(cfg));
  writeFileSync(join(vault, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n');
  writeFileSync(join(vault, DOC_ID), INITIAL_DOCUMENT);
  writeFileSync(join(vault, '角色.md'), [
    '## 公开角色', '### 身份', '公开事实。', '- 公开装备',
    '### 投影过滤节', '- 对外可见。', '- 作者侧·未公开：内部事实。',
    '### 大小写过滤节', '- 对外可见。', '- author_only：内部事实。',
    '### 作者侧·未公开', '绝不可泄露。',
    '## 作者侧·未公开：隐藏角色', '### 身份', '隐藏整卡。',
  ].join('\n'));
  writeFileSync(join(vault, '设定索引.md'), [
    '## 地理',
    '| 编号 | 术语 | 出处 | 首次 | 留白 | 状态 |',
    '| - | - | - | - | - | - |',
    '| 01 | 地点B | 世界观 | 第1章 | — | 已定 |',
  ].join('\n'));
  writeFileSync(join(vault, '状态.md'), [
    '刷新：2026-07-23', '停章：1',
    '## 停点', '公开停点。',
    '## 活跃伏笔速览',
    '| 编号 | 内容 | 状态 |',
    '| - | - | - |',
    '| F1 | 公开伏笔 | 进行中 |',
    '> HIDDEN_VALUE',
    '## 表达基线', '公开表达。',
  ].join('\n'));
  writeFileSync(join(vault, '后续.md'), '# 禁止注入\n\n未来事实。\n');
  writeFileSync(join(vault, '普通根目录.md'), '# 非公开根文档\n');
  writeFileSync(join(vault, '笔记.txt'), 'not a document API file');
  const invalidConfig = config();
  invalidConfig.id = 'invalid-project';
  invalidConfig.aiProfiles.writer.allowVaultBrowsing = true;
  writeFileSync(join(invalidVault, '.writing-studio', 'project.json'), JSON.stringify(invalidConfig));
  const registryPath = join(dataDir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({
    projects: [
      { id: PROJECT_ID, vaultRoot: vault, enabled: true },
      { id: 'invalid-project', vaultRoot: invalidVault, enabled: true },
    ],
  }));
  return { root, dataDir, registryPath };
}

async function makeApp(fixture: Fixture): Promise<FastifyInstance> {
  return buildApp({ dataDir: fixture.dataDir, registryPath: fixture.registryPath, watchSidebar: false });
}

function documentPath(): string {
  return `/api/projects/${PROJECT_ID}/documents/${encodeURIComponent(DOC_ID)}`;
}

function pathFor(docId: string): string {
  return `/api/projects/${PROJECT_ID}/documents/${encodeURIComponent(docId)}`;
}

test('server starts before a registry is provisioned and exposes an empty project list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'writing-studio-empty-bootstrap-'));
  let app: FastifyInstance | undefined;
  try {
    app = await buildApp({ dataDir: join(root, 'data'), watchSidebar: false });
    const response = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(json(response).data, []);
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('slowRuleBudgetMs rejects invalid timer intervals', async () => {
  for (const slowRuleBudgetMs of [-1, 0.5, 2_147_483_648, Number.NaN]) {
    await assert.rejects(
      buildApp({ slowRuleBudgetMs }),
      new Error('slowRuleBudgetMs must be a non-negative 32-bit timer interval'),
    );
  }
});

test('chapter title endpoint returns updated metadata, 409 conflicts, and fail-closed 422s', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    const configPath = join(fixture.root, 'vault', '.writing-studio', 'project.json');
    const configured = JSON.parse(readFileSync(configPath, 'utf8')) as ProjectConfig;
    configured.contentTree.leaf.titleTemplate = '第{num}章：{title}';
    writeFileSync(configPath, JSON.stringify(configured));
    app = await makeApp(fixture);
    const path = `${documentPath()}/title`;
    const before = readFileSync(join(fixture.root, 'vault', DOC_ID), 'utf8');
    const baseSha256 = sha256(before);
    const renamed = await app.inject({
      method: 'PATCH',
      url: path,
      payload: { title: '  章节标题A  ', baseSha256 },
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(json(renamed).data.sha256, json(renamed).data.doc.sha256);
    assert.equal(json(renamed).data.doc.title, '章节标题A');
    const after = readFileSync(join(fixture.root, 'vault', DOC_ID), 'utf8');
    assert.equal(after.split('\n')[0], '# 第1章：章节标题A');
    assert.deepEqual(after.split('\n').slice(1), before.split('\n').slice(1));

    const stale = await app.inject({
      method: 'PATCH',
      url: path,
      payload: { title: '第二次', baseSha256 },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(json(stale).error.code, 'STALE_WRITE');

    for (const title of ['上\n下', '上\u2028下']) {
      const invalidResponse: InjectResponse = await app.inject({
        method: 'PATCH',
        url: path,
        payload: { title, baseSha256: sha256(after) },
      });
      assert.equal(invalidResponse.statusCode, 400, invalidResponse.body);
      assert.equal(readFileSync(join(fixture.root, 'vault', DOC_ID), 'utf8'), after);
    }

    const malformed = '首行不是标题。\n\n正文。\n';
    writeFileSync(join(fixture.root, 'vault', DOC_ID), malformed);
    const noHeading = await app.inject({
      method: 'PATCH',
      url: path,
      payload: { title: '不可插入', baseSha256: sha256(malformed) },
    });
    assert.equal(noHeading.statusCode, 422, noHeading.body);
    assert.equal(json(noHeading).error.code, 'UNPROCESSABLE');
    assert.equal(readFileSync(join(fixture.root, 'vault', DOC_ID), 'utf8'), malformed);
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('chapter title endpoint rejects filename patterns containing {title} without writing', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    const configPath = join(fixture.root, 'vault', '.writing-studio', 'project.json');
    const configured = JSON.parse(readFileSync(configPath, 'utf8')) as ProjectConfig;
    configured.contentTree.leaf.filePattern = '第{num}章_{title}.md';
    writeFileSync(configPath, JSON.stringify(configured));
    app = await makeApp(fixture);
    const before = readFileSync(join(fixture.root, 'vault', DOC_ID), 'utf8');
    const response = await app.inject({
      method: 'PATCH',
      url: `${documentPath()}/title`,
      payload: { title: '不可改', baseSha256: sha256(before) },
    });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(json(response).error.code, 'UNPROCESSABLE');
    assert.equal(readFileSync(join(fixture.root, 'vault', DOC_ID), 'utf8'), before);
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('drafts endpoint returns an empty list and then direct draft DocumentMeta entries', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    app = await makeApp(fixture);
    const url = `/api/projects/${PROJECT_ID}/drafts`;
    const empty = await app.inject({ method: 'GET', url });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.deepEqual(json(empty).data, []);
    const emptyTrash = await app.inject({ method: 'GET', url: `${url}/trash` });
    assert.equal(emptyTrash.statusCode, 200, emptyTrash.body);
    assert.deepEqual(json(emptyTrash).data, []);
    assert.equal(existsSync(join(fixture.root, 'vault', '草稿', '.trash')), false);

    mkdirSync(join(fixture.root, 'vault', '草稿'), { recursive: true });
    writeFileSync(
      join(fixture.root, 'vault', '草稿', '2026-07-23_无标题存量草稿.md'),
      '采纳正文覆盖了创建时的标题行。\n',
    );
    for (const title of ['冒烟测试-生成链路', '逐段采纳复审']) {
      const created: InjectResponse = await app.inject({
        method: 'POST',
        url: `/api/projects/${PROJECT_ID}/documents`,
        payload: { title },
      });
      assert.equal(created.statusCode, 200, created.body);
    }

    const listed = await app.inject({ method: 'GET', url });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(
      json(listed).data.map((draft: { kind: string; title: string; chapterNo: number | null }) => ({
        kind: draft.kind,
        title: draft.title,
        chapterNo: draft.chapterNo,
      })).sort((left: { title: string }, right: { title: string }) => left.title.localeCompare(right.title)),
      [
        { kind: 'draft', title: '冒烟测试-生成链路', chapterNo: null },
        { kind: 'draft', title: '无标题存量草稿', chapterNo: null },
        { kind: 'draft', title: '逐段采纳复审', chapterNo: null },
      ].sort((left, right) => left.title.localeCompare(right.title)),
    );

    const deletedDraft = json(listed).data.find(
      (draft: { title: string }) => draft.title === '冒烟测试-生成链路',
    ) as { docId: string };
    const beforeDelete = readFileSync(join(fixture.root, 'vault', deletedDraft.docId));
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${PROJECT_ID}/drafts/${encodeURIComponent(deletedDraft.docId)}`,
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    const deletedData = json(deleted).data as { docId: string; trashedDocId: string };
    assert.equal(deletedData.docId, deletedDraft.docId);
    assert.equal(existsSync(join(fixture.root, 'vault', deletedDraft.docId)), false);
    assert.equal(existsSync(join(fixture.root, 'vault', deletedData.trashedDocId)), true);
    const trashList = await app.inject({ method: 'GET', url: `${url}/trash` });
    assert.equal(trashList.statusCode, 200, trashList.body);
    assert.deepEqual(json(trashList).data.map((entry: {
      trashedDocId: string;
      originalName: string;
      title: string;
    }) => ({
      trashedDocId: entry.trashedDocId,
      originalName: entry.originalName,
      title: entry.title,
    })), [{
      trashedDocId: deletedData.trashedDocId,
      originalName: deletedDraft.docId.split('/').at(-1),
      title: '冒烟测试-生成链路',
    }]);

    const restoreUrl = `${url}/${encodeURIComponent(deletedData.trashedDocId)}/restore`;
    writeFileSync(join(fixture.root, 'vault', deletedDraft.docId), 'conflicting bytes');
    const conflict = await app.inject({ method: 'POST', url: restoreUrl });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(json(conflict).error.code, 'CONFLICT');
    assert.equal(readFileSync(join(fixture.root, 'vault', deletedDraft.docId), 'utf8'), 'conflicting bytes');
    assert.deepEqual(readFileSync(join(fixture.root, 'vault', deletedData.trashedDocId)), beforeDelete);
    unlinkSync(join(fixture.root, 'vault', deletedDraft.docId));
    const restored = await app.inject({ method: 'POST', url: restoreUrl });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(json(restored).data, {
      trashedDocId: deletedData.trashedDocId,
      docId: deletedDraft.docId,
    });
    assert.deepEqual(readFileSync(join(fixture.root, 'vault', deletedDraft.docId)), beforeDelete);
    assert.equal(existsSync(join(fixture.root, 'vault', deletedData.trashedDocId)), false);

    const restoreCanonRejected = await app.inject({
      method: 'POST',
      url: `${url}/${encodeURIComponent(DOC_ID)}/restore`,
    });
    assert.equal(restoreCanonRejected.statusCode, 400, restoreCanonRejected.body);
    assert.equal(json(restoreCanonRejected).error.code, 'VALIDATION');

    const hiddenTrashId = '草稿/.trash/2026-07-25T01:02:03.004Z_.hidden.md';
    const hiddenTrashPath = join(fixture.root, 'vault', hiddenTrashId);
    mkdirSync(join(fixture.root, 'vault', '草稿', '.trash'), { recursive: true });
    writeFileSync(hiddenTrashPath, 'hidden bytes');
    const restoreHiddenRejected = await app.inject({
      method: 'POST',
      url: `${url}/${encodeURIComponent(hiddenTrashId)}/restore`,
    });
    assert.equal(restoreHiddenRejected.statusCode, 400, restoreHiddenRejected.body);
    assert.equal(json(restoreHiddenRejected).error.code, 'VALIDATION');
    assert.equal(readFileSync(hiddenTrashPath, 'utf8'), 'hidden bytes');
    assert.equal(existsSync(join(fixture.root, 'vault', '草稿', '.hidden.md')), false);

    const canonRejected = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${PROJECT_ID}/drafts/${encodeURIComponent(DOC_ID)}`,
    });
    assert.equal(canonRejected.statusCode, 400, canonRejected.body);
    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${PROJECT_ID}/drafts/${encodeURIComponent('草稿/不存在.md')}`,
    });
    assert.equal(missing.statusCode, 404, missing.body);
    const afterDelete = await app.inject({ method: 'GET', url });
    assert.equal(afterDelete.statusCode, 200, afterDelete.body);
    assert.equal(
      json(afterDelete).data.some((draft: { docId: string }) => draft.docId.includes('.trash')),
      false,
    );
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function waitForAssistant(app: FastifyInstance, threadId: string): Promise<any> {
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    const response = await app.inject({ method: 'GET', url: `/api/threads/${threadId}` });
    if (response.statusCode === 200) {
      const body = json(response);
      if (body.data.messages.some((message: { role: string }) => message.role === 'assistant')) return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('echo assistant message was not persisted within 3 seconds');
}

// Both slow-rule tests below rely on `config()` leaving localePreset unset, so
// the project resolves to the non-empty zh-CN rule pack. Setting it to 'en'
// there would empty the rule set and make the budget assertions vacuous.
const SLOW_RULE_WARNING = 'lint rule exceeded its time budget; review .writing-studio/project.json lint.styleRules patterns';

test('lint logs structured slow-rule warnings through the route', async () => {
  const fixture = makeFixture();
  const captured = captureJsonLogs();
  let app: FastifyInstance | undefined;
  try {
    app = await buildApp({
      dataDir: fixture.dataDir,
      registryPath: fixture.registryPath,
      watchSidebar: false,
      slowRuleBudgetMs: 0,
      logger: { level: 'warn', stream: captured.stream },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/lint`,
      payload: { docId: DOC_ID },
    });
    assert.equal(response.statusCode, 200, response.body);

    const warnings = captured.records.filter((record) => record.msg === SLOW_RULE_WARNING);
    assert.ok(warnings.length > 0, 'expected at least one slow-rule warning');
    const warning = warnings[0];
    assert.equal(warning?.docId, DOC_ID);
    assert.equal(typeof warning?.ruleId, 'string');
    assert.ok(
      typeof warning?.elapsedMs === 'number' && warning.elapsedMs >= 0,
      'slow-rule warning must include a non-negative elapsedMs',
    );
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('lint falls back to the built-in budget when the app injects none', async (context) => {
  const fixture = makeFixture();
  const captured = captureJsonLogs();
  let app: FastifyInstance | undefined;
  try {
    writeFileSync(
      join(fixture.root, 'vault', DOC_ID),
      '# 第1章：开始\n\n值得注意的是，这份清单还没有核对完。\n',
    );
    // Freeze the clock so elapsed is exactly 0 for every rule. Without this the
    // test would only assert "these rules happen to be fast here"; with it, the
    // assertion is that the uninjected path really uses a non-zero budget. A
    // forwarding bug that substitutes 0 for the module default fails here.
    // This also freezes Fastify's own reply.elapsedTime, which shares the same
    // clock: harmless here because nothing asserts on it and the warn-level
    // filter drops the info-level 'request completed' line that carries it.
    context.mock.method(performance, 'now', () => 1_000);
    app = await buildApp({
      dataDir: fixture.dataDir,
      registryPath: fixture.registryPath,
      watchSidebar: false,
      logger: { level: 'warn', stream: captured.stream },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/lint`,
      payload: { docId: DOC_ID },
    });
    assert.equal(response.statusCode, 200, response.body);
    const findings = json(response).data.findings as Array<{ ruleId: string }>;
    assert.ok(findings.length > 0, 'expected the non-empty built-in lint rule pack to produce a finding');
    assert.ok(
      findings.some((finding) => finding.ruleId === 'style.empty-preface'),
      'expected the stable built-in style.empty-preface rule to run',
    );
    assert.deepEqual(captured.records.filter((record) => record.msg === SLOW_RULE_WARNING), []);
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('lint reads the vault document and provenance reports the durable revision chain', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    const vault = join(fixture.root, 'vault');
    const configPath = join(vault, '.writing-studio', 'project.json');
    const projectConfig = JSON.parse(readFileSync(configPath, 'utf8')) as ProjectConfig;
    projectConfig.lint = {
      styleRules: [{
        ruleId: 'project.guard',
        pattern: '守门人',
        message: '项目自定义守门人规则。',
        severity: 'info',
        category: 'style',
      }],
    };
    writeFileSync(configPath, JSON.stringify(projectConfig));
    writeFileSync(
      join(vault, DOC_ID),
      '# 第1章：开始\n\n值得注意的是，守门人被选为队长。禁用短语。\n',
    );
    writeFileSync(
      join(vault, '.writing-studio', 'sensitive-words.txt'),
      '# author-owned\n禁用短语\n',
    );
    app = await makeApp(fixture);

    const lint = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/lint`,
      payload: { docId: DOC_ID },
    });
    assert.equal(lint.statusCode, 200, lint.body);
    assert.equal(json(lint).data.docId, DOC_ID);
    assert.equal(json(lint).data.sha256.length, 64);
    assert.deepEqual(
      new Set(json(lint).data.findings.map((finding: { ruleId: string }) => finding.ruleId)),
      new Set([
        'style.empty-preface',
        'style.neutral-passive',
        'project.guard',
        'sensitive.word',
      ]),
    );
    const arbitraryText = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/lint`,
      payload: { docId: DOC_ID, text: '不可接受' },
    });
    assert.equal(arbitraryText.statusCode, 400);

    for (const input of [
      { kind: 'ai_original', content: '雨停了。', label: 'AI 初稿' },
      { kind: 'user_edit', content: '雨停了。\n她走了出去。', label: '作者修改' },
    ]) {
      const created: InjectResponse = await app.inject({
        method: 'POST',
        url: `${documentPath()}/revisions`,
        payload: input,
      });
      assert.equal(created.statusCode, 200, created.body);
    }
    const provenance = await app.inject({
      method: 'GET',
      url: `${documentPath()}/provenance`,
    });
    assert.equal(provenance.statusCode, 200, provenance.body);
    assert.equal(json(provenance).data.summary.revisionCount, 2);
    assert.equal(json(provenance).data.summary.authorChangedChars > 0, true);
    assert.deepEqual(
      json(provenance).data.revisions.map((item: { kind: string }) => item.kind),
      ['ai_original', 'user_edit'],
    );
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('buildApp isolates an invalid project and enforces document, anchor, and writer-sidebar boundaries', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    app = await makeApp(fixture);
    const projects = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(projects.statusCode, 200);
    assert.deepEqual(json(projects).data.map((project: { status: string }) => project.status), ['ready', 'invalid']);
    const agents = await app.inject({ method: 'GET', url: '/api/agents' });
    assert.equal(agents.statusCode, 200);
    const byAgent = new Map(json(agents).data.map((agent: { agentId: string }) => [agent.agentId, agent]));
    for (const agentId of ['claude', 'codex', 'opencode']) {
      const profiles = (byAgent.get(agentId) as { supportedProfiles: string[] }).supportedProfiles;
      assert.equal(
        JSON.stringify(profiles) === '[]' || JSON.stringify(profiles) === '["writer"]',
        true,
        `${agentId} must either support only writer or fail closed on this host`,
      );
    }
    assert.deepEqual((byAgent.get('echo') as { supportedProfiles: string[] }).supportedProfiles, ['writer', 'planner']);
    const invalid = await app.inject({ method: 'GET', url: '/api/projects/invalid-project' });
    assert.equal(invalid.statusCode, 422);

    const get = await app.inject({ method: 'GET', url: documentPath() });
    assert.equal(get.statusCode, 200);
    const document = json(get).data;
    assert.equal(document.content, INITIAL_DOCUMENT);

    const createdChapter = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/chapters`,
      payload: { title: '新章' },
    });
    assert.equal(createdChapter.statusCode, 200, createdChapter.body);
    assert.equal(json(createdChapter).data.docId, '正文/第一部_开端/第2章.md');
    assert.equal(
      readFileSync(join(fixture.root, 'vault', json(createdChapter).data.docId), 'utf8'),
      '# 第2章 新章\n\n',
    );
    const invalidChapterDir = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/chapters`,
      payload: { title: '错误', dirOverride: '正文' },
    });
    assert.equal(invalidChapterDir.statusCode, 400);
    assert.equal(json(invalidChapterDir).error.code, 'VALIDATION');
    const generationThread = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: {
        projectId: PROJECT_ID,
        docId: json(createdChapter).data.docId,
        kind: 'rewrite',
        origin: 'generate',
      },
    });
    assert.equal(generationThread.statusCode, 200, generationThread.body);
    assert.equal(json(generationThread).data.origin, 'generate');

    const savedContent = INITIAL_DOCUMENT.replace('可锚定', '已经保存');
    const saved = await app.inject({
      method: 'PUT', url: documentPath(), payload: { content: savedContent, baseSha256: document.doc.sha256 },
    });
    assert.equal(saved.statusCode, 200);
    const stale = await app.inject({
      method: 'PUT', url: documentPath(), payload: { content: INITIAL_DOCUMENT, baseSha256: document.doc.sha256 },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(json(stale).error.code, 'STALE_WRITE');
    const escaped = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/documents/${encodeURIComponent('../outside.md')}` });
    assert.equal(escaped.statusCode, 400);
    assert.equal(json(escaped).error.code, 'PATH_ESCAPE');
    const malformed = await app.inject({
      method: 'PUT', url: documentPath(),
      headers: { 'content-type': 'application/json' }, payload: '{',
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(json(malformed).error.code, 'VALIDATION');

    // Root Markdown is exposed only when config explicitly declares it as a
    // sidebar source. Repository/control files and arbitrary files remain
    // outside both GET and PUT document routes.
    const declaredRoot = await app.inject({ method: 'GET', url: pathFor('角色.md') });
    assert.equal(declaredRoot.statusCode, 200);
    const blockedDocuments = [
      '.writing-studio/project.json',
      '.git/config',
      '笔记.txt',
      '普通根目录.md',
    ];
    for (const blockedDocId of blockedDocuments) {
      const blockedGet: InjectResponse = await app.inject({ method: 'GET', url: pathFor(blockedDocId) });
      assert.equal(blockedGet.statusCode, 400, blockedDocId);
      assert.equal(json(blockedGet).error.code, 'PATH_ESCAPE', blockedDocId);
      const blockedPut: InjectResponse = await app.inject({
        method: 'PUT',
        url: pathFor(blockedDocId),
        payload: { content: 'must not write', baseSha256: sha256('original') },
      });
      assert.equal(blockedPut.statusCode, 400, blockedDocId);
      assert.equal(json(blockedPut).error.code, 'PATH_ESCAPE', blockedDocId);
    }

    const current = json(await app.inject({ method: 'GET', url: documentPath() })).data;
    const exact = '已经保存';
    const start = current.content.indexOf(exact);
    const anchor = {
      docSha: current.doc.sha256, start, end: start + exact.length,
      prefix: '', exact, suffix: '',
    };
    const created = await app.inject({
      method: 'POST', url: '/api/threads',
      payload: { projectId: PROJECT_ID, docId: DOC_ID, kind: 'ask', anchor },
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(json(created).data.anchor.exact, exact);
    const badAnchor = await app.inject({
      method: 'POST', url: '/api/threads',
      payload: { projectId: PROJECT_ID, docId: DOC_ID, kind: 'ask', anchor: { ...anchor, exact: '错误' } },
    });
    assert.equal(badAnchor.statusCode, 400);
    assert.equal(json(badAnchor).error.code, 'VALIDATION');

    const sidebar = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/sidebar?view=writer` });
    assert.equal(sidebar.statusCode, 200);
    assert.equal(JSON.stringify(json(sidebar).data).includes('作者侧·未公开'), false);
    assert.equal(JSON.stringify(json(sidebar).data).includes('绝不可泄露'), false);

    const missingPersona = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { projectId: PROJECT_ID, docId: '角色.md', kind: 'chat' },
    });
    assert.equal(missingPersona.statusCode, 400);
    assert.equal(json(missingPersona).error.code, 'VALIDATION');
    for (const payload of [
      {
        projectId: PROJECT_ID,
        docId: '角色.md',
        kind: 'chat',
        persona: { characterName: '不存在' },
      },
      {
        projectId: PROJECT_ID,
        docId: '角色.md',
        kind: 'chat',
        persona: { characterName: '作者侧·未公开：隐藏角色' },
      },
      {
        projectId: PROJECT_ID,
        docId: '角色.md',
        kind: 'chat',
        profile: 'planner',
        persona: { characterName: '公开角色' },
      },
      {
        projectId: PROJECT_ID,
        docId: DOC_ID,
        kind: 'chat',
        persona: { characterName: '公开角色', memoryCutoffChapter: 75 },
      },
    ]) {
      const rejected: InjectResponse = await app.inject({ method: 'POST', url: '/api/threads', payload });
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.equal(json(rejected).error.code, 'VALIDATION');
    }
    const chat = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: {
        projectId: PROJECT_ID,
        docId: '角色.md',
        kind: 'chat',
        persona: { characterName: '公开角色', memoryCutoffChapter: 75 },
      },
    });
    assert.equal(chat.statusCode, 200, chat.body);
    assert.deepEqual({
      docId: json(chat).data.docId,
      profile: json(chat).data.profile,
      persona: json(chat).data.persona,
    }, {
      docId: '角色.md',
      profile: 'writer',
      persona: { characterName: '公开角色', memoryCutoffChapter: 75 },
    });
    const chatList = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/threads?kind=chat`,
    });
    assert.equal(chatList.statusCode, 200);
    assert.equal(json(chatList).data.some((thread: { id: string }) => thread.id === json(chat).data.id), true);
    const chatRewrite = await app.inject({
      method: 'POST',
      url: `/api/threads/${json(chat).data.id as string}/messages`,
      payload: { content: '越界改写', wantRewrite: true },
    });
    assert.equal(chatRewrite.statusCode, 400);
    assert.equal(json(chatRewrite).error.code, 'VALIDATION');
    const chatRun = await app.inject({
      method: 'POST',
      url: `/api/threads/${json(chat).data.id as string}/messages`,
      payload: { content: '你好' },
    });
    assert.equal(chatRun.statusCode, 200, chatRun.body);
    const chatCompleted = await waitForAssistant(app, json(chat).data.id as string);
    assert.match(
      chatCompleted.data.messages.find((message: { role: string }) => message.role === 'assistant').content,
      /收到消息/,
    );

    const forbiddenThread = await app.inject({
      method: 'POST', url: '/api/threads',
      payload: { projectId: PROJECT_ID, docId: '后续.md', kind: 'ask', profile: 'writer' },
    });
    assert.equal(forbiddenThread.statusCode, 400);
    assert.equal(json(forbiddenThread).error.code, 'VALIDATION');

    // Even if a sidebar source is accidentally listed in writer.readable, it
    // cannot become the raw current document (which would bypass its parser's
    // AUTHOR_ONLY filtering and inject the full Markdown into context).
    const sidebarDocumentThread = await app.inject({
      method: 'POST', url: '/api/threads',
      payload: { projectId: PROJECT_ID, docId: '角色.md', kind: 'ask', profile: 'writer' },
    });
    assert.equal(sidebarDocumentThread.statusCode, 400);
    assert.equal(json(sidebarDocumentThread).error.code, 'VALIDATION');
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('canon repair is H2/H3 anchored, rejects AUTHOR_ONLY and refreshes sidebar plus aliases', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    const vault = join(fixture.root, 'vault');
    writeFileSync(
      join(vault, DOC_ID),
      '# 第1章\n\n公开角色见过地点B，也听说过地点C。\n',
    );
    app = await makeApp(fixture);

    const sidebarResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/sidebar?view=writer`,
    });
    const sidebarData = json(sidebarResponse).data as Array<{
      sourceId: string;
      writerSections: Array<{ headingPath: string[]; anchor: any }>;
    }>;
    const characters = sidebarData.find((source) => source.sourceId === 'characters')!;
    assert.deepEqual(
      characters.writerSections.map((section) => section.headingPath),
      [['公开角色', '身份']],
    );
    const publicSection = characters.writerSections[0]!;
    const writingStatus = sidebarData.find((source) => source.sourceId === 'writing_status')!;
    assert.deepEqual(
      writingStatus.writerSections.map((section) => section.headingPath),
      [['停点'], ['表达基线']],
    );
    const rawStatus = readFileSync(join(vault, '状态.md'), 'utf8');
    const activeStart = rawStatus.indexOf('## 活跃伏笔速览');
    const activeEnd = rawStatus.indexOf('## 表达基线');
    const hiddenStatusThread = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: {
        projectId: PROJECT_ID,
        docId: '状态.md',
        kind: 'rewrite',
        origin: 'canon',
        anchor: {
          docSha: sha256(rawStatus),
          start: activeStart,
          end: activeEnd,
          prefix: '',
          exact: rawStatus.slice(activeStart, activeEnd),
          suffix: '',
        },
        headingPath: ['活跃伏笔速览'],
      },
    });
    assert.equal(hiddenStatusThread.statusCode, 400, hiddenStatusThread.body);

    const created = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: {
        projectId: PROJECT_ID,
        docId: '角色.md',
        kind: 'rewrite',
        origin: 'canon',
        profile: 'writer',
        anchor: publicSection.anchor,
        headingPath: publicSection.headingPath,
        evidence: {
          docId: DOC_ID,
          textQuote: '公开角色见过地点B',
        },
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const canonThread = json(created).data;
    assert.equal(canonThread.origin, 'canon');
    assert.deepEqual(canonThread.canon, {
      headingPath: ['公开角色', '身份'],
      evidence: { docId: DOC_ID, textQuote: '公开角色见过地点B' },
    });

    const rawCharacters = readFileSync(join(vault, '角色.md'), 'utf8');
    const hiddenExact = '### 作者侧·未公开\n绝不可泄露。\n';
    const hiddenStart = rawCharacters.indexOf(hiddenExact);
    const hidden = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: {
        projectId: PROJECT_ID,
        docId: '角色.md',
        kind: 'rewrite',
        origin: 'canon',
        anchor: {
          docSha: sha256(rawCharacters),
          start: hiddenStart,
          end: hiddenStart + hiddenExact.length,
          prefix: '',
          exact: hiddenExact,
          suffix: '',
        },
        headingPath: ['公开角色', '作者侧·未公开'],
      },
    });
    assert.equal(hidden.statusCode, 400, hidden.body);
    assert.equal(json(hidden).error.code, 'VALIDATION');

    for (const headingPath of [
      ['公开角色', '投影过滤节'],
      ['公开角色', '大小写过滤节'],
      ['作者侧·未公开：隐藏角色', '身份'],
    ]) {
      const heading = `### ${headingPath[1]}`;
      const start = rawCharacters.indexOf(
        heading,
        headingPath[0] === '公开角色'
          ? rawCharacters.indexOf('### 投影过滤节')
          : rawCharacters.indexOf('## 作者侧·未公开：隐藏角色'),
      );
      const end = headingPath[0] === '公开角色'
        ? rawCharacters.indexOf('\n### ', start + heading.length) + 1
        : rawCharacters.length;
      const filtered: InjectResponse = await app.inject({
        method: 'POST',
        url: '/api/threads',
        payload: {
          projectId: PROJECT_ID,
          docId: '角色.md',
          kind: 'rewrite',
          origin: 'canon',
          anchor: {
            docSha: sha256(rawCharacters),
            start,
            end,
            prefix: '',
            exact: rawCharacters.slice(start, end),
            suffix: '',
          },
          headingPath,
        },
      });
      assert.equal(filtered.statusCode, 400, filtered.body);
      assert.equal(json(filtered).error.code, 'VALIDATION');
    }

    const echoRun = await app.inject({
      method: 'POST',
      url: `/api/threads/${canonThread.id as string}/messages`,
      payload: { content: '按正文证据补充说明', wantRewrite: true },
    });
    assert.equal(echoRun.statusCode, 200, echoRun.body);
    const echoCompleted = await waitForAssistant(app, canonThread.id as string);
    const echoCandidate = echoCompleted.data.messages
      .find((message: { role: string }) => message.role === 'assistant')
      ?.structured?.rewritten_text as string;
    assert.match(echoCandidate, /^### 身份/m);
    assert.match(echoCandidate, /echo 修补占位/);
    const repairedCharacters = [
      rawCharacters.slice(0, publicSection.anchor.start),
      echoCandidate,
      rawCharacters.slice(publicSection.anchor.end),
    ].join('');
    const adopted = await app.inject({
      method: 'PUT',
      url: pathFor('角色.md'),
      payload: {
        content: repairedCharacters,
        baseSha256: sha256(rawCharacters),
        sourceThreadId: canonThread.id,
      },
    });
    assert.equal(adopted.statusCode, 200, adopted.body);
    const refreshedThread = await app.inject({
      method: 'GET',
      url: `/api/threads/${canonThread.id}`,
    });
    assert.match(json(refreshedThread).data.thread.anchor.exact, /echo 修补占位/);
    const refreshedSidebar = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/sidebar?view=writer`,
    });
    assert.match(JSON.stringify(json(refreshedSidebar).data), /echo 修补占位/);
    assert.doesNotMatch(JSON.stringify(json(refreshedSidebar).data), /绝不可泄露/);

    const refreshedCharacters = (json(refreshedSidebar).data as typeof sidebarData)
      .find((source) => source.sourceId === 'characters')!;
    const secondThread = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: {
        projectId: PROJECT_ID,
        docId: '角色.md',
        kind: 'rewrite',
        origin: 'canon',
        anchor: refreshedCharacters.writerSections[0]!.anchor,
        headingPath: ['公开角色', '身份'],
      },
    });
    assert.equal(secondThread.statusCode, 200, secondThread.body);
    const renamed = await app.inject({
      method: 'PUT',
      url: pathFor('角色.md'),
      payload: {
        content: repairedCharacters.replace('### 身份', '### 新身份'),
        baseSha256: json(adopted).data.sha256,
        sourceThreadId: json(secondThread).data.id,
      },
    });
    assert.equal(renamed.statusCode, 400, renamed.body);
    const outside = await app.inject({
      method: 'PUT',
      url: pathFor('角色.md'),
      payload: {
        content: `前言越界\n${repairedCharacters}`,
        baseSha256: json(adopted).data.sha256,
        sourceThreadId: json(secondThread).data.id,
      },
    });
    assert.equal(outside.statusCode, 400, outside.body);

    const newAliasBefore = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/mentions/${encodeURIComponent('地点C')}`,
    });
    assert.deepEqual(json(newAliasBefore).data, []);
    const settingsPayload = (json(refreshedSidebar).data as typeof sidebarData)
      .find((source) => source.sourceId === 'setting_index')!;
    const settingsThread = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: {
        projectId: PROJECT_ID,
        docId: '设定索引.md',
        kind: 'rewrite',
        origin: 'canon',
        anchor: settingsPayload.writerSections[0]!.anchor,
        headingPath: ['地理'],
      },
    });
    assert.equal(settingsThread.statusCode, 200, settingsThread.body);
    const rawSettings = readFileSync(join(vault, '设定索引.md'), 'utf8');
    const settingsAdopted = await app.inject({
      method: 'PUT',
      url: pathFor('设定索引.md'),
      payload: {
        content: rawSettings.replace('地点B', '地点C'),
        baseSha256: sha256(rawSettings),
        sourceThreadId: json(settingsThread).data.id,
      },
    });
    assert.equal(settingsAdopted.statusCode, 200, settingsAdopted.body);
    const newAliasAfter = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/mentions/${encodeURIComponent('地点C')}`,
    });
    assert.deepEqual(json(newAliasAfter).data, [{
      docId: DOC_ID,
      chapterNo: 1,
      count: 1,
      firstOffset: 21,
    }]);

    const safeSettings = readFileSync(join(vault, '设定索引.md'), 'utf8');
    const settingsWithUnknownColumn = safeSettings
      .replace('| 编号 | 术语 | 出处 | 首次 | 留白 | 状态 |', '| 编号 | 术语 | 出处 | 首次 | 留白 | 状态 | Internal |')
      .replace('| - | - | - | - | - | - |', '| - | - | - | - | - | - | - |')
      .replace('| 01 | 地点C | 世界观 | 第1章 | — | 已定 |', '| 01 | 地点C | 世界观 | 第1章 | — | 已定 | HIDDEN_VALUE |');
    writeFileSync(join(vault, '设定索引.md'), settingsWithUnknownColumn);
    const unsafeSettingsSidebar = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/sidebar?view=writer`,
    });
    const unsafeSettingsPayload = (json(unsafeSettingsSidebar).data as typeof sidebarData)
      .find((source) => source.sourceId === 'setting_index')!;
    assert.deepEqual(unsafeSettingsPayload.writerSections, []);
    assert.doesNotMatch(JSON.stringify(unsafeSettingsPayload), /HIDDEN_VALUE/);
    const unsafeSettingsThread = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: {
        projectId: PROJECT_ID,
        docId: '设定索引.md',
        kind: 'rewrite',
        origin: 'canon',
        anchor: {
          docSha: sha256(settingsWithUnknownColumn),
          start: 0,
          end: settingsWithUnknownColumn.length,
          prefix: '',
          exact: settingsWithUnknownColumn,
          suffix: '',
        },
        headingPath: ['地理'],
      },
    });
    assert.equal(unsafeSettingsThread.statusCode, 400, unsafeSettingsThread.body);

    const settingsWithHiddenLinkTarget = safeSettings.replace(
      '| 01 | 地点C | 世界观 | 第1章 | — | 已定 |',
      '| 01 | [地点C](HIDDEN_VALUE) | 世界观 | 第1章 | — | 已定 |',
    );
    writeFileSync(join(vault, '设定索引.md'), settingsWithHiddenLinkTarget);
    const hiddenLinkSidebar = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/sidebar?view=writer`,
    });
    const hiddenLinkPayload = (json(hiddenLinkSidebar).data as typeof sidebarData)
      .find((source) => source.sourceId === 'setting_index')!;
    assert.deepEqual(hiddenLinkPayload.writerSections, []);
    assert.doesNotMatch(JSON.stringify(hiddenLinkPayload), /HIDDEN_VALUE/);
    const hiddenLinkThread = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: {
        projectId: PROJECT_ID,
        docId: '设定索引.md',
        kind: 'rewrite',
        origin: 'canon',
        anchor: {
          docSha: sha256(settingsWithHiddenLinkTarget),
          start: 0,
          end: settingsWithHiddenLinkTarget.length,
          prefix: '',
          exact: settingsWithHiddenLinkTarget,
          suffix: '',
        },
        headingPath: ['地理'],
      },
    });
    assert.equal(hiddenLinkThread.statusCode, 400, hiddenLinkThread.body);
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('echo runs enforce busy, persist messages, and revisions survive app restart with dedupe', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    app = await makeApp(fixture);
    const threadReply = await app.inject({
      method: 'POST', url: '/api/threads', payload: { projectId: PROJECT_ID, docId: DOC_ID, kind: 'ask' },
    });
    assert.equal(threadReply.statusCode, 200, threadReply.body);
    const threadId = json(threadReply).data.id as string;
    const firstRun = await app.inject({ method: 'POST', url: `/api/threads/${threadId}/messages`, payload: { content: '请回复这条集成测试消息。' } });
    assert.equal(firstRun.statusCode, 200);
    const runId = json(firstRun).data.runId as string;
    const busy = await app.inject({ method: 'POST', url: `/api/threads/${threadId}/messages`, payload: { content: '这条应被拒绝。' } });
    assert.equal(busy.statusCode, 409);
    assert.equal(json(busy).error.code, 'THREAD_BUSY');
    const completed = await waitForAssistant(app, threadId);
    assert.deepEqual(completed.data.messages.map((message: { role: string }) => message.role), ['user', 'assistant']);
    assert.match(completed.data.messages[1].content, /【echo】收到消息/);
    const recoveredRun = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    assert.equal(recoveredRun.statusCode, 200);
    assert.deepEqual(json(recoveredRun).data, {
      id: runId,
      projectId: PROJECT_ID,
      threadId,
      agentId: 'echo',
      status: 'completed',
      errorCode: null,
      errorDetail: null,
      createdAt: json(recoveredRun).data.createdAt,
      finishedAt: json(recoveredRun).data.finishedAt,
    });
    assert.equal(typeof json(recoveredRun).data.createdAt, 'number');
    assert.equal(typeof json(recoveredRun).data.finishedAt, 'number');
    assert.equal('stderr' in json(recoveredRun).data, false);
    const db = new Database(join(fixture.dataDir, PROJECT_ID, 'panel.sqlite3'), { readonly: true });
    try {
      const row = db.prepare('SELECT context_manifest_json FROM runs WHERE id = ?').get(runId) as {
        context_manifest_json: string | null;
      };
      const manifest = JSON.parse(row.context_manifest_json ?? 'null') as Array<{ sourceId: string }>;
      assert.deepEqual(manifest.map((entry) => entry.sourceId), [`document:${DOC_ID}`]);
    } finally {
      db.close();
    }
    const unknownRun = await app.inject({ method: 'GET', url: '/api/runs/does-not-exist' });
    assert.equal(unknownRun.statusCode, 404);
    assert.equal(json(unknownRun).error.code, 'NOT_FOUND');

    const revisionPayload = { kind: 'manual_snapshot', content: 'revision snapshot', label: 'integration' };
    const one = await app.inject({ method: 'POST', url: `${documentPath()}/revisions`, payload: revisionPayload });
    const two = await app.inject({ method: 'POST', url: `${documentPath()}/revisions`, payload: revisionPayload });
    assert.equal(one.statusCode, 200);
    assert.equal(two.statusCode, 200);
    assert.equal(json(one).data.id, json(two).data.id);
    const revisionId = json(one).data.id as string;
    assert.equal(json(one).data.sha256, sha256(revisionPayload.content));

    await app.close();
    app = await makeApp(fixture);
    const reopenedThread = await app.inject({ method: 'GET', url: `/api/threads/${threadId}` });
    assert.equal(reopenedThread.statusCode, 200);
    assert.equal(json(reopenedThread).data.messages.length, 2);
    const revisions = await app.inject({ method: 'GET', url: `${documentPath()}/revisions` });
    assert.equal(revisions.statusCode, 200);
    assert.equal(json(revisions).data.length, 1);
    const revision = await app.inject({ method: 'GET', url: `/api/revisions/${revisionId}` });
    assert.equal(revision.statusCode, 200);
    assert.equal(json(revision).data.content, revisionPayload.content);
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('mentions endpoint scans only chapters and refreshes the changed chapter by SHA', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    writeFileSync(
      join(fixture.root, 'vault', DOC_ID),
      '# 第1章\n\n公开角色出现一次，公开角色再出现一次。后备角色尚未建卡。\n',
    );
    app = await makeApp(fixture);
    const url = `/api/projects/${PROJECT_ID}/mentions/${encodeURIComponent('公开角色')}`;
    const first = await app.inject({ method: 'GET', url });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(json(first).data, [{ docId: DOC_ID, chapterNo: 1, count: 2, firstOffset: 7 }]);

    writeFileSync(
      join(fixture.root, 'vault', DOC_ID),
      '# 第1章\n\n公开角色只出现一次。后备角色尚未建卡。\n',
    );
    const changed = await app.inject({ method: 'GET', url });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.deepEqual(json(changed).data, [{ docId: DOC_ID, chapterNo: 1, count: 1, firstOffset: 7 }]);

    const hidden = await app.inject({
      method: 'GET', url: `/api/projects/${PROJECT_ID}/mentions/${encodeURIComponent('隐藏角色')}`,
    });
    assert.equal(hidden.statusCode, 200);
    assert.deepEqual(json(hidden).data, []);

    writeFileSync(join(fixture.root, 'vault', '角色.md'), [
      '## 公开角色', '### 身份', '公开事实。',
      '## 后备角色', '### 身份', '后备事实。',
    ].join('\n'));
    const aliasChanged = await app.inject({
      method: 'GET', url: `/api/projects/${PROJECT_ID}/mentions/${encodeURIComponent('后备角色')}`,
    });
    assert.equal(aliasChanged.statusCode, 200, aliasChanged.body);
    assert.deepEqual(json(aliasChanged).data, [{
      docId: DOC_ID,
      chapterNo: 1,
      count: 1,
      firstOffset: 17,
    }]);
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('mentions endpoint counts an overlapping full name and short alias once', async () => {
  const fixture = makeFixture();
  let app: FastifyInstance | undefined;
  try {
    writeFileSync(join(fixture.root, 'vault', '角色.md'), [
      '## 公开角色（Public）',
      '### 身份',
      '公开事实。',
    ].join('\n'));
    writeFileSync(join(fixture.root, 'vault', DOC_ID), '# 第1章\n\n公开角色（Public）来到这里。\n');
    app = await makeApp(fixture);
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/mentions/${encodeURIComponent('公开角色（Public）')}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(json(response).data, [{
      docId: DOC_ID,
      chapterNo: 1,
      count: 1,
      firstOffset: 7,
    }]);
  } finally {
    await app?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
