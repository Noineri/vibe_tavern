/**
 * Tokenizer service — maps model names to real tokenizers.
 *
 * Uses:
 * - js-tiktoken for OpenAI models (GPT-4, GPT-4o, etc.)
 * - @agnai/web-tokenizers for Claude, Llama3, Mistral, Qwen2, DeepSeek, GLM, etc.
 * - cl100k_base (GPT-4 tokenizer) as universal fallback for prompt token counting only
 *
 * TC-2 (TOKEN_COUNT_ONCE_PLAN): below the provider-exact layer, every count
 * goes through the layered cache — per-tokenizer memory LRU → persistent
 * token_counts store → encode + write-through — so a text is encoded at
 * most once per tokenizer per process (and read, not encoded, after a
 * restart once the store backfill lands).
 */

import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getEncoding, type Tiktoken, type TiktokenEncoding } from "js-tiktoken";
import { Tokenizer as WebTokenizer } from "@agnai/web-tokenizers";
import { activeProviderTokenContext, readExactTokenCount } from "./token-count-cache.js";

// ── cl100k_base fallback ─────────────────────────────────────────────────
// Used when the model name doesn't match any known tokenizer family.
// cl100k_base is the GPT-4 tokenizer — reasonably accurate for all languages
// and far better than byte-based estimation.

// ── Paths ────────────────────────────────────────────────────────────────

export async function resolveTokenizerDir(): Promise<string> {
	const candidates = [
		process.env.VIBE_TAVERN_TOKENIZER_DIR,
		// Standalone artifact: tokenizers next to executable.
		join(resolve(process.execPath, ".."), "tokenizers"),
		// API artifacts: Bun.build flat output or tsc module output.
		join(import.meta.dir, "tokenizers"),
		join(import.meta.dir, "..", "tokenizers"),
		// Source tree (dev mode — no copy step required).
		resolve(import.meta.dir, "..", "..", "..", "assets", "tokenizers"),
		join(process.cwd(), "services", "api", "assets", "tokenizers"),
		// Copied runtime assets in build output.
		resolve(import.meta.dir, "..", "..", "..", "..", "out", "services", "api", "tokenizers"),
		join(process.cwd(), "out", "services", "api", "tokenizers"),
	].filter(Boolean) as string[];

	for (const dir of candidates) {
		if (await Bun.file(join(dir, "claude.json")).exists()) {
			return dir;
		}
	}

	return candidates[candidates.length - 1];
}

let TOKENIZER_DIR: string | undefined;

async function ensureTokenizerDir(): Promise<string> {
	if (!TOKENIZER_DIR) {
		TOKENIZER_DIR = await resolveTokenizerDir();
	}
	return TOKENIZER_DIR;
}

// ── Tokenizer caches (lazy singletons) ──────────────────────────────────

const tiktokenCache = new Map<string, Tiktoken>();
const webTokenizerCache = new Map<string, WebTokenizer>();

function getTiktoken(encoding: string): Tiktoken {
	let instance = tiktokenCache.get(encoding);
	if (instance) return instance;
	instance = getEncoding(encoding as TiktokenEncoding);
	tiktokenCache.set(encoding, instance);
	return instance;
}

async function getWebTokenizer(file: string): Promise<WebTokenizer> {
	let instance = webTokenizerCache.get(file);
	if (instance) return instance;
	const dir = await ensureTokenizerDir();
	const buf = await Bun.file(join(dir, file)).arrayBuffer();
	instance = await WebTokenizer.fromJSON(buf);
	webTokenizerCache.set(file, instance);
	return instance;
}

// ── Model → tokenizer mapping ───────────────────────────────────────────

type TokenizerFamily =
	| { type: "tiktoken"; encoding: string }
	| { type: "web"; file: string }
	| { type: "fallback" };

const OPENAI_TIKTOKEN: Array<[RegExp, string]> = [
	[/^o[134]/, "o200k_base"],
	[/^gpt-5/, "o200k_base"],
	[/^gpt-4\.?1/, "o200k_base"],
	[/^gpt-4\.?5/, "o200k_base"],
	[/^gpt-4o/, "o200k_base"],
	[/^chatgpt-4o/, "o200k_base"],
	[/^gpt-4-32k/, "cl100k_base"],
	[/^gpt-4/, "cl100k_base"],
	[/^gpt-3\.5-turbo-0301/, "p50k_base"],
	[/^gpt-3\.5-turbo/, "cl100k_base"],
	[/^gpt-3\.5/, "cl100k_base"],
];

