import { memo } from "react";
import { useChatStore, useIsSending } from "../../stores/index.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useDisplayMessage, useMessageAuthor, useIsStreamingTarget, useStreamingRevealedFor } from "../../stores/chat-selectors.js";
import { MessageShell, type MessageShellAuthorInfo } from "../chat/MessageShell.js";
import { Markdown } from "../../lib/markdown.js";
import { StreamingMarkdown } from "../chat/StreamingMarkdown.js";
import { CoauthorToolActivitySlot } from "../chat/CoauthorToolActivitySlot.js";
import { Icons } from "../shared/icons.js";
import { useT } from "../../i18n/context.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { useShallow } from "zustand/react/shallow";

export const CoauthorTurnShell = memo(function CoauthorTurnShell({
  turnId,
  index,
  isLastTurn,
}: {
  turnId: string;
  index: number;
  isLastTurn: boolean;
}) {
  const { t } = useT();
  const chat = useChatController();
  const authorInfo = useMessageAuthor();
  const isSending = useIsSending();
  
  const pendingUserMessageContent = useChatStore(s => {
    if (!s.activeChatId) return null;
    return s.generations[s.activeChatId]?.pendingUserMessageContent ?? null;
  });

  const turnMessageIds = useSnapshotStore(useShallow((state) => {
    const order = state.messageOrder;
    const startIndex = order.indexOf(turnId);
    if (startIndex === -1) return [];
    const msgs = state.messagesById;
    const ids = [turnId];
    for (let i = startIndex + 1; i < order.length; i++) {
      const id = order[i];
      if (msgs[id]?.role === "user") break;
      ids.push(id);
    }
    return ids;
  }));

  if (!authorInfo || turnMessageIds.length === 0) return null;

  const lastMessageIdInTurn = turnMessageIds[turnMessageIds.length - 1];
  const lastMessageRole = useSnapshotStore(s => s.messagesById[lastMessageIdInTurn]?.role);

  const isGenerating = isSending && !pendingUserMessageContent && isLastTurn;

  const authorOverride: MessageShellAuthorInfo = {
    name: `${t("coauthor_author_assistant")}: ${authorInfo.character.name}`,
    avatarAssetId: authorInfo.character.avatarAssetId,
    avatarCropJson: authorInfo.character.avatarCropJson,
    avatarSrc: resolveEntityAvatarUrl({
      kind: "characters",
      id: authorInfo.character.id,
      avatarExt: authorInfo.character.avatarExt,
      avatarAssetId: authorInfo.character.avatarAssetId,
      updatedAt: authorInfo.character.updatedAt,
    }),
    avatarNode: (
      <div className="flex h-full w-full items-center justify-center bg-s3">
        <Icons.Sparkles className="h-5 w-5 text-t3" />
      </div>
    ),
    nameNode: (
      <span className="flex items-center gap-1.5">
        <span className="text-t3">{t("coauthor_author_assistant")}:</span>
        <span className="flex items-center gap-1.5 font-medium text-accent-t">
          <div className="h-5 w-5 overflow-hidden rounded-full bg-s3">
            {authorInfo.character.avatarAssetId ? (
              <img
                src={resolveEntityAvatarUrl({
                  kind: "characters",
                  id: authorInfo.character.id,
                  avatarExt: authorInfo.character.avatarExt,
                  avatarAssetId: authorInfo.character.avatarAssetId,
                  updatedAt: authorInfo.character.updatedAt,
                })!}
                alt={authorInfo.character.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-s3 text-[10px] font-medium text-t3">
                {authorInfo.character.name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          {authorInfo.character.name}
        </span>
      </span>
    ),
  };

  const messageActionId = useChatStore(s => s.messageActionId);
  const isBusy = isSending || messageActionId === lastMessageIdInTurn;

  const actions = {
    onCopy: () => {
      const state = useSnapshotStore.getState();
      const text = turnMessageIds
        .map(id => state.messagesById[id])
        .filter(m => m?.role === "assistant")
        .map(m => m?.content)
        .filter(Boolean)
        .join("\n\n");
      void navigator.clipboard?.writeText(text);
    },
    onEdit: () => {
      const state = useSnapshotStore.getState();
      const lastAssistantId = [...turnMessageIds].reverse().find(id => state.messagesById[id]?.role === "assistant");
      if (lastAssistantId) {
        const msg = state.messagesById[lastAssistantId];
        if (msg) chat.handleStartEdit(msg);
      }
    },
    onDelete: () => {},
    onBranch: () => {},
    onRegenerate: () => {},
    onResend: () => void chat.handleResend(),
  };

  const assistantMessageIds = turnMessageIds.filter(id => {
    const role = useSnapshotStore.getState().messagesById[id]?.role;
    return role === "assistant";
  });

  return (
    <MessageShell
      messageId={turnId}
      chatId={authorInfo.activeChatId}
      role="assistant"
      showSeparator={index > 0}
      author={authorOverride}
      isUser={false}
      isGreeting={false}
      isEditing={false}
      isGenerating={isGenerating}
      isBusy={isBusy}
      canBranch={false}
      canRegenerate={false}
      canResend={false}
      selectedVariantIndex={0}
      variantCount={1}
      canSwitchVariant={false}
      tokenCount={0}
      createdAt={useSnapshotStore.getState().messagesById[turnId]?.createdAt ?? ""}
      copied={false}
      slotExtras={{}}
      variantControlsOverlay={null}
      variantControlsRef={{ current: null }}
      actions={actions}
    >
      <div className="flex flex-col gap-3">
        {assistantMessageIds.map((msgId) => (
          <CoauthorTurnPart 
            key={msgId} 
            messageId={msgId} 
            chatId={authorInfo.activeChatId}
          />
        ))}
        {isGenerating && lastMessageRole === "tool" && (
          <div className="mt-1">
            <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-label={t("generating_response")}>
              <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
              <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
              <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
            </span>
          </div>
        )}
      </div>
    </MessageShell>
  );
});

const CoauthorTurnPart = memo(function CoauthorTurnPart({ messageId, chatId }: { messageId: string, chatId: string }) {
  const msg = useDisplayMessage(messageId);
  const isStreamingTarget = useIsStreamingTarget(messageId);
  const streamingReveal = useStreamingRevealedFor(messageId);
  
  if (!msg) return null;

  const isStreamingHere = isStreamingTarget && (!!streamingReveal.streamingText || !!streamingReveal.reasoningText);
  const activeStreamingRevealedText = isStreamingHere ? streamingReveal.revealedText : "";
  const activeStreamingReasoning = isStreamingHere ? streamingReveal.reasoningText : null;
  const reasoningText = msg.variants?.[msg.selectedVariantIndex ?? 0]?.reasoning || null;

  const finalReasoning = isStreamingHere ? (activeStreamingReasoning || reasoningText) : reasoningText;

  return (
    <div className="flex flex-col gap-3">
      {finalReasoning && (
        <details className="group overflow-hidden rounded border border-border bg-s1">
          <summary className="cursor-pointer px-3 py-1.5 font-ui text-[11px] font-medium text-t3 transition-colors hover:text-t2">
            Reasoning
          </summary>
          <div className="border-t border-border px-3 py-2">
            <pre className="whitespace-pre-wrap font-mono text-[11px] text-t3">{finalReasoning}</pre>
          </div>
        </details>
      )}

      {(msg.displayContent || isStreamingHere) && (
        <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
          {isStreamingHere ? (
            <StreamingMarkdown text={activeStreamingRevealedText} />
          ) : (
            <Markdown text={msg.displayContent} />
          )}
        </div>
      )}

      <CoauthorToolActivitySlot chatId={chatId} messageId={messageId} isStreaming={isStreamingHere} />
    </div>
  );
});
