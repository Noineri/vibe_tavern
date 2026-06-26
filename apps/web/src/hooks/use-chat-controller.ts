import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import type { Attachment, ChatBranchId, ChatId } from "@vibe-tavern/domain";
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
import { useModalStore } from "../stores/modal-store.js";
import { useProviderStore } from "../stores/provider-store.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import { StreamingReveal } from "../lib/streaming-reveal.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { useTraceHistoryStore } from "../stores/trace-history-store.js";
import {
  fetchChatAction,
  sendChatMessageAction,
  regenerateMessageAction,
  generateReplyAction,
  editMessageAction,
  deleteMessageAction,
  deleteVariantAction,
  switchChatAction,
  selectVariantAction,
  forkBranchAction,
  activateBranchAction,
  deleteBranchAction,
  renameBranchAction,
} from "../stores/api-actions/chat-actions.js";
import { ProviderStreamError } from "../api/provider-stream-error.js";

function restoreDraftAfterSendError(content?: string | null, attachments?: Attachment[]): void {
  const store = useChatStore.getState();
  if (content != null && store.draft.length === 0) {
    store.setDraft(content);
  }
  if (attachments?.length) {
    const existingIds = new Set(useChatStore.getState().draftAttachments.map((att) => att.id));
    attachments.forEach((att) => {
      if (!existingIds.has(att.id)) store.addDraftAttachment(att);
    });
  }
}

// Categories where the failure is likely transient (retry after a short wait) —
// the message alone is enough; we just add a "try again" hint.
const TRANSIENT_PROVIDER_CATEGORIES = new Set(["rate_limit", "timeout", "network", "server_error"]);

/**
 * Shows a category-aware toast for a provider/LLM generation failure. Reads the
 * server-classified `category` from a {@link ProviderStreamError} and picks a
 * description + (for auth) an action that opens provider settings — so the user
 * gets actionable feedback instead of raw HTTP text. Mirrors the existing
 * VISION_NOT_SUPPORTED toast shape. Falls back to the raw message for
 * `unknown` (and for non-ProviderStreamError errors, e.g. network failures
 * before the request reached the server).
 */
function showProviderErrorToast(error: unknown, t: (key: string) => string, fallbackKey = "message_send_failed"): void {
  const message = error instanceof Error && error.message ? error.message : t(fallbackKey);
  const category = error instanceof ProviderStreamError ? error.category : "unknown";

  if (category === "authentication") {
    toast.error(message, {
      description: t("provider_error_auth_desc"),
      action: {
        label: t("open_provider_settings"),
        onClick: () => useModalStore.getState().setIsProviderModalOpen(true),
      },
    });
    return;
  }
  if (TRANSIENT_PROVIDER_CATEGORIES.has(category)) {
    toast.error(message, { description: t("provider_error_transient_desc") });
    return;
  }
  if (category === "empty_response" || category === "parse_error") {
    toast.error(message, { description: t("provider_error_empty_desc") });
    return;
  }
  toast.error(message);
}

/** Outcome of a single generation attempt, surfaced to the queue pump (Q3). */
export type StreamOutcome = "done" | "cancelled" | "failed";

