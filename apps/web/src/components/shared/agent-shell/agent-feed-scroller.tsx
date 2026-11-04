import { forwardRef } from "react";
import type { ContextProp, ScrollerProps } from "react-virtuoso";
import { MessageScrollerCore, type MessageScrollerCoreContext, type MessageScrollerCoreProps } from "../../chat/message-scroller-core.js";
import { ScrollArea } from "../scroll-area.js";
import { distanceFromBottom, type ScrollMetrics } from "../../../lib/stick-to-bottom.js";
import { notifyScrollLayout } from "../../chat/scroll-layout-notification.js";

// Existing agent-list-scroll policy, not a change to the RP core's 2px rule.
function isAtAgentBottom(metrics: ScrollMetrics): boolean {
  return distanceFromBottom(metrics) < 40;
}

function notifyLaneLayout(viewport: HTMLElement): void {
  // Virtuoso's inner viewport is absolutely positioned: Base UI's normal-flow
  // Content wrapper does not grow with it. The core already observes its tail
  // and receives totalListHeightChanged for the prefix; forward those measured
  // changes using ScrollArea's existing native-editor remeasurement idiom.
  // This refreshes thumb geometry even while reading away from the bottom.
  notifyScrollLayout(viewport);
}

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
export function AgentFeedScroller(props: Omit<MessageScrollerCoreProps, "scrollerComponent" | "isAtBottom" | "onViewportLayoutChange">) {
  return <MessageScrollerCore {...props} scrollerComponent={AgentFeedViewport}
    isAtBottom={isAtAgentBottom} onViewportLayoutChange={notifyLaneLayout} />;
}
