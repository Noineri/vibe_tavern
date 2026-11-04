import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isAtBottom, type ScrollMetrics } from "../../lib/stick-to-bottom.js";
import type { RevealMessageStart } from "./message-scroll-context.js";

/** A stale completion must not align a row or change the pin. */
export type CompleteExplicitNavigation = (target?: HTMLElement | null) => boolean;

/** The stable row-identity attribute every scroller row carries (virtualized
 *  and stable-tail alike) — the prepend anchor and the jump math address rows
 *  through it. */
const SCROLLER_ROW_SELECTOR = "[data-scroller-message-id]";

export interface StickToBottom {
  /** Attach to the overflow container. */
  scrollerRef: (node: HTMLElement | Window | null) => void;
  /** Overlay scrollbars live outside the viewport; forward their user intent
   * here before they write the same viewport's native scroll position. */
  onScrollIntent: () => void;
  /** Attach to the recent message tail whose mounted rows remain stable. */
  stableTailRef: (node: HTMLElement | null) => void;
  /** Reconcile delayed height estimates reported by the virtualized history. */
  onVirtualizedHeightChanged: () => void;
  /** Whether content and viewport size changes should keep the bottom aligned. */
  pinned: boolean;
  /** Re-attach and drive to the bottom (the "to the end" button). */
  scrollToBottom: () => void;
  /** Explicit reading navigation; temporarily wins over bottom follow. */
  revealStart: RevealMessageStart;
  /** Detach until the virtualizer completes; optionally align a mounted row. */
  beginExplicitNavigation: () => CompleteExplicitNavigation;
  /** AFP-2 (AGENT_FEED_PERFORMANCE_PLAN Wave 1 step 3): anchor the first
   *  visible stable row for a pending prepend. Call BEFORE the prepend
   *  commits (older pages landing above the reading position); the returned
   *  restore realigns the captured row to its captured viewport offset AFTER
   *  the new content has laid out — never as bottom-follow, and never moving
   *  the pin. Superseded or cancelled anchors (user scroll intent, explicit
   *  navigation, reveal, bottom jump, reset) restore nothing; a captured row
   *  that left the DOM (unloaded/repartitioned) leaves the position alone. */
  beginPrependAnchor: () => () => void;
}

