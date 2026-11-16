/**
 * StoryPlanProposalCard (DIRECTOR_MODE_PLAN DR-10a) — the review card for a
 * sidechat `propose_plan` record proposal (`recordType: "story-plan"`),
 * registered as `recordProposalRenderers["story-plan"]` in the sidechat host.
 * The proposal payload is the tool's validated plan (`agentPlanSchema` +
 * `normalizeAgentPlan` — sidechat-director-tools.ts constructs it); Accept
 * applies it through the DR-5 dispatch (`StoryPlanSync.applyPlan`), Reject
 * only writes the row's status.
 *
 * fork #1 of ObjectiveProposalCard.tsx
 * (`apps/web/src/components/chat/sidechat/ObjectiveProposalCard.tsx` —
 * forks: 1 there). Correspondence map (frame cloned, content specialized):
 * 1. Root card container → the source's flex-column card chrome verbatim
 *    (own `story-plan-proposal-card` testid + live `data-status`).
 * 2. Header row (icon + status chip) → the source's icon + chip slots; the
 *    icon is the mockup's list-check (§1/§6 — the story plan's own glyph,
 *    distinct from the objective card's `target`), and the chip is
 *    status-TINTED (mock §6: pending accent, applied success, rejected
 *    muted — the source keeps one accent chip for all states).
 * 3. Payload body → the revision view instead of the source's single line:
 *    the model's `summary` (the source's reason-row shape), the proposed
 *    events as a PURE diff by id against the STORED branch plan (read
 *    through the SAME `useAgentPlan` cache seam the plan section uses —
 *    never a second fetch path), each row with the shared `NodeGlyph` and
 *    a new / changed / removed marker (the locale keys' RU canon), the
 *    current event's body under
 *    its row (the ONE domain pick rule, `pickCurrentPlanTask` at a null
 *    clock — DK-10), a dated row's muted time chip (mockup §6, the ONE
 *    `storyEventTimeLabel` derivation — payload-only, no clock, no wait
 *    mark), the A5 replace warning, and the A6 auto-check `Toggle` row
 *    (only while the tracker's auto-check frequency is 0, off by default).
 * 4. Footer button pair → the source's Accept/Reject pair verbatim
 *    (composed classes — CF13); the apply body carries
 *    `enableAutoCheck: true` only while the A6 toggle is on.
 * 5. Resolved states → the mock §6 lines: the tinted chip (the accepted /
 *    rejected status keys) plus one line, no events, no buttons. The status rides
 *    the tool row (DR-5's status write), so a reload renders them with no
 *    fetch — the stored `applied` / `rejected` seeds the card, as in the
 *    source.
 *
 * Named deviations from the source:
 * - D5: a successful Accept ALSO ingests the response's refreshed `plan`
 *   companion into the plan cache (`ingestAgentPlan`) — the server already
 *   saved it, so every mounted plan consumer (the mobile sidechat plan
 *   section, the future strip) re-renders without a second fetch. The
 *   source refetches the chat only.
 * - D6: no tracker-off gate — the story-plan apply never 409s on a disabled
 *   tracker (applyPlan turns the tracker on when the plan has tasks — A5),
 *   so Accept stays enabled while pending; only the already-resolved 409
 *   is handled.
 * - D7: the review block (events, warning, toggle, buttons) waits for the
 *   stored plan's GET — accepting blind, before the diff markers render,
 *   is exactly what the card exists to prevent. The summary + header show
 *   at once.
 */

import { useState } from "react";
import { brandId, pickCurrentPlanTask, type ChatId, type ObjectiveState } from "@vibe-tavern/domain";
import { agentPlanSchema, type AgentPlan, type AgentPlanTask, type RecordProposal } from "@vibe-tavern/api-contracts";
import { toast } from "sonner";
import type { RecordProposalCardProps } from "../../../lib/agent-host-registry.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { fetchChatAction } from "../../../stores/api-actions/chat-actions.js";
import {
  applyStoryPlanProposal,
  rejectStoryPlanProposal,
  OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE,
  ObjectiveProposalApiError,
} from "../../../api/agent-thread-proposals-api.js";
import { ingestAgentPlan, useAgentPlan } from "../../../hooks/use-agent-plan.js";
import { NodeGlyph } from "../../shared/agent-plan/AgentPlanPanel.js";
import { storyEventTimeChipCls, storyEventTimeLabel } from "../../shared/agent-plan/story-event-time.js";
import { currentItems, isOpenLongTerm } from "../message-slots/objective-zone.js";
import { Icons } from "../../shared/icons.js";
import { Toggle } from "../../shared/Toggle.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";

