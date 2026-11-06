/**
 * Lorebook header token total (LC-5, LONG_CHAT_PERFORMANCE_REPORT step 5).
 *
 * Owner ruling 2026-10-30: the total is the SUM of per-entry counts — not one
 * encode of the joined contents — so countTokens' LRU (utils/tokenizer.ts)
 * makes an entries change re-encode only the entries whose content changed.
 * The header label stays an estimate. This is the ONE derivation of the
 * total (LorebookAccordion renders it; there is no second cache or counter).
 */
import type { LoreEntryRecord } from "../../../api/types.js";
import { countTokens } from "../../../utils/tokenizer.js";

/** Sum of the per-entry cached counts; empty book → 0. */
export function sumLoreEntryTokens(entries: LoreEntryRecord[]): number {
	if (entries.length === 0) return 0;
	return entries.reduce((sum, e) => sum + countTokens(e.content), 0);
}

/** Compact token count: 999 → "999", 1200 → "1.2k", 1500000 → "1.5M". */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