export interface ChatControllerActions {
  handleSend: () => Promise<void>;
  handleCancelGeneration: () => void;
  handleSwitchChat: (chatId: ChatId) => Promise<void>;
  handleStartEdit: (message: AppMessage, contentOverride?: string) => void;
  handleCancelEdit: () => void;
  handleSaveMessageEdit: (messageId: string) => Promise<void>;
  handleDeleteMessage: (messageId: string) => Promise<void>;
  handleDeleteVariant: (messageId: string, variantIndex: number) => Promise<void>;
  handleRegenerateMessage: (messageId: string) => Promise<void>;
  handleSelectMessageVariant: (messageId: string, variantIndex: number) => Promise<void>;
  handleResend: () => Promise<void>;
  handleFork: (messageId?: string) => Promise<void>;
  handleActivateBranch: (branchId: ChatBranchId) => Promise<void>;
  handleDeleteActiveBranch: () => Promise<void>;
  handleRenameBranch: (branchId: ChatBranchId, label: string) => Promise<void>;
  /**
   * Run ONE regenerate generation for the queue (Q3). Mirrors
   * handleRegenerateMessage's stream/non-stream branching but threads an
   * optional per-request { model, promptPresetId } override and returns the
   * outcome so the queue pump can mark the job done/failed/cancelled. Does NOT
   * show its own toasts (the stream path's existing toasts still fire); the
   * queue manager owns job-row affordances. Throws nothing — failures surface
   * as the `"failed"` outcome.
   */
  runRegenerateJob: (
    chatId: ChatId,
    messageId: string,
    override?: { model?: string; promptPresetId?: string },
  ) => Promise<StreamOutcome>;
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
    pendingAttachments?: import("@vibe-tavern/domain").Attachment[],
    /**
     * Identity of an EXISTING message this stream targets (regenerate path).
     * Omit/null for fresh sends that stream into __pending-assistant. See
     * ChatGenerationState.streamingMessageId.
     */
    streamingMessageId?: string | null,
  ): Promise<StreamOutcome> {
    const controller = useChatStore.getState().startGeneration(chatId, pendingUserContent, pendingAttachments, streamingMessageId);
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
      return "done";
    } catch (error) {
      if (controller.signal.aborted) {
        void logClientSendDebug("web.hook.stream.cancelled", { chatId });
        await refreshAfterAbort(chatId);
        toast.info(getT()("generation_cancelled"));
        return "cancelled";
      }
      void logClientSendDebug("web.hook.stream.error", {
        chatId,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error && error.message === "VISION_NOT_SUPPORTED") {
        toast.error(getT()("vision_not_supported"), {
          description: getT()("vision_not_supported_desc"),
          action: {
            label: getT()("open_provider_settings"),
            onClick: () => useModalStore.getState().setIsProviderModalOpen(true),
          },
        });
        restoreDraftAfterSendError(pendingUserContent, pendingAttachments);
      } else {
        restoreDraftAfterSendError(pendingUserContent, pendingAttachments);
        showProviderErrorToast(error, getT());
      }
      useChatStore.getState().setGenerationStatus(chatId, "failed");
      return "failed";
    } finally {
      useChatStore.getState().finishGeneration(chatId);
      reveal.clear();
      streamingRevealRef.current = null;
    }
  }

  // --- Actions ---

  const handleSend = useCallback(async (): Promise<void> => {
    const activeChatId = getActiveChatId();
    const csStore = useChatStore.getState();
    const draft = csStore.draft;
    const trimmed = draft.trim();
    const attachments = csStore.draftAttachments.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type as "image" | "file" | "video",
      assetId: a.assetId,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    }));

    void logClientSendDebug("web.hook.handleSend.enter", {
      activeChatId,
      draftLength: draft.length,
      trimmedLength: trimmed.length,
      attachmentsCount: attachments.length,
      isSending: activeChatId ? getIsSending(activeChatId) : false,
      canSendViaActiveProfile: canSendRef.current,
    });

    if ((!trimmed && attachments.length === 0) || !activeChatId || getIsSending(activeChatId)) {
      void logClientSendDebug("web.hook.handleSend.blocked.basic", {
        activeChatId,
        trimmedLength: trimmed.length,
        attachmentsCount: attachments.length,
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
      const currentAttachments = [...csStore.draftAttachments];
      csStore.clearDraftAttachments();
      await executeStreamAction(
        activeChatId,
        (opts) => sendChatMessageStream(activeChatId, { content: trimmed, attachments: attachments.length > 0 ? attachments : undefined }, opts),
        draft,
        currentAttachments,
      );
    } else {
      void logClientSendDebug("web.hook.handleSend.request", { activeChatId });
      const currentAttachments = [...csStore.draftAttachments];
      csStore.clearDraftAttachments();
      const controller = csStore.startGeneration(activeChatId, draft, currentAttachments);
      csStore.setDraft("");
      try {
        await sendChatMessageAction(activeChatId, trimmed, attachments.length > 0 ? attachments : undefined, controller.signal);
        const snapshot = useSnapshotStore.getState();
        csStore.setSelectedTraceId(snapshot.promptTrace?.id ?? null);
        // Optimistically add the fresh trace to the branch-scoped cache so the
        // Trace tab (if open) shows it without a refetch (TL-B2).
        if (snapshot.promptTrace && snapshot.activeBranch?.id) {
          useTraceHistoryStore.getState().upsertLatest(activeChatId, snapshot.activeBranch.id, snapshot.promptTrace);
        }
        void logClientSendDebug("web.hook.handleSend.success", { activeChatId });
      } catch (error) {
        if (controller.signal.aborted) {
          void logClientSendDebug("web.hook.handleSend.cancelled", { activeChatId });
          await refreshAfterAbort(activeChatId);
          toast.info(getT()("generation_cancelled"));
          return;
        }
        logClientSendDebug("web.hook.handleSend.error", { chatId: activeChatId, error: String(error) });
        if (error instanceof Error && error.message === "VISION_NOT_SUPPORTED") {
          toast.error(getT()("vision_not_supported"), {
            description: getT()("vision_not_supported_desc"),
            action: {
              label: getT()("open_provider_settings"),
              onClick: () => useModalStore.getState().setIsProviderModalOpen(true),
            },
          });
          restoreDraftAfterSendError(draft, currentAttachments);
        } else {
          restoreDraftAfterSendError(draft, currentAttachments);
          showProviderErrorToast(error, getT());
        }
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
        useChatStore.getState().setSelectedTraceId(snapshot.promptTrace?.id ?? null);
        if (snapshot.promptTrace && snapshot.activeBranch?.id) {
          useTraceHistoryStore.getState().upsertLatest(activeChatId, snapshot.activeBranch.id, snapshot.promptTrace);
        }
        void logClientSendDebug("web.hook.handleResend.success", { activeChatId });
      } catch (error) {
        if (controller.signal.aborted) {
          void logClientSendDebug("web.hook.handleResend.cancelled", { activeChatId });
          await refreshAfterAbort(activeChatId);
          toast.info(getT()("generation_cancelled"));
          return;
        }
        await refreshChatSnapshotCache(activeChatId);
        showProviderErrorToast(error, getT(), "resend_failed");
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
    if (!activeChatId) return;

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

  async function handleDeleteVariant(messageId: string, variantIndex: number): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    const cs = useChatStore.getState();
    cs.setMessageActionId(messageId);
    try {
      await deleteVariantAction(activeChatId, messageId, variantIndex);
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
        undefined,
        undefined,
        messageId,
      );
    } else {
      const controller = useChatStore.getState().startGeneration(activeChatId, undefined, undefined, messageId);
      try {
        await regenerateMessageAction(activeChatId, messageId, controller.signal);
        const snapshot = useSnapshotStore.getState();
        useChatStore.getState().setSelectedTraceId(snapshot.promptTrace?.id ?? null);
        if (snapshot.promptTrace && snapshot.activeBranch?.id) {
          useTraceHistoryStore.getState().upsertLatest(activeChatId, snapshot.activeBranch.id, snapshot.promptTrace);
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

  async function handleRenameBranch(branchId: ChatBranchId, label: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;
    await renameBranchAction(activeChatId, branchId, label);
  }

  /**
   * Queue entry point (Q3): run ONE regenerate with an optional per-request
   * override, returning the outcome. Reuses the SAME streaming/reveal +
   * generation-state machinery as handleRegenerateMessage (no duplication) —
   * the override is captured in the streamFn closure for the stream path and
   * threaded as the json body for the non-stream path. Only the job lifecycle
   * (enqueue / pump / status) lives in use-generation-queue.ts.
   */
  const runRegenerateJob = useCallback(
    async (
      chatId: ChatId,
      messageId: string,
      override?: { model?: string; promptPresetId?: string },
    ): Promise<StreamOutcome> => {
      useChatStore.getState().setMessageActionId(messageId);
      try {
        if (streamResponseRef.current) {
          return await executeStreamAction(
            chatId,
            (opts) => regenerateChatMessageStream(chatId, messageId, opts, override),
            undefined,
            undefined,
            messageId,
          );
        }
        // Non-stream path: mirror handleRegenerateMessage's branch, threading override.
        const controller = useChatStore.getState().startGeneration(chatId, undefined, undefined, messageId);
        try {
          await regenerateMessageAction(chatId, messageId, controller.signal, override);
          const snapshot = useSnapshotStore.getState();
          useChatStore.getState().setSelectedTraceId(snapshot.promptTrace?.id ?? null);
          if (snapshot.promptTrace && snapshot.activeBranch?.id) {
            useTraceHistoryStore.getState().upsertLatest(chatId, snapshot.activeBranch.id, snapshot.promptTrace);
          }
          return "done";
        } catch (error) {
          if (controller.signal.aborted) {
            await refreshAfterAbort(chatId);
            return "cancelled";
          }
          await refreshChatSnapshotCache(chatId);
          return "failed";
        } finally {
          useChatStore.getState().finishGeneration(chatId);
        }
      } finally {
        useChatStore.getState().setMessageActionId(null);
      }
    },
    [],
  );

  return {
    handleSend,
    handleCancelGeneration,
    handleSwitchChat,
    handleStartEdit,
    handleCancelEdit,
    handleSaveMessageEdit,
    handleDeleteMessage,
    handleDeleteVariant,
    handleRegenerateMessage,
    handleSelectMessageVariant,
    handleResend,
    handleFork,
    handleActivateBranch,
    handleDeleteActiveBranch,
    handleRenameBranch,
    runRegenerateJob,
  };
}
