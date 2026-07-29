import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProjectConfig } from '@writing-studio/contract';
import {
  DEFAULT_GENERATE_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  getGenerateTimeoutMs,
  getRunTimeoutMs,
  loadProjects,
  projectListItems,
  resolveRegistryLocation,
} from '../src/config.js';
import { StudioError } from '../src/errors.js';
import { parseGitStatus } from '../src/git.js';
import { buildChapterTree, parseCnNumber } from '../src/tree.js';
import {
  VaultError,
  createChapter,
  createDraft,
  deleteDraft,
  listDrafts,
  listTrash,
  readDocument,
  resolveDocPath,
  restoreDraft,
  sha256,
  writeDocument,
} from '../src/vault.js';

const CONFIG: ProjectConfig = {
  schemaVersion: 1,
  id: 'valid-project',
  displayName: 'Valid Project',
  contentTree: {
    root: '正文',
    levels: [
      {
        levelName: 'part',
        dirPattern: '第{num}部_{name}',
        numberStyle: 'cnLower',
        indexFile: null,
      },
    ],
    leaf: {
      filePattern: '第{num}章.md',
      numberStyle: 'arabic',
      numberingScope: 'book',
      titleStripRegex: '^第\\d+章[：:]?\\s*',
    },
  },
  draftsDir: '草稿',
  sidebarSources: [],
  aiProfiles: {
    writer: { description: '', readable: [], forbidden: [], allowVaultBrowsing: false },
    planner: { description: '', readable: [], forbidden: [], allowVaultBrowsing: true },
    defaultProfile: 'writer',
  },
  defaultAgentId: 'echo',
};

function withTempDir(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'writing-studio-test-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('run timeout defaults safely and rejects invalid environment values', () => {
  assert.equal(getRunTimeoutMs(undefined), DEFAULT_RUN_TIMEOUT_MS);
  assert.equal(getRunTimeoutMs('1000'), 1_000);
  for (const invalid of ['0', '-1', '1.5', 'NaN', '2147483648']) {
    assert.throws(
      () => getRunTimeoutMs(invalid),
      (error: unknown) => error instanceof StudioError && error.code === 'INVALID_CONFIG',
      invalid,
    );
  }
});

test('generation timeout has an independent validated default and override', () => {
  assert.equal(getGenerateTimeoutMs(undefined), DEFAULT_GENERATE_TIMEOUT_MS);
  assert.equal(DEFAULT_GENERATE_TIMEOUT_MS, 600_000);
  assert.equal(getGenerateTimeoutMs('1000'), 1_000);
  for (const invalid of ['0', '-1', '1.5', 'NaN', '2147483648']) {
    assert.throws(
      () => getGenerateTimeoutMs(invalid),
      (error: unknown) => error instanceof StudioError && error.code === 'INVALID_CONFIG',
      invalid,
    );
  }
});

test('a missing registry is a stable, actionable empty-project bootstrap state', () => {
  withTempDir((root) => {
    const dataDir = join(root, 'unprovisioned-data');
    const location = resolveRegistryLocation({ dataDir });

    assert.equal(location.dataDir, dataDir);
    assert.equal(location.registryPath, join(dataDir, 'registry.json'));
    assert.equal(location.exists, false);

    const projects = loadProjects({ dataDir });
    assert.equal(projects.size, 0);
    assert.deepEqual(projectListItems(projects), []);
  });
});

