/**
 * ObjectiveProposalCard (SIDECHAT_PLAN SC-13c) — the review card for a
 * sidechat `propose_objective` record proposal (`recordType: "objective"`),
 * registered as `recordProposalRenderers.objective` in the sidechat host.
 *
 * forks: 2 — StoryPlanProposalCard.tsx (DR-10a's sanctioned fork on this
 * skeleton) and TrackerSceneProposalCard.tsx (DR-10b); each copy's header
 * carries its own correspondence map.
 *
 * DR-10b (R3): while the ACTIVE branch plan has events, the same objective
 * proposal becomes the next PLAN EVENT (the DR-5 dispatch inserts it after
 * the current event — never a tracker item), so the card retitles through
 * the plan-mode strings (mock §6). The plan state comes through the SAME
 * `useAgentPlan` cache seam the plan section reads (the sidechat host's
 * owner = active chat + active branch) — never a second fetch path. With no
 * plan events the card is exactly today's goal card (its SC-11 pins hold).
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
import { ingestAgentPlan, useAgentPlan } from "../../../hooks/use-agent-plan.js";
import { pickCurrent } from "../../shared/agent-plan/AgentPlanPanel.js";
import {
  applyObjectiveProposal,
  rejectObjectiveProposal,
  OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE,
  OBJECTIVE_TRACKER_DISABLED_CODE,
  ObjectiveProposalApiError,
} from "../../../api/agent-thread-proposals-api.js";
import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
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

/** The plan-mode status chip tint (mock §6: pending accent, applied success,
 *  rejected muted — the StoryPlanProposalCard chip's twin; kept private here
 *  because the no-plan chip stays the source's single accent tint). */
function planModeChipClass(status: RecordProposal["status"]): string {
  const tint =
    status === "applied"
      ? "bg-success-dim text-success-text"
      : status === "rejected"
        ? "bg-s2 text-t3"
        : "bg-accent/15 text-accent";
  return cn("shrink-0 rounded-full px-1.5 py-px font-ui text-[calc(var(--ui-fs)-4px)]", tint);
}

export function ObjectiveProposalCard({ proposal, threadId, onResolved }: RecordProposalCardProps) {
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

  // DR-10b (R3): the ACTIVE branch's plan through the ONE cache seam — the
  // same `useAgentPlan` entry the sidechat plan section reads (the host's
  // owner = active chat + active branch). No branch id (the store's chat
  // without one) → no owner → the empty plan → today's card byte-identical.
  const chatId = useSnapshotStore((s) => s.activeChat?.id ?? null);
  const activeBranchId = useSnapshotStore((s) => s.activeChat?.activeBranchId ?? null);
  const planOwner = chatId !== null && activeBranchId !== null
    ? { kind: "chatBranch" as const, chatId, branchId: activeBranchId }
    : undefined;
  const { plan, isLoading } = useAgentPlan(planOwner);
  // The R3 predicate — the web twin of the dispatch's `activeBranchPlanWithEvents`
  // (`plan.tasks.length > 0`), held off while the first GET runs so a cold
  // cache never flashes the plan-mode copy over a plan that may not exist.
  const planMode = !isLoading && plan.tasks.length > 0;
  // The current event's title interpolates into the "goes next" line (the
  // shared `pickCurrent` rule — `pickCurrentStoryEvent`'s web twin). An
  // all-completed plan has no current event: the line simply renders nothing
  // (the backend appends at the end — `insertStoryEventAfterCurrent`).
  const currentEvent = pickCurrent(plan.tasks);

  async function runResolve(decision: "apply" | "reject"): Promise<void> {
    if (busy || status !== "pending") return;
    setBusy(true);
    try {
      const resolved =
        decision === "apply"
          ? await applyObjectiveProposal(threadId, proposal.id)
          : await rejectObjectiveProposal(threadId, proposal.id);
      setStatus(resolved.proposal.status);
      // 2026-11 remount-resurrection guard: the live feed's cached copy of
      // this proposal is now stale — hand the final row to the host.
      onResolved?.(resolved.proposal);
      if (decision === "apply" && resolved.proposal.status === "applied") {
        // DR-10b: under a plan the apply response carries the refreshed
        // `plan` companion (the inserted event is already saved) — ingest it
        // into the cache so mounted plan consumers re-render without a
        // second fetch (the StoryPlanProposalCard D5 pattern). The owner is
        // the render-scope one whose plan the user just reviewed.
        if (planOwner !== undefined && resolved.plan !== undefined) {
          ingestAgentPlan(planOwner, resolved.plan);
        }
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
          onResolved?.({ ...proposal, status: err.resolvedStatus });
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
        {planMode && (
          <span
            className="min-w-0 flex-1 self-center font-ui text-[calc(var(--ui-fs)-1px)] font-medium leading-snug text-t2"
          >
            {t("agent.objective_proposal.plan_mode_title")}
          </span>
        )}
        <span
          data-testid="objective-proposal-status"
          className={planMode
            ? planModeChipClass(status)
            : "ml-1 shrink-0 rounded-full bg-accent/15 px-1.5 py-px font-ui text-[calc(var(--ui-fs)-4px)] text-accent"}
        >
          {status === "pending"
            ? planMode
              ? t("agent.objective_proposal.plan_status_pending")
              : t("agent.record_proposal.status_pending")
            : status === "applied"
              ? planMode
                ? t("agent.objective_proposal.plan_status_applied")
                : t("agent.objective_proposal.added")
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

      {/* R3: the event's future position — the current event's title
          interpolates (model text — page-translatable). An all-completed plan
          has no current event and renders no line. */}
      {planMode && status === "pending" && currentEvent !== null && (
        <div
          data-testid="objective-plan-next-line"
          translate="yes"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-3px)] text-t3"
        >
          {t("agent.objective_proposal.plan_next_line", { title: currentEvent.title })}
        </div>
      )}

      {planMode && status === "applied" ? (
        <div
          data-testid="objective-plan-applied-line"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] text-t3"
        >
          {t("agent.objective_proposal.plan_applied_line")}
        </div>
      ) : null}

      {status === "pending" ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="objective-proposal-accept"
            disabled={busy || trackerOff}
            onClick={() => void runResolve("apply")}
            className="rounded-md border-0 bg-accent px-4 py-1.5 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
          >
            {planMode
              ? t("agent.objective_proposal.plan_accept")
              : t("agent.record_proposal.accept")}
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
