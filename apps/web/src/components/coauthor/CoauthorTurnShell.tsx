import { memo, useState } from "react";
import { useChatStore, useIsSending } from "../../stores/index.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useDisplayMessage, useMessageAuthor, useIsStreamingTarget, useStreamingRevealedFor } from "../../stores/chat-selectors.js";
import { MessageShell, type MessageShellAuthorInfo } from "../chat/MessageShell.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { Markdown } from "../../lib/markdown.js";
import { StreamingMarkdown } from "../chat/StreamingMarkdown.js";
import { CoauthorToolActivitySlot } from "../chat/CoauthorToolActivitySlot.js";
import { MessageReasoning } from "../chat/MessageReasoning.js";
import { Logo } from "../shared/Logo.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { MobileExpandTextarea } from "../shared/MobileExpandTextarea.js";
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

  const lastMessageIdInTurn = turnMessageIds[turnMessageIds.length - 1] ?? turnId;
  const lastMessageRole = useSnapshotStore(s => s.messagesById[lastMessageIdInTurn]?.role);
  const isEditingTurn = useChatStore(s => turnMessageIds.includes(s.editingMessageId ?? ""));
  const [copied, setCopied] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const messageActionId = useChatStore(s => s.messageActionId);

  const assistantMessageIds = turnMessageIds.filter(id => {
    const role = useSnapshotStore.getState().messagesById[id]?.role;
    return role === "assistant";
  });

  const lastAssistantMsg = useSnapshotStore(s => {
    const ids = [...assistantMessageIds].reverse();
    for (const id of ids) {
      const m = s.messagesById[id];
      if (m) return m;
    }
    return null;
  });

  if (!authorInfo || turnMessageIds.length === 0) return null;

  const isGenerating = isSending && !pendingUserMessageContent && isLastTurn;

  const characterAvatarUrl = resolveEntityAvatarUrl({
    kind: "characters",
    id: authorInfo.character.id,
    avatarExt: authorInfo.character.avatarExt,
    avatarAssetId: authorInfo.character.avatarAssetId,
    updatedAt: authorInfo.character.updatedAt,
  });

  const authorOverride: MessageShellAuthorInfo = {
    name: `${t("coauthor_author_assistant")}: ${authorInfo.character.name}`,
    avatarAssetId: authorInfo.character.avatarAssetId,
    avatarCropJson: authorInfo.character.avatarCropJson,
    avatarSrc: characterAvatarUrl,
    avatarNode: (
      <div className="flex h-full w-full items-center justify-center">
        <Logo className="h-[28px] w-[28px]" />
      </div>
    ),
    nameNode: (
      <span className="flex items-center gap-1.5">
        <span className="text-t3">{t("coauthor_author_assistant")}:</span>
        <span className="flex items-center gap-1.5 font-medium text-accent-t">
          <div className="h-8 w-8 overflow-hidden rounded-full bg-s3">
            {characterAvatarUrl ? (
              <img
                src={characterAvatarUrl}
                alt={authorInfo.character.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-s3 text-[12px] font-medium text-t3">
                {authorInfo.character.name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          {authorInfo.character.name}
        </span>
      </span>
    ),
  };

  const isBusy = isSending || messageActionId === lastMessageIdInTurn;

  const confirmDeleteTurn = async () => {
    setDeleteConfirmOpen(false);
    const ids = [...turnMessageIds].reverse();
    for (const id of ids) {
      await chat.handleDeleteMessage(id);
    }
  };

  const actions = {
    onCopy: () => {
      const state = useSnapshotStore.getState();
      const text = turnMessageIds
        .map(id => state.messagesById[id])
        .filter(m => m?.role === "assistant" && (!m.toolCalls || m.toolCalls.length === 0))
        .map(m => m?.content)
        .filter(Boolean)
        .join("\n\n");
      void navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    },
    onEdit: () => {
      const state = useSnapshotStore.getState();
      const lastAssistantId = [...turnMessageIds].reverse().find(id => {
        const m = state.messagesById[id];
        return m?.role === "assistant" && (!m.toolCalls || m.toolCalls.length === 0);
      });
      if (lastAssistantId) {
        const msg = state.messagesById[lastAssistantId];
        if (msg) chat.handleStartEdit(msg);
      }
    },
    onDelete: () => setDeleteConfirmOpen(true),
    onBranch: () => {},
    onRegenerate: () => {},
    onResend: () => void chat.handleResend(),
  };

  return (
    <>
    {deleteConfirmOpen && (
      <DestructiveConfirmModal
        title={t("delete_message_title")}
        body={t("coauthor_delete_turn_body")}
        confirmLabel={t("delete")}
        onConfirm={() => void confirmDeleteTurn()}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    )}
    <MessageShell
      messageId={turnId}
      chatId={authorInfo.activeChatId}
      role="assistant"
      showSeparator={index > 0}
      author={authorOverride}
      isUser={false}
      isGreeting={false}
      isEditing={isEditingTurn}
      isGenerating={isGenerating}
      isBusy={isBusy}
      canBranch={false}
      canRegenerate={false}
      canResend={false}
      selectedVariantIndex={0}
      variantCount={1}
      canSwitchVariant={false}
      tokenCount={0}
      modelId={lastAssistantMsg?.modelId ?? null}
      coauthorModuleId={lastAssistantMsg?.coauthorModuleId ?? null}
      coauthorSkillId={lastAssistantMsg?.coauthorSkillId ?? null}
      createdAt={useSnapshotStore.getState().messagesById[turnId]?.createdAt ?? ""}
      copied={copied}
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
    </>
  );
});

const CoauthorTurnPart = memo(function CoauthorTurnPart({ messageId, chatId }: { messageId: string, chatId: string }) {
  const { t } = useT();
  const msg = useDisplayMessage(messageId);
  const isStreamingTarget = useIsStreamingTarget(messageId);
  const streamingReveal = useStreamingRevealedFor(messageId);
  const chat = useChatController();
  const isEditingThisPart = useChatStore(s => s.editingMessageId === messageId);
  const editingDraft = useChatStore(s => s.editingDraft);
  const isSending = useIsSending();
  const isMessageAction = useChatStore(s => s.messageActionId === messageId);
  const isBusy = isSending || isMessageAction;

  if (!msg) return null;

  const isStreamingHere = isStreamingTarget && (!!streamingReveal.streamingText || !!streamingReveal.reasoningText);
  const activeStreamingRevealedText = isStreamingHere ? streamingReveal.revealedText : "";
  const activeStreamingReasoning = isStreamingHere ? streamingReveal.reasoningText : null;
  const selectedVariant = msg.variants?.[msg.selectedVariantIndex ?? 0];
  const reasoningText = selectedVariant?.reasoning || null;

  const finalReasoning = isStreamingHere ? (activeStreamingReasoning || reasoningText) : reasoningText;

  return (
    <div className="flex flex-col gap-3">
      {isEditingThisPart ? (
        <>
          <MobileExpandTextarea
            value={editingDraft}
            onChange={(v) => useChatStore.getState().setEditingDraft(v)}
            label={t("edit")}
          >
            <AutoTextarea
              className="w-full resize-none overflow-hidden rounded-md border border-accent bg-s2 px-3.5 py-3 font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 outline-none"
              style={{}}
              minRows={7}
              value={editingDraft}
              onChange={e => useChatStore.getState().setEditingDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') chat.handleCancelEdit(); }}
              autoFocus
            />
          </MobileExpandTextarea>
          <div className="mt-1.5 flex gap-1.5">
            <button type="button"
              className="cursor-pointer rounded-[5px] bg-accent px-3 py-[5px] font-ui text-xs font-medium text-on-accent transition-all duration-100 hover:brightness-110"
              disabled={isBusy}
              onClick={() => void chat.handleSaveMessageEdit(messageId)}
            >{t("save_edit")}</button>
            <button type="button"
              className="cursor-pointer rounded-[5px] bg-s2 px-3 py-[5px] font-ui text-xs font-medium text-t2 transition-all duration-100 hover:bg-s3"
              disabled={isBusy}
              onClick={chat.handleCancelEdit}
            >{t("cancel")}</button>
          </div>
        </>
      ) : (
        <>
          {finalReasoning && (
            <MessageReasoning reasoning={finalReasoning} reasoningDurationMs={selectedVariant?.reasoningDurationMs ?? null} variant="minimal" />
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
        </>
      )}
    </div>
  );
});
