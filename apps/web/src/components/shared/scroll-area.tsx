import { ScrollArea as BaseScrollArea, type ScrollAreaRootProps } from "@base-ui/react/scroll-area";
import { useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ComponentPropsWithRef, CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { cn } from "../../lib/cn.js";

const SCROLL_ORIENTATIONS = ["vertical", "horizontal", "both"] as const;
type ScrollOrientation = (typeof SCROLL_ORIENTATIONS)[number];
type TrackOrientation = Exclude<ScrollOrientation, "both">;

interface ScrollAreaProps extends Omit<ScrollAreaRootProps, "className" | "style"> {
  className?: string;
  style?: CSSProperties;
  /** Visual rest mapping only; native scrolling is retained in both browsers. */
  scrollbarSize?: "thin" | "regular";
  /** Chrome axes: `vertical` (default) clips X, `horizontal` clips Y, `both` keeps one biaxial scroller. */
  orientation?: ScrollOrientation;
  /** Ref, accessible name, events and local layout belong to the real scroller. */
  viewportProps?: ComponentPropsWithRef<"div">;
  /** Compose the actual native editor as the vertical viewport; never nest two scrollers. */
  viewportRender?: ReactElement;
  contentClassName?: string;
}

/**
 * One invisible grab lane (the Base UI track, an absolutely positioned overlay)
 * plus its visible thumb hugging the lane's outer edge. Lane and thumb sizes
 * come from the `--vt-scrollbar-*` contract in styles.css, so hover/drag
 * expansion is paint-only — the viewport's client size never changes.
 */
function ScrollTrack({ orientation }: { orientation: TrackOrientation }) {
  // Base UI 1.9.0 exposes no dragging state: the drag latch lives in refs, and
  // `data-scrolling` is a 500ms scroll debounce that drops while a held drag
  // merely pauses. Mirror the library's own drag lifecycle — primary pointerdown
  // on the lane (thumb press or track jump-click) through release — as
  // `data-dragging`; thumb pointerup/cancel bubble through this track even while
  // the library holds pointer capture on the thumb.
  const [dragging, setDragging] = useState(false);
  const holdDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button === 0) setDragging(true);
  };
  const releaseDrag = () => setDragging(false);
  return (
    <BaseScrollArea.Scrollbar data-scroll-track data-dragging={dragging ? "" : undefined} orientation={orientation}
      onPointerDown={holdDrag} onPointerUp={releaseDrag} onPointerCancel={releaseDrag} onLostPointerCapture={releaseDrag}
      className="z-10 flex cursor-default select-none">
      <BaseScrollArea.Thumb data-scroll-thumb className={cn("rounded-full bg-border2", orientation === "vertical" ? "ms-auto" : "mt-auto")} />
    </BaseScrollArea.Scrollbar>
  );
}

/** Native scroll viewport with themed overlay chrome: 3px-at-rest thumbs (`thin`)
 * expanding to 5px only while the pointer is inside the wider invisible grab
 * lane or a drag is held, with vertical, horizontal and biaxial layouts. */
export function ScrollArea({ children, className, scrollbarSize = "regular", orientation = "vertical", viewportProps, viewportRender, contentClassName, ...props }: ScrollAreaProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const { className: viewportClassName, style: viewportStyle, ref, ...viewportAttrs } = viewportProps ?? {};
  useImperativeHandle(ref, () => viewportRef.current!, [viewportRender?.type]);
  useLayoutEffect(() => {
    // Base UI observes content/viewport resize, but a capped textarea's value
    // can change scrollHeight without resizing either. Notify its measurement
    // listener after editor renders; never move scrollTop or remount the input.
    if (viewportRender) viewportRef.current?.dispatchEvent(new Event("scroll"));
  }, [viewportRender]);
  // Editors own a single vertical scroll axis; lists clip their cross axis so
  // one lane owns the pointer edge; biaxial regions keep one scroller for both.
  const axes: ScrollOrientation = viewportRender ? "vertical" : orientation;
  const overflowClip: CSSProperties = axes === "vertical" ? { overflowX: "hidden" } : axes === "horizontal" ? { overflowY: "hidden" } : {};
  return (
    <BaseScrollArea.Root {...props} data-scroll-area={scrollbarSize} data-scroll-editor={viewportRender ? "" : undefined} className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden", className)}>
      <BaseScrollArea.Viewport {...viewportAttrs} ref={viewportRef} render={viewportRender} data-scroll-viewport
        {...(viewportRender ? { tabIndex: viewportAttrs.tabIndex ?? 0 } : {})}
        className={cn("isolate min-h-0 min-w-0 flex-auto scrollbar-hide outline-none", !viewportRender && "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent", viewportClassName)}
        style={{ ...viewportStyle, ...overflowClip }}
        children={viewportRender ? undefined : (
          // Vertical lists must fit the viewport (overriding Base UI's inline
          // fit-content minimum); horizontal/biaxial regions keep fit-content
          // so wide content genuinely overflows the single scroller.
          <BaseScrollArea.Content data-scroll-content className={contentClassName} style={axes === "vertical" ? { minWidth: 0, width: "100%" } : undefined}>{children}</BaseScrollArea.Content>
        )}
      />
      {axes !== "horizontal" && <ScrollTrack orientation="vertical" />}
      {axes !== "vertical" && <ScrollTrack orientation="horizontal" />}
      {axes === "both" && <BaseScrollArea.Corner data-scroll-corner className="pointer-events-none" />}
    </BaseScrollArea.Root>
  );
}
