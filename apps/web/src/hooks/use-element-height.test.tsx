/** useElementHeight pins (MUI step 14).
 *
 * The hook feeds the chat add-on launcher bar's height into the message
 * scroller's bottom clearance. Pinned: the initial synchronous measure, the
 * ResizeObserver-driven updates (chips appearing/disappearing resize the bar),
 * and the observer teardown on unmount. ResizeObserver is mocked at the
 * globalThis level (happy-dom's own RO never fires layout callbacks; the same
 * approach use-stick-to-bottom.test.tsx takes).
 */
import { describe, expect, it } from "bun:test";
import React from "react";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

let hookHeight = -1;

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  static teardowns = 0;
  callback: () => void;
  observed: Element | null = null;
  constructor(callback: () => void) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed = el;
  }
  disconnect() {
    MockResizeObserver.teardowns += 1;
  }
}

function Probe() {
  const [ref, height] = useElementHeightProbe();
  hookHeight = height;
  return <div ref={ref} data-testid="probe" />;
}

// Import after the env is up; mock must be in place before the effect runs.
const { useElementHeight } = await import("./use-element-height.js");
function useElementHeightProbe(): [React.RefObject<HTMLDivElement | null>, number] {
  return useElementHeight<HTMLDivElement>();
}

describe("useElementHeight", () => {
  it("measures synchronously on mount, follows ResizeObserver callbacks, tears down on unmount", async () => {
    const originalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    const { render, cleanup, act } = await import("@testing-library/react");

    const { getByTestId, unmount } = render(<Probe />);
    const probe = getByTestId("probe") as HTMLDivElement;
    // Initial synchronous measure: happy-dom reports offsetHeight 0 — the
    // contract is "0 until real layout says otherwise".
    expect(hookHeight).toBe(0);
    expect(MockResizeObserver.instances.length).toBe(1);
    expect(MockResizeObserver.instances[0]?.observed).toBe(probe);

    // Simulate the bar growing (chips appeared): offsetHeight changes and the
    // RO callback fires.
    Object.defineProperty(probe, "offsetHeight", { value: 42, configurable: true });
    await act(async () => {
      MockResizeObserver.instances[0]?.callback();
    });
    expect(hookHeight).toBe(42);

    // Shrink (chips disappeared) → 0 clearance again.
    Object.defineProperty(probe, "offsetHeight", { value: 0, configurable: true });
    await act(async () => {
      MockResizeObserver.instances[0]?.callback();
    });
    expect(hookHeight).toBe(0);

    const teardownsBefore = MockResizeObserver.teardowns;
    unmount();
    expect(MockResizeObserver.teardowns).toBe(teardownsBefore + 1);
    cleanup();
    globalThis.ResizeObserver = originalRO;
  });
});
