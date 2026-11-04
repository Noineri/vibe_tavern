import { forwardRef } from "react";
import type { ContextProp, ScrollerProps } from "react-virtuoso";
import { MessageScrollerCore, type MessageScrollerCoreContext, type MessageScrollerCoreProps } from "../../chat/message-scroller-core.js";
import { ScrollArea } from "../scroll-area.js";

// Module-scope identity is essential: a fresh Scroller type remounts Virtuoso's
// viewport, rows and measurements on every stream flush. The forwarded ref,
// id, style and events all belong to the ScrollArea VIEWPORT, never its root.
const AgentFeedViewport = forwardRef<HTMLDivElement, ScrollerProps & ContextProp<MessageScrollerCoreContext>>(
  function AgentFeedViewport({ context, children, ...viewportProps }, ref) {
    return (
      <ScrollArea
        scrollbarSize="thin"
        className="flex-1"
        viewportProps={{ ...viewportProps, ref }}
        onPointerDownCapture={(event) => {
          // The track is a viewport sibling, so the hook's native viewport
          // listener cannot see it. Forward intent, not a second scroll loop.
          if (event.button === 0 && event.target instanceof Element
            && event.target.closest("[data-scroll-track]")?.parentElement === event.currentTarget) context.onScrollIntent();
        }}
      >
        {children}
      </ScrollArea>
    );
  },
);

/** Agent-only thin-lane adapter: ScrollArea and Virtuoso share one native
 * viewport; no RP stores, story-map rail or second scrolling wrapper.
 * The feed supplies its render partition, jump affordance and recovery scope. */
export function AgentFeedScroller(props: Omit<MessageScrollerCoreProps, "scrollerComponent">) {
  return <MessageScrollerCore {...props} scrollerComponent={AgentFeedViewport} />;
}
