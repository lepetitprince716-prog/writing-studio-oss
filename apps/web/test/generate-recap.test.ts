import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ChapterTree,
  SidebarPayload,
  WritingStatusDto,
} from '@writing-studio/contract';
import {
  selectMaxChapterNo,
  selectWritingStatus,
} from '../src/lib/writingStatus.js';

const browserStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string): string | null => browserStorage.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      browserStorage.set(key, value);
    },
  },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { innerWidth: 1024 },
});

const {
  GenerateRecapFullView,
  GenerateRecapPanelView,
  persistGenerateRecapCollapsed,
  persistGenerateRecapMoreOpen,
  readGenerateRecapCollapsed,
  readGenerateRecapMoreOpen,
  selectGenerateRecapContent,
} = await import('../src/components/GenerateRecapPanel.js');

const sectionHeadings: WritingStatusDto['sectionHeadings'] = {
  stopPoint: '停点', storylines: '故事线', activeForeshadow: '活跃伏笔速览',
  characterOneLiners: '角色一句话状态', redLines: '写作红线', expressionBaseline: '表达基线',
};

const status: WritingStatusDto = {
  sectionHeadings,
  lastRefreshed: '2026-07-25',
  stopChapter: 12,
  stopPoint: '示例停点描述。\n示例停点后续说明。',
  storylines: [
    { name: '主线', body: '示例主线进展描述。' },
    { name: '暗线', body: '示例暗线进展描述。' },
  ],
  activeForeshadow: [{ id: 'F07', content: '示例伏笔内容', status: '待回收' }],
  characterOneLiners: [{ name: '角色A', text: '示例角色一句话。' }],
  redLines: ['示例写作红线内容。'],
  expressionBaseline: '不应出现在前情面板中的表达基线。',
};

function writingStatusPayload(data: WritingStatusDto): SidebarPayload {
  return {
    sourceId: 'writing-status',
    parser: 'heading-sections',
    kind: 'writingStatus',
    data,
  };
}

test('writing-status selector returns the first matching source or null', () => {
  const plain: SidebarPayload = {
    sourceId: 'notes',
    parser: 'plain',
    markdown: 'notes',
  };
  const first = writingStatusPayload(status);
  const second = writingStatusPayload({ ...status, stopChapter: 99 });

  assert.equal(selectWritingStatus([]), null);
  assert.equal(selectWritingStatus([plain]), null);
  assert.equal(selectWritingStatus([plain, first, second]), status);
});

test('chapter selector uses only structured numeric chapter fields across nested nodes', () => {
  const chapter = (chapterNo: number | null) => ({
    docId: `chapter-${chapterNo ?? 'none'}.md`,
    projectId: 'project-a',
    kind: 'chapter' as const,
    title: '任意可配置标题',
    chapterNo,
    sha256: 'a'.repeat(64),
    bytes: 1,
    mtimeMs: 1,
  });
  const tree: ChapterTree = {
    root: {
      name: 'root',
      levelName: 'root',
      chapters: [chapter(4), chapter(null)],
      children: [{
        name: 'part',
        levelName: 'part',
        chapters: [chapter(15)],
        children: [],
      }],
    },
  };

  assert.equal(selectMaxChapterNo(null), null);
  assert.equal(selectMaxChapterNo(tree), 15);
});

test('recap view crops null and collapsed content, then renders structured sections', () => {
  const empty = renderToStaticMarkup(createElement(GenerateRecapPanelView, {
    status: null,
    maxChapterNo: null,
    collapsed: false,
  }));
  assert.equal(empty, '');

  const collapsed = renderToStaticMarkup(createElement(GenerateRecapPanelView, {
    status,
    maxChapterNo: 13,
    collapsed: true,
  }));
  assert.match(collapsed, /前情/);
  assert.match(collapsed, /aria-expanded="false"/);
  assert.match(collapsed, /aria-controls="generate-recap-panel-body"/);
  // The toggle must keep its content-derived accessible name: an aria-label
  // would strip the meta line (stale hint included) from screen-reader output.
  assert.doesNotMatch(collapsed, /generate-recap-toggle[^>]*aria-label=/);
  assert.doesNotMatch(collapsed, /示例停点描述/);

  const expanded = renderToStaticMarkup(createElement(GenerateRecapPanelView, {
    status,
    maxChapterNo: 13,
    collapsed: false,
  }));
  assert.match(expanded, /aria-expanded="true"/);
  assert.doesNotMatch(expanded, /generate-recap-toggle[^>]*aria-label=/);
  assert.match(expanded, /aria-label="生成前情摘要"/);
  assert.equal((expanded.match(/aria-label="前情"/g) ?? []).length, 0);
  assert.doesNotMatch(expanded, /<h3/);
  assert.match(expanded, /role="heading" aria-level="3"/);
  assert.match(expanded, /最后刷新 2026-07-25/);
  assert.match(expanded, /停点第12章/);
  assert.match(expanded, /正文已至第13章，前情快照可能未刷新/);
  assert.match(expanded, /示例停点描述。\n示例停点后续说明。/);
  assert.ok(expanded.indexOf('主线') < expanded.indexOf('暗线'));
  assert.match(expanded, /角色A/);
  assert.match(expanded, /F07/);
  assert.match(expanded, /示例写作红线内容/);
  assert.doesNotMatch(expanded, /不应出现在前情面板中的表达基线/);

  // The panel's structural contract: secondary sections live inside the
  // details disclosure while primary sections stay outside it.
  const moreStart = expanded.indexOf('<details class="generate-recap-more"');
  const moreEnd = expanded.indexOf('</details>');
  assert.ok(moreStart !== -1 && moreEnd > moreStart);
  assert.ok(expanded.indexOf('示例停点描述') < moreStart);
  for (const secondary of ['角色A', 'F07', '示例写作红线内容']) {
    const index = expanded.indexOf(secondary);
    assert.ok(index > moreStart && index < moreEnd, `${secondary} must sit inside 更多`);
  }
});

