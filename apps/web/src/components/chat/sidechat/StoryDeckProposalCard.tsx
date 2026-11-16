/**
 * StoryDeckProposalCard (DIRECTOR_DECK_CALENDAR_PLAN DK-8, mockup §4) — the
 * review card for a sidechat `propose_deck` record proposal
 * (`recordType: "story-deck"`), registered as
 * `recordProposalRenderers["story-deck"]` in the sidechat host. The proposal
 * payload is the tool's validated card set (`sidechatDeckProposalInputSchema`
 * — the cards parse here through the contracts' `storyDeckSchema`, the ONE
 * wire shape source) plus an optional one-line summary. Accept resolves
 * through the SC-13c route — the registry's story-deck handler appends the
 * cards to the branch deck with FRESH ids; Reject writes the status only.
 * The director never writes the deck itself.
 *
 * fork #4 of ObjectiveProposalCard.tsx
 * (`apps/web/src/components/chat/sidechat/ObjectiveProposalCard.tsx —
 * `forks: 4` there, updated in the same commit`; #1 StoryPlanProposalCard
 * (DR-10a) is the structural reference for the title-bearing header, #2
 * TrackerSceneProposalCard (DR-10b), #3 DirectorMessageProposalCard
 * (DMT-33)). Correspondence map (frame + resolve machine cloned, body
 * specialized for the deck payload):
 * 1. Root card container → the source's flex-column card chrome verbatim
 *    (own `story-deck-proposal-card` testid + live `data-status`).
 * 2. Header row (icon + title + status chip) → the plan card's
 *    title-bearing header shape; the icon is mock §4's deck glyph
 *    (`Ic.cards` — the deck tab's own seal), the title reuses the deck
 *    tab's own key (`story_deck_title` — one copy, many consumers), and the
 *    chip is the status-TINTED twin reusing the plan card's chip keys —
 *    byte-identical to mock §4 (pending accent, applied success, rejected
 *    muted; no duplicate copy).
 * 3. Payload body → the model's summary (translate="yes" — model text, the
 *    source's description-row shape) plus the proposed cards as a fan of
 *    `StoryCardFace size="sm"` (the 96×134 compact face, mock §4 — the
 *    suits render through the ONE `STORY_CARD_SUIT_META` derivation inside
 *    the face): desktop wraps, the phone scrolls horizontally (CSS-only
 *    dual-mode, `max-md:flex-nowrap max-md:overflow-x-auto`; the faces are
 *    `shrink-0` so the lane scrolls instead of shrinking).
 * 4. Footer button pair → the source's Accept/Reject pair verbatim
 *    (composed classes — CF13); the accept label is new
 *    (`agent.story_deck_proposal.accept`), the reject reuses
 *    `coauthor.review.reject` (mock §4's own reject wording — the
 *    existing shared key, no duplicate copy).
 * 5. Resolved states → mock §4's two lines (applied / rejected), no summary,
 *    no fan, no buttons; the stored status seeds the card, so a reload
 *    renders them with no fetch (the plan card's reload contract).
 *
 * Named deviations from the source:
 * - D1: no tracker-off gate — the deck apply never touches the tracker (the
 *   registry's story-deck handler writes only the deck store), so Accept
 *   stays enabled while pending and only the already-resolved 409 is
 *   handled (the plan card's D6 rule).
 * - D2: a successful Accept re-runs the branch's deck GET through
 *   `refreshStoryDeck` (the DK-6 cache seam — the curtain's deck tab learns
 *   the new cards; never a second fetch path) and does NOT refetch the chat
 *   (the source's `fetchChatAction` — the deck is not chat-row state; the
 *   handler writes no chat fields). Both ids read fresh: the branch is the
 *   proposal's own `targetId` (the payload-branch the apply wrote), the
 *   chat through `getState()` (render closures hold pre-action state).
 * - D3: resolved states hide the summary (mock §4's resolved card renders
 *   header + line only; the plan card keeps its summary visible).
 * - D4: the footer gates on the payload's parsed cards (the plan card's D7
 *   rule — an unshaped payload offers nothing to review, so Accept stays
 *   hidden instead of committing blind; the source renders its pair for
 *   every pending row).
 */

import { useState } from "react";
import { storyDeckSchema, type RecordProposal, type StoryCard } from "@vibe-tavern/api-contracts";
import { toast } from "sonner";
import type { RecordProposalCardProps } from "../../../lib/agent-host-registry.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import {
  applyObjectiveProposal,
  rejectObjectiveProposal,
  OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE,
  ObjectiveProposalApiError,
} from "../../../api/agent-thread-proposals-api.js";
import { refreshStoryDeck } from "../../../hooks/use-story-deck.js";
import { StoryCardFace } from "../../shared/agent-plan/StoryCard.js";
import { Ic } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";

/** The deck proposal's record type — the DR-5 dispatch table's `story-deck`
 *  key. The constant's home is the proposal domain
 *  (`services/api/.../sidechat-director-tools.ts` `STORY_DECK_RECORD_TYPE`),
 *  unreachable from the web app; this is the web-side pin of that wire
 *  string (the `STORY_PLAN_RECORD_TYPE` pattern — one spelling per side,
 *  documented against the source). The card's tests and the host's pin the
 *  string. */
export const STORY_DECK_RECORD_TYPE = "story-deck";

