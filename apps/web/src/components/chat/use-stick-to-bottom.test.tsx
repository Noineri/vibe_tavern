import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useCallback, useRef } from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ScrollMetrics } from "../../lib/stick-to-bottom.js";

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
}

function Harness({ metrics, resetKey, suppressFollow = false, targetOffset = 200 }: HarnessProps) {
  const { scrollerRef, stableTailRef, pinned, scrollToBottom, revealStart } = useStickToBottom(resetKey, suppressFollow);
  const targetRef = useRef<HTMLDivElement>(null);
  const finishRef = useRef<(() => void) | undefined>(undefined);
  const attachScroller = useCallback((node: HTMLDivElement | null) => {
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
        }} data-testid="reading-target" />
      </div>
      <output data-testid="pinned">{String(pinned)}</output>
      <button type="button" onClick={scrollToBottom}>bottom</button>
      <button type="button" onClick={() => { if (targetRef.current) finishRef.current = revealStart(targetRef.current); }}>reveal</button>
      <button type="button" onClick={() => finishRef.current?.()}>finish</button>
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
});
