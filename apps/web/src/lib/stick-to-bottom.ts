/**
 * Pure "stick to the bottom" arithmetic for a scroll container.
 *
 * Follow-while-streaming reduces to two rules, and this module owns the first:
 *
 *   1. pinned = the viewport sits at the bottom      ← here
 *   2. content grew && pinned → drive to the bottom  ← use-stick-to-bottom.ts
 *
 * This module answers only the geometry question. The React controller combines
 * that result with user scroll intent so browser restoration and virtualizer
 * corrections cannot detach an otherwise pinned chat.
 *
 * No DOM, no React, no timers — the whole module is arithmetic over three
 * numbers, which is why its tests need bare numbers and no layout engine.
 */

/** Vertical geometry of a scroll container, in CSS pixels. */
export interface ScrollMetrics {
  /** Current scroll offset from the top. */
  scrollTop: number;
  /** Full height of the scrollable content. */
  scrollHeight: number;
  /** Visible height of the container. */
  clientHeight: number;
}

/**
 * Tolerance, in CSS pixels, for "we are at the bottom".
 *
 * It exists for exactly one reason: `scrollTop`, `scrollHeight` and
 * `clientHeight` are fractional under a fractional devicePixelRatio and under
 * browser zoom, so the exact equality `scrollTop + clientHeight === scrollHeight`
 * never holds. Two pixels cover the rounding with room to spare.
 *
 * This is NOT a tuning knob. If follow only holds steady with a larger value,
 * the defect is somewhere else — go find it instead of raising this number. The
 * previous value was 30, picked empirically to mask precisely such a defect.
 */
export const AT_BOTTOM_TOLERANCE_PX = 2;

/**
 * Pixels between the bottom of the viewport and the bottom of the content. Zero
 * at the bottom; negative when overscrolled (iOS rubber-banding) and when the
 * content is shorter than the viewport.
 */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

/**
 * Whether the viewport counts as parked at the bottom — that is, whether the
 * view should follow new content.
 */
export function isAtBottom(
  metrics: ScrollMetrics,
  tolerancePx: number = AT_BOTTOM_TOLERANCE_PX,
): boolean {
  return distanceFromBottom(metrics) <= tolerancePx;
}
