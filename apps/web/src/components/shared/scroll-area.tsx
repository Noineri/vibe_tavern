import { ScrollArea as BaseScrollArea, type ScrollAreaRootProps } from "@base-ui/react/scroll-area";
import type { ComponentPropsWithRef, CSSProperties } from "react";
import { cn } from "../../lib/cn.js";

interface ScrollAreaProps extends Omit<ScrollAreaRootProps, "className" | "style"> {
  className?: string;
  style?: CSSProperties;
  /** Visual width only; native scrolling is retained in both browsers. */
  scrollbarSize?: "thin" | "regular";
  /** Ref, accessible name, events and local layout belong to the real scroller. */
  viewportProps?: ComponentPropsWithRef<"div">;
  contentClassName?: string;
}

/** Vertical native viewport with browser-independent themed scrollbar chrome. */
export function ScrollArea({ children, className, scrollbarSize = "regular", viewportProps, contentClassName, ...props }: ScrollAreaProps) {
  const { className: viewportClassName, style: viewportStyle, ...viewportAttrs } = viewportProps ?? {};
  return (
    <BaseScrollArea.Root {...props} data-scroll-area={scrollbarSize} className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden", className)}>
      <BaseScrollArea.Viewport {...viewportAttrs} data-scroll-viewport
        className={cn("isolate min-h-0 min-w-0 flex-auto scrollbar-hide outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent", viewportClassName)}
        style={{ ...viewportStyle, overflowX: "hidden" }}>
        <BaseScrollArea.Content data-scroll-content className={cn("min-w-0", contentClassName)}>
          {children}
        </BaseScrollArea.Content>
      </BaseScrollArea.Viewport>
      <BaseScrollArea.Scrollbar data-scroll-track orientation="vertical"
        className={cn("z-10 flex cursor-default select-none", scrollbarSize === "thin" ? "w-[3px]" : "w-2")}>
        <BaseScrollArea.Thumb data-scroll-thumb className="w-full rounded-full bg-border2" />
      </BaseScrollArea.Scrollbar>
    </BaseScrollArea.Root>
  );
}
