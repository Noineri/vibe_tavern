import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getT, type TFunc } from "../../../i18n/locale-helpers.js";
import { Icons } from "../icons.js";
import type {
  AgentHostTransport,
  AgentKind,
  AgentMessageAction,
  AgentSendOptions,
  CopilotStreamOpts,
} from "../../../lib/agent-host-registry.js";
import {
  useAgentTurnStore,
} from "../../../stores/agent-turn-store.js";
import {
  experienceCopilotContextMetricsSchema,
  type ExperienceCopilotContextMetrics,
  type ExperienceCopilotMessageWire,
  type ProviderErrorCategory,
} from "@vibe-tavern/api-contracts";
import { ProviderStreamError } from "../../../api/provider-stream-error.js";
import type { Attachment } from "@vibe-tavern/domain";

/**
 * Agent turn actions (AGENT_SHELL_POLISH, Wave 3 / AP-10) — the turn-action
 * handlers the generic shell's action row calls: regenerate the last turn,
 * delete a turn, and edit-last (delete the last exchange, then resend).
 *
 * Split from `use-agent-controller.ts` (which owns the send/answer/cancel
 * flows and the SSE→store wiring) under the file-size ratchet — this module
 * owns the AP-10 surface only. The controller feeds it everything the
 * handlers touch (its send, its callback builder, its turn-state writers)
 * through ONE args object and re-exposes the three handlers on its own
 * contract, so the shell keeps a single controller.
 */

// Categories where the failure is likely transient (retry after a short wait) —
// the message alone is enough; we just add a "try again" hint. Mirrors the RP
// controller's `TRANSIENT_PROVIDER_CATEGORIES` set (see lib/provider-error-toast.ts).
const TRANSIENT_PROVIDER_CATEGORIES: ReadonlySet<ProviderErrorCategory> = new Set(["rate_limit", "timeout", "network", "server_error"]);

/**
 * AP-13: the thread's last turn failure (controller state, keyed per thread
 * — switching threads shows that thread's failure or none). Carries the
 * server-classified category so the error card renders the SAME description
 * the toast rendered (the ONE mapping below); a successful turn clears it,
 * a retry's failure replaces it.
 */
export interface AgentTurnFailure {
  category: ProviderErrorCategory;
}

/** AP-13: the error from a failed turn run narrowed to the failure record. */
export function copilotTurnFailureOf(error: unknown): AgentTurnFailure {
  return { category: error instanceof ProviderStreamError ? error.category : "unknown" };
}

/**
 * AP-13: the ONE category→description derivation the turn-failure surface
 * shares — the toast (below) and the error card (AgentTurnErrorCard) both
 * render through it, so the card carries exactly what the toast carried.
 * Undefined = no description (the toast stays bare, the card hides its
 * description line).
 */
export function copilotFailureDescriptionKey(
  category: ProviderErrorCategory,
): "provider_error_auth_desc" | "provider_error_transient_desc" | "provider_error_empty_desc" | undefined {
  if (category === "authentication") return "provider_error_auth_desc";
  if (TRANSIENT_PROVIDER_CATEGORIES.has(category)) return "provider_error_transient_desc";
  if (category === "empty_response" || category === "parse_error") return "provider_error_empty_desc";
  return undefined;
}

/**
 * Category-aware provider-error toast. `showProviderErrorToast` in
 * lib/provider-error-toast.ts carries the RP modal action, so this is its minimal replica
 * (same category → description mapping), minus the `open_provider_settings`
 * modal action (which is tied to the RP `useModalStore`; the copilot shell owns
 * its own provider selection). Shared with the controller's send/answer error
 * paths (imported back there) — one spelling for the mapping.
 */
export function showProviderErrorToast(error: unknown, t: TFunc): void {
  const message = error instanceof Error && error.message ? error.message : t("message_send_failed");
  const descriptionKey = copilotFailureDescriptionKey(copilotTurnFailureOf(error).category);
  if (descriptionKey !== undefined) {
    toast.error(message, { description: t(descriptionKey) });
    return;
  }
  toast.error(message);
}

