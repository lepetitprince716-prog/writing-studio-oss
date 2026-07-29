import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProvenanceResponse } from '@writing-studio/contract';
import {
  buildProvenanceMarkdown,
  formatDuration,
} from '../src/lib/provenanceMarkdown.js';

test('provenance Markdown contains the summary and complete timeline without正文', () => {
  const provenance: ProvenanceResponse = {
    docId: '正文/第1章.md',
    title: '示例标题',
    summary: {
      aiDraftWordCount: 1200,
      authorChangedChars: 438,
      revisionCount: 2,
      timeSpanMs: 3_900_000,
    },
    revisions: [{
      revisionId: 'r1',
      kind: 'ai_original',
      createdAt: 1_000,
      wordCount: 1200,
      addedChars: 0,
      deletedChars: 0,
    }, {
      revisionId: 'r2',
      kind: 'user_edit',
      createdAt: 3_901_000,
      wordCount: 1260,
      addedChars: 249,
      deletedChars: 189,
    }],
  };
  const markdown = buildProvenanceMarkdown(provenance, (timestamp) => `T${timestamp}`);
  assert.match(markdown, /^# 示例标题｜编辑自证包/m);
  assert.match(markdown, /AI 初稿字数：1200/);
  assert.match(markdown, /作者累计改动字符数：438/);
  assert.match(markdown, /1 小时 5 分钟/);
  assert.match(markdown, /\| T1000 \| AI 初稿 \| 1200 \| \+0 \| -0 \|/);
  assert.match(markdown, /\| T3901000 \| 作者编辑 \| 1260 \| \+249 \| -189 \|/);
  assert.doesNotMatch(markdown, /雨停了|正文内容：/);
});

test('duration formatting has stable zero, minute, and hour forms', () => {
  assert.equal(formatDuration(0), '0 分钟');
  assert.equal(formatDuration(30_000), '1 分钟');
  assert.equal(formatDuration(7_200_000), '2 小时');
});