test('relative registry vault roots are resolved from the registry directory', () => {
  withTempDir((root) => {
    const dataDir = join(root, 'data');
    const vault = join(root, 'example-vault');
    mkdirSync(join(vault, '.writing-studio'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(vault, '.writing-studio', 'project.json'), JSON.stringify(CONFIG));
    writeFileSync(join(dataDir, 'registry.json'), JSON.stringify({
      projects: [{ id: CONFIG.id, vaultRoot: '../example-vault', enabled: true }],
    }));

    const loaded = loadProjects({ dataDir }).get(CONFIG.id);
    assert.equal(loaded?.status, 'ready');
    if (loaded?.status === 'ready') assert.equal(loaded.project.vaultRoot, realpathSync(vault));
  });
});

test('project loading isolates an invalid vault config', () => {
  withTempDir((root) => {
    const dataDir = join(root, 'data');
    const validVault = join(root, 'valid');
    const invalidVault = join(root, 'invalid');
    mkdirSync(join(validVault, '.writing-studio'), { recursive: true });
    mkdirSync(join(invalidVault, '.writing-studio'), { recursive: true });
    writeFileSync(join(validVault, '.writing-studio', 'project.json'), JSON.stringify(CONFIG));
    writeFileSync(join(invalidVault, '.writing-studio', 'project.json'), '{}');
    mkdirSync(dataDir, { recursive: true });
    const registryPath = join(dataDir, 'registry.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        projects: [
          { id: 'valid-project', vaultRoot: validVault, enabled: true },
          { id: 'invalid-project', vaultRoot: invalidVault, enabled: true },
        ],
      }),
    );

    const projects = loadProjects({ dataDir, registryPath });
    assert.equal(projects.get('valid-project')?.status, 'ready');
    assert.equal(projects.get('invalid-project')?.status, 'invalid');
    assert.deepEqual(
      projectListItems(projects).map((item) => item.status),
      ['ready', 'invalid'],
    );
  });
});

test('vault read/write is exact, atomic and optimistic', () => {
  withTempDir((vault) => {
    const docId = '正文/第一部_开端/第1章.md';
    mkdirSync(join(vault, '正文', '第一部_开端'), { recursive: true });
    const initial = '# 第1章：开始\n\n正文。\n';
    writeFileSync(join(vault, docId), initial);

    const loaded = readDocument(vault, CONFIG, docId);
    assert.equal(loaded.content, initial);
    const next = '# 第1章：开始\n\n修改后的正文。\n';
    const meta = writeDocument(vault, CONFIG, docId, next, loaded.meta.sha256);
    assert.equal(readFileSync(join(vault, docId), 'utf8'), next);
    assert.equal(meta.sha256, sha256(next));
    assert.equal(readdirSync(join(vault, '正文', '第一部_开端')).some((name) => name.startsWith('.ws-write-')), false);

    assert.throws(
      () => writeDocument(vault, CONFIG, docId, '覆盖', loaded.meta.sha256),
      (error: unknown) => error instanceof VaultError && error.code === 'STALE_WRITE',
    );
    assert.throws(
      () => writeDocument(vault, CONFIG, '正文/不存在.md', '新建', sha256('')),
      (error: unknown) => error instanceof VaultError && error.code === 'NOT_FOUND',
    );
  });
});

test('chapter creation follows the content tree, increments atomically, and rejects non-leaf overrides', () => {
  withTempDir((vault) => {
    const config: ProjectConfig = {
      ...CONFIG,
      contentTree: {
        root: '正文',
        levels: [
          {
            levelName: 'part',
            dirPattern: '第{num}部_{name}',
            numberStyle: 'cnLower',
            indexFile: null,
          },
          {
            levelName: 'arc',
            dirPattern: '第{num}篇_{name}',
            numberStyle: 'cnLower',
            indexFile: null,
          },
        ],
        leaf: {
          filePattern: '第{num}章.md',
          numberStyle: 'arabic',
          numberingScope: 'book',
          titleStripRegex: '^第[一二三四五六七八九十百零]+章\\s*',
        },
      },
    };
    const latestDir = join(vault, '正文', '第二部_部名A', '第三篇_篇名A');
    mkdirSync(latestDir, { recursive: true });
    mkdirSync(join(vault, '正文', '第一部_部名B', '第一篇_篇名B'), { recursive: true });
    writeFileSync(join(latestDir, '第13章.md'), '# 第十三章 旧章\n\n结尾。\n');
    writeFileSync(
      join(vault, '正文', '第一部_部名B', '第一篇_篇名B', '第12章.md'),
      '# 第十二章 旧章\n',
    );

    const chapterA = createChapter(vault, config, '  章节标题A  ');
    assert.equal(chapterA.docId, '正文/第二部_部名A/第三篇_篇名A/第14章.md');
    assert.equal(readFileSync(join(vault, chapterA.docId), 'utf8'), '# 第14章 章节标题A\n\n');

    const chapterB = createChapter(vault, config, '章节标题B');
    assert.equal(chapterB.docId, '正文/第二部_部名A/第三篇_篇名A/第15章.md');

    assert.throws(
      () => createChapter(vault, config, '错误', '正文/第二部_部名A'),
      (error: unknown) => error instanceof VaultError && error.code === 'VALIDATION',
    );
    assert.throws(
      () => createChapter(vault, config, '错误', '正文/不存在/第三篇_篇名A'),
      (error: unknown) => error instanceof VaultError && error.code === 'VALIDATION',
    );
  });
});

