import { Text, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";

/**
 * The «Show in code» reveal affordance (SS-7) — extracted from
 * `components/build/editors/script-safety/FindingsWarningModal.tsx` (AS-6c-ii:
 * the shared `AgentBufferReviewEditor` imported the helper from that
 * build/editors module, an upward shared→build import; this neutral `lib`
 * home removes it — the modal, the shared review editor, and `ScriptEditor`
 * all import from here now).
 *
 * `scriptSafetyRevealPosition` moves with `scriptSafetyRevealLine` (it is the
 * line's only dependency — leaving it behind would point this module back at
 * the modal file and recreate the same violation in reverse).
 */

/** Clamp a 1-based finding line onto the live document (1..doc.lines) and
 *  return the absolute 0-based offset of that line's start — the jump target
 *  the «Show in code» reveal uses. Pure so the clamp is unit-testable without
 *  an editor view. */
export function scriptSafetyRevealPosition(doc: Text, line: number): number {
  const clamped = Math.max(1, Math.min(line, doc.lines));
  return doc.line(clamped).from;
}

/** The «Show in code» reveal jump (SS-7): a CodeMirror extension that, once
 *  installed, moves the caret to the finding's line and centers it — the
 *  same affordance the lint gutter gives, driven from the modal.
 *
 *  Consumers fold it into their existing `extensions` array (the CD-4
 *  compartment seam, like the SS-5 linter): passing a FRESH instance per
 *  reveal request reconfigures the compartment, which (re)instantiates this
 *  plugin and fires the jump. The closure-level `fired` flag guarantees ONE
 *  jump per request even when a later spec change reconfigures the same
 *  memoized instance back in.
 *
 *  The dispatch is deferred a frame (CodeMirror requires measure-safe timing
 *  for scroll effects) and guarded by DOM connectivity so a view destroyed by
 *  a remount (mobile breakpoint crossing) can never throw. */
export function scriptSafetyRevealLine(line: number): Extension {
  let fired = false;
  return ViewPlugin.define((view) => {
    if (fired) return {};
    fired = true;
    const pos = scriptSafetyRevealPosition(view.state.doc, line);
    requestAnimationFrame(() => {
      if (!view.dom.isConnected) return;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
    });
    return {};
  });
}
