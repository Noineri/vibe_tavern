import { ScrollArea as BaseScrollArea, type ScrollAreaRootProps } from "@base-ui/react/scroll-area";
import { useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { ComponentPropsWithRef, CSSProperties, ReactElement } from "react";
import { cn } from "../../lib/cn.js";

interface ScrollAreaProps extends Omit<ScrollAreaRootProps, "className" | "style"> {
  className?: string;
  style?: CSSProperties;
  /** Visual width only; native scrolling is retained in both browsers. */
  scrollbarSize?: "thin" | "regular";
  /** Ref, accessible name, events and local layout belong to the real scroller. */
  viewportProps?: ComponentPropsWithRef<"div">;
  /** Compose the actual native editor as viewport; never nest two scrollers. */
  viewportRender?: ReactElement;
  contentClassName?: string;
}

/** Vertical native viewport with browser-independent themed scrollbar chrome. */
export function ScrollArea({ children, className, scrollbarSize = "regular", viewportProps, viewportRender, contentClassName, ...props }: ScrollAreaProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const { className: viewportClassName, style: viewportStyle, ref, ...viewportAttrs } = viewportProps ?? {};
  useImperativeHandle(ref, () => viewportRef.current!, [viewportRender?.type]);
  useLayoutEffect(() => {
    // Base UI observes content/viewport resize, but a capped textarea's value
    // can change scrollHeight without resizing either. Notify its measurement
    // listener after editor renders; never move scrollTop or remount the input.
    if (viewportRender) viewportRef.current?.dispatchEvent(new Event("scroll"));
  }, [viewportRender]);
  return (
    <BaseScrollArea.Root {...props} data-scroll-area={scrollbarSize} data-scroll-editor={viewportRender ? "" : undefined} className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden", className)}>
      <BaseScrollArea.Viewport {...viewportAttrs} ref={viewportRef} render={viewportRender} data-scroll-viewport
        {...(viewportRender ? { tabIndex: viewportAttrs.tabIndex ?? 0 } : {})}
        className={cn("isolate min-h-0 min-w-0 flex-auto scrollbar-hide outline-none", !viewportRender && "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent", viewportClassName)}
        style={{ ...viewportStyle, overflowX: "hidden" }}
        children={viewportRender ? undefined : (
          // Vertical lists must fit the viewport; override Base UI's inline fit-content minimum.
          <BaseScrollArea.Content data-scroll-content className={contentClassName} style={{ minWidth: 0, width: "100%" }}>{children}</BaseScrollArea.Content>
        )}
      />
      <BaseScrollArea.Scrollbar data-scroll-track orientation="vertical"
        className={cn("z-10 flex cursor-default select-none", scrollbarSize === "thin" ? "w-[3px]" : "w-2")}>
        <BaseScrollArea.Thumb data-scroll-thumb className="w-full rounded-full bg-border2" />
      </BaseScrollArea.Scrollbar>
    </BaseScrollArea.Root>
  );
}
