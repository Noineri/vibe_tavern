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
 *  - `orderMessagesWithDigests`: the digest placement + covered-count
 *    caption (CM-9, re-ruled by AP-33). The backend APPENDS a digest message
 *    at the END of the list — where the compaction ran — and stores the id of
 *    the FIRST KEPT message in the digest's `toolCallId` column (the boundary
 *    anchor). The UI keeps rendering the full history; each digest stays at
 *    its own chronological slot, after the rows that existed when the
 *    compaction ran (owner ruling: the separator sits where the compaction
 *    HAPPENED, not at the boundary it folded). This function keeps tool rows
 *    out of the rendered flow and, for each digest, derives the "covers N
 *    messages" caption count (flow messages between this digest's anchor and
 *    the previous digest's anchor — anchors only, never the digest's slot).
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
 * Order messages for rendering: the user/assistant flow in list order with
 * each compaction digest kept at its own chronological slot (AP-33 — where
 * the compaction ran; never moved to its anchor).
 *
 * The backend appends digests at the END of the flat message list
 * (append-only store) and records the FIRST KEPT message's id in the digest's
 * `toolCallId` column. Tool-role messages are NOT rendered by the list (their
 * activity is surfaced through the turn store), so they are excluded from
 * both the flow and the covered count — "covers N messages" counts the
 * user/assistant bubbles the card replaces. The count is derived from the
 * anchors alone: a digest covers the flow messages between its anchor and
 * the previous digest's anchor; a dangling anchor (id not found) degrades to
 * the flow's end, so its count still covers the whole remaining prefix —
 * never a wrong-side split (mirrors the backend's degradation).
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

  // Covered-count derivation (AP-33: UNCHANGED): resolve each digest's anchor
  // position in the flow (end when dangling), then stable-sort by ascending
  // anchor so "the previous digest" means the nearest smaller anchor. The
  // count never reads the digest's own slot — only the anchors.
  const positioned = digests
    .map((digest) => ({
      digest,
      anchorIdx: digest.toolCallId != null ? (flowIndex.get(digest.toolCallId) ?? flow.length) : flow.length,
    }))
    .sort((a, b) => a.anchorIdx - b.anchorIdx);
  const coveredByDigestId = new Map<string, number>();
  positioned.forEach((entry, i) => {
    const prevAnchor = i === 0 ? 0 : positioned[i - 1]!.anchorIdx;
    coveredByDigestId.set(entry.digest.id, Math.max(0, entry.anchorIdx - prevAnchor));
  });

  // AP-33: NO reorder — each digest renders at its own chronological slot
  // (the compaction moment), between the rows it was appended after. Only
  // tool rows drop out of the rendered flow.
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "digest")
    .map((message) => ({
      message,
      coveredCount: message.role === "digest" ? (coveredByDigestId.get(message.id) ?? null) : null,
    }));
}
