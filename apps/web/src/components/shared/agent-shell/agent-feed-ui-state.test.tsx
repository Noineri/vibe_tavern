import { beforeAll, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import {
  AgentFeedUiStateProvider,
  createAgentFeedUiStateStore,
  useAgentFeedRowUiState,
} from "./agent-feed-ui-state.js";

useDomEnv();

// AFP-3 (AGENT_FEED_PERFORMANCE_PLAN Wave 1 step 5): pins for the
// session-local row UI-state container. The contract the plan owns:
// disclosures/dirty drafts keyed by stable row id SURVIVE row unmount, are
// NOT persisted, and a keystroke re-renders only its own row (per-key
// subscription, never a whole-map subscription). Pure harness — no i18n, no
// seams, no mocks.

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let act: typeof import("@testing-library/react").act;

beforeAll(async () => {
  ({ render, fireEvent, act } = await import("@testing-library/react"));
});

/** A minimal row consumer: a disclosure toggle, a draft input and the
 *  retained state rendered as text — enough to observe the hook contract. */
function Row({
  rowKey,
  label,
  renderCount,
}: {
  rowKey: string;
  label: string;
  renderCount?: { current: number };
}) {
  if (renderCount !== undefined) renderCount.current += 1;
  const state = useAgentFeedRowUiState(rowKey);
  return (
    <div data-testid={label} data-disclosed={state.entry.disclosed === true ? "open" : "closed"}>
      <span data-testid={`${label}-draft`}>{state.entry.draft ?? ""}</span>
      <button onClick={() => state.setDisclosed(state.entry.disclosed !== true)}>toggle</button>
      <input
        data-testid={`${label}-input`}
        value={state.entry.draft ?? ""}
        onChange={(e) => state.setDraft(e.target.value)}
      />
    </div>
  );
}

describe("agent-feed-ui-state — session-local row state (AFP-3)", () => {
  it("disclosure and a dirty draft survive row unmount (no hidden DOM retained)", async () => {
    const view = render(
      <AgentFeedUiStateProvider sessionKey="s1">
        <Row rowKey="msg:u1" label="row" />
      </AgentFeedUiStateProvider>,
    );
    await act(async () => {
      view.getByText("toggle").click();
      fireEvent.change(view.getByTestId("row-input"), { target: { value: "dirty draft" } });
    });
    expect(view.getByTestId("row").getAttribute("data-disclosed")).toBe("open");
    expect(view.getByTestId("row-draft").textContent).toBe("dirty draft");

    // The row unmounts (virtualized away) — nothing of it stays in the DOM…
    view.rerender(
      <AgentFeedUiStateProvider sessionKey="s1">{null}</AgentFeedUiStateProvider>,
    );
    // …but a FRESH mount of the same row key restores the retained state
    // (the SAME provider store — the row's state outlives the row, not the
    // session).
    view.rerender(
      <AgentFeedUiStateProvider sessionKey="s1">
        <Row rowKey="msg:u1" label="row" />
      </AgentFeedUiStateProvider>,
    );
    expect(view.getByTestId("row").getAttribute("data-disclosed")).toBe("open");
    expect(view.getByTestId("row-draft").textContent).toBe("dirty draft");
    view.unmount();
  });

  it("a draft keystroke re-renders only its own row (per-key subscription)", async () => {
    const rendersA = { current: 0 };
    const rendersB = { current: 0 };
    const view = render(
      <AgentFeedUiStateProvider sessionKey="s1">
        <Row rowKey="msg:u1" label="a" renderCount={rendersA} />
        <Row rowKey="msg:u2" label="b" renderCount={rendersB} />
      </AgentFeedUiStateProvider>,
    );
    const aBefore = rendersA.current;
    const bBefore = rendersB.current;
    await act(async () => {
      fireEvent.change(view.getByTestId("a-input"), { target: { value: "x" } });
    });
    expect(view.getByTestId("a-draft").textContent).toBe("x");
    // Row A re-rendered (its own state changed); row B did NOT — the whole
    // feed never re-renders on a keystroke.
    expect(rendersA.current).toBeGreaterThan(aBefore);
    expect(rendersB.current).toBe(bBefore);
    view.unmount();
  });

  it("a real session change (sessionKey) resets every row; a plain rerender keeps the store", async () => {
    const view = render(
      <AgentFeedUiStateProvider sessionKey="s1">
        <Row rowKey="msg:u1" label="row" />
      </AgentFeedUiStateProvider>,
    );
    await act(async () => {
      view.getByText("toggle").click();
    });
    expect(view.getByTestId("row").getAttribute("data-disclosed")).toBe("open");

    // Same sessionKey, children identity change — the store (and state) is
    // kept across re-renders.
    view.rerender(
      <AgentFeedUiStateProvider sessionKey="s1">
        <Row rowKey="msg:u1" label="row" />
      </AgentFeedUiStateProvider>,
    );
    expect(view.getByTestId("row").getAttribute("data-disclosed")).toBe("open");

    // A REAL session switch — fresh store, everything default again.
    view.rerender(
      <AgentFeedUiStateProvider sessionKey="s2">
        <Row rowKey="msg:u1" label="row" />
      </AgentFeedUiStateProvider>,
    );
    expect(view.getByTestId("row").getAttribute("data-disclosed")).toBe("closed");
    view.unmount();
  });

  it("the store drops empty entries, ignores no-op patches, and restores rows on reset notifications", () => {
    const store = createAgentFeedUiStateStore();
    store.setRowState("k", { disclosed: true });
    expect(store.getRowState("k")).toEqual({ disclosed: true });

    // A no-op patch must not notify (a listener-driven rerender would be
    // wasted work) — pin by subscription firing count.
    let fired = 0;
    const unsubscribe = store.subscribeRow("k", () => {
      fired += 1;
    });
    store.setRowState("k", { disclosed: true });
    expect(fired).toBe(0);

    // Clearing the last field removes the entry entirely.
    store.setRowState("k", { disclosed: undefined });
    expect(store.getRowState("k")).toBeUndefined();
    expect(fired).toBe(1);
    unsubscribe();

    // reset() notifies every affected row (a remounted row re-reads the
    // cleared state through its own subscription).
    store.setRowState("k2", { draft: "d" });
    let k2Fired = 0;
    const off = store.subscribeRow("k2", () => {
      k2Fired += 1;
    });
    store.reset();
    expect(store.getRowState("k2")).toBeUndefined();
    expect(k2Fired).toBe(1);
    off();
  });

  it("the hook outside a provider throws (explicit misuse, never silent)", () => {
    expect(() => render(<Row rowKey="k" label="row" />)).toThrow(
      "useAgentFeedUiStateStore requires AgentFeedUiStateProvider",
    );
  });
});
