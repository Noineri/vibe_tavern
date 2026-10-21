import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePersistedNumber } from "../../hooks/use-persisted-boolean.js";
import { cn } from "../../lib/cn.js";

/**
 * One shared resizable side pane (SIDECHAT_PLAN, SC-16b) — the single home of
 * the side-column behaviour SC-16c reuses for scripts, mini-apps and the
 * co-author editor. First consumer: the desktop sidechat panel.
 *
 * Owns, so no consumer copies it:
 * - the width drag line on a chosen edge (the GalleryViewer viewport-pan
 *   pattern: mousedown on the 6 px `col-resize` strip → window
 *   mousemove/mouseup with a start ref, so fast pointer travel off the strip
 *   never drops the gesture; `hover:bg-accent/60`, `bg-accent` while held);
 * - the width clamp (static min via `usePersistedNumber`, max = half the live
 *   window width, re-clamped on window resize without touching stored intent);
 * - the persisted width (`usePersistedNumber` under the caller's key);
 * - double-click on the line → the default width through the same clamp/write
 *   path as a drag;
 * - the open/close animation: the pane's inline WIDTH glides 0 → target on
 *   open and back to 0 on close (`transition-[width_0.18s_ease-out]` — the
 *   rail flyouts' `flyoutIn` curve, no new curve), so the neighbouring column
 *   follows in layout. While the line is held the transition is off (the line
 *   never lags the pointer). Under `prefers-reduced-motion` both directions
 *   are instant: the `motion-reduce:transition-none` class kills the CSS while
 *   the `matchMedia` reads below skip the mount/kick/wait logic (the
 *   dice-faces JS idiom — a width transition needs mount logic CSS alone
 *   cannot do).
 *
 * Closing keeps the pane mounted until its close glide ends. The primary path
 * is the aside's own `transitionend`, filtered to `event.target ===
 * currentTarget` + `propertyName === "width"` so child transitions inside the
 * content never unmount the pane; a 200 ms timeout (0.18 s + margin) covers
 * commits that animate nothing. After that the pane unmounts and the caller
 * renders `closedView` (the sidechat's closed handle) — unless `keepMounted`
 * is set (SC-16c: the script/mini-app assistant panes flip the same aside
 * to `hidden` at width 0 instead of unmounting, so a running turn, the
 * input draft and the scroll position survive a collapse; the caller
 * renders its own expand tab elsewhere).
 *
 * The pane never clips its children itself: the edge chrome's outset shadows
 * must survive at full width, so squeezing content carries its own
 * `overflow-hidden` + `min-w-0` (the sidechat's content column does).
 */
export interface ResizableSidePaneProps {
  /** Pane presence: false starts the close glide, true mounts and opens. */
  readonly open: boolean;
  /** `usePersistedNumber` key for the one shared width preference. */
  readonly storageKey: string;
  /** Resting width (px) — also the double-click reset target. */
  readonly defaultWidth: number;
  /** Static floor (px) — enforced on read, write, drag and reset. */
  readonly minWidth: number;
  /** Which pane edge carries the drag line. */
  readonly resizeEdge: "left" | "right";
  /** Pane content (squeezing content must clip itself — see header). */
  readonly children: ReactNode;
  /** Rendered instead of the pane once the close glide ends (default: nothing). */
  readonly closedView?: ReactNode;
  /**
   * SC-16c: keep the pane mounted while closed — after the close glide the
   * pane renders as a `hidden` zero-width aside (children alive) instead of
   * unmounting, and `closedView` is ignored (the caller overlays its own
   * expand tab). Absent/false = the SC-16b sidechat contract byte-identical.
   */
  readonly keepMounted?: boolean;
  /** Extends the pane chrome (`cn` is join-only — appended, never replaced). */
  readonly className?: string;
  /** Test hook for the pane element (suites pin behaviour through it). */
  readonly panelTestId?: string;
  /** Test hook for the drag line. */
  readonly resizeHandleTestId?: string;
}

/** Plan-settled: the pane never takes more than half the window. */
const MAX_VIEWPORT_RATIO = 0.5;

/** 0.18 s glide + margin — fallback only; `transitionend` is the primary close path. */
const CLOSE_FALLBACK_MS = 200;

