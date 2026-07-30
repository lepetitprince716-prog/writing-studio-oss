import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConflictFinding } from '@writing-studio/contract';
import { ConflictFindingsPanel } from '../src/components/ConflictFindingsPanel.js';
import {
  conflictCheckButtonState,
  groupConflictFindings,
} from '../src/lib/conflict-check.js';

const findings: ConflictFinding[] = [
  {
    claimInText: '时间线冲突',
    textQuote: '示例文本引用一',
    canonSource: { docId: '写作状态.md', heading: '停点' },
    conflictType: 'timeline',
    severity: 'high',
    explanation: '正典停点仍是第二天夜间。',
  },
  {
    claimInText: '角色状态冲突',
    textQuote: '示例文本引用二',
    canonSource: { docId: '角色.md', heading: '角色A / 当前状态' },
    conflictType: 'character',
    severity: 'medium',
    explanation: '角色卡记载左臂受伤。',
  },
];

test('conflict-check button state covers idle, starting, and active-run states', () => {
  assert.deepEqual(
    conflictCheckButtonState({ hasDocument: true, starting: false, running: false }),
    { disabled: false, label: '查冲突' },
  );
  assert.deepEqual(
    conflictCheckButtonState({ hasDocument: true, starting: true, running: false }),
    { disabled: true, label: '启动中…' },
  );
  assert.deepEqual(
    conflictCheckButtonState({ hasDocument: true, starting: false, running: true }),
    { disabled: true, label: '检查中…' },
  );
  assert.equal(
    conflictCheckButtonState({ hasDocument: false, starting: false, running: false }).disabled,
    true,
  );
});

test('findings group by severity order and render quotes, canon sources, and honesty label', () => {
  assert.deepEqual(
    groupConflictFindings(findings).map(([severity]) => severity),
    ['high', 'medium'],
  );
  const html = renderToStaticMarkup(createElement(ConflictFindingsPanel, {
    response: { findings },
    onLocateText: () => undefined,
    onOpenCanon: () => undefined,
    onRepairCanon: () => undefined,
  }));
  assert.match(html, /AI 初筛，可能漏检误报/);
  assert.match(html, /高风险/);
  assert.match(html, /示例文本引用一/);
  assert.match(html, /写作状态.md · 停点/);
  assert.match(html, /中风险/);
  assert.match(html, /角色状态冲突/);
  assert.match(html, /修补正典/);
});

test('findings panel distinguishes empty results from raw parse fallback', () => {
  const empty = renderToStaticMarkup(createElement(ConflictFindingsPanel, {
    response: { findings: [] },
    onLocateText: () => undefined,
    onOpenCanon: () => undefined,
    onRepairCanon: () => undefined,
  }));
  assert.match(empty, /未发现冲突（AI 初筛）/);
  // A clean result is not an interruption, so it must not announce itself.
  assert.doesNotMatch(empty, /role="alert"/);

  const fallback = renderToStaticMarkup(createElement(ConflictFindingsPanel, {
    response: null,
    rawText: 'unparsed output',
    onLocateText: () => undefined,
    onOpenCanon: () => undefined,
    onRepairCanon: () => undefined,
  }));
  assert.match(fallback, /解析失败，请人工阅读/);
  assert.match(fallback, /unparsed output/);
  assert.match(fallback, /role="alert"/);
});
