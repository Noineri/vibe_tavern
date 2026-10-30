import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import type { Attachment, ChatBranchId, ChatId, ExperienceMessageReport } from "@vibe-tavern/domain";
import { getT, type TFunc } from "../i18n/locale-helpers.js";
import type Resources from "../i18n/resources.js";
import { fetchChat, generateReplyStream, continueChatMessageStream, regenerateChatMessageStream, sendChatMessageStream, subscribeChatGeneration, stopChatGeneration, type StreamOpts } from "../api/chat-api.js";
import type { AppMessage, ChatGenerationStatus } from "../api/types.js";
import { useChatStore } from "../stores/chat-store.js";
import { useModalStore } from "../stores/modal-store.js";
import { useProviderStore } from "../stores/provider-store.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import { StreamingReveal } from "../lib/streaming-reveal.js";
import { getProviderErrorText, showProviderErrorToast } from "../lib/provider-error-toast.js";
import { restoreDraftAfterSendError, settleFailedSendDraft } from "../lib/failed-send-draft.js";
import { toSendAttachment } from "../lib/send-attachments.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { forkBranchFlow } from "./branch-fork.js";
import {
  refreshAfterAbort,
  refreshChatSnapshotCache,
  resetGenerationBatch,
  settleRunningQueueRecordFailure,
  settlePlainRegenerateRecord,
  startPlainRegenerateRecord,
  updatePlainRegenerateRecordMetadata,
} from "./generation-batch-lifecycle.js";
import { useCoauthorBindingState } from "./use-coauthor-provider-binding.js";
import { notifyUserTurnSettled } from "../lib/star-prompt-trigger.js";
import { useTraceHistoryStore } from "../stores/trace-history-store.js";
import { useCoauthorTurnStore } from "../stores/coauthor-turn-store.js";
import type { RegenerateOverride } from "@vibe-tavern/api-contracts";
import { chatStreamToolCallbacks } from "./chat-stream-tool-callbacks.js";
import {
  sendChatMessageAction,
  regenerateMessageAction,
  continueMessageAction,
  generateReplyAction,
  editMessageAction,
  deleteMessageAction,
  deleteVariantAction,
  switchChatAction,
  selectVariantAction,
  activateBranchAction,
  deleteBranchAction,
  renameBranchAction,
} from "../stores/api-actions/chat-actions.js";
import { useDiceStore } from "../stores/dice-store.js";
import { usePerSendPrefillStore } from "../stores/per-send-prefill-store.js";
import { useExperienceStore } from "../stores/experience-store.js";
import type { DiceSendCommitIntent } from "../api/types.js";
import { readExperienceSendState } from "./experience-send-state.js";
import { findCurrentInsightsCompletionTarget, startInsightsCompletionRefreshFromSnapshot } from "../stores/api-actions/insights-completion-actions.js";
import { ProviderStreamError } from "../api/provider-stream-error.js";
import { diceConflictCode, experienceConflictCode, gateErrorCode } from "./chat-controller-error-codes.js";
export { diceSendBlockReason, type DiceSendBlock } from "./dice-send-gate.js";
import { diceSendBlockReason, type DiceSendBlock } from "./dice-send-gate.js";
import { captureQuickSwitchGenerationMetadata, type GenerationMetadata } from "../lib/generation-metadata.js";
import { getActiveChatId, getDraft, getEditingDraft, getEditingMessageId, getIsSending } from "./chat-controller-store-reads.js";

// ─── Dice send gate (DICE-F3) ───────────────────────────────────────────
// Subtractive-only: when Dice is disabled, the lane is absent/empty, or there
// is nothing bindable, every helper below collapses to "no Dice" so a no-Dice
// send stays byte-identical to before. Dice can only ever BLOCK a send, never
// make an otherwise-unsendable draft sendable.

/** Imperative read (at send time) of the dice commit intent + any block, for the
 *  CURRENT `{chatId, branchId}` and the chat's configured `diceMode`. The intent
 *  is captured ONLY when the active lane has a bindable (included) roll —
 *  otherwise it is undefined and the send body is byte-identical to a no-Dice
 *  send. */
