import { Fragment, useEffect, useMemo, useRef } from "react";
import type { AppMessage } from "../app-client.js";
import { Markdown } from "../lib/markdown.js";
import { MessageBlock } from "./MessageBlock.js";
import type { MessageListProps } from "./play-mode-types.js";

export function MessageList(input: MessageListProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
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
    <div className="msgs">
      <div className="scene-note">{input.scenario}</div>

      {input.messages.map((message, index) => {
        const previous = index > 0 ? input.messages[index - 1] : null;
        const showSeparator =
          previous !== null &&
          !isBreakoutRole(previous.role) &&
          !isBreakoutRole(message.role);

        return (
          <Fragment key={message.id}>
            {showSeparator && (
              <div className="msg-sep">
                <div className="msg-sep-l" />
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
              greetingOptions={message.id === firstCharMsgId ? greetingOptions : undefined}
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
            <div className="msg-sep">
              <div className="msg-sep-l" />
            </div>
          )}
          <div className="msg-wrap">
            <div className="msg-block">
              <div className="msg-lbl">
                <span className="msg-mini-ava">Y</span>
                <span>You</span>
              </div>
              <div className="user-wrap">
                <Markdown className="msg-body" text={input.pendingUserMessageContent} />
              </div>
            </div>
          </div>
          <div className="msg-sep">
            <div className="msg-sep-l" />
          </div>
          <div className="msg-wrap" aria-label="Generating response">
            <div className="msg-block">
              <div className="msg-lbl char-lbl">
                <span className="msg-mini-ava">
                  {input.characterName.slice(0, 1).toUpperCase()}
                </span>
                <span>{input.characterName}</span>
              </div>
              <div className="msg-body">
                <span className="gen-cur" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      <div ref={endRef} style={{ height: 1 }} />
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
