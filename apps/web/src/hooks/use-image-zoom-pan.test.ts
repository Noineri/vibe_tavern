/**
 * useImageZoomPan — characterization + crash-regression tests.
 *
 * The CRASH test pins the v1.2.1 mobile defect D5: the translate updater
 * queued by touchMove read `lastTouchCenter.current` at RENDER time, but
 * touchEnd nulls that ref — on a real device's high-frequency touch stream a
 * touchend can land between the queue and the commit, so the updater executed
 * `null!.x` and threw during render; with no root ErrorBoundary the whole
 * tree unmounted (blank themed page until reload). The updater must be pure
 * over queue-time captured values.
 *
 * The other tests pin the load-bearing gesture behavior the hook must keep:
 * pinch scale ratio, pan-by-center-delta, and double-tap toggle.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import type React from "react";

useDomEnv();

let renderHook: typeof import("@testing-library/react").renderHook;
let act: typeof import("@testing-library/react").act;
let useImageZoomPan: typeof import("./use-image-zoom-pan.js").useImageZoomPan;

beforeAll(async () => {
  ({ renderHook, act } = await import("@testing-library/react"));
  ({ useImageZoomPan } = await import("./use-image-zoom-pan.js"));
});

/** Two-finger touch event at the given client coordinates. */
function touch2(x1: number, y1: number, x2: number, y2: number): React.TouchEvent {
  return {
    touches: [
      { clientX: x1, clientY: y1 },
      { clientX: x2, clientY: y2 },
    ],
    preventDefault() {},
  } as unknown as React.TouchEvent;
}

describe("useImageZoomPan", () => {
  test("CRASH (D5): translate updater queued by touchMove must survive touchEnd nulling the refs before the commit", async () => {
    const { result } = renderHook(() => useImageZoomPan());
    // Deliberately OUTSIDE act: the updates must stay queued across touchEnd
    // (the real-device race shape). The act warning in the log is expected.
    result.current.touchHandlers.onTouchStart(touch2(0, 0, 100, 0));
    result.current.touchHandlers.onTouchMove(touch2(0, 0, 150, 0));
    // touchEnd before React commits the queued updater → refs nulled while
    // the translate closure is still pending.
    result.current.touchHandlers.onTouchEnd();
    // Flush: the OLD updater read lastTouchCenter.current!.x here → TypeError
    // during render → tree unmount. Must commit cleanly instead.
    await act(async () => {});
    expect(result.current.scale).toBeGreaterThan(1);
  });

  test("pinch: scale follows the distance ratio, translate follows the pinch center", async () => {
    const { result } = renderHook(() => useImageZoomPan());
    await act(async () => {
      result.current.touchHandlers.onTouchStart(touch2(0, 0, 100, 0));
      result.current.touchHandlers.onTouchMove(touch2(0, 0, 150, 0));
    });
    expect(result.current.scale).toBeCloseTo(1.5);
    expect(result.current.translate.x).toBeCloseTo(25);
    await act(async () => {
      result.current.touchHandlers.onTouchMove(touch2(0, 0, 200, 0));
    });
    expect(result.current.scale).toBeCloseTo(2);
    expect(result.current.translate.x).toBeCloseTo(50);
  });

  test("double-tap toggles 1 → 2.5 → 1 and resets the pan", async () => {
    const { result } = renderHook(() => useImageZoomPan());
    // Pan the image first so the reset is observable (a {0,0}→{0,0} assertion
    // would pin nothing). Monotonic fake clock: pairs of taps must be >300ms
    // apart or four quick taps read as two double-taps and toggle twice.
    let now = 1_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      await act(async () => {
        result.current.touchHandlers.onTouchStart(touch2(0, 0, 100, 0));
        result.current.touchHandlers.onTouchMove(touch2(30, 0, 130, 0));
      });
      expect(result.current.translate.x).toBeCloseTo(30);

      await act(async () => {
        result.current.handleTap();
        now += 50;
        result.current.handleTap();
      });
      expect(result.current.scale).toBe(2.5);
      expect(result.current.translate).toEqual({ x: 0, y: 0 });

      now += 400;
      await act(async () => {
        result.current.handleTap();
        now += 50;
        result.current.handleTap();
      });
      expect(result.current.scale).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

});
