import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProjectConfig } from '@writing-studio/contract';
import {
  extractTitle,
  readDocument,
  renameChapterTitle,
  VaultError,
} from '../src/vault.js';

function projectConfig(
  numberStyle: 'arabic' | 'cnLower',
  titleTemplate?: string,
  titleStripRegex?: string,
): ProjectConfig {
  return {
    schemaVersion: 1,
    id: `rename-${numberStyle}`,
    displayName: 'Rename fixture',
    contentTree: {
      root: '正文',
      levels: [],
      leaf: {
        filePattern: '第{num}章.md',
        numberStyle,
        ...(titleTemplate ? { titleTemplate } : {}),
        numberingScope: 'book',
        titleStripRegex: titleStripRegex ?? (numberStyle === 'arabic'
          ? '^Chapter\\s+\\d+:\\s*'
          : '^第[一二三四五六七八九十百千万亿零]+章\\s*'),
      },
    },
    draftsDir: '草稿',
    sidebarSources: [],
    aiProfiles: {
      writer: {
        description: 'writer',
        readable: ['正文/**'],
        forbidden: [],
        allowVaultBrowsing: false,
      },
      planner: {
        description: 'planner',
        readable: ['正文/**'],
        forbidden: [],
        allowVaultBrowsing: true,
      },
      defaultProfile: 'writer',
    },
    defaultAgentId: 'echo',
  };
}

