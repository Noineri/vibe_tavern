import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useCallback, useRef } from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ScrollMetrics } from "../../lib/stick-to-bottom.js";
import { jumpToMessage, type MessageJumpOptions } from "./message-jump.js";

useDomEnv();

const nativeResizeObserver = globalThis.ResizeObserver;

class ControlledResizeObserver implements ResizeObserver {
  static instances: ControlledResizeObserver[] = [];

  readonly callback: ResizeObserverCallback;
  target: Element | null = null;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControlledResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.target = target;
  }

  unobserve(target: Element): void {
    if (this.target === target) this.target = null;
  }

  disconnect(): void {
    this.target = null;
  }

  notify(): void {
    this.callback([], this);
  }
}

globalThis.ResizeObserver = ControlledResizeObserver;

let useStickToBottom: typeof import("./use-stick-to-bottom.js").useStickToBottom;
let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ render, fireEvent, act } = await import("@testing-library/react"));
  ({ useStickToBottom } = await import("./use-stick-to-bottom.js"));
});

beforeEach(() => {
  globalThis.ResizeObserver = ControlledResizeObserver;
  ControlledResizeObserver.instances = [];
});

afterAll(() => {
  globalThis.ResizeObserver = nativeResizeObserver;
});

interface HarnessProps {
  metrics: ScrollMetrics;
  resetKey: string;
  suppressFollow?: boolean;
  targetOffset?: number;
  targetId?: string;
  jumpIndex?: number;
  virtualizer?: MessageJumpOptions["virtualizer"];
  /** AFP-2: the inverse-scroll index offset threaded into jumpToMessage. */
  virtualIndexBase?: number;
}

function Harness({ metrics, resetKey, suppressFollow = false, targetOffset = 200, targetId = "row-150", jumpIndex = 150, virtualizer = null, virtualIndexBase }: HarnessProps) {
  const { scrollerRef, stableTailRef, pinned, scrollToBottom, revealStart, beginExplicitNavigation, beginPrependAnchor } = useStickToBottom(resetKey, suppressFollow);
  const targetRef = useRef<HTMLDivElement>(null);
  const scrollerElement = useRef<HTMLDivElement | null>(null);
  const finishRef = useRef<(() => void) | undefined>(undefined);
  const anchorFinishRef = useRef<(() => void) | undefined>(undefined);
  const attachScroller = useCallback((node: HTMLDivElement | null) => {
    scrollerElement.current = node;
    if (node) {
      node.getBoundingClientRect = () => new DOMRect(0, 20, 320, metrics.clientHeight);
      Object.defineProperties(node, {
        scrollTop: {
          configurable: true,
          get: () => metrics.scrollTop,
          set: (value: number) => { metrics.scrollTop = value; },
        },
        scrollHeight: {
          configurable: true,
          get: () => metrics.scrollHeight,
        },
        clientHeight: {
          configurable: true,
          get: () => metrics.clientHeight,
        },
      });
    }
    scrollerRef(node);
  }, [metrics, scrollerRef]);

  return (
    <>
      <div ref={attachScroller} data-testid="scroller">
        <div ref={stableTailRef} data-testid="stable-tail" />
        <div ref={(node) => {
          targetRef.current = node;
          if (node) node.getBoundingClientRect = () => new DOMRect(0, 20 + targetOffset - metrics.scrollTop, 320, 200);
        }} data-testid="reading-target" data-scroller-message-id={targetId} />
      </div>
      <output data-testid="pinned">{String(pinned)}</output>
      <button type="button" onClick={scrollToBottom}>bottom</button>
      <button type="button" onClick={() => { if (targetRef.current) finishRef.current = revealStart(targetRef.current); }}>reveal</button>
      <button type="button" onClick={() => finishRef.current?.()}>finish</button>
      <button type="button" onClick={() => { finishRef.current = beginExplicitNavigation(); }}>jump</button>
      <button type="button" onClick={() => { anchorFinishRef.current = beginPrependAnchor(); }}>anchor</button>
      <button type="button" onClick={() => anchorFinishRef.current?.()}>anchor-restore</button>
      <button type="button" onClick={() => jumpToMessage({
        index: jumpIndex, displayIds: Array.from({ length: 200 }, (_, i) => `row-${i}`),
        stableTailStartIndex: 100, scroller: scrollerElement.current, virtualizer, beginExplicitNavigation,
        ...(virtualIndexBase !== undefined ? { virtualIndexBase } : {}),
      })}>jump-row</button>
    </>
  );
}

