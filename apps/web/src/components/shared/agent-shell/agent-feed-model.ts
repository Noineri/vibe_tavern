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
 * The folds were moved from AgentMessageList (TA-1 / AP-4 / AP-33 / SC-19b);
 * AFP-6 makes this their single implementation, consumed by the real list.
 *
 * Pure — no React, no store reads at call time (`extractHistoricalTurnActivities`
 * is a pure wire→activity derivation exported by the turn store module).
 *
 * The anchor pass also owns lastHistoryActivityId for permission interactivity;
 * it follows raw message order and excludes activities owned by the live feed.
 */
import type { AgentFeedEventSummary, AgentThreadEventWire, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import type { AgentFeedWindow } from "./agent-feed-reconcile.js";
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
  /** Covered windows; each disjoint interval retains its own event/turn end. */
  windows?: readonly AgentFeedWindow[];
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
  trailingSlotId?: string;
  segments?: AgentFeedModel[];
  summaryEventAnchors: Map<string, AgentFeedEventSummary[]>;
  trailingSummaryEvents: AgentFeedEventSummary[];
  atThreadHead: boolean;
  lastHistoryActivityId: string | null;
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
  if (input.windows) {
    const segments = input.windows.map(window => buildWindowModel({ ...input, messages: window.messages, events: EMPTY_AGENT_FEED_EVENTS }, window));
    const base = segments.at(-1) ?? buildWindowModel(input);
    const visibleMessages = segments.flatMap(s => s.visibleMessages);
    const lastBoundary = input.windows.at(-1)?.boundary;
    const combinedBoundary = lastBoundary?.pageFacts ? { ...lastBoundary, pageFacts: { ...lastBoundary.pageFacts,
      messagePositions: input.windows.flatMap(w => w.boundary.pageFacts?.messagePositions ?? []),
    } } : lastBoundary;
    return { ...base, segments, visibleMessages,
      boundaries: agentFlowBoundaries(visibleMessages, combinedBoundary),
      anchorItems: new Map(segments.flatMap(s => [...s.anchorItems])),
      anchoredIds: new Set(segments.flatMap(s => [...s.anchoredIds])),
      captions: { ...base.captions, captionBefore: new Map(segments.flatMap(s => [
        ...s.captions.captionBefore,
        ...(s.trailingSlotId && s.captions.trailingCaption ? [[s.trailingSlotId, s.captions.trailingCaption] as const] : []),
      ])), stateKeys: new Map(segments.flatMap(s => [...s.captions.stateKeys])) },
      summaryEventAnchors: new Map(), trailingSummaryEvents: [],
    };
  }
  return buildWindowModel(input);
}

function buildWindowModel(input: AgentFeedModelInput, window?: AgentFeedWindow): AgentFeedModel {
  const { messages, events, liveToolCallIds } = input;

  // History tool activities (the CD-1 persisted audit cards), deduped by
  // toolCallId — verbatim from the list's `historyActivities` fold.
  const historyActivities = new Map<string, AgentToolActivity>();
  // Feed the SAME persisted parser compact call carriers for split pairs;
  // these context-only rows never enter the visible/history arrays.
  const carriers = window?.boundary.continuedToolCalls.flatMap(call => {
    const first = messages[0];
    return first && call.toolName ? [{ ...first, id: `context:${call.toolCallId}`, role: "assistant" as const, content: "",
      toolCallsJson: JSON.stringify([{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: {} }]) }] : [];
  }) ?? [];
  for (const turn of extractHistoricalTurnActivities([...carriers, ...messages])) {
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
  let lastHistoryActivityId: string | null = null;
  for (const m of messages) {
    if (m.role === "tool") {
      const activity = historyActivities.get(m.toolCallId ?? m.id);
      if (!activity || liveToolCallIds.has(activity.toolCallId)) continue;
      lastHistoryActivityId = activity.toolCallId;
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

  const visibleMessages = orderMessagesWithDigests(messages, window?.boundary.pageFacts
    ? new Map(window.boundary.pageFacts.digestCounts.map(d => [d.id, d.coveredCount])) : undefined);
  const boundaries = agentFlowBoundaries(visibleMessages, window?.boundary);

  // AP-4 caption fold — needs the anchored ids and the trailing flag.
  const anchoredIds = new Set<string>();
  for (const [id, items] of anchor) if (items.length > 0) anchoredIds.add(id);
  const captions = buildTurnCaptions({
    visibleMessages,
    anchoredIds,
    hasTrailingAnchors: pending.length > 0,
    continuedTurnOpener: window?.boundary.startsMidTurn ? window.boundary.turnOpenerMessageId : undefined,
  });

  // SC-19b event anchoring — anchored before the anchor row; null/unknown
  // anchors trail (the group lives in `agent-event-anchors.ts`).
  const { eventAnchors, trailingEvents } = agentEventAnchors(
    events,
    new Set(visibleMessages.map((entry) => entry.message.id)),
  );
  const summaries = agentEventAnchors(window?.events ?? [], new Set(visibleMessages.map(e => e.message.id)), messages.map(m => m.id));
  const trailingSlotId = window ? `trailing:${captions.stateKeys.get("trailing") ?? window.oldest.id}` : undefined;
  if (trailingSlotId) captions.stateKeys.set(trailingSlotId, captions.stateKeys.get("trailing") ?? trailingSlotId);
  if (trailingSlotId && captions.lastTurnSlotId === "trailing") captions.lastTurnSlotId = trailingSlotId;

  return {
    trailingSlotId,
    atThreadHead: !(window?.hasNewer ?? false),
    summaryEventAnchors: summaries.eventAnchors,
    trailingSummaryEvents: summaries.trailingEvents,
    lastHistoryActivityId,
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
  windows?: readonly AgentFeedWindow[];
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
      slot.windows === input.windows &&
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
    windows: input.windows,
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