/** The deck payload contract (`propose_deck` tool input verbatim): at least
 *  one proposed twist card plus an optional one-line summary for the card. */
interface StoryDeckPayload {
  cards: StoryCard[];
  summary?: string;
}

/** Defensive narrow of the opaque proposal payload, the sibling cards'
 *  field-by-field discipline: the cards parse through the SAME contracts
 *  schema the wire deck validates against (`storyDeckSchema` — what the
 *  registry's parse gate admits), and an unshaped payload renders empty,
 *  never a throw. */
function readStoryDeckPayload(payload: unknown): StoryDeckPayload {
  if (typeof payload !== "object" || payload === null) return { cards: [] };
  const record = payload as Record<string, unknown>;
  const parsed = storyDeckSchema.safeParse({ cards: record.cards });
  const cards = parsed.success ? parsed.data.cards : [];
  const summary = typeof record.summary === "string" && record.summary !== "" ? record.summary : undefined;
  return summary === undefined ? { cards } : { cards, summary };
}

/** The status chip tint (mock §4: pending accent, applied success, rejected
 *  muted — the sibling cards' shared tint). */
function statusChipClass(status: RecordProposal["status"]): string {
  const tint =
    status === "applied"
      ? "bg-success-dim text-success-text"
      : status === "rejected"
        ? "bg-s2 text-t3"
        : "bg-accent/15 text-accent";
  return cn("shrink-0 rounded-full px-1.5 py-px font-ui text-[calc(var(--ui-fs)-4px)]", tint);
}

export function StoryDeckProposalCard({ proposal, threadId, onResolved }: RecordProposalCardProps) {
  const { t } = useT();
  // The stored status seeds the card: a reloaded thread renders the persisted
  // `applied` / `rejected` (the status rides the tool row — the DR-5 write).
  const [status, setStatus] = useState<RecordProposal["status"]>(proposal.status);
  const [busy, setBusy] = useState(false);

  const { cards, summary } = readStoryDeckPayload(proposal.payload);

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
        // D2: the branch deck's GET re-runs through the ONE cache seam so the
        // curtain's deck tab shows the new cards at once. Fresh ids through
        // `getState()` / the proposal's own target (render closures hold the
        // pre-action state — the frontend-skill rule); the registry requires
        // a string targetId for this record type, so either id missing is a
        // defensive skip (the deck still refreshes on the next load).
        const branchId = typeof proposal.targetId === "string" ? proposal.targetId : null;
        const chatId = useSnapshotStore.getState().activeChat?.id ?? null;
        if (chatId !== null && branchId !== null) {
          refreshStoryDeck(chatId, branchId);
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
      // app's existing error toast (sonner — the sibling cards' precedent,
      // their shared fallback key reused verbatim).
      toast.error(err instanceof Error ? err.message : t("agent.objective_proposal.request_failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="story-deck-proposal-card"
      data-record-type={proposal.recordType}
      data-op={proposal.op}
      data-status={status}
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface px-2.5 py-2"
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-px shrink-0 leading-[1.45] text-t3"><Ic.cards /></span>
        <span className="min-w-0 flex-1 self-center font-ui text-[calc(var(--ui-fs)-1px)] font-medium leading-snug text-t2">
          {t("story_deck_title")}
        </span>
        <span data-testid="story-deck-proposal-status" className={statusChipClass(status)}>
          {status === "pending"
            ? t("agent.story_plan_proposal.status_pending")
            : status === "applied"
              ? t("agent.story_plan_proposal.status_applied")
              : t("agent.story_plan_proposal.status_rejected")}
        </span>
      </div>

      {status === "pending" ? (
        <>
          {/* The proposed twists are MODEL text — page-translatable (the
              sibling cards' rule); the chip and buttons are chrome. */}
          {summary !== undefined && (
            <div
              data-testid="story-deck-proposal-summary"
              translate="yes"
              className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-3px)] text-t3"
            >
              {summary}
            </div>
          )}

          {/* The proposed cards' fan (mock §4): desktop wraps, the phone
              scrolls horizontally (the faces keep their 96×134 footprint). */}
          {cards.length > 0 && (
            <>
              <div
                data-testid="story-deck-proposal-fan"
                className="flex min-w-0 flex-wrap gap-1.5 max-md:flex-nowrap max-md:overflow-x-auto"
              >
                {cards.map((card) => (
                  <StoryCardFace key={card.id} card={card} size="sm" />
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="story-deck-proposal-accept"
                  disabled={busy}
                  onClick={() => void runResolve("apply")}
                  className="rounded-md border-0 bg-accent px-4 py-1.5 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
                >
                  {t("agent.story_deck_proposal.accept")}
                </button>
                <button
                  type="button"
                  data-testid="story-deck-proposal-reject"
                  disabled={busy}
                  onClick={() => void runResolve("reject")}
                  className="rounded-md border border-border bg-bg px-3.5 py-1.5 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t2 transition-all hover:bg-s2 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
                >
                  {t("coauthor.review.reject")}
                </button>
              </div>
            </>
          )}
        </>
      ) : status === "applied" ? (
        <div
          data-testid="story-deck-applied-line"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] text-t3"
        >
          {t("agent.story_deck_proposal.applied_line")}
        </div>
      ) : (
        <div
          data-testid="story-deck-rejected-line"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] text-t3"
        >
          {t("agent.story_deck_proposal.rejected_line")}
        </div>
      )}
    </div>
  );
}
