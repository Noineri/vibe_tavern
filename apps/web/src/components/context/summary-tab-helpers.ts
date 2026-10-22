import type { ChatSummaryRecord } from "../../api/types.js";

/** Maps the editor's history-limit state to display state. `null` (or a
 *  non-positive persisted value — the DB stores 0 = unlimited, consumed
 *  server-side as `limit || Infinity`) is the LATCHED/auto state: every
 *  message goes in and the slider thumb rides the branch's full length. A
 *  positive number is a manual cap, displayed clamped to the branch's real
 *  message count (a fork can shrink the branch below the persisted cap).
 *  count<=0 (the switchChat clearMessages dip) floors to 1 so the slider
 *  never renders a value below its own min. */
export function resolveHistoryLimitState(
  limit: number | null,
  messageCount: number,
): { latched: boolean; displayLimit: number } {
  const max = Math.max(1, messageCount);
  if (limit === null || limit <= 0) return { latched: true, displayLimit: max };
  return { latched: false, displayLimit: Math.min(limit, max) };
}

export function upsertSummary(list: ChatSummaryRecord[], summary: ChatSummaryRecord): ChatSummaryRecord[] {
  const idx = list.findIndex((item) => item.id === summary.id);
  if (idx < 0) return [...list, summary].sort((a, b) => a.summarizedFrom - b.summarizedFrom || a.createdAt.localeCompare(b.createdAt));
  const next = [...list];
  next[idx] = summary;
  return next;
}
