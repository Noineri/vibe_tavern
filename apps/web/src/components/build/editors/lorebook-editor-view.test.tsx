/**
 * LorebookEditorView — header/agent-panel composition (AS-8c4d).
 *
 * Pins that the editor header row renders only when there is no agent panel:
 * the agent panel carries its own back control (first in the bar on desktop,
 * the shell's tab-row chevron on mobile), so a header row above it would cost
 * a whole row for one caret. Lore entries keep their header row — the view
 * renders it whenever the panel is null.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let LorebookEditorView: typeof import("./lorebook-editor-view.js").LorebookEditorView;
beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  ({ LorebookEditorView } = await import("./lorebook-editor-view.js"));
});

describe("LorebookEditorView (AS-8c4d)", () => {
  it("skips the header row when the agent panel is present", () => {
    const { getByTestId, queryByTestId } = render(
      <LorebookEditorView
        editorHeader={<div data-testid="editor-header">header</div>}
        agentPanel={<div data-testid="agent-panel">panel</div>}
        isMobile={false}
      >
        <div data-testid="plain-children">children</div>
      </LorebookEditorView>,
    );

    // The panel renders; the header row (and the plain container with it)
    // does not — the panel owns the full height plus its own back control.
    expect(getByTestId("agent-panel")).toBeTruthy();
    expect(queryByTestId("editor-header")).toBeNull();
    expect(queryByTestId("plain-children")).toBeNull();
  });

  it("renders the header row and the children when there is no agent panel", () => {
    const { getByTestId, queryByTestId } = render(
      <LorebookEditorView
        editorHeader={<div data-testid="editor-header">header</div>}
        agentPanel={null}
        isMobile={false}
      >
        <div data-testid="plain-children">children</div>
      </LorebookEditorView>,
    );

    // Lore entries keep their header row above the padded container.
    expect(getByTestId("editor-header")).toBeTruthy();
    expect(getByTestId("plain-children")).toBeTruthy();
    expect(queryByTestId("agent-panel")).toBeNull();
  });
});
