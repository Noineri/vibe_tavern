import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import type { ChatBranchId, ChatId } from "@vibe-tavern/domain";
import { getT } from "../i18n/locale-helpers.js";
import {
  generateReplyStream,
  logClientSendDebug,
  regenerateChatMessageStream,
  sendChatMessageStream,
  type AppMessage,
  type ChatGenerationStatus,
} from "../app-client.js";
import { useChatStore } from "../stores/chat-store.js";
import { useProviderStore } from "../stores/provider-store.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import { StreamingReveal } from "../lib/streaming-reveal.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import {
  fetchChatAction,
  sendChatMessageAction,
  regenerateMessageAction,
  generateReplyAction,
  editMessageAction,
  deleteMessageAction,
  switchChatAction,
  selectVariantAction,
  forkBranchAction,
  activateBranchAction,
  deleteBranchAction,
} from "../stores/api-actions/chat-actions.js";

export interface ChatControllerActions {
  handleSend: () => Promise<void>;
  handleCancelGeneration: () => void;
  handleSwitchChat: (chatId: ChatId) => Promise<void>;
  handleStartEdit: (message: AppMessage, contentOverride?: string) => void;
  handleCancelEdit: () => void;
  handleSaveMessageEdit: (messageId: string) => Promise<void>;
  handleDeleteMessage: (messageId: string) => Promise<void>;
  handleRegenerateMessage: (messageId: string) => Promise<void>;
  handleSelectMessageVariant: (messageId: string, variantIndex: number) => Promise<void>;
  handleResend: () => Promise<void>;
  handleFork: (messageId?: string) => Promise<void>;
  handleActivateBranch: (branchId: ChatBranchId) => Promise<void>;
  handleDeleteActiveBranch: () => Promise<void>;
}

