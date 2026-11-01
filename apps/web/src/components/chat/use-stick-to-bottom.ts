import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isAtBottom, type ScrollMetrics } from "../../lib/stick-to-bottom.js";
import type { RevealMessageStart } from "./message-scroll-context.js";

/** A stale completion must not align a row or change the pin. */
export type CompleteExplicitNavigation = (target?: HTMLElement | null) => boolean;

export interface StickToBottom {
  /** Attach to the overflow container. */
  scrollerRef: (node: HTMLElement | Window | null) => void;
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

  const revealStart = useCallback<RevealMessageStart>((target) => {
    const element = scrollerElementRef.current;
    if (!element?.contains(target)) return () => {};
    explicitNavigationRef.current = null;
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
    userScrollIntentRef.current = true;
  }, []);

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
    setPinned(true);
    followBottom();
  }, [followBottom, setPinned]);

  useLayoutEffect(() => {
    explicitNavigationRef.current = null;
    readingNavigationRef.current = null;
    userScrollIntentRef.current = false;
    setPinned(true);
    followBottom();
  }, [followBottom, resetKey, setPinned]);

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
    stableTailRef,
    onVirtualizedHeightChanged: reconcileAfterLayoutChange,
    pinned,
    scrollToBottom,
    revealStart,
    beginExplicitNavigation,
  };
}
