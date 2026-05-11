import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { AppMessage } from "../app-client.js";
import { Markdown } from "../lib/markdown.js";
import { useChatStore } from "../stores/chat-store.js";
import { MessageBlock } from "./MessageBlock.js";
import { useAppActions } from "./AppShell.js";
import { useT } from "../i18n/context.js";

export function MessageList() {
  const { t } = useT();
  const app = useAppActions();
  const msgsRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [greetingIndex, setGreetingIndex] = useState(0);

  const snapshot = app.snapshot;
  const editingMessageId = useChatStore((s) => s.editingMessageId);
  const editingDraft = useChatStore((s) => s.editingDraft);
  const isSending = useChatStore((s) => s.isSending);
  const messageActionId = useChatStore((s) => s.messageActionId);
  const streamingText = useChatStore((s) => s.streamingText);

  const messages = app.displayMessages;
  const pendingUserMessageContent = app.displayPendingUserMessageContent;
  const alternateGreetings = app.displayAlternateGreetings;

  const characterName = snapshot?.character.name ?? "";
  const characterAvatarAssetId = snapshot?.character.avatarAssetId ?? null;
  const personaAvatarAssetId = snapshot?.persona?.avatarAssetId ?? null;

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
    <div className="flex-1 overflow-y-auto scroll-smooth" style={{paddingBottom:12,paddingTop:28}} ref={msgsRef}>
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
              <div style={{maxWidth:'min(calc(var(--mw) + 160px), calc(100vw - var(--sw) - 64px))', margin:'8px auto 6px', paddingLeft:28, paddingRight:28}}>
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
              greetingOptions={message.id === firstCharMsgId ? greetingOptions : undefined}
              greetingIndex={message.id === firstCharMsgId ? greetingIndex : 0}
              onGreetingIndexChange={setGreetingIndex}
              onBranch={() => void app.handleFork()}
              onStartEdit={() => app.handleStartEdit(message)}
              onEditingDraftChange={app.setEditingDraft}
              onCancelEdit={app.handleCancelEdit}
              onSaveEdit={() => void app.handleSaveMessageEdit(message.id)}
              onDelete={() => void app.handleDeleteMessage(message.id)}
              onRegenerate={() => void app.handleRegenerateMessage(message.id)}
              onResend={() => { void app.handleResend(); }}
              onSelectPreviousVariant={() =>
                app.handleSelectMessageVariant(message.id, (message.selectedVariantIndex ?? 0) - 1)
              }
              onSelectNextVariant={() =>
                app.handleSelectMessageVariant(message.id, (message.selectedVariantIndex ?? 0) + 1)
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
            <div style={{maxWidth:'min(calc(var(--mw) + 160px), calc(100vw - var(--sw) - 64px))', margin:'8px auto 6px', paddingLeft:28, paddingRight:28}}>
              <div className="h-px bg-border opacity-40"/>
            </div>
          )}
          <div className="relative" style={{maxWidth:'min(calc(var(--mw) + 160px), calc(100vw - var(--sw) - 64px))', margin:'0 auto', paddingLeft:28, paddingRight:28}}>
            <div className="relative group" style={{paddingTop:10,paddingBottom:10}}>
              <div className="flex items-center gap-[7px] text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.04em] text-t3" style={{marginBottom:'5px'}}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[12px] italic text-t3">Y</span>
                <span>{t("message_user_label")}</span>
              </div>
              <div className="my-0.5 rounded-md bg-user-bg" style={{padding:'13px 16px'}}>
                <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 opacity-88 [&_em]:italic [&_em]:text-t2">
                  <Markdown text={pendingUserMessageContent} />
                </div>
              </div>
            </div>
          </div>
          <div style={{maxWidth:'min(calc(var(--mw) + 160px), calc(100vw - var(--sw) - 64px))', margin:'8px auto 6px', paddingLeft:28, paddingRight:28}}>
            <div className="h-px bg-border opacity-40"/>
          </div>
          <div className="relative" style={{maxWidth:'min(calc(var(--mw) + 160px), calc(100vw - var(--sw) - 64px))', margin:'0 auto', paddingLeft:28, paddingRight:28}} aria-label={t("generating_response")}>
            <div className="relative group" style={{paddingTop:10,paddingBottom:10}}>
              <div className="flex items-center gap-[7px] text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.04em] text-t3 text-accent-t opacity-85" style={{marginBottom:'5px'}}>
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
          <div style={{maxWidth:'min(calc(var(--mw) + 160px), calc(100vw - var(--sw) - 64px))', margin:'8px auto 6px', paddingLeft:28, paddingRight:28}}>
            <div className="h-px bg-border opacity-40"/>
          </div>
          <div className="relative" style={{maxWidth:'min(calc(var(--mw) + 160px), calc(100vw - var(--sw) - 64px))', margin:'0 auto', paddingLeft:28, paddingRight:28}} aria-label={t("generating_response")}>
            <div className="relative group" style={{paddingTop:10,paddingBottom:10}}>
              <div className="flex items-center gap-[7px] text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.04em] text-t3 text-accent-t opacity-85" style={{marginBottom:'5px'}}>
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
            <div className="pointer-events-auto inline-flex items-center gap-1.5 rounded-2xl border border-border bg-surface px-3.5 py-1.5 text-[calc(var(--ui-fs)-3px)] text-t2 shadow-[0_4px_16px_rgba(0,0,0,.25)] transition-opacity duration-200 cursor-pointer" style={{padding:'5px 14px'}} onClick={scrollHandler}>
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
