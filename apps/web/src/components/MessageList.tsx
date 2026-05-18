import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AppMessage } from "../app-client.js";
import { Markdown } from "../lib/markdown.js";
import { avatarUrl } from "../lib/avatar.js";
import { replaceUiMacros } from "../lib/macros.js";
import { useChatController } from "../hooks/use-chat-controller.js";
import { useChatSnapshot } from "../queries/chat-queries.js";
import { useChatStore } from "../stores/chat-store.js";
import { useMessageOrder, useMacroContext, useChatDataStore } from "../stores/index.js";
import { MessageBlock } from "./MessageBlock.js";
import { TranslateErrorBoundary } from "./TranslateErrorBoundary.js";
import { initials } from "./app-shell-helpers.jsx";
import { useT } from "../i18n/context.js";

const msgWrap = "max-w-[min(calc(var(--mw)_+_160px),calc(100vw_-_var(--sw)_-_64px))] mx-auto px-7";
const sepWrap = msgWrap + " my-[6px] mt-2";

export function MessageList() {
  const { t } = useT();
  const chat = useChatController();
  const activeChatId = useChatStore((s) => s.activeChatId);
  const snapshotQuery = useChatSnapshot(activeChatId);
  const snapshot = snapshotQuery.data ?? null;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const prevMsgCountRef = useRef(0);
  const [greetingIndex, setGreetingIndex] = useState(0);

  const editingMessageId = useChatStore((s) => s.editingMessageId);
  const editingDraft = useChatStore((s) => s.editingDraft);
  const isSending = useChatStore((s) => s.isSending);
  const messageActionId = useChatStore((s) => s.messageActionId);
  const streamingText = useChatStore((s) => s.streamingText);
  const pendingUserMessageContent = useChatStore((s) => s.pendingUserMessageContent);

  // Read from normalized store selectors
  const messageOrder = useMessageOrder();
  const macroContext = useMacroContext();

  // Build displayMessages with macro resolution
  const messages = useMemo(() => {
    if (!macroContext) return [];
    const state = useChatDataStore.getState();
    return messageOrder
      .map((id) => state.messagesById[id])
      .filter((msg): msg is AppMessage => Boolean(msg))
      .map((message): AppMessage => ({
        ...message,
        content: replaceUiMacros(message.content, macroContext),
      }));
  }, [messageOrder, macroContext]);

  const displayPendingUserMessageContent = useMemo(
    () => pendingUserMessageContent && macroContext
      ? replaceUiMacros(pendingUserMessageContent, macroContext)
      : pendingUserMessageContent,
    [macroContext, pendingUserMessageContent],
  );

  const alternateGreetings = useMemo(
    () => macroContext && snapshot
      ? snapshot.character.alternateGreetings.map((g) => replaceUiMacros(g, macroContext))
      : [],
    [macroContext, snapshot],
  );

  const characterName = snapshot?.character.name ?? "";
  const characterAvatarAssetId = snapshot?.character.avatarAssetId ?? null;
  const personaAvatarAssetId = snapshot?.persona?.avatarAssetId ?? null;
  const personaName = snapshot?.persona?.name ?? "";

  const firstCharMsgId = useMemo(() => {
    for (const msg of messages) {
      if (msg.role === "assistant") return msg.id;
    }
    return null;
  }, [messages]);
  const firstCharMsg = useMemo(
    () => messages.find((message) => message.id === firstCharMsgId) ?? null,
    [firstCharMsgId, messages],
  );
  const greetingOptions = firstCharMsg && alternateGreetings.length > 0
    ? [firstCharMsg.content, ...alternateGreetings]
    : undefined;

  // --- Virtualizer ---
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const msg = messages[index];
      if (!msg) return 100;
      return msg.role === "user" ? 80 : 160;
    },
    overscan: 5,
  });

  // Reset on chat switch
  useEffect(() => {
    prevMsgCountRef.current = 0;
  }, [activeChatId]);

  // Auto-scroll: instant jump on initial load, smooth for incremental updates
  useEffect(() => {
    if (messages.length === 0) return;
    const isInitialLoad = prevMsgCountRef.current === 0;
    prevMsgCountRef.current = messages.length;

    if (isInitialLoad) {
      // Scroll to bottom repeatedly as virtualizer measures items.
      // estimateSize gives rough heights; measureElement replaces them with
      // real heights after render, growing the total container size.
      // We keep jumping to bottom over several frames until it stabilizes.
      let attempts = 0;
      const jump = () => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
        if (++attempts < 10) requestAnimationFrame(jump);
      };
      requestAnimationFrame(jump);
    } else {
      // Incremental: smooth scroll for new messages / streaming
      virtualizer.scrollToIndex(messages.length - 1, { align: "end", behavior: "smooth" });
    }
  }, [messages.length, virtualizer]);

  // Keep scrolled to bottom during streaming
  useEffect(() => {
    if (streamingText) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [streamingText]);

  return (
    <TranslateErrorBoundary>
    <div className="flex-1 overflow-y-auto pt-7 pb-3" ref={scrollRef}>
      {/* TODO: VP-W4+ — EmptyState component for no active chat */}
      {/* TODO: VP-W4+ — EmptyState component for empty chat */}

      <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const message = messages[virtualItem.index];
          if (!message) return null;
          const previous = virtualItem.index > 0 ? messages[virtualItem.index - 1] : null;
          const showSeparator =
            previous !== null &&
            !isBreakoutRole(previous.role) &&
            !isBreakoutRole(message.role);

          return (
            <Fragment key={message.id}>
              {showSeparator && (
                <div
                  style={{ position: "absolute", top: virtualItem.start - 14, left: 0, right: 0 }}
                  className={sepWrap}
                >
                  <div className="h-px bg-border opacity-40"/>
                </div>
              )}
              <div
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                style={{ position: "absolute", top: virtualItem.start, left: 0, width: "100%" }}
              >
                <MessageBlock
                  messageId={message.id}
                  characterName={characterName}
                  isEditing={editingMessageId === message.id}
                  isGenerating={
                    message.id !== firstCharMsgId &&
                    message.role === "assistant" &&
                    isSending &&
                    isLastAssistantMessage(messages, message.id)
                  }
                  editingDraft={editingDraft}
                  isBusy={isSending || messageActionId === message.id}
                  canBranch={isLastMessage(messages, message.id)}
                  canRegenerate={message.id !== firstCharMsgId && isLastAssistantMessage(messages, message.id)}
                  canResend={isLastMessage(messages, message.id) && message.role === "user" && !displayPendingUserMessageContent}
                  canSwitchVariant={isLastMessage(messages, message.id)}
                  isGreeting={message.id === firstCharMsgId}
                  greetingOptions={message.id === firstCharMsgId ? greetingOptions : undefined}
                  greetingIndex={message.id === firstCharMsgId ? greetingIndex : 0}
                  onGreetingIndexChange={setGreetingIndex}
                  onBranch={() => void chat.handleFork()}
                  onStartEdit={() => chat.handleStartEdit(message)}
                  onEditingDraftChange={useChatStore.getState().setEditingDraft}
                  onCancelEdit={chat.handleCancelEdit}
                  onSaveEdit={() => void chat.handleSaveMessageEdit(message.id)}
                  onDelete={() => void chat.handleDeleteMessage(message.id)}
                  onRegenerate={() => void chat.handleRegenerateMessage(message.id)}
                  onResend={() => { void chat.handleResend(); }}
                  onSelectPreviousVariant={() =>
                    chat.handleSelectMessageVariant(message.id, (message.selectedVariantIndex ?? 0) - 1)
                  }
                  onSelectNextVariant={() =>
                    chat.handleSelectMessageVariant(message.id, (message.selectedVariantIndex ?? 0) + 1)
                  }
                  characterAvatarAssetId={characterAvatarAssetId}
                  personaAvatarAssetId={personaAvatarAssetId}
                />
              </div>
            </Fragment>
          );
        })}
      </div>

      {/* Streaming footer — outside virtualizer, always rendered when needed */}
      {displayPendingUserMessageContent && (
        <>
          {messages.length > 0 && (
            <div className={sepWrap}>
              <div className="h-px bg-border opacity-40"/>
            </div>
          )}
          <div className={msgWrap}>
            <div className="relative group py-2.5">
              <div className="mb-[5px] flex items-center gap-[7px] text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.04em] text-t3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[12px] italic text-t3 [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top">
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
              <div className="mb-[5px] flex items-center gap-[7px] text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.04em] text-t3 text-accent-t opacity-85">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[12px] italic text-t3">
                  {characterName.slice(0, 1).toUpperCase()}
                </span>
                <span>{characterName}</span>
              </div>
              <StreamingContent characterName={characterName} />
            </div>
          </div>
        </>
      )}

      {!displayPendingUserMessageContent && isSending && messages.length > 0 && messages[messages.length - 1].role === "user" && (
        <>
          <div className={sepWrap}>
            <div className="h-px bg-border opacity-40"/>
          </div>
          <div className={msgWrap} aria-label={t("generating_response")}>
            <div className="relative group py-2.5">
              <div className="mb-[5px] flex items-center gap-[7px] text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.04em] text-t3 text-accent-t opacity-85">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[12px] italic text-t3">
                  {characterName.slice(0, 1).toUpperCase()}
                </span>
                <span>{characterName}</span>
              </div>
              <StreamingContent characterName={characterName} />
            </div>
          </div>
        </>
      )}

      {/* Streaming during regenerate/continue — last message is assistant, streaming text appears below */}
      {!displayPendingUserMessageContent && isSending && streamingText && messages.length > 0 && messages[messages.length - 1].role === "assistant" && (
        <>
          <div className={msgWrap} aria-label={t("generating_response")}>
            <div className="relative group py-2.5">
              <StreamingContent characterName={characterName} />
            </div>
          </div>
        </>
      )}

      <div ref={endRef} className="h-px"/>
    </div>
    </TranslateErrorBoundary>
  );
}

function isBreakoutRole(role: AppMessage["role"]): boolean {
  return role === "tool";
}

function isLastAssistantMessage(messages: AppMessage[], messageId: string): boolean {
  const lastMessage = messages[messages.length - 1];
  return lastMessage?.id === messageId && lastMessage.role === "assistant";
}

function isLastMessage(messages: AppMessage[], messageId: string): boolean {
  const lastMessage = messages[messages.length - 1];
  return lastMessage?.id === messageId;
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
  if (streamingText) {
    return (
      <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 [&_em]:italic [&_em]:text-t2">
        <Markdown text={streamingText} />
        {_dots}
      </div>
    );
  }
  return (
    <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 [&_em]:italic [&_em]:text-t2">
      {_dots}
    </div>
  );
}
