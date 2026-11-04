/**
 * The agent feed render-unit model + window partition (AFP-3,
 * AGENT_FEED_PERFORMANCE_PLAN Wave 1 step 4).
 *
 * Two pure derivations over the memoized `AgentFeedModel`:
 *
 *  1. `agentFeedRenderUnits` — the COMPLETE ordered list of virtual render
 *     items for everything the feed currently shows: event separators,
 *     captions, tool/ask/permission/proposal cards, message and digest rows,
 *     the pending user row, the live caption / reasoning rows, live feed
 *     rows, the pending assistant block and the turn-failure card — each
 *     with a NAMESPACED stable unit id (`msg:…`, `event:…`, `card:…`,
 *     `caption:…`, …) so React/Virtuoso keys survive refetch-shaped
 *     rerenders and history prepends alike. Null-rendering carriers
 *     (assistant rows that exist only to carry `toolCallsJson`) produce NO
 *     unit — they are never zero-height virtual items — while the cards and
 *     captions anchored at them keep their slot (their tool/caption
 *     semantics are preserved, not dropped).
 *
 *  2. `partitionAgentFeedWindow` — the split the shared
 *     `message-scroller-core.tsx` (AFP-2) consumes: a virtualized older
 *     prefix plus a mounted stable tail. Unlike the RP
 *     `partitionMessageRenderWindow` (whose page grid is anchored to the
 *     ARRAY start), the agent suffix is anchored in STABLE APPEND
 *     COORDINATES: every item's coordinate is its position in the full
 *     append stream (`firstItemIndex + arrayIndex`), and tail membership is
 *     a page-aligned coordinate window measured back from the newest head.
 *     Prepending older history never changes existing items' coordinates or
 *     the head — so the suffix is NEVER repartitioned by a prepend (the
 *     plan's withdrawn page-50 probe: array-relative math moved the suffix
 *     start m100 → m110 after a 50-row prepend; this math pins it).
 *
 * This module models ALL loaded render items — it is NOT a history slice.
 * Landing unused-by-design (AFP-5/AFP-6 thread it into the real list);
 * tested in isolation here.
 *
 * Pure — no React, no store reads.
 */
