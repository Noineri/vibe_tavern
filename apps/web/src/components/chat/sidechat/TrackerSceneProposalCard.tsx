/**
 * TrackerSceneProposalCard (DIRECTOR_MODE_PLAN DR-10b) — the review card for
 * a sidechat `propose_tracker_template` record proposal
 * (`recordType: "tracker-scene"`), registered as
 * `recordProposalRenderers["tracker-scene"]` in the sidechat host. The
 * proposal payload is the generated tracker template's SCENE half only (A9 —
 * goal tracking comes from the story plan; `sidechat-director-tools.ts`
 * drops the objective section before proposing). Accept applies it through
 * the DR-5 dispatch (the insights adapter's shared template tail with
 * `objective: null`), BODY-LESS — the addressed row's payload is the whole
 * input; Reject only writes the row's status.
 *
 * fork #2 of ObjectiveProposalCard.tsx
 * (`apps/web/src/components/chat/sidechat/ObjectiveProposalCard.tsx —
 * forks: 2 there`; DR-10a's StoryPlanProposalCard is fork #1 and the
 * structural reference for the title-bearing header). Correspondence map
 * (frame cloned, content specialized):
 * 1. Root card container → the source's flex-column card chrome verbatim
 *    (own `tracker-scene-proposal-card` testid + live `data-status`).
 * 2. Header row (icon + title + status chip) → the StoryPlanProposalCard's
 *    title-bearing header shape (the mock §6 card carries a title; the
 *    source's header is chip-only) — the icon is the mock's layout-list
 *    (§6, `Icons.layoutList`), the chip is status-TINTED (mock §6: pending
 *    accent, applied success, rejected muted — the source keeps one accent
 *    tint for all states).
 * 3. Payload body → the card-composed summary line (the tool sends NO
 *    `summary` — `sidechatTrackerProposalInputSchema`'s doc: the card
 *    composes its own line; the mock §6 prefix over the scene schema's
 *    field labels/keys — key
 *    `agent.tracker_scene_proposal.summary_prefix`) plus the SHARED
 *    `TrackerTemplateSchemaPreview` rendering the template's scene part
 *    (never forked; the parse pins `objective: null` so an objective half
 *    that rides the payload is DROPPED, never rendered). The parse goes
 *    through the domain's `normalizeTrackerTemplate` — the ONE normalizer
 *    every tracker-template surface reads; an unshaped payload renders
 *    empty, never a throw.
 * 4. Footer button pair → the source's Accept/Reject pair verbatim
 *    (composed classes — CF13); the apply carries no body.
 * 5. Resolved states → the mock §6 lines: applied → the applied line
 *    (`agent.tracker_scene_proposal.applied_line`) plus the muted hint
 *    pointing at the chat settings' existing save-as-character-template
 *    action (`agent.tracker_scene_proposal.save_hint` interpolates the
 *    EXISTING `insights_template_save_as_character` wording — one
 *    derivation of that button's name); rejected → the muted chip only
 *    (the source's rejected shape — the plan specifies no rejected line for
 *    this card). The stored `applied` / `rejected` seeds the card, so a
 *    reload renders with no fetch.
 *
 * Named deviations from the source:
 * - D8: no tracker-off gate — the tracker-scene apply never 409s on a
 *   disabled objective tracker (it writes the scene tracker setup, a
 *   different toggle), so Accept stays enabled while pending; only the
 *   already-resolved 409 is handled.
 * - D9: a successful Accept refetches the active chat (the source's
 *   `fetchChatAction` pattern) so the chat's scene tracker config lands in
 *   the snapshot at once; the response's `patch` companion is display-only
 *   here (the refetch already carries the same config to every consumer).
 */

import { useState } from "react";
import { brandId, type ChatId, normalizeTrackerTemplate, TRACKER_TEMPLATE_VERSION, type TrackerTemplate } from "@vibe-tavern/domain";
import type { RecordProposal } from "@vibe-tavern/api-contracts";
import { toast } from "sonner";
import type { RecordProposalCardProps } from "../../../lib/agent-host-registry.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { fetchChatAction } from "../../../stores/api-actions/chat-actions.js";
import {
  applyTrackerSceneProposal,
  rejectTrackerSceneProposal,
  OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE,
  ObjectiveProposalApiError,
} from "../../../api/agent-thread-proposals-api.js";
import { TrackerTemplateSchemaPreview } from "../../shared/tracker-template-schema-preview.js";
import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";

/** The tracker-scene proposal's record type — the DR-5 dispatch table's
 *  `tracker-scene` key. The constant's home is the proposal domain
 *  (`services/api/.../sidechat-director-tools.ts` `TRACKER_SCENE_RECORD_TYPE`),
 *  unreachable from the web app; this is the web-side pin of that wire
 *  string (the `STORY_PLAN_RECORD_TYPE` pattern — one spelling per side,
 *  documented against the source). The card's tests pin the string. */
export const TRACKER_SCENE_RECORD_TYPE = "tracker-scene";

/** The tracker-scene payload contract (`propose_tracker_template`'s emitted
 *  proposal verbatim): the scene template half alone —
 *  `{ scene: { enabled, config } }` (A9; the tool drops the generated
 *  objective section before proposing). */
interface TrackerScenePayload {
  template: TrackerTemplate | null;
}

/** Defensive narrow of the opaque proposal payload, the source card's
 *  field-by-field discipline: the scene half parses through the domain's
 *  ONE tracker-template normalizer (the same boundary the character-card
 *  route reads a template through), with `objective: null` pinned so an
 *  objective section riding the payload is DROPPED at the parse, never
 *  rendered (A9). An unshaped payload renders empty, never a throw. */