/** TAG-9: the optimistic resolution recorded when an ask card is submitted. */
export interface AgentPendingAskAnswer {
  toolCallId: string;
  status: "answered" | "skipped";
  /** The answer text — present iff `status === "answered"`. */
  answer?: string;
}

/** SC-23f: the optimistic resolution recorded when a permission card is
 *  decided (the user's decision, echoed so the card flips immediately). */
export interface AgentPendingPermissionAnswer {
  toolCallId: string;
  decision: "allow" | "deny";
}

/**
 * AP-10: the last user row's id in the CURRENT persisted messages (the
 * edit-last delete target), or null when no user row exists (assistant-only
 * or empty feed). Scans from the end — the trailing assistant row belongs
 * to the turn being edited, the user row before it starts the exchange.
 * Resolved from controller state (the `threadMessages` arg), never a fetch.
 */
function findLastUserMessageId(messages: readonly ExperienceCopilotMessageWire[] | undefined): string | null {
  if (messages === undefined) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row?.role === "user") return row.id;
  }
  return null;
}

/**
 * CA-4e3: the last user row's attachments (edit-last resends them as they
 * are — the editor edits text only). Empty array when no user row exists or
 * the row carries none.
 */
function findLastUserAttachments(messages: readonly ExperienceCopilotMessageWire[] | undefined): readonly Attachment[] {
  if (messages === undefined) return [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row?.role === "user") return row.attachments ?? [];
  }
  return [];
}

/**
 * AP-29 follow-up 3: the ids of the persisted rows a regenerate replaces —
 * every ASSISTANT row after the last user row of the `threadMessages` the
 * regenerate started from (with no user row the whole feed is one turn, so
 * every assistant row). Recorded at regenerate start; tool-role rows need
 * no entries (they render anchored to a flow message inside the hidden
 * fragment, or as the trailing group hidden while the set is non-empty).
 */
function findReplacedAssistantIds(messages: readonly ExperienceCopilotMessageWire[] | undefined): string[] {
  if (messages === undefined) return [];
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  const ids: string[] = [];
  for (let i = lastUserIndex + 1; i < messages.length; i++) {
    const row = messages[i];
    if (row?.role === "assistant") ids.push(row.id);
  }
  return ids;
}

/** The controller-owned turn state the actions drive (refs + writers). */
export interface AgentTurnStateControls {
  isSendingRef: { current: boolean };
  abortRef: { current: AbortController | null };
  setIsSending: (value: boolean) => void;
  setPendingText: (value: string) => void;
  setPendingReasoning: (value: string) => void;
  setPendingAskAnswer: (value: AgentPendingAskAnswer | null) => void;
  setPendingPermissionAnswer: (value: AgentPendingPermissionAnswer | null) => void;
  /** AP-13: write/clear the thread's last turn failure (the error card's
   *  live state — bound to the controller's current thread). */
  setTurnFailure: (failure: AgentTurnFailure | null) => void;
}

export interface UseAgentTurnActionsArgs {
  /** The host kind driving the actions (store keys only — the transport
   *  stays host-injected and kind-free). */
  kind: AgentKind;
  /** The host descriptor's transport — the actions' ONLY API seam. */
  transport: AgentHostTransport;
  threadId: string | null;
  providerProfileId: string | null;
  model?: string;
  /** Called after a turn settles (done/cancelled/failed) so the shell can refetch persisted messages. */
  onTurnSettled?: (ok: boolean) => void;
  /** Feed the segmented context metrics from the `finish` SSE event to the
   *  shell's meter immediately. Null when the event carried no/ill-formed metrics. */
  onMetrics?: (metrics: ExperienceCopilotContextMetrics | null) => void;
  /** The shell's `useAgentPlan` applyToolResult (a `plan` tool result routes
   *  here — forwarded into the shared callback builder). */
  applyPlanToolResult?: (args: unknown, output: unknown) => void;
  /** The shell's CURRENT persisted messages for the thread (fresh every
   *  render) — `handleEditLast` resolves the last user row's id from THIS
   *  list, never a fetch. */
  threadMessages?: ExperienceCopilotMessageWire[];
  /** The controller's send — edit-last falls through to it after the delete. */
  sendTurn: (content: string, opts?: AgentSendOptions) => Promise<void>;
  /** The controller's SSE→store callback builder (the shared live-tool
   *  wiring — one spelling, owned by the controller). */
  buildStreamCallbacks: (activeThreadId: string, sawStreamEvent: { current: boolean }) => CopilotStreamOpts;
  /** The controller-owned turn state the actions drive. */
  turnState: AgentTurnStateControls;
}

