import { useMemo, useRef, useCallback, useState, useEffect, useLayoutEffect } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useActiveGeneration, useIsSending } from "../../stores/chat-store.js";
import { useMessageOrder, useMacroContext } from "../../stores/index.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { MessageBlock } from "./MessageBlock.js";
import { TranslateErrorBoundary } from "../layout/TranslateErrorBoundary.js";
import { useT } from "../../i18n/context.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { cn } from "../../lib/cn.js";

const msgWrap = "max-w-[min(calc(var(--mw)_+_160px),calc(100vw_-_var(--sw)_-_64px))] mx-auto px-7";
const msgWrapM = "w-full px-3";
const sepWrap = msgWrap + " my-[6px] mt-2";
const sepWrapM = msgWrapM + " my-[6px] mt-2";

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

export function MessageList() {
  const { t } = useT();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);

  const activeGen = useActiveGeneration();
  const isSending = useIsSending();
  const pendingUserMessageContent = activeGen?.pendingUserMessageContent ?? null;
  const streamingRevealedText = activeGen?.streamingRevealedText ?? "";
  const streamingReasoningText = activeGen?.streamingReasoningText ?? "";

  const [atBottom, setAtBottom] = useState(true);
  const isMobile = useIsMobile();
  const userScrolledUpRef = useRef(false);
  const wasSendingRef = useRef(false);
  const settledRef = useRef(false);

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

  const messageOrder = useMessageOrder();
  const macroContext = useMacroContext();
  // Active chat+branch for the switch-scope key. The message list's content is
  // branch-scoped (switching branches within the same chat swaps the entire
  // message set), so BOTH levels must be part of the scope. See
  // ContextMemoryModal for the same chatId|branchId lesson.
  const activeScope = useSnapshotStore((s) => {
    const cid = s.activeChat?.id ?? null;
    const bid = s.activeBranch?.id ?? null;
    return cid && bid ? `${cid}|${bid}` : null;
  });
  const lastPersistedMessage = useSnapshotStore((s) => {
    const lastMessageId = s.messageOrder[s.messageOrder.length - 1];
    return lastMessageId ? s.messagesById[lastMessageId] : null;
  });

  // Hoisted from MessageBlock (was an O(n²) useMemo over messageOrder inside
  // every mounted block). Computed once here, passed as a prop.
  const firstAssistantMsgId = useMemo(() => {
    const state = useSnapshotStore.getState();
    for (const id of messageOrder) {
      if (state.messagesById[id]?.role === "assistant") return id;
    }
    return null;
  }, [messageOrder]);

  const displayMessageIds = useMemo(() => {
    const ids = [...messageOrder];

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

  const bottomPinCleanupRef = useRef<(() => void) | null>(null);
  // Tracks the previous chat+branch scope so we can detect a switch and
  // pin-to-bottom instantly (no animation). Without this, Virtuoso's
  // followOutput="smooth" animates on the message-count change and chokes on
  // large dynamic-height chats (lands mid-way). The previous "seamless"
  // behavior was an accidental consequence of the heavier pre-refactor
  // payload slowing the fetch enough that Virtuoso saw a 0→N (fresh-load)
  // transition; the narrowed B1.4 response made it a 2→N smooth-follow.
  // Pinning explicitly makes the behavior correct AND independent of timing.
  const prevScopeRef = useRef<string | null | undefined>(undefined);

  useLayoutEffect(() => {
    if (prevScopeRef.current === activeScope) return;
    const isFirstRender = prevScopeRef.current === undefined;
    prevScopeRef.current = activeScope;
    // Skip the very first render — initialTopMostItemIndex already places us
    // at the bottom on mount. Only react to subsequent chat/branch switches.
    if (isFirstRender || !activeScope) return;
    // Cancel any in-flight streaming pin so the switch pin owns the window.
    bottomPinCleanupRef.current?.();
    // Pin to bottom for ~700ms via the rAF loop (the same ADR-blessed mechanism
    // used for variant-switch pinning). This overrides Virtuoso's smooth
    // followOutput and covers its re-measurement of the new dynamic-height
    // message set — a single scrollTop set gets undone by Virtuoso's
    // measurement cycle (per the bottom-pinning ADR), hence the rAF loop.
    userScrolledUpRef.current = false;
    bottomPinCleanupRef.current = pinToBottomForMs(scrollerElRef.current, 700);
  }, [activeScope]);

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
  }, [displayMessageIds.length]);


  const itemContent = useCallback((index: number) => {
    const messageId = displayMessageIds[index];
    if (!messageId) return null;
    // Derivations hoisted from MessageBlock so individual blocks no longer
    // subscribe to the full messageOrder array. Pending ids (__pending-*)
    // short-circuit inside MessageBlock, so these values are unused for them.
    const state = useSnapshotStore.getState();
    const isFirstAssistant = messageId === firstAssistantMsgId;
    const isLast = index === messageOrder.length - 1;
    const prevRole =
      index > 0 && messageOrder[index - 1]
        ? (state.messagesById[messageOrder[index - 1]]?.role ?? null)
        : null;
    return (
      <MessageBlock
        key={messageId}
        messageId={messageId}
        index={index}
        isFirstAssistant={isFirstAssistant}
        isLast={isLast}
        prevRole={prevRole}
      />
    );
  }, [displayMessageIds, firstAssistantMsgId, messageOrder]);

  const Header = useCallback(() => <div style={{ height: 28 }} />, []);

  const Footer = useCallback(() => <div style={{ height: 12 }} />, []);

  return (
    <TranslateErrorBoundary>
        <div className={cn("relative flex-1 flex flex-col min-h-0", isMobile && "overscroll-y-none")}>
          <Virtuoso
            ref={virtuosoRef}
            scrollerRef={(ref) => { scrollerElRef.current = ref as HTMLElement | null; }}
            computeItemKey={(index) => displayMessageIds[index]}
            totalCount={displayMessageIds.length}
            initialTopMostItemIndex={{ index: Math.max(0, displayMessageIds.length - 1), align: "end" }}
            followOutput={isSending ? "auto" : "smooth"}
            overscan={{ main: 4000, reverse: 4000 }}
            itemContent={itemContent}
            components={{ Header, Footer }}
            className="flex-1"
            style={{ overflowY: "auto", WebkitOverflowScrolling: "touch" } as React.CSSProperties}
            atBottomStateChange={setAtBottom}
          />
          {!atBottom && settledRef.current && displayMessageIds.length > 0 && (
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