const WEB_TOKENIZERS: Array<[RegExp, string]> = [
	[/claude/, "claude.json"],
	[/command-a/, "command-a.json"],
	[/command-r/, "command-r.json"],
	[/glm|zai-|z-ai/, "glm-4.6.json"],
	[/deepseek/, "deepseek.json"],
	[/mimo/, "mimo.json"],
	[/qwen/, "qwen2.json"],
	[/mistral-nemo|open-mistral-nemo|nemo/, "nemo.json"],
	[/mistral|mixtral|codestral|ministral|magistral/, "mistral.json"],
	[/llama[-_]?3|llama/, "llama3.json"],
	[/gemini|gemma/, "llama3.json"],
	[/yi[-_]/, "llama3.json"],
	[/jamba/, "llama3.json"],
	[/phi/, "llama3.json"],
	[/hermes/, "llama3.json"],
	[/dolphin/, "llama3.json"],
	[/mythomax/, "llama3.json"],
	[/magnum/, "llama3.json"],
	[/anthracite/, "llama3.json"],
	[/toppy/, "llama3.json"],
	[/noromaid/, "llama3.json"],
	[/openchat/, "llama3.json"],
	[/nous/, "llama3.json"],
];

function resolveTokenizerFamily(model: string): TokenizerFamily {
	const m = model.toLowerCase();

	for (const [re, encoding] of OPENAI_TIKTOKEN) {
		if (re.test(m)) return { type: "tiktoken", encoding };
	}

	for (const [re, file] of WEB_TOKENIZERS) {
		if (re.test(m)) return { type: "web", file };
	}

	return { type: "fallback" };
}

// ── Tokenizer id resolution (TC-2) ──────────────────────────────────────

/** Id of the universal cl100k fallback — also countTokensDefault's tokenizer. */
const CL100K_TOKENIZER_ID = "tiktoken:cl100k_base";

/**
 * The tokenizer the ladder would ACTUALLY use for a model, resolved in one
 * place: the tiktoken encoding it maps to, the web file if that file is
 * already loaded, or the cl100k fallback when no model is given, nothing
 * matches, or the web file has not been warmed yet (the cold path counts
 * with cl100k until warmup loads the file — so does this resolution).
 */
type TokenizerRef =
	| { id: string; type: "tiktoken"; encoding: string }
	| { id: string; type: "web"; file: string }
	| { id: string; type: "fallback" };

function resolveTokenizerRef(model?: string): TokenizerRef {
	if (!model) return { id: CL100K_TOKENIZER_ID, type: "fallback" };
	const family = resolveTokenizerFamily(model);
	switch (family.type) {
		case "tiktoken":
			return { id: `tiktoken:${family.encoding}`, type: "tiktoken", encoding: family.encoding };
		case "web":
			return webTokenizerCache.has(family.file)
				? { id: `web:${family.file}`, type: "web", file: family.file }
				: { id: CL100K_TOKENIZER_ID, type: "fallback" };
		default:
			return { id: CL100K_TOKENIZER_ID, type: "fallback" };
	}
}

/**
 * The id of the tokenizer countTokens would actually use for `model` —
 * e.g. "tiktoken:o200k_base", "web:llama3.json". ONE derivation: the
 * layered-cache keys, the persistent token_counts rows and the history
 * separator-side table (Wave 2) all read THIS id, never a second copy.
 */
export function resolveTokenizerId(model?: string): string {
	return resolveTokenizerRef(model).id;
}

// ── Layered count cache (TC-2) ──────────────────────────────────────────
// A token count is deterministic per (exact text, tokenizer), so below the
// provider-exact layer every count is memoized: per-tokenizer memory LRU
// (the hot layer, the same discipline as the browser's LC-5 cache) →
// persistent token_counts store (survives restarts) → encode + write-
// through to both. countTokens stays synchronous by contract, so the store
// participates asynchronously: a memory miss schedules a non-blocking store
// read that backfills the memory LRU when it lands (a stored row overwrites
// the encoded value — they are equal by determinism); the CURRENT call
// always answers with the encode.

