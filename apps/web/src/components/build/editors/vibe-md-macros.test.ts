import { describe, expect, it, beforeEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionContext, type Completion } from "@codemirror/autocomplete";
import { macroAutocomplete, macroCompletions } from "./vibe-md-macros.js";
import { useMacroAutocompleteStore } from "../../shared/macro-autocomplete-store.js";

function ctxFor(doc: string, pos = doc.length, explicit = false): CompletionContext {
  const state = EditorState.create({ doc });
  return new CompletionContext(state, pos, explicit);
}

describe("macroCompletions (CM6 source)", () => {
  beforeEach(() => useMacroAutocompleteStore.setState({ recency: [] }));

  it("returns null when there is no {{", () => {
    expect(macroCompletions(ctxFor("hello world"))).toBeNull();
  });

  it("returns the catalog immediately after {{, anchored at the braces", () => {
    const r = macroCompletions(ctxFor("hello {{"));
    expect(r).not.toBeNull();
    const labels = r!.options.map((o) => o.label);
    expect(labels).toContain("{{user}}");
    expect(labels).toContain("{{char}}");
    // from = position of the first '{' (replacement range covers `{{query`)
    expect(r!.from).toBe(6);
  });

  it("keeps the session open for name chars but not once }} is typed", () => {
    const r = macroCompletions(ctxFor("{{us"));
    expect(r).not.toBeNull();
    const validFor = r!.validFor as RegExp;
    expect(validFor.test("{{us")).toBe(true);
    expect(validFor.test("{{user}}")).toBe(false);
  });

  it("closes once the macro is completed (matchBefore fails on `}`)", () => {
    expect(macroCompletions(ctxFor("{{user}}"))).toBeNull();
    expect(macroCompletions(ctxFor("text {{su"))?.from).toBe(5);
  });

  it("apply inserts the full token, places the caret after it, and records recency", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      state: EditorState.create({ doc: "hi {{us", extensions: macroAutocomplete() }),
      parent: host,
    });
    try {
      const r = macroCompletions(new CompletionContext(view.state, 7, false));
      expect(r).not.toBeNull();
      const userOpt = r!.options.find((o) => o.label === "{{user}}") as Completion;
      expect(userOpt).toBeTruthy();
      const apply = userOpt.apply as (v: EditorView, c: Completion, from: number, to: number) => void;
      apply(view, userOpt, r!.from, 7);
      expect(view.state.doc.toString()).toBe("hi {{user}}");
      expect(view.state.selection.main.head).toBe("hi {{user}}".length);
      expect(useMacroAutocompleteStore.getState().recency[0]).toBe("user");
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