import type { AgentThreadEventWire, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import type { AgentToolActivity } from "../../../stores/agent-turn-store.js";
import { MESSAGE_PAGE_SIZE, STABLE_TAIL_PAGES } from "../../chat/message-render-window.js";
import type { CopilotTurnAnchorItem } from "./agent-anchor-items.js";
import type { AgentFeedModel } from "./agent-feed-model.js";

// ─── Render units ────────────────────────────────────────────────────────────

export type AgentFeedCardKind = "accordion" | "ask" | "permission" | "proposal";

/** One virtual render item. `unitId` is the Virtuoso/React key — namespaced
 *  per kind so ids from different sources never collide. */
export type AgentFeedRenderUnit =
  | { kind: "event"; unitId: string; event: AgentThreadEventWire }
  | { kind: "caption"; unitId: string; slotId: string }
  | { kind: AgentFeedCardKind; unitId: string; anchorId: string; item: CopilotTurnAnchorItem }
  | { kind: "message"; unitId: string; message: ExperienceCopilotMessageWire }
  | { kind: "digest"; unitId: string; message: ExperienceCopilotMessageWire; coveredCount: number | null }
  | { kind: "pending-user"; unitId: string }
  | { kind: "live-caption"; unitId: string }
  | { kind: "live-reasoning"; unitId: string }
  | { kind: "live"; unitId: string; row: AgentFeedLiveRow }
  | { kind: "pending-assistant"; unitId: string }
  | { kind: "failure"; unitId: string };

/** Fixed unit ids for the singleton tail rows (stable keys — these rows
 *  appear at most once and carry no data identity of their own). */
export const AGENT_FEED_PENDING_USER_UNIT_ID = "pending-user";
export const AGENT_FEED_LIVE_CAPTION_UNIT_ID = "live-caption";
export const AGENT_FEED_LIVE_REASONING_UNIT_ID = "live-reasoning";
export const AGENT_FEED_PENDING_ASSISTANT_UNIT_ID = "pending-assistant";
export const AGENT_FEED_FAILURE_UNIT_ID = "turn-failure";

/** One rendered row of the live feed section (the caller resolves which
 *  live entries render; this descriptor only carries kind + stable id). */
export interface AgentFeedLiveRow {
  kind: "accordion" | "ask" | "permission" | "proposal" | "text";
  /** Stable identity: the activity's toolCallId for cards/the accordion,
   *  the live feed entry id for text segments. */
  id: string;
  /** Text segments only: the segment is still streaming (AFP-6 streams the
   *  open segment; closed segments render as settled history). */
  streaming?: boolean;
}

/** The post-history tail the list renders mid-turn. Every flag mirrors one
 *  decision `AgentMessageList` already makes (CA-4e3 pending-user content
 *  rule, the AP-29 fresh-turn caption rule, the no-title fallback row, the
 *  bare pending block when the live feed is empty, the AP-13 failure card)
 *  — the caller keeps owning those rules; the window only orders the rows. */
export interface AgentFeedLiveTailInput {
  /** The optimistic pending user row (before the persisted row lands). */
  hasPendingUser?: boolean;
  /** The hoisted live-turn caption row (fresh turn, host has a title). */
  hasLiveCaption?: boolean;
  /** The fallback no-title live reasoning row (unknown host kinds). */
  hasLiveReasoningRow?: boolean;
  /** Ordered live feed rows (cards at their activity ids, ONE accordion,
   *  text segments at their entry ids). */
  liveRows?: readonly AgentFeedLiveRow[];
  /** The bare streaming assistant block (pending text, empty live feed). */
  hasPendingAssistant?: boolean;
  /** The turn-failure card at the feed end. */
  hasFailure?: boolean;
}

export interface AgentFeedWindowInput {
  model: AgentFeedModel;
  /** Mid-turn tail rows (absent = history only). */
  tail?: AgentFeedLiveTailInput;
  /** Flow message ids whose whole fragment hides (AP-29 regenerate: the
   *  caller folds the in-flight flag AND the recorded id set into one id
   *  set — a hidden anchor's message, cards, caption and anchored event
   *  separators all drop together, exactly like the list's fragment cut). */
  hiddenMessageIds?: ReadonlySet<string>;
  /** Hide the trailing tool group and its caption with the replaced turn
   *  (the list's `hideActive` trailing half). Trailing EVENTS never hide —
   *  they are history, not turn content (AFP-1 pin 3). */
  hideTrailingAnchors?: boolean;
}

/**
 * True for a null-rendering carrier: an assistant row with no visible text
 * that exists only to carry `toolCallsJson`. Such rows render no unit — but
 * they still anchor cards/captions (the anchor pass keys them like any
 * flow message), so their cluster keeps its slot.
 */
export function isNullCarrierMessage(message: ExperienceCopilotMessageWire): boolean {
  return message.role === "assistant" && message.content.trim().length === 0
    && message.toolCallsJson !== null && (message.attachments?.length ?? 0) === 0;
}

// ─── Stable unit-id builders (AFP-4) ────────────────────────────────────────
// The ONE derivation of the unit-id key shapes, shared by the render model
// below and the AFP-4 row-state consumers (separators, accordions, captions,
// message drafts) — a second hand-written `card:accordion:…` template in a
// consumer is a defect from copy #2.

export const agentFeedEventUnitId = (eventId: string): string => `event:${eventId}`;
export const agentFeedMessageUnitId = (messageId: string): string => `msg:${messageId}`;
export const agentFeedCaptionUnitId = (slotId: string): string => `caption:${slotId}`;
export const agentFeedAccordionUnitId = (toolCallId: string): string => `card:accordion:${toolCallId}`;

function cardUnitId(item: CopilotTurnAnchorItem): string {
  if (item.kind === "accordion") return agentFeedAccordionUnitId(item.activities[0]!.toolCallId);
  return `card:${item.kind}:${item.activity.toolCallId}`;
}

/**
 * Build the full ordered render-unit list — the document order the flat
 * list produces today (the AFP-1 composite pin), one unit per visual row.
 */
export function agentFeedRenderUnits(input: AgentFeedWindowInput): AgentFeedRenderUnit[] {
  const { model, tail, hiddenMessageIds, hideTrailingAnchors } = input;
  const units: AgentFeedRenderUnit[] = [];

  for (const entry of model.visibleMessages) {
    const message = entry.message;
    const hidden = hiddenMessageIds !== undefined && hiddenMessageIds.has(message.id);
    if (!hidden) {
      // SC-19b: anchored events render immediately BEFORE their anchor —
      // before its caption, cards and bubble alike (the list renders them
      // first inside the anchor's fragment).
      const anchoredEvents = model.eventAnchors.get(message.id);
      if (anchoredEvents !== undefined) {
        for (const event of anchoredEvents) {
          units.push({ kind: "event", unitId: agentFeedEventUnitId(event.id), event });
        }
      }
      // AP-4: the turn caption sits above the slot's first rendered item.
      if (model.captions.captionBefore.has(message.id)) {
        units.push({ kind: "caption", unitId: agentFeedCaptionUnitId(message.id), slotId: message.id });
      }
      // TA-1: the slot's card cluster, in accumulation order.
      const anchors = model.anchorItems.get(message.id);
      if (anchors !== undefined) {
        for (const item of anchors) {
          units.push({ kind: item.kind, unitId: cardUnitId(item), anchorId: message.id, item });
        }
      }
    }
    if (message.role === "digest") {
      if (!hidden) {
        units.push({ kind: "digest", unitId: agentFeedMessageUnitId(message.id), message, coveredCount: entry.coveredCount });
      }
      continue;
    }
    // Match the block's body gate, including empty non-carrier messages: none
    // may become a zero-height virtual item. Attachment-only bodies stay real.
    if (message.content.trim().length === 0 && (message.attachments?.length ?? 0) === 0) continue;
    if (!hidden) {
      units.push({ kind: "message", unitId: agentFeedMessageUnitId(message.id), message });
    }
  }

  // The trailing tool group (and its caption) — hides with the replaced
  // turn when `hideTrailingAnchors`; trailing EVENTS never hide.
  if (!hideTrailingAnchors) {
    if (model.captions.trailingCaption !== null) {
      units.push({ kind: "caption", unitId: "caption:trailing", slotId: "trailing" });
    }
    for (const item of model.trailingItems) {
      units.push({ kind: item.kind, unitId: cardUnitId(item), anchorId: "trailing", item });
    }
  }
  for (const event of model.trailingEvents) {
    units.push({ kind: "event", unitId: `event:${event.id}`, event });
  }

  // The mid-turn tail, in the flat list's fixed order: optimistic user row,
  // hoisted live caption / fallback reasoning row, live feed rows, bare
  // pending block, failure card.
  if (tail !== undefined) {
    if (tail.hasPendingUser) {
      units.push({ kind: "pending-user", unitId: AGENT_FEED_PENDING_USER_UNIT_ID });
    }
    if (tail.hasLiveCaption) {
      units.push({ kind: "live-caption", unitId: AGENT_FEED_LIVE_CAPTION_UNIT_ID });
    }
    if (tail.hasLiveReasoningRow) {
      units.push({ kind: "live-reasoning", unitId: AGENT_FEED_LIVE_REASONING_UNIT_ID });
    }
    for (const row of tail.liveRows ?? []) {
      const unitId = row.kind === "text" ? `live:${row.id}` : `live:${row.kind}:${row.id}`;
      units.push({ kind: "live", unitId, row });
    }
    if (tail.hasPendingAssistant) {
      units.push({ kind: "pending-assistant", unitId: AGENT_FEED_PENDING_ASSISTANT_UNIT_ID });
    }
    if (tail.hasFailure) {
      units.push({ kind: "failure", unitId: AGENT_FEED_FAILURE_UNIT_ID });
    }
  }

  return units;
}

/** The Virtuoso `data` array for the unit list (stable ids, one per row). */
export function agentFeedUnitIds(units: readonly AgentFeedRenderUnit[]): string[] {
  return units.map((unit) => unit.unitId);
}

// ─── Window partition (stable append coordinates) ────────────────────────────

export interface AgentFeedWindowOptions {
  /** Page size for the coordinate grid (default: the shared RP page, 20). */
  pageSize?: number;
  /** Pages kept mounted in the stable tail (default: the shared 5 pages). */
  tailPages?: number;
}

/** The partition `MessageScrollerCore` consumes. */
export interface AgentFeedWindow {
  /** Older units owned by the virtualizer. */
  virtualizedUnits: AgentFeedRenderUnit[];
  /** Recent units that stay mounted below the virtualized history. */
  stableTailUnits: AgentFeedRenderUnit[];
  /** Array index (into the input units) of the first stable-tail unit. */
  stableTailStartIndex: number;
  /** The append coordinate of `virtualizedUnits[0]` — the core's
   *  `firstItemIndex` (inverse-scroll passthrough). Drops by exactly the
   *  count of prepended units when older history pages arrive. */
  firstItemIndex: number;
}

/**
 * Split the render units into a virtualized prefix and a mounted stable
 * tail, anchored in STABLE APPEND COORDINATES.
 *
 * An item at array index `i` has coordinate `firstItemIndex + i`. The tail
 * is the page-aligned coordinate window `[tailStartCoord, headCoordinate)`
 * where `headCoordinate = firstItemIndex + units.length` — i.e. measured
 * back from the NEWEST head, aligned to the absolute page grid. Because
 * prepends assign lower coordinates to the new items only (existing items
 * and the head keep theirs), tail membership is invariant under prepend:
 * the suffix never repartitiones from total array length (the plan's
 * m100 → m110 defect). Appends push the head forward and retire the oldest
 * tail page — the intended RP behavior, unchanged.
 */
export function partitionAgentFeedWindow(
  units: readonly AgentFeedRenderUnit[],
  firstItemIndex: number,
  options: AgentFeedWindowOptions = {},
): AgentFeedWindow {
  const pageSize = options.pageSize ?? MESSAGE_PAGE_SIZE;
  const tailSize = (options.tailPages ?? STABLE_TAIL_PAGES) * pageSize;
  const headCoordinate = firstItemIndex + units.length;
  // Page-align (toward -inf, so the grid is absolute) then clamp to the
  // loaded start: a short feed keeps everything mounted.
  const rawTailStart = headCoordinate - tailSize;
  const alignedTailStart = Math.floor(rawTailStart / pageSize) * pageSize;
  const tailStartCoordinate = Math.max(firstItemIndex, alignedTailStart);
  const stableTailStartIndex = tailStartCoordinate - firstItemIndex;
  return {
    virtualizedUnits: units.slice(0, stableTailStartIndex),
    stableTailUnits: units.slice(stableTailStartIndex),
    stableTailStartIndex,
    firstItemIndex,
  };
}
