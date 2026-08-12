import { useMemo } from "react";
import { Virtuoso } from "react-virtuoso";
import type { ReactNode } from "react";
import type { Components } from "react-virtuoso";
import { useChatStore, useIsSending } from "../../stores/chat-store.js";
import { useMessageOrder } from "../../stores/index.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { TranslateErrorBoundary } from "../layout/TranslateErrorBoundary.js";
import { useT } from "../../i18n/context.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { cn } from "../../lib/cn.js";
import { useStickToBottom } from "./use-stick-to-bottom.js";
import { FollowBottomContext } from "./follow-bottom-context.js";

/**
 * Flat-list display-id derivation: the visible message sequence BEFORE any
 * turn grouping. Filters out `role: "tool"` messages (they render inside their
 * owning assistant turn) and appends synthetic `__pending-*` placeholders while
 * a generation is in flight so the UI can show the in-progress user/assistant
 * turn before the server persists it.
 *
 * Shared by the RP and Co-Author flat renderers today. CS-31 (co-author turn
 * grouping) will give Co-Author its own grouped-id derivation; this hook stays
 * the RP flat-list source of truth.
 *
 * The subscriptions are deliberately narrow: `pendingUserMessageContent` comes
 * from a pinpoint selector rather than `useActiveGeneration()`. The wide
 * selector returned the whole generation object, which is recreated on every
 * reveal tick, and re-rendered the entire message list 60 times a second.
 */
export function useDisplayMessageIds(): string[] {
  const messageOrder = useMessageOrder();
  const isSending = useIsSending();
  const pendingUserMessageContent = useChatStore((s) =>
    s.activeChatId ? (s.generations[s.activeChatId]?.pendingUserMessageContent ?? null) : null,
  );
  const lastPersistedMessage = useSnapshotStore((s) => {
    const lastMessageId = s.messageOrder[s.messageOrder.length - 1];
    return lastMessageId ? s.messagesById[lastMessageId] : null;
  });

  return useMemo(() => {
    const state = useSnapshotStore.getState();
    const ids = messageOrder.filter(id => state.messagesById[id]?.role !== "tool");

    if (pendingUserMessageContent) {
      const lastMsg = lastPersistedMessage;
      const alreadyPersisted =
        lastMsg?.role === "user" &&
        lastMsg.content.trim() === pendingUserMessageContent.trim();

      if (!alreadyPersisted) {
        ids.push("__pending-user");
      }
      ids.push("__pending-assistant");
    } else if (isSending && lastPersistedMessage?.role === "user") {
      ids.push("__pending-assistant");
    }

    return ids;
  }, [messageOrder, pendingUserMessageContent, lastPersistedMessage, isSending]);
}

export interface MessageScrollerProps {
  /**
   * Ordered list of message ids (plus synthetic `__pending-*` ids, if any) to
   * render. Computed by the caller (RP vs co-author have different derivation
   * rules). Passed straight to Virtuoso as the key/total source of truth.
   */
  displayIds: string[];
  /**
   * Render one item. Receives the resolved messageId (or pending id) at the
   * given index. Mode-specific derivations (e.g. RP's prevRole / isFirstAssistant)
   * live inside each caller's renderItem — the scroller itself is mode-agnostic.
   */
  renderItem: (index: number, messageId: string) => ReactNode;
}

// Hoisted to module scope: declared inside the component body they got a fresh
// identity on every render, which made Virtuoso remount them and re-trigger
// height measurements.
const Header = () => <div style={{ height: 28 }} />;
const Footer = () => <div style={{ height: 12 }} />;