/**
 * The persistent-count seam injected at server boot. Structural on purpose:
 * TC-1's TokenCountStore satisfies it; unit tests and tools inject a fake
 * or run without one (the layer is then skipped — memory-only).
 */
export interface PersistentTokenCountStore {
	get(textHash: string, tokenizer: string): Promise<{ tokenCount: number } | null>;
	putMany(
		rows: ReadonlyArray<{ textHash: string; tokenizer: string; tokenCount: number }>,
	): Promise<void>;
}

interface LayerTunables {
	/** Max cached texts per tokenizer id. */
	maxEntriesPerTokenizer: number;
	/** Max total cached text length (UTF-16 units) per tokenizer id. */
	maxTotalCharsPerTokenizer: number;
}

const DEFAULT_LAYER_TUNABLES: LayerTunables = {
	// Same bounds as the browser's LC-5 cache (apps/web/src/utils/tokenizer.ts):
	// a chat's stable tail plus prompt/lorebook churn fits with room to age
	// out; per-tokenizer so switching models never evicts another model's
	// counts.
	maxEntriesPerTokenizer: 1_000,
	maxTotalCharsPerTokenizer: 2_000_000,
};

/**
 * Texts above this length are cached in MEMORY ONLY, never persisted —
 * joined prompt blocks would grow the table unboundedly; the memory layer
 * still dedups the hot ones.
 */
const PERSIST_MAX_TEXT_CHARS = 100_000;

const layerTunables: LayerTunables = { ...DEFAULT_LAYER_TUNABLES };
const layerStats = { encodes: 0, storeReads: 0, storeReadHits: 0, storeWrites: 0 };

/** tokenizerId → (exact text → count). Never a concatenated key string. */
const perTokenizerCache = new Map<string, Map<string, number>>();
const perTokenizerChars = new Map<string, number>();

let persistentStore: PersistentTokenCountStore | null = null;

/**
 * In-flight store reads deduped per (tokenizer, hash). Internal key format —
 * NOT the store's composite key (that derivation stays in token-count-store).
 */
const inflightReads = new Set<string>();
let pendingStoreReads = 0;
const storeReadIdleWaiters: Array<() => void> = [];
/** Bumped by the test reset so reads scheduled before it cannot repopulate cleared state. */
let readGeneration = 0;

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Memory read; a hit re-inserts the key on the most-recent side (LRU touch). */
function layerLookup(tokenizerId: string, text: string): number | undefined {
	const inner = perTokenizerCache.get(tokenizerId);
	if (!inner) return undefined;
	const hit = inner.get(text);
	if (hit === undefined) return undefined;
	inner.delete(text);
	inner.set(text, hit);
	return hit;
}

/**
 * Memory write; evicts from the least-recent side until BOTH bounds hold
 * (LC-5 discipline — the keys ARE the texts, so the char cap is the memory
 * cap). A single text larger than the whole bound is never cached.
 */
function layerStore(tokenizerId: string, text: string, count: number): void {
	if (text.length > layerTunables.maxTotalCharsPerTokenizer) return;
	let inner = perTokenizerCache.get(tokenizerId);
	if (!inner) {
		inner = new Map();
		perTokenizerCache.set(tokenizerId, inner);
		perTokenizerChars.set(tokenizerId, 0);
	}
	if (!inner.has(text)) {
		perTokenizerChars.set(tokenizerId, (perTokenizerChars.get(tokenizerId) ?? 0) + text.length);
	}
	inner.delete(text);
	inner.set(text, count);
	let chars = perTokenizerChars.get(tokenizerId) ?? 0;
	while (
		inner.size > 0 &&
		(inner.size > layerTunables.maxEntriesPerTokenizer ||
			chars > layerTunables.maxTotalCharsPerTokenizer)
	) {
		const oldest = inner.keys().next().value;
		if (oldest === undefined) break;
		inner.delete(oldest);
		chars -= oldest.length;
	}
	perTokenizerChars.set(tokenizerId, Math.max(chars, 0));
}

