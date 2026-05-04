import { useCallback, useRef } from "react";
import type { ChatBranchId, ChatId } from "@rp-platform/domain";
import {
  activateBranch,
  deleteBranch,
  deleteChatMessage,
  editChatMessage,
  fetchChat,
  forkBranch,
  logClientSendDebug,
  regenerateChatMessage,
  selectMessageVariant,
  sendChatMessage,
  type AppMessage,
  type AppSnapshot,
} from "../app-client.js";

export interface ChatControllerDeps {
  // read state (getter functions — Zustand-compatible)
  getActiveChatId: () => ChatId | null;
  getSnapshot: () => AppSnapshot | null;
  getDraft: () => string;
  getIsSending: () => boolean;
  getCanSendViaActiveProfile: () => boolean;
  getEditingDraft: () => string;
  getEditingMessageId: () => string | null;
  // write / mutate
  setSnapshot: (chatId: ChatId, next: AppSnapshot) => void;
  setDraft: (draft: string) => void;
  setIsSending: (sending: boolean) => void;
  setChatNotice: (notice: string) => void;
  setPendingUserMessageContent: (content: string | null) => void;
  setMessageActionId: (id: string | null) => void;
  setEditingMessageId: (id: string | null) => void;
  setEditingDraft: (draft: string) => void;
  setSelectedTraceId: (id: string | null) => void;
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
    setSnapshot,
    setDraft,
    setIsSending,
    setChatNotice,
    setPendingUserMessageContent,
    setMessageActionId,
    setEditingMessageId,
    setEditingDraft,
    setSelectedTraceId,
  } = deps;

  const abortRef = useRef<AbortController | null>(null);

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
        "Message sending is unavailable until a provider profile is activated and its default model is set. Open Provider settings, pick a model, press Save profile, then Set as active.",
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
      void logClientSendDebug("web.hook.handleSend.request", { activeChatId });
      const nextSnapshot = await sendChatMessage(activeChatId, { content: trimmed }, { signal: controller.signal });
      setSnapshot(activeChatId, nextSnapshot);
      setSelectedTraceId(nextSnapshot.promptTrace?.id ?? nextSnapshot.promptTraceHistory[0]?.id ?? null);
      void logClientSendDebug("web.hook.handleSend.success", { activeChatId });
    } catch (error) {
      if (controller.signal.aborted) {
        void logClientSendDebug("web.hook.handleSend.cancelled", { activeChatId });
        setSnapshot(activeChatId, await fetchChat(activeChatId));
        setChatNotice("Generation cancelled.");
        return;
      }
      void logClientSendDebug("web.hook.handleSend.error", {
        activeChatId,
        message: error instanceof Error ? error.message : String(error),
      });
      setSnapshot(activeChatId, await fetchChat(activeChatId));
      setChatNotice(error instanceof Error && error.message ? error.message : "Message sending failed.");
    } finally {
      setPendingUserMessageContent(null);
      setIsSending(false);
      abortRef.current = null;
    }
  }, []);

  const handleCancelGeneration = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setChatNotice("Cancelling generation…");
  }, []);

  async function handleSwitchChat(chatId: ChatId): Promise<void> {
    // No-op when switching to the same active chat — avoids unnecessary re-fetch
    // that would discard in-memory state like variant selection.
    if (chatId === getActiveChatId()) return;
    setSnapshot(chatId, await fetchChat(chatId));
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
      setSnapshot(activeChatId, await editChatMessage(activeChatId, messageId, trimmed));
      setEditingMessageId(null);
      setEditingDraft("");
      setChatNotice("");
    } finally {
      setMessageActionId(null);
    }
  }

  async function handleDeleteMessage(messageId: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId || !window.confirm("Delete this message?")) return;

    setMessageActionId(messageId);
    try {
      setSnapshot(activeChatId, await deleteChatMessage(activeChatId, messageId));
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
        "Regeneration is unavailable until a provider profile is activated and its default model is set.",
      );
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setIsSending(true);
    setMessageActionId(messageId);
    setChatNotice("");
    try {
      const nextSnapshot = await regenerateChatMessage(activeChatId, messageId, { signal: controller.signal });
      setSnapshot(activeChatId, nextSnapshot);
      setSelectedTraceId(nextSnapshot.promptTrace?.id ?? nextSnapshot.promptTraceHistory[0]?.id ?? null);
    } catch (error) {
      if (controller.signal.aborted) {
        void logClientSendDebug("web.hook.handleRegenerate.cancelled", { activeChatId, messageId });
        setSnapshot(activeChatId, await fetchChat(activeChatId));
        setChatNotice("Generation cancelled.");
        return;
      }
      setSnapshot(activeChatId, await fetchChat(activeChatId));
      setChatNotice(error instanceof Error ? error.message : "Regeneration failed.");
    } finally {
      setIsSending(false);
      setMessageActionId(null);
      abortRef.current = null;
    }
  }

  async function handleSelectMessageVariant(messageId: string, variantIndex: number): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId || variantIndex < 0) return;

    setSnapshot(activeChatId, await selectMessageVariant(activeChatId, messageId, variantIndex));
  }

  async function handleFork(): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    setSnapshot(activeChatId, await forkBranch(activeChatId));
  }

  async function handleActivateBranch(branchId: ChatBranchId): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    setSnapshot(activeChatId, await activateBranch(activeChatId, branchId));
  }

  async function handleDeleteActiveBranch(): Promise<void> {
    const activeChatId = getActiveChatId();
    const snapshot = getSnapshot();
    if (!activeChatId || !snapshot) return;

    const activeBranch = snapshot.activeBranch;
    const rootBranch = snapshot.branches.find((b) => b.parentBranchId === null);
    if (!rootBranch || activeBranch.id === rootBranch.id) {
      setChatNotice("Cannot delete: active branch is the main timeline.");
      return;
    }

    try {
      setSnapshot(activeChatId, await deleteBranch(activeChatId, activeBranch.id));
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Branch delete failed.");
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
    handleFork,
    handleActivateBranch,
    handleDeleteActiveBranch,
  };
}
