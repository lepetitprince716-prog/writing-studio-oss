import { StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  hoverTooltip,
  type DecorationSet,
} from '@codemirror/view';
import type { LintFinding } from '@writing-studio/contract';

interface LintEditorState {
  findings: readonly LintFinding[];
  decorations: DecorationSet;
}

export const setLintFindings = StateEffect.define<readonly LintFinding[]>();

function buildDecorations(
  documentLength: number,
  findings: readonly LintFinding[],
): DecorationSet {
  const ranges = findings.flatMap((finding) => {
    const from = Math.min(documentLength, Math.max(0, finding.offset));
    const to = Math.min(documentLength, Math.max(from, finding.offset + finding.length));
    if (to <= from) return [];
    const className = finding.category === 'sensitive'
      ? 'cm-lint-sensitive'
      : 'cm-lint-style';
    return [Decoration.mark({
      class: className,
      attributes: {
        'data-lint-rule': finding.ruleId,
        'aria-label': finding.message,
      },
    }).range(from, to)];
  });
  return Decoration.set(ranges, true);
}

export const lintStateField = StateField.define<LintEditorState>({
  create() {
    return { findings: [], decorations: Decoration.none };
  },
  update(value, transaction) {
    let findings = transaction.docChanged ? [] : value.findings;
    for (const effect of transaction.effects) {
      if (effect.is(setLintFindings)) findings = effect.value;
    }
    if (findings === value.findings) return value;
    return {
      findings,
      decorations: buildDecorations(transaction.newDoc.length, findings),
    };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export const lintHoverTooltip = hoverTooltip((view, position) => {
  const finding = view.state.field(lintStateField).findings.find((candidate) =>
    position >= candidate.offset && position < candidate.offset + candidate.length);
  if (!finding) return null;
  return {
    pos: finding.offset,
    end: finding.offset + finding.length,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = `cm-lint-tooltip ${finding.category}`;
      dom.textContent = finding.message;
      return { dom };
    },
  };
});