/** AP-11: a turn delete staged for confirmation — set by the row's delete
 *  action, cleared by confirm/cancel (or a thread switch). The pane renders
 *  the `DestructiveConfirmModal` from this (the modal tree lives there); the
 *  hook owns WHICH delete awaits confirmation. `includeUserMessage` picks
 *  the modal body: the §3 user-turn text (message + answer go) vs the
 *  assistant-turn text (the reply and its turn actions go). */
export interface AgentPendingDelete {
  messageId: string;
  includeUserMessage: boolean;
}

/** AP-11: the pane-wired row callbacks — the list merges these with its own
 *  boundaries (last turn, digest cover, streaming) per message. */
export interface AgentTurnRowCallbacks {
  onCopy: (text: string) => void;
  onRegenerate: () => void;
  onRequestDelete: (messageId: string, includeUserMessage: boolean) => void;
}

/** AP-11: the inputs `buildAgentTurnRow` derives one message's row from.
 *  Indexes run over the list's VISIBLE (digest-ordered) flow: `visibleIndex`
 *  is the message's own slot, `lastUserVisibleIndex` the last user row's
 *  slot (-1 when the thread has no user row — the whole feed is one turn),
 *  `lastDigestAnchorVisibleIndex` the last digest's ANCHOR slot — the first
 *  kept message (AP-33: delete/edit hide strictly BEFORE it, whatever sits
 *  at the digest's own later slot; the visible end when the anchor dangles;
 *  null = no digest). */
export interface AgentTurnRowInput {
  message: ExperienceCopilotMessageWire;
  visibleIndex: number;
  lastUserVisibleIndex: number;
  lastDigestAnchorVisibleIndex: number | null;
  isSending: boolean;
  hostActions?: AgentMessageAction[];
  callbacks: AgentTurnRowCallbacks;
}

export interface AgentTurnRowResult {
  hostActions?: AgentMessageAction[];
  turnActions?: AgentMessageAction[];
  /** AP-12: the row belongs to the LAST user message (uncovered, not
   *  streaming) — the block renders its own «Изменить» opener there (the
   *  opener flips block-local editing state, so the action is constructed
   *  at the renderer, not here; eligibility still lives in this builder). */
  canEditLast?: boolean;
  /** AP-32: the row is an editable assistant text row (the AP-30 rule —
   *  assistant, non-empty text, no tool calls, uncovered, not streaming)
   *  — the block renders its own «Изменить» opener there (same renderer-
   *  constructed shape as `canEditLast`; eligibility still lives HERE —
   *  the ONE derivation, no second boundary computation). */
  canEditAssistant?: boolean;
}

/**
 * AP-11: one message's action row — the eligibility matrix, pure (no React).
 * Assistant rows: copy always; regenerate only when the row belongs to the
 * LAST turn (past the last user row — the action addresses the thread's last
 * row server-side, so earlier turns get no button); delete unless covered.
 * User rows: delete WITH the answer (`includeUserMessage: true`) unless
 * covered — user rows carry a row for the FIRST time here (SC-16's
 * assistant-only rule covered HOST actions; turn actions are new).
 * AP-12: the LAST user row additionally reports `canEditLast` — the block
 * renders its «Изменить» opener there (streaming and digest-cover both
 * return early above, so eligibility is last user row + not streaming).
 * AP-32: every EDITABLE assistant text row additionally reports
 * `canEditAssistant` — the AP-30 server rule mirrored from the SAME
 * boundaries above (assistant, non-empty text, no `toolCallsJson`, not
 * covered — the streaming early return covers the busy gate). The block
 * renders its opener there; folded rows and tool-call carriers report
 * nothing (copy still rides the row — reading never gates on editing).
 * Digest-covered rows (strictly before the last digest's anchor — the 409
 * floor is server-side, the UI hides proactively): delete hidden, copy
 * kept. While
 * streaming no rows render at all, either role (host rows ride the same
 * gate — the RP row hides its actions while generating). Host actions pass
 * through on assistant rows only (SC-16, unchanged); regenerate/delete need
 * no text, so their `onSelect` adapts within the shape (the closure carries
 * the ids — the text arg is ignored).
 */
