import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocumentMeta, MentionLocation } from '@writing-studio/contract';
import { ContextManifestPanel } from '../src/components/ContextManifestPanel.js';
import { DraftSection } from '../src/components/DraftSection.js';
import { Empty, ErrorState, LoadingSkeleton } from '../src/components/Empty.js';
import { buildTrashDeleteMessage, TrashList } from '../src/components/TrashModal.js';
import {
  MentionResults,
  mentionUiReducer,
  normalizeMentions,
  type MentionUiState,
} from '../src/components/sidebar/CharacterMentions.js';

const noop = (): void => undefined;

test('context manifest renders only server-supplied entries and all diagnostic fields', () => {
  assert.equal(renderToStaticMarkup(createElement(ContextManifestPanel, { manifest: null })), '');
  assert.equal(renderToStaticMarkup(createElement(ContextManifestPanel, { manifest: [] })), '');

  const html = renderToStaticMarkup(createElement(ContextManifestPanel, {
    manifest: [{
      sourceId: 'characters:角色A',
      originalChars: 1_200,
      injectedChars: 800,
      truncated: true,
      quotaChars: 800,
      trigger: 'mention',
    }],
  }));
  assert.match(html, /本轮注入（1）/);
  assert.match(html, /characters:角色A/);
  assert.match(html, /800/);
  assert.match(html, /1,200/);
  assert.match(html, /已截断/);
  assert.match(html, />mention</);
  assert.match(html, /quota 800/);
});

test('the three async-state primitives carry the ARIA each one is supposed to', () => {
  // Loading and error interrupt, so they announce; empty is ordinary content
  // and must not. A role creeping onto Empty would make every empty list in
  // the app talk over whatever the reader is doing.
  const loading = renderToStaticMarkup(createElement(LoadingSkeleton, { label: '正在加载草稿' }));
  assert.match(loading, /role="status"/);
  assert.match(loading, /aria-label="正在加载草稿"/);

  const empty = renderToStaticMarkup(createElement(Empty, { text: '暂无草稿' }));
  assert.match(empty, /暂无草稿/);
  assert.doesNotMatch(empty, /role=/);

  const quiet = renderToStaticMarkup(createElement(ErrorState, { message: '读取失败' }));
  assert.match(quiet, /role="alert"/);
  assert.match(quiet, /读取失败/);
  // No retry action passed means no button — the primitive must not imply an
  // affordance the caller cannot honor.
  assert.doesNotMatch(quiet, /<button/);

  const retryable = renderToStaticMarkup(createElement(ErrorState, {
    message: '读取失败',
    onRetry: noop,
  }));
  assert.match(retryable, /<button type="button" class="btn-ghost">重试<\/button>/);
});

test('draft section exposes the required empty state and draft title list', () => {
  const empty = renderToStaticMarkup(createElement(DraftSection, {
    drafts: [],
    loading: false,
    error: null,
    activeDocId: undefined,
    onOpen: noop,
    onOpenTrash: noop,
    onContextMenu: noop,
  }));
  assert.match(empty, /暂无草稿/);

  const draft: DocumentMeta = {
    docId: '草稿/2026-07-23_逐段采纳复审.md',
    projectId: 'sample',
    kind: 'draft',
    title: '逐段采纳复审',
    chapterNo: null,
    sha256: 'a'.repeat(64),
    bytes: 20,
    mtimeMs: 1,
  };
  const listed = renderToStaticMarkup(createElement(DraftSection, {
    drafts: [draft],
    loading: false,
    error: null,
    activeDocId: draft.docId,
    onOpen: noop,
    onOpenTrash: noop,
    onContextMenu: noop,
  }));
  assert.match(listed, /逐段采纳复审/);
  assert.match(listed, /aria-current="true"/);
  assert.match(listed, /回收站/);
});

test('the sidebar async branches announce themselves through the shared primitives', () => {
  // Both of these branches shipped for months with no coverage at all, which is
  // how they drifted onto three different idioms in the first place.
  const draftProps = {
    drafts: [], activeDocId: undefined, onOpen: noop, onOpenTrash: noop, onContextMenu: noop,
  };
  const trashProps = { entries: [], draftsDir: '草稿', restoringDocId: null, onRestore: noop };

  const branches: Array<{ loading: string; failed: string }> = [
    {
      loading: renderToStaticMarkup(createElement(DraftSection, { ...draftProps, loading: true, error: null })),
      failed: renderToStaticMarkup(createElement(DraftSection, { ...draftProps, loading: false, error: '磁盘不可读' })),
    },
    {
      loading: renderToStaticMarkup(createElement(TrashList, { ...trashProps, loading: true, error: null })),
      failed: renderToStaticMarkup(createElement(TrashList, { ...trashProps, loading: false, error: '磁盘不可读' })),
    },
  ];
  for (const { loading, failed } of branches) {
    assert.match(loading, /role="status"/);
    assert.match(loading, /class="skeleton"/);
    assert.match(failed, /role="alert"/);
    assert.match(failed, /磁盘不可读/);
    // Neither call site has a retry action to offer, so neither may show one.
    assert.doesNotMatch(failed, /重试/);
  }
});

