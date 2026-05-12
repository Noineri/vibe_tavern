import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ChatBranchId, ChatId } from "@rp-platform/domain";
import { getT } from "../i18n/context.js";
import {
  generateReplyStream,
  logClientSendDebug,
  regenerateChatMessageStream,
  sendChatMessageStream,
  type AppMessage,
  type AppSnapshot,
  type ChatGenerationStatus,
} from "../app-client.js";
import { useChatStore } from "../stores/chat-store.js";
import { chatKeys } from "../queries/query-keys.js";
import { StreamingReveal } from "../lib/streaming-reveal.js";
import {
  useEditMessageMutation,
  useDeleteMessageMutation,
  useSwitchChatMutation,
  useSelectVariantMutation,
  useForkMutation,
  useActivateBranchMutation,
  useDeleteBranchMutation,
  useSendMessageMutation,
  useRegenerateMessageMutation,
  useGenerateReplyMutation,
} from "../queries/chat-queries.js";

export interface ChatControllerDeps {
  // read state (getter functions — Zustand-compatible)
  getActiveChatId: () => ChatId | null;
  getSnapshot: () => AppSnapshot | null;
  getDraft: () => string;
  getIsSending: () => boolean;
  getCanSendViaActiveProfile: () => boolean;
  getEditingDraft: () => string;
  getEditingMessageId: () => string | null;
  getGenerationStatus: () => ChatGenerationStatus;
  getStreamResponse: () => boolean;
  // write / mutate
  refreshChatSnapshot: (chatId: ChatId) => Promise<AppSnapshot>;
  setDraft: (draft: string) => void;
  setIsSending: (sending: boolean) => void;
  setPendingUserMessageContent: (content: string | null) => void;
  setMessageActionId: (id: string | null) => void;
  setEditingMessageId: (id: string | null) => void;
  setEditingDraft: (draft: string) => void;
  setSelectedTraceId: (id: string | null) => void;
  setGenerationStatus: (status: ChatGenerationStatus) => void;
}

export interface ChatControllerActions {
  handleSend: () => Promise<void>;
  handleCancelGeneration: () => void;
  handleSwitchChat: (chatId: ChatId) => Promise<void>;
  handleStartEdit: (message: AppMessage) => void;
  handleCancelEdit: () => void;
  handleSaveMessageEdit: (messageId: string) => Promise<void>;
  handleDeleteMessage: (messageId: string) => Promise<void>;
  handleRegenerateMessage: (messageId: string) => Promise<void>;
  handleSelectMessageVariant: (messageId: string, variantIndex: number) => Promise<void>;
  handleResend: () => Promise<void>;
  handleFork: () => Promise<void>;
  handleActivateBranch: (branchId: ChatBranchId) => Promise<void>;
  handleDeleteActiveBranch: () => Promise<void>;
}