export function buildAgentTurnRow(input: AgentTurnRowInput): AgentTurnRowResult {
  const { message, visibleIndex, lastUserVisibleIndex, lastDigestAnchorVisibleIndex, isSending, hostActions, callbacks } = input;
  if (isSending) return {};
  // AP-33: the folded boundary is the last digest's ANCHOR (the first kept
  // message), never the digest's own slot — the separator renders at the
  // compaction moment, later than the anchor, and the kept tail between the
  // two stays actionable (the same rows as when the digest sat at its
  // anchor: covered = strictly before the anchor either way).
  const covered = lastDigestAnchorVisibleIndex !== null && visibleIndex < lastDigestAnchorVisibleIndex;
  if (message.role === "user") {
    if (covered) return {};
    return {
      turnActions: [
        {
          labelKey: "delete",
          icon: Icons.Del,
          onSelect: () => callbacks.onRequestDelete(message.id, true),
          testId: "copilot-turn-delete",
        },
      ],
      // AP-12: the last user row is by definition post-digest (the digest
      // folds older rows), so `!covered` above is the only cover gate.
      ...(visibleIndex === lastUserVisibleIndex ? { canEditLast: true as const } : {}),
    };
  }
  if (message.role !== "assistant") return {};
  const turnActions: AgentMessageAction[] = [
    {
      labelKey: "copy",
      icon: Icons.Copy,
      onSelect: (text) => callbacks.onCopy(text),
      testId: "copilot-turn-copy",
    },
  ];
  if (visibleIndex > lastUserVisibleIndex) {
    turnActions.push({
      labelKey: "regen",
      icon: Icons.Regen,
      onSelect: () => callbacks.onRegenerate(),
      testId: "copilot-turn-regenerate",
    });
  }
  if (!covered) {
    turnActions.push({
      labelKey: "delete",
      icon: Icons.Del,
      onSelect: () => callbacks.onRequestDelete(message.id, false),
      testId: "copilot-turn-delete",
    });
  }
  // AP-32: the editable rule (AP-30's client mirror) — derived HERE from
  // the same boundaries the row above uses: uncovered (the digest floor),
  // non-empty text, no tool calls (carriers are refused server-side). The
  // streaming gate returned early above, so no busy check here.
  const canEditAssistant = !covered &&
    message.content.trim().length > 0 &&
    message.toolCallsJson == null;
  return {
    ...(hostActions !== undefined && hostActions.length > 0 ? { hostActions } : {}),
    turnActions,
    ...(canEditAssistant ? { canEditAssistant: true as const } : {}),
  };
}

