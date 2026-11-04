/**
 * The memoized agent feed model (AFP-3, AGENT_FEED_PERFORMANCE_PLAN Wave 1
 * step 5): every HISTORICAL fold `AgentMessageList.tsx` currently reruns per
 * render — digest ordering (`orderMessagesWithDigests`), flow boundaries,
 * the TA-1 tool-anchor pass, per-turn captions and SC-19b event anchoring —
 * gathered into ONE pure derivation over the loaded (messages, events) pair.
 *
 * LAG-3/AFP-3 contract: a live-text flush must NOT rerun any of these folds.
 * The model's inputs are exactly the data identities a rerender can change
 * (`messages`, `events`, `liveToolCallIds`); live stream text, reasoning,
 * pending rows and ask/permission overrides are NOT inputs and never reach
 * this module. Feed the memoized builder stable references
 * (`memoizedAgentFeedModel`) and the snapshot object survives every flush.
 *
 * The folds themselves are VERBATIM moves of the `useMemo` bodies in
 * `AgentMessageList.tsx` (TA-1 / AP-4 / AP-33 / SC-19b semantics — the
 * AFP-1 characterization suite pins their rendered output). The list port
 * (AFP-6) swaps its inline folds for this module; until then it lands
 * unused-by-design, tested in isolation.
 *
 * Pure — no React, no store reads at call time (`extractHistoricalTurnActivities`
 * is a pure wire→activity derivation exported by the turn store module).
 *
 * fork #1 of AgentMessageList.tsx — the `historyActivities` map and the
 * TA-1 anchor pass below are copies of the list's live inline `useMemo`
 * bodies (the two folds over `messages`, ~lines 226–295 there). The other
 * folds call the already-extracted shared modules (`orderMessagesWithDigests`,
 * `agent-flow-boundaries`, `agent-turn-captions`, `agent-event-anchors`) —
 * no fork, one derivation. The source keeps its originals until AFP-6
 * swaps the list onto this model and deletes both halves together.
 *
 * Named deviations from the source bodies:
 *  - the source's anchor fold also tracks `lastHistoryActivityId` (the
 *    thread's chronologically last history tool activity); omitted here —
 *    it is list state feeding the ask/permission interactivity rules, not
 *    a render fold (AFP-6 re-derives it from stores/activities as today).
 */