test('chapter creation default title follows the arabic file number style', () => {
  withTempDir((vault) => {
    const chapterDir = join(vault, '正文', '第一部_开端');
    mkdirSync(chapterDir, { recursive: true });
    writeFileSync(join(chapterDir, '第1章.md'), '# 第一章 旧章\n\n');

    const chapter = createChapter(vault, CONFIG, '  章节标题A  ');

    assert.equal(chapter.docId, '正文/第一部_开端/第2章.md');
    assert.equal(
      readFileSync(join(vault, chapter.docId), 'utf8'),
      '# 第2章 章节标题A\n\n',
    );
  });
});

test('explicit null title template creates the same bytes as an omitted template', () => {
  const createBytes = (titleTemplate: null | undefined): string => {
    let content = '';
    withTempDir((vault) => {
      const chapterDir = join(vault, '正文', '第一部_开端');
      mkdirSync(chapterDir, { recursive: true });
      const config: ProjectConfig = {
        ...CONFIG,
        contentTree: {
          ...CONFIG.contentTree,
          leaf: { ...CONFIG.contentTree.leaf, titleTemplate },
        },
      };
      const chapter = createChapter(vault, config, '章节标题A');
      content = readFileSync(join(vault, chapter.docId), 'utf8');
    });
    return content;
  };

  assert.equal(createBytes(null), createBytes(undefined));
  assert.equal(createBytes(null), '# 第1章 章节标题A\n\n');
});

test('chapter creation renders configured title placeholders and preserves unknown placeholders', () => {
  const createWithTemplate = (
    titleTemplate: string,
    existingChapterNo: number,
    title: string,
  ): string => {
    let content = '';
    withTempDir((vault) => {
      const chapterDir = join(vault, '正文', '第一部_开端');
      mkdirSync(chapterDir, { recursive: true });
      if (existingChapterNo > 0) {
        writeFileSync(
          join(chapterDir, `第${existingChapterNo}章.md`),
          '# existing\n\n',
        );
      }
      const config: ProjectConfig = {
        ...CONFIG,
        contentTree: {
          ...CONFIG.contentTree,
          leaf: { ...CONFIG.contentTree.leaf, titleTemplate },
        },
      };
      const chapter = createChapter(vault, config, title);
      content = readFileSync(join(vault, chapter.docId), 'utf8');
    });
    return content;
  };

  assert.equal(
    createWithTemplate('Chapter {num}: {title}', 0, 'Opening $&'),
    '# Chapter 1: Opening $&\n\n',
  );
  assert.equal(
    createWithTemplate('第{numCn}章 {title}', 11, '章节标题A'),
    '# 第十二章 章节标题A\n\n',
  );
  assert.equal(
    createWithTemplate('Chapter {num} {foo} {title}', 0, 'Opening'),
    '# Chapter 1 {foo} Opening\n\n',
  );
});

