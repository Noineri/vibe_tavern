import { createContext, forwardRef, useCallback, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { ContextProp, ScrollerProps } from "react-virtuoso";
import { MessageScrollerCore, type MessageScrollerCoreContext, type MessageScrollerCoreProps } from "../../chat/message-scroller-core.js";
import { ScrollArea } from "../scroll-area.js";
import { Icons } from "../icons.js";
import { distanceFromBottom, type ScrollMetrics } from "../../../lib/stick-to-bottom.js";
import { notifyScrollLayout } from "../../chat/scroll-layout-notification.js";
import { useT } from "../../../i18n/context.js";
import type { MessageScrollerCoreApi } from "../../chat/message-scroller-core.js";
import type { UseAgentFeedResult } from "./use-agent-feed.js";

const FeedbackContext = createContext<UseAgentFeedResult | null>(null);
export function AgentFeedFeedbackProvider({ feed, children }: { feed: UseAgentFeedResult | null; children: ReactNode }) {
  return <FeedbackContext.Provider value={feed}>{children}</FeedbackContext.Provider>;
}
export function useAgentFeedFeedback(): UseAgentFeedResult | null {
  return useContext(FeedbackContext);
}

// Quiet text actions inside the transcript, not a second toolbar under the
// chat header. Authored copy wraps; phone targets retain their 44px footprint.
const ACTION = "inline-flex min-h-11 max-w-full cursor-pointer items-center justify-center gap-1.5 rounded-md bg-transparent px-2.5 py-1 text-center font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-t1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-default disabled:opacity-50 sm:min-h-7";

export function AgentFeedFeedback({ api }: { api?: MessageScrollerCoreApi }) {
  const feed = useAgentFeedFeedback();
  return feed === null ? null : <FeedFeedback feed={feed} api={api} />;
}

function FeedFeedback({ feed, api }: { feed: UseAgentFeedResult; api?: MessageScrollerCoreApi }) {
  const { t } = useT();
  const pending = useRef<{ start: UseAgentFeedResult["feed"]; restore: () => void; complete: () => boolean } | null>(null);
  const readingAnchor = useRef<string | null>(null);
  const busy = feed.loadingOlder || feed.loadingAround || feed.refreshing;
  const disabled = busy || (api !== undefined && api.scrollerElement === null);
  const rememberReadingAnchor = useCallback(() => {
    const viewport = api?.scrollerElement;
    if (!viewport || viewport.clientHeight <= 0) return;
    const top = viewport.getBoundingClientRect().top + viewport.clientTop;
    for (const row of viewport.querySelectorAll<HTMLElement>('[data-scroller-message-id^="msg:"]')) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= top + 1 || rect.top >= top + viewport.clientHeight) continue;
      const id = row.getAttribute("data-scroller-message-id")!.slice(4);
      readingAnchor.current = id;
      feed.setReadingAnchor(id);
      break;
    }
  }, [api?.scrollerElement, feed.setReadingAnchor]);
  useEffect(() => {
    const viewport = api?.scrollerElement;
    if (!viewport) return;
    viewport.addEventListener("scroll", rememberReadingAnchor, { passive: true });
    rememberReadingAnchor();
    return () => viewport.removeEventListener("scroll", rememberReadingAnchor);
  }, [api?.scrollerElement, rememberReadingAnchor]);
  useLayoutEffect(() => {
    const operation = pending.current;
    if (!operation) return;
    if (operation.start !== feed.feed) {
      operation.restore();
      operation.restore = () => {};
    }
    if (!busy) {
      operation.complete();
      pending.current = null;
    }
  }, [feed.feed, busy]);
  const request = (action: () => void) => {
    if (disabled) return;
    rememberReadingAnchor();
    if (api) {
      const complete = api.beginExplicitNavigation();
      // Keep the core's one anchor through delayed virtual measurements;
      // explicit reader input/navigation still cancels it in the core.
      pending.current = { start: feed.feed, restore: api.beginPrependAnchor(true), complete };
    }
    action();
  };
  if (feed.feed === null) return <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
    {feed.error !== null ? <>
      <p role="alert">{t("agent_feed_load_error")}</p>
      <button type="button" className={ACTION} onClick={feed.retry}>{t("agent_retry")}</button>
    </> : <p role="status">{t("agent_feed_loading")}</p>}
  </div>;
  const oldest = feed.feed.windows[0];
  const needsRevalidation = oldest?.stale === true;
  const canLoadOlder = oldest && (oldest.hasOlder || needsRevalidation);
  const errors = [
    { error: feed.olderError, label: "agent_feed_older_error", retry: feed.loadOlder },
    { error: feed.aroundError, label: "agent_feed_around_error", retry: () => {
      const anchor = readingAnchor.current ?? oldest?.messages[0]?.id;
      if (anchor) feed.loadAround(anchor); else feed.refresh();
    } },
    { error: feed.refreshError, label: "agent_feed_refresh_error", retry: feed.refresh },
  ] as const;
  if (!oldest && !busy && errors.every(({ error }) => error === null)) return null;
  return <div data-testid="agent-feed-feedback" className="flex min-w-0 flex-col items-center justify-center gap-1 px-4 py-1 text-center font-ui text-[calc(var(--ui-fs)-3px)] text-t3" aria-busy={busy}>
    {canLoadOlder && <button type="button" className={ACTION} disabled={disabled} aria-label={t(needsRevalidation ? "agent_feed_revalidate" : "agent_feed_load_older")} onClick={() => request(feed.loadOlder)}>
      {feed.loadingOlder ? <span role="status">{t("agent_feed_loading_older")}</span> : <><Icons.Caret direction="u" /><span>{t(needsRevalidation ? "agent_feed_revalidate" : "agent_feed_load_older")}</span></>}
    </button>}
    {busy && (!feed.loadingOlder || !canLoadOlder) && <p role="status">{t(feed.loadingOlder ? "agent_feed_loading_older" : "agent_feed_refreshing")}</p>}
    {errors.map(({ error, label, retry }) => error === null ? null : <div key={label} className="flex min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1">
      <p role="alert">{t(label)}</p>
      <button type="button" className={ACTION} disabled={disabled} onClick={() => request(retry)}>{t("agent_retry")}</button>
    </div>)}
    {feed.feed.windows.length > 1 && <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1">
      <p>{t("agent_feed_gap")}</p>
      <button type="button" className={ACTION} disabled={disabled} onClick={() => request(feed.refresh)}>{t("agent_feed_fill_gap")}</button>
    </div>}
    {oldest && !oldest.hasOlder && !needsRevalidation && <p>{t("agent_feed_start")}</p>}
  </div>;
}

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
export function AgentFeedScroller({ renderHeader, ...props }: Omit<MessageScrollerCoreProps, "scrollerComponent" | "isAtBottom" | "onViewportLayoutChange">) {
  return <MessageScrollerCore {...props} scrollerComponent={AgentFeedViewport}
    isAtBottom={isAtAgentBottom} onViewportLayoutChange={notifyLaneLayout}
    renderHeader={(api) => <><AgentFeedFeedback api={api} />{renderHeader?.(api)}</>} />;
}