function observerFor(testId: string): ControlledResizeObserver {
  const observer = ControlledResizeObserver.instances.find(
    (candidate) => candidate.target?.getAttribute("data-testid") === testId,
  );
  if (!observer) throw new Error(`No ResizeObserver found for ${testId}`);
  return observer;
}

describe("useStickToBottom", () => {
  it.each(["wheel", "touch", "keyboard", "pointer"] as const)("releases on the first 1px %s frame and retains continuous reading through layout and growth", (input) => {
    const metrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="release" />);
    const viewport = view.getByTestId("scroller");
    if (input === "wheel") fireEvent.wheel(viewport, { deltaY: -12 });
    if (input === "touch") fireEvent.touchMove(viewport);
    if (input === "keyboard") fireEvent.keyDown(viewport, { key: "ArrowUp" });
    if (input === "pointer") fireEvent.pointerDown(viewport, { button: 0 });
    // A no-movement frame must not consume a held drag/gesture.
    fireEvent.scroll(viewport);
    metrics.scrollTop = 599;
    fireEvent.scroll(viewport);
    expect(view.getByTestId("pinned").textContent).toBe("false");
    act(() => observerFor("stable-tail").notify());
    expect(metrics.scrollTop).toBe(599);
    metrics.scrollTop = 590;
    fireEvent.scroll(viewport);
    metrics.scrollHeight = 1200;
    act(() => observerFor("stable-tail").notify());
    expect(metrics.scrollTop).toBe(590);
    expect(view.getByTestId("pinned").textContent).toBe("false");
    // Continuation toward the bottom reclaims the existing geometry policy.
    metrics.scrollTop = 799;
    fireEvent.scroll(viewport);
    expect(view.getByTestId("pinned").textContent).toBe("true");
    metrics.scrollHeight = 1300;
    act(() => observerFor("stable-tail").notify());
    expect(metrics.scrollTop).toBe(900);
  });

  it("bottom jump and reset revoke old gesture permission and still reject restoration", () => {
    const metrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="a" />);
    const viewport = view.getByTestId("scroller");
    fireEvent.wheel(viewport, { deltaY: -12 });
    fireEvent.click(view.getByText("bottom"));
    metrics.scrollTop = 500;
    fireEvent.scroll(viewport);
    expect(metrics.scrollTop).toBe(600);
    fireEvent.touchMove(viewport);
    view.rerender(<Harness metrics={metrics} resetKey="b" />);
    metrics.scrollTop = 599;
    fireEvent.scroll(viewport);
    expect(metrics.scrollTop).toBe(600);
  });

  it("manual input drops a stale pin when stationary geometry is already outside the bottom band", () => {
    const metrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="stale-geometry" />);
    metrics.scrollHeight = 1200;
    const viewport = view.getByTestId("scroller");
    fireEvent.wheel(viewport, { deltaY: -12 });
    fireEvent.scroll(viewport);
    expect(metrics.scrollTop).toBe(600);
    expect(view.getByTestId("pinned").textContent).toBe("false");
    act(() => observerFor("stable-tail").notify());
    expect(metrics.scrollTop).toBe(600);
  });

  it.each(["pointerUp", "pointerCancel"] as const)("a %s without displacement does not leave following suspended", (end) => {
    const metrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="no-drag" />);
    const viewport = view.getByTestId("scroller");
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 5 });
    metrics.scrollHeight = 1100;
    act(() => observerFor("stable-tail").notify());
    fireEvent[end](document, { button: 0, pointerId: 5 });
    expect(metrics.scrollTop).toBe(700);
    expect(view.getByTestId("pinned").textContent).toBe("true");
    metrics.scrollTop = 500;
    fireEvent.scroll(viewport);
    expect(metrics.scrollTop).toBe(700);
  });

  it("disconnects observers and native follow listeners on unmount", () => {
    const metrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="cleanup" />);
    const viewport = view.getByTestId("scroller");
    const observers = [...ControlledResizeObserver.instances];
    expect(observers.some((observer) => observer.target === viewport)).toBe(true);
    view.unmount();
    expect(observers.every((observer) => observer.target === null)).toBe(true);
    metrics.scrollTop = 200;
    fireEvent.scroll(viewport);
    expect(metrics.scrollTop).toBe(200);
  });

  it("tail jumps align a scoped row through the controller without the virtualizer", () => {
    const metrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="chat-1" />);
    fireEvent.click(view.getByText("jump-row"));
    expect(metrics.scrollTop).toBe(200);
    expect(view.getByTestId("pinned").textContent).toBe("false");
  });

  it("AFP-2: a virtualIndexBase shifts the index handed to the virtualizer (inverse-scroll jumps)", () => {
    // A paged feed addressing virtualized history through the shifted
    // firstItemIndex space: the stub virtualizer must receive base + array
    // index (1012), never the raw array position — the core's `scrollToItem`
    // passes exactly this translation.
    const metrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    let requestedIndex: number | undefined;
    const virtualizer: NonNullable<MessageJumpOptions["virtualizer"]> = {
      scrollIntoView(location) {
        if (typeof location === "number" || !("index" in location)) throw new Error("Expected indexed location");
        requestedIndex = location.index;
      },
    };
    const view = render(
      <Harness metrics={metrics} resetKey="chat-1" jumpIndex={12} targetId="row-12" virtualizer={virtualizer} virtualIndexBase={1000} />,
    );
    fireEvent.click(view.getByText("jump-row"));
    expect(requestedIndex).toBe(1012);
    expect(view.getByTestId("pinned").textContent).toBe("false");
  });

  it("virtualized jumps stay detached until the virtualizer completion and align on landing", () => {
    const metrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    let done: (() => void) | undefined;
    const virtualizer: NonNullable<MessageJumpOptions["virtualizer"]> = {
      scrollIntoView(location) {
        if (typeof location === "number" || !("index" in location)) throw new Error("Expected indexed location");
        expect(location.index).toBe(12);
        expect(location.behavior).toBe("auto");
        expect(location.align).toBe("start");
        done = location.done;
      },
    };
    const view = render(<Harness metrics={metrics} resetKey="chat-1" jumpIndex={12} targetId="row-12" virtualizer={virtualizer} />);
    fireEvent.click(view.getByText("jump-row"));
    expect(view.getByTestId("pinned").textContent).toBe("false");
    expect(metrics.scrollTop).toBe(600);
    metrics.scrollHeight = 1200;
    act(() => { observerFor("stable-tail").notify(); });
    expect(metrics.scrollTop).toBe(600);
    expect(done).toBeDefined();
    act(() => { done!(); });
    expect(metrics.scrollTop).toBe(200);
    expect(view.getByTestId("pinned").textContent).toBe("false");
    fireEvent.click(view.getByText("jump-row"));
    fireEvent.wheel(view.getByTestId("scroller"), { deltaY: -100 });
    metrics.scrollTop = 350;
    fireEvent.scroll(view.getByTestId("scroller"));
    act(() => { done!(); });
    expect(metrics.scrollTop).toBe(350);
  });

  it("explicit jumps stay detached through layout and settle at the real position", () => {
    const metrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="chat-1" />);
    fireEvent.click(view.getByText("jump"));
    expect(view.getByTestId("pinned").textContent).toBe("false");
    metrics.scrollTop = 600;
    act(() => { observerFor("stable-tail").notify(); });
    fireEvent.scroll(view.getByTestId("scroller"));
    expect(view.getByTestId("pinned").textContent).toBe("false");
    metrics.scrollTop = 200;
    fireEvent.click(view.getByText("finish"));
    expect(view.getByTestId("pinned").textContent).toBe("false");
    fireEvent.click(view.getByText("jump"));
    metrics.scrollTop = 600;
    fireEvent.click(view.getByText("finish"));
    expect(view.getByTestId("pinned").textContent).toBe("true");
    metrics.scrollHeight = 1200;
    act(() => { observerFor("stable-tail").notify(); });
    expect(metrics.scrollTop).toBe(800);
  });

  it("bottom navigation and reset invalidate pending jump completions", () => {
    const metrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="chat-1" />);
    fireEvent.click(view.getByText("jump"));
    fireEvent.click(view.getByText("bottom"));
    fireEvent.click(view.getByText("finish"));
    expect(view.getByTestId("pinned").textContent).toBe("true");
    fireEvent.click(view.getByText("jump"));
    view.rerender(<Harness metrics={metrics} resetKey="chat-2" />);
    fireEvent.click(view.getByText("finish"));
    expect(metrics.scrollTop).toBe(600);
    expect(view.getByTestId("pinned").textContent).toBe("true");
  });

  it("reveals a variant start and rejects bottom-follow throughout its height transition", () => {
    const metrics: ScrollMetrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="chat-1" />);
    fireEvent.click(view.getByText("reveal"));
    expect(metrics.scrollTop).toBe(200);
    expect(view.getByTestId("pinned").textContent).toBe("false");
    metrics.scrollHeight = 1600;
    act(() => { observerFor("stable-tail").notify(); });
    fireEvent.scroll(view.getByTestId("scroller"));
    expect(metrics.scrollTop).toBe(200);
    fireEvent.click(view.getByText("finish"));
    expect(view.getByTestId("pinned").textContent).toBe("false");
  });

  it("does not move an already visible start when a short variant grows into a long one", () => {
    const metrics: ScrollMetrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="chat-1" targetOffset={800} />);
    fireEvent.click(view.getByText("reveal"));
    expect(metrics.scrollTop).toBe(600);
    metrics.scrollHeight = 1800;
    act(() => { observerFor("stable-tail").notify(); });
    fireEvent.click(view.getByText("finish"));
    expect(metrics.scrollTop).toBe(600);
    expect(view.getByTestId("pinned").textContent).toBe("false");
  });

  it("reconciles the real pin after landing on a short variant and follows later growth normally", () => {
    const metrics: ScrollMetrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="chat-1" />);
    fireEvent.click(view.getByText("reveal"));
    metrics.scrollHeight = 600;
    act(() => { observerFor("stable-tail").notify(); });
    expect(view.getByTestId("pinned").textContent).toBe("false");
    fireEvent.click(view.getByText("finish"));
    expect(view.getByTestId("pinned").textContent).toBe("true");
    metrics.scrollHeight = 1000;
    act(() => { observerFor("stable-tail").notify(); });
    expect(metrics.scrollTop).toBe(600);
  });

  it("new user intent or a chat reset cancels an old navigation completion", () => {
    const metrics: ScrollMetrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="chat-1" />);
    fireEvent.click(view.getByText("reveal"));
    fireEvent.wheel(view.getByTestId("scroller"), { deltaY: -100 });
    metrics.scrollTop = 350;
    fireEvent.scroll(view.getByTestId("scroller"));
    fireEvent.click(view.getByText("finish"));
    expect(metrics.scrollTop).toBe(350);
    fireEvent.click(view.getByText("reveal"));
    view.rerender(<Harness metrics={metrics} resetKey="chat-2" />);
    fireEvent.click(view.getByText("finish"));
    expect(metrics.scrollTop).toBe(600);
    expect(view.getByTestId("pinned").textContent).toBe("true");
  });

  it("follows content growth only while pinned", () => {
    const metrics: ScrollMetrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const { getByTestId } = render(<Harness metrics={metrics} resetKey="chat-1:branch-1" />);
    const scroller = getByTestId("scroller");

    expect(metrics.scrollTop).toBe(600);
    metrics.scrollHeight = 1200;
    observerFor("stable-tail").notify();
    expect(metrics.scrollTop).toBe(800);

    fireEvent.wheel(scroller, { deltaY: -200 });
    metrics.scrollTop = 300;
    fireEvent.scroll(scroller);
    expect(getByTestId("pinned").textContent).toBe("false");

    metrics.scrollHeight = 1400;
    observerFor("stable-tail").notify();
    expect(metrics.scrollTop).toBe(300);
  });

  it("re-pins on explicit bottom navigation and list reset", () => {
    const metrics: ScrollMetrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const { getByTestId, getByText, rerender } = render(
      <Harness metrics={metrics} resetKey="chat-1:branch-1" />,
    );
    const scroller = getByTestId("scroller");

    fireEvent.wheel(scroller, { deltaY: -200 });
    metrics.scrollTop = 200;
    fireEvent.scroll(scroller);
    expect(getByTestId("pinned").textContent).toBe("false");

    fireEvent.click(getByText("bottom"));
    expect(metrics.scrollTop).toBe(600);
    expect(getByTestId("pinned").textContent).toBe("true");

    fireEvent.wheel(scroller, { deltaY: -200 });
    metrics.scrollTop = 100;
    fireEvent.scroll(scroller);
    metrics.scrollHeight = 1600;
    rerender(<Harness metrics={metrics} resetKey="chat-2:branch-9" />);
    expect(metrics.scrollTop).toBe(1200);
    expect(getByTestId("pinned").textContent).toBe("true");
  });

  it("keeps the bottom across viewport resizes without moving detached readers", () => {
    const metrics: ScrollMetrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const { getByTestId } = render(<Harness metrics={metrics} resetKey="chat-1:branch-1" />);
    const scroller = getByTestId("scroller");

    metrics.clientHeight = 300;
    observerFor("scroller").notify();
    expect(metrics.scrollTop).toBe(700);

    fireEvent.wheel(scroller, { deltaY: -200 });
    metrics.scrollTop = 200;
    fireEvent.scroll(scroller);
    metrics.clientHeight = 250;
    observerFor("scroller").notify();
    expect(metrics.scrollTop).toBe(200);
    expect(getByTestId("pinned").textContent).toBe("false");
  });

  it("rejects a browser-restored intermediate scroll position until the user scrolls", () => {
    const metrics: ScrollMetrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const { getByTestId } = render(<Harness metrics={metrics} resetKey="chat-1:branch-1" />);
    const scroller = getByTestId("scroller");

    fireEvent.wheel(scroller, { deltaY: 200 });
    metrics.scrollTop = 180;
    fireEvent.scroll(scroller);
    expect(metrics.scrollTop).toBe(600);
    expect(getByTestId("pinned").textContent).toBe("true");

    fireEvent.wheel(scroller, { deltaY: -200 });
    metrics.scrollTop = 250;
    fireEvent.scroll(scroller);
    expect(metrics.scrollTop).toBe(250);
    expect(getByTestId("pinned").textContent).toBe("false");
  });

  it("IF-4b follow-up: suppressFollow leaves a pinned reader in place and drops the pin when the bottom leaves reach", () => {
    const metrics: ScrollMetrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    const { getByTestId, getByText, rerender } = render(
      <Harness metrics={metrics} resetKey="chat-1:branch-1" suppressFollow />,
    );
    expect(metrics.scrollTop).toBe(600);
    expect(getByTestId("pinned").textContent).toBe("true");

    // Suppressed growth: the position must NOT follow the new bottom. The
    // notify fires the reconcile outside React's act scope — wrap it so the
    // pin state settles before the read.
    metrics.scrollHeight = 1200;
    act(() => { observerFor("stable-tail").notify(); });
    expect(metrics.scrollTop).toBe(600);
    // The bottom is now 800 — out of reach → the pin drops (the "to the
    // end" button surfaces instead of a yank).
    expect(getByTestId("pinned").textContent).toBe("false");

    // Unsuspended: the next growth follows the bottom again once re-pinned.
    rerender(<Harness metrics={metrics} resetKey="chat-1:branch-1" />);
    fireEvent.click(getByText("bottom"));
    metrics.scrollHeight = 1400;
    act(() => { observerFor("stable-tail").notify(); });
    expect(metrics.scrollTop).toBe(1000);
  });

  // ─── AFP-2: the prepend anchor (paged history loading above a reader) ───

  it("a prepend anchor restores the first visible row's offset without claiming the pin", () => {
    const metrics = { scrollTop: 300, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="chat-1:branch-1" targetOffset={200} />);

    // A detached reader: their visual anchor row sits partially above the fold
    // (viewport top 20, row top -80 — the first row whose bottom is visible).
    fireEvent.wheel(view.getByTestId("scroller"), { deltaY: -100 });
    metrics.scrollTop = 300;
    fireEvent.scroll(view.getByTestId("scroller"));
    expect(view.getByTestId("pinned").textContent).toBe("false");

    // The paged feed captures the anchor, then older history lands ABOVE:
    // the row moves 500px down visually and the content grows by 500.
    fireEvent.click(view.getByText("anchor"));
    metrics.scrollHeight = 1500;
    view.rerender(<Harness metrics={metrics} resetKey="chat-1:branch-1" targetOffset={700} />);
    expect(metrics.scrollTop).toBe(300);

    // The restore realigns the captured row to its captured viewport offset
    // (+500) — without following the new bottom (1100) or flipping the pin.
    fireEvent.click(view.getByText("anchor-restore"));
    expect(metrics.scrollTop).toBe(800);
    expect(view.getByTestId("pinned").textContent).toBe("false");
  });

  it("user scroll intent after the capture cancels the pending anchor", () => {
    const metrics = { scrollTop: 300, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="chat-1:branch-1" targetOffset={200} />);
    fireEvent.wheel(view.getByTestId("scroller"), { deltaY: -100 });
    metrics.scrollTop = 350;
    fireEvent.scroll(view.getByTestId("scroller"));
    expect(view.getByTestId("pinned").textContent).toBe("false");

    fireEvent.click(view.getByText("anchor"));
    // The reader scrolls again after the capture — their newer intent wins.
    metrics.scrollHeight = 1500;
    metrics.scrollTop = 350;
    view.rerender(<Harness metrics={metrics} resetKey="chat-1:branch-1" targetOffset={700} />);
    fireEvent.wheel(view.getByTestId("scroller"), { deltaY: -100 });
    fireEvent.scroll(view.getByTestId("scroller"));
    fireEvent.click(view.getByText("anchor-restore"));
    expect(metrics.scrollTop).toBe(350);
  });

  it("an anchor whose row left the loaded range leaves the position alone", () => {
    const metrics = { scrollTop: 300, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="chat-1:branch-1" targetOffset={200} targetId="row-150" />);
    fireEvent.wheel(view.getByTestId("scroller"), { deltaY: -100 });
    metrics.scrollTop = 300;
    fireEvent.scroll(view.getByTestId("scroller"));
    expect(view.getByTestId("pinned").textContent).toBe("false");

    fireEvent.click(view.getByText("anchor"));
    // The captured row unmounted (history window moved on); a different row
    // now carries the slot's id attribute.
    metrics.scrollHeight = 1500;
    view.rerender(<Harness metrics={metrics} resetKey="chat-1:branch-1" targetOffset={700} targetId="row-40" />);
    fireEvent.click(view.getByText("anchor-restore"));
    expect(metrics.scrollTop).toBe(300);
  });

  it("a reset key change drops a pending anchor along with the rest of the navigation state", () => {
    const metrics = { scrollTop: 300, scrollHeight: 1000, clientHeight: 400 };
    const view = render(<Harness metrics={metrics} resetKey="chat-1:branch-1" targetOffset={200} />);
    fireEvent.wheel(view.getByTestId("scroller"), { deltaY: -100 });
    metrics.scrollTop = 300;
    fireEvent.scroll(view.getByTestId("scroller"));
    expect(view.getByTestId("pinned").textContent).toBe("false");

    fireEvent.click(view.getByText("anchor"));
    metrics.scrollHeight = 1500;
    view.rerender(<Harness metrics={metrics} resetKey="chat-2:branch-1" targetOffset={700} />);
    // The reset re-pins to the new bottom; the stale anchor restore no-ops.
    expect(metrics.scrollTop).toBe(1100);
    fireEvent.click(view.getByText("anchor-restore"));
    expect(metrics.scrollTop).toBe(1100);
    expect(view.getByTestId("pinned").textContent).toBe("true");
  });
});