test('recap formats both stop and stale chapter labels while keeping Chinese shells', () => {
  const chapterLeaf = {
    filePattern: 'chapter-{num}.md',
    numberStyle: 'arabic' as const,
    titleTemplate: 'Chapter {num} {title}',
    numberingScope: 'book' as const,
    titleStripRegex: null,
  };
  const html = renderToStaticMarkup(createElement(GenerateRecapPanelView, {
    status,
    maxChapterNo: 13,
    collapsed: true,
    chapterLeaf,
  }));

  assert.match(html, /停点Chapter 12/);
  assert.match(html, /正文已至Chapter 13，前情快照可能未刷新/);
});

test('recap header exposes sibling toggle and fullscreen buttons without nesting', () => {
  for (const collapsed of [true, false]) {
    const html = renderToStaticMarkup(createElement(GenerateRecapPanelView, {
      status,
      maxChapterNo: 12,
      collapsed,
    }));

    assert.match(html, /class="generate-recap-header"/);
    assert.match(html, new RegExp(`aria-expanded="${String(!collapsed)}"`));
    assert.match(html, /aria-label="全屏查看前情"/);
    assert.equal((html.match(/<button/g) ?? []).length, 2);
    const firstButtonStart = html.indexOf('<button');
    const firstButtonEnd = html.indexOf('</button>', firstButtonStart);
    assert.equal(html.slice(firstButtonStart + 1, firstButtonEnd).includes('<button'), false);
  }
});

test('fullscreen recap lays out all sections without the panel more disclosure', () => {
  const html = renderToStaticMarkup(createElement(GenerateRecapFullView, {
    status,
    maxChapterNo: 13,
  }));

  for (const heading of ['刚刚发生', '故事线', '角色一句话', '活跃伏笔', '动笔前核对']) {
    assert.match(html, new RegExp(heading));
  }
  assert.match(html, /最后刷新 2026-07-25/);
  assert.match(html, /正文已至第13章，前情快照可能未刷新/);
  assert.doesNotMatch(html, /<details|<summary|更多/);
  assert.doesNotMatch(html, /不应出现在前情面板中的表达基线/);
});

test('fullscreen recap omits the meta block wrapper when no meta exists', () => {
  const html = renderToStaticMarkup(createElement(GenerateRecapFullView, {
    status: { ...status, lastRefreshed: null, stopChapter: null },
    maxChapterNo: 5,
  }));
  assert.match(html, /刚刚发生/);
  assert.doesNotMatch(html, /generate-recap-full-meta/);
});

test('recap content selector trims values and reports section availability', () => {
  const content = selectGenerateRecapContent({
    ...status,
    stopPoint: '  停点正文  ',
    storylines: [{ name: ' 主线 ', body: ' 进展 ' }, { name: '  ', body: '  ' }],
    characterOneLiners: [],
    activeForeshadow: [],
    redLines: ['  ', ' 红线一 '],
  });

  assert.equal(content.stopPoint, '停点正文');
  assert.deepEqual(content.storylines, [{ name: '主线', body: '进展' }]);
  assert.deepEqual(content.redLines, ['红线一']);
  assert.equal(content.hasPrimary, true);
  assert.equal(content.hasMore, true);
  assert.equal(content.hasSections, true);

  const empty = selectGenerateRecapContent({
    ...status,
    stopPoint: ' ',
    storylines: [],
    characterOneLiners: [],
    activeForeshadow: [],
    redLines: [],
  });
  assert.equal(empty.hasPrimary, false);
  assert.equal(empty.hasMore, false);
  assert.equal(empty.hasSections, false);
});