function readTrackerScenePayload(payload: unknown): TrackerScenePayload {
  if (typeof payload !== "object" || payload === null) return { template: null };
  const record = payload as Record<string, unknown>;
  const template = normalizeTrackerTemplate({
    version: TRACKER_TEMPLATE_VERSION,
    scene: record.scene,
    objective: null,
  });
  return { template };
}

/** The summary line's field list (mock §6: the fields-for-this-story
 *  prefix over the field names): each top-level scene field's label, falling
 *  back to its key — exported pure so the card's tests pin the composition. */
export function trackerSceneSummaryFields(template: TrackerTemplate): string[] {
  return Object.entries(template.scene?.config.schema ?? {}).map(([key, node]) => node.label ?? key);
}

/** The status chip (mock §6: pending accent, applied success, rejected muted —
 *  the StoryPlanProposalCard chip's twin). */
function statusChipClass(status: RecordProposal["status"]): string {
  const tint =
    status === "applied"
      ? "bg-success-dim text-success-text"
      : status === "rejected"
        ? "bg-s2 text-t3"
        : "bg-accent/15 text-accent";
  return cn("shrink-0 rounded-full px-1.5 py-px font-ui text-[calc(var(--ui-fs)-4px)]", tint);
}

export function TrackerSceneProposalCard({ proposal, threadId, onResolved }: RecordProposalCardProps) {
  const { t } = useT();
  // The stored status seeds the card: a reloaded thread renders the persisted
  // `applied` / `rejected` with no further fetch (the source card's pattern).
  const [status, setStatus] = useState<RecordProposal["status"]>(proposal.status);
  const [busy, setBusy] = useState(false);

  const { template } = readTrackerScenePayload(proposal.payload);
  const summaryFields = template === null ? [] : trackerSceneSummaryFields(template);

  async function runResolve(decision: "apply" | "reject"): Promise<void> {
    if (busy || status !== "pending") return;
    setBusy(true);
    try {
      const resolved =
        decision === "apply"
          ? await applyTrackerSceneProposal(threadId, proposal.id)
          : await rejectTrackerSceneProposal(threadId, proposal.id);
      setStatus(resolved.proposal.status);
      // 2026-11 remount-resurrection guard: the live feed's cached copy of
      // this proposal is now stale — hand the final row to the host.
      onResolved?.(resolved.proposal);
      if (decision === "apply" && resolved.proposal.status === "applied") {
        // Fresh id through `getState()`: render closures hold the pre-action
        // state (the frontend-skill rule). The refetch lands the chat's new
        // scene tracker config in the snapshot; the setup is already
        // persisted, so a refetch failure is swallowed.
        const chatId = useSnapshotStore.getState().activeChat?.id;
        if (chatId !== undefined && chatId !== null) {
          try {
            await fetchChatAction(brandId<ChatId>(chatId));
          } catch {
            /* the setup is already persisted — the tracker refreshes on the next load */
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
      data-testid="tracker-scene-proposal-card"
      data-record-type={proposal.recordType}
      data-op={proposal.op}
      data-status={status}
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface px-2.5 py-2"
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-px shrink-0 leading-[1.45] text-t3"><Icons.layoutList /></span>
        <span className="min-w-0 flex-1 self-center font-ui text-[calc(var(--ui-fs)-1px)] font-medium leading-snug text-t2">
          {t("agent.tracker_scene_proposal.title")}
        </span>
        <span data-testid="tracker-scene-proposal-status" className={statusChipClass(status)}>
          {status === "pending"
            ? t("agent.tracker_scene_proposal.status_pending")
            : status === "applied"
              ? t("agent.tracker_scene_proposal.status_applied")
              : t("agent.tracker_scene_proposal.status_rejected")}
        </span>
      </div>

      {/* The summary's field names are MODEL text (the generated schema's
          labels/keys) — page-translatable, like the source card's payload
          rows; the prefix and the buttons are chrome. */}
      {status === "pending" && summaryFields.length > 0 && (
        <div
          data-testid="tracker-scene-proposal-summary"
          translate="yes"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-3px)] text-t3"
        >
          {t("agent.tracker_scene_proposal.summary_prefix", { fields: summaryFields.join(", ") })}
        </div>
      )}

      {status === "applied" ? (
        <>
          <div
            data-testid="tracker-scene-applied-line"
            className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] text-t3"
          >
            {t("agent.tracker_scene_proposal.applied_line")}
          </div>
          <div
            data-testid="tracker-scene-save-hint"
            className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-3px)] text-t4"
          >
            {t("agent.tracker_scene_proposal.save_hint", {
              action: t("insights_template_save_as_character"),
            })}
          </div>
        </>
      ) : null}

      {status === "pending" && template !== null ? (
        <>
          {/* The mock §6 preview box around the SHARED preview — the scene
              part only (the parse pinned `objective: null`). */}
          <div
            data-testid="tracker-scene-proposal-preview"
            className="rounded-[5px] border border-border bg-bg px-2 py-1.5"
          >
            <TrackerTemplateSchemaPreview template={template} />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="tracker-scene-proposal-accept"
              disabled={busy}
              onClick={() => void runResolve("apply")}
              className="rounded-md border-0 bg-accent px-4 py-1.5 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
            >
              {t("agent.record_proposal.accept")}
            </button>
            <button
              type="button"
              data-testid="tracker-scene-proposal-reject"
              disabled={busy}
              onClick={() => void runResolve("reject")}
              className="rounded-md border border-border bg-bg px-3.5 py-1.5 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t2 transition-all hover:bg-s2 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
            >
              {t("coauthor.review.reject")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
