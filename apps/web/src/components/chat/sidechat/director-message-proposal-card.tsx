/**
 * DirectorMessageProposalCard (DIRECTOR_MESSAGE_TOOLS_PLAN Wave 3 / DMT-33) —
 * ONE review card for BOTH Director message record types, registered in the
 * sidechat host's `recordProposalRenderers` under the SHARED contract keys
 * (`DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit` / `.messageVariant` — no local
 * string literals; the payload narrow parses through the SAME DMT-11 schemas
 * the server's registry gate uses — never a second hand-written shape):
 *
 * - `message-edit` (`propose_message_edit`): source vs candidate through the
 *   ordinary editor's diff — the `MessageAiEditorModal` fallback chain (word
 *   diff → line diff → labeled source/candidate blocks) — plus the FULL
 *   candidate preview, never truncated. Apply runs the ordinary guarded edit
 *   (the server refuses a moved selection or a changed base with 409 — the
 *   conflict line); Reject changes only the proposal status.
 * - `message-variant` (`propose_message_variant`): the Director's COMPLETE new
 *   reply as the full candidate preview. Save appends + selects a separate
 *   swipe through the ordinary add-variant path — NEVER the merge mode, no
 *   star/two-source requirement, no editor-model rewrite of the supplied text.
 *
 * fork #3 of ObjectiveProposalCard.tsx
 * (`apps/web/src/components/chat/sidechat/ObjectiveProposalCard.tsx` —
 * `forks: 3` there, updated in the same commit). Correspondence map (frame +
 * resolve machine cloned, body specialized for the two message payloads):
 * 1. Root card container → the source's flex-column card chrome verbatim
 *    (own `director-message-proposal-card` testid + live `data-record-type`
 *    / `data-op` / `data-status`).
 * 2. Header row (icon + title + chip) → the source's icon + title-row +
 *    status-chip slots; the icon is type-driven (`edit` vs `branch`) and the
 *    chip is the status-TINTED twin (pending accent, applied success,
 *    rejected muted).
 * 3. Payload body → the message review instead of description/reason: the
 *    target line, the instruction (edit only), the shared
 *    `TextDiffPreview` + `MessageAiEditorCandidatePreview` primitives.
 * 4. Footer button pair → the source's Accept/Reject pair composed classes
 *    verbatim; the primary is Apply (edit) or Save-as-separate-swipe
 *    (variant); the row gains `flex-wrap` so the long RU Save label never
 *    truncates or overflows the narrow sidechat slot (AD-022 budget).
 * 5. Resolved states → the source's stored-status lines + tinted chip, no
 *    buttons; a reloaded thread renders them with no fetch.
 *
 * Named deviations from the source:
 * - D1: ONE component serves BOTH record types — the presentation branches on
 *   the shared contract keys, not a second card.
 * - D2: the review body composes the SHARED review primitives (the ordinary
 *   editor's diff + candidate preview) — no description/reason rows.
 * - D3: a non-already-resolved 409 (stale base / moved selection) pins the
 *   conflict state — the conflict line shows and the primary button disables
 *   (the source's trackerBlocked pattern; the action is known-refusing), and
 *   a 404 (deleted/moved target) pins the missing state the same way.
 * - D4: a successful apply ingests the TARGET-SCOPED message companion
 *   through the canonical `ingestMessageCompanionAction` (fresh
 *   `getState()` reads — the render-closure rule); NO chat refetch and NO
 *   plan-cache ingest — the companion already carries the affected message.
 */

import { useMemo, useState } from "react";
import {
  DIRECTOR_MESSAGE_RECORD_TYPES,
  directorMessageEditProposalSchema,
  directorMessageVariantProposalSchema,
  type DirectorMessageEditProposal,
  type DirectorMessageVariantProposal,
  type RecordProposal,
} from "@vibe-tavern/api-contracts";
import { toast } from "sonner";
import {
  TextDiffPreview,
  buildLineDiff,
  buildWordDiff,
  type TextDiffSummary,
  type TextDiffWordSummary,
} from "../../shared/TextDiffPreview.js";
import { MessageAiEditorCandidatePreview } from "../message-ai-editor-candidate-preview.js";
import type { RecordProposalCardProps } from "../../../lib/agent-host-registry.js";
import {
  applyDirectorMessageProposal,
  rejectDirectorMessageProposal,
  OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE,
  ObjectiveProposalApiError,
} from "../../../api/agent-thread-proposals-api.js";
import { ingestMessageCompanionAction } from "../../../stores/api-actions/chat-actions.js";
import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";