function readMetrics(element: HTMLElement): ScrollMetrics {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

/**
 * Owns the scroll invariant for a message list with a stable recent tail.
 *
 * The observed tail is outside the virtualized history. Scrolling can change
 * which old rows Virtuoso renders, but it cannot resize this observed element,
 * so a tail resize can update `scrollTop` without feeding back into the same
 * ResizeObserver. This lets the pinned position settle before paint for
 * streaming text, disclosure animations, image loads, font changes, and future
 * row content without component-specific coordination.
 *
 * AFP-2 adds the PREPEND ANCHOR (beginPrependAnchor): a paged feed loading
 * older history above a detached reader captures the first visible stable row
 * and restores its viewport offset after the prepend commits — the load never
 * yanks the reader to the bottom and never claims the pin. Any newer user
 * intent (scroll, jump, reveal, reset) cancels the pending anchor.
 *
 *  IF-4b follow-up (owner 2026-09-22): `suppressFollow` — while an image-gen
 *  run is in flight for this chat, content growth must NOT drag the pinned
 *  view to the bottom (the user swipes variants on earlier slots while a
 *  later one generates). A suppressed reconcile leaves the scroll position
 *  alone; when growth pushes the bottom out of reach the pin DROPS
 *  (isAtBottom re-eval), so the floating "to the end" button appears instead
 *  of a yank. The explicit `scrollToBottom()` still follows (a direct user
 *  action), and text streaming is unaffected — the caller only raises the
 *  flag for image-gen runs.
 */
export function useStickToBottom(resetKey: string, suppressFollow: boolean = false): StickToBottom {
  const scrollerElementRef = useRef<HTMLElement | null>(null);
  const stableTailObserverRef = useRef<ResizeObserver | null>(null);
  const viewportObserverRef = useRef<ResizeObserver | null>(null);
  const pinnedRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const readingNavigationRef = useRef<{ target: HTMLElement } | null>(null);
  const explicitNavigationRef = useRef<object | null>(null);
  const prependAnchorRef = useRef<{ rowId: string; rowViewportTop: number } | null>(null);
  const [pinned, setPinnedState] = useState(true);
  // Latest-flag mirror: the observers close over reconcileAfterLayoutChange,
  // so a changing suppressFollow must not churn them (the ref is read at
  // reconcile time).
  const suppressFollowRef = useRef(suppressFollow);
  suppressFollowRef.current = suppressFollow;

  const setPinned = useCallback((next: boolean) => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
    setPinnedState(next);
  }, []);

  const followBottom = useCallback(() => {
    const element = scrollerElementRef.current;
    if (!element) return;
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  }, []);

  const revealReadingStart = useCallback(() => {
    const element = scrollerElementRef.current;
    const navigation = readingNavigationRef.current;
    if (!element || !navigation || !element.contains(navigation.target)) return;
    const viewportTop = element.getBoundingClientRect().top + element.clientTop;
    const delta = navigation.target.getBoundingClientRect().top - viewportTop;
    // Preserve a visible start; only bring hidden text back into view.
    if (delta < 0) element.scrollTop = Math.max(0, element.scrollTop + delta);
  }, []);

  /** Clear any pending prepend anchor: a newer interaction owns the
   *  position now (the stale restore checks identity and no-ops, but clearing
   *  at the source keeps the state honest). */
  const cancelPrependAnchor = useCallback(() => {
    prependAnchorRef.current = null;
  }, []);

  const beginPrependAnchor = useCallback(() => {
    const element = scrollerElementRef.current;
    if (!element) return () => {};
    // The first row whose bottom edge is below the viewport top — the reader's
    // current visual anchor. Rows without the stable-id attribute are skipped
    // (they are chrome, not content).
    const viewportTop = element.getBoundingClientRect().top + element.clientTop;
    let firstVisible: HTMLElement | null = null;
    for (const row of element.querySelectorAll<HTMLElement>(SCROLLER_ROW_SELECTOR)) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > viewportTop + 1) { firstVisible = row; break; }
    }
    if (firstVisible === null) return () => {};
    const anchor = {
      rowId: firstVisible.getAttribute("data-scroller-message-id")!,
      rowViewportTop: firstVisible.getBoundingClientRect().top - viewportTop,
    };
    prependAnchorRef.current = anchor;
    return () => {
      if (prependAnchorRef.current !== anchor) return; // superseded / cancelled
      prependAnchorRef.current = null;
      const scroller = scrollerElementRef.current;
      if (!scroller) return;
      const row = Array.from(scroller.querySelectorAll<HTMLElement>(SCROLLER_ROW_SELECTOR))
        .find((candidate) => candidate.getAttribute("data-scroller-message-id") === anchor.rowId);
      // The row left the DOM (unloaded history / repartition): keep the
      // current position — a guess would be worse than the reader's place.
      if (!row) return;
      const viewportTopNow = scroller.getBoundingClientRect().top + scroller.clientTop;
      const delta = row.getBoundingClientRect().top - viewportTopNow - anchor.rowViewportTop;
      if (delta === 0) return;
      scroller.scrollTop = Math.max(
        0,
        Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + delta),
      );
    };
  }, []);

  const revealStart = useCallback<RevealMessageStart>((target) => {
    const element = scrollerElementRef.current;
    if (!element?.contains(target)) return () => {};
    explicitNavigationRef.current = null;
    cancelPrependAnchor();
    const navigation = { target };
    readingNavigationRef.current = navigation;
    userScrollIntentRef.current = false;
    // Detach before the selected panel resizes, even if its old start is
    // visible: a short -> long landing must not follow the new bottom.
    setPinned(false);
    revealReadingStart();
    return () => {
      if (readingNavigationRef.current !== navigation) return;
      revealReadingStart();
      readingNavigationRef.current = null;
      const current = scrollerElementRef.current;
      if (current) setPinned(isAtBottom(readMetrics(current)));
    };
  }, [revealReadingStart, setPinned]);

  const beginExplicitNavigation = useCallback((): CompleteExplicitNavigation => {
    const navigation = {};
    explicitNavigationRef.current = navigation;
    readingNavigationRef.current = null;
    cancelPrependAnchor();
    userScrollIntentRef.current = false;
    setPinned(false);
    return (target) => {
      if (explicitNavigationRef.current !== navigation) return false;
      const element = scrollerElementRef.current;
      if (element && target && element.contains(target)) {
        const top = element.getBoundingClientRect().top + element.clientTop;
        const delta = target.getBoundingClientRect().top - top;
        element.scrollTop = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + delta));
      }
      explicitNavigationRef.current = null;
      if (element) setPinned(isAtBottom(readMetrics(element)));
      return true;
    };
  }, [setPinned]);

  const reconcileAfterLayoutChange = useCallback(() => {
    const element = scrollerElementRef.current;
    if (!element) return;
    if (explicitNavigationRef.current) return;
    if (readingNavigationRef.current) {
      revealReadingStart();
      return;
    }
    if (pinnedRef.current) {
      // Suppressed: leave the position alone; re-evaluate the pin so an
      // out-of-reach bottom surfaces the "to the end" button instead of a
      // silent stale pin (the next unsuppressed reconcile follows again).
      if (!suppressFollowRef.current) followBottom();
      else setPinned(isAtBottom(readMetrics(element)));
      return;
    }
    setPinned(isAtBottom(readMetrics(element)));
  }, [followBottom, revealReadingStart, setPinned]);

  const handleScroll = useCallback(() => {
    const element = scrollerElementRef.current;
    if (!element) return;
    if (readingNavigationRef.current || explicitNavigationRef.current) return;
    if (pinnedRef.current && !userScrollIntentRef.current) {
      // Firefox can restore a nested scroll container after React's layout
      // effects have already aligned a freshly loaded chat. That browser-owned
      // scroll has no preceding user input, so it must not detach the pinned
      // view. The same rule also rejects virtualizer-owned position changes.
      followBottom();
      return;
    }
    userScrollIntentRef.current = false;
    setPinned(isAtBottom(readMetrics(element)));
  }, [followBottom, setPinned]);

  const markUserScrollIntent = useCallback(() => {
    explicitNavigationRef.current = null;
    readingNavigationRef.current = null;
    cancelPrependAnchor();
    userScrollIntentRef.current = true;
  }, [cancelPrependAnchor]);

  const markWheelScrollIntent = useCallback((event: WheelEvent) => {
    // At the bottom, a downward wheel has nowhere to go and must not leave a
    // stale intent that could legitimize a later browser-owned scroll.
    if (event.deltaY < 0 || !pinnedRef.current) markUserScrollIntent();
  }, [markUserScrollIntent]);

  const markDirectPointerIntent = useCallback((event: PointerEvent) => {
    // A scrollbar-thumb drag targets the scroller itself. Pointer presses on a
    // disclosure or message control must not be mistaken for scroll intent.
    if (event.target === event.currentTarget) markUserScrollIntent();
  }, [markUserScrollIntent]);

  const markKeyboardScrollIntent = useCallback((event: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      markUserScrollIntent();
    }
  }, [markUserScrollIntent]);

  const observeViewport = useCallback((node: HTMLElement | null) => {
    viewportObserverRef.current?.disconnect();
    viewportObserverRef.current = null;
    if (!node) return;
    const observer = new ResizeObserver(reconcileAfterLayoutChange);
    observer.observe(node);
    viewportObserverRef.current = observer;
  }, [reconcileAfterLayoutChange]);

  const scrollerRef = useCallback((node: HTMLElement | Window | null) => {
    const previous = scrollerElementRef.current;
    if (previous) {
      previous.removeEventListener("scroll", handleScroll);
      previous.removeEventListener("wheel", markWheelScrollIntent);
      previous.removeEventListener("touchmove", markUserScrollIntent);
      previous.removeEventListener("pointerdown", markDirectPointerIntent);
      previous.removeEventListener("keydown", markKeyboardScrollIntent);
    }
    const element = node instanceof HTMLElement ? node : null;
    scrollerElementRef.current = element;
    if (element) {
      element.addEventListener("scroll", handleScroll, { passive: true });
      element.addEventListener("wheel", markWheelScrollIntent, { passive: true });
      element.addEventListener("touchmove", markUserScrollIntent, { passive: true });
      element.addEventListener("pointerdown", markDirectPointerIntent, { passive: true });
      element.addEventListener("keydown", markKeyboardScrollIntent);
    }
    observeViewport(element);
  }, [handleScroll, markDirectPointerIntent, markKeyboardScrollIntent, markUserScrollIntent, markWheelScrollIntent, observeViewport]);

  const stableTailRef = useCallback((node: HTMLElement | null) => {
    stableTailObserverRef.current?.disconnect();
    stableTailObserverRef.current = null;
    if (!node) return;
    const observer = new ResizeObserver(reconcileAfterLayoutChange);
    observer.observe(node);
    stableTailObserverRef.current = observer;
  }, [reconcileAfterLayoutChange]);

  const scrollToBottom = useCallback(() => {
    explicitNavigationRef.current = null;
    readingNavigationRef.current = null;
    cancelPrependAnchor();
    setPinned(true);
    followBottom();
  }, [followBottom, setPinned, cancelPrependAnchor]);

  useLayoutEffect(() => {
    explicitNavigationRef.current = null;
    readingNavigationRef.current = null;
    cancelPrependAnchor();
    userScrollIntentRef.current = false;
    setPinned(true);
    followBottom();
  }, [followBottom, resetKey, setPinned, cancelPrependAnchor]);

  useEffect(() => {
    return () => {
      explicitNavigationRef.current = null;
      const element = scrollerElementRef.current;
      element?.removeEventListener("scroll", handleScroll);
      element?.removeEventListener("wheel", markWheelScrollIntent);
      element?.removeEventListener("touchmove", markUserScrollIntent);
      element?.removeEventListener("pointerdown", markDirectPointerIntent);
      element?.removeEventListener("keydown", markKeyboardScrollIntent);
      stableTailObserverRef.current?.disconnect();
      viewportObserverRef.current?.disconnect();
    };
  }, [handleScroll, markDirectPointerIntent, markKeyboardScrollIntent, markUserScrollIntent, markWheelScrollIntent]);

  return {
    scrollerRef,
    onScrollIntent: markUserScrollIntent,
    stableTailRef,
    onVirtualizedHeightChanged: reconcileAfterLayoutChange,
    pinned,
    scrollToBottom,
    revealStart,
    beginExplicitNavigation,
    beginPrependAnchor,
  };
}
