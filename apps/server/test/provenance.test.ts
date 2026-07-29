import assert from 'node:assert/strict';
import test from 'node:test';
import type { RevisionWithContent } from '@writing-studio/contract';
import { buildProvenance, countManuscriptWords } from '../src/provenance.js';

function revision(
  id: string,
  kind: RevisionWithContent['kind'],
  content: string,
  createdAt: number,
): RevisionWithContent {
  return {
    id,
    projectId: 'novel',
    docId: '正文/第1章.md',
    kind,
    sha256: id.padEnd(64, 'a').slice(0, 64),
    sourceThreadId: null,
    label: null,
    createdAt,
    content,
  };
}

test('mixed Chinese and Latin manuscript word count matches the editor rule', () => {
  assert.equal(countManuscriptWords('第3章 The End'), 5);
  assert.equal(countManuscriptWords('雨停了。'), 3);
});

test('provenance summarizes a multi-revision chain and counts author edits only', () => {
  const revisions = [
    revision('r3', 'manual_snapshot', '雨停了。\n她走了出去。', 4_000),
    revision('r1', 'ai_original', '雨停了。\n她出门。', 1_000),
    revision('r2', 'user_edit', '雨停了。\n她走了出去。', 2_500),
  ];
  const result = buildProvenance('正文/第1章.md', '示例标题', revisions);

  assert.equal(result.summary.aiDraftWordCount, countManuscriptWords('雨停了。\n她出门。'));
  assert.equal(result.summary.revisionCount, 3);
  assert.equal(result.summary.timeSpanMs, 3_000);
  assert.deepEqual(result.revisions.map((item) => item.revisionId), ['r1', 'r2', 'r3']);
  assert.deepEqual(result.revisions[0] && {
    added: result.revisions[0].addedChars,
    deleted: result.revisions[0].deletedChars,
  }, { added: 0, deleted: 0 });
  assert.equal(result.revisions[1]!.addedChars > 0, true);
  assert.equal(
    result.summary.authorChangedChars,
    result.revisions[1]!.addedChars
      + result.revisions[1]!.deletedChars
      + result.revisions[2]!.addedChars
      + result.revisions[2]!.deletedChars,
  );
});

test('provenance preserves input order for revisions created in the same millisecond', () => {
  const createdAt = 2_000;
  const revisions = [
    revision('zz-first', 'ai_original', '初稿。', createdAt),
    revision('aa-second', 'user_edit', '修改稿。', createdAt),
  ];

  const result = buildProvenance('正文/第1章.md', '同毫秒修订', revisions);

  assert.deepEqual(
    result.revisions.map((item) => item.revisionId),
    ['zz-first', 'aa-second'],
  );
});

test('empty provenance is a valid zero summary', () => {
  assert.deepEqual(buildProvenance('正文/第1章.md', '空章', []).summary, {
    aiDraftWordCount: 0,
    authorChangedChars: 0,
    revisionCount: 0,
    timeSpanMs: 0,
  });
});
