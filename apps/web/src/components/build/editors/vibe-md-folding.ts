/**
 * Vibe MD — heading folding (CodeMirror 6), inline-toggle style.
 *
 * Makes the structural divider lines foldable so the user can collapse a whole
 * section to reduce visual noise on long cards:
 *  - an **H1 heading** (`# PERSONALITY` etc.) folds its entire body — from the
 *    end of the heading line up to (but excluding) the next H1, or EOF.
 *    `=== ALT N ===` markers are treated as *body* of the `# GREETINGS` section,
 *    so folding `# GREETINGS` collapses the whole greeting stack at once.
 *  - an **`=== ALT N ===` marker** folds just that alternate block — up to the
 *    next `=== ALT` marker or the next H1, whichever comes first.
 *
 * UI: the fold chevron is an **inline widget at the end of the structural
 * line**, NOT a separate left gutter column. A gutter would occupy a full
 * vertical strip left of the content (plus the content's own padding), leaving
 * the chevron far from the heading text. An inline widget hugs the text and
 * reads like a conventional accordion (▾ open / ▸ collapsed), placed BEFORE the
 * greetings `+`/`✕` widget on the same line.
 *
 * Toggling dispatches `foldEffect` / `unfoldEffect` (from `@codemirror/language`)
 * against the line's body range; `codeFolding()` carries the fold state and
 * renders the inline `…` placeholder for collapsed bodies. `foldKeymap` adds the
 * keyboard toggles (Ctrl-Q / Cmd-Opt-[ etc.).
 *
 * Folds are view state: they survive normal typing, but a wholesale body
 * replace (Reset, character switch, add/remove greeting) drops them. That is
 * acceptable for a transient noise-reduction affordance.
 */

import {
  codeFolding,
  foldEffect,
  foldKeymap,
  foldService,
  foldState,
  unfoldEffect,
} from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import { EditorState, RangeSet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { keymap } from "@codemirror/view";

/** Matches an H1 heading line (`# X`, at least one char after the marker). */
const H1_RE = /^#\s+\S/;
/** Matches an `=== ALT N ===` greeting marker line. */
const ALT_RE = /^[=\-]{3}\s*(?:alt|ALT)(?:\s+\d+)?\s*[=\-]{3}\s*$/;

/** Whether `line` is a structural divider that owns a foldable body. */
function isFoldableLine(text: string): boolean {
  return H1_RE.test(text) || ALT_RE.test(text.trim());
}

/**
 * The body range a structural line collapses to:
 *  - H1 boundary:  next H1 (ALT markers are GREETINGS body, not a boundary).
 *  - ALT boundary: next ALT marker OR next H1 (whichever first).
 * `from` = end of the heading line (heading stays visible);
 * `to`   = end of the last body line.
 * Returns null if the line has no body (e.g. two adjacent headings).
 */
function foldRangeFor(state: EditorState, lineStart: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart);
  if (!isFoldableLine(line.text)) return null;
  const isH1 = H1_RE.test(line.text);
  let lastBodyLine = line.number;
  for (let i = line.number + 1; i <= state.doc.lines; i++) {
    const t = state.doc.line(i).text;
    const hitsBoundary = isH1 ? H1_RE.test(t) : ALT_RE.test(t.trim()) || H1_RE.test(t);
    if (hitsBoundary) break;
    lastBodyLine = i;
  }
  if (lastBodyLine <= line.number) return null;
  return { from: line.to, to: state.doc.line(lastBodyLine).to };
}

// foldService makes the line foldable (so foldKeymap / foldEffect know the range).
const vibeMdFoldService = foldService.of((state, lineStart) => foldRangeFor(state, lineStart));

/** Is there a fold range starting exactly at `pos`? */
function isFoldedAt(folds: RangeSet<Decoration>, pos: number): boolean {
  for (let cur = folds.iter(); cur.value; cur.next()) {
    if (cur.from === pos) return true;
  }
  return false;
}

/** Inline fold-toggle chevron widget placed at the end of a structural line. */
class FoldToggleWidget extends WidgetType {
  constructor(
    private readonly lineFrom: number,
    private readonly bodyFrom: number,
    private readonly bodyTo: number,
    private readonly folded: boolean,
  ) {
    super();
  }
  toDOM(view: EditorView): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-vtf-fold-btn " + (this.folded ? "cm-vtf-fold-closed" : "cm-vtf-fold-open");
    btn.title = this.folded ? "Unfold section" : "Fold section";
    btn.setAttribute("aria-label", this.folded ? "Unfold section" : "Fold section");
    btn.innerHTML = this.folded
      ? '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>'
      : '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
    btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep editor focus
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const range = foldRangeFor(view.state, this.lineFrom);
      if (!range) return;
      const folded = isFoldedAt(view.state.field(foldState) ?? Decoration.none, range.from);
      view.dispatch({
        effects: (folded ? unfoldEffect : foldEffect).of({ from: range.from, to: range.to }),
      });
    });
    return btn;
  }
  eq(other: FoldToggleWidget): boolean {
    return (
      other.lineFrom === this.lineFrom &&
      other.bodyFrom === this.bodyFrom &&
      other.bodyTo === this.bodyTo &&
      other.folded === this.folded
    );
  }
  ignoreEvent(): boolean {
    return false; // let click/mousedown reach the button
  }
}

function buildFoldDecorations(view: EditorView): RangeSet<Decoration> {
  const widgets: Range<Decoration>[] = [];
  const folds = view.state.field(foldState) ?? Decoration.none;
  for (let i = 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i);
    if (!isFoldableLine(line.text)) continue;
    const range = foldRangeFor(view.state, line.from);
    if (!range) continue;
    const folded = isFoldedAt(folds, range.from);
    widgets.push(
      // side: 1 → after line content. Lower side sorts first (leftmost), so the
      // chevron (side 1) appears BEFORE the greetings +/✕ widget (side 2).
      Decoration.widget({
        widget: new FoldToggleWidget(line.from, range.from, range.to, folded),
        side: 1,
      }).range(line.to),
    );
  }
  return Decoration.set(widgets, true);
}

const foldTogglePlugin = ViewPlugin.fromClass(
  class {
    decorations: RangeSet<Decoration>;
    constructor(view: EditorView) {
      this.decorations = buildFoldDecorations(view);
    }
    update(update: ViewUpdate): void {
      const docOrViewport = update.docChanged || update.viewportChanged;
      const foldsChanged = update.startState.field(foldState) !== update.state.field(foldState);
      if (docOrViewport || foldsChanged) {
        this.decorations = buildFoldDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * The folding surface: fold state + service + inline toggle widgets + keymap.
 * Compose into the editor's extensions alongside `vibeMdBundle()` /
 * `greetingsUi()`. (No `foldGutter` — the chevron is an inline widget.)
 */
export function vibeMdFolding(): Extension[] {
  // NOTE: `foldKeymap` is wired in, but the hotkeys (Ctrl-Q / Cmd-Opt-[, etc.)
  // currently don't fire — likely swallowed by an editor- or app-level
  // keymap/shortcut handler earlier in the precedence chain. The inline ▾/▸
  // toggle widget is the working fold affordance for now; revisit keymap
  // precedence later. Tracked as a known TODO.
  return [codeFolding(), vibeMdFoldService, foldTogglePlugin, keymap.of(foldKeymap)];
}
