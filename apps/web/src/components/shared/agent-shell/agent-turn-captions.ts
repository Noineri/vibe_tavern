import type { OrderedCopilotMessage } from "../../../lib/copilot-context.js";

/**
 * The per-turn caption fold for the agent feed (AP-29 follow-up).
 *
 * AP-28 stores a turn's model reasoning on the FIRST assistant row a request
 * writes — but one visible turn (user row → next user row) can hold two or
 * more reasoning-carrying rows: an ask answer starts a new request WITHOUT a
 * user row, so the continuation's reasoning lands on a later row of the SAME
 * turn. The caption must carry ALL of it, in order, as one block.
 *
 * Pure: no React, no store reads. The list feeds it the already-computed
 * anchor sets (TA-1 anchoring is untouched — this module only decides where
 * the caption sits relative to those anchors) and renders what it returns.
 */

/** One assistant row's kept-reasoning contribution, in turn order. */
export interface TurnReasoningPart {
  reasoning: string;
  reasoningDurationMs: number | null;
}

/** The caption's kept-reasoning block — null reasoning = the bare title. */
export interface TurnCaption {
  reasoning: string | null;
  reasoningDurationMs: number | null;
}

/**
 * Join every assistant row's reasoning in one visible turn, in order,
 * separated by a blank line; the durations sum (null when none of the rows
 * carries a duration). Null when no row carries reasoning — the turn shows
 * no toggle.
 */
export function joinTurnReasoning(parts: readonly TurnReasoningPart[]): TurnCaption | null {
  const texts: string[] = [];
  let durationMs = 0;
  let hasDuration = false;
  for (const part of parts) {
    if (part.reasoning.trim().length === 0) continue;
    texts.push(part.reasoning);
    if (part.reasoningDurationMs !== null && part.reasoningDurationMs !== undefined) {
      durationMs += part.reasoningDurationMs;
      hasDuration = true;
    }
  }
  if (texts.length === 0) return null;
  return { reasoning: texts.join("\n\n"), reasoningDurationMs: hasDuration ? durationMs : null };
}

export interface TurnCaptionLayout {
  /** Caption rendered immediately BEFORE the anchored items + bubble of the
   *  keyed flow message (the turn's first rendered item lives at that key —
   *  its tool accordion, an ask / permission / proposal card, or its first
   *  text, whichever comes first). */
  captionBefore: Map<string, TurnCaption>;
  /** Caption for the trailing tool group (no following flow message) —
   *  rendered above it. */
  trailingCaption: TurnCaption | null;
  /** Where the LAST turn's caption sits (`"trailing"` for the trailing
   *  group, null when it earns none) — the live continuation joins there. */
  lastTurnSlotId: string | "trailing" | null;
  /** Whether the last turn earns a caption (visible text OR kept reasoning). */
  lastTurnEarnsCaption: boolean;
}

/**
 * One caption per assistant turn, at the top of the turn. Turns are delimited
 * by user rows (the same boundary the TA-1 anchor pass uses); digest rows
 * never split a turn. A turn earns the caption when it has visible text OR
 * kept reasoning — so a tools-only turn with reasoning keeps its caption
 * after it lands, and a turn with neither keeps none.
 */
export function buildTurnCaptions(args: {
  visibleMessages: readonly OrderedCopilotMessage[];
  anchoredIds: ReadonlySet<string>;
  hasTrailingAnchors: boolean;
}): TurnCaptionLayout {
  const { visibleMessages, anchoredIds, hasTrailingAnchors } = args;
  const captionBefore = new Map<string, TurnCaption>();
  let trailingCaption: TurnCaption | null = null;
  // Split the ordered flow at user rows — the user row OPENS the next turn,
  // so anchors keyed at it belong to the PREVIOUS turn's trailing tools.
  const openers: (string | null)[] = [];
  const members: OrderedCopilotMessage[][] = [];
  let opener: string | null = null;
  let current: OrderedCopilotMessage[] = [];
  let started = false;
  for (const entry of visibleMessages) {
    if (entry.message.role === "user") {
      if (started) {
        openers.push(opener);
        members.push(current);
      }
      opener = entry.message.id;
      current = [];
      started = true;
      continue;
    }
    current.push(entry);
    started = true;
  }
  if (started) {
    openers.push(opener);
    members.push(current);
  }
  let lastTurnSlotId: string | "trailing" | null = null;
  let lastTurnEarnsCaption = false;
  for (let i = 0; i < members.length; i++) {
    const turnMembers = members[i]!;
    const rows = turnMembers.filter((entry) => entry.message.role === "assistant");
    const parts: TurnReasoningPart[] = [];
    for (const row of rows) {
      const reasoning = row.message.reasoning;
      if (reasoning !== null && reasoning !== undefined && reasoning.trim().length > 0) {
        parts.push({ reasoning, reasoningDurationMs: row.message.reasoningDurationMs ?? null });
      }
    }
    const hasVisibleText = rows.some((row) => row.message.content.trim().length > 0);
    const earns = hasVisibleText || parts.length > 0;
    const isLast = i === members.length - 1;
    if (isLast) lastTurnEarnsCaption = earns;
    if (!earns) continue;
    const joined = joinTurnReasoning(parts);
    const caption: TurnCaption = {
      reasoning: joined?.reasoning ?? null,
      reasoningDurationMs: joined?.reasoningDurationMs ?? null,
    };
    let slot: string | "trailing" | null = null;
    for (const entry of turnMembers) {
      if (entry.message.role !== "assistant") continue;
      if (anchoredIds.has(entry.message.id) || entry.message.content.trim().length > 0) {
        slot = entry.message.id;
        break;
      }
    }
    if (slot === null) {
      // No anchored/text item inside the turn: the turn's tools sit at the
      // next opener (previous turn's trailing tools) or trail at the list
      // end; a reasoning-only carrier with no tools falls back to its own
      // (null-rendering) row, so the toggle still has a site.
      const nextOpener: string | null = i + 1 < openers.length ? (openers[i + 1] ?? null) : null;
      if (nextOpener !== null && anchoredIds.has(nextOpener)) {
        slot = nextOpener;
      } else if (isLast && hasTrailingAnchors) {
        slot = "trailing";
      } else {
        slot = rows[0]?.message.id ?? null;
      }
    }
    if (slot === null) continue;
    if (slot === "trailing") trailingCaption = caption;
    else captionBefore.set(slot, caption);
    if (isLast) lastTurnSlotId = slot;
  }
  return { captionBefore, trailingCaption, lastTurnSlotId, lastTurnEarnsCaption };
}

/**
 * Fold one live reasoning delta into the persisted caption it streams into
 * (the ask-answer continuation joins the turn it continues — the same
 * blank-line join; the live delta carries no duration, so the sum is
 * unchanged and the handover swaps no chrome).
 */
export function withLiveReasoning(base: TurnCaption | undefined, liveReasoning: string): TurnCaption {
  const baseText = base?.reasoning?.trim() ? base.reasoning : null;
  return {
    reasoning: baseText !== null ? `${baseText}\n\n${liveReasoning}` : liveReasoning,
    reasoningDurationMs: base?.reasoningDurationMs ?? null,
  };
}