/** System reduced-motion query (the dice-faces / Logo JS idiom). */
const REDUCED_MOTION_MQ = "(prefers-reduced-motion: reduce)";

/** Live viewport width for the relative max (subscribers re-render on resize). */
function readViewportWidth(): number {
  if (typeof window === "undefined") return 1024;
  return window.innerWidth || 1024;
}

/** The viewport-ratio max at clamp time, never below the static min. */
function maxWidthFor(viewportWidth: number, minWidth: number): number {
  return Math.max(minWidth, Math.floor(viewportWidth * MAX_VIEWPORT_RATIO));
}

function readReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(REDUCED_MOTION_MQ).matches;
  } catch {
    return false;
  }
}

export function ResizableSidePane({
  open,
  storageKey,
  defaultWidth,
  minWidth,
  resizeEdge,
  children,
  closedView,
  keepMounted = false,
  className,
  panelTestId,
  resizeHandleTestId,
}: ResizableSidePaneProps) {
  const [storedWidth, setStoredWidth] = usePersistedNumber(storageKey, defaultWidth, { min: minWidth });
  const [viewportWidth, setViewportWidth] = useState(readViewportWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(readViewportWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const liveMax = maxWidthFor(viewportWidth, minWidth);
  const paneTarget = Math.min(Math.max(storedWidth, minWidth), liveMax);
  const paneTargetRef = useRef(paneTarget);
  paneTargetRef.current = paneTarget;
  const openRef = useRef(open);
  openRef.current = open;

  // Mount + glide state: `visible` keeps the pane up while the close glide
  // runs; `animatedWidth` is the width style except while held (then the
  // target tracks the pointer with the transition off).
  const [visible, setVisible] = useState(open);
  const [animatedWidth, setAnimatedWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const kickRef = useRef<number>(0);
  const kickPendingRef = useRef(false);
  const closeTokenRef = useRef(0);
  const closeFallbackRef = useRef<number>(0);
  const closingRef = useRef(false);

  // Open mounts the pane at width 0 and kicks it to the target on the next
  // task (the committed 0 → target change is what the CSS transition glides;
  // the kick's pending window is also what the suites observe as the 0
  // phase). Close glides back to 0; the unmount waits for `transitionend`.
  useEffect(() => {
    if (open) {
      closingRef.current = false;
      closeTokenRef.current += 1;
      window.clearTimeout(closeFallbackRef.current);
      setVisible(true);
      if (readReducedMotion()) {
        setAnimatedWidth(paneTargetRef.current);
        return;
      }
      setAnimatedWidth(0);
      kickPendingRef.current = true;
      kickRef.current = window.setTimeout(() => {
        kickPendingRef.current = false;
        setAnimatedWidth(paneTargetRef.current);
      }, 0);
      return () => {
        window.clearTimeout(kickRef.current);
        kickPendingRef.current = false;
      };
    }
    if (!visible) return;
    if (readReducedMotion()) {
      setVisible(false);
      setAnimatedWidth(0);
      return;
    }
    closingRef.current = true;
    setAnimatedWidth(0);
    const token = (closeTokenRef.current += 1);
    window.clearTimeout(closeFallbackRef.current);
    closeFallbackRef.current = window.setTimeout(() => {
      if (closeTokenRef.current === token && !openRef.current) {
        closingRef.current = false;
        setVisible(false);
      }
    }, CLOSE_FALLBACK_MS);
  }, [open, visible]);

  // A window resize re-clamps the rendered width without touching the stored
  // intent (the SC-14 contract); the glide follows since the transition is
  // on. Skipped while the open kick is pending (the kick carries the latest
  // target), while held (the render path tracks the pointer directly), and
  // while closing (the pane is heading to 0).
  useEffect(() => {
    if (!open || !visible || dragging || closingRef.current || kickPendingRef.current) return;
    setAnimatedWidth(paneTarget);
  }, [open, visible, dragging, paneTarget]);

  // Pending timers never outlive the pane (a late kick or fallback firing
  // into the next tree is a cross-test leak under the shared worker pool).
  useEffect(
    () => () => {
      window.clearTimeout(kickRef.current);
      window.clearTimeout(closeFallbackRef.current);
    },
    [],
  );

  // Border drag (the GalleryViewer viewport-pan pattern, moved here from
  // `SidechatPanel`): mousedown records the start, window-level move/up
  // listeners carry the gesture so fast pointer travel off the 6 px strip
  // never drops it.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onDragMove = useCallback(
    (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = resizeEdge === "left" ? drag.startX - event.clientX : event.clientX - drag.startX;
      const raw = drag.startWidth + delta;
      const next = Math.min(Math.max(raw, minWidth), maxWidthFor(readViewportWidth(), minWidth));
      setStoredWidth(next);
      setAnimatedWidth(next);
    },
    [resizeEdge, minWidth, setStoredWidth],
  );
  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
  }, []);
  useEffect(() => {
    if (!dragging) return;
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
    return () => {
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragEnd);
    };
  }, [dragging, onDragMove, onDragEnd]);
  const onDragStart = (event: React.MouseEvent<HTMLDivElement>) => {
    // A grab landing inside the close glide is dropped: the pane is
    // unmounting, and cancelling the close is the caller's (open-state)
    // decision, not the line's.
    if (event.button !== 0 || closingRef.current) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: paneTargetRef.current };
    setDragging(true);
  };
  // Double-click restores the default through the same clamp/write path as a
  // drag (hook setter = static clamp, live max by hand).
  const onResizeReset = () => {
    const next = Math.min(Math.max(defaultWidth, minWidth), maxWidthFor(readViewportWidth(), minWidth));
    setStoredWidth(next);
    setAnimatedWidth(next);
  };

  const onWidthTransitionEnd = (event: React.TransitionEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "width") return;
    if (openRef.current || readReducedMotion()) return;
    closingRef.current = false;
    closeTokenRef.current += 1;
    window.clearTimeout(closeFallbackRef.current);
    setVisible(false);
  };

  // SC-16c: the assistant panes hide instead of unmounting. `closedHidden`
  // flips only on the settled frame (the close glide above still runs first),
  // and the aside element NEVER branches — open, gliding and hidden frames
  // render the identical JSX (same strip, same children order), so React
  // updates props in place and no child (turn feed, draft, scroll) ever
  // remounts. Verified the hard way: an early shape rendered a separate
  // hidden aside at settle, and the child-array shift across the swap
  // remounted the content and lost the draft — the suite pins the draft on
  // the same node now. `hidden` takes no layout space, so the editor never
  // shifts; the drag strip stays mounted inside it (inert under
  // display:none — no pointer or a11y presence), because removing it at
  // settle would be another child-array shift. `closedView` is ignored (the
  // caller overlays its own expand tab); without `keepMounted` the SC-16b
  // unmount contract below is byte-identical.
  const closedHidden = keepMounted && !visible;
  if (!visible && !keepMounted) return <>{closedView ?? null}</>;

  // While held the width tracks the pointer with no transition; otherwise the
  // glide state drives (open kick, close glide, resize re-clamp, reset).
  const renderedWidth = dragging ? paneTarget : animatedWidth;
  return (
    <aside
      data-testid={panelTestId}
      onTransitionEnd={onWidthTransitionEnd}
      style={{ width: closedHidden ? 0 : renderedWidth }}
      // `flex`/`hidden` are exclusive by construction (never composed
      // together — `cn` is join-only, so stacking both would resolve by
      // stylesheet order instead of intent); the direction/shrink tokens
      // are inert without a flex display and stay put in both frames.
      className={cn(
        "relative shrink-0 flex-col",
        closedHidden ? "hidden" : "flex",
        dragging ? "transition-none" : "transition-[width_0.18s_ease-out] motion-reduce:transition-none",
        className,
      )}
    >
      {/* Width drag strip on the resize edge (`col-resize`); double-click resets. */}
      <div
        data-testid={resizeHandleTestId}
        onMouseDown={onDragStart}
        onDoubleClick={onResizeReset}
        className={cn(
          "absolute top-0 bottom-0 z-10 w-1.5 cursor-col-resize select-none",
          resizeEdge === "left" ? "left-0" : "right-0",
          dragging ? "bg-accent" : "bg-transparent hover:bg-accent/60",
        )}
      />
      {children}
    </aside>
  );
}
