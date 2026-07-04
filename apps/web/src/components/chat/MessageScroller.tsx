import { useRef, useState, useEffect, useLayoutEffect, useMemo } from "react";
import { Virtuoso } from "react-virtuoso";
import type { ReactNode } from "react";
import { useActiveGeneration, useIsSending } from "../../stores/chat-store.js";
import { useMessageOrder } from "../../stores/index.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { TranslateErrorBoundary } from "../layout/TranslateErrorBoundary.js";
import { useT } from "../../i18n/context.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { cn } from "../../lib/cn.js";

// atBottomThreshold for Virtuoso's followOutput: how close to the bottom (in px)
// counts as "at bottom". Tuned to 30 by spike 2026-06-20 (see
// vibe_tavern_plan/reports/scroll-bottom-pinning-verification.md); the library
// default of 4 was too tight for dynamic-height chat content. Do not lower it
// without re-testing long streaming replies — too tight re-introduces the
// follow flap that the spike documented.
const AT_BOTTOM_THRESHOLD = 30;

function scrollToBottom(el: HTMLElement | null) {
  if (el) el.scrollTop = el.scrollHeight;
}

function pinToBottomForMs(el: HTMLElement | null, ms: number): () => void {
  if (!el) return () => {};
  const until = performance.now() + ms;
  let raf: number | undefined;
  const pin = () => {
    el.scrollTop = el.scrollHeight;
    if (performance.now() < until) {
      raf = requestAnimationFrame(pin);
    } else {
      el.scrollTop = el.scrollHeight;
    }
  };
  pin();
  return () => { if (raf !== undefined) cancelAnimationFrame(raf); };
}

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
 */