/** The AP-10 turn actions — re-exposed on the controller's contract. */
export interface AgentTurnActions {
  /** Rerun the last turn with NO new user row — streams with
   *  `regenerate: true` (the server deletes the replaced turn's rows and
   *  streams the replacement). Mirrors `handleAnswer`'s no-pending-user-
   *  bubble path; the pending/`isSending` flags behave like a send (inputs
   *  stay disabled while it runs). */
  handleRegenerate: (opts?: AgentSendOptions) => Promise<void>;
  /** Delete the turn resolved around `messageId` — the transport's
   *  `deleteTurn`, then the send settle (the shell refetches on
   *  `onTurnSettled`). NO optimistic removal: a failed delete leaves the
   *  feed as-is and surfaces the error the way send errors surface. */
  handleDeleteTurn: (messageId: string, includeUserMessage: boolean) => Promise<void>;
  /** AP-31: edit ONE assistant text row's text in place (AP-30's route) —
   *  the transport's `editMessage`, then the SAME settle refetch the delete
   *  uses. Returns success to the caller (true = the edit landed; AP-32's
   *  editor closes on it). False = failure or a silent guard (blank
   *  content, no thread, already sending — `handleEditLast`'s guard set):
   *  a real failure surfaced the error the delete's way (the provider-error
   *  toast), and NOTHING settles — a failed edit changed nothing
   *  server-side, so there is nothing to refetch (the caller keeps the
   *  draft). */
  handleEditAssistant: (messageId: string, content: string) => Promise<boolean>;
  /** Edit the last exchange — deletes the LAST turn (its user row
   *  included, resolved from `threadMessages`) and sends `content` as a
   *  fresh turn. A failed delete never sends. One settle for the whole
   *  edit: the delete phase does not settle, the send below refetches once. */
  handleEditLast: (content: string) => Promise<void>;
  /** AP-11: the delete staged for confirmation (null = no modal). */
  pendingDelete: AgentPendingDelete | null;
  /** AP-11: stage a row's delete for confirmation (silent guard: no thread
   *  or already sending — the row never renders then, so this is unreachable). */
  requestDeleteTurn: (messageId: string, includeUserMessage: boolean) => void;
  /** AP-11: run the staged delete through `handleDeleteTurn` (settle +
   *  refetch) and clear the stage. A no-op without a staged delete. */
  confirmDeleteTurn: () => Promise<void>;
  /** AP-11: drop the staged delete without touching the API. */
  cancelDeleteTurn: () => void;
  /** AP-29 follow-up 2: a regenerate is in flight — the replaced turn
   *  (every row after the last user row) is already gone server-side, so
   *  the feed hides it until the settle refetch lands the stored truth.
   *  True from the regenerate's turn-start reset to its settle (success,
   *  failure, or cancel); sends and ask-answer continuations never set it.
   *  AP-29 follow-up 3: on SUCCESS the replaced rows stay hidden past the
   *  settle through `hiddenRegeneratedIds` below (this flag still drops at
   *  the settle, as today) — the flag covers the flight, the set covers
   *  the settle → refetch window. */
  isRegenerating: boolean;
  /** AP-29 follow-up 3: the replaced rows' ids (see `findReplacedAssistantIds`),
   *  recorded at regenerate start. On success the set is KEPT past the settle
   *  until a `threadMessages` array arrives without them (the server deleted
   *  them, so the refetch landing the new turn is the natural end); on
   *  refusal / failure / cancel it drops at once with the flag, so the
   *  refetch shows the stored old turn with the error card. Null = no hide
   *  (sends and ask-answer continuations never set it). */
  hiddenRegeneratedIds: readonly string[] | null;
}

