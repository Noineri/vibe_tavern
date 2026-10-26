import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePersistedNumber } from "../../hooks/use-persisted-boolean.js";
import { cn } from "../../lib/cn.js";

/**
 * One shared resizable side pane (SIDECHAT_PLAN, SC-16b; slide rework SC-16e)
 * — the single home of the side-column behaviour SC-16c reuses for scripts,
 * mini-apps and the co-author editor. First consumer: the desktop sidechat
 * panel.
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
 * - the open/close slide: the pane's inline WIDTH takes its final value in
 *   ONE step on open (and releases it in one step after the close slide), so
 *   the neighbouring column re-lays out exactly once per open/close; the
 *   visible glide is a `transform` slide (`translateX` on the shared accordion
 *   curve — `AnimatedDisclosure`'s 0.25 s `easeOut`, retimed from the rail
 *   flyouts' 0.18 s curve per owner review 2026-10-21: the slide felt too
 *   fast, match the accordion feel) inside an `overflow-hidden` clip frame,
 *   so no per-frame layout ever runs. While the line is held the slide
 *   transition is off (the pane tracks the pointer with no animation).
 *   Under `prefers-reduced-motion` both directions are instant: the
 *   `motion-reduce:transition-none` class kills the CSS while the
 *   `matchMedia` reads below skip the slide/wait logic (the dice-faces JS
 *   idiom — a transform slide needs mount logic CSS alone cannot do).
 *
 * The slide starts only after the content has painted once: the pane mounts
 * (or reopens) at its final width with the slider parked off-screen, a
 * synchronous layout read (`getBoundingClientRect`) flushes the content's
 * first measure at final size, and the slide to `translateX(0)` kicks on the
 * next task — a freshly mounted sidechat (AgentShell's first render) never
 * competes with its own animation. Which side parks off-screen follows the
 * resize edge (the pane enters from its own outer edge: `left`-edge panes
 * from the right, `right`-edge panes from the left).
 *
 * Closing keeps the pane mounted at its final width while the slider glides
 * out. The primary path is the slider's own `transitionend`, filtered to
 * `event.target === currentTarget` + `propertyName === "transform"` so child
 * transitions inside the content never unmount the pane; a 280 ms timeout
 * (0.25 s + margin) covers commits that animate nothing. Only then does the
 * outer box release the width (the neighbour widens in one step) and the
 * caller renders `closedView` (the sidechat's closed handle) — unless
 * `keepMounted` is set (SC-16c: the script/mini-app assistant panes flip the
 * same aside to `hidden` at width 0 instead of unmounting, so a running turn,
 * the input draft and the scroll position survive a collapse; the caller
 * renders its own expand tab elsewhere).
 *
 * The clip frame is an inner flex child, never the aside itself: the edge
 * chrome's outset shadows must survive at full width, so the aside keeps
 * `overflow-visible` and only the content column clips. Squeezing content
 * still carries its own `overflow-hidden` + `min-w-0` inside the slider (the
 * sidechat's content column does).
 */
export interface ResizableSidePaneProps {
  /** Pane presence: false starts the close slide, true mounts and slides in. */
  readonly open: boolean;
  /** `usePersistedNumber` key for the one shared width preference. */
  readonly storageKey: string;
  /** Resting width (px) — also the double-click reset target. */
  readonly defaultWidth: number;
  /** Static floor (px) — enforced on read, write, drag and reset. */
  readonly minWidth: number;
  /** Which pane edge carries the drag line (also the slide's outer edge). */
  readonly resizeEdge: "left" | "right";
  /** Pane content (squeezing content must clip itself — see header). */
  readonly children: ReactNode;
  /** Rendered instead of the pane once the close slide ends (default: nothing). */
  readonly closedView?: ReactNode;
  /**
   * SC-16c: keep the pane mounted while closed — after the close slide the
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
  /** Test hook for the sliding inner wrapper (the transform-transition seam). */
  readonly slideTestId?: string;
}

/** Plan-settled: the pane never takes more than half the window. */
const MAX_VIEWPORT_RATIO = 0.5;

/** 0.25 s slide + margin — fallback only; `transitionend` is the primary close path. */
const CLOSE_FALLBACK_MS = 280;

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