export function useDisplayMessageIds(): string[] {
  const messageOrder = useMessageOrder();
  const activeGen = useActiveGeneration();
  const isSending = useIsSending();
  const pendingUserMessageContent = activeGen?.pendingUserMessageContent ?? null;
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

/**
 * Reusable virtualized message scroller with the streaming-follow pinning net.
 *
 * Extracted verbatim from MessageList (the original single RP renderer) so that
 * both RP (`MessageList`) and Co-Author (`CoauthorMessageList`) share ONE copy
 * of the fragile pinning machinery instead of forking it. The two surfaces
 * differ only in HOW they derive `displayIds` and `renderItem`; the scroll
 * behaviour must stay identical.
 *
 * ━━━ FRAGILE — Streaming Follow Safety Net ━━━
 * The refs and effects in this block (userScrolledUpRef, wasSendingRef,
 * the streaming-text scrollToBottom effect, the isSending setTimeout effect,
 * the wheel/touch listeners, and the useLayoutEffect 900ms pin below) are
 * LOAD-BEARING. They run ALONGSIDE Virtuoso's native followOutput (see the
 * <Virtuoso> props). Native followOutput ALONE is not sufficient on
 * dynamic-height streaming content — it flaps ("follows, then doesn't"),
 * especially when the window loses focus. Spikes on 2026-06-20 proved this:
 * disabling these effects broke streaming follow, and adding increaseViewportBy
 * made it worse. DO NOT REMOVE OR "SIMPLIFY" without a verified replacement
 * that holds streaming follow on its own. See scroll-bottom-pinning-verification.md.
 */
export function MessageScroller({ displayIds, renderItem }: MessageScrollerProps) {
  const { t } = useT();
  const isMobile = useIsMobile();

  const activeGen = useActiveGeneration();
  const isSending = useIsSending();
  const streamingRevealedText = activeGen?.streamingRevealedText ?? "";
  const streamingReasoningText = activeGen?.streamingReasoningText ?? "";

  const [atBottom, setAtBottom] = useState(true);

  const userScrolledUpRef = useRef(false);
  const wasSendingRef = useRef(false);
  const settledRef = useRef(false);

  const scrollerElRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isSending && !userScrolledUpRef.current) {
      scrollToBottom(scrollerElRef.current);
    }
  }, [streamingRevealedText, streamingReasoningText, isSending]);

  useEffect(() => {
    if (isSending) {
      wasSendingRef.current = true;
      if (!userScrolledUpRef.current) {
        const el = scrollerElRef.current;
        if (el) {
          scrollToBottom(el);
          const timers = [
            setTimeout(() => scrollToBottom(el), 50),
            setTimeout(() => scrollToBottom(el), 150),
          ];
          return () => timers.forEach(clearTimeout);
        }
      }
    } else if (wasSendingRef.current) {
      wasSendingRef.current = false;
      const didUserScrollUp = userScrolledUpRef.current;
      userScrolledUpRef.current = false;

      if (!didUserScrollUp) {
        const el = scrollerElRef.current;
        if (el) {
          scrollToBottom(el);
          const timers = [
            setTimeout(() => scrollToBottom(el), 150),
            setTimeout(() => scrollToBottom(el), 400),
            setTimeout(() => scrollToBottom(el), 800),
          ];
          return () => timers.forEach(clearTimeout);
        }
      }
    }
  }, [isSending]);

  useEffect(() => {
    const scroller = scrollerElRef.current;
    if (!scroller) return;

    let lastTouchY: number | null = null;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        userScrolledUpRef.current = true;
      } else {
        const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
        if (nearBottom) userScrolledUpRef.current = false;
      }
    };
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (lastTouchY === null) return;
      const y = e.touches[0]?.clientY;
      if (y !== undefined && y > lastTouchY + 10) userScrolledUpRef.current = true;
      if (y !== undefined && y < lastTouchY - 10) {
        const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
        if (nearBottom) userScrolledUpRef.current = false;
      }
      lastTouchY = y ?? null;
    };
    const onTouchEnd = () => { lastTouchY = null; };

    scroller.addEventListener('wheel', onWheel, { passive: true });
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: true });
    scroller.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
      scroller.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  const bottomPinCleanupRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (isSending) {
      wasSendingRef.current = true;
      // Cancel any previous transition pin — new generation started
      bottomPinCleanupRef.current?.();
      bottomPinCleanupRef.current = null;
      const el = scrollerElRef.current;
      if (el && !userScrolledUpRef.current) {
        scrollToBottom(el);
      }
    } else if (wasSendingRef.current) {
      wasSendingRef.current = false;
      userScrolledUpRef.current = false;
      // Pin for 900ms to cover framer-motion settling + buttons appearing
      bottomPinCleanupRef.current = pinToBottomForMs(scrollerElRef.current, 900);
    }
    return () => {
      // Cleanup on unmount only; the pin self-terminates
    };
  }, [isSending]);

  useEffect(() => {
    settledRef.current = false;
    const timer = setTimeout(() => { settledRef.current = true; }, 850);
    return () => clearTimeout(timer);
  }, [displayIds.length]);

  const itemContent = (index: number) => {
    const messageId = displayIds[index];
    if (!messageId) return null;
    return renderItem(index, messageId);
  };

  const Header = () => <div style={{ height: 28 }} />;
  const Footer = () => <div style={{ height: 12 }} />;

  return (
    <TranslateErrorBoundary>
      <div className={cn("relative flex-1 flex flex-col min-h-0", isMobile && "overscroll-y-none")}>
        <Virtuoso
          scrollerRef={(ref) => { scrollerElRef.current = ref as HTMLElement | null; }}
          computeItemKey={(index) => displayIds[index]}
          totalCount={displayIds.length}
          initialTopMostItemIndex={{ index: Math.max(0, displayIds.length - 1), align: "end" }}
          // Native follow. Runs ALONGSIDE the ⚠️ FRAGILE streaming safety-net
          // effects above. Neither is sufficient alone; together they produce
          // stable streaming follow + a clean "stop following when the user
          // scrolls up". Returning false when !atBottom is what fixes the old
          // "can't scroll up during streaming" bug.
          followOutput={(atBottom) => atBottom ? "smooth" : false}
          atBottomThreshold={AT_BOTTOM_THRESHOLD}
          overscan={{ main: 4000, reverse: 4000 }}
          itemContent={itemContent}
          components={{ Header, Footer }}
          className="flex-1"
          style={{ overflowY: "auto", WebkitOverflowScrolling: "touch" } as React.CSSProperties}
          atBottomStateChange={setAtBottom}
        />
        {!atBottom && settledRef.current && displayIds.length > 0 && (
          isMobile ? (
            <button type="button"
              className="absolute bottom-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-surface/80 backdrop-blur-sm border border-border shadow-lg transition-all duration-300 active:scale-95"
              onClick={() => { userScrolledUpRef.current = false; scrollToBottom(scrollerElRef.current); }}
            >
              <Icons.Caret direction="d" />
            </button>
          ) : (
            <CustomTooltip content={t("scroll_to_bottom")} side="left">
              <button type="button"
                className="absolute bottom-6 right-8 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-transform hover:scale-110 active:scale-95"
                onClick={() => { userScrolledUpRef.current = false; scrollToBottom(scrollerElRef.current); }}
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