/** The plan proposal's record type — the DR-5 dispatch table's `story-plan`
 *  key. The constant's home is the proposal domain
 *  (`services/api/.../sidechat-director-tools.ts` `STORY_PLAN_RECORD_TYPE`),
 *  unreachable from the web app; this is the web-side pin of that wire
 *  string (the `SIDECHAT_AGENT_KIND` pattern — one spelling per side,
 *  documented against the source). The card's tests pin the string. */
export const STORY_PLAN_RECORD_TYPE = "story-plan";

/** The story-plan payload contract (`propose_plan` tool input verbatim): the
 *  complete validated plan plus an optional one-line summary for the card. */
interface StoryPlanPayload {
  plan: AgentPlan | null;
  summary?: string;
}

/** Defensive narrow of the opaque proposal payload, the source card's
 *  field-by-field discipline: the plan parses through the SAME strict schema
 *  the tool validated against (`agentPlanSchema` — exactly what the tool
 *  emits after `normalizeAgentPlan`), and an unshaped payload renders empty,
 *  never a throw. */
function readStoryPlanPayload(payload: unknown): StoryPlanPayload {
  if (typeof payload !== "object" || payload === null) return { plan: null };
  const record = payload as Record<string, unknown>;
  const parsed = agentPlanSchema.safeParse(record.plan);
  const plan = parsed.success ? parsed.data : null;
  const summary = typeof record.summary === "string" && record.summary !== "" ? record.summary : undefined;
  return summary === undefined ? { plan } : { plan, summary };
}

/** One revision row: the task as proposed (or as stored, for a removed one)
 *  plus its diff marker. `null` = unchanged — a reorder renders unmarked. */
export interface StoryEventDiffRow {
  readonly task: AgentPlanTask;
  readonly marker: "new" | "changed" | "removed" | null;
}

/**
 * The pure revision diff (mock §6: "a pure diff by id"): align the stored
 * branch plan's events with the proposed ones by id — a proposed id the
 * stored plan lacks is NEW, a stored id the proposal drops is REMOVED,
 * a kept id whose title or body changed is CHANGED (status-only changes
 * are the glyph's business, not a content edit). Ordering is the classic
 * two-pointer walk with insertions before removals in the same gap, which
 * reproduces the mock's §6 order exactly; a reorder (both ids exist ahead)
 * emits the task unmarked, following whichever reappears sooner.
 */
export function diffStoryPlanEvents(
  stored: readonly AgentPlanTask[],
  proposed: readonly AgentPlanTask[],
): StoryEventDiffRow[] {
  const storedIds = new Set(stored.map((task) => task.id));
  const proposedIds = new Set(proposed.map((task) => task.id));
  // A task emitted from ONE side in the reorder branch must never re-emit
  // from the other — its queued twin is skipped, so a pure reorder carries
  // no markers instead of a false removed+new pair.
  const emitted = new Set<string>();
  const rows: StoryEventDiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < stored.length || j < proposed.length) {
    while (i < stored.length && emitted.has(stored[i]!.id)) i++;
    while (j < proposed.length && emitted.has(proposed[j]!.id)) j++;
    if (i >= stored.length && j >= proposed.length) break;
    if (j >= proposed.length) {
      rows.push({ task: stored[i]!, marker: "removed" });
      emitted.add(stored[i]!.id);
      i++;
      continue;
    }
    if (i >= stored.length) {
      rows.push({ task: proposed[j]!, marker: "new" });
      emitted.add(proposed[j]!.id);
      j++;
      continue;
    }
    const prev = stored[i]!;
    const next = proposed[j]!;
    if (prev.id === next.id) {
      rows.push({
        task: next,
        marker: prev.title !== next.title || prev.body !== next.body ? "changed" : null,
      });
      emitted.add(prev.id);
      i++;
      j++;
      continue;
    }
    if (!storedIds.has(next.id)) {
      rows.push({ task: next, marker: "new" });
      emitted.add(next.id);
      j++;
      continue;
    }
    if (!proposedIds.has(prev.id)) {
      rows.push({ task: prev, marker: "removed" });
      emitted.add(prev.id);
      i++;
      continue;
    }
    // Both ids exist ahead — a reorder: follow whichever reappears sooner, no marker.
    const storedAhead = proposed.findIndex((task) => task.id === prev.id) - j;
    const proposedAhead = stored.findIndex((task) => task.id === next.id) - i;
    if (storedAhead <= proposedAhead) {
      rows.push({ task: prev, marker: null });
      emitted.add(prev.id);
      i++;
    } else {
      rows.push({ task: next, marker: null });
      emitted.add(next.id);
      j++;
    }
  }
  return rows;
}

