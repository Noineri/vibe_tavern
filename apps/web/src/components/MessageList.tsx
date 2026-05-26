import { useMemo, useRef, useCallback, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { AppMessage } from "../app-client.js";
import { Markdown } from "../lib/markdown.js";
import { avatarUrl } from "../lib/avatar.js";
import { replaceUiMacros } from "../lib/macros.js";
import { useChatStore } from "../stores/chat-store.js";
import { useMessageOrder, useMacroContext, useChatDataStore } from "../stores/index.js";
import { MessageBlock } from "./MessageBlock.js";
import { MessageReasoning } from "./MessageReasoning.js";
import { TranslateErrorBoundary } from "./TranslateErrorBoundary.js";
import { initials } from "./app-shell-helpers.jsx";
import { useT } from "../i18n/context.js";
import { Icons } from "./shared/icons.js";
import { CustomTooltip } from "./shared/Tooltip.js";
import { useIsMobile } from "../hooks/use-mobile.js";
import { cn } from "../lib/cn.js";

const msgWrap = "max-w-[min(calc(var(--mw)_+_160px),calc(100vw_-_var(--sw)_-_64px))] mx-auto px-7";
const sepWrap = msgWrap + " my-[6px] mt-2";

export function MessageList() {
  const { t } = useT();
  const chatMeta = useChatDataStore((s) => s.chatMeta);
  const snapshot = chatMeta ? {
    character: chatMeta.character,
    persona: chatMeta.persona,
  } : null;
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const isSending = useChatStore((s) => s.isSending);
  const pendingUserMessageContent = useChatStore((s) => s.pendingUserMessageContent);

  const [atBottom, setAtBottom] = useState(true);
  const isMobile = useIsMobile();

  // Read from normalized store selectors
  const messageOrder = useMessageOrder();
  const macroContext = useMacroContext();

  // Raw messages list (no macro resolution here for performance)
  const messages = useMemo(() => {
    const state = useChatDataStore.getState();
    return messageOrder
      .map((id) => state.messagesById[id])
      .filter((msg): msg is AppMessage => Boolean(msg));
  }, [messageOrder]);

  // When a user message is pending (being streamed), it's rendered in the
  // pending-message footer.  If React Query refetches the snapshot mid-stream,
  const displayMessageIds = messageOrder;

  const displayPendingUserMessageContent = useMemo(
    () => pendingUserMessageContent && macroContext
      ? replaceUiMacros(pendingUserMessageContent, macroContext)
      : pendingUserMessageContent,
    [macroContext, pendingUserMessageContent],
  );

  const characterName = snapshot?.character.name ?? "";
  const characterAvatarAssetId = snapshot?.character.avatarAssetId ?? null;
  const personaAvatarAssetId = snapshot?.persona?.avatarAssetId ?? null;
  const personaName = snapshot?.persona?.name ?? "";

  const itemContent = useCallback((index: number) => {
    const messageId = displayMessageIds[index];
    if (!messageId) return null;
    return (
      <MessageBlock
        key={messageId}
        messageId={messageId}
        index={index}
      />
    );
  }, [displayMessageIds]);

  const Footer = useCallback(() => (
    <>
      {displayPendingUserMessageContent && (
        <>
          {displayMessageIds.length > 0 && (
            <div className={sepWrap}>
              <div className="h-px bg-border opacity-40"/>
            </div>
          )}
          <div className={msgWrap}>
            <div className="relative group py-2.5">
              <div className="mb-[12px] flex items-center gap-[10px] text-[calc(var(--ui-fs)-2px)] font-semibold tracking-[0.04em] text-t3 flex-row-reverse">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[calc(var(--ui-fs)+1px)] italic text-t3 [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top">
                  {personaAvatarAssetId
                    ? <img src={avatarUrl(personaAvatarAssetId)} alt="" className="h-full w-full object-cover object-top" />
                    : (personaName ? initials(personaName) : "Y")}
                </span>
                <span>{t("message_user_label")}</span>
              </div>
              <div className="my-0.5 rounded-md bg-user-bg px-4 py-[13px]">
                <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 opacity-88 [&_em]:italic [&_em]:text-t2">
                  <Markdown text={displayPendingUserMessageContent} />
                </div>
              </div>
            </div>
          </div>
          <div className={sepWrap}>
            <div className="h-px bg-border opacity-40"/>
          </div>
          <div className={msgWrap} aria-label={t("generating_response")}>
            <div className="relative group py-2.5">
              <div className="mb-[12px] flex items-center gap-[10px] text-[calc(var(--ui-fs)-2px)] font-semibold tracking-[0.04em] text-t3 text-accent-t opacity-85">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[calc(var(--ui-fs)+1px)] italic text-t3 [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top">
                  {characterAvatarAssetId
                    ? <img src={avatarUrl(characterAvatarAssetId)} alt="" className="h-full w-full object-cover object-top" />
                    : (characterName ? initials(characterName) : "")}
                </span>
                <span>{characterName}</span>
              </div>
              <StreamingContent characterName={characterName} />
            </div>
          </div>
        </>
      )}

      {!displayPendingUserMessageContent && isSending && displayMessageIds.length > 0 && (
        (() => {
          const state = useChatDataStore.getState();
          const lastMsgId = displayMessageIds[displayMessageIds.length - 1];
          const lastMsg = state.messagesById[lastMsgId];
          if (lastMsg?.role !== "user") return null;

          return (
            <>
              <div className={sepWrap}>
                <div className="h-px bg-border opacity-40"/>
              </div>
              <div className={msgWrap} aria-label={t("generating_response")}>
                <div className="relative group py-2.5">
                  <div className="mb-[12px] flex items-center gap-[10px] text-[calc(var(--ui-fs)-2px)] font-semibold tracking-[0.04em] text-t3 text-accent-t opacity-85">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[calc(var(--ui-fs)+1px)] italic text-t3 [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top">
                      {characterAvatarAssetId
                        ? <img src={avatarUrl(characterAvatarAssetId)} alt="" className="h-full w-full object-cover object-top" />
                        : (characterName ? initials(characterName) : "")}
                    </span>
                    <span>{characterName}</span>
                  </div>
                  <StreamingContent characterName={characterName} />
                </div>
              </div>
            </>
          );
        })()
      )}
    </>
  ), [displayPendingUserMessageContent, displayMessageIds, isSending,
      personaAvatarAssetId, personaName, characterAvatarAssetId, characterName, t]);

  return (
    <TranslateErrorBoundary>
        <div className={cn("relative flex-1 flex flex-col min-h-0", isMobile && "overscroll-y-none")}>
          <Virtuoso
            ref={virtuosoRef}
            computeItemKey={(index) => displayMessageIds[index]}
            totalCount={displayMessageIds.length}
            initialTopMostItemIndex={Math.max(0, displayMessageIds.length - 1)}
            followOutput="smooth"
            overscan={{ main: 4000, reverse: 4000 }}
            itemContent={itemContent}
            components={{ Footer }}
            className="flex-1 pt-7 pb-3"
            style={{ overflowY: "auto", WebkitOverflowScrolling: "touch" } as React.CSSProperties}
            atBottomStateChange={setAtBottom}
          />
          {!atBottom && displayMessageIds.length > 0 && (
            <CustomTooltip content={t("scroll_to_bottom")} side="left">
              <button
                className="absolute bottom-6 right-8 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-transform hover:scale-110 active:scale-95 z-10"
                onClick={() => virtuosoRef.current?.scrollToIndex({ index: displayMessageIds.length - 1, behavior: "smooth" })}
              >
                <Icons.Caret direction="d" />
              </button>
            </CustomTooltip>
          )}
        </div>
    </TranslateErrorBoundary>
  );
}

const _dots = (
  <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-hidden="true">
    <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
    <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
    <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
  </span>
);

function StreamingContent(_props: { characterName: string }) {
  const streamingText = useChatStore((s) => s.streamingText);
  const streamingReasoning = useChatStore((s) => s.streamingReasoningText);
  if (streamingText) {
    return (
      <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 [&_em]:italic [&_em]:text-t2">
        {streamingReasoning && <MessageReasoning reasoning={streamingReasoning} />}
        <Markdown text={streamingText} />
        {_dots}
      </div>
    );
  }
  return (
    <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 [&_em]:italic [&_em]:text-t2">
      {streamingReasoning && <MessageReasoning reasoning={streamingReasoning} />}
      {_dots}
    </div>
  );
}