export function useChatController(deps: ChatControllerDeps): ChatControllerActions {
  const {
    getActiveChatId,
    getSnapshot,
    getDraft,
    getIsSending,
    getCanSendViaActiveProfile,
    getEditingDraft,
    getEditingMessageId,
    getGenerationStatus,
    getStreamResponse,
    refreshChatSnapshot,
    setDraft,
    setIsSending,
    setPendingUserMessageContent,
    setMessageActionId,
    setEditingMessageId,
    setEditingDraft,
    setSelectedTraceId,
    setGenerationStatus,
  } = deps;

  const qc = useQueryClient();

  // TQ mutation hooks
  const sendMessageMut = useSendMessageMutation();
  const regenMessageMut = useRegenerateMessageMutation();
  const generateReplyMut = useGenerateReplyMutation();
  const editMessageMut = useEditMessageMutation();
  const deleteMessageMut = useDeleteMessageMutation();
  const switchChatMut = useSwitchChatMutation();
  const selectVariantMut = useSelectVariantMutation();
  const forkMut = useForkMutation();
  const activateBranchMut = useActivateBranchMutation();
  const deleteBranchMut = useDeleteBranchMutation();

  const abortRef = useRef<AbortController | null>(null);
  const streamingReveal = useRef(new StreamingReveal());

  /** Refetch chat snapshot cache from the canonical source, bypassing TQ staleTime. */
  async function refreshChatSnapshotCache(chatId: ChatId): Promise<AppSnapshot> {
    const snapshot = await refreshChatSnapshot(chatId);
    qc.setQueryData(chatKeys.snapshot(chatId), snapshot);
    return snapshot;
  }

  /**
   * After an abort, the backend needs a moment to save the partial variant
   * before we fetch the snapshot. Without this pause, the snapshot may be
   * stale (missing the just-saved partial), causing the variant counter to
   * lag behind (e.g. shows 5/5 instead of 6/6).
   */
  async function refreshAfterAbort(chatId: ChatId): Promise<AppSnapshot> {
    await new Promise((r) => setTimeout(r, 200));
    return refreshChatSnapshotCache(chatId);
  }

  const handleSend = useCallback(async (): Promise<void> => {
    const activeChatId = getActiveChatId();
    const draft = getDraft();
    const trimmed = draft.trim();

    void logClientSendDebug("web.hook.handleSend.enter", {
      activeChatId,
      draftLength: draft.length,
      trimmedLength: trimmed.length,
      isSending: getIsSending(),
      canSendViaActiveProfile: getCanSendViaActiveProfile(),
    });

    if (!trimmed || getIsSending() || !activeChatId) {
      void logClientSendDebug("web.hook.handleSend.blocked.basic", {
        activeChatId,
        trimmedLength: trimmed.length,
        isSending: getIsSending(),
      });
      return;
    }

    if (!getCanSendViaActiveProfile()) {
      void logClientSendDebug("web.hook.handleSend.blocked.provider", {
        activeChatId,
      });
      toast.error(getT()("message_unavailable_no_provider"));
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setDraft("");
    setPendingUserMessageContent(trimmed);
    setIsSending(true);

    try {
      if (getStreamResponse()) {
        void logClientSendDebug("web.hook.handleSend.stream-request", { activeChatId, generationStatus: getGenerationStatus() });
        let collected = "";
        await sendChatMessageStream(activeChatId, { content: trimmed }, {
          signal: controller.signal,
          onStatus: setGenerationStatus,
          onChunk: (delta) => {
            collected += delta;
            streamingReveal.current.pushDelta(delta);
          },
        });
        await streamingReveal.current.waitForReveal();
        await refreshChatSnapshotCache(activeChatId);
        void logClientSendDebug("web.hook.handleSend.stream-success", { activeChatId, replyLength: collected.length });
      } else {
        void logClientSendDebug("web.hook.handleSend.request", { activeChatId });
        const nextSnapshot = await sendMessageMut.mutateAsync(
          { chatId: activeChatId, content: trimmed, signal: controller.signal },
        );
        setSelectedTraceId(nextSnapshot.promptTrace?.id ?? nextSnapshot.promptTraceHistory[0]?.id ?? null);
        void logClientSendDebug("web.hook.handleSend.success", { activeChatId });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        void logClientSendDebug("web.hook.handleSend.cancelled", { activeChatId });
        await refreshAfterAbort(activeChatId);
        toast.info(getT()("generation_cancelled"));
        return;
      }
      void logClientSendDebug("web.hook.handleSend.error", {
        activeChatId,
        message: error instanceof Error ? error.message : String(error),
      });
      await refreshChatSnapshotCache(activeChatId);
      toast.error(error instanceof Error && error.message ? error.message : getT()("message_send_failed"));
    } finally {
      setPendingUserMessageContent(null);
      setIsSending(false);
      abortRef.current = null;
      streamingReveal.current.clear();
    }
  }, [sendMessageMut]);

  const handleResend = useCallback(async (): Promise<void> => {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    if (!getCanSendViaActiveProfile()) {
      toast.error(getT()("resend_unavailable_no_provider"));
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setIsSending(true);
    try {
      if (getStreamResponse()) {
        void logClientSendDebug("web.hook.handleResend.stream-request", { activeChatId, generationStatus: getGenerationStatus() });
        let collected = "";
        await generateReplyStream(activeChatId, {
          signal: controller.signal,
          onStatus: setGenerationStatus,
          onChunk: (delta) => {
            collected += delta;
            streamingReveal.current.pushDelta(delta);
          },
        });
        await streamingReveal.current.waitForReveal();
        await refreshChatSnapshotCache(activeChatId);
        void logClientSendDebug("web.hook.handleResend.stream-success", { activeChatId, replyLength: collected.length });
      } else {
        void logClientSendDebug("web.hook.handleResend.request", { activeChatId });
        const nextSnapshot = await generateReplyMut.mutateAsync({ chatId: activeChatId, signal: controller.signal });
        setSelectedTraceId(nextSnapshot.promptTrace?.id ?? nextSnapshot.promptTraceHistory[0]?.id ?? null);
        void logClientSendDebug("web.hook.handleResend.success", { activeChatId });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        void logClientSendDebug("web.hook.handleResend.cancelled", { activeChatId });
        await refreshAfterAbort(activeChatId);
        toast.info(getT()("generation_cancelled"));
        return;
      }
      void logClientSendDebug("web.hook.handleResend.error", {
        activeChatId,
        message: error instanceof Error ? error.message : String(error),
      });
      await refreshChatSnapshotCache(activeChatId);
      toast.error(error instanceof Error && error.message ? error.message : getT()("resend_failed"));
    } finally {
      setIsSending(false);
      abortRef.current = null;
      streamingReveal.current.clear();
    }
  }, [generateReplyMut]);

  const handleCancelGeneration = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    toast.info(getT()("cancelling_generation"));
  }, []);

  async function handleSwitchChat(chatId: ChatId): Promise<void> {
    // No-op when switching to the same active chat — avoids unnecessary re-fetch
    // that would discard in-memory state like variant selection.
    if (chatId === getActiveChatId()) return;
    await switchChatMut.mutateAsync(chatId);
    useChatStore.getState().setActiveChatId(chatId);
  }

  function handleStartEdit(message: AppMessage): void {
    setEditingMessageId(message.id);
    setEditingDraft(message.content);
  }

  function handleCancelEdit(): void {
    setEditingMessageId(null);
    setEditingDraft("");
  }

  async function handleSaveMessageEdit(messageId: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    const trimmed = getEditingDraft().trim();
    if (!trimmed) return;

    setMessageActionId(messageId);
    try {
      await editMessageMut.mutateAsync({ chatId: activeChatId, messageId, content: trimmed });
      setEditingMessageId(null);
      setEditingDraft("");
    } finally {
      setMessageActionId(null);
    }
  }

  async function handleDeleteMessage(messageId: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId || !window.confirm(getT()("delete_message_title"))) return;

    setMessageActionId(messageId);
    try {
      await deleteMessageMut.mutateAsync({ chatId: activeChatId, messageId });
      if (getEditingMessageId() === messageId) {
        setEditingMessageId(null);
        setEditingDraft("");
      }
    } finally {
      setMessageActionId(null);
    }
  }

  async function handleRegenerateMessage(messageId: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    if (!getCanSendViaActiveProfile()) {
      toast.error(getT()("regen_unavailable_no_provider"));
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setIsSending(true);
    setMessageActionId(messageId);
    try {
      if (getStreamResponse()) {
        void logClientSendDebug("web.hook.handleRegenerate.stream-request", { activeChatId, messageId, generationStatus: getGenerationStatus() });
        let collected = "";
        await regenerateChatMessageStream(activeChatId, messageId, {
          signal: controller.signal,
          onStatus: setGenerationStatus,
          onChunk: (delta) => {
            collected += delta;
            streamingReveal.current.pushDelta(delta);
          },
        });
        await streamingReveal.current.waitForReveal();
        await refreshChatSnapshotCache(activeChatId);
        void logClientSendDebug("web.hook.handleRegenerate.stream-success", { activeChatId, messageId, replyLength: collected.length });
      } else {
        const nextSnapshot = await regenMessageMut.mutateAsync(
          { chatId: activeChatId, messageId, signal: controller.signal },
        );
        setSelectedTraceId(nextSnapshot.promptTrace?.id ?? nextSnapshot.promptTraceHistory[0]?.id ?? null);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        void logClientSendDebug("web.hook.handleRegenerate.cancelled", { activeChatId, messageId });
        await refreshAfterAbort(activeChatId);
        toast.info(getT()("generation_cancelled"));
        return;
      }
      await refreshChatSnapshotCache(activeChatId);
      toast.error(error instanceof Error ? error.message : getT()("regen_failed"));
    } finally {
      setIsSending(false);
      setMessageActionId(null);
      abortRef.current = null;
      streamingReveal.current.clear();
    }
  }

  async function handleSelectMessageVariant(messageId: string, variantIndex: number): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId || variantIndex < 0) return;

    await selectVariantMut.mutateAsync({ chatId: activeChatId, messageId, variantIndex });
  }

  async function handleFork(): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    await forkMut.mutateAsync(activeChatId);
  }

  async function handleActivateBranch(branchId: ChatBranchId): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    await activateBranchMut.mutateAsync({ chatId: activeChatId, branchId });
  }

  async function handleDeleteActiveBranch(): Promise<void> {
    const activeChatId = getActiveChatId();
    const snapshot = getSnapshot();
    if (!activeChatId || !snapshot) return;

    const activeBranch = snapshot.activeBranch;
    const rootBranch = snapshot.branches.find((b) => b.parentBranchId === null);
    if (!rootBranch || activeBranch.id === rootBranch.id) {
      toast.error(getT()("cannot_delete_main_branch"));
      return;
    }

    try {
      await deleteBranchMut.mutateAsync({ chatId: activeChatId, branchId: activeBranch.id });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("branch_delete_failed"));
    }
  }

  return {
    handleSend,
    handleCancelGeneration,
    handleSwitchChat,
    handleStartEdit,
    handleCancelEdit,
    handleSaveMessageEdit,
    handleDeleteMessage,
    handleRegenerateMessage,
    handleSelectMessageVariant,
    handleResend,
    handleFork,
    handleActivateBranch,
    handleDeleteActiveBranch,
  };
}