test('title template {num} follows numberStyle and titles are not re-substituted', () => {
  withTempDir((vault) => {
    mkdirSync(join(vault, '正文', '第一部_开端'), { recursive: true });
    const config: ProjectConfig = {
      ...CONFIG,
      contentTree: {
        ...CONFIG.contentTree,
        leaf: {
          ...CONFIG.contentTree.leaf,
          numberStyle: 'cnLower',
          titleTemplate: '第{num}章 {title}',
        },
      },
    };
    const chapter = createChapter(vault, config, '含{num}与{numCn}的标题');
    assert.equal(
      readFileSync(join(vault, chapter.docId), 'utf8'),
      '# 第一章 含{num}与{numCn}的标题\n\n',
    );
  });
});

test('title template rendering must stay on a single line', () => {
  withTempDir((vault) => {
    mkdirSync(join(vault, '正文', '第一部_开端'), { recursive: true });
    const config: ProjectConfig = {
      ...CONFIG,
      contentTree: {
        ...CONFIG.contentTree,
        leaf: {
          ...CONFIG.contentTree.leaf,
          titleTemplate: 'Chapter {num}\n## injected\n{title}',
        },
      },
    };
    assert.throws(() => createChapter(vault, config, 'Real'), /single line/);
  });
});

test('write rechecks the target immediately before atomic replacement', () => {
  withTempDir((vault) => {
    const docId = '正文/第一部_开端/第1章.md';
    const abs = join(vault, docId);
    mkdirSync(join(vault, '正文', '第一部_开端'), { recursive: true });
    const initial = '# 第1章：开始\n\n原文。\n';
    const external = '# 第1章：开始\n\nObsidian 的外部改动。\n';
    writeFileSync(abs, initial);
    const loaded = readDocument(vault, CONFIG, docId);

    assert.throws(
      () =>
        writeDocument(vault, CONFIG, docId, '# 第1章：开始\n\n面板改动。\n', loaded.meta.sha256, {
          // This hook executes after the temp file is fsynced, deterministically
          // simulating the exact race window without timing-dependent sleeps.
          beforeFinalCheck: () => writeFileSync(abs, external),
        }),
      (error: unknown) => error instanceof VaultError && error.code === 'STALE_WRITE',
    );
    assert.equal(readFileSync(abs, 'utf8'), external);
    assert.equal(readdirSync(join(vault, '正文', '第一部_开端')).some((name) => name.startsWith('.ws-write-')), false);
  });
});

test('write rejects a same-content replacement of the target path', () => {
  withTempDir((vault) => {
    const docId = '正文/第一部_开端/第1章.md';
    const dir = join(vault, '正文', '第一部_开端');
    const abs = join(vault, docId);
    mkdirSync(dir, { recursive: true });
    const initial = '# 第1章：开始\n\n原文。\n';
    writeFileSync(abs, initial);
    const loaded = readDocument(vault, CONFIG, docId);

    assert.throws(
      () =>
        writeDocument(vault, CONFIG, docId, '# 第1章：开始\n\n面板改动。\n', loaded.meta.sha256, {
          // A replacement with byte-identical content defeats a hash-only
          // check, but must still never be overwritten by this save.
          beforeFinalCheck: () => {
            const replacement = join(dir, 'external-replacement.md');
            writeFileSync(replacement, initial);
            renameSync(replacement, abs);
          },
        }),
      (error: unknown) => error instanceof VaultError && error.code === 'STALE_WRITE',
    );
    assert.equal(readFileSync(abs, 'utf8'), initial);
  });
});

