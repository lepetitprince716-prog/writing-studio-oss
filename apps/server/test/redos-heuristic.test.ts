import assert from 'node:assert/strict';
import test from 'node:test';
import { findNestedQuantifierRisk } from '../src/lint/redos-heuristic.js';
import { zhCnLintRulePack } from '../src/lint/packs/zh-CN.js';

const POSITIVE_PATTERNS = [
  '(a+)+b',
  '([^。]+)+x',
  '(\\w*)*$',
  '(a|a)+b',
  '(?:ab+)+c',
  '(a{1,3}){2,}',
  '((a+))+',
  '(a?)+b',
  '(\\d{2,4})+',
  '(?:(a+))+',
  '(a(b+)c)+',
  // Skipping group openers must not skip the quantifier that follows one: a
  // tempered token carrying its own `+` is still the shape we are after.
  '(?:(?!x).+)+',
  // The opener is skipped, never the body behind it. Widening the skip to the
  // whole group — or running a group name past its `>` — would drop every one
  // of these, and a heuristic that stops reporting is worse than a noisy one.
  '(?<a>b+)+',
  '(?<a>b|c)+',
  '(?<a>>+)+',
  '(?:(?<a>b)+c)+',
  '(?:(?<=a+)b)+',
  '(?:(?!a|b)c)+',
] as const;

for (const pattern of POSITIVE_PATTERNS) {
  test(`nested-quantifier heuristic flags ${pattern}`, () => {
    assert.notEqual(findNestedQuantifierRisk(pattern), null);
  });
}

test('nested-quantifier heuristic reports the repeated group position and reason', () => {
  assert.deepEqual(
    findNestedQuantifierRisk('xx(a|a)+b'),
    { index: 2, reason: '分组体内存在分支' },
  );
});

const NEGATIVE_PATTERNS = [
  '第[0-9]+章',
  '\\s+',
  '(abc)+',
  '(?:foo)*',
  '[a-z]+(x)',
  '\\(a+\\)+',
  '[(a+)+]',
  '(a)?',
  '\\p{L}+',
  '(\\p{L})+',
  // Group openers are not body content. Every `(?…)` form below is linear;
  // reading the `?` or `<` inside an opener as a quantifier is what produced
  // false positives on ordinary authored patterns.
  '(?<word>\\w)+',
  '(?<name>abc)+',
  '(a(?:b))+',
  '(a(b)c)+',
  '(?:(?!ab).)+',
  '(?:(?=a)b)+',
  '(?:x(?<=y))+',
  '(?:a(?:b)c)+',
  '(?:(?<name>x)y)+',
  '(?:(?<!z)w)+',
  '(?<a$_1>x)+',
  '(?<\\u0061>x)+',
  // `\k<n>` is a backreference, not a group opener.
  '(?<n>a)(?:\\k<n>x)+',
] as const;

for (const pattern of NEGATIVE_PATTERNS) {
  test(`nested-quantifier heuristic does not flag ${pattern}`, () => {
    assert.equal(findNestedQuantifierRisk(pattern), null);
  });
}

test('a truncated group opener is scanned without throwing', () => {
  for (const pattern of ['(?', '(?<', '(?<a', '(?<a>']) {
    assert.equal(findNestedQuantifierRisk(pattern), null, pattern);
  }
});

test('zh-CN built-in regex rules remain below the heuristic threshold', () => {
  const regexRules = zhCnLintRulePack.styleRules.filter((rule) => rule.kind === 'regex');
  assert.ok(regexRules.length > 0);
  for (const rule of regexRules) {
    assert.equal(
      findNestedQuantifierRisk(rule.pattern.source),
      null,
      `${rule.ruleId}: ${rule.pattern.source}`,
    );
  }
});