export function useChatController(): ChatControllerActions {
  // --- Provider capabilities (derived internally) ---
  const providerProfiles = useProviderDataStore((s) => s.profiles);
  const activeProfile = useMemo(
    () => providerProfiles.find((p) => p.isActive) ?? null,
    [providerProfiles],
  );
  const canSendViaActiveProfile = activeProfile !== null && Boolean(activeProfile.defaultModel);
  const streamResponse = useProviderStore((s) => s.connection.streamResponse);

  // Refs for stable access in async callbacks
  const canSendRef = useRef(canSendViaActiveProfile);
  canSendRef.current = canSendViaActiveProfile;
  const streamResponseRef = useRef(streamResponse);
  streamResponseRef.current = streamResponse;

  // StreamingReveal is created per-generation, re-created when needed
  const streamingRevealRef = useRef<StreamingReveal | null>(null);

  // --- Store helpers (imperative reads via getState, not subscriptions) ---

  function getActiveChatId(): ChatId | null { return useChatStore.getState().activeChatId; }
  function getDraft(): string { return useChatStore.getState().draft; }
  function getEditingDraft(): string { return useChatStore.getState().editingDraft; }
  function getEditingMessageId(): string | null { return useChatStore.getState().editingMessageId; }

  // Per-chat helpers
  function getIsSending(chatId: string): boolean {
    return useChatStore.getState().generations[chatId]?.isSending ?? false;
  }
  function getGenerationStatus(chatId: string): ChatGenerationStatus {
    return useChatStore.getState().generations[chatId]?.generationStatus ?? "idle";
  }

  // --- Snapshot cache helpers ---

  /** Refetch chat snapshot cache from the canonical source. */
  async function refreshChatSnapshotCache(chatId: ChatId): Promise<void> {
    await fetchChatAction(chatId);
  }

  /**
   * After an abort, the backend needs a moment to save the partial variant
   * before we fetch the snapshot.
   */
  async function refreshAfterAbort(chatId: ChatId): Promise<void> {
    await new Promise((r) => setTimeout(r, 200));
    await refreshChatSnapshotCache(chatId);
  }

  // --- Common streaming helper ---

  /**
   * Execute a streaming action (send, regenerate, generateReply) with
   * per-chat generation state management.
   */
  async function executeStreamAction(
    chatId: ChatId,
    streamFn: (opts: {
      signal: AbortSignal;
      onStatus: (status: ChatGenerationStatus) => void;
      onChunk: (delta: string) => void;
      onReasoningChunk?: (delta: string) => void;
      onReasoningDone?: (info: { durationMs: number | null; redacted: boolean }) => void;
    }) => Promise<{ finishReason: string; usage?: Record<string, number> }>,
    pendingUserContent?: string | null,
  ): Promise<void> {
    const controller = useChatStore.getState().startGeneration(chatId, pendingUserContent);
    const store = useChatStore.getState();
    store.setDraft("");

    // Create a new StreamingReveal for this generation
    const reveal = new StreamingReveal(chatId);
    streamingRevealRef.current = reveal;

    try {
      let collected = "";
      await streamFn({
        signal: controller.signal,
        onStatus: (status) => useChatStore.getState().setGenerationStatus(chatId, status),
        onChunk: (delta) => {
          collected += delta;
          reveal.pushDelta(delta);
        },
        onReasoningChunk: (delta) => {
          useChatStore.getState().appendReasoningText(chatId, delta);
        },
        onReasoningDone: () => {
          // Reasoning complete — text stays until snapshot refresh
        },
      });

      await reveal.waitForReveal();
      useChatStore.getState().setPendingContent(chatId, null);
      await refreshChatSnapshotCache(chatId);
      void logClientSendDebug("web.hook.stream.success", { chatId, replyLength: collected.length });
    } catch (error) {
      if (controller.signal.aborted) {
        void logClientSendDebug("web.hook.stream.cancelled", { chatId });
        await refreshAfterAbort(chatId);
        toast.info(getT()("generation_cancelled"));
        return;
      }
      void logClientSendDebug("web.hook.stream.error", {
        chatId,
        message: error instanceof Error ? error.message : String(error),
      });
      await refreshChatSnapshotCache(chatId);
      toast.error(error instanceof Error && error.message ? error.message : getT()("message_send_failed"));
    } finally {
      useChatStore.getState().finishGeneration(chatId);
      reveal.clear();
      streamingRevealRef.current = null;
    }
  }

  // --- Actions ---

  const handleSend = useCallback(async (): Promise<void> => {
    const activeChatId = getActiveChatId();
    const draft = getDraft();
    const trimmed = draft.trim();

    void logClientSendDebug("web.hook.handleSend.enter", {
      activeChatId,
      draftLength: draft.length,
      trimmedLength: trimmed.length,
      isSending: activeChatId ? getIsSending(activeChatId) : false,
      canSendViaActiveProfile: canSendRef.current,
    });

    if (!trimmed || !activeChatId || getIsSending(activeChatId)) {
      void logClientSendDebug("web.hook.handleSend.blocked.basic", {
        activeChatId,
        trimmedLength: trimmed.length,
        isSending: activeChatId ? getIsSending(activeChatId) : false,
      });
      return;
    }

    if (!canSendRef.current) {
      void logClientSendDebug("web.hook.handleSend.blocked.provider", { activeChatId });
      toast.error(getT()("message_unavailable_no_provider"));
      return;
    }

    if (streamResponseRef.current) {
      void logClientSendDebug("web.hook.handleSend.stream-request", {
        activeChatId,
        generationStatus: getGenerationStatus(activeChatId),
      });
      await executeStreamAction(
        activeChatId,
        (opts) => sendChatMessageStream(activeChatId, { content: trimmed }, opts),
        trimmed,
      );
    } else {
      void logClientSendDebug("web.hook.handleSend.request", { activeChatId });
      const controller = useChatStore.getState().startGeneration(activeChatId, trimmed);
      const cs = useChatStore.getState();
      cs.setDraft("");
      try {
        await sendChatMessageAction(activeChatId, trimmed, controller.signal);
        const snapshot = useSnapshotStore.getState();
        cs.setSelectedTraceId(
          snapshot.promptTrace?.id ?? snapshot.promptTraceHistory[0]?.id ?? null,
        );
        void logClientSendDebug("web.hook.handleSend.success", { activeChatId });
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
        useChatStore.getState().finishGeneration(activeChatId);
      }
    }
  }, []);

  const handleResend = useCallback(async (): Promise<void> => {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    if (!canSendRef.current) {
      toast.error(getT()("resend_unavailable_no_provider"));
      return;
    }

    if (streamResponseRef.current) {
      void logClientSendDebug("web.hook.handleResend.stream-request", {
        activeChatId,
        generationStatus: getGenerationStatus(activeChatId),
      });
      await executeStreamAction(
        activeChatId,
        (opts) => generateReplyStream(activeChatId, opts),
      );
    } else {
      const controller = useChatStore.getState().startGeneration(activeChatId);
      try {
        await generateReplyAction(activeChatId, controller.signal);
        const snapshot = useSnapshotStore.getState();
        useChatStore.getState().setSelectedTraceId(
          snapshot.promptTrace?.id ?? snapshot.promptTraceHistory[0]?.id ?? null,
        );
        void logClientSendDebug("web.hook.handleResend.success", { activeChatId });
      } catch (error) {
        if (controller.signal.aborted) {
          void logClientSendDebug("web.hook.handleResend.cancelled", { activeChatId });
          await refreshAfterAbort(activeChatId);
          toast.info(getT()("generation_cancelled"));
          return;
        }
        await refreshChatSnapshotCache(activeChatId);
        toast.error(error instanceof Error ? error.message : getT()("resend_failed"));
      } finally {
        useChatStore.getState().finishGeneration(activeChatId);
      }
    }
  }, []);

  const handleCancelGeneration = useCallback((): void => {
    const chatId = getActiveChatId();
    if (chatId) {
      useChatStore.getState().abortGeneration(chatId);
    }
    toast.info(getT()("cancelling_generation"));
  }, []);

  async function handleSwitchChat(chatId: ChatId): Promise<void> {
    if (chatId === getActiveChatId()) return;
    await switchChatAction(chatId);
    useChatStore.getState().setActiveChatId(chatId);
  }

  function handleStartEdit(message: AppMessage, contentOverride?: string): void {
    useChatStore.getState().setEditingMessageId(message.id);
    useChatStore.getState().setEditingDraft(contentOverride ?? message.content);
  }

  function handleCancelEdit(): void {
    useChatStore.getState().setEditingMessageId(null);
    useChatStore.getState().setEditingDraft("");
  }

  async function handleSaveMessageEdit(messageId: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    const cs = useChatStore.getState();
    const trimmed = cs.editingDraft.trim();
    if (!trimmed) return;

    cs.setMessageActionId(messageId);
    try {
      await editMessageAction(activeChatId, messageId, trimmed);
      cs.setEditingMessageId(null);
      cs.setEditingDraft("");
    } finally {
      useChatStore.getState().setMessageActionId(null);
    }
  }

  async function handleDeleteMessage(messageId: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId || !window.confirm(getT()("delete_message_title"))) return;

    const cs = useChatStore.getState();
    cs.setMessageActionId(messageId);
    try {
      await deleteMessageAction(activeChatId, messageId);
      if (cs.editingMessageId === messageId) {
        useChatStore.getState().setEditingMessageId(null);
        useChatStore.getState().setEditingDraft("");
      }
    } finally {
      useChatStore.getState().setMessageActionId(null);
    }
  }

  async function handleRegenerateMessage(messageId: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    if (!canSendRef.current) {
      toast.error(getT()("regen_unavailable_no_provider"));
      return;
    }

    useChatStore.getState().setMessageActionId(messageId);

    if (streamResponseRef.current) {
      void logClientSendDebug("web.hook.handleRegenerate.stream-request", {
        activeChatId, messageId,
        generationStatus: getGenerationStatus(activeChatId),
      });
      await executeStreamAction(
        activeChatId,
        (opts) => regenerateChatMessageStream(activeChatId, messageId, opts),
      );
    } else {
      const controller = useChatStore.getState().startGeneration(activeChatId);
      try {
        await regenerateMessageAction(activeChatId, messageId, controller.signal);
        const snapshot = useSnapshotStore.getState();
        useChatStore.getState().setSelectedTraceId(
          snapshot.promptTrace?.id ?? snapshot.promptTraceHistory[0]?.id ?? null,
        );
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
        useChatStore.getState().finishGeneration(activeChatId);
      }
    }

    useChatStore.getState().setMessageActionId(null);
  }

  async function handleSelectMessageVariant(messageId: string, variantIndex: number): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId || variantIndex < 0) return;
    void selectVariantAction(activeChatId, messageId, variantIndex);
  }

  async function handleFork(messageId?: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;
    await forkBranchAction(activeChatId, messageId);
  }

  async function handleActivateBranch(branchId: ChatBranchId): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;
    await activateBranchAction(activeChatId, branchId);
  }

  async function handleDeleteActiveBranch(): Promise<void> {
    const activeChatId = getActiveChatId();
    const snapshot = useSnapshotStore.getState();
    if (!activeChatId || !snapshot.activeBranch) return;

    const activeBranch = snapshot.activeBranch;
    const rootBranch = snapshot.branches.find((b) => b.parentBranchId === null);
    if (!rootBranch || activeBranch.id === rootBranch.id) {
      toast.error(getT()("cannot_delete_main_branch"));
      return;
    }

    try {
      await deleteBranchAction(activeChatId, activeBranch.id);
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
