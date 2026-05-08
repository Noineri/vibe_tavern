import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { AppMessage } from "../app-client.js";
import { Markdown } from "../lib/markdown.js";
import { MessageBlock } from "./MessageBlock.js";
import type { MessageListProps } from "./play-mode-types.js";

export function MessageList(input: MessageListProps) {
  const msgsRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [greetingIndex, setGreetingIndex] = useState(0);
  const firstCharMsgId = useMemo(() => {
    for (const msg of input.messages) {
      if (msg.role === "assistant") return msg.id;
    }
    return null;
  }, [input.messages]);
  const firstCharMsg = useMemo(
    () => input.messages.find((message) => message.id === firstCharMsgId) ?? null,
    [firstCharMsgId, input.messages],
  );
  const alternateGreetings = input.alternateGreetings ?? [];
  const greetingOptions = firstCharMsg && alternateGreetings.length > 0
    ? [firstCharMsg.content, ...alternateGreetings]
    : undefined;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [input.messages.length, input.pendingUserMessageContent]);

  return (
    <div className="flex-1 overflow-y-auto scroll-smooth" style={{paddingBottom:12,paddingTop:28}} ref={msgsRef}>
      {/* TODO: VP-W4+ — EmptyState component for no active chat */}
      {/* TODO: VP-W4+ — EmptyState component for empty chat */}
      <div className="mx-auto max-w-msg text-center font-body text-[12.5px] italic text-t3" style={{paddingLeft:24,paddingRight:24,paddingTop:4,paddingBottom:'26px'}}>
        {input.scenario}
      </div>

      {input.messages.map((message, index) => {
        const previous = index > 0 ? input.messages[index - 1] : null;
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
              characterName={input.characterName}
              isEditing={input.editingMessageId === message.id}
              isGenerating={
                message.id !== firstCharMsgId &&
                message.role === "assistant" &&
                input.isSending &&
                isLastAssistantMessage(input.messages, message.id)
              }
              editingDraft={input.editingDraft}
              isBusy={input.isSending || input.messageActionId === message.id}
              canBranch={isLastMessage(input.messages, message.id)}
              canRegenerate={message.id !== firstCharMsgId && isLastAssistantMessage(input.messages, message.id)}
              canSwitchVariant={isLastMessage(input.messages, message.id)}
              greetingOptions={message.id === firstCharMsgId ? greetingOptions : undefined}
              greetingIndex={message.id === firstCharMsgId ? greetingIndex : 0}
              onGreetingIndexChange={setGreetingIndex}
              onBranch={input.onFork}
              onStartEdit={() => input.onStartEdit(message)}
              onEditingDraftChange={input.onEditingDraftChange}
              onCancelEdit={input.onCancelEdit}
              onSaveEdit={() => input.onSaveEdit(message.id)}
              onDelete={() => input.onDelete(message.id)}
              onRegenerate={() => input.onRegenerate(message.id)}
              onSelectPreviousVariant={() =>
                input.onSelectVariant(message.id, (message.selectedVariantIndex ?? 0) - 1)
              }
              onSelectNextVariant={() =>
                input.onSelectVariant(message.id, (message.selectedVariantIndex ?? 0) + 1)
              }
            />
          </Fragment>
        );
      })}

      {input.pendingUserMessageContent && (
        <>
          {input.messages.length > 0 && (
            <div style={{maxWidth:'min(calc(var(--mw) + 160px), calc(100vw - var(--sw) - 64px))', margin:'8px auto 6px', paddingLeft:28, paddingRight:28}}>
              <div className="h-px bg-border opacity-40"/>
            </div>
          )}
          <div className="relative" style={{maxWidth:'min(calc(var(--mw) + 160px), calc(100vw - var(--sw) - 64px))', margin:'0 auto', paddingLeft:28, paddingRight:28}}>
            <div className="relative group" style={{paddingTop:10,paddingBottom:10}}>
              <div className="flex items-center gap-[7px] text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.04em] text-t3" style={{marginBottom:'5px'}}>
                <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[9px] italic text-t3">Y</span>
                <span>You</span>
              </div>
              <div className="my-0.5 rounded-md bg-user-bg" style={{padding:'13px 16px'}}>
                <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 opacity-88 [&_em]:italic [&_em]:text-t2">
                  <Markdown text={input.pendingUserMessageContent} />
                </div>
              </div>
            </div>
          </div>
          <div style={{maxWidth:'min(calc(var(--mw) + 160px), calc(100vw - var(--sw) - 64px))', margin:'8px auto 6px', paddingLeft:28, paddingRight:28}}>
            <div className="h-px bg-border opacity-40"/>
          </div>
          <div className="relative" style={{maxWidth:'min(calc(var(--mw) + 160px), calc(100vw - var(--sw) - 64px))', margin:'0 auto', paddingLeft:28, paddingRight:28}} aria-label="Generating response">
            <div className="relative group" style={{paddingTop:10,paddingBottom:10}}>
              <div className="flex items-center gap-[7px] text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.04em] text-t3 text-accent-t opacity-85" style={{marginBottom:'5px'}}>
                <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[9px] italic text-t3">
                  {input.characterName.slice(0, 1).toUpperCase()}
                </span>
                <span>{input.characterName}</span>
              </div>
              <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 [&_em]:italic [&_em]:text-t2">
                <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-hidden="true">
                  <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
                  <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
                  <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
                </span>
              </div>
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