test('path escape and symlink escape are rejected', () => {
  withTempDir((root) => {
    const vault = join(root, 'vault');
    mkdirSync(vault);
    const outside = join(root, 'outside.md');
    const outsideTree = join(root, 'outside-tree');
    const internalPrivateTree = join(vault, 'private-tree');
    writeFileSync(outside, 'secret');
    mkdirSync(outsideTree);
    mkdirSync(internalPrivateTree);
    writeFileSync(join(internalPrivateTree, 'secret.md'), 'internal secret');
    symlinkSync(outside, join(vault, 'link.md'));
    symlinkSync(outsideTree, join(vault, '正文'));
    symlinkSync(internalPrivateTree, join(vault, 'public-alias'));

    for (const docId of ['../outside.md', '/etc/passwd', 'safe/../../outside.md']) {
      assert.throws(
        () => resolveDocPath(vault, docId),
        (error: unknown) => error instanceof VaultError && error.code === 'PATH_ESCAPE',
      );
    }
    assert.throws(
      () => resolveDocPath(vault, 'link.md'),
      (error: unknown) => error instanceof VaultError && error.code === 'PATH_ESCAPE',
    );
    assert.throws(
      () => resolveDocPath(vault, 'public-alias/secret.md'),
      (error: unknown) => error instanceof VaultError && error.code === 'PATH_ESCAPE',
    );
    assert.throws(
      () => buildChapterTree(vault, CONFIG),
      (error: unknown) => error instanceof VaultError && error.code === 'PATH_ESCAPE',
    );
  });
});

test('tree and drafts follow config without adding panel metadata', () => {
  withTempDir((vault) => {
    mkdirSync(join(vault, '正文', '第十二部_部名A'), { recursive: true });
    writeFileSync(join(vault, '正文', '第十二部_部名A', '第81章.md'), '# 第81章：章节标题A\n\n内容');
    const tree = buildChapterTree(vault, CONFIG);
    assert.equal(parseCnNumber('一百零三'), 103);
    assert.equal(tree.root.children[0]?.chapters[0]?.title, '章节标题A');
    const draft = createDraft(vault, CONFIG, '测试/草稿');
    assert.equal(draft.kind, 'draft');
    assert.equal(readFileSync(join(vault, draft.docId), 'utf8'), '# 测试_草稿\n\n');
  });
});

test('draft soft delete moves into hidden trash and scanners exclude it', () => {
  withTempDir((root) => {
    const vault = join(root, 'vault');
    mkdirSync(join(vault, '正文', '第一部_开端'), { recursive: true });
    mkdirSync(join(vault, '草稿'), { recursive: true });
    writeFileSync(join(vault, '正文', '第一部_开端', '第1章.md'), '# 第一章\n');
    const draft = createDraft(vault, CONFIG, '待删除');
    const deleted = deleteDraft(vault, CONFIG, draft.docId);
    assert.equal(readdirSync(join(vault, '草稿')).includes(draft.docId.split('/').at(-1)!), false);
    assert.equal(readFileSync(join(vault, deleted.trashedDocId), 'utf8'), '# 待删除\n\n');
    assert.deepEqual(listDrafts(vault, CONFIG), []);
    assert.doesNotMatch(JSON.stringify(buildChapterTree(vault, CONFIG)), /\.trash|待删除/);
  });
});

test('draft trash round-trip preserves bytes and full underscore-rich original name', () => {
  withTempDir((root) => {
    const vault = join(root, 'vault');
    mkdirSync(join(vault, '草稿'), { recursive: true });
    const originalName = '2026-07-25_我的_草稿.md';
    const originalPath = join(vault, '草稿', originalName);
    const originalBytes = Buffer.from('# 我的_草稿\n\n逐字节内容 $\n', 'utf8');
    writeFileSync(originalPath, originalBytes);

    const deleted = deleteDraft(vault, CONFIG, `草稿/${originalName}`);
    const entries = listTrash(vault, CONFIG);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.trashedDocId, deleted.trashedDocId);
    assert.equal(entries[0]?.originalName, originalName);
    assert.match(entries[0]?.deletedAt ?? '', /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(entries[0]?.title, '我的_草稿');

    const restored = restoreDraft(vault, CONFIG, deleted.trashedDocId);
    assert.equal(restored.docId, `草稿/${originalName}`);
    assert.deepEqual(readFileSync(originalPath), originalBytes);
    assert.equal(listTrash(vault, CONFIG).length, 0);
    assert.equal(listDrafts(vault, CONFIG).some((draft) => draft.docId === restored.docId), true);
  });
});

