/**
 * CodeEditor — external-sync echo tests.
 *
 * Pins the contract that `onChange` fires ONLY for user edits, never for
 * programmatic syncs of the `value` prop. The sync effect replaces the whole
 * document via `view.dispatch(...)`; without a guard that dispatch echoes
 * through the updateListener back into `onChange`, so a parent that feeds
 * server state into the editor gets a phantom "user edit" carrying the
 * EXTERNAL text — which in ScriptEditor scheduled an autosave of stale code
 * over the user's fresher pending input (the "eaten characters" race).
 *
 * Runner: vitest (apps/web) + happy-dom; CodeMirror 6 mounts headless here.
 */
import { describe, it, expect, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { CodeEditor } from "./CodeEditor.js";

function getView(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor");
  if (!(dom instanceof HTMLElement)) throw new Error("cm-editor not mounted");
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("EditorView not found");
  return view;
}

describe("CodeEditor", () => {
  it("emits onChange for user edits", () => {
    const onChange = vi.fn();
    const { container } = render(<CodeEditor value="" onChange={onChange} />);
    const view = getView(container);

    act(() => {
      view.dispatch({ changes: { from: 0, insert: "x" } });
    });

    expect(onChange).toHaveBeenCalledWith("x");
  });

  it("syncs an external value change into the document WITHOUT emitting onChange", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<CodeEditor value="hello" onChange={onChange} />);
    const view = getView(container);
    onChange.mockClear();

    rerender(<CodeEditor value="external" onChange={onChange} />);

    // The document must reflect the new prop…
    expect(view.state.doc.toString()).toBe("external");
    // …but that programmatic dispatch must NOT echo back as a user edit.
    expect(onChange).not.toHaveBeenCalled();
  });
});
