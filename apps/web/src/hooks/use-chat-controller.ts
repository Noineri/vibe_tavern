import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import type { Attachment, ChatBranchId, ChatId } from "@vibe-tavern/domain";
import { getT, type TFunc } from "../i18n/locale-helpers.js";
import type Resources from "../i18n/resources.js";
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
import { useModalStore } from "../stores/modal-store.js";
import { useProviderStore } from "../stores/provider-store.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import { StreamingReveal } from "../lib/streaming-reveal.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { useBootstrapStore } from "../stores/api-actions/bootstrap-actions.js";
import { resolveCoauthorBinding } from "../lib/coauthor-provider-binding.js";
import { useTraceHistoryStore } from "../stores/trace-history-store.js";
import { useCoauthorTurnStore } from "../stores/coauthor-turn-store.js";
import { coauthorToolOutputSchema, coauthorSkillReadOutputSchema, coauthorLoreBundleOutputSchema } from "@vibe-tavern/api-contracts";
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
import { useDiceStore } from "../stores/dice-store.js";
import { useExperienceStore } from "../stores/experience-store.js";
import { DiceApiError } from "../api/dice-api.js";
import type { DiceLaneState, DiceSendCommitIntent, ExperienceSendCommitIntent } from "../api/types.js";
import { findCurrentInsightsCompletionTarget, startInsightsCompletionRefreshFromSnapshot } from "../stores/api-actions/insights-completion-actions.js";
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

// ─── Dice send gate (DICE-F3) ───────────────────────────────────────────
// Subtractive-only: when Dice is disabled, the lane is absent/empty, or there
// is nothing bindable, every helper below collapses to "no Dice" so a no-Dice
// send stays byte-identical to before. Dice can only ever BLOCK a send, never
// make an otherwise-unsendable draft sendable.

/** Why a send is Dice-blocked. */
export type DiceSendBlock = "choose" | "actor_mismatch";

const DICE_CONFLICT_CODES = new Set(["stale_revision", "unresolved_choose"]);

// IR-70H Experience bind conflict codes carried on DiceApiError (non-stream
// HTTP 409 via sendChatMessageError) or ProviderStreamError (SSE error event).
// These are server-side commit conflicts, not provider failures — the
// attachment moved under us. Disjoint from DICE_CONFLICT_CODES.
const EXPERIENCE_CONFLICT_CODES = new Set(["not_found", "already_bound", "stale_queue", "stale_session"]);

/** Extract the dice commit-conflict code from either send-mode error: non-stream
 *  throws {@link DiceApiError} (HTTP 409 body `error.details.code`), stream
 *  throws {@link ProviderStreamError} (SSE error event `code`). */
function diceConflictCode(error: unknown): string | undefined {
  const code = error instanceof DiceApiError || error instanceof ProviderStreamError ? error.code : undefined;
  return code !== undefined && DICE_CONFLICT_CODES.has(code) ? code : undefined;
}

/** Extract the experience bind-conflict code from either send-mode error
 *  (IR-70H). Same transport as {@link diceConflictCode} but checks the four
 *  Experience bind codes — disjoint from the Dice codes. */
function experienceConflictCode(error: unknown): string | undefined {
  const code = error instanceof DiceApiError || error instanceof ProviderStreamError ? error.code : undefined;
  return code !== undefined && EXPERIENCE_CONFLICT_CODES.has(code) ? code : undefined;
}

/** Pure send-gate: the reason the active pending lane blocks a send, or null.
 *  Mirrors the backend bind gate (`bindActiveAndResetInTx`), which rejects an
 *  unresolved `choose` only among INCLUDED unbound rolls (the store already
 *  drops bound rolls) — so excluded rolls neither block nor bind. The actor
 *  check is frontend-only (the backend does not validate actor): a pending roll
 *  captured for an actor that no longer matches the current persona/character
 *  must not bind silently. Exported for the reactive `canSend` in
 *  use-input-area. */