test('trash list exposes its empty state, manual cleanup note, and restore loading state', () => {
  const empty = renderToStaticMarkup(createElement(TrashList, {
    entries: [],
    loading: false,
    error: null,
    draftsDir: '草稿',
    restoringDocId: null,
    onRestore: noop,
  }));
  assert.match(empty, /回收站是空的/);
  assert.match(empty, /草稿\/\.trash\//);
  assert.match(empty, /文件管理器中手动删除/);

  const trashedDocId = '草稿/.trash/2026-07-25T01:02:03.004Z_2026-07-25_我的_草稿.md';
  const listed = renderToStaticMarkup(createElement(TrashList, {
    entries: [
      {
        trashedDocId,
        originalName: '2026-07-25_我的_草稿.md',
        deletedAt: '2026-07-25T01:02:03.004Z',
        title: '我的_草稿',
      },
      {
        trashedDocId: '草稿/.trash/2026-07-25T01:02:04.004Z_第二.md',
        originalName: '第二.md',
        deletedAt: '2026-07-25T01:02:04.004Z',
        title: '第二',
      },
    ],
    loading: false,
    error: null,
    draftsDir: '自定义/片段',
    restoringDocId: trashedDocId,
    onRestore: noop,
  }));
  assert.match(listed, /2026-07-25_我的_草稿\.md/);
  assert.match(listed, /自定义\/片段\/\.trash\//);
  assert.match(listed, /正在恢复…/);
  assert.equal((listed.match(/disabled=""/g) ?? []).length, 2);
  assert.equal(
    buildTrashDeleteMessage('待删草稿', '自定义/片段'),
    '“待删草稿”将移至磁盘上的 自定义/片段/.trash/ 文件夹。',
  );
});

test('mentions reducer covers loading, empty, failure, and successful locations', () => {
  const idle: MentionUiState = { status: 'idle' };
  assert.deepEqual(mentionUiReducer(idle, { type: 'load' }), { status: 'loading' });
  assert.deepEqual(
    mentionUiReducer(idle, { type: 'success', locations: [] }),
    { status: 'success', locations: [] },
  );
  assert.deepEqual(
    mentionUiReducer(idle, { type: 'error', message: 'network down' }),
    { status: 'error', message: 'network down' },
  );

  const loading = renderToStaticMarkup(createElement(MentionResults, {
    state: { status: 'loading' },
    onOpen: noop,
    onRetry: noop,
  }));
  const empty = renderToStaticMarkup(createElement(MentionResults, {
    state: { status: 'success', locations: [] },
    onOpen: noop,
    onRetry: noop,
  }));
  const failed = renderToStaticMarkup(createElement(MentionResults, {
    state: { status: 'error', message: 'network down' },
    onOpen: noop,
    onRetry: noop,
  }));
  assert.match(loading, /正在查找出现章节/);
  assert.match(empty, /暂无出现章节/);
  assert.match(failed, /加载失败：network down/);
  assert.match(failed, />重试</);
});

test('mentions keep server order while deduplicating docId and render chapter counts', () => {
  const locations: MentionLocation[] = [
    { docId: '正文/第51章.md', chapterNo: 51, count: 2, firstOffset: 4 },
    { docId: '正文/第51章.md', chapterNo: 51, count: 9, firstOffset: 8 },
    { docId: '正文/第52章.md', chapterNo: 52, count: 1, firstOffset: 6 },
  ];
  const normalized = normalizeMentions(locations);
  assert.deepEqual(normalized.map((location) => location.docId), [
    '正文/第51章.md',
    '正文/第52章.md',
  ]);

  const html = renderToStaticMarkup(createElement(MentionResults, {
    state: { status: 'success', locations: normalized },
    onOpen: noop,
    onRetry: noop,
  }));
  assert.ok(html.indexOf('第51章') < html.indexOf('第52章'));
  assert.match(html, /第51章 ×2/);
  assert.match(html, /第52章 ×1/);

  const enHtml = renderToStaticMarkup(createElement(MentionResults, {
    state: { status: 'success', locations: normalized },
    onOpen: noop,
    onRetry: noop,
    chapterLeaf: {
      filePattern: 'chapter-{num}.md',
      numberStyle: 'arabic',
      titleTemplate: 'Chapter {num} {title}',
      numberingScope: 'book',
      titleStripRegex: null,
    },
  }));
  assert.match(enHtml, /Chapter 51 ×2/);
  assert.match(enHtml, /Chapter 52 ×1/);
});
