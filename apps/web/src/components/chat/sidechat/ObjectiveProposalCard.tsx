/**
 * ObjectiveProposalCard (SIDECHAT_PLAN SC-13c) — the review card for a
 * sidechat `propose_objective` record proposal (`recordType: "objective"`),
 * registered as `recordProposalRenderers.objective` in the sidechat host.
 *
 * fork #1 of RecordProposalFallbackCard
 * (`apps/web/src/components/shared/agent-shell/RecordProposalFallbackCard.tsx`).
 * Correspondence map (frame cloned, content specialized):
 * 1. Root card container → the fallback's flex-column card chrome verbatim
 *    (own `objective-proposal-card` testid + live `data-status`).
 * 2. Header row (icon + line) → the fallback's icon + title-row slot; the
 *    icon is `Ic.target` (the RP objective zone's own icon) instead of the
 *    fallback's neutral `FileText`, and the line carries the STORED status
 *    chip instead of the pending-only chip (a reloaded thread renders the
 *    stored `applied` / `rejected` directly).
 * 3. Payload preview (`codeQuote` JSON block) → the objective description as
 *    body text plus the optional reason in muted text (user-facing copy, not
 *    a code quote — the payload contract `{ description, reason? }` is known,
 *    so no defensive stringify; an unshaped payload renders empty, never a
 *    throw).
 * 4. Footer (disabled Accept + hint) → the mini-app assistant's review button
 *    pair cloned from `CoauthorReviewingOverlay.tsx` (bordered Reject +
 *    accent Apply, `disabled:opacity-40`), with the resolved-state lines and
 *    the tracker-off hint. Named deviations from BOTH sources:
 *    - D1 (vs the fallback): Accept is ENABLED while pending — the type is
 *      known and rendered, so committing is not blind.
 *    - D2 (vs the fallback): Reject stays enabled while the tracker is off —
 *      rejecting writes nothing to the tracker, so only Accept is gated.
 *    - D3 (vs the CoauthorReviewingOverlay pair): while a request runs, BOTH
 *      buttons disable (the overlay disables on `applying` only) — a second
 *      click would race the single-tx server lock into a typed 409.
 *    - D4 (vs the overlay): the applied/rejected lines and the tracker-off
 *      hint are new rows — the overlay has no resolved or disabled-tracker
 *      states (its footer is review-only).
 *
 * States: pending → Accept / Reject; applied → the added line; rejected →
 * the rejected line; tracker off (the ACTIVE chat's
 * `insightsConfig.objectiveEnabled`, read live from the snapshot store) → a
 * disabled Accept with the tracker hint. A successful Accept refetches the
 * active chat (`fetchChatAction`, the SceneHistoryBackfill pattern — the
 * record is already persisted, so a refetch failure is swallowed) so the RP
 * objective zone shows the new item at once.
 */

import { useState } from "react";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import type { RecordProposal } from "@vibe-tavern/api-contracts";
import { toast } from "sonner";
import type { RecordProposalCardProps } from "../../../lib/agent-host-registry.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { fetchChatAction } from "../../../stores/api-actions/chat-actions.js";
import {
  applyObjectiveProposal,
  rejectObjectiveProposal,
  OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE,
  OBJECTIVE_TRACKER_DISABLED_CODE,
  ObjectiveProposalApiError,
} from "../../../api/agent-thread-proposals-api.js";
import { Icons } from "../../shared/icons.js";
import { useT } from "../../../i18n/context.js";

/** The objective payload contract (sidechat `propose_objective` tool input
 *  verbatim): a required description plus an optional one-line reason. */
interface ObjectivePayload {
  description: string;
  reason?: string;
}

/** Defensive narrow of the opaque proposal payload: an unshaped payload
 *  renders empty, never a throw (the fallback stringifies; here the shape
 *  is known so a narrow replaces the try/catch). */
function readObjectivePayload(payload: unknown): ObjectivePayload {
  if (typeof payload !== "object" || payload === null) return { description: "" };
  const record = payload as Record<string, unknown>;
  const description = typeof record.description === "string" ? record.description : "";
  const reason = typeof record.reason === "string" && record.reason !== "" ? record.reason : undefined;
  return reason === undefined ? { description } : { description, reason };
}