/**
 * Item wrapper. Identical to the default one except for `display: flow-root`,
 * and that one property is load-bearing.
 *
 * Message blocks space themselves with vertical margins. A plain block wrapper
 * lets a child's margin escape its box, so the wrapper's measured height — which
 * is what Virtuoso records — comes out ~8px short per item, while the DOM
 * carries the full gap. The virtualizer's model of the content then sits below
 * the real scrollHeight (measured in Firefox: 323px across 18 items), it places
 * "the bottom" that much too high, and it drags the position back there every
 * time we drive to the real bottom. That tug-of-war is what made a reload land
 * anywhere between "fine" and "half a message hidden behind the composer",
 * depending on which side moved last.
 *
 * `flow-root` gives the wrapper its own block formatting context, so the margins
 * stay inside and the measured height matches what the DOM lays out. Measured
 * after the change: item gaps 0, distance-to-bottom 0 in both engines.
 */
const Item: NonNullable<Components["Item"]> = ({ children, style, item, context, ...rest }) => (
  <div {...rest} style={{ ...style, display: "flow-root" }}>
    {children}
  </div>
);

const components = { Header, Footer, Item };

/**
 * Reusable virtualized message scroller.
 *
 * Shared by RP (`MessageList`) and Co-Author (`CoauthorMessageList`); they
 * differ only in how `displayIds` is derived and how an item renders, and the
 * scroll behaviour has to be identical.
 *
 * All scroll handling lives in `useStickToBottom` and reduces to one rule:
 * `pinned` = the viewport is at the bottom; content grew while `pinned` → drive
 * to the bottom. There are no timers here, no rAF loops, no wheel/touch
 * listeners and no notion of a "generation" or an "end of stream" — deliberately
 * so: the previous implementation consisted of six such mechanisms, one of which
 * was dead code and two of which fought over effect ordering.
 *
 * There is intentionally NO `followOutput` prop: per the library's own docs it
 * only fires when `totalCount` changes, so while tokens stream (item count
 * constant, one item growing) it is inert. Its role when a message is appended
 * is covered by the same `totalListHeightChanged`.
 *
 * `totalListHeightChanged` is not the only growth input, because it arrives one
 * frame after the DOM grew — the virtualizer re-measures the row and re-renders
 * first — and that frame is visible while tokens stream. `followContent` goes
 * down through `FollowBottomContext` so the streamed body applies the same rule
 * in the frame it grew in.
 */
export function MessageScroller({ displayIds, renderItem }: MessageScrollerProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const { virtuosoRef, scrollerRef, onTotalListHeightChanged, followContent, pinned, scrollToBottom } =
    useStickToBottom();

  const itemContent = (index: number) => {
    const messageId = displayIds[index];
    if (!messageId) return null;
    return renderItem(index, messageId);
  };

  return (
    <TranslateErrorBoundary>
      <div className={cn("relative flex-1 flex flex-col min-h-0", isMobile && "overscroll-y-none")}>
        <FollowBottomContext.Provider value={followContent}>
          <Virtuoso
            ref={virtuosoRef}
            scrollerRef={scrollerRef}
            computeItemKey={(index) => displayIds[index]}
            totalCount={displayIds.length}
            totalListHeightChanged={onTotalListHeightChanged}
            overscan={{ main: 4000, reverse: 4000 }}
            itemContent={itemContent}
            components={components}
            className="flex-1"
            style={{ overflowY: "auto", WebkitOverflowScrolling: "touch" } as React.CSSProperties}
          />
        </FollowBottomContext.Provider>
        {!pinned && displayIds.length > 0 && (
          isMobile ? (
            <button type="button"
              className="absolute bottom-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-surface/80 backdrop-blur-sm border border-border shadow-lg transition-all duration-300 active:scale-95"
              onClick={scrollToBottom}
            >
              <Icons.Caret direction="d" />
            </button>
          ) : (
            <CustomTooltip content={t("scroll_to_bottom")} side="left">
              <button type="button"
                className="absolute bottom-6 right-8 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-transform hover:scale-110 active:scale-95"
                onClick={scrollToBottom}
              >
                <Icons.Caret direction="d" />
              </button>
            </CustomTooltip>
          )
        )}
      </div>
    </TranslateErrorBoundary>
  );
}
