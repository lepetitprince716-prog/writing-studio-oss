import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnchor, refreshAnchorFingerprint, resolveAnchor } from '../src/anchors.js';

const SHA = 'a'.repeat(64);

test('anchors use exact JavaScript UTF-16 offsets and refresh their fingerprint', () => {
  const content = '前😀中 target 后';
  const start = content.indexOf('target');
  const anchor = createAnchor(SHA, content, start, start + 'target'.length);
  assert.equal(start, 5); // 前(1) + 😀(2) + 中 and space (2)
  assert.deepEqual(resolveAnchor(anchor, content), { status: 'exact', start, end: start + 6 });
  const refreshed = refreshAnchorFingerprint(anchor, 'b'.repeat(64), content);
  assert.equal(refreshed.docSha, 'b'.repeat(64));
  assert.equal(refreshed.exact, 'target');
});

test('exact matching handles duplicate quotes by contextual fingerprint and previous offset', () => {
  const original = 'one before TOKEN after\ntwo before TOKEN after';
  const start = original.lastIndexOf('TOKEN');
  const anchor = createAnchor(SHA, original, start, start + 5);
  const moved = 'prefix\none before TOKEN after\ntwo before TOKEN after';
  const resolution = resolveAnchor(anchor, moved);
  assert.deepEqual(resolution, { status: 'exact', start: moved.lastIndexOf('TOKEN'), end: moved.lastIndexOf('TOKEN') + 5 });
});

test('duplicate exact matching prefers the nearest previous start over better distant context', () => {
  const original = 'distant-prefix TOKEN distant-suffix\nnear TOKEN x';
  const start = original.lastIndexOf('TOKEN');
  const anchor = createAnchor(SHA, original, start, start + 5);
  // The first copy preserves both original context sides, while the second
  // copy moves only one UTF-16 unit from the prior start and must still win.
  const edited = 'distant-prefix TOKEN distant-suffix\nnear! TOKEN y';
  const resolution = resolveAnchor(anchor, edited);
  const expected = edited.lastIndexOf('TOKEN');
  assert.deepEqual(resolution, { status: 'exact', start: expected, end: expected + 5 });
});

test('fuzzy matching survives a bounded internal edit and reports a normalized score', () => {
  const original = '开头：The quick brown fox jumps over the quiet river。结尾';
  const start = original.indexOf('The quick');
  const anchor = createAnchor(SHA, original, start, original.indexOf('。结尾'));
  const edited = '新增\n开头：The quick amber fox jumps over the quiet river。结尾';
  const resolution = resolveAnchor(anchor, edited);
  assert.equal(resolution.status, 'fuzzy');
  if (resolution.status === 'fuzzy') {
    assert.ok(resolution.score >= 0.72 && resolution.score <= 1);
    assert.match(edited.slice(resolution.start, resolution.end), /quick amber fox/);
  }
});

test('long anchors survive an internal replacement while unrelated text is lost', () => {
  const selected = `${'甲乙丙丁'.repeat(90)}中段旧词${'戊己庚辛'.repeat(90)}`;
  const original = `BEGIN\n${selected}\nEND`;
  const start = original.indexOf(selected);
  const anchor = createAnchor(SHA, original, start, start + selected.length);
  const edited = original.replace('中段旧词', '中段新词并补充');
  const fuzzy = resolveAnchor(anchor, edited);
  assert.equal(fuzzy.status, 'fuzzy');
  const lost = resolveAnchor(anchor, '完全无关的内容');
  assert.deepEqual(lost, { status: 'lost' });
});