function scheduleStoreRead(tokenizerId: string, text: string, hash: string): void {
	const store = persistentStore;
	if (!store) return;
	const inflightKey = `${tokenizerId}\u0000${hash}`;
	if (inflightReads.has(inflightKey)) return;
	inflightReads.add(inflightKey);
	layerStats.storeReads++;
	pendingStoreReads++;
	const generation = readGeneration;
	store
		.get(hash, tokenizerId)
		.then((row) => {
			if (row === null || generation !== readGeneration) return;
			layerStats.storeReadHits++;
			// Overwrite, not write-if-absent: a stored row and a fresh encode
		// are equal by determinism, and overwriting is what makes store
			// routing observable in the tests.
			layerStore(tokenizerId, text, row.tokenCount);
		})
		.catch(() => {
			// A failed store read is non-fatal — counting keeps working through
			// the encode path, and the next miss schedules a fresh read.
		})
		.finally(() => {
			inflightReads.delete(inflightKey);
			pendingStoreReads--;
			if (pendingStoreReads === 0) {
				for (const resolve of storeReadIdleWaiters.splice(0)) resolve();
			}
		});
}

function writeThroughStore(tokenizerId: string, hash: string, count: number): void {
	const store = persistentStore;
	if (!store) return;
	layerStats.storeWrites++;
	void store
		.putMany([{ textHash: hash, tokenizer: tokenizerId, tokenCount: count }])
		.catch(() => {
			// Persistence is best-effort: a failed write only costs a later
			// re-encode after a restart, never a wrong count.
		});
}

/**
 * The TC-2 layering for one (tokenizer, text): memory LRU read → (async
 * store backfill scheduled on a miss) → encode → write-through. `encode`
 * runs at most once per (text, tokenizer) while the entry stays cached.
 */
function countViaLayer(tokenizerId: string, text: string, encode: () => number): number {
	const hit = layerLookup(tokenizerId, text);
	if (hit !== undefined) return hit;
	const hash = text.length <= PERSIST_MAX_TEXT_CHARS ? sha256Hex(text) : null;
	if (hash !== null) scheduleStoreRead(tokenizerId, text, hash);
	layerStats.encodes++;
	const count = encode();
	layerStore(tokenizerId, text, count);
	if (hash !== null) writeThroughStore(tokenizerId, hash, count);
	return count;
}

/** Inject the persistent token_counts store (server boot). `null` un-injects. */
export function setPersistentTokenCountStore(store: PersistentTokenCountStore | null): void {
	persistentStore = store;
}

/** Test/observability seam: resolves when every scheduled store read has settled. Never rejects. */
export function waitForTokenCountReadIdle(): Promise<void> {
	if (pendingStoreReads === 0) return Promise.resolve();
	return new Promise((resolve) => storeReadIdleWaiters.push(resolve));
}

/** Spy seam: layer activity since the last reset (encode/store touch counts). */
export function getTokenCountLayerStatsForTests(): typeof layerStats {
	return { ...layerStats };
}

/** Override cache bounds (tests: eviction at small limits). */
export function configureTokenCountLayerForTests(tunables: Partial<LayerTunables>): void {
	Object.assign(layerTunables, tunables);
}

/**
 * Drop every cached count, restore default bounds and invalidate in-flight
 * store reads (test isolation — this file's process is shared).
 */