export function ObjectiveProposalCard({ proposal, threadId }: RecordProposalCardProps) {
  const { t } = useT();
  // The stored status seeds the card: a reloaded thread renders the persisted
  // `applied` / `rejected` with no further fetch (the message list passes the
  // tool row's parsed output straight through).
  const [status, setStatus] = useState<RecordProposal["status"]>(proposal.status);
  const [busy, setBusy] = useState(false);
  // A 409 `objective_tracker_disabled` pins the off state locally: the store
  // may still read on (the user flipped the toggle after this render), and a
  // refetch would not change the refusal.
  const [trackerBlocked, setTrackerBlocked] = useState(false);
  // Render-path hook (the objective-zone pattern): the card re-renders when
  // the active chat's tracker toggle changes, so no manual refresh is needed.
  const trackerOn = useSnapshotStore((s) => s.activeChat?.insightsConfig.objectiveEnabled ?? false);
  const trackerOff = !trackerOn || trackerBlocked;
  const { description, reason } = readObjectivePayload(proposal.payload);

  async function runResolve(decision: "apply" | "reject"): Promise<void> {
    if (busy || status !== "pending") return;
    setBusy(true);
    try {
      const resolved =
        decision === "apply"
          ? await applyObjectiveProposal(threadId, proposal.id)
          : await rejectObjectiveProposal(threadId, proposal.id);
      setStatus(resolved.proposal.status);
      if (decision === "apply" && resolved.proposal.status === "applied") {
        // Fresh id through `getState()`: render closures hold the pre-action
        // state (the frontend-skill rule). The chat cannot be null here (the
        // sidechat panel mounts on the active chat), but stay defensive.
        const chatId = useSnapshotStore.getState().activeChat?.id;
        if (chatId !== undefined && chatId !== null) {
          try {
            await fetchChatAction(brandId<ChatId>(chatId));
          } catch {
            /* the item is already persisted — the zone refreshes on the next load */
          }
        }
      }
    } catch (err) {
      if (err instanceof ObjectiveProposalApiError) {
        if (err.code === OBJECTIVE_TRACKER_DISABLED_CODE) {
          setTrackerBlocked(true);
          return;
        }
        if (err.code === OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE && err.resolvedStatus !== undefined) {
          // Double click / second tab: the server owns the final status —
          // show it instead of refetching the thread.
          setStatus(err.resolvedStatus);
          return;
        }
      }
      // Any other failure keeps the card pending and reports through the
      // app's existing error toast (sonner — the TrackerConfig precedent).
      toast.error(err instanceof Error ? err.message : t("agent.objective_proposal.request_failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="objective-proposal-card"
      data-record-type={proposal.recordType}
      data-op={proposal.op}
      data-status={status}
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface px-2.5 py-2"
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-px shrink-0 leading-[1.45] text-t3"><Icons.target /></span>
        <span
          data-testid="objective-proposal-status"
          className="ml-1 shrink-0 rounded-full bg-accent/15 px-1.5 py-px font-ui text-[calc(var(--ui-fs)-4px)] text-accent"
        >
          {status === "pending"
            ? t("agent.record_proposal.status_pending")
            : status === "applied"
              ? t("agent.objective_proposal.added")
              : t("agent.objective_proposal.rejected")}
        </span>
      </div>

      {/* The proposed objective is MODEL text — page-translatable (owner
          follow-up 2026-10-24); the status chip and buttons are chrome. */}
      <div
        data-testid="objective-proposal-description"
        translate="yes"
        className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] font-medium leading-snug text-t2"
      >
        {description}
      </div>

      {reason !== undefined && (
        <div
          data-testid="objective-proposal-reason"
          translate="yes"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-3px)] text-t3"
        >
          {reason}
        </div>
      )}

      {status === "pending" ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="objective-proposal-accept"
            disabled={busy || trackerOff}
            onClick={() => void runResolve("apply")}
            className="rounded-md border-0 bg-accent px-4 py-1.5 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
          >
            {t("agent.record_proposal.accept")}
          </button>
          <button
            type="button"
            data-testid="objective-proposal-reject"
            disabled={busy}
            onClick={() => void runResolve("reject")}
            className="rounded-md border border-border bg-bg px-3.5 py-1.5 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t2 transition-all hover:bg-s2 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
          >
            {t("coauthor.review.reject")}
          </button>
          {trackerOff && (
            <span
              data-testid="objective-proposal-tracker-hint"
              className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-3px)] text-t3"
            >
              {t("agent.objective_proposal.tracker_disabled_hint")}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
