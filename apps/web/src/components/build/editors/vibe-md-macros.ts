/**
 * `{{`-macro autocomplete for the CodeMirror editor (Vibe MD surface).
 *
 * Uses CodeMirror 6's native `@codemirror/autocomplete` (not the React popup):
 * the editor owns focus and caret, so the native completion tooltip gets
 * correct caret-relative positioning + keyboard nav (ArrowUp/Down/Enter/Tab/
 * Escape via `defaultKeymap`) for free. The completion source mirrors the
 * React `AutoTextArea` picker: same catalog (`getMacroCatalog`), same shared
 * recency store (`useMacroAutocompleteStore` — so a macro picked in any surface
 * rises to the top everywhere), and the same seed ordering.
 *
 * On accept, the typed `{{query` range is replaced by `{{name}}` and the cursor
 * lands after the token.
 */

import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { getMacroCatalog } from "@vibe-tavern/prompt-pipeline";
import {
  macroCategoryLabel,
  orderMacrosForDisplay,
  useMacroAutocompleteStore,
} from "../../shared/macro-autocomplete-store.js";

/**
 * Completion source: return macro options when the text before the cursor is an
 * open `{{` session (the braces plus optional name chars, not yet closed by
 * `}`). `matchBefore` requires the regex to end at — and match up to — the
 * cursor, so it returns null once `}}` (or any `}`) is typed.
 */
export function macroCompletions(cx: CompletionContext): CompletionResult | null {
  const m = cx.matchBefore(/\{\{[\w:]*$/);
  if (!m) return null;

  const recency = useMacroAutocompleteStore.getState().recency;
  const ordered = orderMacrosForDisplay(getMacroCatalog(), recency);

  const options: Completion[] = ordered.map((entry) => {
    const token = `{{${entry.name}}}`;
    return {
      label: token,
      type: "variable",
      detail: `${entry.description} · ${macroCategoryLabel(entry.category)}`,
      apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
        // `from`..`to` is the `{{query` range (== result.from..cursor). Replace
        // it with the full token and place the caret after it.
        view.dispatch({
          changes: { from, to, insert: token },
          selection: { anchor: from + token.length },
        });
        useMacroAutocompleteStore.getState().pick(entry.name);
      },
    };
  });

  return {
    from: m.from,
    options,
    // Keep the popup open while the text from `from` stays a valid `{{`-query;
    // typing `}` (closing the macro) or leaving the region closes it.
    validFor: /^\{\{[\w:]*$/,
  };
}

/** Style the native autocomplete tooltip to match the app's dark surface. */
const tooltipTheme = EditorView.baseTheme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "var(--input-bg)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
    fontFamily: "var(--font-ui)",
    fontSize: "12px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono)",
    maxHeight: "240px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "4px 10px",
    color: "var(--t1)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--s2)",
    color: "var(--t1)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete .cm-completionDetail": {
    fontFamily: "var(--font-ui)",
    color: "var(--t3)",
  },
});

/**
 * The Vibe MD macro-autocomplete extension. Add to the editor's extensions.
 * `override` makes this the sole completion source; `defaultKeymap` wires
 * ArrowUp/Down/Enter/Tab/Escape; `icons: false` (the label is already `{{name}}`).
 */
export function macroAutocomplete(): Extension[] {
  return [
    autocompletion({
      override: [macroCompletions],
      defaultKeymap: true,
      closeOnBlur: true,
      icons: false,
    }),
    tooltipTheme,
  ];
}
