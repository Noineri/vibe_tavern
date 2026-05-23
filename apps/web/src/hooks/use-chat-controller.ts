import { useCallback, useMemo, useRef } from "react";
import { useChatDataStore } from "../stores/chat-data-store.js";
import { toast } from "sonner";
import type { ChatBranchId, ChatId } from "@rp-platform/domain";
import { getT } from "../i18n/context.js";
import {
  generateReplyStream,
  logClientSendDebug,
  regenerateChatMessageStream,
  sendChatMessageStream,
  type AppMessage,
  type ChatGenerationStatus,
} from "../app-client.js";
import { useChatStore, getAbortController, setAbortController, abortGeneration } from "../stores/chat-store.js";
import { useProviderStore } from "../stores/provider-store.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import { StreamingReveal } from "../lib/streaming-reveal.js";
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
  handleStartEdit: (message: AppMessage) => void;
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

  // AbortController is a module-level singleton in chat-store.ts.
  // Any hook instance can cancel via abortGeneration().
  const streamingReveal = useRef(new StreamingReveal());

  // --- Store helpers (imperative reads via getState, not subscriptions) ---

  function getActiveChatId(): ChatId | null { return useChatStore.getState().activeChatId; }
  function getDraft(): string { return useChatStore.getState().draft; }
  function getIsSending(): boolean { return useChatStore.getState().isSending; }
  function getEditingDraft(): string { return useChatStore.getState().editingDraft; }
  function getEditingMessageId(): string | null { return useChatStore.getState().editingMessageId; }
  function getGenerationStatus(): ChatGenerationStatus { return useChatStore.getState().generationStatus; }

  // --- Snapshot cache helpers ---

  /** Refetch chat snapshot cache from the canonical source. */
  async function refreshChatSnapshotCache(chatId: ChatId): Promise<void> {
    await fetchChatAction(chatId);
  }

  /**
   * After an abort, the backend needs a moment to save the partial variant
   * before we fetch the snapshot. Without this pause, the snapshot may be
   * stale (missing the just-saved partial), causing the variant counter to
   * lag behind (e.g. shows 5/5 instead of 6/6).
   */
  async function refreshAfterAbort(chatId: ChatId): Promise<void> {
    await new Promise((r) => setTimeout(r, 200));
    await refreshChatSnapshotCache(chatId);
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
      isSending: getIsSending(),
      canSendViaActiveProfile: canSendRef.current,
    });

    if (!trimmed || getIsSending() || !activeChatId) {
      void logClientSendDebug("web.hook.handleSend.blocked.basic", {
        activeChatId,
        trimmedLength: trimmed.length,
        isSending: getIsSending(),
      });
      return;
    }

    if (!canSendRef.current) {
      void logClientSendDebug("web.hook.handleSend.blocked.provider", {
        activeChatId,
      });
      toast.error(getT()("message_unavailable_no_provider"));
      return;
    }

    const controller = new AbortController();
    setAbortController(controller);
    const cs = useChatStore.getState();

    cs.setDraft("");
    cs.setPendingUserMessageContent(trimmed);
    cs.setIsSending(true);

    try {
      if (streamResponseRef.current) {
        void logClientSendDebug("web.hook.handleSend.stream-request", { activeChatId, generationStatus: getGenerationStatus() });
        let collected = "";
        await sendChatMessageStream(activeChatId, { content: trimmed }, {
          signal: controller.signal,
          onStatus: cs.setGenerationStatus,
          onChunk: (delta) => {
            collected += delta;
            streamingReveal.current.pushDelta(delta);
          },
          onReasoningChunk: (delta) => {
            const s = useChatStore.getState();
            s.setStreamingReasoningText(s.streamingReasoningText + delta);
          },
          onReasoningDone: () => {
            // Reasoning complete — text stays until snapshot refresh
          },
        });
        await streamingReveal.current.waitForReveal();
        useChatStore.getState().setPendingUserMessageContent(null);
        await refreshChatSnapshotCache(activeChatId);
        void logClientSendDebug("web.hook.handleSend.stream-success", { activeChatId, replyLength: collected.length });
      } else {
        void logClientSendDebug("web.hook.handleSend.request", { activeChatId });
        await sendChatMessageAction(activeChatId, trimmed, controller.signal);
        const nextSnapshotTrace = useChatDataStore.getState().promptTrace;
        const nextSnapshotTraceHistory = useChatDataStore.getState().promptTraceHistory;
        cs.setSelectedTraceId(nextSnapshotTrace?.id ?? nextSnapshotTraceHistory[0]?.id ?? null);
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
      useChatStore.getState().setPendingUserMessageContent(null);
      useChatStore.getState().setIsSending(false);
      useChatStore.getState().setStreamingReasoningText("");
      setAbortController(null);
      streamingReveal.current.clear();
    }
  }, []);

  const handleResend = useCallback(async (): Promise<void> => {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    if (!canSendRef.current) {
      toast.error(getT()("resend_unavailable_no_provider"));
      return;
    }

    const controller = new AbortController();
    setAbortController(controller);
    const cs = useChatStore.getState();
    cs.setIsSending(true);

    try {
      if (streamResponseRef.current) {
        void logClientSendDebug("web.hook.handleResend.stream-request", { activeChatId, generationStatus: getGenerationStatus() });
        let collected = "";
        await generateReplyStream(activeChatId, {
          signal: controller.signal,
          onStatus: cs.setGenerationStatus,
          onChunk: (delta) => {
            collected += delta;
            streamingReveal.current.pushDelta(delta);
          },
          onReasoningChunk: (delta) => {
            const s = useChatStore.getState();
            s.setStreamingReasoningText(s.streamingReasoningText + delta);
          },
          onReasoningDone: () => {},
        });
        await streamingReveal.current.waitForReveal();
        await refreshChatSnapshotCache(activeChatId);
        void logClientSendDebug("web.hook.handleResend.stream-success", { activeChatId, replyLength: collected.length });
      } else {
        void logClientSendDebug("web.hook.handleResend.request", { activeChatId });
        await generateReplyAction(activeChatId, controller.signal);
        const nextSnapshotTrace = useChatDataStore.getState().promptTrace;
        const nextSnapshotTraceHistory = useChatDataStore.getState().promptTraceHistory;
        cs.setSelectedTraceId(nextSnapshotTrace?.id ?? nextSnapshotTraceHistory[0]?.id ?? null);
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
      useChatStore.getState().setIsSending(false);
      useChatStore.getState().setStreamingReasoningText("");
      setAbortController(null);
      streamingReveal.current.clear();
    }
  }, []);

  const handleCancelGeneration = useCallback((): void => {
    abortGeneration();
    setAbortController(null);
    toast.info(getT()("cancelling_generation"));
  }, []);

  async function handleSwitchChat(chatId: ChatId): Promise<void> {
    if (chatId === getActiveChatId()) return;
    await switchChatAction(chatId);
    useChatStore.getState().setActiveChatId(chatId);
  }

  function handleStartEdit(message: AppMessage): void {
    useChatStore.getState().setEditingMessageId(message.id);
    useChatStore.getState().setEditingDraft(message.content);
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

    const controller = new AbortController();
    setAbortController(controller);

    const cs = useChatStore.getState();
    cs.setIsSending(true);
    cs.setMessageActionId(messageId);

    try {
      if (streamResponseRef.current) {
        void logClientSendDebug("web.hook.handleRegenerate.stream-request", { activeChatId, messageId, generationStatus: getGenerationStatus() });
        let collected = "";
        await regenerateChatMessageStream(activeChatId, messageId, {
          signal: controller.signal,
          onStatus: cs.setGenerationStatus,
          onChunk: (delta) => {
            collected += delta;
            streamingReveal.current.pushDelta(delta);
          },
          onReasoningChunk: (delta) => {
            const s = useChatStore.getState();
            s.setStreamingReasoningText(s.streamingReasoningText + delta);
          },
          onReasoningDone: () => {},
        });
        await streamingReveal.current.waitForReveal();
        await refreshChatSnapshotCache(activeChatId);
        void logClientSendDebug("web.hook.handleRegenerate.stream-success", { activeChatId, messageId, replyLength: collected.length });
      } else {
        await regenerateMessageAction(activeChatId, messageId, controller.signal);
        const nextSnapshotTrace = useChatDataStore.getState().promptTrace;
        const nextSnapshotTraceHistory = useChatDataStore.getState().promptTraceHistory;
        cs.setSelectedTraceId(nextSnapshotTrace?.id ?? nextSnapshotTraceHistory[0]?.id ?? null);
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
      useChatStore.getState().setIsSending(false);
      useChatStore.getState().setStreamingReasoningText("");
      useChatStore.getState().setMessageActionId(null);
      setAbortController(null);
      streamingReveal.current.clear();
    }
  }

  async function handleSelectMessageVariant(messageId: string, variantIndex: number): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId || variantIndex < 0) return;
    // Store already updated optimistically via selectVariant() in MessageBlock.
    // Fire-and-forget server persist (no syncSnapshot).
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
    const chatMeta = useChatDataStore.getState().chatMeta;
    if (!activeChatId || !chatMeta) return;

    const activeBranch = chatMeta.activeBranch;
    const rootBranch = chatMeta.branches.find((b) => b.parentBranchId === null);
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
