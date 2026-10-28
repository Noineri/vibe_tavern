import { describe, expect, test } from "bun:test";
import {
  getVariantRenderWindow,
  getVariantScrollIndex,
  observeVariantScrollSettle,
  type VariantScrollMetrics,
} from "./variant-scroll-snap.js";

// A test-local clock: no real waits, timer patches, DOM globals or module mocks.
function createClock() {
  let now = 0;
  const pending = new Set<{ at: number; callback: () => void }>();
  return {
    schedule(callback: () => void, delayMs: number) {
      const task = { at: now + delayMs, callback };
      pending.add(task);
      return () => { pending.delete(task); };
    },
    advance(delayMs: number) {
      now += delayMs;
      for (const task of [...pending].sort((a, b) => a.at - b.at)) {
        if (task.at <= now && pending.delete(task)) task.callback();
      }
    },
    get pendingCount() { return pending.size; },
  };
}

function setup(nativeScrollEnd: boolean, readRequestedIndex?: () => number | null) {
  const target = new EventTarget();
  if (nativeScrollEnd) Object.defineProperty(target, "onscrollend", { value: null });
  const clock = createClock();
  const metrics: VariantScrollMetrics = { scrollLeft: 0, slotWidth: 320, variantCount: 5 };
  const settled: number[] = [];
  const dispose = observeVariantScrollSettle(target, {
    readMetrics: () => metrics,
    onSettle: (index) => { settled.push(index); },
    schedule: clock.schedule,
    readRequestedIndex,
  });
  return {
    target, clock, metrics, settled, dispose,
    scrollTo(left: number) {
      metrics.scrollLeft = left;
      target.dispatchEvent(new Event("scroll"));
    },
    touch(type: string, remainingTouches: number) {
      target.dispatchEvent(Object.assign(new Event(type), { touches: { length: remainingTouches } }));
    },
  };
}

describe("getVariantScrollIndex", () => {
  test("rounds to the nearest slot, including a track gap and fractional widths", () => {
    // 320px content + a 12px track gap => a 332px slot pitch.
    expect(getVariantScrollIndex({ scrollLeft: 664, slotWidth: 332, variantCount: 5 })).toBe(2);
    expect(getVariantScrollIndex({ scrollLeft: 159.9, slotWidth: 320, variantCount: 5 })).toBe(0);
    expect(getVariantScrollIndex({ scrollLeft: 160, slotWidth: 320, variantCount: 5 })).toBe(1);
    expect(getVariantScrollIndex({ scrollLeft: 641, slotWidth: 320.5, variantCount: 5 })).toBe(2);
  });

  test("clamps rubber-band overscroll at either edge and handles a single slot", () => {
    expect(getVariantScrollIndex({ scrollLeft: -200, slotWidth: 320, variantCount: 5 })).toBe(0);
    expect(getVariantScrollIndex({ scrollLeft: 2000, slotWidth: 320, variantCount: 5 })).toBe(4);
    expect(getVariantScrollIndex({ scrollLeft: 2000, slotWidth: 320, variantCount: 1 })).toBe(0);
  });

  test("does not invent an index before measurement or with no variants", () => {
    const valid = { scrollLeft: 0, slotWidth: 320, variantCount: 5 };
    for (const slotWidth of [0, -1, NaN, Infinity]) {
      expect(getVariantScrollIndex({ ...valid, slotWidth })).toBeNull();
    }
    for (const scrollLeft of [NaN, Infinity, -Infinity]) {
      expect(getVariantScrollIndex({ ...valid, scrollLeft })).toBeNull();
    }
    for (const variantCount of [0, -1, NaN, Infinity, 1.5]) {
      expect(getVariantScrollIndex({ ...valid, variantCount })).toBeNull();
    }
  });
});

describe("getVariantRenderWindow", () => {
  test("returns only the current and available adjacent positions", () => {
    expect(getVariantRenderWindow(0, 5)).toEqual([0, 1]);
    expect(getVariantRenderWindow(2, 5)).toEqual([1, 2, 3]);
    expect(getVariantRenderWindow(4, 5)).toEqual([3, 4]);
    expect(getVariantRenderWindow(0, 1)).toEqual([0]);
    expect(getVariantRenderWindow(0, 0)).toEqual([]);
  });

  test("clamps a stale selection after deletion and preserves overlapping panel identities", () => {
    expect(getVariantRenderWindow(4, 3)).toEqual([1, 2]);
    expect(getVariantRenderWindow(-1, 3)).toEqual([0, 1]);
    const before = getVariantRenderWindow(2, 100);
    const after = getVariantRenderWindow(3, 100);
    expect(after.filter((index) => !before.includes(index))).toEqual([4]);
    expect(after.filter((index) => before.includes(index))).toEqual([2, 3]);
  });

  test("is bounded to three panels regardless of the number of variants", () => {
    expect(getVariantRenderWindow(5000, 10000)).toEqual([4999, 5000, 5001]);
    expect(getVariantRenderWindow(NaN, 3)).toEqual([]);
    expect(getVariantRenderWindow(0, Infinity)).toEqual([]);
  });
});

