import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import type { LintFinding } from '@writing-studio/contract';
import {
  lintStateField,
  setLintFindings,
} from '../src/lib/lintDecorations.js';

const findings: LintFinding[] = [{
  ruleId: 'style.empty-preface',
  category: 'style',
  message: '直接陈述事实。',
  offset: 0,
  length: 7,
  severity: 'warning',
}, {
  ruleId: 'sensitive.word',
  category: 'sensitive',
  message: '人工复核。',
  offset: 8,
  length: 2,
  severity: 'error',
}];

test('manual lint effect installs findings and document edits clear stale decorations', () => {
  let state = EditorState.create({
    doc: '值得注意的是，禁词。',
    extensions: [lintStateField],
  });
  state = state.update({ effects: setLintFindings.of(findings) }).state;
  assert.deepEqual(state.field(lintStateField).findings, findings);
  assert.equal(state.field(lintStateField).decorations.size, 2);

  state = state.update({ changes: { from: 0, insert: '今夜，' } }).state;
  assert.deepEqual(state.field(lintStateField).findings, []);
  assert.equal(state.field(lintStateField).decorations.size, 0);
});

test('out-of-range server findings are ignored instead of breaking the editor', () => {
  let state = EditorState.create({ doc: '短句', extensions: [lintStateField] });
  state = state.update({
    effects: setLintFindings.of([{ ...findings[0]!, offset: 99, length: 4 }]),
  }).state;
  assert.equal(state.field(lintStateField).decorations.size, 0);
});
