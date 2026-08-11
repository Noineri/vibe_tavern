import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { nextPinned, type ScrollMetrics } from "../../lib/stick-to-bottom.js";

export interface StickToBottom {
  /** Pass to `<Virtuoso ref>`. */
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  /** Pass to `<Virtuoso scrollerRef>`. */
  scrollerRef: (ref: HTMLElement | Window | null) => void;
  /** Pass to `<Virtuoso totalListHeightChanged>`. */
  onTotalListHeightChanged: (height: number) => void;
  /**
   * Whether the view follows the bottom. It flips rarely — only when the user
   * detaches or re-attaches — so it is cheap to render the "to the end" button
   * from.
   */
  pinned: boolean;
  /** Re-attach and drive to the bottom (the "to the end" button). */
  scrollToBottom: () => void;
}

/**
 * Binds the rule from `stick-to-bottom.ts` to a Virtuoso instance.
 *
 * Three inputs and one output:
 *   in  — the container's `scroll` event   → recompute `pinned`
 *   in  — `totalListHeightChanged`         → if `pinned`, drive to the bottom
 *   in  — viewport resize                  → if `pinned`, drive to the bottom
 *   out — `scrollToBottom()` for the button → re-attach and drive
 *
 * Why `totalListHeightChanged` rather than `followOutput`: `followOutput` only
 * fires when `totalCount` changes — the library's own JSDoc says so. While
 * tokens stream the item count does not change; the height of one item grows.
 * `totalListHeightChanged` is derived from `listState`, which updates on every
 * item re-measurement, so it catches both a growing message and a new one.
 *
 * The hook knows NOTHING about generations: no `isSending`, no "end of stream".
 * Finishing a generation is just one more height change. That absence of an
 * "the stream ended" special case is precisely what removes the "it scrolled to
 * the bottom even though the user went back to read" bug.
 */
export function useStickToBottom(): StickToBottom {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  // `pinned` lives in a ref and in state at once: the ref is read on every
  // scroll event (no re-render), the state renders the "to the end" button.
  // Only `setPinned` writes either, so they cannot drift apart.
  const pinnedRef = useRef(true);
  const [pinned, setPinnedState] = useState(true);
  const setPinned = useCallback((next: boolean) => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
    setPinnedState(next);
  }, []);
  // The last geometry we know of. `nextPinned` compares against it to tell a
  // user scrolling up from a position the content re-layout moved itself.
  //
  // It is refreshed EVERY time we look at the container, not just on scroll
  // events, and that is load-bearing rather than tidy: Firefox delivers scroll
  // events late, so `scrollTop` in the event belongs to one moment while the
  // `scrollHeight` we read while handling it belongs to a later one. The
  // virtualizer's height estimate wobbles (measured: 6762 → 6003 → 5890 →
  // 6205), so it can change and change back between two scroll events — and a
  // comparison against the previous EVENT then reports "the height never moved"
  // while the position did, which reads as a user scrolling up. Comparing
  // against the last height we actually observed keeps the two coherent.
  const lastMetricsRef = useRef<ScrollMetrics>({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });

  const rememberGeometry = useCallback(() => {
    const el = scrollerElRef.current;
    if (!el) return;
    lastMetricsRef.current = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  }, []);

  const followBottom = useCallback(() => {
    // Ask Virtuoso to scroll instead of writing scrollTop ourselves: it owns the
    // position (it compensates for item re-measurement), and a second writer
    // would desynchronise its internal "we are at the bottom" state.
    //
    // We ask for a deliberately unreachable offset: the library's `scrollTo`
    // clamps `top` to the real maximum (`scrollHeight - viewportHeight`) at the
    // moment it applies, and updates its own state with that same value. So
    // "the maximum" is more accurate than any estimate of ours — an item may be
    // re-measured between reading the height and scrolling.
    //
    // Why not `scrollToIndex({ index: "LAST", align: "end" })`, which is how the
    // library implements follow internally: it aligns the bottom of the last
    // ITEM with the bottom of the viewport, and the Footer sits below that item.
    // Measured in the browser: it stopped 32px short, `isAtBottom` read that as
    // "not at the bottom", and follow detached itself after the very first tick.
    //
    // `behavior: "auto"` — no animation: an animated scroll would still be
    // running when the next token arrives.
    virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" });
    rememberGeometry();
  }, [rememberGeometry]);

  const handleScroll = useCallback(() => {
    const el = scrollerElRef.current;
    if (!el) return;
    const previous = lastMetricsRef.current;
    const current: ScrollMetrics = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
    lastMetricsRef.current = current;
    setPinned(nextPinned(pinnedRef.current, previous, current));
    // Pinned but not at the bottom means a content re-layout moved the position
    // and moved it short (the virtualizer does that when it swaps the streaming
    // placeholder for the real message). Finish the trip.
    // When there is nothing left to travel, the library's `scrollTo` bails out
    // early and emits no event, so this does not recurse.
    if (pinnedRef.current) followBottom();
  }, [followBottom, setPinned]);

  // The second geometry input beside `totalListHeightChanged`: VIEWPORT resize.
  //
  // It is needed because the library's callback only covers the list height.
  // Measured: 1280x800 → 1280x600 changes neither the list height nor
  // `scrollTop`, so neither `totalListHeightChanged` nor a `scroll` event
  // arrives — and the view was left 200px from the bottom while still `pinned`.
  //
  // We observe the scroller and nothing inside it. Observing the list container
  // is not an option: driving to the bottom changes which items are rendered,
  // that changes the list height, and `ResizeObserver` storms — the browser
  // answers with "ResizeObserver loop completed with undelivered notifications".
  // The scroller's own size does not depend on scrolling, so there is no loop.
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const observeViewport = useCallback(
    (el: HTMLElement | null) => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (!el) return;
      const observer = new ResizeObserver(() => {
        if (pinnedRef.current) followBottom();
        else rememberGeometry();
      });
      observer.observe(el);
      resizeObserverRef.current = observer;
    },
    [followBottom],
  );

  const scrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      const previous = scrollerElRef.current;
      if (previous) previous.removeEventListener("scroll", handleScroll);
      // Virtuoso hands back a Window only in useWindowScroll mode, which is not
      // used here; narrow to HTMLElement and ignore anything else.
      const next = ref instanceof HTMLElement ? ref : null;
      scrollerElRef.current = next;
      if (next) next.addEventListener("scroll", handleScroll, { passive: true });
      observeViewport(next);
    },
    [handleScroll, observeViewport],
  );

  useEffect(() => {
    return () => {
      scrollerElRef.current?.removeEventListener("scroll", handleScroll);
      resizeObserverRef.current?.disconnect();
    };
  }, [handleScroll]);

  const onTotalListHeightChanged = useCallback((height: number) => {
    if (pinnedRef.current) followBottom();
    else rememberGeometry();
  }, [followBottom, rememberGeometry]);

  const scrollToBottom = useCallback(() => {
    setPinned(true);
    followBottom();
  }, [followBottom, setPinned]);

  // The very first geometry read: without it `lastMetrics` stays at zeroes and
  // the first real scroll event compares against a container that never existed.
  useEffect(() => {
    rememberGeometry();
  }, [rememberGeometry]);

  return { virtuosoRef, scrollerRef, onTotalListHeightChanged, pinned, scrollToBottom };
}
