import { useMemo, useRef, useCallback, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Markdown } from "../../lib/markdown.js";
import { avatarUrl } from "../../lib/avatar.js";
import { replaceUiMacros } from "../../lib/macros.js";
import { useActiveGeneration, useIsSending } from "../../stores/chat-store.js";
import { useMessageOrder, useMacroContext, useChatMeta } from "../../stores/index.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { MessageBlock } from "./MessageBlock.js";
import { MessageReasoning } from "./MessageReasoning.js";
import { TranslateErrorBoundary } from "../layout/TranslateErrorBoundary.js";
import { initials } from "../layout/app-shell-helpers.js";
import { useT } from "../../i18n/context.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { cn } from "../../lib/cn.js";

const msgWrap = "max-w-[min(calc(var(--mw)_+_160px),calc(100vw_-_var(--sw)_-_64px))] mx-auto px-7";
const msgWrapM = "w-full px-3";
const sepWrap = msgWrap + " my-[6px] mt-2";
const sepWrapM = msgWrapM + " my-[6px] mt-2";

export function MessageList() {
  const { t } = useT();
  const chatMeta = useChatMeta();
  const snapshot = chatMeta ? {
    character: chatMeta.character,
    persona: chatMeta.persona,
  } : null;
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const activeGen = useActiveGeneration();
  const isSending = useIsSending();
  const pendingUserMessageContent = activeGen?.pendingUserMessageContent ?? null;

  const [atBottom, setAtBottom] = useState(true);
  const isMobile = useIsMobile();

  // Read from normalized store selectors
  const messageOrder = useMessageOrder();
  const macroContext = useMacroContext();
  const lastPersistedMessage = useSnapshotStore((s) => {
    const lastMessageId = s.messageOrder[s.messageOrder.length - 1];
    return lastMessageId ? s.messagesById[lastMessageId] : null;
  });

  // When a user message is pending, it is rendered in the footer immediately.
  // If a snapshot refresh lands mid-generation after the backend persisted the
  // same user message, hide that last persisted user row to avoid a ghost
  // duplicate. Only filter the final row when its content matches pending text;
  // otherwise an older user message could disappear before persistence catches up.
  const displayMessageIds = useMemo(() => {
    if (!pendingUserMessageContent || messageOrder.length === 0) return messageOrder;

    if (
      lastPersistedMessage?.role === "user" &&
      lastPersistedMessage.content.trim() === pendingUserMessageContent.trim()
    ) {
      return messageOrder.slice(0, -1);
    }

    return messageOrder;
  }, [lastPersistedMessage, messageOrder, pendingUserMessageContent]);

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
            <div className={isMobile ? sepWrapM : sepWrap}>
              <div className="h-px bg-border opacity-40"/>
            </div>
          )}
          <div className={isMobile ? msgWrapM : msgWrap}>
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
          <div className={isMobile ? sepWrapM : sepWrap}>
            <div className="h-px bg-border opacity-40"/>
          </div>
          <div className={isMobile ? msgWrapM : msgWrap} aria-label={t("generating_response")}>
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
          const state = useSnapshotStore.getState();
          const lastMsgId = displayMessageIds[displayMessageIds.length - 1];
          const lastMsg = state.messagesById[lastMsgId];
          if (lastMsg?.role !== "user") return null;

          return (
            <>
              <div className={isMobile ? sepWrapM : sepWrap}>
                <div className="h-px bg-border opacity-40"/>
              </div>
              <div className={isMobile ? msgWrapM : msgWrap} aria-label={t("generating_response")}>
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
      personaAvatarAssetId, personaName, characterAvatarAssetId, characterName, t, isMobile]);

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
            isMobile ? (
              <button type="button"
                className="absolute bottom-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-surface/80 backdrop-blur-sm border border-border shadow-lg transition-all duration-300 active:scale-95"
                onClick={() => virtuosoRef.current?.scrollToIndex({ index: 999999, behavior: "smooth", align: "end" })}
              >
                <Icons.Caret direction="d" />
              </button>
            ) : (
              <CustomTooltip content={t("scroll_to_bottom")} side="left">
                <button type="button"
                  className="absolute bottom-6 right-8 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-transform hover:scale-110 active:scale-95"
                  onClick={() => virtuosoRef.current?.scrollToIndex({ index: 999999, behavior: "smooth", align: "end" })}
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

const _dots = (
  <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-hidden="true">
    <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
    <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
    <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
  </span>
);

function StreamingContent(_props: { characterName: string }) {
  const gen = useActiveGeneration();
  const streamingText = gen?.streamingText ?? "";
  const streamingReasoning = gen?.streamingReasoningText ?? "";
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
