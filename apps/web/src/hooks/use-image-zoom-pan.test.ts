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
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import { inertView } from "../../test/react-event-seam.js";
import type React from "react";

useDomEnv();
const realNow = Date.now;
beforeEach(() => { Date.now = realNow; });
afterAll(() => { Date.now = realNow; });

let renderHook: typeof import("@testing-library/react").renderHook;
let act: typeof import("@testing-library/react").act;
let useImageZoomPan: typeof import("./use-image-zoom-pan.js").useImageZoomPan;

beforeAll(async () => {
  ({ renderHook, act } = await import("@testing-library/react"));
  ({ useImageZoomPan } = await import("./use-image-zoom-pan.js"));
});

// ── Member-for-member React TouchEvent doubles (step 8b) ───────────────────
// The hook reads only `event.touches` (length + clientX/clientY), so the
// Touch points are member-for-member inert Touch rows (a real target from the
// happy-dom document) and the event carries the FULL required TouchEvent
// member set with inert defaults — the compiler checks the member set here.

function touchRow(point: { clientX: number; clientY: number }): Touch {
  return {
    identifier: 0,
    target: document.body,
    clientX: point.clientX,
    clientY: point.clientY,
    screenX: point.clientX,
    screenY: point.clientY,
    pageX: point.clientX,
    pageY: point.clientY,
    radiusX: 0,
    radiusY: 0,
    rotationAngle: 0,
    force: 0,
  };
}

/** The touch-list double: an array carries `length` + the numeric indexer +
 *  `[Symbol.iterator]` (both the React and the native TouchList shapes), with
 *  the two named accessors on top — `item` returning `Touch` satisfies React's
 *  non-null view and the native's nullable one alike. */
function touchListDouble(
	points: Array<{ clientX: number; clientY: number }>,
): TouchList & { item(index: number): Touch; identifiedTouch(identifier: number): Touch } {
	const row = (index: number): Touch =>
		touchRow(points[Math.max(0, Math.min(index, points.length - 1))] ?? { clientX: 0, clientY: 0 });
	return Object.assign(points.map(touchRow), {
		item: (index: number) => row(index),
		identifiedTouch: (identifier: number) => row(identifier),
	});
}

function touchEvent(touches: Array<{ clientX: number; clientY: number }>): React.TouchEvent {
  const list = touchListDouble(touches);
  return {
    // The NATIVE touch event is a member-for-member inert double over a real
    // Event base (happy-dom ships no TouchEvent constructor) — the hook reads
    // only the SYNTHETIC's touches, never the native one.
    nativeEvent: Object.assign(new Event("touchmove"), {
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      touches: list,
      targetTouches: list,
      changedTouches: list,
      detail: 0,
      view: window,
      which: 0,
      initUIEvent: () => {},
    }),
    currentTarget: document.createElement("div"),
    target: document.body,
    bubbles: false,
    cancelable: true,
    defaultPrevented: false,
    eventPhase: 0,
    isTrusted: false,
    preventDefault() {},
    isDefaultPrevented: () => false,
    stopPropagation() {},
    isPropagationStopped: () => false,
    persist() {},
    timeStamp: 0,
    type: "touchmove",
    detail: 0,
    view: inertView(),
    touches: list,
    targetTouches: list,
    changedTouches: list,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    getModifierState: () => false,
  };
}

/** Two-finger touch event at the given client coordinates. */
function touch2(x1: number, y1: number, x2: number, y2: number): React.TouchEvent {
  return touchEvent([
    { clientX: x1, clientY: y1 },
    { clientX: x2, clientY: y2 },
  ]);
}

/** Single-finger touch event. */
function touch1(x: number, y: number): React.TouchEvent {
  return touchEvent([{ clientX: x, clientY: y }]);
}

/** touchend/touchcancel with the given still-on-screen fingers. */
function touchEnd(remaining: Array<{ clientX: number; clientY: number }>): React.TouchEvent {
  return touchEvent(remaining);
}

/** Explicit fitted geometry, centered at (50, 0), with no global layout patch. */
function mountZoom() {
  const view = renderHook(() => useImageZoomPan());
  const container = document.createElement("div");
  container.getBoundingClientRect = () => new DOMRect(-50, -100, 200, 200);
  const image = document.createElement("img");
  Object.defineProperties(image, { offsetWidth: { value: 200 }, offsetHeight: { value: 200 } });
  view.result.current.containerRef.current = container;
  view.result.current.imageRef.current = image;
  return view;
}

