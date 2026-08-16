import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useCallback } from "react";
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
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
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
}

function Harness({ metrics, resetKey }: HarnessProps) {
  const { scrollerRef, stableTailRef, pinned, scrollToBottom } = useStickToBottom(resetKey);
  const attachScroller = useCallback((node: HTMLDivElement | null) => {
    if (node) {
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
      </div>
      <output data-testid="pinned">{String(pinned)}</output>
      <button type="button" onClick={scrollToBottom}>bottom</button>
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
});
