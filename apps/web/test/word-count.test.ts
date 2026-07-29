import assert from 'node:assert/strict';
import test from 'node:test';
import { countWords } from '../src/lib/wordCount.js';

test('countWords preserves the documented mixed CJK and Latin examples', () => {
  assert.equal(countWords('你好world'), 3);
  assert.equal(countWords('第75章 The End'), 5);
  assert.equal(countWords('  空 格  a b  '), 4);
});
