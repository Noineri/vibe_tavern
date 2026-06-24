/**
 * Vibe MD — locked headings (CodeMirror 6 `changeFilter`).
 *
 * **Threat 1 — UX guardrail.** H1 heading LINES (`# PERSONALITY`, `# SCENARIO`,
 * `# EXAMPLES`) are made read-only against *user typing*. A first-class CM6
 * transaction filter cancels input/delete transactions whose changes touch a
 * heading line, so the user cannot accidentally delete, retype, or move one.
 *
 * What this is NOT: the data-integrity guarantee. It does not — and cannot —
 * protect against programmatic writes (LLM Co-Author apply, import, store
 * round-trip). Those are handled by structural pinning in `vibe-md-sync.ts`
 * (VTF-12), which re-emits the canonical heading set on every save. The two
 * layers are complementary; see the VTF plan ADR and `vibe-md-theme.ts` header.
 *
 * Scope of the block (why programmatic writes are let through unchanged):
 * `changeFilter` fires for every document-changing transaction, including
 * wholesale replacements dispatched by the sync layer. Gating the block on
 * `isUserEvent("input" | "delete")` ensures sync's programmatic updates are
 * never cancelled — otherwise enabling this extension would break VTF-12's
 * editor refresh. Undo/redo are excluded on purpose: a heading change can never
 * enter the history in the first place (it would have been blocked here), so
 * undo/redo never carry heading mutations.
 *
 * Edge cases handled by the range math in `changeTouchesHeading`:
 *  - typing/inserting anywhere inside a heading line (incl. splitting via \n);
 *  - deleting the heading's leading `#` or any of its characters;
 *  - deleting the newline *after* a heading (would merge heading into next line);
 *  - deleting the newline *before* a heading (would merge previous line into it);
 *  - appending to a heading that is the last line of the document.
 */

import { EditorState, type Extension, type Transaction, type Text } from "@codemirror/state";
import { ViewPlugin, type ViewUpdate, EditorView, Decoration, type DecorationSet } from "@codemirror/view";

/** Matches an H1 heading line: `# ` followed by a non-space. Shared with the theme. */
const H1_LINE_RE = /^#\s+\S/;

/**
 * Does a change `[fromA, toA]` (positions in the pre-change doc) touch a
 * heading line? A heading's protected span extends one char before its start
 * (so deleting the preceding newline, which would merge it into the previous
 * line, is caught) and one past its terminator (so deleting its own trailing
 * newline, or appending to a final-line heading, is caught). Overlap is strict
 * on both ends: a pure insertion collapses to `fromA === toA`, which overlaps
 * iff that point falls strictly inside the protected span.
 *
 * Scans every line rather than only the changed region: the document is a
 * character card (hundreds of lines at most) and this sidesteps every
 * `lineAt()` line-boundary ambiguity — correctness over a micro-optimisation.
 */
function changeTouchesHeading(doc: Text, fromA: number, toA: number): boolean {
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (H1_LINE_RE.test(line.text)) {
      const start = line.from > 0 ? line.from - 1 : 0;
      const end = line.to + 1; // include trailing terminator + guard last-line append
      if (fromA < end && toA > start) return true;
    }
  }
  return false;
}

const lockedHeadingsFilter = EditorState.changeFilter.of((tr: Transaction): boolean => {
  if (!tr.docChanged) return true;
  // Only block user-originated edits; programmatic writes pass through (see header).
  if (!tr.isUserEvent("input") && !tr.isUserEvent("delete")) return true;
  const doc = tr.startState.doc;
  let touchesHeading = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (!touchesHeading && changeTouchesHeading(doc, fromA, toA)) {
      touchesHeading = true;
    }
  });
  return !touchesHeading;
});

// ───────────────────────────────────────────────────────────────────────────
// Active-cursor decoration: when the caret rests on a heading line, flag it.
// The static lock badge (vibe-md-theme.ts) marks every heading as read-only;
// this is the *interaction* feedback — the caret can still be placed on a
// heading (selection isn't blocked), so a `not-allowed` cursor + stronger tint
// explains why typing then does nothing. Without it, an accent caret on a
// heading that ignores input reads as a bug.
// ───────────────────────────────────────────────────────────────────────────

function buildActiveHeadingDecoration(view: EditorView): DecorationSet {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  if (!H1_LINE_RE.test(line.text)) return Decoration.none;
  return Decoration.set([Decoration.line({ class: "cm-vtf-locked-active" }).range(line.from)], true);
}

const activeHeadingPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildActiveHeadingDecoration(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildActiveHeadingDecoration(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * The locked-headings surface: the `changeFilter` (Threat 1 UX guardrail) plus
 * the active-cursor decoration. Compose into an editor's extensions alongside
 * `vibeMdBundle()` (VTF-13 `VibeMdView`; the `#vtf-preview` surface composes
 * it too for live testing). The read-only Co-Author diff panel does NOT compose
 * this — it has no user input to guard.
 */
export function lockedHeadings(): Extension[] {
  return [lockedHeadingsFilter, activeHeadingPlugin];
}

/** Exposed for tests that want to assert heading detection without a full editor. */
export { H1_LINE_RE as LOCKED_HEADING_RE, changeTouchesHeading };