import type { AgentThreadEventWire, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import type { OrderedCopilotMessage } from "../../../lib/copilot-context.js";
import { orderMessagesWithDigests } from "../../../lib/copilot-context.js";
import type { AgentToolActivity } from "../../../stores/agent-turn-store.js";
import { extractHistoricalTurnActivities } from "../../../stores/agent-turn-store.js";
import { agentEventAnchors } from "./agent-event-anchors.js";
import { agentFlowBoundaries, type AgentFlowBoundaries } from "./agent-flow-boundaries.js";
import { recordProposalOf, type CopilotTurnAnchorItem } from "./agent-anchor-items.js";
import { buildTurnCaptions, type TurnCaptionLayout } from "./agent-turn-captions.js";

/** Stable empty event list — pass THIS (not a fresh `[]`) so the memoized
 *  builder sees a stable identity across renders. */
export const EMPTY_AGENT_FEED_EVENTS: readonly AgentThreadEventWire[] = [];

/** Stable empty live-tool set — pass THIS (not a fresh `new Set()`) so the
 *  memoized builder sees a stable identity across renders. */
export const EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS: ReadonlySet<string> = new Set<string>();

/** The model's full input. All three fields are compared BY REFERENCE by
 *  `memoizedAgentFeedModel` — callers must reuse array/set identities
 *  between renders (a `useMemo` or module constant per source). */
export interface AgentFeedModelInput {
  /** ALL loaded persisted messages (the full wire list — no slicing here;
   *  windowing is `agent-feed-window.ts`'s job, never a data cut). */
  messages: readonly ExperienceCopilotMessageWire[];
  /** The thread's frozen context events in merged-timeline order. */
  events: readonly AgentThreadEventWire[];
  /** Tool-call ids currently owned by the LIVE feed (post-settle dedupe:
   *  a history tool row whose id is live-owned renders nothing until the
   *  live feed clears). */
  liveToolCallIds: ReadonlySet<string>;
}

/** One memoized snapshot of every historical fold the feed renders from. */
export interface AgentFeedModel {
  /** Digest-ordered visible flow (CM-9 / AP-33): user/assistant/digest rows
   *  in list order, tool rows excluded, each digest at its own chronological
   *  slot with its covered-count caption. */
  visibleMessages: OrderedCopilotMessage[];
  /** The turn-row boundaries (AP-11 / AP-33) over `visibleMessages`. */
  boundaries: AgentFlowBoundaries;
  /** TA-1 anchored card clusters keyed by their anchor flow message id
   *  (the NEXT user/assistant row — null-rendering carriers included). */
  anchorItems: Map<string, CopilotTurnAnchorItem[]>;
  /** Tool/ask/permission/proposal items with no following flow message —
   *  rendered at the feed end, before trailing events. */
  trailingItems: CopilotTurnAnchorItem[];
  /** Anchors that carry at least one item (the caption fold's input). */
  anchoredIds: ReadonlySet<string>;
  /** SC-19b frozen-event separators keyed by their anchor message id. */
  eventAnchors: Map<string, AgentThreadEventWire[]>;
  /** Null-anchor and unknown-anchor events — trail after the flow rows. */
  trailingEvents: AgentThreadEventWire[];
  /** AP-4 one-caption-per-assistant-turn layout over the visible flow. */
  captions: TurnCaptionLayout;
}

/** Build the full historical model. Pure and synchronous; O(n) over the
 *  loaded list. Prefer `memoizedAgentFeedModel` at render sites. */
export function buildAgentFeedModel(input: AgentFeedModelInput): AgentFeedModel {
  const { messages, events, liveToolCallIds } = input;

  // History tool activities (the CD-1 persisted audit cards), deduped by
  // toolCallId — verbatim from the list's `historyActivities` fold.
  const historyActivities = new Map<string, AgentToolActivity>();
  for (const turn of extractHistoricalTurnActivities(messages)) {
    for (const activity of turn.activities) historyActivities.set(activity.toolCallId, activity);
  }

  // TA-1 anchor pass — verbatim from the list's fold: tool rows accumulate
  // into their turn's single accordion (ask / permission / proposal cards
  // stay separate, in place); the cluster anchors at the NEXT flow message
  // (user/assistant, carriers included — they render as null, so the
  // position is identical). A user row starts the next turn's group;
  // digest rows neither flush nor split a turn.
  const anchor = new Map<string, CopilotTurnAnchorItem[]>();
  let pending: CopilotTurnAnchorItem[] = [];
  let turnTools: AgentToolActivity[] | null = null;
  for (const m of messages) {
    if (m.role === "tool") {
      const activity = historyActivities.get(m.toolCallId ?? m.id);
      if (!activity || liveToolCallIds.has(activity.toolCallId)) continue;
      if (activity.ask) {
        pending.push({ kind: "ask", activity });
        continue;
      }
      if (activity.permission) {
        pending.push({ kind: "permission", activity });
        continue;
      }
      const proposal = recordProposalOf(activity);
      if (proposal !== undefined) {
        pending.push({ kind: "proposal", activity, proposal });
        continue;
      }
      if (!turnTools) {
        turnTools = [];
        pending.push({ kind: "accordion", activities: turnTools });
      }
      turnTools.push(activity);
      continue;
    }
    if (m.role === "user" || m.role === "assistant") {
      if (pending.length > 0) {
        anchor.set(m.id, pending);
        pending = [];
      }
      if (m.role === "user") turnTools = null;
    }
  }

  const visibleMessages = orderMessagesWithDigests(messages);
  const boundaries = agentFlowBoundaries(visibleMessages);

  // AP-4 caption fold — needs the anchored ids and the trailing flag.
  const anchoredIds = new Set<string>();
  for (const [id, items] of anchor) if (items.length > 0) anchoredIds.add(id);
  const captions = buildTurnCaptions({
    visibleMessages,
    anchoredIds,
    hasTrailingAnchors: pending.length > 0,
  });

  // SC-19b event anchoring — anchored before the anchor row; null/unknown
  // anchors trail (the group lives in `agent-event-anchors.ts`).
  const { eventAnchors, trailingEvents } = agentEventAnchors(
    events,
    new Set(visibleMessages.map((entry) => entry.message.id)),
  );

  return {
    visibleMessages,
    boundaries,
    anchorItems: anchor,
    trailingItems: pending,
    anchoredIds,
    eventAnchors,
    trailingEvents,
    captions,
  };
}

// ─── Memoization ─────────────────────────────────────────────────────────────
// A small identity-keyed cache: the feed calls the memoized builder every
// render; an unchanged (messages, events, liveToolCallIds) triple must
// return the SAME snapshot object so downstream consumers (the window pass,
// row derivations) keep their references across live-text flushes. A few
// slots so the sidechat, copilot and mini-app feeds can be alive at once
// without thrashing each other.

const MEMO_CAPACITY = 3;

interface AgentFeedModelMemoSlot {
  messages: readonly ExperienceCopilotMessageWire[];
  events: readonly AgentThreadEventWire[];
  liveToolCallIds: ReadonlySet<string>;
  model: AgentFeedModel;
}

const memoSlots: AgentFeedModelMemoSlot[] = [];

/**
 * `buildAgentFeedModel` behind a reference-identity cache (most-recent
 * first, `MEMO_CAPACITY` slots). Equal input references return the same
 * snapshot object — zero folds rerun; any changed reference rebuilds.
 * Callers must pass STABLE identities (the props arrays / a memoized Set),
 * not fresh literals per render.
 */
export function memoizedAgentFeedModel(input: AgentFeedModelInput): AgentFeedModel {
  for (let i = 0; i < memoSlots.length; i++) {
    const slot = memoSlots[i]!;
    if (
      slot.messages === input.messages &&
      slot.events === input.events &&
      slot.liveToolCallIds === input.liveToolCallIds
    ) {
      // Recency bump (most-recent-first keeps alternating feeds warm).
      memoSlots.splice(i, 1);
      memoSlots.unshift(slot);
      return slot.model;
    }
  }
  const model = buildAgentFeedModel(input);
  memoSlots.unshift({
    messages: input.messages,
    events: input.events,
    liveToolCallIds: input.liveToolCallIds,
    model,
  });
  if (memoSlots.length > MEMO_CAPACITY) memoSlots.length = MEMO_CAPACITY;
  return model;
}

/** Drop every memoized snapshot (test isolation — the cache is module
 *  state shared by every feed using this module). */
export function clearAgentFeedModelMemo(): void {
  memoSlots.length = 0;
}
