import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatPersonaLabel,
  initialMemoryCutoffState,
  isMemoryCutoffValid,
  memoryCutoffReducer,
  resolveMemoryCutoffChapter,
} from '../src/lib/memory-cutoff.js';

test('memory cutoff state defaults to the latest chapter and resolves all modes', () => {
  const latest = initialMemoryCutoffState(75);
  assert.deepEqual(latest, { mode: 'latest', customChapter: '75' });
  assert.equal(resolveMemoryCutoffChapter(latest, 75), 75);
  assert.equal(isMemoryCutoffValid(latest, 75), true);

  const custom = memoryCutoffReducer(latest, { type: 'custom', value: '70' });
  assert.deepEqual(custom, { mode: 'custom', customChapter: '70' });
  assert.equal(resolveMemoryCutoffChapter(custom, 75), 70);
  assert.equal(isMemoryCutoffValid(custom, 75), true);

  const none = memoryCutoffReducer(custom, { type: 'select', mode: 'none' });
  assert.equal(resolveMemoryCutoffChapter(none, 75), undefined);
  assert.equal(isMemoryCutoffValid(none, 75), true);
});

test('memory cutoff rejects non-positive and non-integer custom input', () => {
  for (const value of ['', '0', '-1', '1.5', 'abc']) {
    const state = { mode: 'custom' as const, customChapter: value };
    assert.equal(isMemoryCutoffValid(state, 75), false, value);
    assert.equal(resolveMemoryCutoffChapter(state, 75), undefined, value);
  }
  assert.deepEqual(initialMemoryCutoffState(null), { mode: 'none', customChapter: '' });
});

test('persona labels distinguish chapter-bounded threads', () => {
  assert.equal(formatPersonaLabel({ characterName: '角色A' }), '角色A');
  assert.equal(
    formatPersonaLabel({ characterName: '角色A', memoryCutoffChapter: 70 }),
    '角色A @≤70章',
  );
});