describe("observeVariantScrollSettle — native scrollend", () => {
  test("an explicit request lands as soon as its own snap position is reached, without waiting for scrollend", () => {
    for (const native of [true, false]) {
      const s = setup(native, () => 2);
      s.scrollTo(320); // Another aligned slot is not the requested destination.
      s.scrollTo(620);
      expect(s.settled).toEqual([]);
      s.scrollTo(639.5);
      expect(s.settled).toEqual([2]);
      s.target.dispatchEvent(new Event("scrollend"));
      s.clock.advance(200);
      expect(s.settled).toEqual([2]);
      expect(s.clock.pendingCount).toBe(0);
      s.dispose();
    }
  });

  test("an explicit request cannot commit while a finger is held, even on the native path", () => {
    const s = setup(true, () => 2);
    s.touch("touchstart", 1);
    s.scrollTo(640);
    expect(s.settled).toEqual([]);
    s.touch("touchend", 0);
    s.target.dispatchEvent(new Event("scrollend"));
    expect(s.settled).toEqual([2]);
    s.dispose();
  });

  test("removing a pending request restores normal native settle-only behavior", () => {
    let requested: number | null = 2;
    const s = setup(true, () => requested);
    s.scrollTo(320);
    requested = null;
    s.scrollTo(640);
    expect(s.settled).toEqual([]);
    s.target.dispatchEvent(new Event("scrollend"));
    expect(s.settled).toEqual([2]);
    s.dispose();
  });

  test("feature-detects support, waits for scrollend, and commits once per scroll sequence", () => {
    const s = setup(true);
    s.scrollTo(180);
    s.scrollTo(320);
    s.clock.advance(1000);
    expect(s.settled).toEqual([]);
    expect(s.clock.pendingCount).toBe(0);
    s.target.dispatchEvent(new Event("scrollend"));
    s.target.dispatchEvent(new Event("scrollend"));
    expect(s.settled).toEqual([1]);
    s.dispose();
  });

  test("reads fresh geometry on landing and ignores an unmeasured landing", () => {
    const s = setup(true);
    s.scrollTo(640);
    s.metrics.slotWidth = 160;
    s.metrics.variantCount = 3;
    s.target.dispatchEvent(new Event("scrollend"));
    expect(s.settled).toEqual([2]);
    s.scrollTo(0);
    s.metrics.slotWidth = 0;
    s.target.dispatchEvent(new Event("scrollend"));
    expect(s.settled).toEqual([2]);
    s.dispose();
  });

  test("interrupted motion can settle in either direction without an animation promise", () => {
    const s = setup(true);
    s.scrollTo(200);
    s.scrollTo(640);
    s.target.dispatchEvent(new Event("scrollend"));
    s.scrollTo(450);
    s.scrollTo(320);
    s.target.dispatchEvent(new Event("scrollend"));
    expect(s.settled).toEqual([2, 1]);
    s.dispose();
  });
});

describe("observeVariantScrollSettle — scroll fallback", () => {
  test("debounces scrolls when scrollend is unsupported, including a new swipe after landing", () => {
    const s = setup(false);
    s.scrollTo(320);
    s.clock.advance(100);
    s.scrollTo(640);
    s.clock.advance(100);
    expect(s.settled).toEqual([]);
    s.clock.advance(100);
    expect(s.settled).toEqual([2]);
    expect(s.clock.pendingCount).toBe(0);
    s.scrollTo(320);
    s.clock.advance(200);
    expect(s.settled).toEqual([2, 1]);
    s.dispose();
  });

  test("does not commit a pause between snap points or rubber-band overscroll", () => {
    const s = setup(false);
    for (const left of [180, -30, 1320]) {
      s.scrollTo(left);
      s.clock.advance(200);
    }
    expect(s.settled).toEqual([]);
    s.scrollTo(319.5);
    s.clock.advance(200);
    expect(s.settled).toEqual([1]);
    s.dispose();
  });

  test("does not commit while a finger is held, even at a snap point", () => {
    const s = setup(false);
    s.scrollTo(320);
    s.touch("touchstart", 1);
    s.clock.advance(1000);
    expect(s.settled).toEqual([]);
    s.scrollTo(640);
    s.clock.advance(1000);
    expect(s.settled).toEqual([]);
    s.touch("touchend", 1);
    s.clock.advance(200);
    expect(s.settled).toEqual([]);
    s.touch("touchend", 0);
    s.clock.advance(200);
    expect(s.settled).toEqual([2]);
    s.dispose();
  });

  test("resumes after touchcancel and does not treat an ordinary reading touch as a switch", () => {
    const s = setup(false);
    s.touch("touchstart", 1);
    s.touch("touchend", 0);
    s.clock.advance(200);
    expect(s.settled).toEqual([]);
    s.touch("touchstart", 1);
    s.scrollTo(320);
    s.touch("touchcancel", 0);
    s.clock.advance(200);
    expect(s.settled).toEqual([1]);
    s.dispose();
  });
});

describe("settle observer lifecycle", () => {
  test("disposal removes listeners and pending callbacks on both paths", () => {
    for (const native of [false, true]) {
      const s = setup(native);
      s.scrollTo(320);
      s.dispose();
      s.dispose();
      s.clock.advance(1000);
      s.scrollTo(640);
      s.target.dispatchEvent(new Event("scrollend"));
      s.touch("touchend", 0);
      s.clock.advance(1000);
      expect(s.settled).toEqual([]);
      expect(s.clock.pendingCount).toBe(0);
    }
  });
});
