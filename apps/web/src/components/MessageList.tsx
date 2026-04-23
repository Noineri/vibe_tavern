import type { AppMessage } from "../app-client.js";
import { Markdown } from "../lib/markdown.js";
import { MessageBlock } from "./MessageBlock.js";
import type { MessageListProps } from "./play-mode-types.js";

export function MessageList(input: MessageListProps) {
  return (
    <section className="msgs">
      <div className="scene-note">{input.scenario}</div>

      <div className="branch-strip">
        {input.branches.map((branch) => (
          <button
            key={branch.id}
            className={`branch-pill${branch.id === input.activeBranchId ? " active" : ""}`}
            onClick={() => input.onActivateBranch(branch.id)}
          >
            {branch.label}
          </button>
        ))}
      </div>

      <div className="messages-stack">
        {input.messages.map((message, index) => (
          <MessageBlock
            key={message.id}
            message={message}
            characterName={input.characterName}
            isEditing={input.editingMessageId === message.id}
            isGenerating={message.role === "assistant" && input.isSending && isLastAssistantMessage(input.messages, message.id)}
            editingDraft={input.editingDraft}
            isBusy={input.isSending || input.messageActionId === message.id}
            canBranch={isLastMessage(input.messages, message.id)}
            canRegenerate={isLastAssistantMessage(input.messages, message.id)}
            showSeparator={index > 0}
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
        ))}
        {input.pendingUserMessageContent && (
          <>
            <article className="msg-wrap">
              <div className="msg-block">
                <div className="msg-lbl">
                  <span className="msg-mini-ava">Y</span>
                  <span>You</span>
                </div>
                <div className="user-wrap">
                  <Markdown className="msg-body" text={input.pendingUserMessageContent} />
                </div>
              </div>
            </article>
            <MessageBlock
              message={{
                id: "pending-assistant",
                chatId: input.messages[0]?.chatId ?? "pending-chat",
                branchId: input.activeBranchId,
                role: "assistant",
                authorType: "assistant",
                content: "",
                state: "pending",
                position: input.messages.length,
                createdAt: new Date(0).toISOString(),
                updatedAt: new Date(0).toISOString(),
                variants: [],
                selectedVariantIndex: null,
              }}
              characterName={input.characterName}
              isEditing={false}
              isGenerating
              editingDraft=""
              isBusy
              canBranch={false}
              canRegenerate={false}
              showSeparator={input.messages.length > 0}
              onBranch={() => undefined}
              onStartEdit={() => undefined}
              onEditingDraftChange={() => undefined}
              onCancelEdit={() => undefined}
              onSaveEdit={() => undefined}
              onDelete={() => undefined}
              onRegenerate={() => undefined}
              onSelectPreviousVariant={() => undefined}
              onSelectNextVariant={() => undefined}
            />
          </>
        )}
      </div>
    </section>
  );
}

function isLastAssistantMessage(messages: AppMessage[], messageId: string): boolean {
  const lastMessage = messages[messages.length - 1];
  return lastMessage?.id === messageId && lastMessage.role === "assistant";
}

function isLastMessage(messages: AppMessage[], messageId: string): boolean {
  const lastMessage = messages[messages.length - 1];
  return lastMessage?.id === messageId;
}
