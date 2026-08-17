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
