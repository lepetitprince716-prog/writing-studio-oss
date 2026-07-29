import assert from 'node:assert/strict';
import test from 'node:test';
import { hasAcceptedRewrite } from '../src/lib/rewrite-review.js';

test('rejecting every rewrite chunk is equivalent to cancellation', () => {
  assert.equal(hasAcceptedRewrite('原文', '原文'), false);
});

test('keeping any candidate chunk enables the composed rewrite', () => {
  assert.equal(hasAcceptedRewrite('第一段\n第二段', '第一段\n修改后的第二段'), true);
});
