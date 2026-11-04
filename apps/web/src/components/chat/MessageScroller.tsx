import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useHasFreshGeneration, useIsGenerationVisible, usePendingUserContent } from "../../stores/chat-store.js";
import { useActiveStreamingMessageId } from "../../stores/chat-selectors.js";
import { useMessageOrder } from "../../stores/index.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useImageGenChatStore } from "../../stores/image-gen-chat-store.js";
import { TranslateErrorBoundary } from "../layout/TranslateErrorBoundary.js";
import { useT } from "../../i18n/context.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { cn } from "../../lib/cn.js";
import { MessageScrollerCore, type MessageScrollerCoreApi } from "./message-scroller-core.js";
import { MessageScrollContext } from "./message-scroll-context.js";
import { ChatScrollRail } from "./scroll-rail.js";

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
  const isSending = useIsGenerationVisible();
  const hasFreshGeneration = useHasFreshGeneration();
  const streamingMessageId = useActiveStreamingMessageId();
  const pendingUserMessageContent = usePendingUserContent();
  const lastPersistedMessage = useSnapshotStore((s) => {
    const lastMessageId = s.messageOrder[s.messageOrder.length - 1];
    return lastMessageId ? s.messagesById[lastMessageId] : null;
  });

  return useMemo(() => {
    const state = useSnapshotStore.getState();
    const ids = messageOrder.filter(id => state.messagesById[id]?.role !== "tool");

    // Empty text is a valid attachment-only send; null alone means no pending user turn.
    if (pendingUserMessageContent !== null) {
      const lastMsg = lastPersistedMessage;
      const alreadyPersisted =
        lastMsg?.role === "user" &&
        lastMsg.content.trim() === pendingUserMessageContent.trim();

      if (!alreadyPersisted) {
        ids.push("__pending-user");
      }
      ids.push("__pending-assistant");
    } else if (isSending && !streamingMessageId && (hasFreshGeneration || lastPersistedMessage?.role === "user")) {
      ids.push("__pending-assistant");
    }

    return ids;
  }, [messageOrder, pendingUserMessageContent, lastPersistedMessage, isSending, hasFreshGeneration, streamingMessageId]);
}

export interface MessageScrollerProps {
  /**
   * Ordered list of message ids (plus synthetic `__pending-*` ids, if any) to
   * render. Computed by the caller (RP vs co-author have different derivation
   * rules). The scroller keeps the recent suffix mounted and virtualizes the
   * older prefix.
   */
  displayIds: string[];
  /**
   * Render one item. Receives the resolved messageId (or pending id) at the
   * given index. Mode-specific derivations (e.g. RP's prevRole / isFirstAssistant)
   * live inside each caller's renderItem — the scroller itself is mode-agnostic.
   */
  renderItem: (index: number, messageId: string) => ReactNode;
  /**
   * Extra scroll room (px) below the stable tail — MUI step 14 (2026-09-11):
   * the chat add-on launcher bar (dice/playlist/experience chips) floats
   * absolutely above the input dock and overlays the list's bottom edge, so
   * the last message's action buttons could never be scrolled clear of it.
   * The caller measures the bar and passes its height here; 0 (default) keeps
   * the historical 12px tail breathing room unchanged.
   */
  bottomInset?: number;
}

/**
 * Reusable hybrid message scroller — the RP/co-author ADAPTER (AFP-2).
 *
 * Shared by RP (`MessageList`) and Co-Author (`CoauthorMessageList`); they
 * differ only in how `displayIds` is derived and how an item renders, and the
 * scroll behaviour has to be identical. The virtualization, the scroll
 * invariant and the navigation live in the store-free
 * `message-scroller-core.tsx`; this adapter contributes exactly the
 * environment: the snapshot-derived reset identity (`chat:branch`), the
 * image-gen suppression flag (IF-4b follow-up), the story-map rail, the
 * reveal-start context for message rows, the translate recovery boundary and
 * the desktop/mobile "to the end" button pair.
 *
 * Older messages remain virtualized for long conversations. Several complete
 * recent pages render in Virtuoso's footer and therefore retain their DOM while
 * the view is pinned. A ResizeObserver watches only that stable tail. Changing
 * `scrollTop` cannot resize it, so disclosure and streaming growth settle at
 * the bottom before paint without the ResizeObserver feedback loop caused by
 * synchronously measuring virtualized rows.
 *
 * The stable tail is bounded: a 1,000-message branch still mounts only the last
 * 81–100 messages plus Virtuoso's viewport/overscan rows. At each page boundary
 * the oldest tail page moves into virtualization while the four newest pages
 * keep their React and DOM identity.
 */
export function MessageScroller({ displayIds, renderItem, bottomInset = 0 }: MessageScrollerProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const resetKey = useSnapshotStore((state) =>
    `${state.activeChat?.id ?? ""}:${state.activeBranch?.id ?? ""}`,
  );
  // IF-4b follow-up (owner 2026-09-22): while an image-gen run is in flight
  // for THIS chat, growth (the progress row, the landing image) must not
  // drag the pinned view to the bottom — the user may be swiping variants on
  // earlier slots. Suppression is chat-scoped: a run in another chat never
  // touches this list; text streaming never raises the flag.
  const activeChatId = useSnapshotStore((state) => state.activeChat?.id ?? null);
  const imageGenRunInFlight = useImageGenChatStore(
    (state) => activeChatId !== null && state.runningByChat[activeChatId] !== undefined,
  );

  // The jump-landing highlight is adapter chrome (the core stays animation-free).
  const highlightRef = useRef<Animation | null>(null);
  useEffect(() => () => { highlightRef.current?.cancel(); }, [resetKey]);
  const onJump = useCallback((api: MessageScrollerCoreApi) => (index: number) => {
    api.scrollToItem(index, (target) => {
      highlightRef.current?.cancel();
      highlightRef.current = target.animate([{ backgroundColor: "var(--accent-dim)" }, { backgroundColor: "transparent" }], { duration: 900 });
    });
  }, []);

  return (
    <TranslateErrorBoundary>
      <MessageScrollerCore
        resetKey={resetKey}
        suppressFollow={imageGenRunInFlight}
        displayIds={displayIds}
        renderItem={renderItem}
        bottomInset={bottomInset}
        className={cn("chat-rail-layout", isMobile && "overscroll-y-none")}
        wrap={(scroller, api) => (
          <MessageScrollContext.Provider value={api.revealStart}>{scroller}</MessageScrollContext.Provider>
        )}
        overlay={(api) => (
          <ChatScrollRail
            key={resetKey}
            displayIds={displayIds}
            scroller={api.scrollerElement}
            onJump={onJump(api)}
            isMobile={isMobile}
          />
        )}
        renderJumpToBottom={(scrollToBottom) => isMobile ? (
          <button type="button"
            className="absolute bottom-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-surface/80 backdrop-blur-sm border border-border shadow-lg transition-all duration-300 active:scale-95"
            onClick={scrollToBottom}
          >
            <Icons.Caret direction="d" />
          </button>
        ) : (
          <CustomTooltip content={t("scroll_to_bottom")} side="left">
            <button type="button"
              className="chat-rail-bottom-button absolute bottom-6 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-transform hover:scale-110 active:scale-95"
              onClick={scrollToBottom}
            >
              <Icons.Caret direction="d" />
            </button>
          </CustomTooltip>
        )}
      />
    </TranslateErrorBoundary>
  );
}