/**
 * A5: Accept replaces the tracker's goals with the plan's events — warn only
 * when something the tracker currently shows would be lost: a current item
 * whose id is not one of the proposed event ids, or an OPEN long-term goal
 * (the projection nulls that slot — A2). Only the ACTIVE branch's plan drives
 * the tracker (the reconciler projects on branch switch), so a proposal
 * against another branch never warns.
 */
export function willAcceptReplaceForeignGoals(
  state: ObjectiveState | undefined,
  proposedTaskIds: ReadonlySet<string>,
  targetBranchId: string | undefined,
  activeBranchId: string | null,
): boolean {
  if (state === undefined || targetBranchId === undefined || targetBranchId !== activeBranchId) return false;
  if (currentItems(state).some((item) => !proposedTaskIds.has(item.id))) return true;
  return state.mode === "goals" && isOpenLongTerm(state.longTermGoal);
}

/** The marker chip tint (mock §6: new = success, changed = warning,
 *  removed = danger). */
function markerClass(marker: "new" | "changed" | "removed"): string {
  const tint =
    marker === "new"
      ? "bg-success-dim text-success-text"
      : marker === "changed"
        ? "bg-warning-dim text-warning-text"
        : "bg-danger-dim text-danger-text";
  return cn(
    "mt-px shrink-0 whitespace-nowrap rounded px-1.5 py-px font-ui text-[calc(var(--ui-fs)-4px)]",
    tint,
  );
}

/** The status chip (mock §6: pending accent, applied success, rejected muted). */
function statusChipClass(status: RecordProposal["status"]): string {
  const tint =
    status === "applied"
      ? "bg-success-dim text-success-text"
      : status === "rejected"
        ? "bg-s2 text-t3"
        : "bg-accent/15 text-accent";
  return cn("shrink-0 rounded-full px-1.5 py-px font-ui text-[calc(var(--ui-fs)-4px)]", tint);
}

