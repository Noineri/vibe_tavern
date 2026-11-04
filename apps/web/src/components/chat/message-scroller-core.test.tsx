import { beforeAll, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// AFP-2 (AGENT_FEED_PERFORMANCE_PLAN Wave 1 step 2): the store-free core's
// contract. These pins render the core with NO RP store, provider or seam
// setup — the module graph must stand alone (the adapter owns every store
// read). The RP/co-author wrapper's own behavior is pinned by the unchanged
// scroll-rail suite rendering `MessageScroller` end-to-end; the scroll
// invariant itself lives in the use-stick-to-bottom suite.

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let act: typeof import("@testing-library/react").act;
let MessageScrollerCore: typeof import("./message-scroller-core.js").MessageScrollerCore;

beforeAll(async () => {
  ({ render, fireEvent, act } = await import("@testing-library/react"));
  ({ MessageScrollerCore } = await import("./message-scroller-core.js"));
});

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `m${index}`);
}

/** Fake tall-content geometry on the Virtuoso scroller (happy-dom has no
 *  layout) — the same trick the scroll-rail suite uses. */
function fakeTallGeometry(view: ReturnType<typeof render>): HTMLElement {
  const scroller = view.container.querySelector<HTMLElement>("[data-virtuoso-scroller]")!;
  expect(scroller).not.toBeNull();
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 2000 },
  });
  return scroller;
}

/** Detach the pinned view the way a real reader does (wheel intent + scroll). */
function detach(view: ReturnType<typeof render>, scroller: HTMLElement): void {
  fireEvent.wheel(scroller, { deltaY: -100 });
  scroller.scrollTop = 100;
  fireEvent.scroll(scroller);
}