export function diceSendBlockReason(
  lane: DiceLaneState | null | undefined,
  personaId: string | null,
  characterId: string | null,
): DiceSendBlock | null {
  if (!lane) return null;
  const bindable = lane.rolls.filter((roll) => roll.included);
  if (bindable.some((roll) => roll.policy === "choose" && roll.finalAttemptId === null)) return "choose";
  if (
    bindable.some((roll) =>
      roll.actor.actorType === "persona" ? roll.actor.actorId !== personaId : roll.actor.actorId !== characterId,
    )
  ) {
    return "actor_mismatch";
  }
  return null;
}

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
  const diceMode = insights.diceMode ?? "normal";
  const lane = useDiceStore.getState().byScope[`${chatId}|${branchId}`]?.lanes?.[diceMode] ?? null;
  const blockReason = diceSendBlockReason(lane, snapshot.persona?.id ?? null, snapshot.activeChat?.characterId ?? null);
  if (blockReason) return { commitIntent: undefined, blockReason };
  const hasBindable = lane !== null && lane.rolls.some((roll) => roll.included);
  const commitIntent = lane && hasBindable ? { diceMode, pendingRevision: lane.revision } : undefined;
  return { commitIntent, blockReason: null };
}

/** Imperative read (at send time) of the experience attachment commit intent
 *  for the EXACT scope the caller is about to send into (IR-73D). The
 *  `expectedChatId` is the actual send target (from the chat store, not the
 *  snapshot); a transient mismatch — snapshot claims a different chat is active
 *  — fails closed so the other chat's attachment can never be bound into this
 *  send. Subtractive-only: when the scope has no queued attachment, or the
 *  attachment's scope IDs don't match the active scope exactly, the intent is
 *  undefined and the send body is byte-identical to a no-experience send.
 *  Derives ONLY the three identifiers/revisions the server already stored —
 *  never `publicReport`, hashes, transcript, state, or visual source. The
 *  returned `scope` (always set when there is an active chat+branch) is used
 *  for the post-settlement authoritative attachment refresh. */