export function StoryPlanProposalCard({ proposal, threadId, onResolved }: RecordProposalCardProps) {
  const { t } = useT();
  // The stored status seeds the card: a reloaded thread renders the persisted
  // `applied` / `rejected` (the status rides the tool row — DR-5).
  const [status, setStatus] = useState<RecordProposal["status"]>(proposal.status);
  const [busy, setBusy] = useState(false);
  // A6: the auto-check switch, off by default; its value rides Accept.
  const [autoCheck, setAutoCheck] = useState(false);

  // The chat the sidechat panel is mounted on — the tracker state's owner and
  // the plan owner's chat half (the source card reads the same store).
  const chatId = useSnapshotStore((s) => s.activeChat?.id ?? null);
  const activeBranchId = useSnapshotStore((s) => s.activeChat?.activeBranchId ?? null);
  const objectiveState = useSnapshotStore((s) => s.activeChat?.insightsObjectiveState);
  // A6: the row shows ONLY while the tracker's auto-check is off (0 = manual).
  const autoCheckFrequency = useSnapshotStore((s) => s.activeChat?.insightsObjectiveState.autoCheckFrequency ?? 0);

  // The stored branch plan through the ONE cache seam (useAgentPlan) — the
  // proposal's own branch (its `targetId`), which is what Accept rewrites.
  const branchId = typeof proposal.targetId === "string" ? proposal.targetId : undefined;
  const owner = chatId !== null && branchId !== undefined
    ? { kind: "chatBranch" as const, chatId, branchId }
    : undefined;
  const { plan: storedPlan, isLoading } = useAgentPlan(owner);

  const { plan, summary } = readStoryPlanPayload(proposal.payload);
  const proposedTasks = plan?.tasks ?? [];
  const rows = diffStoryPlanEvents(storedPlan.tasks, proposedTasks);
  const proposedIds = new Set(proposedTasks.map((task) => task.id));
  const replaceWarning = willAcceptReplaceForeignGoals(objectiveState, proposedIds, branchId, activeBranchId);
  // The current event's body shows under its row — the ONE domain pick rule
  // with a null clock (DK-10: the card is payload-only, it reads no tracker
  // time, so the pick is exactly the retired local `pickCurrent` result).
  const currentEventId = pickCurrentPlanTask(proposedTasks, null)?.id ?? null;
  const showAutoCheckRow = status === "pending" && autoCheckFrequency === 0;

  async function runResolve(decision: "apply" | "reject"): Promise<void> {
    if (busy || status !== "pending") return;
    setBusy(true);
    try {
      const resolved =
        decision === "apply"
          ? await applyStoryPlanProposal(
              threadId,
              proposal.id,
              showAutoCheckRow && autoCheck ? { enableAutoCheck: true } : {},
            )
          : await rejectStoryPlanProposal(threadId, proposal.id);
      setStatus(resolved.proposal.status);
      // 2026-11 remount-resurrection guard: the live feed's cached copy of
      // this proposal is now stale — hand the final row to the host.
      onResolved?.(resolved.proposal);
      if (decision === "apply" && resolved.proposal.status === "applied") {
        // D5: the companion plan is authoritative and already saved — push it
        // into the cache so mounted plan consumers re-render (no second GET).
        const currentOwner = owner;
        if (currentOwner !== undefined && resolved.plan !== undefined) {
          ingestAgentPlan(currentOwner, resolved.plan);
        }
        // Fresh ids through `getState()`: render closures hold the pre-action
        // state (the frontend-skill rule). The refetch refreshes the tracker
        // state (the projection changed the chat's goals); the plan is
        // already persisted, so a refetch failure is swallowed.
        const currentChatId = useSnapshotStore.getState().activeChat?.id;
        if (currentChatId !== undefined && currentChatId !== null) {
          try {
            await fetchChatAction(brandId<ChatId>(currentChatId));
          } catch {
            /* the plan is already persisted — the tracker refreshes on the next load */
          }
        }
      }
    } catch (err) {
      if (
        err instanceof ObjectiveProposalApiError &&
        err.code === OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE &&
        err.resolvedStatus !== undefined
      ) {
        // Double click / second tab: the server owns the final status.
        setStatus(err.resolvedStatus);
        onResolved?.({ ...proposal, status: err.resolvedStatus });
        return;
      }
      // Any other failure keeps the card pending and reports through the
      // app's existing error toast (sonner — the source card's precedent).
      toast.error(err instanceof Error ? err.message : t("agent.objective_proposal.request_failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="story-plan-proposal-card"
      data-record-type={proposal.recordType}
      data-op={proposal.op}
      data-status={status}
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface px-2.5 py-2"
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-px shrink-0 leading-[1.45] text-t3"><Icons.listCheck /></span>
        <span className="min-w-0 flex-1 self-center font-ui text-[calc(var(--ui-fs)-1px)] font-medium leading-snug text-t2">
          {t("agent.story_plan_proposal.title")}
        </span>
        <span data-testid="story-plan-proposal-status" className={statusChipClass(status)}>
          {status === "pending"
            ? t("agent.story_plan_proposal.status_pending")
            : status === "applied"
              ? t("agent.story_plan_proposal.status_applied")
              : t("agent.story_plan_proposal.status_rejected")}
        </span>
      </div>

      {summary !== undefined && (
        <div
          data-testid="story-plan-proposal-summary"
          translate="yes"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-3px)] text-t3"
        >
          {summary}
        </div>
      )}

      {status === "applied" ? (
        <div
          data-testid="story-plan-applied-line"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] text-t3"
        >
          {t("agent.story_plan_proposal.applied_line")}
        </div>
      ) : null}
      {status === "rejected" ? (
        <div
          data-testid="story-plan-rejected-line"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] text-t3"
        >
          {t("agent.story_plan_proposal.rejected_line")}
        </div>
      ) : null}

      {status === "pending" && plan !== null ? (
        isLoading ? (
          // D7: the diff needs the stored plan — accepting before the markers
          // render is accepting blind, so the review block waits for the GET.
          <div className="font-ui text-[calc(var(--ui-fs)-3px)] text-t4">{t("agent_plan_loading")}</div>
        ) : (
          <>
            <ol data-testid="story-plan-proposal-events" className="flex min-w-0 flex-col">
              {rows.map((row) => (
                <li
                  key={`${row.marker === "removed" ? "s" : "p"}-${row.task.id}`}
                  data-testid="story-plan-event"
                  data-event-id={row.task.id}
                  data-marker={row.marker ?? ""}
                  className="flex items-start gap-1.5 py-0.5"
                >
                  <span className="mt-[1px] flex shrink-0 items-center justify-center">
                    <NodeGlyph status={row.task.status} />
                  </span>
                  <span className="min-w-0 flex-1">
                    {/* The MODEL's event titles and the current event's body —
                        page-translatable (the objective card's precedent). */}
                    <span
                      translate="yes"
                      className={cn(
                        "block whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)]",
                        row.marker === "removed"
                          ? "text-t4 line-through"
                          : row.task.status === "completed"
                            ? "text-success-text line-through"
                            : row.task.status === "abandoned"
                              ? "text-t4 line-through"
                              : "text-t2",
                      )}
                    >
                      {row.task.title}
                    </span>
                    {row.task.id === currentEventId && row.task.body !== "" && (
                      <span
                        translate="yes"
                        className="mt-0.5 block whitespace-pre-wrap font-ui text-[calc(var(--ui-fs)-3px)] leading-normal text-t4"
                      >
                        {row.task.body}
                      </span>
                    )}
                  </span>
                  {/* DK-10 (mockup §6): a dated proposed event carries the
                      SAME muted time chip as the events tab — payload-only
                      (the card reads no clock), so no "awaits" mark here. */}
                  {row.task.at !== undefined && (
                    <span data-testid="story-plan-event-time" className={storyEventTimeChipCls}>
                      {storyEventTimeLabel(row.task.at, t)}
                    </span>
                  )}
                  {row.marker !== null && (
                    <span data-testid={`story-plan-marker-${row.marker}`} className={markerClass(row.marker)}>
                      {row.marker === "new"
                        ? t("agent.story_plan_proposal.marker_new")
                        : row.marker === "changed"
                          ? t("agent.story_plan_proposal.marker_changed")
                          : t("agent.story_plan_proposal.marker_removed")}
                    </span>
                  )}
                </li>
              ))}
            </ol>

            {replaceWarning && (
              <div
                data-testid="story-plan-replace-warning"
                className="flex items-start gap-1 font-ui text-[calc(var(--ui-fs)-2px)] text-warning-text"
              >
                <span className="mt-px shrink-0"><Icons.alert /></span>
                <span className="min-w-0">{t("agent.story_plan_proposal.warning_replace_goals")}</span>
              </div>
            )}

            {showAutoCheckRow && (
              <div
                data-testid="story-plan-auto-check-row"
                className="flex items-center justify-between gap-2 border-t border-border pt-1.5"
              >
                <span className="min-w-0 font-ui text-[calc(var(--ui-fs)-2px)] text-t2">
                  {t("agent.story_plan_proposal.auto_check_label")}
                </span>
                <Toggle
                  checked={autoCheck}
                  onChange={setAutoCheck}
                  aria-label={t("agent.story_plan_proposal.auto_check_label")}
                />
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="story-plan-proposal-accept"
                disabled={busy}
                onClick={() => void runResolve("apply")}
                className="rounded-md border-0 bg-accent px-4 py-1.5 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
              >
                {t("agent.record_proposal.accept")}
              </button>
              <button
                type="button"
                data-testid="story-plan-proposal-reject"
                disabled={busy}
                onClick={() => void runResolve("reject")}
                className="rounded-md border border-border bg-bg px-3.5 py-1.5 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t2 transition-all hover:bg-s2 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
              >
                {t("coauthor.review.reject")}
              </button>
            </div>
          </>
        )
      ) : null}
    </div>
  );
}