function readDiceSendState(): { commitIntent: DiceSendCommitIntent | undefined; blockReason: DiceSendBlock | null } {
  const snapshot = useSnapshotStore.getState();
  const chatId = snapshot.activeChat?.id ?? null;
  const branchId = snapshot.activeBranch?.id ?? null;
  const insights = snapshot.activeChat?.insightsConfig;
  if (!insights?.diceEnabled || !chatId || !branchId) return { commitIntent: undefined, blockReason: null };
  const diceMode = insights.diceMode;
  const lane = useDiceStore.getState().byScope[`${chatId}|${branchId}`]?.lanes?.[diceMode] ?? null;
  const blockReason = diceSendBlockReason(lane, snapshot.persona?.id ?? null, snapshot.activeChat?.characterId ?? null);
  if (blockReason) return { commitIntent: undefined, blockReason };
  const hasBindable = lane !== null && lane.rolls.some((roll) => roll.included);
  const commitIntent = lane && hasBindable ? { diceMode, pendingRevision: lane.revision } : undefined;
  return { commitIntent, blockReason: null };
}

/** A send that failed with a dice commit conflict (stale lane revision /
 *  unresolved choose) is NOT a provider error — the lane moved under us. Resync
 *  the pending lane and KEEP the draft so the user can re-review and resend.
 *  Returns true when the error was a dice conflict (caller must skip the generic
 *  provider-error path). */
function tryHandleDiceSendConflict(
  error: unknown,
  chatId: ChatId,
  pendingUserContent: string | null | undefined,
  pendingAttachments: Attachment[] | undefined,
): boolean {
  if (diceConflictCode(error) === undefined) return false;
  restoreDraftAfterSendError(pendingUserContent, pendingAttachments);
  const branchId = useSnapshotStore.getState().activeBranch?.id ?? null;
  if (branchId) void useDiceStore.getState().refreshPending(chatId, branchId);
  return true;
}

/** A send that failed with an experience bind conflict (not_found /
 *  already_bound / stale_queue / stale_session — IR-70H) is NOT a provider
 *  error — the attachment moved under us. Restore the draft so the user can
 *  re-review and resend. The authoritative attachment refresh is handled by
 *  the post-settlement refresh in handleSend (requirement 3), not here. Returns
 *  true when the error was an experience conflict (caller must skip the generic
 *  provider-error path). */
function tryHandleExperienceSendConflict(
  error: unknown,
  pendingUserContent: string | null | undefined,
  pendingAttachments: Attachment[] | undefined,
): boolean {
  if (experienceConflictCode(error) === undefined) return false;
  restoreDraftAfterSendError(pendingUserContent, pendingAttachments);
  return true;
}

/** Outcome of a single generation attempt, surfaced to the queue pump (Q3). */
export type StreamOutcome = "done" | "cancelled" | "failed";

export interface ChatControllerActions {
  reattachGeneration: (chatId: ChatId, signal: AbortSignal) => Promise<StreamOutcome>;
  handleSend: () => Promise<void>;
  handleCancelGeneration: () => void;
  handleSwitchChat: (chatId: ChatId) => Promise<void>;
  handleStartEdit: (message: AppMessage, contentOverride?: string) => void;
  handleCancelEdit: () => void;
  handleSaveMessageEdit: (messageId: string) => Promise<void>;
  handleDeleteMessage: (messageId: string) => Promise<void>;
  handleDeleteVariant: (messageId: string, variantIndex: number) => Promise<void>;
  handleRegenerateMessage: (messageId: string) => Promise<void>;
  /** LS-4a: continue the LAST assistant reply from its selected variant's
   *  text; the continuation appends as a new variant of that message. */
  handleContinueMessage: (messageId: string) => Promise<void>;
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
    override?: RegenerateOverride,
  ) => Promise<StreamOutcome>;
}

