/**
 * Dependency-free Markdown line decorations for the editor: heading lines get
 * a weight/size class, blockquote lines get a muted class. Avoids pulling a
 * syntax-highlight theme (and its @lezer/highlight dependency) for the small
 * amount of emphasis a manuscript editor needs.
 */

import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';

const HEADING = /^(#{1,6})\s/;
const QUOTE = /^\s*>/;

const headingDeco = [1, 2, 3, 4, 5, 6].map((level) => Decoration.line({ class: `cm-md-h${level}` }));
const quoteDeco = Decoration.line({ class: 'cm-md-quote' });

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const h = HEADING.exec(line.text);
      if (h && h[1]) {
        builder.add(line.from, line.from, headingDeco[h[1].length - 1]!);
      } else if (QUOTE.test(line.text)) {
        builder.add(line.from, line.from, quoteDeco);
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const mdDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);
