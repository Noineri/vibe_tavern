/**
 * The core of the "follow the bottom" rule: pinned = we are at the bottom.
 *
 * These tests deliberately work on bare numbers — no DOM, no layout engine.
 * That was the central problem with the old scroll layer: its logic was smeared
 * across effects and refs, nothing tested it at all, and so three iterations in
 * a row broke it blind.
 */
import { describe, it, expect } from "bun:test";
import {
  AT_BOTTOM_TOLERANCE_PX,
  distanceFromBottom,
  isAtBottom,
  nextPinned,
  type ScrollMetrics,
} from "./stick-to-bottom.js";

/** A 400px-tall container holding 1000px of content → max scrollTop is 600. */
function metrics(scrollTop: number, scrollHeight = 1000, clientHeight = 400): ScrollMetrics {
  return { scrollTop, scrollHeight, clientHeight };
}

describe("distanceFromBottom", () => {
  it("is zero once the viewport bottom meets the content bottom", () => {
    expect(distanceFromBottom(metrics(600))).toBe(0);
  });

  it("counts the pixels left below the viewport", () => {
    expect(distanceFromBottom(metrics(100))).toBe(500);
  });

  it("goes negative when overscrolled past the end (iOS rubber-banding)", () => {
    expect(distanceFromBottom(metrics(650))).toBe(-50);
  });

  it("goes negative when the content is shorter than the viewport", () => {
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(-200);
  });
});

describe("isAtBottom", () => {
  it("holds exactly at the bottom", () => {
    expect(isAtBottom(metrics(600))).toBe(true);
  });

  it("holds within the sub-pixel tolerance", () => {
    expect(isAtBottom(metrics(599))).toBe(true);
  });

  it("holds exactly on the tolerance boundary", () => {
    expect(isAtBottom(metrics(600 - AT_BOTTOM_TOLERANCE_PX))).toBe(true);
  });

  it("fails one pixel past the tolerance", () => {
    expect(isAtBottom(metrics(600 - AT_BOTTOM_TOLERANCE_PX - 1))).toBe(false);
  });

  it("holds while overscrolled (rubber-banding must not unpin)", () => {
    expect(isAtBottom(metrics(650))).toBe(true);
  });

  it("holds when the content is shorter than the viewport (nowhere to scroll)", () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(true);
  });

  it("fails after scrolling up by a screen", () => {
    expect(isAtBottom(metrics(200))).toBe(false);
  });

  it("survives fractional metrics from a fractional devicePixelRatio", () => {
    expect(isAtBottom({ scrollTop: 599.5, scrollHeight: 1000.25, clientHeight: 400.5 })).toBe(true);
  });

  it("honours an explicitly passed tolerance", () => {
    expect(isAtBottom(metrics(500), 100)).toBe(true);
    expect(isAtBottom(metrics(500), 99)).toBe(false);
  });

  it("keeps the tolerance in single-digit pixels — it is rounding, not tuning", () => {
    expect(AT_BOTTOM_TOLERANCE_PX).toBeLessThanOrEqual(4);
  });
});

describe("nextPinned", () => {
  it("unpins when the user scrolls up with the content unchanged", () => {
    expect(nextPinned(true, metrics(600), metrics(200))).toBe(false);
  });

  it("does not unpin on a tiny upward move inside the tolerance", () => {
    expect(nextPinned(true, metrics(600), metrics(599))).toBe(true);
  });

  it("does not unpin when the virtualizer re-measured the content height", () => {
    // Measured on chat open: the list shrank from 6360 to 6012 and the position
    // travelled up with it. Scrolling never changes the content height.
    expect(nextPinned(true, metrics(5677, 6360, 683), metrics(5023, 6012, 683))).toBe(true);
  });

  it("does not unpin when the view moved DOWN but stopped short of the end", () => {
    // Stream end: the placeholder is swapped for the real message, scrollTop
    // grows but halts above the bottom.
    expect(nextPinned(true, metrics(2646, 4190, 683), metrics(3095, 4140, 683))).toBe(true);
  });

  it("stays unpinned until the user actually reaches the bottom", () => {
    expect(nextPinned(false, metrics(200), metrics(400))).toBe(false);
  });

  it("re-pins once the user scrolls back down to the bottom", () => {
    expect(nextPinned(false, metrics(400), metrics(600))).toBe(true);
  });

  it("leaves the decision alone when content merely grows", () => {
    expect(nextPinned(true, metrics(600), metrics(600, 1400))).toBe(true);
    expect(nextPinned(false, metrics(200), metrics(200, 1400))).toBe(false);
  });

  it("does not unpin on rubber-banding, though it is formally an upward move", () => {
    expect(nextPinned(true, metrics(650), metrics(620))).toBe(true);
  });

  it("honours an explicitly passed tolerance", () => {
    expect(nextPinned(true, metrics(600), metrics(500), 100)).toBe(true);
    expect(nextPinned(true, metrics(600), metrics(500), 99)).toBe(false);
  });
});
