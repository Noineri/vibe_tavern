/** Framework-independent geometry and settle detection for the native pager. */
export type VariantScrollMetrics = {
  scrollLeft: number;
  /** Distance between slot starts: the content width PLUS any track gap. */
  slotWidth: number;
  variantCount: number;
};

/** Nearest logical position; null until there is usable layout and content. */
export function getVariantScrollIndex({ scrollLeft, slotWidth, variantCount }: VariantScrollMetrics): number | null {
  if (!Number.isFinite(scrollLeft) || !Number.isFinite(slotWidth) || slotWidth <= 0
    || !Number.isInteger(variantCount) || variantCount <= 0) return null;
  return Math.max(0, Math.min(variantCount - 1, Math.round(scrollLeft / slotWidth)));
}

/** Keep slots for all positions, but mount Markdown only at these indices.
 * Key panels by variant identity, not by their previous/current/next role. */
export function getVariantRenderWindow(selectedIndex: number, variantCount: number): number[] {
  if (!Number.isInteger(selectedIndex) || !Number.isInteger(variantCount) || variantCount <= 0) return [];
  const current = Math.max(0, Math.min(variantCount - 1, selectedIndex));
  const positions: number[] = [];
  for (let index = Math.max(0, current - 1); index <= Math.min(variantCount - 1, current + 1); index++) {
    positions.push(index);
  }
  return positions;
}

type ScheduleSettle = (callback: () => void, delayMs: number) => () => void;

type VariantScrollSettleOptions = {
  /** Read at settle time, not from a stale render before resize or deletion. */
  readMetrics: () => VariantScrollMetrics;
  onSettle: (index: number) => void;
  /** Explicit control intent only; reaching this exact slot can finish a
   * programmatic scroll before a delayed native scrollend. Never infer it
   * from touch displacement or velocity. Clear it on new user input. */
  readRequestedIndex?: () => number | null;
  /** Clock boundary; a deterministic scheduler can be supplied by tests. */
  schedule?: ScheduleSettle;
};

const FALLBACK_QUIET_MS = 120;
const SNAP_TOLERANCE_PX = 1;

function isSnapAligned(metrics: VariantScrollMetrics, index: number): boolean {
  return Math.abs(metrics.scrollLeft - index * metrics.slotWidth) <= SNAP_TOLERANCE_PX;
}

const scheduleTimeout: ScheduleSettle = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/** Observe a native scroller without owning its motion or selection state.
 * Modern browsers own settling via scrollend; older engines get a quiet-scroll
 * fallback that only accepts an aligned snap point after all touches end.
 * An explicit control request may finish at its own physical snap position.
 * Neither path uses an animation promise or an interruptible animation lock. */
export function observeVariantScrollSettle(target: EventTarget, options: VariantScrollSettleOptions): () => void {
  const { readMetrics, onSettle, readRequestedIndex = () => null, schedule = scheduleTimeout } = options;
  const nativeScrollEnd = "onscrollend" in target;
  let pending = false;
  let touching = false;
  let disposed = false;
  let cancelScheduled: (() => void) | undefined;

  const cancel = () => {
    cancelScheduled?.();
    cancelScheduled = undefined;
  };

  const settle = () => {
    cancelScheduled = undefined;
    if (disposed || !pending || touching) return;
    const metrics = readMetrics();
    const index = getVariantScrollIndex(metrics);
    if (index === null) return;
    // A quiet interval can occur mid-drag or during iOS rubber-banding.
    // Do not treat that as a landing; the next scroll will re-arm detection.
    if (!nativeScrollEnd && !isSnapAligned(metrics, index)) return;
    pending = false;
    onSettle(index);
  };

  const scheduleFallback = () => {
    cancel();
    if (!nativeScrollEnd && pending && !touching) {
      cancelScheduled = schedule(settle, FALLBACK_QUIET_MS);
    }
  };

  const onScroll = (event: Event) => {
    // Nested code blocks or other scrollable panel contents are not the pager.
    if (event.target !== target) return;
    pending = true;
    const requested = readRequestedIndex();
    if (requested !== null && !touching) {
      const metrics = readMetrics();
      if (getVariantScrollIndex(metrics) === requested && isSnapAligned(metrics, requested)) {
        // A chevron has already named the destination. Its physical arrival
        // is sufficient; do not keep the old panel height until scrollend.
        cancel();
        settle();
        return;
      }
    }
    scheduleFallback();
  };
  const onScrollEnd = (event: Event) => {
    if (event.target === target) settle();
  };
  const onTouchStart = () => {
    touching = true;
    cancel();
  };
  const onTouchEnd = (event: Event) => {
    touching = (event as TouchEvent).touches.length > 0;
    scheduleFallback();
  };

  target.addEventListener("scroll", onScroll, { passive: true });
  if (nativeScrollEnd) {
    target.addEventListener("scrollend", onScrollEnd);
  }
  // Touch events retain their start target during native scrolling, unlike
  // pointer events. Both settle paths must reject arrival while a finger is down.
  target.addEventListener("touchstart", onTouchStart, { passive: true });
  target.addEventListener("touchend", onTouchEnd, { passive: true });
  target.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return () => {
    disposed = true;
    cancel();
    target.removeEventListener("scroll", onScroll);
    target.removeEventListener("scrollend", onScrollEnd);
    target.removeEventListener("touchstart", onTouchStart);
    target.removeEventListener("touchend", onTouchEnd);
    target.removeEventListener("touchcancel", onTouchEnd);
  };
}