/** Parked off-screen offset for the slider — the pane enters from its own outer edge. */
function slideOffsetFor(resizeEdge: "left" | "right"): string {
  return resizeEdge === "left" ? "translateX(100%)" : "translateX(-100%)";
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
  slideTestId,
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

  // Mount + slide state: `visible` keeps the pane up while the close slide
  // runs; `slidIn` parks the slider off-screen (false) or at rest (true).
  // The width is DERIVED — always the final target while shown — so the
  // neighbour steps once per open/close and no width transition ever runs
  // (a window resize re-clamps the render without touching stored intent,
  // with no kick/drag/close guards needed).
  const [visible, setVisible] = useState(open);
  const [slidIn, setSlidIn] = useState(false);
  const [dragging, setDragging] = useState(false);
  const slideRef = useRef<HTMLDivElement>(null);
  const closeTokenRef = useRef(0);
  const closeFallbackRef = useRef(0);
  const closingRef = useRef(false);

  // Open parks the slider off-screen at the final width (the neighbour steps
  // once, on this commit); the paint-gate effect below starts the slide.
  // Close glides the slider out while the width HOLDS the target; the
  // unmount (and the width release) waits for the slider's `transitionend`.
  useEffect(() => {
    if (open) {
      closingRef.current = false;
      closeTokenRef.current += 1;
      window.clearTimeout(closeFallbackRef.current);
      setVisible(true);
      setSlidIn(readReducedMotion());
      return;
    }
    if (!visible) return;
    if (readReducedMotion()) {
      setVisible(false);
      return;
    }
    closingRef.current = true;
    setSlidIn(false);
    const token = (closeTokenRef.current += 1);
    window.clearTimeout(closeFallbackRef.current);
    closeFallbackRef.current = window.setTimeout(() => {
      if (closeTokenRef.current === token && !openRef.current) {
        closingRef.current = false;
        setVisible(false);
      }
    }, CLOSE_FALLBACK_MS);
  }, [open, visible]);

  // Paint gate (SC-16e): the slide starts only after the content has painted
  // once. The offset commit above is already in the DOM here, so a
  // synchronous layout read measures the content at its final size, and the
  // next-task kick moves the slider to rest — the transition glides from a
  // painted frame, never from mount. Skipped while held (the pane tracks the
  // pointer, never the slide) and under reduced motion (instant).
  useEffect(() => {
    if (!open || !visible || slidIn || dragging || readReducedMotion()) return;
    void slideRef.current?.getBoundingClientRect();
    const kick = window.setTimeout(() => {
      setSlidIn(true);
    }, 0);
    return () => {
      window.clearTimeout(kick);
    };
  }, [open, visible, slidIn, dragging]);

  // A pending close fallback never outlives the pane (a late fire into the
  // next tree is a cross-test leak under the shared worker pool); the slide
  // kick above owns its own cleanup.
  useEffect(
    () => () => {
      window.clearTimeout(closeFallbackRef.current);
    },
    [],
  );

  // Border drag (the GalleryViewer viewport-pan pattern, moved here from
  // `SidechatPanel`): mousedown records the start, window-level move/up
  // listeners carry the gesture so fast pointer travel off the 6 px strip
  // never drops it. The width follows the stored value directly (no
  // transition on the box, none on the slider while held); grabbing
  // mid-slide snaps the slider to rest so the clip never fights the pointer.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onDragMove = useCallback(
    (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = resizeEdge === "left" ? drag.startX - event.clientX : event.clientX - drag.startX;
      const raw = drag.startWidth + delta;
      const next = Math.min(Math.max(raw, minWidth), maxWidthFor(readViewportWidth(), minWidth));
      setStoredWidth(next);
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
    // A grab landing inside the close slide is dropped: the pane is
    // unmounting, and cancelling the close is the caller's (open-state)
    // decision, not the line's.
    if (event.button !== 0 || closingRef.current) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: paneTargetRef.current };
    setSlidIn(true);
    setDragging(true);
  };
  // Double-click restores the default through the same clamp/write path as a
  // drag (the box takes it instantly — width never transitions).
  const onResizeReset = () => {
    const next = Math.min(Math.max(defaultWidth, minWidth), maxWidthFor(readViewportWidth(), minWidth));
    setStoredWidth(next);
  };

  const onSlideTransitionEnd = (event: React.TransitionEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "transform") return;
    if (openRef.current || readReducedMotion()) return;
    closingRef.current = false;
    closeTokenRef.current += 1;
    window.clearTimeout(closeFallbackRef.current);
    setVisible(false);
  };

  // SC-16c: the assistant panes hide instead of unmounting. `closedHidden`
  // flips only on the settled frame (the close slide above still runs first),
  // and the aside element NEVER branches — open, sliding and hidden frames
  // render the identical JSX (same strip, same clip, same slider order), so
  // React updates props in place and no child (turn feed, draft, scroll)
  // ever remounts. Verified the hard way: an early shape rendered a separate
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

  // No transition on the box, ever: it takes the final width in one step.
  // Only the slider animates (`transform`), parked off-screen until the
  // paint gate kicks it to rest — except while held, when it sits at rest
  // with no transition and the box tracks the pointer in real time.
  const renderedWidth = closedHidden ? 0 : paneTarget;
  const sliderTransform = dragging || slidIn ? undefined : slideOffsetFor(resizeEdge);
  return (
    <aside
      data-testid={panelTestId}
      style={{ width: renderedWidth }}
      // `flex`/`hidden` are exclusive by construction (never composed
      // together — `cn` is join-only, so stacking both would resolve by
      // stylesheet order instead of intent); the direction/shrink tokens
      // are inert without a flex display and stay put in both frames.
      className={cn("relative shrink-0 flex-col", closedHidden ? "hidden" : "flex", className)}
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
      {/* Clip frame for the slide (the aside itself never clips — see header). */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div
          ref={slideRef}
          data-testid={slideTestId}
          onTransitionEnd={onSlideTransitionEnd}
          style={sliderTransform === undefined ? undefined : { transform: sliderTransform }}
          className={cn(
            "flex h-full w-full flex-col",
            dragging
              ? "transition-none"
              : "transition-[transform_0.25s_ease-out] motion-reduce:transition-none",
          )}
        >
          {children}
        </div>
      </div>
    </aside>
  );
}