test('trash listing is read-only when absent and manual entries restore by whole filename', () => {
  withTempDir((vault) => {
    mkdirSync(join(vault, '草稿'), { recursive: true });
    const trashDir = join(vault, '草稿', '.trash');
    assert.deepEqual(listTrash(vault, CONFIG), []);
    assert.equal(existsSync(trashDir), false);

    mkdirSync(trashDir);
    writeFileSync(join(trashDir, '用户_手工放入.md'), '没有标题\n');
    const [entry] = listTrash(vault, CONFIG);
    assert.equal(entry?.originalName, '用户_手工放入.md');
    assert.equal(entry?.title, '用户_手工放入');
    assert.match(entry?.deletedAt ?? '', /^\d{4}-\d{2}-\d{2}T/u);
    const restored = restoreDraft(vault, CONFIG, entry!.trashedDocId);
    assert.equal(restored.docId, '草稿/用户_手工放入.md');
    assert.equal(readFileSync(join(vault, restored.docId), 'utf8'), '没有标题\n');
  });
});

test('dot-prefixed restore targets are hidden from listing and rejected on restore', () => {
  withTempDir((vault) => {
    const trashDir = join(vault, '草稿', '.trash');
    mkdirSync(trashDir, { recursive: true });
    // Both shapes strip to a dot-prefixed name that listDrafts and the
    // document path allowlist would never surface after a restore.
    const strandedNames = ['.hidden.md', '2026-07-25T01:02:03.004Z_.md'];
    for (const filename of strandedNames) {
      writeFileSync(join(trashDir, filename), filename);
    }
    writeFileSync(join(trashDir, '2026-07-25T01:02:03.004Z_可见.md'), '# 可见\n');

    assert.deepEqual(
      listTrash(vault, CONFIG).map((entry) => entry.originalName),
      ['可见.md'],
    );

    for (const filename of strandedNames) {
      assert.throws(
        () => restoreDraft(vault, CONFIG, `草稿/.trash/${filename}`),
        (error: unknown) => error instanceof VaultError && error.code === 'VALIDATION',
      );
      assert.equal(readFileSync(join(trashDir, filename), 'utf8'), filename);
      assert.equal(existsSync(join(vault, '草稿', trashOriginalNameForTest(filename))), false);
    }
  });
});

function trashOriginalNameForTest(filename: string): string {
  return filename.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_/u, () => '');
}

test('trash listing sorts by deletedAt descending with a stable docId tie-breaker', () => {
  withTempDir((vault) => {
    const trashDir = join(vault, '草稿', '.trash');
    mkdirSync(trashDir, { recursive: true });
    const filenames = [
      '2026-07-25T01:02:03.004Z_b.md',
      '2026-07-25T01:02:04.004Z_newest.md',
      '2026-07-25T01:02:03.004Z_a.md',
    ];
    for (const filename of filenames) writeFileSync(join(trashDir, filename), filename);
    const sameMtime = new Date('2026-07-25T01:02:05.000Z');
    for (const filename of filenames) utimesSync(join(trashDir, filename), sameMtime, sameMtime);

    assert.deepEqual(
      listTrash(vault, CONFIG).map((entry) => entry.trashedDocId),
      [
        '草稿/.trash/2026-07-25T01:02:04.004Z_newest.md',
        '草稿/.trash/2026-07-25T01:02:03.004Z_a.md',
        '草稿/.trash/2026-07-25T01:02:03.004Z_b.md',
      ],
    );
  });
});