export function resetTokenCountLayerForTests(): void {
	perTokenizerCache.clear();
	perTokenizerChars.clear();
	inflightReads.clear();
	layerStats.encodes = 0;
	layerStats.storeReads = 0;
	layerStats.storeReadHits = 0;
	layerStats.storeWrites = 0;
	readGeneration++;
	Object.assign(layerTunables, DEFAULT_LAYER_TUNABLES);
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Count tokens for a string. Synchronous (web-tokenizers are pre-loaded).
 * Falls back to byte estimation if no model or tokenizer fails.
 *
 * LS-1b: when a provider token context is in scope (set by the send/preview
 * orchestrator via `runWithProviderTokenContext`), a cached backend-exact
 * count wins; on a miss the local ladder below runs and a bounded background
 * warm fetch is scheduled. See `token-count-cache.ts` for the mechanic.
 *
 * TC-2: below that provider-exact layer, counts go through the layered
 * cache — memory LRU → (async) persistent store → encode + write-through.
 * The returned number is always exactly what the ladder encoded.
 */
export function countTokens(text: string, model?: string): number {
	if (!text) return 0;

	const providerCtx = activeProviderTokenContext();
	if (providerCtx) {
		const exact = readExactTokenCount(text, providerCtx);
		if (exact !== null) return exact;
		// Miss → local ladder below; the warm pass fills the cache for next turn.
	}

	const ref = resolveTokenizerRef(model);
	try {
		if (ref.type === "tiktoken") {
			return countViaLayer(ref.id, text, () => getTiktoken(ref.encoding).encode(text).length);
		}
		if (ref.type === "web") {
			const tokenizer = webTokenizerCache.get(ref.file);
			if (tokenizer) {
				return countViaLayer(ref.id, text, () => tokenizer.encode(text).length);
			}
		}
	} catch {
		// ignore — fallback below
	}

	// No model, an unknown model, a not-yet-loaded web tokenizer, or a failed
	// family encode — the cl100k default, exactly as before the cache existed.
	return countTokensDefault(text);
}

/**
 * Count tokens using cl100k_base (GPT-4 class tokenizer).
 * Good universal default for prompt pipeline — much more accurate than
 * byte estimation for all languages, even for non-OpenAI models.
 */
export function countTokensDefault(text: string): number {
	if (!text) return 0;
	try {
		return countViaLayer(CL100K_TOKENIZER_ID, text, () =>
			getTiktoken("cl100k_base").encode(text).length,
		);
	} catch {
		// cl100k_base failed (shouldn't happen) — rough char-based estimate
		return Math.ceil(text.length / 4);
	}
}

export interface TokenizedToken {
	id: number;
	text: string;
}

/**
 * Tokenize text into individual tokens with their IDs and text representations.
 * Uses cl100k_base (GPT-4 class) tokenizer as the default.
 */
export function tokenizeText(text: string, model?: string): TokenizedToken[] {
	if (!text) return [];

	try {
		const family = model ? resolveTokenizerFamily(model) : null;

		if (family?.type === "tiktoken") {
			const enc = getTiktoken(family.encoding);
			const ids = Array.from(enc.encode(text));
			return ids.map((id) => {
				const decoded = enc.decode([id]);
				return { id, text: typeof decoded === "string" ? decoded : Buffer.from(decoded).toString() };
			});
		}

		if (family?.type === "web") {
			const cached = webTokenizerCache.get(family.file);
			if (cached) {
				const ids = Array.from(cached.encode(text));
				return ids.map((id) => {
					const bytes = cached.decode(Int32Array.from([id]));
					return { id, text: Buffer.from(bytes).toString() };
				});
			}
		}

		// Fallback to cl100k_base
		const enc = getTiktoken("cl100k_base");
		const ids = Array.from(enc.encode(text));
		return ids.map((id) => {
			const decoded = enc.decode([id]);
			return { id, text: typeof decoded === "string" ? decoded : Buffer.from(decoded).toString() };
		});
	} catch {
		return [];
	}
}

/**
 * Count tokens using cl100k_base (GPT-4 class tokenizer).
 * Good universal default for prompt pipeline — much more accurate than
 * byte estimation for all languages, even for non-OpenAI models.
 */

/**
 * Pre-load all web-tokenizer models so countTokens() can stay synchronous.
 * Call once at server startup.
 */
export async function warmupTokenizers(): Promise<void> {
	const files = new Set(WEB_TOKENIZERS.map(([, f]) => f));
	for (const file of files) {
		try {
			await getWebTokenizer(file);
		} catch (e) {
			console.warn(`[tokenizer] Failed to load ${file}:`, e instanceof Error ? e.message : e);
		}
	}
	console.info(`[tokenizer] Warmed up ${tiktokenCache.size + webTokenizerCache.size} tokenizer(s)`);
}

/**
 * Count tokens for an array of chat messages (role + content).
 */
export function countMessageTokens(
	messages: Array<{ role: string; content: string }>,
	model?: string,
): number {
	const overhead = 4;
	let total = 0;
	for (const msg of messages) {
		total += overhead + countTokens(msg.content, model);
	}
	total += 3; // priming tokens
	return total;
}