function readExperienceSendState(expectedChatId: ChatId): {
  commitIntent: ExperienceSendCommitIntent | undefined;
  scope: { chatId: string; branchId: string } | null;
} {
  const snapshot = useSnapshotStore.getState();
  // Fail closed unless the snapshot's active chat is the EXACT send target — a
  // transient mismatch could otherwise capture the wrong chat's intent.
  if (snapshot.activeChat?.id !== expectedChatId) return { commitIntent: undefined, scope: null };
  const chatId = snapshot.activeChat?.id ?? null;
  const branchId = snapshot.activeBranch?.id ?? null;
  if (!chatId || !branchId) return { commitIntent: undefined, scope: null };
  const attachment = useExperienceStore.getState().byScope[JSON.stringify([chatId, branchId])]?.queuedAttachment ?? null;
  if (!attachment || attachment.chatId !== chatId || attachment.branchId !== branchId) {
    return { commitIntent: undefined, scope: { chatId, branchId } };
  }
  return {
    commitIntent: {
      experienceAttachmentId: attachment.id,
      experienceQueueRevision: attachment.queueRevision,
      experienceSessionRevision: attachment.sessionRevision,
    },
    scope: { chatId, branchId },
  };
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

/**
 * Shows a category-aware toast for a provider/LLM generation failure. Reads the
 * server-classified `category` from a {@link ProviderStreamError} and picks a
 * description + (for auth) an action that opens provider settings — so the user
 * gets actionable feedback instead of raw HTTP text. Mirrors the existing
 * VISION_NOT_SUPPORTED toast shape. Falls back to the raw message for
 * `unknown` (and for non-ProviderStreamError errors, e.g. network failures
 * before the request reached the server).
 */
function showProviderErrorToast(error: unknown, t: TFunc, fallbackKey: keyof Resources["en"] = "message_send_failed"): void {
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

  // Co-Author binding — used for the send gate when the active chat is in
  // coauthor mode. resolveCoauthorBinding falls back to the RP active profile
  // when no explicit Co-Author pair is saved, so coauthor readiness covers both.
  const coauthorProviderId = useBootstrapStore((s) => s.data?.uiSettings?.coauthorProviderId ?? null);
  const coauthorModelName = useBootstrapStore((s) => s.data?.uiSettings?.coauthorModelName ?? null);
  const chatMode = useSnapshotStore((s) => s.activeChat?.mode);
  const coauthorBinding = useMemo(
    () => resolveCoauthorBinding({ coauthorProviderId, coauthorModelName, profiles: providerProfiles, rpActiveProfile: activeProfile }),
    [coauthorProviderId, coauthorModelName, providerProfiles, activeProfile],
  );

  const canSendViaActiveProfile = chatMode === "coauthor"
    ? coauthorBinding.isReady
    : activeProfile !== null && Boolean(activeProfile.defaultModel);
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
  async function refreshChatSnapshotCache(chatId: ChatId): Promise<AppSnapshot> {
    return fetchChatAction(chatId);
  }

  /**
   * After an abort, the backend needs a moment to save the partial variant
   * before we fetch the snapshot.
   */
  async function refreshAfterAbort(chatId: ChatId): Promise<AppSnapshot> {
    await new Promise((r) => setTimeout(r, 200));
    return refreshChatSnapshotCache(chatId);
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
      onToolCall?: (info: { toolCallId: string; toolName: string; args: unknown }) => void;
      onToolInputStart?: (info: { toolCallId: string; toolName: string }) => void;
      onToolInputDelta?: (info: { toolCallId: string; delta: string }) => void;
      onToolResult?: (info: { toolCallId: string; toolName: string; output: unknown; isError: boolean }) => void;
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
    const completionTargetBeforeStream = streamingMessageId
      ? null
      : findCurrentInsightsCompletionTarget(chatId);
    const controller = useChatStore.getState().startGeneration(chatId, pendingUserContent, pendingAttachments, streamingMessageId);
    const store = useChatStore.getState();
    store.setDraft("");

    // Start the co-author turn fresh: drop the previous turn's tool activities.
    // No-op for RP chats (they never emit tool events, so the store stays empty).
    useCoauthorTurnStore.getState().clearTurn(chatId);

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
        onToolCall: (info) => {
          // Capture the full operation INPUT (args) here — onToolCall fires once
          // the call's args are complete, before execution. onToolResult later
          // merges result fields without erasing args (CED-5), so the activity
          // carries both the input and the cumulative output for the operation card.
          useCoauthorTurnStore.getState().upsertActivity(chatId, {
            toolCallId: info.toolCallId,
            toolName: info.toolName,
            args: info.args,
            status: "streaming",
          });
        },
        onToolInputStart: (info) => {
          useCoauthorTurnStore.getState().upsertActivity(chatId, {
            toolCallId: info.toolCallId,
            toolName: info.toolName,
            status: "streaming",
          });
        },
        onToolResult: (info) => {
          // CTX-S6: a read_skill_file result is {path, content} — NOT a proposal.
          // Recognize it before the proposal-schema parse so the card renders as
          // a normal done read (green check + path) instead of an error card.
          if (info.toolName === "read_skill_file") {
            const read = coauthorSkillReadOutputSchema.safeParse(info.output);
            useCoauthorTurnStore.getState().upsertActivity(chatId, {
              toolCallId: info.toolCallId,
              toolName: info.toolName,
              status: info.isError || !read.success ? "error" : "done",
              ...(read.success ? { readPath: read.data.path } : {}),
            });
            return;
          }
          // CTX-L3: a lore_bundle result is a distinct PROPOSAL arm (the
          // cumulative lore draft). Recognize it before the profile/greeting
          // parse (which would otherwise flag it an error). The five lore tools
          // all return {target:"lore_bundle", bundle, summary}.
          if (
            info.toolName === "create_lorebook" || info.toolName === "create_lore_entry"
            || info.toolName === "set_lore_activation" || info.toolName === "ai_write_lore_entry"
            || info.toolName === "ai_generate_lore_keys"
          ) {
            const lore = coauthorLoreBundleOutputSchema.safeParse(info.output);
            useCoauthorTurnStore.getState().upsertActivity(chatId, {
              toolCallId: info.toolCallId,
              toolName: info.toolName,
              status: info.isError || !lore.success ? "error" : "done",
              ...(lore.success ? { loreBundle: lore.data.bundle, summary: lore.data.summary } : {}),
            });
            return;
          }
          // Narrow the opaque `output` to the CoauthorToolOutput wire contract; a
          // malformed payload (or an explicit tool error) marks the card as error.
          const parsed = coauthorToolOutputSchema.safeParse(info.output);
          useCoauthorTurnStore.getState().upsertActivity(chatId, {
            toolCallId: info.toolCallId,
            toolName: info.toolName,
            status: info.isError || !parsed.success ? "error" : "done",
            ...(parsed.success
              ? {
                  summary: parsed.data.summary,
                  target: parsed.data.target,
                  proposed: parsed.data.proposed,
                  greetingIndex: parsed.data.greetingIndex,
                  isAdd: parsed.data.isAdd,
                }
              : {}),
          });
        },
      });

      await reveal.waitForReveal();
      useChatStore.getState().setPendingContent(chatId, null);
      const snapshot = await refreshChatSnapshotCache(chatId);
      // Fresh send/generate paths emit message.appended and start insight work;
      // regenerate targets an existing message and intentionally does not.
      if (!streamingMessageId) startInsightsCompletionRefreshFromSnapshot(chatId, snapshot);
      void logClientSendDebug("web.hook.stream.success", { chatId, replyLength: collected.length });
      return "done";
    } catch (error) {
      if (controller.signal.aborted) {
        void logClientSendDebug("web.hook.stream.cancelled", { chatId });
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
      streamingMessageId?: string | null;
      /** Suppress the default "generation cancelled" toast — the queue path
       *  (runRegenerateJob) owns its own job-row affordances and stays silent. */
      suppressCancelToast?: boolean;
      /** Caller-specific non-abort error recovery (toast / draft restore /
       *  snapshot refresh). Abort is handled uniformly by the helper. */
      onError?: (error: unknown) => void | Promise<void>;
      /** When set, the helper emits `${label}.success/.cancelled/.error` debug
       *  logs — uniformizing what call sites previously logged inconsistently. */
      debugLabel?: string;
    } = {},
  ): Promise<StreamOutcome> {
    const controller = useChatStore.getState().startGeneration(
      chatId,
      opts.pendingUserContent ?? null,
      opts.pendingAttachments,
      opts.streamingMessageId ?? null,
    );
    try {
      await fn(controller.signal);
      const snapshot = useSnapshotStore.getState();
      useChatStore.getState().setSelectedTraceId(snapshot.promptTrace?.id ?? null);
      if (snapshot.promptTrace && snapshot.activeBranch?.id) {
        useTraceHistoryStore.getState().upsertLatest(chatId, snapshot.activeBranch.id, snapshot.promptTrace);
      }
      if (opts.debugLabel) void logClientSendDebug(`${opts.debugLabel}.success`, { chatId });
      return "done";
    } catch (error) {
      if (controller.signal.aborted) {
        if (opts.debugLabel) void logClientSendDebug(`${opts.debugLabel}.cancelled`, { chatId });
        await refreshAfterAbort(chatId);
        if (!opts.suppressCancelToast) toast.info(getT()("generation_cancelled"));
        return "cancelled";
      }
      if (opts.debugLabel) void logClientSendDebug(`${opts.debugLabel}.error`, { chatId, error: String(error) });
      await opts.onError?.(error);
      return "failed";
    } finally {
      useChatStore.getState().finishGeneration(chatId);
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

    // DICE-F3: capture the commit intent (only when the active lane has a
    // bindable roll) and enforce the subtractive send gate. The button/Enter
    // path already gates on `canSend` (use-input-area); this is the
    // defense-in-depth backstop for any direct handleSend call.
    const dice = readDiceSendState();
    if (dice.blockReason) {
      void logClientSendDebug("web.hook.handleSend.blocked.dice", { activeChatId, reason: dice.blockReason });
      return;
    }

    // IR-73D: capture the experience attachment commit intent (only when the
    // active scope has a valid server-queued attachment). Subtractive: when
    // absent or scope-mismatched, no experience fields are added and no
    // experience refresh is issued. The scope is retained for the post-
    // settlement authoritative attachment refresh (requirement 3). The send
    // target (activeChatId) is passed so a transient snapshot mismatch fails
    // closed instead of capturing the wrong chat's intent.
    const exp = readExperienceSendState(activeChatId);

    if (streamResponseRef.current) {
      void logClientSendDebug("web.hook.handleSend.stream-request", {
        activeChatId,
        generationStatus: getGenerationStatus(activeChatId),
      });
      const currentAttachments = [...csStore.draftAttachments];
      csStore.clearDraftAttachments();
      await executeStreamAction(
        activeChatId,
        (opts) => sendChatMessageStream(activeChatId, { content: trimmed, attachments: attachments.length > 0 ? attachments : undefined, ...dice.commitIntent, ...exp.commitIntent }, opts),
        draft,
        currentAttachments,
      );
    } else {
      void logClientSendDebug("web.hook.handleSend.request", { activeChatId });
      const currentAttachments = [...csStore.draftAttachments];
      csStore.clearDraftAttachments();
      csStore.setDraft("");
      // Draft restore is caller-specific (and only on non-abort errors — an
      // abort is an explicit user cancel, the message is already gone from
      // the draft by design). executeNonStreamAction owns the lifecycle and
      // treats abort as a settled "cancelled" outcome without invoking onError.
      await executeNonStreamAction(
        activeChatId,
        (signal) => sendChatMessageAction(activeChatId, trimmed, attachments.length > 0 ? attachments : undefined, dice.commitIntent, signal, exp.commitIntent),
        {
          pendingUserContent: draft,
          pendingAttachments: currentAttachments,
          debugLabel: "web.hook.handleSend",
          onError: (error) => {
            // DICE-F3: a dice commit conflict resyncs the lane and keeps the
            // draft — it is not a provider failure.
            if (tryHandleDiceSendConflict(error, activeChatId, draft, currentAttachments)) return;
            // IR-73D: an experience bind conflict restores the draft — not a
            // provider failure. The authoritative attachment refresh is
            // handled by the post-settlement refresh below.
            if (tryHandleExperienceSendConflict(error, draft, currentAttachments)) return;
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
          },
        },
      );
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
      await executeNonStreamAction(
        activeChatId,
        (signal) => generateReplyAction(activeChatId, signal),
        {
          debugLabel: "web.hook.handleResend",
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
    try {
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
        await executeNonStreamAction(
          activeChatId,
          (signal) => regenerateMessageAction(activeChatId, messageId, signal),
          {
            streamingMessageId: messageId,
            debugLabel: "web.hook.handleRegenerate",
            onError: async (error) => {
              await refreshChatSnapshotCache(activeChatId);
              toast.error(error instanceof Error ? error.message : getT()("regen_failed"));
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

  async function handleFork(messageId?: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    // Forking a long branch can take seconds. Avoid a distracting flash for
    // fast requests, but make the originating message visibly busy when it
    // crosses the interaction-feedback threshold.
    const feedbackTimer = messageId == null
      ? null
      : window.setTimeout(() => useChatStore.getState().setMessageActionId(messageId), 200);
    try {
      await forkBranchAction(activeChatId, messageId);
    } finally {
      if (feedbackTimer != null) window.clearTimeout(feedbackTimer);
      if (messageId != null && useChatStore.getState().messageActionId === messageId) {
        useChatStore.getState().setMessageActionId(null);
      }
    }
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
        // Non-stream path: same lifecycle contract via executeNonStreamAction.
        // suppressCancelToast — the queue manager owns job-row affordances and
        // stays silent on cancel/error (mirrors the prior behavior).
        return await executeNonStreamAction(
          chatId,
          (signal) => regenerateMessageAction(chatId, messageId, signal, override),
          {
            streamingMessageId: messageId,
            suppressCancelToast: true,
            onError: async () => {
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
