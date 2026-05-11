import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
  setChatNotice: (notice: string) => void;
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
    setChatNotice,
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
  const streamRevealRef = useRef<{
    target: string;
    shown: string;
    timer: ReturnType<typeof setTimeout> | null;
    flushResolve: (() => void) | null;
  }>({ target: "", shown: "", timer: null, flushResolve: null });

  function clearStreamingReveal(): void {
    const reveal = streamRevealRef.current;
    if (reveal.timer) clearTimeout(reveal.timer);
    reveal.target = "";
    reveal.shown = "";
    reveal.timer = null;
    reveal.flushResolve?.();
    reveal.flushResolve = null;
    useChatStore.getState().setStreamingText("");
  }

  function scheduleStreamingReveal(): void {
    const reveal = streamRevealRef.current;
    if (reveal.timer) return;

    const tick = () => {
      const state = streamRevealRef.current;
      const remaining = state.target.length - state.shown.length;
      if (remaining <= 0) {
        state.timer = null;
        state.flushResolve?.();
        state.flushResolve = null;
        return;
      }

      const step = remaining > 240 ? 8 : remaining > 120 ? 5 : 3;
      state.shown = state.target.slice(0, state.shown.length + step);
      useChatStore.getState().setStreamingText(state.shown);
      state.timer = setTimeout(tick, 24);
    };

    reveal.timer = setTimeout(tick, 16);
  }

  function pushStreamingDelta(delta: string): void {
    streamRevealRef.current.target += delta;
    scheduleStreamingReveal();
  }

  function waitForStreamingReveal(): Promise<void> {
    const reveal = streamRevealRef.current;
    if (reveal.shown.length >= reveal.target.length) return Promise.resolve();
    return new Promise((resolve) => {
      reveal.flushResolve = resolve;
      scheduleStreamingReveal();
    });
  }

  /** Refetch chat snapshot cache from the canonical source, bypassing TQ staleTime. */
  async function refreshChatSnapshotCache(chatId: ChatId): Promise<AppSnapshot> {
    const snapshot = await refreshChatSnapshot(chatId);
    qc.setQueryData(chatKeys.snapshot(chatId), snapshot);
    return snapshot;
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
      setChatNotice(
        getT()("message_unavailable_no_provider"),
      );
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setDraft("");
    setPendingUserMessageContent(trimmed);
    setChatNotice("");
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
            pushStreamingDelta(delta);
          },
        });
        await waitForStreamingReveal();
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
        await refreshChatSnapshotCache(activeChatId);
        setChatNotice(getT()("generation_cancelled"));
        return;
      }
      void logClientSendDebug("web.hook.handleSend.error", {
        activeChatId,
        message: error instanceof Error ? error.message : String(error),
      });
      await refreshChatSnapshotCache(activeChatId);
      setChatNotice(error instanceof Error && error.message ? error.message : getT()("message_send_failed"));
    } finally {
      setPendingUserMessageContent(null);
      setIsSending(false);
      abortRef.current = null;
      clearStreamingReveal();
    }
  }, [sendMessageMut]);

  const handleResend = useCallback(async (): Promise<void> => {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    if (!getCanSendViaActiveProfile()) {
      setChatNotice(
        getT()("resend_unavailable_no_provider"),
      );
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setIsSending(true);
    setChatNotice("");
    try {
      if (getStreamResponse()) {
        void logClientSendDebug("web.hook.handleResend.stream-request", { activeChatId, generationStatus: getGenerationStatus() });
        let collected = "";
        await generateReplyStream(activeChatId, {
          signal: controller.signal,
          onStatus: setGenerationStatus,
          onChunk: (delta) => {
            collected += delta;
            pushStreamingDelta(delta);
          },
        });
        await waitForStreamingReveal();
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
        await refreshChatSnapshotCache(activeChatId);
        setChatNotice(getT()("generation_cancelled"));
        return;
      }
      void logClientSendDebug("web.hook.handleResend.error", {
        activeChatId,
        message: error instanceof Error ? error.message : String(error),
      });
      await refreshChatSnapshotCache(activeChatId);
      setChatNotice(error instanceof Error && error.message ? error.message : getT()("resend_failed"));
    } finally {
      setIsSending(false);
      abortRef.current = null;
      clearStreamingReveal();
    }
  }, [generateReplyMut]);

  const handleCancelGeneration = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setChatNotice(getT()("cancelling_generation"));
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
      setChatNotice("");
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
      setChatNotice("");
    } finally {
      setMessageActionId(null);
    }
  }

  async function handleRegenerateMessage(messageId: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    if (!getCanSendViaActiveProfile()) {
      setChatNotice(
        getT()("regen_unavailable_no_provider"),
      );
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setIsSending(true);
    setMessageActionId(messageId);
    setChatNotice("");
    try {
      if (getStreamResponse()) {
        void logClientSendDebug("web.hook.handleRegenerate.stream-request", { activeChatId, messageId, generationStatus: getGenerationStatus() });
        let collected = "";
        await regenerateChatMessageStream(activeChatId, messageId, {
          signal: controller.signal,
          onStatus: setGenerationStatus,
          onChunk: (delta) => {
            collected += delta;
            pushStreamingDelta(delta);
          },
        });
        await waitForStreamingReveal();
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
        await refreshChatSnapshotCache(activeChatId);
        setChatNotice(getT()("generation_cancelled"));
        return;
      }
      await refreshChatSnapshotCache(activeChatId);
      setChatNotice(error instanceof Error ? error.message : getT()("regen_failed"));
    } finally {
      setIsSending(false);
      setMessageActionId(null);
      abortRef.current = null;
      clearStreamingReveal();
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
      setChatNotice(getT()("cannot_delete_main_branch"));
      return;
    }

    try {
      await deleteBranchMut.mutateAsync({ chatId: activeChatId, branchId: activeBranch.id });
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : getT()("branch_delete_failed"));
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
