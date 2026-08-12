/**
 * Pure "stick to the bottom" arithmetic for a scroll container.
 *
 * Follow-while-streaming reduces to two rules, and this module owns the first:
 *
 *   1. pinned = the viewport sits at the bottom      ← here
 *   2. content grew && pinned → drive to the bottom  ← use-stick-to-bottom.ts
 *
 * `pinned` is derived from the RESULT of scrolling (the position), never from
 * its CAUSE (wheel / touch / keyboard events). That is deliberate: reading the
 * position covers every input — wheel, trackpad inertia, scrollbar dragging,
 * PageUp/Home, arrow keys, programmatic scrolling — without enumerating any of
 * them. The previous implementation tracked only `wheel` and `touchmove`, so it
 * was blind to the scrollbar and the keyboard; that is exactly where the "I
 * scrolled up mid-stream and got yanked back down" bug came from.
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

/**
 * The new value of `pinned` after a `scroll` event.
 *
 * `isAtBottom` alone is not enough, and that was measured rather than reasoned:
 * the user is not the only one moving the position. The virtualizer moves it
 * itself whenever it re-lays out content — it refines item heights while
 * scrolling, it swaps the streaming placeholder for the real message — and it
 * moves it IMPRECISELY. Measured on a live page:
 *
 *   chat open:     `scrollHeight` 6360 → 6012, `scrollTop` 5677 → 5023  (dfb 306)
 *   stream end:    `scrollTop` 2646 → 3095 where 3457 was needed        (dfb 362)
 *
 * A plain "at the bottom or not" rule saw those hundreds of pixels and dropped
 * follow in situations where the user did nothing at all.
 *
 * Content height tells the two apart: scrolling never changes it — the user can
 * only move `scrollTop` within an unchanged `scrollHeight`. Hence the rule:
 *
 *   at the bottom        → pinned (however we got there)
 *   content height moved → not the user; keep the previous decision
 *   moved up             → unpinned
 *   moved down / stayed  → keep the previous decision
 *
 * This is still a function of numbers: no input events, no timers, and no notion
 * of a generation enter into it.
 */
export function nextPinned(
  pinned: boolean,
  previous: ScrollMetrics,
  metrics: ScrollMetrics,
  tolerancePx: number = AT_BOTTOM_TOLERANCE_PX,
): boolean {
  if (isAtBottom(metrics, tolerancePx)) return true;
  if (metrics.scrollHeight !== previous.scrollHeight) return pinned;
  return metrics.scrollTop < previous.scrollTop ? false : pinned;
}