test('restore conflict and path guards reject without changing either side', () => {
  withTempDir((root) => {
    const vault = join(root, 'vault');
    const outside = join(root, 'outside.md');
    mkdirSync(join(vault, '草稿', '.trash'), { recursive: true });
    const trashedDocId = '草稿/.trash/2026-07-25T01:02:03.004Z_冲突.md';
    const trashPath = join(vault, trashedDocId);
    const targetPath = join(vault, '草稿', '冲突.md');
    writeFileSync(trashPath, 'trash bytes');
    writeFileSync(targetPath, 'target bytes');

    assert.throws(
      () => restoreDraft(vault, CONFIG, trashedDocId),
      (error: unknown) => error instanceof VaultError && error.code === 'CONFLICT',
    );
    assert.equal(readFileSync(trashPath, 'utf8'), 'trash bytes');
    assert.equal(readFileSync(targetPath, 'utf8'), 'target bytes');

    for (const [docId, expectedCode] of [
      ['../草稿/.trash/逃逸.md', 'VALIDATION'],
      ['草稿/非回收站.md', 'VALIDATION'],
      ['草稿/.trash/不是Markdown.txt', 'VALIDATION'],
      ['草稿/.trash/子目录/x.md', 'VALIDATION'],
    ] as const) {
      assert.throws(
        () => restoreDraft(vault, CONFIG, docId),
        (error: unknown) => error instanceof VaultError && error.code === expectedCode,
      );
      assert.equal(readFileSync(trashPath, 'utf8'), 'trash bytes');
      assert.equal(readFileSync(targetPath, 'utf8'), 'target bytes');
    }

    writeFileSync(outside, 'outside bytes');
    const linkedDocId = '草稿/.trash/2026-07-25T01:02:03.005Z_链接.md';
    symlinkSync(outside, join(vault, linkedDocId));
    assert.throws(
      () => restoreDraft(vault, CONFIG, linkedDocId),
      (error: unknown) => error instanceof VaultError && error.code === 'PATH_ESCAPE',
    );
    assert.equal(readFileSync(outside, 'utf8'), 'outside bytes');
  });
});

test('document metadata derives chapter numbers from the configured leaf pattern and style', () => {
  withTempDir((vault) => {
    const cnConfig: ProjectConfig = {
      ...CONFIG,
      contentTree: {
        ...CONFIG.contentTree,
        levels: [],
        leaf: {
          ...CONFIG.contentTree.leaf,
          filePattern: '第{num}章.md',
          numberStyle: 'cnLower',
        },
      },
    };
    mkdirSync(join(vault, '正文'), { recursive: true });
    writeFileSync(join(vault, '正文', '第十二章.md'), '# 第十二章：章节标题A\n');
    assert.equal(readDocument(vault, cnConfig, '正文/第十二章.md').meta.chapterNo, 12);

    const customConfig: ProjectConfig = {
      ...cnConfig,
      contentTree: {
        ...cnConfig.contentTree,
        leaf: {
          ...cnConfig.contentTree.leaf,
          filePattern: 'chapter-{num}.md',
          numberStyle: 'arabic',
        },
      },
    };
    writeFileSync(join(vault, '正文', 'chapter-23.md'), '# Chapter 23\n');
    assert.equal(readDocument(vault, customConfig, '正文/chapter-23.md').meta.chapterNo, 23);
    assert.deepEqual(
      buildChapterTree(vault, customConfig).root.chapters.map((chapter) => chapter.chapterNo),
      [23],
    );
  });
});

test('porcelain v2 parser preserves paths containing spaces and rename records', () => {
  const raw = [
    '# branch.oid abc',
    '# branch.head main',
    '1 .M N... 100644 100644 100644 abc def 正文/file with spaces.md',
    '2 R. N... 100644 100644 100644 abc def R100 new name.md',
    'old name.md',
    '? untracked name.md',
    '',
  ].join('\0');
  assert.deepEqual(parseGitStatus(raw), {
    branch: 'main',
    dirty: [
      { status: '.M', path: '正文/file with spaces.md' },
      { status: 'R.', path: 'new name.md' },
      { status: '??', path: 'untracked name.md' },
    ],
  });
});
