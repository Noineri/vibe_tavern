/**
 * Vibe MD — greetings UI widgets (CodeMirror 6).
 *
 * Interactive decorations on the `# GREETINGS` section (VTF-13 rework):
 *  - a **`+` button** appended to the `# GREETINGS` heading line → adds a new
 *    alternate greeting block (calls `onAdd`);
 *  - a **`✕` button** appended to every `=== ALT N ===` marker line → deletes
 *    that alternate (calls `onRemove(altIndex)`, 0-based into
 *    `alternateGreetings[]`).
 *  - the `=== ALT N ===` marker LINES are locked against user typing (a
 *    `changeFilter`, mirroring `vibe-md-locked-headings.ts`) so a marker can't
 *    be broken by an accidental keystroke — the same UX-guardrail rationale as
 *    for H1 headings. The marker bodies remain fully editable.
 *
 * The widgets do NOT mutate the document directly. They call React-side
 * handlers (`onAdd` / `onRemove`) which update the form draft; the existing
 * form→editor subscription (VibeMdView) then re-emits the canonical body via
 * `draftToBody` and dispatches it. This reuses the structural-pinning pipeline
 * (markers are always re-emitted canonically by `compileGreetingsInline`, so
 * numbering never drifts to `ALT 1, ALT 3`) and keeps a single source of truth.
 */

import { EditorState, type Extension, type Transaction, type Text, type Range } from "@codemirror/state";
import { ViewPlugin, type ViewUpdate, EditorView, Decoration, type DecorationSet, WidgetType } from "@codemirror/view";

/** Matches an `=== ALT [N] ===` greeting marker line. */
const GREETINGS_ALT_RE = /^[=\-]{3}\s*(?:alt|ALT)(?:\s+\d+)?\s*[=\-]{3}\s*$/;
/** Matches the `# GREETINGS` H1 line. */
const GREETINGS_H1_RE = /^#\s+GREETINGS\s*$/;

export interface GreetingsUiHandlers {
  /** Add a new alternate greeting block. */
  onAdd: () => void;
  /** Remove the alternate greeting at `altIndex` (0-based into alternateGreetings[]). */
  onRemove: (altIndex: number) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Widgets
// ─────────────────────────────────────────────────────────────────────────────

/** `+` button widget on the `# GREETINGS` heading. */
class AddGreetingWidget extends WidgetType {
  constructor(private readonly onAdd: () => void) {
    super();
  }
  toDOM(): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-vtf-greet-btn cm-vtf-greet-add";
    btn.title = "Add alternate greeting";
    btn.setAttribute("aria-label", "Add alternate greeting");
    btn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>';
    btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep editor focus
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onAdd();
    });
    return btn;
  }
  eq(): boolean {
    return true; // single instance; handler identity is stable for the editor's life
  }
  ignoreEvent(): boolean {
    return false; // let click/mousedown through to the button
  }
}

/** `✕` button widget on an `=== ALT N ===` marker line. */
class RemoveGreetingWidget extends WidgetType {
  constructor(
    private readonly altIndex: number,
    private readonly onRemove: (altIndex: number) => void,
  ) {
    super();
  }
  toDOM(): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-vtf-greet-btn cm-vtf-greet-remove";
    btn.title = "Delete this alternate greeting";
    btn.setAttribute("aria-label", "Delete this alternate greeting");
    btn.innerHTML =
      '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>';
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onRemove(this.altIndex);
    });
    return btn;
  }
  eq(other: RemoveGreetingWidget): boolean {
    return other.altIndex === this.altIndex;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Decoration plugin
// ─────────────────────────────────────────────────────────────────────────────

function buildGreetingsDecorations(view: EditorView, handlers: GreetingsUiHandlers): DecorationSet {
  const widgets: Range<Decoration>[] = [];
  const lines: Range<Decoration>[] = [];
  let altIndex = 0;
  for (let i = 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i);
    const text = line.text.trim();
    if (GREETINGS_H1_RE.test(text)) {
      lines.push(Decoration.line({ class: "cm-vtf-greet-h1" }).range(line.from));
      widgets.push(Decoration.widget({ widget: new AddGreetingWidget(handlers.onAdd), side: 2 }).range(line.to));
    } else if (GREETINGS_ALT_RE.test(text)) {
      const idx = altIndex;
      lines.push(Decoration.line({ class: "cm-vtf-alt-marker" }).range(line.from));
      widgets.push(Decoration.widget({ widget: new RemoveGreetingWidget(idx, handlers.onRemove), side: 2 }).range(line.to));
      altIndex++;
    }
  }
  return Decoration.set([...lines, ...widgets], true);
}

function greetingsDecorations(handlers: GreetingsUiHandlers): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildGreetingsDecorations(view, handlers);
      }
      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildGreetingsDecorations(update.view, handlers);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker-line locking (UX guardrail — mirrors vibe-md-locked-headings.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Does a change touch an `=== ALT N ===` marker line? Same span math as the
 *  H1 guard: protect one char before the line start (preceding newline merge)
 *  and one past its terminator (trailing newline / last-line append). */
function changeTouchesMarker(doc: Text, fromA: number, toA: number): boolean {
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (GREETINGS_ALT_RE.test(line.text.trim())) {
      const start = line.from > 0 ? line.from - 1 : 0;
      const end = line.to + 1;
      if (fromA < end && toA > start) return true;
    }
  }
  return false;
}

const markerChangeFilter = EditorState.changeFilter.of((tr: Transaction): boolean => {
  if (!tr.docChanged) return true;
  if (!tr.isUserEvent("input") && !tr.isUserEvent("delete")) return true;
  const doc = tr.startState.doc;
  let touches = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (!touches && changeTouchesMarker(doc, fromA, toA)) touches = true;
  });
  return !touches;
});

/**
 * The greetings-UI surface: the marker-line lock (UX guardrail) plus the
 * `+` / `✕` widget decorations. Compose into the editor's extensions alongside
 * `vibeMdBundle()` and `lockedHeadings()`.
 */
export function greetingsUi(handlers: GreetingsUiHandlers): Extension[] {
  return [markerChangeFilter, greetingsDecorations(handlers)];
}