describe("useImageZoomPan", () => {
  test("CRASH (D5): translate updater queued by touchMove must survive touchEnd nulling the refs before the commit", async () => {
    const { result } = mountZoom();
    // Deliberately OUTSIDE act: the updates must stay queued across touchEnd
    // (the real-device race shape). The act warning in the log is expected.
    result.current.touchHandlers.onTouchStart(touch2(0, 0, 100, 0));
    result.current.touchHandlers.onTouchMove(touch2(0, 0, 150, 0));
    // touchEnd before React commits the queued updater → refs nulled while
    // the translate closure is still pending.
    result.current.touchHandlers.onTouchEnd(touchEnd([]));
    // Flush: the OLD updater read lastTouchCenter.current!.x here → TypeError
    // during render → tree unmount. Must commit cleanly instead.
    await act(async () => {});
    expect(result.current.scale).toBeGreaterThan(1);
  });

  test("pinch: scale follows the distance ratio, translate follows the pinch center", async () => {
    const { result } = mountZoom();
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
    const { result } = mountZoom();
    // Pan the zoomed image so the reset is observable. Monotonic fake clock:
    // pairs of taps must be >300ms
    // apart or four quick taps read as two double-taps and toggle twice.
    let now = 1_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      await act(async () => {
        result.current.handleTap();
        now += 50;
        result.current.handleTap();
      });
      expect(result.current.scale).toBe(2.5);
      expect(result.current.translate).toEqual({ x: 0, y: 0 });

      // A fitted image can no longer pan at 1x. Make the reset observable by
      // panning the zoomed image instead, preserving the same toggle boundary.
      await act(async () => {
        result.current.touchHandlers.onTouchStart(touch1(50, 0));
        result.current.touchHandlers.onTouchMove(touch1(80, 0));
      });
      expect(result.current.translate.x).toBeCloseTo(30);

      now += 400;
      await act(async () => {
        result.current.handleTap();
        now += 50;
        result.current.handleTap();
      });
      expect(result.current.scale).toBe(1);
      expect(result.current.translate).toEqual({ x: 0, y: 0 });
    } finally {
      Date.now = realNow;
    }
  });

  test("single-finger move while zoomed in pans the image, incl. the 2→1 pinch handoff (D5b)", async () => {
    const { result } = mountZoom();
    // Zoom in via a SYMMETRIC pinch (spread around a fixed center): 1 → 2
    // with translate unchanged, so the pan assertions below are pure pan.
    await act(async () => {
      result.current.touchHandlers.onTouchStart(touch2(0, 0, 100, 0));
      result.current.touchHandlers.onTouchMove(touch2(-50, 0, 150, 0));
    });
    expect(result.current.scale).toBeCloseTo(2);
    expect(result.current.translate).toEqual({ x: 0, y: 0 });
    // Lift one finger (2→1): the hook must re-baseline on the remaining
    // finger at ITS current position (60,0) — panning continues seamlessly.
    await act(async () => {
      result.current.touchHandlers.onTouchEnd(touchEnd([{ clientX: 60, clientY: 0 }]));
      result.current.touchHandlers.onTouchMove(touch1(90, 10));
      result.current.touchHandlers.onTouchMove(touch1(120, 20));
    });
    // Pan delta = 60→120 (+60 x, +20 y) — the image follows the finger.
    expect(result.current.translate.x).toBeCloseTo(60);
    expect(result.current.translate.y).toBeCloseTo(20);
    // The pinch refs must be released: isPinching is false after the lift.
    expect(result.current.isPinching).toBe(false);
  });

  test("single-finger move does nothing at scale 1 (no ghost-drag of a fitted image)", async () => {
    const { result } = mountZoom();
    await act(async () => {
      result.current.touchHandlers.onTouchStart(touch1(60, 0));
      result.current.touchHandlers.onTouchMove(touch1(120, 20));
    });
    expect(result.current.translate).toEqual({ x: 0, y: 0 });
  });

  test("touchcancel clears all gesture state — no stale refs, no phantom pinch", async () => {
    const { result } = mountZoom();
    // Pinch in progress, then the browser takes the gesture over (cancel).
    result.current.touchHandlers.onTouchStart(touch2(0, 0, 100, 0));
    result.current.touchHandlers.onTouchCancel(touchEnd([]));
    // A following 2-finger move must be inert (dist ref cleared → no zoom),
    // and the queued updater from a cancel-racing move must not throw either.
    await act(async () => {
      result.current.touchHandlers.onTouchMove(touch2(0, 0, 400, 0));
    });
    expect(result.current.scale).toBe(1);
    expect(result.current.isPinching).toBe(false);
  });

  test("pinch keeps the image point under an off-center finger midpoint", async () => {
    const { result } = mountZoom();
    await act(async () => {
      result.current.touchHandlers.onTouchStart(touch2(50, 20, 150, 20));
      result.current.touchHandlers.onTouchMove(touch2(0, 20, 200, 20));
    });
    expect(result.current.scale).toBe(2);
    expect(result.current.translate).toEqual({ x: -50, y: -20 });
  });

  test("pan uses screen pixels, clamps to bounds and recenters when zooming out", async () => {
    const { result } = mountZoom();
    await act(async () => {
      result.current.touchHandlers.onTouchStart(touch2(0, 0, 100, 0));
      result.current.touchHandlers.onTouchMove(touch2(-50, 0, 150, 0));
      result.current.touchHandlers.onTouchEnd(touchEnd([{ clientX: 50, clientY: 0 }]));
      result.current.touchHandlers.onTouchMove(touch1(70, 10));
    });
    expect(result.current.translate).toEqual({ x: 20, y: 10 });
    expect(result.current.imageStyle.transform).toBe("translate(20px, 10px) scale(2)");
    await act(async () => { result.current.touchHandlers.onTouchMove(touch1(1000, 1000)); });
    expect(result.current.translate).toEqual({ x: 100, y: 100 });
    await act(async () => {
      result.current.touchHandlers.onTouchStart(touch2(-50, 0, 150, 0));
      result.current.touchHandlers.onTouchMove(touch2(10, 0, 90, 0));
    });
    expect(result.current.scale).toBeCloseTo(0.8);
    expect(result.current.translate).toEqual({ x: 0, y: 0 });
  });

  test("no transform easing runs while any finger is down, including the pinch-to-pan handoff", async () => {
    const { result } = mountZoom();
    await act(async () => { result.current.touchHandlers.onTouchStart(touch1(50, 0)); });
    expect(result.current.imageStyle.transition).toBe("none");
    await act(async () => {
      result.current.touchHandlers.onTouchStart(touch2(0, 0, 100, 0));
      result.current.touchHandlers.onTouchEnd(touchEnd([{ clientX: 50, clientY: 0 }]));
    });
    expect(result.current.isPinching).toBe(false);
    expect(result.current.imageStyle.transition).toBe("none");
    await act(async () => { result.current.touchHandlers.onTouchEnd(touchEnd([])); });
    expect(result.current.imageStyle.transition).toBe("transform 0.15s ease-out");
  });
});
