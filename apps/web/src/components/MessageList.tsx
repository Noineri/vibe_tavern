import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { AppMessage } from "../app-client.js";
import { Markdown } from "../lib/markdown.js";
import { avatarUrl } from "../lib/avatar.js";
import { useChatController } from "../hooks/use-chat-controller.js";
import { useCharacterController } from "../hooks/use-character-controller.js";
import { useDisplayHelpers } from "../hooks/use-display-helpers.js";
import { useBootstrapQuery } from "../queries/bootstrap-queries.js";
import { useChatSnapshot } from "../queries/chat-queries.js";
import { useChatStore } from "../stores/chat-store.js";
import { MessageBlock } from "./MessageBlock.js";
import { initials } from "./app-shell-helpers.jsx";
import { useT } from "../i18n/context.js";

const msgWrap = "max-w-[min(calc(var(--mw)_+_160px),calc(100vw_-_var(--sw)_-_64px))] mx-auto px-7";
const sepWrap = msgWrap + " my-[6px] mt-2";

export function MessageList() {
  const { t } = useT();
  const chat = useChatController();
  const bootstrapQuery = useBootstrapQuery();
  const activeChatId = useChatStore((s) => s.activeChatId);
  const snapshotQuery = useChatSnapshot(activeChatId);
  const snapshot = snapshotQuery.data ?? null;
  const allCharacters = bootstrapQuery.data?.allCharacters ?? [];
  const display = useDisplayHelpers(allCharacters, snapshot);
  const msgsRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [greetingIndex, setGreetingIndex] = useState(0);

  const editingMessageId = useChatStore((s) => s.editingMessageId);
  const editingDraft = useChatStore((s) => s.editingDraft);
  const isSending = useChatStore((s) => s.isSending);
  const messageActionId = useChatStore((s) => s.messageActionId);
  const streamingText = useChatStore((s) => s.streamingText);

  const messages = display.displayMessages;
  const pendingUserMessageContent = display.displayPendingUserMessageContent;
  const alternateGreetings = display.displayAlternateGreetings;

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

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pendingUserMessageContent, streamingText]);

  return (
    <div className="flex-1 overflow-y-auto scroll-smooth pt-7 pb-3" ref={msgsRef}>
      {/* TODO: VP-W4+ — EmptyState component for no active chat */}
      {/* TODO: VP-W4+ — EmptyState component for empty chat */}

      {messages.map((message, index) => {
        const previous = index > 0 ? messages[index - 1] : null;
        const showSeparator =
          previous !== null &&
          !isBreakoutRole(previous.role) &&
          !isBreakoutRole(message.role);

        return (
          <Fragment key={message.id}>
            {showSeparator && (
              <div className={sepWrap}>
                <div className="h-px bg-border opacity-40"/>
              </div>
            )}
            <MessageBlock
              message={message}
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
              canResend={isLastMessage(messages, message.id) && message.role === "user" && !pendingUserMessageContent}
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
          </Fragment>
        );
      })}

      {pendingUserMessageContent && (
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
                  <Markdown text={pendingUserMessageContent} />
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

      {!pendingUserMessageContent && isSending && messages.length > 0 && messages[messages.length - 1].role === "user" && (
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

      <div ref={endRef} className="h-px"/>
      {/* TODO: VP-W4+ — scroll-to-bottom button
          Maket structure:
          <div className="sticky bottom-2 z-20 flex justify-center pointer-events-none">
            <div className="pointer-events-auto inline-flex items-center gap-1.5 rounded-2xl border border-border bg-surface px-3.5 py-1.5 text-[calc(var(--ui-fs)-3px)] text-t2 shadow-[0_4px_16px_rgba(0,0,0,.25)] transition-opacity duration-200 cursor-pointer" onClick={scrollHandler}>
              <span>↓</span> Scroll to latest
            </div>
          </div>
      */}
    </div>
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
