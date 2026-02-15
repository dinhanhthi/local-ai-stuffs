import { diffLines } from 'diff';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet, ViewPlugin } from '@codemirror/view';

const addedLine = Decoration.line({ class: 'cm-diff-added' });
const removedLine = Decoration.line({ class: 'cm-diff-removed' });

/**
 * Build line decorations for the "this" side of a diff.
 * `side` = 'a' means we highlight lines removed in `a` (store) but not in `b`.
 * `side` = 'b' means we highlight lines added in `b` (target) but not in `a`.
 */
function buildDecorations(
  doc: { lines: number; line(n: number): { from: number } },
  thisContent: string,
  otherContent: string,
  side: 'a' | 'b',
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const changes = diffLines(otherContent, thisContent);

  let lineNum = 1;
  for (const change of changes) {
    const count = change.count ?? 0;
    if (change.added) {
      // Lines present in thisContent but not in otherContent
      if (side === 'b') {
        for (let i = 0; i < count && lineNum <= doc.lines; i++, lineNum++) {
          builder.add(doc.line(lineNum).from, doc.line(lineNum).from, addedLine);
        }
      } else {
        lineNum += count;
      }
    } else if (change.removed) {
      // Lines present in otherContent but not in thisContent
      if (side === 'a') {
        for (let i = 0; i < count && lineNum <= doc.lines; i++, lineNum++) {
          builder.add(doc.line(lineNum).from, doc.line(lineNum).from, removedLine);
        }
      }
      // removed lines don't exist in thisContent, don't advance lineNum for the other side
    } else {
      // Unchanged lines
      lineNum += count;
    }
  }

  return builder.finish();
}

/**
 * Create a CodeMirror extension that highlights diff lines.
 * `thisContent` is the text shown in this editor.
 * `otherContent` is the text on the other side to diff against.
 * `side` indicates which side this editor represents.
 */
export function diffHighlight(thisContent: string, otherContent: string, side: 'a' | 'b') {
  const plugin = ViewPlugin.define(
    (view) => ({
      decorations: buildDecorations(view.state.doc, thisContent, otherContent, side),
    }),
    {
      decorations: (v) => v.decorations,
    },
  );

  const theme = EditorView.baseTheme({
    '.cm-diff-added': { backgroundColor: 'rgba(76, 175, 80, 0.15)' },
    '.cm-diff-removed': { backgroundColor: 'rgba(244, 67, 54, 0.15)' },
  });

  return [plugin, theme];
}
