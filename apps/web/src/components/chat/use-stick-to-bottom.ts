import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isAtBottom, type ScrollMetrics } from "../../lib/stick-to-bottom.js";

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
 */
export function useStickToBottom(resetKey: string): StickToBottom {
  const scrollerElementRef = useRef<HTMLElement | null>(null);
  const stableTailObserverRef = useRef<ResizeObserver | null>(null);
  const viewportObserverRef = useRef<ResizeObserver | null>(null);
  const pinnedRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const [pinned, setPinnedState] = useState(true);

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

  const reconcileAfterLayoutChange = useCallback(() => {
    const element = scrollerElementRef.current;
    if (!element) return;
    if (pinnedRef.current) {
      followBottom();
      return;
    }
    setPinned(isAtBottom(readMetrics(element)));
  }, [followBottom, setPinned]);

  const handleScroll = useCallback(() => {
    const element = scrollerElementRef.current;
    if (!element) return;
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
    setPinned(true);
    followBottom();
  }, [followBottom, setPinned]);

  useLayoutEffect(() => {
    userScrollIntentRef.current = false;
    setPinned(true);
    followBottom();
  }, [followBottom, resetKey, setPinned]);

  useEffect(() => {
    return () => {
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
  };
}