export function useChatController(): ChatControllerActions {
  // --- Provider capabilities (derived internally) ---
  const providerProfiles = useProviderDataStore((s) => s.profiles);
  const activeProfile = useMemo(
    () => providerProfiles.find((p) => p.isActive) ?? null,
    [providerProfiles],
  );

  // Co-Author binding — the send gate when the active chat is in coauthor
  // mode. Resolution (and its CG-2 connection-row model fallback) lives in
  // useCoauthorBindingState — the single derivation shared with the input UI.
  const chatMode = useSnapshotStore((s) => s.activeChat?.mode);
  const coauthorBinding = useCoauthorBindingState();

  const canSendViaActiveProfile = chatMode === "coauthor"
    ? coauthorBinding.isReady
    : activeProfile !== null && Boolean(activeProfile.defaultModel);
  const streamResponse = useProviderStore((s) => s.connection.streamResponse);

  // Refs for stable access in async callbacks
  const canSendRef = useRef(canSendViaActiveProfile);
  canSendRef.current = canSendViaActiveProfile;
  const streamResponseRef = useRef(streamResponse);
  streamResponseRef.current = streamResponse;

  // --- Snapshot cache helpers ---

  // --- Common streaming helper ---

  /**
   * Execute a streaming action (send, regenerate, generateReply) with
   * per-chat generation state management.
   */
  async function executeStreamAction(
    chatId: ChatId,
    streamFn: (opts: StreamOpts & { signal: AbortSignal }) => Promise<{ finishReason: string; usage?: Record<string, number>; metrics?: unknown; lorebookOverflows?: Array<{ name: string; dropped: number }> }>,
    pendingUserContent?: string | null,
    pendingAttachments?: import("@vibe-tavern/domain").Attachment[],
    /**
     * Identity of an EXISTING message this stream targets (regenerate path).
     * Omit/null for fresh sends that stream into __pending-assistant. See
     * ChatGenerationState.streamingMessageId.
     */
    streamingMessageId?: string | null,
    onFailure?: (error: unknown) => void,
    onGenerationMetadata?: (metadata: GenerationMetadata) => void,
    pendingExperienceReport?: ExperienceMessageReport | null,
    attachment?: { signal: AbortSignal },
  ): Promise<StreamOutcome> {
    if (getIsSending(chatId)) return "failed";
    const completionTargetBeforeStream = streamingMessageId
      ? null
      : findCurrentInsightsCompletionTarget(chatId);
    const controller = useChatStore.getState().startGeneration(chatId, pendingUserContent, pendingAttachments, streamingMessageId, pendingExperienceReport);
    const store = useChatStore.getState();
    if (!attachment) store.setDraft("");
    let replaying = Boolean(attachment);
    const owns = () => useChatStore.getState().generations[chatId]?.abortController === controller;
    let contextSeen = false, stopRequested = false, stopping = false;
    const requestStop = () => {
      stopRequested = true;
      if (!contextSeen || stopping || !owns()) return;
      stopping = true;
      void stopChatGeneration(chatId).catch((error: unknown) => {
        stopping = false;
        if (owns()) showProviderErrorToast(error, getT());
      });
    };
    store.setGenerationStop(chatId, requestStop);

    // Start the co-author turn fresh: drop the previous turn's tool activities.
    // No-op for RP chats (they never emit tool events, so the store stays empty).
    useCoauthorTurnStore.getState().clearTurn(chatId);

    // Create a new StreamingReveal for this generation
    const reveal = new StreamingReveal(chatId);
    const detach = () => {
      if (owns()) { reveal.clear(); useChatStore.getState().finishGeneration(chatId); }
      controller.abort();
    };
    attachment?.signal.addEventListener("abort", detach, { once: true });
    // Replay snapshot reads must not outlive this subscriber, even if the
    // same chat is reopened before a slow HTTP response comes back.
    const refresh = async () => {
      if (!replaying) return refreshChatSnapshotCache(chatId);
      const snapshot = await fetchChat(chatId);
      if (owns() && !controller.signal.aborted && getActiveChatId() === chatId) useSnapshotStore.getState().ingestSnapshot(snapshot);
      return snapshot;
    };
    let userRefresh: Promise<unknown> = Promise.resolve();

    try {
      if (attachment?.signal.aborted) { detach(); return "cancelled"; }
      const callbacks: StreamOpts & { signal: AbortSignal } = {
        signal: controller.signal,
        waitForStreamEnd: true,
        onStatus: (status) => { if (owns()) useChatStore.getState().setGenerationStatus(chatId, status); },
        onChunk: (delta) => {
          if (owns()) reveal.pushDelta(delta);
        },
        onReasoningChunk: (delta) => {
          if (owns()) useChatStore.getState().appendReasoningText(chatId, delta);
        },
        onReasoningDone: () => {
          // Reasoning complete — text stays until snapshot refresh
        },
        onGenerationMetadata: (metadata) => {
          if (!owns()) return;
          useChatStore.getState().setGenerationMetadata(chatId, metadata);
          onGenerationMetadata?.(metadata);
        },
        onGenerationContext: (context) => {
          if (!owns()) return;
          if (context.chatId !== chatId) throw new Error("Chat generation context mismatch");
          streamingMessageId = context.messageId;
          useChatStore.getState().setGenerationContext(chatId, context);
          contextSeen = true;
          if (stopRequested) requestStop();
        },
        onUserMessageSaved: () => {
          if (replaying && owns()) userRefresh = userRefresh.then(refresh).catch((error: unknown) => console.warn("[chat-run] user refresh failed", error));
        },
        ...chatStreamToolCallbacks(chatId, owns),
      };
      let streamResult: Awaited<ReturnType<typeof streamFn>>;
      try { streamResult = await streamFn(callbacks); }
      catch (error) {
        if (!(error instanceof ProviderStreamError) || error.code !== "AGENT_RUN_ACTIVE") throw error;
        if (getActiveChatId() === chatId) restoreDraftAfterSendError(pendingUserContent, pendingAttachments);
        replaying = true;
        pendingUserContent = null; pendingAttachments = undefined;
        useChatStore.getState().setPendingContent(chatId, null);
        await refresh();
        streamResult = await subscribeChatGeneration(chatId, 0, callbacks);
      }

      await userRefresh;
      if (!owns() || controller.signal.aborted) return "cancelled";
      if (streamResult?.finishReason === "cancelled") {
        const snapshot = await refresh();
        if (!streamingMessageId) startInsightsCompletionRefreshFromSnapshot(chatId, snapshot, completionTargetBeforeStream);
        toast.info(getT()("generation_cancelled"));
        return "cancelled";
      }
      await reveal.waitForReveal();
      if (!owns()) return "cancelled";
      useChatStore.getState().setPendingContent(chatId, null);
      const snapshot = await refresh();
      // Fresh send/generate paths emit message.appended and start insight work;
      // regenerate targets an existing message and intentionally does not.
      if (!streamingMessageId) startInsightsCompletionRefreshFromSnapshot(chatId, snapshot);
      // P21 (overflowAlert): alert-on books that overflowed this turn ride the
      // finish SSE event (server filters on the per-book overflowAlert flag —
      // the flag lives in the DB, this page has no lorebook list). One warning
      // per book, once per turn. Named deviation: ST toasts dry runs too; VT
      // carries the notice on live generations only.
      for (const overflow of streamResult?.lorebookOverflows ?? []) {
        toast.warning(getT()("lore_overflow_toast", { name: overflow.name, n: overflow.dropped }));
      }
      return "done";
    } catch (error) {
      if (controller.signal.aborted) {
        if (attachment) return "cancelled";
        const snapshot = await refreshAfterAbort(chatId);
        // The backend persists and emits message.appended for a partial fresh
        // assistant response. Refresh only when abort produced a new target;
        // cancellation before any assistant text remains a true no-op.
        if (!streamingMessageId) {
          startInsightsCompletionRefreshFromSnapshot(chatId, snapshot, completionTargetBeforeStream);
        }
        toast.info(getT()("generation_cancelled"));
        return "cancelled";
      }
      onFailure?.(error);
      const settleDraft = () => replaying ? refresh() : settleFailedSendDraft(error, chatId, refreshChatSnapshotCache, pendingUserContent, pendingAttachments);
      // DICE-F3: a dice commit conflict (stale revision / unresolved choose)
      // resyncs the lane and keeps the draft — not a provider error.
      if (tryHandleDiceSendConflict(error, chatId, pendingUserContent, pendingAttachments)) {
        useChatStore.getState().setGenerationStatus(chatId, "failed");
        return "failed";
      }
      // IR-73D: an experience bind conflict (not_found / already_bound /
      // stale_queue / stale_session) restores the draft — not a provider
      // error. The authoritative attachment refresh is handled by the
      // post-settlement refresh in handleSend.
      if (tryHandleExperienceSendConflict(error, pendingUserContent, pendingAttachments)) {
        useChatStore.getState().setGenerationStatus(chatId, "failed");
        return "failed";
      }
      if (gateErrorCode(error) === "vision_not_supported") {
        toast.error(getT()("vision_not_supported"), {
          description: getT()("vision_not_supported_desc"),
          action: {
            label: getT()("open_provider_settings"),
            onClick: () => useModalStore.getState().setIsProviderModalOpen(true),
          },
        });
        await settleDraft();
      } else if (gateErrorCode(error) === "voice_transcribe_unavailable") {
        toast.error(getT()("voice_transcribe_unavailable"), {
          description: getT()("voice_transcribe_unavailable_desc"),
          action: {
            label: getT()("open_provider_settings"),
            onClick: () => useModalStore.getState().setIsProviderModalOpen(true),
          },
        });
        await settleDraft();
      } else {
        await settleDraft();
        showProviderErrorToast(error, getT());
      }
      useChatStore.getState().setGenerationStatus(chatId, "failed");
      return "failed";
    } finally {
      attachment?.signal.removeEventListener("abort", detach);
      if (owns()) { reveal.clear(); useChatStore.getState().finishGeneration(chatId); }
    }
  }

  // --- Non-streaming helper ---

  /**
   * Execute a non-streaming action (send / regenerate / generateReply) with the
   * SAME lifecycle contract as {@link executeStreamAction}: it owns
   * startGeneration/finishGeneration, treats a signal abort as a settled
   * "cancelled" outcome (refreshAfterAbort + toast), and NEVER throws — so
   * callers can bracket message-level flags (messageActionId) with plain
   * set/clear around the await without an early `return` leaking the clear.
   *
   * Why this exists: the non-stream path used to hand-roll startGeneration →
   * try/catch(signal.aborted)/finally/finishGeneration in four call sites,
   * each with slightly different cleanup. One of those clones (the abort
   * branch of handleRegenerateMessage) early-returned before its
   * `setMessageActionId(null)` and left the regenerated message permanently
   * busy (`MessageBlock.isBusy`/`isBranching` key off messageActionId).
   * Centralizing the lifecycle here makes that class of leak unreachable.
   *
   * Post-success trace hydration (selectedTraceId + branch-scoped cache
   * upsert) is folded in because all four call sites do it identically.
   * Non-abort error recovery is caller-owned via {@link opts.onError} (toast,
   * draft restore, snapshot refresh) — the helper does not second-guess it and
   * resolves as "failed". generationStatus is intentionally NOT touched:
   * nothing reads it for non-stream paths today (only executeStreamAction
   * sets "failed" there, and only for debug consumption).
   */
  async function executeNonStreamAction(
    chatId: ChatId,
    fn: (signal: AbortSignal) => Promise<unknown>,
    opts: {
      pendingUserContent?: string | null;
      pendingAttachments?: Attachment[];
      pendingExperienceReport?: ExperienceMessageReport | null;
      streamingMessageId?: string | null;
      /** Suppress the default "generation cancelled" toast — the queue path
       *  (runRegenerateJob) owns its own job-row affordances and stays silent. */
      suppressCancelToast?: boolean;
      /** Caller-specific non-abort error recovery (toast / draft restore /
       *  snapshot refresh). Abort is handled uniformly by the helper. */
      onError?: (error: unknown) => void | Promise<void>;
    } = {},
  ): Promise<StreamOutcome> {
    const controller = useChatStore.getState().startGeneration(
      chatId,
      opts.pendingUserContent ?? null,
      opts.pendingAttachments,
      opts.streamingMessageId ?? null,
      opts.pendingExperienceReport,
    );
    useChatStore.getState().setGenerationMetadata(chatId, captureQuickSwitchGenerationMetadata(chatId));
    try {
      await fn(controller.signal);
      const snapshot = useSnapshotStore.getState();
      if (snapshot.activeChat?.id === chatId) useChatStore.getState().setSelectedTraceId(snapshot.promptTrace?.id ?? null);
      if (snapshot.activeChat?.id === chatId && snapshot.promptTrace && snapshot.activeBranch?.id) {
        useTraceHistoryStore.getState().upsertLatest(chatId, snapshot.activeBranch.id, snapshot.promptTrace);
      }
      return "done";
    } catch (error) {
      if (controller.signal.aborted) {
        await refreshAfterAbort(chatId);
        if (!opts.suppressCancelToast) toast.info(getT()("generation_cancelled"));
        return "cancelled";
      }
      await opts.onError?.(error);
      return "failed";
    } finally {
      useChatStore.getState().finishGeneration(chatId);
    }
  }

  // --- Actions ---

  const reattachGeneration = useCallback((chatId: ChatId, signal: AbortSignal) => executeStreamAction(
    chatId, (opts) => subscribeChatGeneration(chatId, 0, opts), null, undefined, null, undefined, undefined, null, { signal },
  ), []);

  const handleSend = useCallback(async (): Promise<void> => {
    const activeChatId = getActiveChatId();
    const csStore = useChatStore.getState();
    const draft = csStore.draft;
    const trimmed = draft.trim();
    const attachments = csStore.draftAttachments.map(toSendAttachment);

    if ((!trimmed && attachments.length === 0) || !activeChatId || getIsSending(activeChatId)) {
      return;
    }

    if (!canSendRef.current) {
      toast.error(getT()("message_unavailable_no_provider"));
      return;
    }

    // DICE-F3: capture the commit intent (only when the active lane has a
    // bindable roll) and enforce the subtractive send gate. The button/Enter
    // path already gates on `canSend` (use-input-area); this is the
    // defense-in-depth backstop for any direct handleSend call.
    const dice = readDiceSendState();
    if (dice.blockReason) {
      return;
    }

    resetGenerationBatch(activeChatId);

    // IR-73D: capture the experience attachment commit intent (only when the
    // active scope has a valid server-queued attachment). Subtractive: when
    // absent or scope-mismatched, no experience fields are added and no
    // experience refresh is issued. The scope is retained for the post-
    // settlement authoritative attachment refresh (requirement 3). The send
    // target (activeChatId) is passed so a transient snapshot mismatch fails
    // closed instead of capturing the wrong chat's intent.
    const exp = readExperienceSendState(activeChatId);

    // LS-4b: one-shot per-send prefill — consumed HERE (read + clear) so the
    // override applies to exactly the next send and the preset value stays
    // the persistent default. Guards above already returned, so a blocked
    // send never burns the override.
    const perSendPrefill = usePerSendPrefillStore.getState().consume() ?? undefined;

    if (streamResponseRef.current) {
      const currentAttachments = [...csStore.draftAttachments];
      csStore.clearDraftAttachments();
      const outcome = await executeStreamAction(
        activeChatId,
        (opts) => sendChatMessageStream(activeChatId, { content: trimmed, attachments: attachments.length > 0 ? attachments : undefined, ...dice.commitIntent, ...exp.commitIntent, ...(perSendPrefill !== undefined ? { prefill: perSendPrefill } : {}) }, opts),
        draft,
        currentAttachments,
        null,
        undefined,
        undefined,
        exp.pendingReport,
      );
      notifyUserTurnSettled(outcome === "done");
    } else {
      const currentAttachments = [...csStore.draftAttachments];
      csStore.clearDraftAttachments();
      csStore.setDraft("");
      // Draft restore is caller-specific (and only on non-abort errors — an
      // abort is an explicit user cancel, the message is already gone from
      // the draft by design). executeNonStreamAction owns the lifecycle and
      // treats abort as a settled "cancelled" outcome without invoking onError.
      const outcome = await executeNonStreamAction(
        activeChatId,
        (signal) => sendChatMessageAction(activeChatId, trimmed, attachments.length > 0 ? attachments : undefined, dice.commitIntent, signal, exp.commitIntent, perSendPrefill),
        {
          pendingUserContent: draft,
          pendingAttachments: currentAttachments,
          pendingExperienceReport: exp.pendingReport,
          onError: async (error) => {
            const settleDraft = () => settleFailedSendDraft(error, activeChatId, refreshChatSnapshotCache, draft, currentAttachments);
            // DICE-F3: a dice commit conflict resyncs the lane and keeps the
            // draft — it is not a provider failure.
            if (tryHandleDiceSendConflict(error, activeChatId, draft, currentAttachments)) return;
            // IR-73D: an experience bind conflict restores the draft — not a
            // provider failure. The authoritative attachment refresh is
            // handled by the post-settlement refresh below.
            if (tryHandleExperienceSendConflict(error, draft, currentAttachments)) return;
            if (gateErrorCode(error) === "vision_not_supported") {
              toast.error(getT()("vision_not_supported"), {
                description: getT()("vision_not_supported_desc"),
                action: {
                  label: getT()("open_provider_settings"),
                  onClick: () => useModalStore.getState().setIsProviderModalOpen(true),
                },
              });
              await settleDraft();
            } else if (gateErrorCode(error) === "voice_transcribe_unavailable") {
              toast.error(getT()("voice_transcribe_unavailable"), {
                description: getT()("voice_transcribe_unavailable_desc"),
                action: {
                  label: getT()("open_provider_settings"),
                  onClick: () => useModalStore.getState().setIsProviderModalOpen(true),
                },
              });
              await settleDraft();
            } else {
              await settleDraft();
              showProviderErrorToast(error, getT());
            }
          },
        },
      );
      notifyUserTurnSettled(outcome === "done");
    }

    // IR-73D settlement/rollback parity: if an experience intent was captured,
    // refresh that exact scope's queued attachment after EVERY send settlement
    // (success, typed conflict, generic error, and abort). This lets server
    // truth clear a bound attachment or restore/replace an unbound/compensated
    // one. A no-experience send issues no experience refresh. The refresh is
    // AWAITED (not fire-and-forget) so handleSend does not resolve until the
    // authoritative attachment state is settled — otherwise a rapid second send
    // could capture the already-bound stale intent before the refresh completes.
    // The store action records its own errors, so a failure here does not throw.
    if (exp.commitIntent && exp.scope) {
      await useExperienceStore.getState().refreshAttachment(exp.scope.chatId, exp.scope.branchId);
    }
  }, []);

  const handleResend = useCallback(async (): Promise<void> => {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    if (!canSendRef.current) {
      toast.error(getT()("resend_unavailable_no_provider"));
      return;
    }

    resetGenerationBatch(activeChatId);

    if (streamResponseRef.current) {
      await executeStreamAction(
        activeChatId,
        (opts) => generateReplyStream(activeChatId, opts),
      );
    } else {
      await executeNonStreamAction(
        activeChatId,
        (signal) => generateReplyAction(activeChatId, signal),
        {
          onError: async (error) => {
            await refreshChatSnapshotCache(activeChatId);
            showProviderErrorToast(error, getT(), "resend_failed");
          },
        },
      );
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

    // Bracket messageActionId with try/finally so EVERY settle path clears it:
    // success, abort, provider error, or a throw out of refreshAfterAbort. The
    // prior non-stream branch early-returned on abort and skipped this clear,
    // leaving the message permanently busy (MessageBlock.isBusy/isBranching).
    useChatStore.getState().setMessageActionId(messageId);
    const plainRecordId = startPlainRegenerateRecord(
      activeChatId,
      messageId,
      (() => {
        const metadata = captureQuickSwitchGenerationMetadata(activeChatId);
        return { model: metadata.modelId, presetName: metadata.presetName };
      })(),
    );
    try {
      let outcome: StreamOutcome;
      let failureText = getT()("regen_failed");
      if (streamResponseRef.current) {
        outcome = await executeStreamAction(
          activeChatId,
          (opts) => regenerateChatMessageStream(activeChatId, messageId, opts),
          undefined,
          undefined,
          messageId,
          (error) => { failureText = getProviderErrorText(error, getT(), "regen_failed"); },
          (metadata) => updatePlainRegenerateRecordMetadata(activeChatId, plainRecordId, {
            model: metadata.modelId,
            presetName: metadata.presetName,
          }),
        );
      } else {
        outcome = await executeNonStreamAction(
          activeChatId,
          (signal) => regenerateMessageAction(activeChatId, messageId, signal),
          {
            streamingMessageId: messageId,
            onError: async (error) => {
              await refreshChatSnapshotCache(activeChatId);
              failureText = getProviderErrorText(error, getT(), "regen_failed");
              toast.error(failureText);
            },
          },
        );
      }
      settlePlainRegenerateRecord(activeChatId, plainRecordId, outcome, failureText);
    } finally {
      useChatStore.getState().setMessageActionId(null);
    }
  }

  /** LS-4a: continue the LAST assistant reply from its selected variant's
   *  text. Mirrors handleRegenerateMessage's lifecycle exactly (messageActionId
   *  bracket + stream/non-stream branch), but the backend endpoint differs:
   *  the continuation prompt ends with the variant's content as the assistant
   *  continuation point, and the result APPENDS as a new variant of the same
   *  message instead of replacing the generation. */
  async function handleContinueMessage(messageId: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    if (!canSendRef.current) {
      toast.error(getT()("continue_unavailable_no_provider"));
      return;
    }

    useChatStore.getState().setMessageActionId(messageId);
    try {
      if (streamResponseRef.current) {
        await executeStreamAction(
          activeChatId,
          (opts) => continueChatMessageStream(activeChatId, messageId, opts),
          undefined,
          undefined,
          messageId,
        );
      } else {
        await executeNonStreamAction(
          activeChatId,
          (signal) => continueMessageAction(activeChatId, messageId, signal),
          {
            streamingMessageId: messageId,
            onError: async (error) => {
              await refreshChatSnapshotCache(activeChatId);
              toast.error(error instanceof Error ? error.message : getT()("continue_failed"));
            },
          },
        );
      }
    } finally {
      useChatStore.getState().setMessageActionId(null);
    }
  }

  async function handleSelectMessageVariant(messageId: string, variantIndex: number): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId || variantIndex < 0) return;
    void selectVariantAction(activeChatId, messageId, variantIndex);
  }

  /**
   * Fork the active branch — delegates to `forkBranchFlow`, where the SC-21
   * sidechat confirm gate and the feedback timer live (file-size ratchet:
   * this file may only shrink by extraction). All three fork call sites go
   * through here, so no per-caller wiring.
   */
  async function handleFork(messageId?: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;
    await forkBranchFlow(activeChatId, messageId);
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
      override?: RegenerateOverride,
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
            (error) => settleRunningQueueRecordFailure(chatId, messageId, getProviderErrorText(error, getT(), "regen_failed")),
          );
        }
        // Non-stream path: same lifecycle contract via executeNonStreamAction.
        // suppressCancelToast — the queue manager owns job-row affordances and
        // stays silent on cancel/error (mirrors the prior behavior).
        return await executeNonStreamAction(
          chatId,
          (signal) => regenerateMessageAction(chatId, messageId, signal, override),
          {
            streamingMessageId: messageId,
            suppressCancelToast: true,
            onError: async (error) => {
              settleRunningQueueRecordFailure(chatId, messageId, getProviderErrorText(error, getT(), "regen_failed"));
              await refreshChatSnapshotCache(chatId);
            },
          },
        );
      } finally {
        useChatStore.getState().setMessageActionId(null);
      }
    },
    [],
  );

  return {
    reattachGeneration,
    handleSend,
    handleCancelGeneration,
    handleSwitchChat,
    handleStartEdit,
    handleCancelEdit,
    handleSaveMessageEdit,
    handleDeleteMessage,
    handleDeleteVariant,
    handleRegenerateMessage,
    handleContinueMessage,
    handleSelectMessageVariant,
    handleResend,
    handleFork,
    handleActivateBranch,
    handleDeleteActiveBranch,
    handleRenameBranch,
    runRegenerateJob,
  };
}