/** Defensive narrow of the opaque proposal payload through the SHARED DMT-11
 *  schema — the server registry gate's own discipline (a safeParse, never a
 *  second hand-written derivation). An unshaped payload renders the frame
 *  empty, never a throw. */
function readEditPayload(payload: unknown): DirectorMessageEditProposal | null {
  if (typeof payload !== "object" || payload === null) return null;
  const parsed = directorMessageEditProposalSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** The `message-variant` twin of {@link readEditPayload}. */
function readVariantPayload(payload: unknown): DirectorMessageVariantProposal | null {
  if (typeof payload !== "object" || payload === null) return null;
  const parsed = directorMessageVariantProposalSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** The status chip tint — the StoryPlanProposalCard twin (pending accent,
 *  applied success, rejected muted). */
function statusChipClass(status: RecordProposal["status"]): string {
  const tint =
    status === "applied"
      ? "bg-success-dim text-success-text"
      : status === "rejected"
        ? "bg-s2 text-t3"
        : "bg-accent/15 text-accent";
  return cn("shrink-0 rounded-full px-1.5 py-px font-ui text-[calc(var(--ui-fs)-4px)]", tint);
}

export function DirectorMessageProposalCard({ proposal, threadId, onResolved }: RecordProposalCardProps) {
  const { t } = useT();
  // The stored status seeds the card: a reloaded thread renders the persisted
  // `applied` / `rejected` with no further fetch (the persisted tool row).
  const [status, setStatus] = useState<RecordProposal["status"]>(proposal.status);
  const [busy, setBusy] = useState(false);
  // D3: a non-already-resolved 409 (the guarded edit refused — stale base or
  // moved selection) pins the conflict state; a 404 (deleted/moved target)
  // pins the missing state. Both keep the row's stored status (still pending
  // server-side) while disabling the known-refusing primary action.
  const [conflict, setConflict] = useState(false);
  const [missing, setMissing] = useState(false);

  // Type-driven presentation off the SHARED contract keys — no local record
  // type literals anywhere in this module. The payload parses once per row
  // (memo on the stable payload — the diff memos below depend on it).
  const isEdit = proposal.recordType === DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit;
  const edit = useMemo(
    () => (isEdit ? readEditPayload(proposal.payload) : null),
    [isEdit, proposal.payload],
  );
  const variant = useMemo(
    () => (isEdit ? null : readVariantPayload(proposal.payload)),
    [isEdit, proposal.payload],
  );

  // The ordinary editor's diff chain, computed once per payload (the
  // MessageAiEditorModal memo discipline): word diff first, line diff when
  // the word budget bails, labeled source/candidate blocks as the last resort.
  const editWordDiff: TextDiffWordSummary | null = useMemo(
    () => (edit === null ? null : buildWordDiff(edit.sourceText, edit.candidate)),
    [edit],
  );
  const editLineDiff: TextDiffSummary | null = useMemo(
    () => (editWordDiff !== null && editWordDiff.tooLarge && edit !== null
      ? buildLineDiff(edit.sourceText, edit.candidate)
      : null),
    [editWordDiff, edit],
  );
  const editShowPlainBlocks =
    edit !== null && editWordDiff !== null && editWordDiff.tooLarge
    && (editLineDiff === null || editLineDiff.tooLarge);

  async function runResolve(decision: "apply" | "reject"): Promise<void> {
    if (busy || status !== "pending") return;
    setBusy(true);
    try {
      const resolved = decision === "apply"
        ? await applyDirectorMessageProposal(threadId, proposal.id)
        : await rejectDirectorMessageProposal(threadId, proposal.id);
      setStatus(resolved.proposal.status);
      // 2026-11 remount-resurrection guard: the live feed's cached copy of
      // this proposal is now stale — hand the final row to the host.
      onResolved?.(resolved.proposal);
      if (decision === "apply" && resolved.proposal.status === "applied") {
        // D4: the companion IS the refreshed target — ingest it through the
        // canonical action (fresh store reads inside; it self-guards scope).
        if (resolved.message !== undefined) {
          ingestMessageCompanionAction(resolved.message);
        }
      }
    } catch (err) {
      if (err instanceof ObjectiveProposalApiError) {
        if (err.code === OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE && err.resolvedStatus !== undefined) {
          // Double click / second tab: the server owns the final status —
          // show it instead of refetching the thread.
          setStatus(err.resolvedStatus);
          onResolved?.({ ...proposal, status: err.resolvedStatus });
          return;
        }
        if (err.status === 409) {
          // The guarded edit refused (stale base / moved selection): the
          // proposal stays pending server-side; show the conflict line and
          // disable the primary action (retrying cannot succeed).
          setConflict(true);
          return;
        }
        if (err.status === 404) {
          // Deleted/moved target (or a deleted source swipe): nothing at the
          // frozen identity to resolve — the missing line, primary disabled.
          setMissing(true);
          return;
        }
      }
      // Any other failure keeps the card pending and reports through the
      // app's existing error toast (sonner — the source card's precedent).
      toast.error(err instanceof Error
        ? err.message
        : t(isEdit
          ? "agent.message_edit_proposal.request_failed"
          : "agent.message_variant_proposal.request_failed"));
    } finally {
      setBusy(false);
    }
  }

  const resolvedLine = status === "applied"
    ? t(isEdit
      ? "agent.message_edit_proposal.applied_line"
      : "agent.message_variant_proposal.saved_line")
    : status === "rejected"
      ? t(isEdit
        ? "agent.message_edit_proposal.rejected_line"
        : "agent.message_variant_proposal.rejected_line")
      : null;
  const statusLabel = status === "pending"
    ? t(isEdit
      ? "agent.message_edit_proposal.status_pending"
      : "agent.message_variant_proposal.status_pending")
    : status === "applied"
      ? t(isEdit
        ? "agent.message_edit_proposal.status_applied"
        : "agent.message_variant_proposal.status_applied")
      : t(isEdit
        ? "agent.message_edit_proposal.status_rejected"
        : "agent.message_variant_proposal.status_rejected");

  return (
    <div
      data-testid="director-message-proposal-card"
      data-record-type={proposal.recordType}
      data-op={proposal.op}
      data-status={status}
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface px-2.5 py-2"
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-px shrink-0 leading-[1.45] text-t3">
          {isEdit ? <Icons.edit /> : <Icons.branch />}
        </span>
        <span className="min-w-0 flex-1 self-center font-ui text-[calc(var(--ui-fs)-1px)] font-medium leading-snug text-t2">
          {t(isEdit
            ? "agent.message_edit_proposal.title"
            : "agent.message_variant_proposal.title")}
        </span>
        <span data-testid="director-message-proposal-status" className={statusChipClass(status)}>
          {statusLabel}
        </span>
      </div>

      {/* The target reply + source swipe(s) — the UI always names them, never
          a bare text payload. The variant number is the FIRST frozen source
          (the reply the Director based the work on); a multi-source variant
          proposal adds the count line. */}
      {(() => {
        const variantNumber = isEdit
          ? edit?.source.variantNumber
          : variant?.sources[0]?.variantNumber;
        if (variantNumber === undefined) return null;
        const sourceCount = isEdit ? undefined : variant?.sources.length;
        return (
          <div data-testid="director-message-proposal-target" className="min-w-0 flex flex-wrap items-baseline gap-x-2">
            <span className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
              {t(isEdit
                ? "agent.message_edit_proposal.target_line"
                : "agent.message_variant_proposal.target_line", { variant: variantNumber })}
            </span>
            {!isEdit && sourceCount !== undefined && sourceCount > 1 && (
              <span className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
                {/* `count` selects the plural suffix, `n` fills the template —
                    the describe-tracker-template precedent. */}
                {t("agent.message_variant_proposal.sources_label", { count: sourceCount, n: sourceCount })}
              </span>
            )}
          </div>
        );
      })()}

      {/* The Director's instruction (edit only) — model text, page-
          translatable (the source card's discipline). */}
      {edit !== null && (
        <div data-testid="director-message-proposal-instruction" className="min-w-0">
          <div className="font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.06em] text-t3">
            {t("agent.message_edit_proposal.instruction_label")}
          </div>
          <div
            translate="yes"
            className="mt-0.5 min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] leading-snug text-t2"
          >
            {edit.instruction}
          </div>
        </div>
      )}

      {/* The review body — pending only, and only with a shaped payload (the
          frame still renders for a corrupt row). */}
      {status === "pending" && (edit !== null || variant !== null) && (
        <>
          {isEdit && edit !== null && !editShowPlainBlocks && editWordDiff !== null && (
            editWordDiff.tooLarge && editLineDiff !== null && !editLineDiff.tooLarge ? (
              <TextDiffPreview
                granularity="line"
                summary={editLineDiff}
                labels={{
                  title: t("message_ai_editor_changes"),
                  tooLarge: t("message_ai_editor_diff_too_large"),
                  noChanges: t("message_ai_editor_no_changes"),
                }}
              />
            ) : !editWordDiff.tooLarge ? (
              <TextDiffPreview
                granularity="word"
                summary={editWordDiff}
                labels={{
                  title: t("message_ai_editor_changes"),
                  tooLarge: t("message_ai_editor_diff_too_large"),
                  noChanges: t("message_ai_editor_no_changes"),
                }}
              />
            ) : null
          )}
          {isEdit && editShowPlainBlocks && edit !== null && (
            /* Both diffs bailed (huge rewrite): the labeled source block
               replaces the diff so the review never goes blind — the exact
               fallback trio the ordinary editor modal renders. */
            <MessageAiEditorCandidatePreview label={t("agent.message_edit_proposal.source_label")}>
              {edit.sourceText}
            </MessageAiEditorCandidatePreview>
          )}
          {/* The FULL candidate, never truncated — the shared preview
              primitive's capped scroll lane. */}
          <MessageAiEditorCandidatePreview
            label={t(isEdit
              ? "agent.message_edit_proposal.candidate_label"
              : "agent.message_variant_proposal.candidate_label")}
          >
            {isEdit ? edit?.candidate ?? "" : variant?.content ?? ""}
          </MessageAiEditorCandidatePreview>
        </>
      )}

      {conflict && (
        <div
          data-testid="director-message-proposal-conflict-line"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] text-warning-text"
        >
          {t("agent.message_edit_proposal.conflict_line")}
        </div>
      )}
      {missing && (
        <div
          data-testid="director-message-proposal-missing-line"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] text-t3"
        >
          {t(isEdit
            ? "agent.message_edit_proposal.source_missing_line"
            : "agent.message_variant_proposal.source_missing_line")}
        </div>
      )}

      {resolvedLine !== null && (
        <div
          data-testid="director-message-proposal-resolved-line"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] text-t3"
        >
          {resolvedLine}
        </div>
      )}

      {status === "pending" && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="director-message-proposal-apply"
            disabled={busy || conflict || missing}
            onClick={() => void runResolve("apply")}
            className="rounded-md border-0 bg-accent px-4 py-1.5 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
          >
            {t(isEdit
              ? "agent.message_edit_proposal.apply"
              : "agent.message_variant_proposal.save")}
          </button>
          <button
            type="button"
            data-testid="director-message-proposal-reject"
            disabled={busy}
            onClick={() => void runResolve("reject")}
            className="rounded-md border border-border bg-bg px-3.5 py-1.5 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t2 transition-all hover:bg-s2 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
          >
            {t(isEdit
              ? "agent.message_edit_proposal.reject"
              : "agent.message_variant_proposal.reject")}
          </button>
        </div>
      )}
    </div>
  );
}
