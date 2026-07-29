import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  CanonSectionRef,
  ContentTreeLeaf,
  DocumentMeta,
  WritingStatusDto,
} from '@writing-studio/contract';
import { EditorChapterBadge, TreeChapterLabel } from '../src/components/ChapterLabels.js';
import { formatChapterLabel } from '../src/lib/chapter-label.js';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (): string | null => null,
    setItem: (): void => undefined,
  },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { innerWidth: 1024 },
});

const { WritingStatusView } = await import('../src/components/sidebar/WritingStatusView.js');

const leaf = (
  numberStyle: ContentTreeLeaf['numberStyle'],
  titleTemplate?: string,
): ContentTreeLeaf => ({
  filePattern: 'chapter-{num}.md',
  numberStyle,
  ...(titleTemplate === undefined ? {} : { titleTemplate }),
  numberingScope: 'book',
  titleStripRegex: null,
});

const chapter: DocumentMeta = {
  docId: 'manuscript/chapter-12.md',
  projectId: 'project-a',
  kind: 'chapter',
  title: '章节标题A',
  chapterNo: 12,
  sha256: 'a'.repeat(64),
  bytes: 1,
  mtimeMs: 1,
};

test('formatChapterLabel covers default zh, arabic, en, null, and render failure fallbacks', () => {
  assert.equal(
    formatChapterLabel(leaf('arabic', '第{numCn}章 {title}'), 12),
    '第十二章',
  );
  assert.equal(
    formatChapterLabel(leaf('arabic', '第{numCn}章 {title}'), 12, '章节标题A'),
    '第十二章 章节标题A',
  );
  assert.equal(formatChapterLabel(leaf('arabic', '第{num}章 {title}'), 12), '第12章');
  assert.equal(
    formatChapterLabel(leaf('arabic', 'Chapter {num} {title}'), 12, 'Placeholder'),
    'Chapter 12 Placeholder',
  );
  assert.equal(formatChapterLabel(leaf('arabic'), null, '纯标题'), '纯标题');
  assert.equal(formatChapterLabel(leaf('arabic'), null), '');
  assert.equal(formatChapterLabel(leaf('arabic'), 12, '模板缺失'), '第12章 模板缺失');
  // A missing leaf (project data not loaded) must never drop the chapter
  // number: it falls back to the legacy template like a template-less leaf.
  assert.equal(
    formatChapterLabel(undefined, 12, '配置未加载时的标题'),
    '第12章 配置未加载时的标题',
  );
  assert.equal(formatChapterLabel(undefined, 12), '第12章');
  assert.equal(formatChapterLabel(null, 12), '第12章');
  assert.equal(
    formatChapterLabel(
      leaf('cnLower', '第{num}章 {title}'),
      12,
      "含 $& $' $` $1$2 $$ 的标题",
    ),
    "第十二章 含 $& $' $` $1$2 $$ 的标题",
  );
});

test('tree node and editor badge follow the same project chapter template', () => {
  const zhLeaf = leaf('arabic', '第{num}章 {title}');
  assert.equal(
    renderToStaticMarkup(createElement(TreeChapterLabel, {
      chapter,
      chapterLeaf: zhLeaf,
    })),
    '<span>第12章 章节标题A</span>',
  );
  assert.equal(
    renderToStaticMarkup(createElement(EditorChapterBadge, {
      chapterNo: 12,
      chapterLeaf: zhLeaf,
    })),
    '<span class="chapter-badge">第12章</span>',
  );

  const enLeaf = leaf('arabic', 'Chapter {num} {title}');
  assert.match(
    renderToStaticMarkup(createElement(TreeChapterLabel, {
      chapter: { ...chapter, title: 'Placeholder' },
      chapterLeaf: enLeaf,
    })),
    /Chapter 12 Placeholder/,
  );
  assert.match(
    renderToStaticMarkup(createElement(EditorChapterBadge, {
      chapterNo: 12,
      chapterLeaf: enLeaf,
    })),
    /Chapter 12/,
  );
});

test('writing-status stop point preserves its shell and formats only the chapter label', () => {
  const data: WritingStatusDto = {
    sectionHeadings: {
      stopPoint: '停点', storylines: '故事线', activeForeshadow: '活跃伏笔速览',
      characterOneLiners: '角色一句话状态', redLines: '写作红线', expressionBaseline: '表达基线',
    },
    lastRefreshed: null,
    stopChapter: 12,
    stopPoint: '',
    storylines: [],
    activeForeshadow: [],
    characterOneLiners: [],
    redLines: [],
    expressionBaseline: '',
  };
  const render = (chapterLeaf: ContentTreeLeaf): string => renderToStaticMarkup(
    createElement(WritingStatusView, {
      data,
      sections: [],
      onRepair: () => undefined,
      sourceFile: 'writing-status.md',
      chapterLeaf,
    }),
  );

  assert.match(render(leaf('arabic', '第{num}章 {title}')), /停点：第12章/);
  assert.match(render(leaf('arabic', 'Chapter {num} {title}')), /停点：Chapter 12/);
  assert.match(render(leaf('arabic')), /停点：第 12 章/);
});

test('writing-status repair controls follow resolved non-Chinese section headings', () => {
  const sectionHeadings: WritingStatusDto['sectionHeadings'] = {
    stopPoint: 'Checkpoint',
    storylines: 'Threads',
    activeForeshadow: 'Open clues',
    characterOneLiners: 'Cast status',
    redLines: 'Guardrails',
    expressionBaseline: 'Style baseline',
  };
  const data: WritingStatusDto = {
    sectionHeadings,
    lastRefreshed: null,
    stopChapter: null,
    stopPoint: 'Checkpoint body',
    storylines: [{ name: 'Main', body: 'Progress' }],
    activeForeshadow: [{ id: 'C1', content: 'Clue', status: 'Open' }],
    characterOneLiners: [{ name: 'Character A', text: 'Waiting' }],
    redLines: ['No spoilers'],
    expressionBaseline: 'Be precise',
  };
  const anchor = (exact: string): CanonSectionRef['anchor'] => ({
    docSha: 'b'.repeat(64), start: 0, end: exact.length, prefix: '', exact, suffix: '',
  });
  const sections: CanonSectionRef[] = Object.values(sectionHeadings).map((heading) => ({
    headingPath: [heading],
    anchor: anchor(heading),
  }));

  const markup = renderToStaticMarkup(createElement(WritingStatusView, {
    data,
    sections,
    onRepair: () => undefined,
    sourceFile: 'writing-status.md',
    chapterLeaf: leaf('arabic'),
  }));

  assert.equal(markup.match(/>修订此节<\/button>/g)?.length, 6);
});
