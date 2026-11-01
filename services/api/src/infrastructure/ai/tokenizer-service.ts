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
 * most once per tokenizer per process, and after a restart (or any memory
 * eviction) it is READ from the store, never re-encoded (TC-8: the store
 * is consulted synchronously before the encode decision).
 */

import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getEncoding, type Tiktoken, type TiktokenEncoding } from "js-tiktoken";
import { Tokenizer as WebTokenizer } from "@agnai/web-tokenizers";
import type { SeparatorSide } from "@vibe-tavern/prompt-pipeline";
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

/** Test seam: drop the warmed web tokenizers so a file can pin the COLD path
 * (fallback ids, pre-warmup counts) on demand. "Fresh process" cannot be
 * assumed from file order: a workspace's test files share ONE process and
 * discovery order is readdir-order on Linux CI vs alphabetical on Windows
 * dev — on 2026-11-01 a server-runtime-importing file warmed the cache before
 * tokenizer-service.test.ts ran, flipping its cold-path pins. */
export function resetWebTokenizerCacheForTests(): void {
	webTokenizerCache.clear();
}

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

// ── History separator side (TC-3) ──────────────────────────────────────
// Which side of a history piece the "\n\n" separator merges into for a
// tokenizer — i.e. the side on which the per-message decomposition equals
// the joined count TO THE TOKEN. EXPLICIT ids only, one row per fixture
// rail in services/api/test/tokenizer-side-exactness.test.ts; never a
// blanket "every tiktoken encoding" rule (p50k_base disproved that
// generalization: it binds BEFORE like claude, unlike cl100k/o200k). Every
// unlisted tokenizer (qwen2, glm-4.6, deepseek, mimo, nemo, mistral —
// measured to have NO exact side — command-r, command-a, …) resolves to
// null → the pipeline keeps the joined count, exact by construction.

/** The measured separator side per tokenizer id; ids without a row are null. */
const SEPARATOR_SIDES: Readonly<Record<string, SeparatorSide>> = {
	// tiktoken BPE merges the separator into the END of the preceding piece.
	"tiktoken:cl100k_base": "after",
	"tiktoken:o200k_base": "after",
	// GPT-2-style BPE: the separator merges into the START of the following
	// piece (claude-style), unlike cl100k/o200k above.
	"tiktoken:p50k_base": "before",
	"web:llama3.json": "after",
	"web:claude.json": "before",
};

/**
 * The measured separator side for a tokenizer id (TC-3): "after" | "before"
 * for the ids the fixture-exactness suite pins, null for every other
 * tokenizer (joined counting). Callers resolve the id through
 * {@link resolveTokenizerId} — never a second id derivation.
 */
export function separatorSide(tokenizerId: string): SeparatorSide | null {
	return SEPARATOR_SIDES[tokenizerId] ?? null;
}

// ── Layered count cache (TC-2, TC-8) ──────────────────────────────
// A token count is deterministic per (exact text, tokenizer), so below the
// provider-exact layer every count is memoized: per-tokenizer memory LRU
// (the hot layer, the same discipline as the browser's LC-5 cache) →
// persistent token_counts store (survives restarts) → encode + write-
// through to both. The store is consulted SYNCHRONOUSLY on every memory
// miss, BEFORE the encode decision (TC-8): a hit answers with the stored
// count and populates the LRU, so a text is encoded at most once per
// tokenizer across restarts. (TC-2's first cut scheduled the store read
// asynchronously and always encoded on the miss — measured by TC-7 to
// re-encode an entire long-chat snapshot on every pass.)

/**
 * The persistent-count seam injected at server boot. Structural on purpose:
 * TC-1's TokenCountStore satisfies it; unit tests and tools inject a fake
 * or run without one (the layer is then skipped — memory-only). `getSync`
 * is synchronous because the counting path is synchronous by contract and
 * the underlying bun:sqlite read always was (see the store's getSync note).
 */
export interface PersistentTokenCountStore {
	getSync(textHash: string, tokenizer: string): { tokenCount: number } | null;
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
	// Same entry bound as the browser's LC-5 cache (apps/web/src/utils/tokenizer.ts):
	// a chat's stable tail plus prompt/lorebook churn fits with room to age
	// out; per-tokenizer so switching models never evicts another model's
	// counts. The chars bound is deliberately 4× the browser's 2 000 000
	// (TC-8): TC-7 measured one long-chat snapshot pass at 813 texts /
	// ~2.5 M chars, so a 2 M-char server LRU evicted the pass's own head
	// before its tail arrived and every pass re-encoded everything; 8 M
	// holds the whole pass (~16 MB of strings worst case — trivial
	// server-side).
	maxEntriesPerTokenizer: 1_000,
	maxTotalCharsPerTokenizer: 8_000_000,
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

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * The persistence key hash for an exact text — ONE derivation (TC-2's
 * hashing, exported for the TC-6 backfill and the tests, never a second
 * copy): sha256 hex, or null when the text exceeds the persistence cutoff
 * (such texts are memory-only by design and are never stored).
 */
export function tokenCountTextHash(text: string): string | null {
	return text.length <= PERSIST_MAX_TEXT_CHARS ? sha256Hex(text) : null;
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
 * The TC-2/TC-8 layering for one (tokenizer, text): memory LRU read →
 * SYNCHRONOUS persistent-store read → encode → write-through. `encode` runs
 * at most once per (text, tokenizer) while the row stays stored — a store
 * hit answers directly AND populates the LRU, so even an evicted entry is
 * read back, never re-encoded.
 */
function countViaLayer(tokenizerId: string, text: string, encode: () => number): number {
	const hit = layerLookup(tokenizerId, text);
	if (hit !== undefined) return hit;
	const hash = tokenCountTextHash(text);
	const store = persistentStore;
	if (hash !== null && store) {
		layerStats.storeReads++;
		let row: { tokenCount: number } | null = null;
		try {
			row = store.getSync(hash, tokenizerId);
		} catch {
			// A failed store read is non-fatal — counting falls through to the
			// encode path, and the next miss consults the store again.
		}
		if (row !== null) {
			layerStats.storeReadHits++;
			layerStore(tokenizerId, text, row.tokenCount);
			return row.tokenCount;
		}
	}
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

/** Spy seam: layer activity since the last reset (encode/store touch counts). */
export function getTokenCountLayerStatsForTests(): typeof layerStats {
	return { ...layerStats };
}

/** Override cache bounds (tests: eviction at small limits). */
export function configureTokenCountLayerForTests(tunables: Partial<LayerTunables>): void {
	Object.assign(layerTunables, tunables);
}

/**
 * Drop every cached count, reset the activity counters and restore default
 * bounds (test isolation — this file's process is shared).
 */
export function resetTokenCountLayerForTests(): void {
	perTokenizerCache.clear();
	perTokenizerChars.clear();
	layerStats.encodes = 0;
	layerStats.storeReads = 0;
	layerStats.storeReadHits = 0;
	layerStats.storeWrites = 0;
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
 * TC-2/TC-8: below that provider-exact layer, counts go through the layered
 * cache — memory LRU → persistent store (synchronous) → encode +
 * write-through. The returned number is always exactly what the ladder
 * encoded (or what the store holds — equal by determinism).
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