describe("MessageScrollerCore", () => {
  it("renders rows through the stable tail with stable-id wrappers, no chrome without slots", () => {
    const view = render(
      <MessageScrollerCore
        resetKey="t"
        displayIds={ids(3)}
        renderItem={(_index, messageId) => <div>row {messageId}</div>}
      />,
    );

    // All three ids are short-list stable-tail rows: mounted, each wrapped in
    // its stable-id element (the jump math's and prepend anchor's address).
    const rows = view.container.querySelectorAll("[data-scroller-message-id]");
    expect(Array.from(rows).map((row) => row.getAttribute("data-scroller-message-id"))).toEqual(["m0", "m1", "m2"]);
    expect(rows[0]!.textContent).toBe("row m0");
    // The virtualizer's own scroller element exists (one real viewport).
    expect(view.container.querySelector("[data-virtuoso-scroller]")).not.toBeNull();
    expect(view.container.querySelector("[data-message-stable-tail]")).not.toBeNull();
    // No jump affordance without the slot — the feed owns that chrome.
    expect(view.container.querySelector("button")).toBeNull();
  });

  it("renderJumpToBottom surfaces on detach, re-pins on click, and hides again", () => {
    const view = render(
      <MessageScrollerCore
        resetKey="t"
        displayIds={ids(1)}
        renderItem={(_index, messageId) => <div>row {messageId}</div>}
        renderJumpToBottom={(scrollToBottom) => (
          <button type="button" data-testid="core-jump" onClick={scrollToBottom}>jump</button>
        )}
      />,
    );
    expect(view.queryByTestId("core-jump")).toBeNull();

    const scroller = fakeTallGeometry(view);
    detach(view, scroller);
    const jump = view.getByTestId("core-jump");

    fireEvent.click(jump);
    expect(scroller.scrollTop).toBe(1600);
    expect(view.queryByTestId("core-jump")).toBeNull();
  });

  it("a resetKey change re-pins a detached reader to the bottom", () => {
    const content = (resetKey: string) => (
      <MessageScrollerCore
        resetKey={resetKey}
        displayIds={ids(1)}
        renderItem={(_index, messageId) => <div>row {messageId}</div>}
        renderJumpToBottom={(scrollToBottom) => (
          <button type="button" data-testid="core-jump" onClick={scrollToBottom}>jump</button>
        )}
      />
    );
    const view = render(content("t1"));
    const scroller = fakeTallGeometry(view);
    detach(view, scroller);
    expect(view.getByTestId("core-jump")).toBeDefined();

    view.rerender(content("t2"));
    expect(scroller.scrollTop).toBe(1600);
    expect(view.queryByTestId("core-jump")).toBeNull();
  });

  it("overlay and wrap slots receive the full navigation api; wrap encloses the virtualizer", () => {
    const apis: unknown[] = [];
    const view = render(
      <MessageScrollerCore
        resetKey="t"
        displayIds={ids(2)}
        renderItem={(_index, messageId) => <div>row {messageId}</div>}
        wrap={(scroller, api) => {
          apis.push(api);
          return <div data-testid="core-wrap">{scroller}</div>;
        }}
        overlay={(api) => {
          apis.push(api);
          return <div data-testid="core-overlay" data-pinned={String(api.pinned)} />;
        }}
      />,
    );

    // The wrap encloses the virtualizer (context providers reach the rows).
    const wrap = view.getByTestId("core-wrap");
    expect(wrap.contains(view.container.querySelector("[data-virtuoso-scroller]"))).toBe(true);
    // The overlay renders after the wrapped scroller with the api's pin state.
    expect(view.getByTestId("core-overlay").getAttribute("data-pinned")).toBe("true");

    // The api contract: every documented member present, callable, and
    // identically shaped across slots (AFP-3/AFP-5 adapters consume these).
    // The scroller element attaches AFTER the first commit — only the last
    // captured api (post-attach re-render) carries it.
    for (const api of apis) {
      const member = api as Record<string, unknown>;
      expect(typeof member.scrollToBottom).toBe("function");
      expect(typeof member.revealStart).toBe("function");
      expect(typeof member.beginExplicitNavigation).toBe("function");
      expect(typeof member.beginPrependAnchor).toBe("function");
      expect(typeof member.scrollToItem).toBe("function");
      expect(typeof member.pinned).toBe("boolean");
      expect(typeof member.stableTailStartIndex).toBe("number");
    }
    const last = apis.at(-1) as Record<string, unknown>;
    expect(last.scrollerElement).toBeInstanceOf(HTMLElement);
  });

  it("firstItemIndex shifts virtualized and stable-tail indexes uniformly off array positions", async () => {
    const displayIds = ids(150); // 60 virtualized + 90 stable tail at the default partition
    const seen = new Map<string, number>();
    const view = render(
      <MessageScrollerCore
        resetKey="t"
        firstItemIndex={1000}
        displayIds={displayIds}
        renderItem={(index, messageId) => {
          seen.set(messageId, index);
          return <div>row {messageId}</div>;
        }}
      />,
    );

    // Drive the viewport to the virtualized head so the prefix range renders
    // under the zero-height happy-dom window, then let the pipeline settle.
    const scroller = fakeTallGeometry(view);
    fireEvent.wheel(scroller, { deltaY: -100 });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await act(async () => {});

    // Every rendered row — here the whole stable tail (m60..m149), the only
    // region happy-dom can mount — reports the SAME shifted space:
    // index = firstItemIndex + array position. The virtualized prefix never
    // enters Virtuoso's render range without real layout (probed: zero-height
    // items keep the range on the tail), so the prefix-side shift is pinned
    // at the seam that consumes it — the jump suite's stub-virtualizer test
    // asserts scrollIntoView receives virtualIndexBase + array index — and
    // live in Wave 4's integrated checks.
    expect(seen.size).toBeGreaterThan(0);
    for (const [messageId, index] of seen) {
      const arrayPosition = Number(messageId.slice(1));
      expect(index).toBe(1000 + arrayPosition);
    }
    // The seam row: the FIRST stable-tail row carries the boundary index
    // (firstItemIndex + stableTailStartIndex), and the last tail row the far
    // end — the core's own arithmetic, not Virtuoso's.
    expect(seen.get("m60")).toBe(1060);
    expect(seen.get("m149")).toBe(1149);
  });

  // NOTE (AFP-2): `onStartReached` is threaded to Virtuoso's `startReached`
  // at the type level (the prop is part of the core contract), but its
  // RUNTIME firing cannot be honestly pinned under happy-dom — Virtuoso's
  // range pipeline needs real layout to register "the start is in view".
  // The load-older trigger is exercised live in Wave 4's integrated checks
  // and the owner's checklist; do not fake it with a synthetic call here.
});