export function useAgentTurnActions(
  args: UseAgentTurnActionsArgs,
): AgentTurnActions {
  const { kind, transport, threadId, providerProfileId, model, onTurnSettled, onMetrics, applyPlanToolResult, threadMessages, sendTurn, buildStreamCallbacks, turnState } = args;
  const { isSendingRef, abortRef, setIsSending, setPendingText, setPendingReasoning, setPendingAskAnswer, setPendingPermissionAnswer, setTurnFailure } = turnState;

  // AP-10: the shared delete core for handleDeleteTurn and handleEditLast —
  // guards, busy flags, the transport call, the send-style error path. The
  // outcome RETURNS instead of settling: handleDeleteTurn settles it, while
  // handleEditLast's success path falls through to the send (whose settle
  // refetches once for the whole edit). `null` = a silent guard exit (no
  // thread / already sending) — the caller settles nothing.
  const deleteTurnRun = useCallback(
    async (messageId: string, includeUserMessage: boolean, keepAttachmentFiles = false): Promise<boolean | null> => {
      if (!threadId || isSendingRef.current) return null;
      isSendingRef.current = true;
      setIsSending(true);
      try {
        // CA-4e1: edit-last passes `keepAttachmentFiles` — the row's files are
        // resent with the edited turn, so they must outlive the row delete.
        await transport.deleteTurn(threadId, { messageId, includeUserMessage, ...(keepAttachmentFiles ? { keepAttachmentFiles: true } : {}) });
        return true;
      } catch (error) {
        showProviderErrorToast(error, getT());
        return false;
      } finally {
        isSendingRef.current = false;
        setIsSending(false);
      }
    },
    [threadId, transport, isSendingRef, setIsSending],
  );

  const handleDeleteTurn = useCallback(
    async (messageId: string, includeUserMessage: boolean): Promise<void> => {
      const ok = await deleteTurnRun(messageId, includeUserMessage);
      if (ok === null) return;
      onTurnSettled?.(ok);
    },
    [deleteTurnRun, onTurnSettled],
  );

  // AP-31: edit one assistant text row in place — the delete's flight
  // contract mirrored (busy flags around the single transport call, the
  // provider-error toast on failure) with the caller-facing outcome the
  // delete's void handlers do not have: true = landed (the settle refetch
  // below re-renders the stored text), false = not (the caller keeps its
  // draft). The settle fires only on success and AFTER the busy flags drop
  // (the delete's ordering).
  const handleEditAssistant = useCallback(
    async (messageId: string, content: string): Promise<boolean> => {
      const trimmed = content.trim();
      // Silent guards (no toast): blank content, missing thread, already
      // sending — the same set as handleEditLast.
      if (!trimmed || !threadId || isSendingRef.current) return false;
      isSendingRef.current = true;
      setIsSending(true);
      let ok = false;
      try {
        await transport.editMessage(threadId, messageId, trimmed);
        ok = true;
      } catch (error) {
        showProviderErrorToast(error, getT());
      } finally {
        isSendingRef.current = false;
        setIsSending(false);
      }
      if (ok) onTurnSettled?.(true);
      return ok;
    },
    [threadId, transport, isSendingRef, setIsSending, onTurnSettled],
  );

  const handleRegenerate = useCallback(
    async (opts?: AgentSendOptions): Promise<void> => {
      // Silent guards (no toast): missing thread, already sending.
      if (!threadId || isSendingRef.current) return;
      // Missing provider is the one guard that deserves feedback.
      if (!providerProfileId) {
        toast.error(getT()("message_unavailable_no_provider"));
        return;
      }

      // AP-29 follow-up 2: the replaced turn is already gone server-side
      // once this stream opens (the regenerate mode deletes it before the
      // history load), so the feed hides it from HERE to the settle — the
      // new turn streams as a fresh turn, never joined to the replaced one.
      // A refusal/failure clears it below, and the settle refetch shows the
      // stored truth (the old turn) again, not a blank.
      // AP-29 follow-up 3: record the replaced rows' ids alongside the flag
      // (a later regenerate overwrites them with a fresh set) — the flag
      // drops at the settle below, but the SET survives a success until the
      // refetch lands (see the threadMessages effect next to the flag state).
      setIsRegenerating(true);
      const replacedIds = findReplacedAssistantIds(threadMessages);
      setHiddenRegeneratedIds(replacedIds.length > 0 ? replacedIds : null);

      // Same turn-start reset as a send: the replaced turn's live activities
      // drop (the SSE below rebuilds them), and any stale ask/permission
      // override clears (the settle+refetch shows the persisted truth).
      // AP-13: a retry supersedes the card — the stale failure clears while
      // the new turn runs (its failure replaces the card below).
      useAgentTurnStore.getState().clearTurn(kind, threadId);
      setPendingAskAnswer(null);
      setPendingPermissionAnswer(null);
      setTurnFailure(null);

      const controller = new AbortController();
      abortRef.current = controller;
      isSendingRef.current = true;
      setIsSending(true);
      setPendingText("");
      setPendingReasoning("");
      // NO pendingUserContent — a regenerate has no new user row (the server
      // reruns the last turn against the surviving thread state).

      const sawStreamEvent = { current: false };
      try {
        const streamResult = await transport.sendStream(
          threadId,
          {
            regenerate: true,
            providerProfileId,
            ...(model ? { model } : {}),
            ...(opts?.rules !== undefined ? { rules: opts.rules } : {}),
            ...(opts?.visual !== undefined ? { visual: opts.visual } : {}),
            ...(opts?.code !== undefined ? { code: opts.code } : {}),
            ...(opts?.scriptKind !== undefined ? { scriptKind: opts.scriptKind } : {}),
            ...(opts?.codeSaved !== undefined ? { codeSaved: opts.codeSaved } : {}),
            ...(opts?.contextCharacterId !== undefined ? { contextCharacterId: opts.contextCharacterId } : {}),
            ...(opts?.contextPersonaId !== undefined ? { contextPersonaId: opts.contextPersonaId } : {}),
            ...(opts?.step ? { step: opts.step } : {}),
            ...(opts?.testFeedback !== undefined ? { testFeedback: opts.testFeedback } : {}),
            ...(opts?.launchContext !== undefined ? { launchContext: opts.launchContext } : {}),
            ...(opts?.reviewSnapshot !== undefined ? { reviewSnapshot: opts.reviewSnapshot } : {}),
            ...(opts?.rulesSaved !== undefined ? { rulesSaved: opts.rulesSaved } : {}),
            ...(opts?.visualSaved !== undefined ? { visualSaved: opts.visualSaved } : {}),
            // SC-18: the sidechat host maps its pending variant chips here;
            // absent = not sent (the schema caps the list at 64 pairs).
            ...(opts?.attachedVariants !== undefined ? { attachedVariants: opts.attachedVariants } : {}),
          },
          {
            signal: controller.signal,
            ...buildStreamCallbacks(threadId, sawStreamEvent),
          },
        );

        // Same CM-7 metrics surfacing as handleSend.
        const rawMetrics = streamResult.metrics;
        const parsedMetrics = rawMetrics != null
          ? experienceCopilotContextMetricsSchema.safeParse(rawMetrics)
          : null;
        onMetrics?.(parsedMetrics?.success ? parsedMetrics.data : null);

        setPendingText("");
        setPendingReasoning("");
        setIsSending(false);
        isSendingRef.current = false;
        // AP-13: the retry answered — the card clears with the failure.
        setTurnFailure(null);
        // AP-29 follow-up 3: the flag drops, the hide SET stays — the
        // replaced rows hide until the settle refetch lands without them
        // (no settle → refetch contract change: the effect below drops the
        // set when `threadMessages` no longer contains them).
        setIsRegenerating(false);
        onTurnSettled?.(true);
      } catch (error) {
        if (controller.signal.aborted) {
          toast.info(getT()("generation_cancelled"));
        } else {
          // AP-13: the turn failure owns the surface — the card renders
          // the category description, so the toast is gone.
          setTurnFailure(copilotTurnFailureOf(error));
        }
        setPendingText("");
        setPendingReasoning("");
        setIsSending(false);
        isSendingRef.current = false;
        // AP-29 follow-up 3: refusal / failure / cancel drops the hide at
        // once with the flag (as the flag did alone before) — the settle
        // refetch shows the stored old turn with the error card.
        setIsRegenerating(false);
        setHiddenRegeneratedIds(null);
        onTurnSettled?.(false);
      } finally {
        abortRef.current = null;
      }
    },
    [kind, threadId, providerProfileId, model, transport, onTurnSettled, onMetrics, applyPlanToolResult, buildStreamCallbacks, threadMessages, isSendingRef, abortRef, setIsSending, setPendingText, setPendingReasoning, setPendingAskAnswer, setPendingPermissionAnswer, setTurnFailure],
  );

  const handleEditLast = useCallback(
    async (content: string): Promise<void> => {
      const trimmed = content.trim();

      // CA-4e3: the last user row's attachments ride the resend as they are
      // (the editor edits text only — agent call 2026-10-24), so an
      // attachment-only row keeps editing legal with empty text.
      const attachments = findLastUserAttachments(threadMessages);

      // Silent guards (no toast): no text AND no attachments, missing thread,
      // already sending.
      if ((!trimmed && attachments.length === 0) || !threadId || isSendingRef.current) return;

      // The last exchange resolves from the CURRENT persisted messages (the
      // `threadMessages` arg — controller state, never a fetch). No user row
      // (assistant-only or empty feed) surfaces the error and settles —
      // there is nothing to delete and nothing to send. No dedicated i18n
      // key exists for this degenerate case (AP-11 renders the action only
      // where a user turn exists), so the generic send-failure line carries it.
      const lastUserId = findLastUserMessageId(threadMessages);
      if (lastUserId === null) {
        toast.error(getT()("message_send_failed"));
        onTurnSettled?.(false);
        return;
      }

      // Delete the last exchange WITH its user row first, KEEPING the row's
      // physical files (the resend below points at them — CA-4e1). A failed
      // delete (e.g. the digest floor) never sends — the error already
      // surfaced in the delete core, the feed is untouched, settle so the
      // shell refetches. The success path does NOT settle here: the send
      // below settles once for the whole edit (a single refetch).
      const ok = await deleteTurnRun(lastUserId, true, true);
      if (ok !== true) {
        if (ok === false) onTurnSettled?.(false);
        return;
      }

      await sendTurn(trimmed, { attachments });
    },
    [threadId, threadMessages, deleteTurnRun, sendTurn, onTurnSettled, isSendingRef],
  );

  // AP-11: the delete-confirm stage — the row's delete action only STAGES
  // (the modal renders from the pane); confirm runs it through the shared
  // delete core above (settle + refetch), cancel drops it untouched. A
  // thread switch drops a staged delete (never confirm against the wrong
  // thread — the controller resets its ask/permission overrides the same way).
  const [pendingDelete, setPendingDelete] = useState<AgentPendingDelete | null>(null);

  // AP-29 follow-up 2: the regenerate flight flag (see handleRegenerate).
  // A thread switch drops it like the staged delete (never hide against
  // the wrong thread — a switch mid-stream is disabled shell-side, so this
  // is unreachable in production, the same guard shape as below).
  const [isRegenerating, setIsRegenerating] = useState(false);

  // AP-29 follow-up 3: the replaced rows' hide set (see handleRegenerate).
  // Dropped at once on refusal / failure / cancel above, on thread switch
  // below, and — after a success — by the effect below once a `threadMessages`
  // array arrives without them (the server deleted them, so the refetch that
  // lands the new turn is the natural end; no settle → refetch change).
  const [hiddenRegeneratedIds, setHiddenRegeneratedIds] = useState<readonly string[] | null>(null);

  useEffect(() => {
    if (hiddenRegeneratedIds === null || threadMessages === undefined) return;
    const anyStillPresent = hiddenRegeneratedIds.some((id) => threadMessages.some((row) => row.id === id));
    if (!anyStillPresent) setHiddenRegeneratedIds(null);
  }, [threadMessages, hiddenRegeneratedIds]);

  useEffect(() => {
    setPendingDelete(null);
    setIsRegenerating(false);
    setHiddenRegeneratedIds(null);
  }, [threadId]);

  const requestDeleteTurn = useCallback(
    (messageId: string, includeUserMessage: boolean): void => {
      if (!threadId || isSendingRef.current) return;
      setPendingDelete({ messageId, includeUserMessage });
    },
    [threadId, isSendingRef],
  );

  const cancelDeleteTurn = useCallback((): void => {
    setPendingDelete(null);
  }, []);

  const confirmDeleteTurn = useCallback(
    async (): Promise<void> => {
      if (pendingDelete === null) return;
      const { messageId, includeUserMessage } = pendingDelete;
      setPendingDelete(null);
      await handleDeleteTurn(messageId, includeUserMessage);
    },
    [pendingDelete, handleDeleteTurn],
  );

  return { handleRegenerate, handleDeleteTurn, handleEditAssistant, handleEditLast, pendingDelete, requestDeleteTurn, confirmDeleteTurn, cancelDeleteTurn, isRegenerating, hiddenRegeneratedIds };
}
