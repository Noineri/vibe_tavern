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
} from "@vibe-tavern/api-contracts";
import { ProviderStreamError } from "../../../api/provider-stream-error.js";

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
const TRANSIENT_PROVIDER_CATEGORIES = new Set(["rate_limit", "timeout", "network", "server_error"]);

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
  const category = error instanceof ProviderStreamError ? error.category : "unknown";

  if (category === "authentication") {
    toast.error(message, { description: t("provider_error_auth_desc") });
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

/** The controller-owned turn state the actions drive (refs + writers). */
export interface AgentTurnStateControls {
  isSendingRef: { current: boolean };
  abortRef: { current: AbortController | null };
  setIsSending: (value: boolean) => void;
  setPendingText: (value: string) => void;
  setPendingReasoning: (value: string) => void;
  setPendingAskAnswer: (value: AgentPendingAskAnswer | null) => void;
  setPendingPermissionAnswer: (value: AgentPendingPermissionAnswer | null) => void;
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
 *  `lastDigestVisibleIndex` the last digest card's slot (null = no digest). */
export interface AgentTurnRowInput {
  message: ExperienceCopilotMessageWire;
  visibleIndex: number;
  lastUserVisibleIndex: number;
  lastDigestVisibleIndex: number | null;
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
 * Digest-covered rows (at/before the digest anchor — the 409 floor is
 * server-side, the UI hides proactively): delete hidden, copy kept. While
 * streaming no rows render at all, either role (host rows ride the same
 * gate — the RP row hides its actions while generating). Host actions pass
 * through on assistant rows only (SC-16, unchanged); regenerate/delete need
 * no text, so their `onSelect` adapts within the shape (the closure carries
 * the ids — the text arg is ignored).
 */
export function buildAgentTurnRow(input: AgentTurnRowInput): AgentTurnRowResult {
  const { message, visibleIndex, lastUserVisibleIndex, lastDigestVisibleIndex, isSending, hostActions, callbacks } = input;
  if (isSending) return {};
  const covered = lastDigestVisibleIndex !== null && visibleIndex <= lastDigestVisibleIndex;
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
  return {
    ...(hostActions !== undefined && hostActions.length > 0 ? { hostActions } : {}),
    turnActions,
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
}

export function useAgentTurnActions(
  args: UseAgentTurnActionsArgs,
): AgentTurnActions {
  const { kind, transport, threadId, providerProfileId, model, onTurnSettled, onMetrics, applyPlanToolResult, threadMessages, sendTurn, buildStreamCallbacks, turnState } = args;
  const { isSendingRef, abortRef, setIsSending, setPendingText, setPendingReasoning, setPendingAskAnswer, setPendingPermissionAnswer } = turnState;

  // AP-10: the shared delete core for handleDeleteTurn and handleEditLast —
  // guards, busy flags, the transport call, the send-style error path. The
  // outcome RETURNS instead of settling: handleDeleteTurn settles it, while
  // handleEditLast's success path falls through to the send (whose settle
  // refetches once for the whole edit). `null` = a silent guard exit (no
  // thread / already sending) — the caller settles nothing.
  const deleteTurnRun = useCallback(
    async (messageId: string, includeUserMessage: boolean): Promise<boolean | null> => {
      if (!threadId || isSendingRef.current) return null;
      isSendingRef.current = true;
      setIsSending(true);
      try {
        await transport.deleteTurn(threadId, { messageId, includeUserMessage });
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

  const handleRegenerate = useCallback(
    async (opts?: AgentSendOptions): Promise<void> => {
      // Silent guards (no toast): missing thread, already sending.
      if (!threadId || isSendingRef.current) return;
      // Missing provider is the one guard that deserves feedback.
      if (!providerProfileId) {
        toast.error(getT()("message_unavailable_no_provider"));
        return;
      }

      // Same turn-start reset as a send: the replaced turn's live activities
      // drop (the SSE below rebuilds them), and any stale ask/permission
      // override clears (the settle+refetch shows the persisted truth).
      useAgentTurnStore.getState().clearTurn(kind, threadId);
      setPendingAskAnswer(null);
      setPendingPermissionAnswer(null);

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
        onTurnSettled?.(true);
      } catch (error) {
        if (controller.signal.aborted) {
          toast.info(getT()("generation_cancelled"));
        } else {
          showProviderErrorToast(error, getT());
        }
        setPendingText("");
        setPendingReasoning("");
        setIsSending(false);
        isSendingRef.current = false;
        onTurnSettled?.(false);
      } finally {
        abortRef.current = null;
      }
    },
    [kind, threadId, providerProfileId, model, transport, onTurnSettled, onMetrics, applyPlanToolResult, buildStreamCallbacks, isSendingRef, abortRef, setIsSending, setPendingText, setPendingReasoning, setPendingAskAnswer, setPendingPermissionAnswer],
  );

  const handleEditLast = useCallback(
    async (content: string): Promise<void> => {
      const trimmed = content.trim();

      // Silent guards (no toast): empty content, missing thread, already sending.
      if (!trimmed || !threadId || isSendingRef.current) return;

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

      // Delete the last exchange WITH its user row first. A failed delete
      // (e.g. the digest floor) never sends — the error already surfaced in
      // the delete core, the feed is untouched, settle so the shell refetches.
      // The success path does NOT settle here: the send below settles once
      // for the whole edit (a single refetch).
      const ok = await deleteTurnRun(lastUserId, true);
      if (ok !== true) {
        if (ok === false) onTurnSettled?.(false);
        return;
      }

      await sendTurn(trimmed);
    },
    [threadId, threadMessages, deleteTurnRun, sendTurn, onTurnSettled, isSendingRef],
  );

  // AP-11: the delete-confirm stage — the row's delete action only STAGES
  // (the modal renders from the pane); confirm runs it through the shared
  // delete core above (settle + refetch), cancel drops it untouched. A
  // thread switch drops a staged delete (never confirm against the wrong
  // thread — the controller resets its ask/permission overrides the same way).
  const [pendingDelete, setPendingDelete] = useState<AgentPendingDelete | null>(null);

  useEffect(() => {
    setPendingDelete(null);
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

  return { handleRegenerate, handleDeleteTurn, handleEditLast, pendingDelete, requestDeleteTurn, confirmDeleteTurn, cancelDeleteTurn };
}
