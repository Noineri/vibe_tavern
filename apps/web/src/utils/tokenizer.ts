/**
 * Shared tokenizer singleton for the frontend.
 * Uses cl100k_base (GPT-4 class) — same as backend's countTokensDefault().
 * Lazy-loaded on first use.
 *
 * Token count cache (LC-5, LONG_CHAT_PERFORMANCE_REPORT step 5): a message's
 * displayed count is a pure function of its displayed text, so countTokens
 * memoizes results in a bounded LRU keyed by the EXACT text — unchanged text
 * is a hit across remounts (chat open, branch switch, scrolling back into
 * virtualized history), changed text is a different key, stale keys age out.
 * Every consumer (useDisplayMessage, use-token-count, SummaryTab,
 * CoauthorTurnShell, attachment overflow, the lorebook total, the pending
 * user stub) calls countTokens and gets this cache for free — there is no
 * second cache anywhere.
 *
 * The encoder initialization shape below is deliberately unchanged (APP_LOAD
 * step 3 will swap the rank-table import and may lazily preload the table):
 * the cache wraps getTokenizer().encode, it does not touch the loader.
 */

import { getEncoding, type Tiktoken } from "js-tiktoken";

let instance: Tiktoken | null = null;

export function getTokenizer(): Tiktoken {
	if (!instance) {
		instance = getEncoding("cl100k_base");
	}
	return instance;
}

// ── Bounded LRU over encode() results ──────────────────────────────────────
// Sibling of markdown-result-cache.ts (LC-4): a JS Map's insertion order is
// the recency order (a hit re-inserts on the most-recent side); eviction
// walks the least-recent side until BOTH bounds hold — entry count AND total
// text size (UTF-16 code units; the keys ARE the texts, so the size cap is
// also the memory cap). Bounds sized for a lorebook of hundreds of entries
// plus two chat stable tails and the streaming/composer churn (every draft
// edit is a new key that must age out).
interface TokenCountCacheTunables {
	maxEntries: number;
	maxTotalChars: number;
}

const DEFAULT_TOKEN_COUNT_CACHE_TUNABLES: TokenCountCacheTunables = {
	maxEntries: 1_000,
	maxTotalChars: 2_000_000,
};

const tokenCountCacheTunables: TokenCountCacheTunables = { ...DEFAULT_TOKEN_COUNT_CACHE_TUNABLES };

const tokenCountCache = new Map<string, number>();
let tokenCountCacheChars = 0;

/** Cache read; a hit re-inserts the key on the most-recent side (LRU touch). */
function lookupTokenCount(text: string): number | undefined {
	const hit = tokenCountCache.get(text);
	if (hit === undefined) return undefined;
	tokenCountCache.delete(text);
	tokenCountCache.set(text, hit);
	return hit;
}

/** Cache write on a miss; evicts from the least-recent side until both bounds hold. */
function storeTokenCount(text: string, count: number): void {
	// A single text larger than the whole size bound is never cached (it
	// could only evict itself or everything else).
	if (text.length > tokenCountCacheTunables.maxTotalChars) return;
	tokenCountCache.set(text, count);
	tokenCountCacheChars += text.length;
	while (
		tokenCountCache.size > 0 &&
		(tokenCountCache.size > tokenCountCacheTunables.maxEntries ||
			tokenCountCacheChars > tokenCountCacheTunables.maxTotalChars)
	) {
		const oldest = tokenCountCache.keys().next().value;
		if (oldest === undefined) break;
		tokenCountCache.delete(oldest);
		tokenCountCacheChars -= oldest.length;
	}
}

export function countTokens(text: string): number {
	if (!text || typeof text !== "string") return 0;
	const cached = lookupTokenCount(text);
	if (cached !== undefined) return cached;
	const count = getTokenizer().encode(text).length;
	storeTokenCount(text, count);
	return count;
}

/** Override cache tunables (tests: eviction at small bounds). */
export function configureTokenCountCacheForTests(tunables: Partial<TokenCountCacheTunables>): void {
	Object.assign(tokenCountCacheTunables, tunables);
}

/** Drop every cached entry and restore the default tunables (test isolation). */
export function resetTokenCountCacheForTests(): void {
	tokenCountCache.clear();
	tokenCountCacheChars = 0;
	Object.assign(tokenCountCacheTunables, DEFAULT_TOKEN_COUNT_CACHE_TUNABLES);
}