test('fullscreen recap hides empty sections and renders nothing for an empty DTO', () => {
  const partial = renderToStaticMarkup(createElement(GenerateRecapFullView, {
    status: {
      ...status,
      stopPoint: ' ',
      storylines: [],
      activeForeshadow: [],
      redLines: [],
    },
    maxChapterNo: 12,
  }));
  assert.match(partial, /角色一句话/);
  assert.doesNotMatch(partial, /刚刚发生|故事线|活跃伏笔|动笔前核对|更多/);

  const empty = renderToStaticMarkup(createElement(GenerateRecapFullView, {
    status: {
      sectionHeadings,
      lastRefreshed: null,
      stopChapter: null,
      stopPoint: ' ',
      storylines: [],
      activeForeshadow: [],
      characterOneLiners: [],
      redLines: [],
      expressionBaseline: '',
    },
    maxChapterNo: 5,
  }));
  assert.equal(empty, '');
});

test('recap view hides every empty optional section and stale hint at equal chapter', () => {
  const html = renderToStaticMarkup(createElement(GenerateRecapPanelView, {
    status: {
      ...status,
      stopPoint: ' ',
      storylines: [],
      activeForeshadow: [],
      characterOneLiners: [],
      redLines: [],
    },
    maxChapterNo: 12,
    collapsed: false,
  }));

  assert.doesNotMatch(html, /刚刚发生/);
  assert.doesNotMatch(html, /故事线/);
  assert.doesNotMatch(html, /更多/);
  assert.doesNotMatch(html, /可能未刷新/);
});

test('recap persistence has independent phase defaults and honors saved values', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
  };

  assert.equal(readGenerateRecapCollapsed('setup', storage), false);
  assert.equal(readGenerateRecapCollapsed('session', storage), true);
  values.set('ws-generate-recap-setup-collapsed', '1');
  values.set('ws-generate-recap-session-collapsed', '0');
  assert.equal(readGenerateRecapCollapsed('setup', storage), true);
  assert.equal(readGenerateRecapCollapsed('session', storage), false);
});

test('recap persistence writes round-trip through the same encoding the reader accepts', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
  };

  persistGenerateRecapCollapsed('setup', true, storage);
  persistGenerateRecapCollapsed('session', false, storage);
  assert.equal(readGenerateRecapCollapsed('setup', storage), true);
  assert.equal(readGenerateRecapCollapsed('session', storage), false);

  persistGenerateRecapCollapsed('setup', false, storage);
  assert.equal(readGenerateRecapCollapsed('setup', storage), false);
});

test('more disclosure state persists independently and survives outer collapse', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
  };

  persistGenerateRecapMoreOpen('setup', true, storage);
  assert.equal(readGenerateRecapMoreOpen('setup', storage), true);
  assert.equal(readGenerateRecapMoreOpen('session', storage), false);

  const collapsed = renderToStaticMarkup(createElement(GenerateRecapPanelView, {
    status,
    maxChapterNo: 13,
    collapsed: true,
    moreOpen: readGenerateRecapMoreOpen('setup', storage),
  }));
  assert.doesNotMatch(collapsed, /<details/);

  const reopened = renderToStaticMarkup(createElement(GenerateRecapPanelView, {
    status,
    maxChapterNo: 13,
    collapsed: false,
    moreOpen: readGenerateRecapMoreOpen('setup', storage),
  }));
  assert.match(reopened, /<details class="generate-recap-more" open=""/);
});

test('setup layout is top-anchored so delayed recap content cannot shift the form', async () => {
  const css = await readFile(new URL('../src/styles/layout.css', import.meta.url), 'utf8');
  const setup = css.match(/\.generate-setup-layout\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(setup, /justify-content:\s*flex-start/);
  assert.doesNotMatch(setup, /justify-content:\s*(?:safe\s+)?center/);
});

test('recap adjacency uses one shared border at header and beat progress seams', async () => {
  const css = await readFile(new URL('../src/styles/layout.css', import.meta.url), 'utf8');
  const recap = css.match(/\.generate-recap\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  const progress = css.match(/\.generate-beat-progress\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.doesNotMatch(recap, /border-top/);
  assert.match(recap, /border-bottom:\s*1px/);
  assert.doesNotMatch(progress, /border-top/);
  assert.match(progress, /border-bottom:\s*1px/);
});

test('recap persistence survives throwing storage and falls back to phase defaults', () => {
  const throwing = {
    getItem: (): string | null => {
      throw new Error('denied');
    },
    setItem: (): void => {
      throw new Error('denied');
    },
  };

  assert.equal(readGenerateRecapCollapsed('setup', throwing), false);
  assert.equal(readGenerateRecapCollapsed('session', throwing), true);
  assert.doesNotThrow(() => persistGenerateRecapCollapsed('setup', true, throwing));
});

test('recap view renders nothing when the DTO exists but every field is empty', () => {
  const html = renderToStaticMarkup(createElement(GenerateRecapPanelView, {
    status: {
      sectionHeadings,
      lastRefreshed: null,
      stopChapter: null,
      stopPoint: ' ',
      storylines: [],
      activeForeshadow: [],
      characterOneLiners: [],
      redLines: [],
      expressionBaseline: '',
    },
    maxChapterNo: 5,
    collapsed: false,
  }));

  assert.equal(html, '');
});