function withVault(run: (vault: string) => void): void {
  const vault = mkdtempSync(join(tmpdir(), 'writing-studio-title-'));
  try {
    mkdirSync(join(vault, '正文'), { recursive: true });
    run(vault);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

test('chapter title rename changes only the H1 line for default zh and arabic templates', () => {
  for (const fixture of [
    {
      config: projectConfig('cnLower'),
      docId: '正文/第一章.md',
      before: '# 第一章 旧题\n\n正文第一行。\n正文第二行。\n',
      title: '新题',
      expectedHeading: '# 第一章 新题',
    },
    {
      config: projectConfig('arabic', 'Chapter {num}: {title}'),
      docId: '正文/第12章.md',
      before: '# Chapter 12: Before\n\nBody one.\nBody two.\n',
      title: 'After',
      expectedHeading: '# Chapter 12: After',
    },
    {
      // Renaming under the default template rewrites the heading in the
      // configured number style, even when the old heading used another one.
      config: projectConfig('arabic', undefined, '^第[0-9一二三四五六七八九十百千万亿零]+章\\s*'),
      docId: '正文/第76章.md',
      before: '# 第七十六章 旧题\n\n正文第一行。\n正文第二行。\n',
      title: '新题',
      expectedHeading: '# 第76章 新题',
    },
  ]) {
    withVault((vault) => {
      const path = join(vault, fixture.docId);
      writeFileSync(path, fixture.before);
      const loaded = readDocument(vault, fixture.config, fixture.docId);
      const renamed = renameChapterTitle(
        vault,
        fixture.config,
        fixture.docId,
        fixture.title,
        loaded.meta.sha256,
      );
      const after = readFileSync(path, 'utf8');
      assert.equal(after.split('\n')[0], fixture.expectedHeading);
      assert.deepEqual(after.split('\n').slice(1), fixture.before.split('\n').slice(1));
      assert.equal(renamed.meta.chapterNo, loaded.meta.chapterNo);
      assert.equal(renamed.meta.title, fixture.title);
    });
  }
});

test('backtick fence before the real H1 is ignored by title read and rename', () => {
  withVault((vault) => {
    const config = projectConfig('cnLower');
    const docId = '正文/第一章.md';
    const path = join(vault, docId);
    const before = '```md\n# 假标题\n```\n\n# 第一章 真标题\n\n正文 $& 保持。\n';
    writeFileSync(path, before);

    const loaded = readDocument(vault, config, docId);
    assert.equal(extractTitle(before, config.contentTree.leaf.titleStripRegex), '真标题');
    renameChapterTitle(vault, config, docId, '新标题', loaded.meta.sha256);

    const after = readFileSync(path, 'utf8');
    assert.equal(after, '```md\n# 假标题\n```\n\n# 第一章 新标题\n\n正文 $& 保持。\n');
  });
});

test('a file with only a fenced H1 has no title and rename performs no write', () => {
  withVault((vault) => {
    const config = projectConfig('cnLower');
    const docId = '正文/第一章.md';
    const path = join(vault, docId);
    const before = '前言。\n```text\n# 假标题\n```\n正文。\n';
    writeFileSync(path, before);
    const loaded = readDocument(vault, config, docId);

    assert.equal(extractTitle(before, config.contentTree.leaf.titleStripRegex), null);
    assert.equal(loaded.meta.title, docId);
    assert.throws(
      () => renameChapterTitle(vault, config, docId, '新标题', loaded.meta.sha256),
      (error: unknown) => error instanceof VaultError && error.code === 'UNPROCESSABLE',
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  });
});

test('an unclosed fence hides every later H1 through EOF', () => {
  withVault((vault) => {
    const config = projectConfig('cnLower');
    const docId = '正文/第一章.md';
    const path = join(vault, docId);
    const before = '```\n代码。\n# 假标题\n';
    writeFileSync(path, before);
    const loaded = readDocument(vault, config, docId);

    assert.equal(extractTitle(before, config.contentTree.leaf.titleStripRegex), null);
    assert.throws(
      () => renameChapterTitle(vault, config, docId, '新标题', loaded.meta.sha256),
      (error: unknown) => error instanceof VaultError && error.code === 'UNPROCESSABLE',
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  });
});

test('tilde fence before the real H1 is ignored by title read and rename', () => {
  withVault((vault) => {
    const config = projectConfig('cnLower');
    const docId = '正文/第一章.md';
    const path = join(vault, docId);
    const before = '~~~md\n# 假标题\n~~~~\n# 第一章 真标题\n\n正文。\n';
    writeFileSync(path, before);
    const loaded = readDocument(vault, config, docId);

    assert.equal(extractTitle(before, config.contentTree.leaf.titleStripRegex), '真标题');
    renameChapterTitle(vault, config, docId, '新标题', loaded.meta.sha256);
    assert.equal(
      readFileSync(path, 'utf8'),
      '~~~md\n# 假标题\n~~~~\n# 第一章 新标题\n\n正文。\n',
    );
  });
});

test('CRLF fences behave exactly like their LF counterparts', () => {
  withVault((vault) => {
    const config = projectConfig('cnLower');
    const docId = '正文/第一章.md';
    const path = join(vault, docId);
    const before = '```md\r\n# 假标题\r\n```\r\n\r\n# 第一章 真标题\r\n';
    writeFileSync(path, before);
    const loaded = readDocument(vault, config, docId);

    assert.equal(extractTitle(before, config.contentTree.leaf.titleStripRegex), '真标题');
    renameChapterTitle(vault, config, docId, '新标题', loaded.meta.sha256);
    assert.equal(
      readFileSync(path, 'utf8'),
      '```md\r\n# 假标题\r\n```\r\n\r\n# 第一章 新标题\r\n',
    );
  });
});

test('a shorter closing run does not close a longer fence', () => {
  withVault((vault) => {
    const config = projectConfig('cnLower');
    const docId = '正文/第一章.md';
    const path = join(vault, docId);
    // ``` cannot close ````, so both # lines stay fenced until ```` closes.
    const before = '````\n# 假标题\n```\n# 仍在围栏内\n````\n# 第一章 真标题\n';
    writeFileSync(path, before);
    const loaded = readDocument(vault, config, docId);

    assert.equal(extractTitle(before, config.contentTree.leaf.titleStripRegex), '真标题');
    renameChapterTitle(vault, config, docId, '新标题', loaded.meta.sha256);
    assert.equal(
      readFileSync(path, 'utf8'),
      '````\n# 假标题\n```\n# 仍在围栏内\n````\n# 第一章 新标题\n',
    );
  });
});

test('chapter title rename is optimistic and fail-closed without a recognizable H1', () => {
  withVault((vault) => {
    const config = projectConfig('arabic', 'Chapter {num}: {title}');
    const docId = '正文/第2章.md';
    const path = join(vault, docId);
    const before = '# Chapter 2: Before\n\nBody.\n';
    writeFileSync(path, before);
    const base = readDocument(vault, config, docId).meta.sha256;
    renameChapterTitle(vault, config, docId, 'First', base);
    assert.throws(
      () => renameChapterTitle(vault, config, docId, 'Second', base),
      (error: unknown) => error instanceof VaultError && error.code === 'STALE_WRITE',
    );

    const malformed = 'Preface without an H1.\n\nBody.\n';
    writeFileSync(path, malformed);
    const malformedBase = readDocument(vault, config, docId).meta.sha256;
    assert.throws(
      () => renameChapterTitle(vault, config, docId, 'No guess', malformedBase),
      (error: unknown) => error instanceof VaultError && error.code === 'UNPROCESSABLE',
    );
    assert.equal(readFileSync(path, 'utf8'), malformed);
  });
});

test('filename patterns containing {title} are rejected without writing', () => {
  withVault((vault) => {
    const config = projectConfig('arabic', 'Chapter {num}: {title}');
    config.contentTree.leaf.filePattern = '第{num}章_{title}.md';
    const docId = '正文/第3章_Before.md';
    const path = join(vault, docId);
    const before = '# Chapter 3: Before\n\nBody.\n';
    writeFileSync(path, before);
    assert.throws(
      () => renameChapterTitle(vault, config, docId, 'After', 'a'.repeat(64)),
      (error: unknown) => error instanceof VaultError && error.code === 'UNPROCESSABLE',
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  });
});

test('bare or empty H1 lines fail closed instead of swallowing body paragraphs', () => {
  // `\s` matches newlines, so a naive /^#\s+(.+)$/m would cross the line break
  // and replace the first body paragraph. All three shapes must 422 unchanged.
  for (const before of [
    '# \n\n正文第一段。\n正文第二段。\n',
    '#\n\n正文第一段。\n正文第二段。\n',
    '#   \n正文第一段。\n',
  ]) {
    withVault((vault) => {
      const config = projectConfig('cnLower');
      const docId = '正文/第一章.md';
      const path = join(vault, docId);
      writeFileSync(path, before);
      const base = readDocument(vault, config, docId).meta.sha256;
      // The read side shares the strict locator: no title, not the old
      // lenient regex's cross-line swallow of the first body paragraph.
      assert.equal(extractTitle(before, config.contentTree.leaf.titleStripRegex), null);
      assert.throws(
        () => renameChapterTitle(vault, config, docId, '新题', base),
        (error: unknown) => error instanceof VaultError && error.code === 'UNPROCESSABLE',
      );
      assert.equal(readFileSync(path, 'utf8'), before);
    });
  }
});

test('replacement-pattern tokens in the new title are inserted literally', () => {
  withVault((vault) => {
    const config = projectConfig('cnLower');
    const docId = '正文/第一章.md';
    const path = join(vault, docId);
    writeFileSync(path, '# 第一章 旧题\n\n正文第一行。\n');
    const loaded = readDocument(vault, config, docId);
    const title = "售价$100 与 $&、$'、$`、$1$2、$$ 占位词";
    renameChapterTitle(vault, config, docId, title, loaded.meta.sha256);
    const after = readFileSync(path, 'utf8');
    assert.equal(after.split('\n')[0], `# 第一章 ${title}`);
    assert.ok(!after.includes('旧题'));
  });
});
