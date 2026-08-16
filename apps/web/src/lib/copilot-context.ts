/**
 * Copilot context meter + digest-ordering helpers (COPILOT_CONTEXT_METER_PLAN,
 * Wave 3 / CM-7 + CM-9).
 *
 * Pure — no React, no I/O, no store access. Two concerns live here because both
 * are "copilot context" math that is cheap to pin in isolation:
 *
 *  - `meterSegments` / `isMeterUrgent`: the segmented-context fractions the
 *    meter renders, and the 80% urgency flag that drives the compact button's
 *    glow. Both mirror the backend's own threshold exactly (the auto-compact
 *    gate uses `totalTokens >= 0.8 * budgetTokens`).
 *  - `orderMessagesWithDigests`: the CM-9 digest-card placement. The backend
 *    APPENDS a digest message at the END of the list and stores the id of the
 *    FIRST KEPT message in the digest's `toolCallId` column (the boundary
 *    anchor). The UI keeps rendering the full history, so a digest card must be
 *    moved to sit immediately BEFORE its anchor message — not left at end of
 *    list. This function does that reordering and, for each digest, derives the
 *    "covers N messages" caption count (flow messages between this digest's
 *    anchor and the previous digest's anchor).
 */

import type {
  ExperienceCopilotContextMetrics,
  ExperienceCopilotMessageWire,
} from "@vibe-tavern/api-contracts";

// ─── Meter fractions ─────────────────────────────────────────────────────────

/** Per-segment fractions of the context budget (each in [0, 1]). `usedTokens`
 *  is the raw sum of the three rendered segments (always the assembler's
 *  estimate); `totalTokens` (provider-measured when available) is what the
 *  urgency flag uses, matching the backend auto-compact gate. */
export interface MeterSegments {
  system: number;
  digest: number;
  history: number;
  reserve: number;
  usedTokens: number;
  budgetTokens: number;
  reserveTokens: number;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Segment fractions against `budgetTokens`, or null when unmetered (no metrics
 *  yet, or the effective profile has no explicit context budget — `budgetTokens
 *  === 0` means the meter renders an unmetered state, never a zero bar). */
export function meterSegments(
  metrics: ExperienceCopilotContextMetrics | null,
): MeterSegments | null {
  if (!metrics || metrics.budgetTokens <= 0) return null;
  const budget = metrics.budgetTokens;
  return {
    system: clamp01(metrics.systemTokens / budget),
    digest: clamp01(metrics.digestTokens / budget),
    history: clamp01(metrics.historyTokens / budget),
    reserve: clamp01(metrics.reserveTokens / budget),
    usedTokens: metrics.systemTokens + metrics.digestTokens + metrics.historyTokens,
    budgetTokens: budget,
    reserveTokens: metrics.reserveTokens,
  };
}

/** True when the thread has crossed the 80% auto-compact threshold. Mirrors the
 *  backend's `AUTO_COMPACT_THRESHOLD = 0.8` gate exactly (uses the provider
 *  `totalTokens` when available — `isMeterUrgent` should agree with whether the
 *  server would auto-compact). */
export function isMeterUrgent(metrics: ExperienceCopilotContextMetrics | null): boolean {
  if (!metrics || metrics.budgetTokens <= 0) return false;
  return metrics.totalTokens >= 0.8 * metrics.budgetTokens;
}

// ─── Digest ordering ─────────────────────────────────────────────────────────

/** One entry in the rendered message order. `coveredCount` is non-null only for
 *  digest entries: the number of flow (user/assistant) messages that digest
 *  covers — messages between its anchor and the previous digest's anchor. */
export interface OrderedCopilotMessage {
  message: ExperienceCopilotMessageWire;
  coveredCount: number | null;
}

/**
 * Order messages for rendering, moving each compaction digest to sit immediately
 * before its anchor message.
 *
 * The backend appends digests at the END of the flat message list (append-only
 * store) and records the FIRST KEPT message's id in the digest's `toolCallId`
 * column. Tool-role messages are NOT rendered by the list (their activity is
 * surfaced through the turn store), so they are excluded from both the flow and
 * the covered count — "covers N messages" counts the user/assistant bubbles the
 * card replaces.
 *
 * Dangling anchors (anchor id not found) degrade to end-of-list placement —
 * never a wrong-side split (mirrors the backend's no-drop degradation).
 */
export function orderMessagesWithDigests(
  messages: readonly ExperienceCopilotMessageWire[],
): OrderedCopilotMessage[] {
  const flow = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const digests = messages.filter((m) => m.role === "digest");

  if (digests.length === 0) {
    return flow.map((message) => ({ message, coveredCount: null }));
  }

  const flowIndex = new Map<string, number>();
  flow.forEach((m, i) => flowIndex.set(m.id, i));

  // Resolve each digest's anchor position in the flow (end when dangling), then
  // stable-sort by ascending anchor so earlier boundaries come first.
  const positioned = digests
    .map((digest) => ({
      digest,
      anchorIdx: digest.toolCallId != null ? (flowIndex.get(digest.toolCallId) ?? flow.length) : flow.length,
    }))
    .sort((a, b) => a.anchorIdx - b.anchorIdx);

  const result: OrderedCopilotMessage[] = [];
  let d = 0;
  // Iterate flow positions 0..flow.length inclusive; at position i emit any
  // digests anchored at i, then the flow message at i (when i < flow.length).
  for (let i = 0; i <= flow.length; i++) {
    while (d < positioned.length && positioned[d].anchorIdx === i) {
      const prevAnchor = d === 0 ? 0 : positioned[d - 1].anchorIdx;
      result.push({
        message: positioned[d].digest,
        coveredCount: Math.max(0, i - prevAnchor),
      });
      d++;
    }
    if (i < flow.length) {
      result.push({ message: flow[i], coveredCount: null });
    }
  }

  return result;
}
