/**
 * Tokenizer service — TOKEN_COUNT_ONCE_PLAN TC-2 characterization + cache
 * layer pins.
 *
 * Characterization (written BEFORE the TC-2 change, against the pre-change
 * code): the count matrix below pins today's exact numbers for a fixture
 * set (ASCII, Cyrillic, emoji, whitespace runs, a 30 000-char text) across
 * the model ladder (no model → cl100k default, gpt-4o → o200k_base,
 * gemini → llama3.json, claude → claude.json) plus countTokensDefault. The
 * layered cache (TC-2) must keep every one of these byte-identical.
 *
 * Cache layer pins (added with the TC-2 implementation): memory-LRU
 * per-tokenizer isolation, persistent-store routing through the injected
 * seam, the 100 000-char persistence cutoff, provider-exact precedence
 * over every local layer, and store-less (unit-test) operation.
 *
 * Process-sharing (services/api tests share one process): this file is the
 * ONLY warmer of the web tokenizers in the suite, so the pre-warmup pins
 * below are deterministic. Every injection this file makes (persistent
 * store, fetch stub) is restored in afterAll; every layer is reset between
 * tests.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import {
	countTokens,
	countTokensDefault,
	warmupTokenizers,
	resolveTokenizerId,
	setPersistentTokenCountStore,
	getTokenCountLayerStatsForTests,
	configureTokenCountLayerForTests,
	resetTokenCountLayerForTests,
	type PersistentTokenCountStore,
} from "../src/infrastructure/ai/tokenizer-service.js";
import {
	resetTokenCountCache,
	runWithProviderTokenContext,
	waitForTokenWarmIdle,
	type ProviderTokenContext,
} from "../src/infrastructure/ai/token-count-cache.js";

/** Deterministic long fixture: seed repeated, then "x"-padded to the exact length. */
function buildExactLength(seed: string, len: number): string {
	let out = "";
	while (out.length + seed.length <= len) out += seed;
	while (out.length < len) out += "x";
	return out;
}

const FIX_ASCII = "The quick brown fox jumps over the lazy dog.";
const FIX_CYRILLIC =
	"Привет! Как твои дела? Это проверка подсчёта токенов — кириллица, тире и многоточие…";
const FIX_EMOJI =
	"Emoji mix 🎭🔥👍🏽 with ZWJ family 👨‍👩‍👧‍👦 and a checkered flag 🏁 plus skin tone.";
const FIX_WHITESPACE = "start\n\n\n\n   \t\t  middle \n \n\t end\t";
const FIX_LONG_30K = buildExactLength("Cat Cafe turn: Привет 🎭 and a long paragraph of tokens. ", 30_000);

/** [fixture name, text, model label, model] — the model ladder's four rails. */
const MATRIX: Array<{ text: string; fixture: string; model: string; modelId?: string }> = [
	{ fixture: "ascii", text: FIX_ASCII, model: "none" },
	{ fixture: "ascii", text: FIX_ASCII, model: "gpt4o", modelId: "gpt-4o" },
	{ fixture: "ascii", text: FIX_ASCII, model: "gemini", modelId: "gemini-2.0-flash" },
	{ fixture: "ascii", text: FIX_ASCII, model: "claude", modelId: "claude-sonnet-4-5" },
	{ fixture: "cyrillic", text: FIX_CYRILLIC, model: "none" },
	{ fixture: "cyrillic", text: FIX_CYRILLIC, model: "gpt4o", modelId: "gpt-4o" },
	{ fixture: "cyrillic", text: FIX_CYRILLIC, model: "gemini", modelId: "gemini-2.0-flash" },
	{ fixture: "cyrillic", text: FIX_CYRILLIC, model: "claude", modelId: "claude-sonnet-4-5" },
	{ fixture: "emoji", text: FIX_EMOJI, model: "none" },
	{ fixture: "emoji", text: FIX_EMOJI, model: "gpt4o", modelId: "gpt-4o" },
	{ fixture: "emoji", text: FIX_EMOJI, model: "gemini", modelId: "gemini-2.0-flash" },
	{ fixture: "emoji", text: FIX_EMOJI, model: "claude", modelId: "claude-sonnet-4-5" },
	{ fixture: "whitespace", text: FIX_WHITESPACE, model: "none" },
	{ fixture: "whitespace", text: FIX_WHITESPACE, model: "gpt4o", modelId: "gpt-4o" },
	{ fixture: "whitespace", text: FIX_WHITESPACE, model: "gemini", modelId: "gemini-2.0-flash" },
	{ fixture: "whitespace", text: FIX_WHITESPACE, model: "claude", modelId: "claude-sonnet-4-5" },
	{ fixture: "long30k", text: FIX_LONG_30K, model: "none" },
	{ fixture: "long30k", text: FIX_LONG_30K, model: "gpt4o", modelId: "gpt-4o" },
	{ fixture: "long30k", text: FIX_LONG_30K, model: "gemini", modelId: "gemini-2.0-flash" },
	{ fixture: "long30k", text: FIX_LONG_30K, model: "claude", modelId: "claude-sonnet-4-5" },
];

/**
 * PINNED on the PRE-TC-2 code (warmed tokenizers), 2026-10-31. Every entry
 * is the literal the then-current countTokens returned — the cache layer
 * must not move a single one.
 */
const PINNED: Record<string, number> = {
	"ascii|none": 10,
	"ascii|gpt4o": 10,
	"ascii|gemini": 10,
	"ascii|claude": 10,
	"cyrillic|none": 45,
	"cyrillic|gpt4o": 30,
	"cyrillic|gemini": 37,
	"cyrillic|claude": 48,
	"emoji|none": 48,
	"emoji|gpt4o": 36,
	"emoji|gemini": 45,
	"emoji|claude": 46,
	"whitespace|none": 9,
	"whitespace|gpt4o": 9,
	"whitespace|gemini": 9,
	"whitespace|claude": 9,
	"long30k|none": 8946,
	"long30k|gpt4o": 7894,
	"long30k|gemini": 8946,
	"long30k|claude": 9997,
	"ascii|default": 10,
	"cyrillic|default": 45,
	"emoji|default": 48,
	"whitespace|default": 9,
	"long30k|default": 8946,
};

const originalFetch = globalThis.fetch;
/** Marker exactness: the stubbed llama-server /tokenize counts 1000 + text.length. */
const EXACT = (text: string) => 1000 + text.length;

function stubTokenizeFetch() {
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		const content = typeof body.content === "string" ? body.content : "";
		return new Response(JSON.stringify({ tokens: Array.from({ length: EXACT(content) }) }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

function ctxFor(baseUrl: string): ProviderTokenContext {
	return {
		protocol: "llamacpp",
		baseUrl,
		apiKey: null,
		modelId: "qwen2.5-test",
		providerKey: `llamacpp|${baseUrl}|qwen2.5-test`,
	};
}

interface RecordedRow {
	textHash: string;
	tokenizer: string;
	tokenCount: number;
}

/** T1 double through the setter seam: records reads/writes, serves `rows`. */
function makeFakeStore() {
	const rows = new Map<string, number>();
	const gets: Array<{ textHash: string; tokenizer: string }> = [];
	const puts: RecordedRow[] = [];
	const store: PersistentTokenCountStore = {
		getSync: (textHash, tokenizer) => {
			gets.push({ textHash, tokenizer });
			const count = rows.get(`${tokenizer}::${textHash}`);
			return count === undefined ? null : { tokenCount: count };
		},
		putMany: async (rs) => {
			puts.push(...rs.map((r) => ({ ...r })));
		},
	};
	return { store, rows, gets, puts };
}

beforeEach(() => {
	globalThis.fetch = originalFetch;
	resetTokenCountCache();
	resetTokenCountLayerForTests();
	setPersistentTokenCountStore(null);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	resetTokenCountCache();
	resetTokenCountLayerForTests();
	setPersistentTokenCountStore(null);
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	resetTokenCountCache();
	resetTokenCountLayerForTests();
	setPersistentTokenCountStore(null);
});

describe("tokenizer-service before warmup (fresh process)", () => {
	test("a not-yet-loaded web tokenizer falls back to the cl100k count", () => {
		// Nothing in this test process loads web tokenizers before this file's
		// warmup below — countTokens with a claude model must equal the plain
		// cl100k default, exactly as the production cold path does before
		// warmupTokenizers() completes.
		expect(countTokens(FIX_CYRILLIC, "claude-sonnet-4-5")).toBe(countTokensDefault(FIX_CYRILLIC));
		expect(countTokens(FIX_CYRILLIC, "gemini-2.0-flash")).toBe(countTokensDefault(FIX_CYRILLIC));
	});

	test("resolveTokenizerId: no model or cold web file resolves to the cl100k id", () => {
		expect(resolveTokenizerId()).toBe("tiktoken:cl100k_base");
		expect(resolveTokenizerId("claude-sonnet-4-5")).toBe("tiktoken:cl100k_base");
		expect(resolveTokenizerId("gemini-2.0-flash")).toBe("tiktoken:cl100k_base");
	});
});

describe("tokenizer-service counts (characterization, warmed)", () => {
	// Warmup loads all 10 web-tokenizer JSON files — measured ~5.9 s, over
	// bun's 5 s default hook timeout, so the hook declares the measured
	// budget explicitly (deterministic setup cost, not a flake mask).
	beforeAll(async () => {
		await warmupTokenizers();
	}, 30_000);

	test("every pinned (text, model) count is byte-identical", () => {
		for (const entry of MATRIX) {
			expect(countTokens(entry.text, entry.modelId)).toBe(PINNED[`${entry.fixture}|${entry.model}`]);
		}
	});

	test("countTokensDefault pins hold and equal the no-model counts", () => {
		for (const [fixture, text] of [
			["ascii", FIX_ASCII],
			["cyrillic", FIX_CYRILLIC],
			["emoji", FIX_EMOJI],
			["whitespace", FIX_WHITESPACE],
			["long30k", FIX_LONG_30K],
		] as const) {
			expect(countTokensDefault(text)).toBe(PINNED[`${fixture}|default`]);
			expect(countTokens(text)).toBe(countTokensDefault(text));
		}
	});

	test("resolveTokenizerId maps every rail to the tokenizer the ladder uses", () => {
		expect(resolveTokenizerId("gpt-4o")).toBe("tiktoken:o200k_base");
		expect(resolveTokenizerId("o3-mini")).toBe("tiktoken:o200k_base");
		expect(resolveTokenizerId("gpt-4-turbo")).toBe("tiktoken:cl100k_base");
		expect(resolveTokenizerId("gemini-2.0-flash")).toBe("web:llama3.json");
		expect(resolveTokenizerId("gemma-2b")).toBe("web:llama3.json");
		expect(resolveTokenizerId("llama-3.3-70b")).toBe("web:llama3.json");
		expect(resolveTokenizerId("claude-sonnet-4-5")).toBe("web:claude.json");
		expect(resolveTokenizerId("totally-unknown-model")).toBe("tiktoken:cl100k_base");
	});
});

describe("layered count cache (TC-2)", () => {
	test("a repeated text encodes once — the second count is a cache hit", () => {
		const text = "the same text is never encoded twice in one process";
		const first = countTokens(text, "gpt-4o");
		expect(countTokens(text, "gpt-4o")).toBe(first);
		expect(countTokens(text, "gpt-4o")).toBe(first);
		expect(getTokenCountLayerStatsForTests().encodes).toBe(1);
	});

	test("per-tokenizer isolation: two tokenizers encode twice, a shared file does not", () => {
		const text = "same text under a different tokenizer ladder";
		const gemini = countTokens(text, "gemini-2.0-flash"); // web:llama3.json
		countTokens(text, "gpt-4o"); // tiktoken:o200k_base — separate inner map
		const gemma = countTokens(text, "gemma-2b"); // web:llama3.json again — hit
		expect(gemma).toBe(gemini);
		expect(getTokenCountLayerStatsForTests().encodes).toBe(2);
	});

	test("countTokensDefault shares the cl100k layer with the no-model and gpt-4 rails", () => {
		const text = "cl100k is the universal default rail";
		const viaDefault = countTokensDefault(text);
		expect(countTokens(text)).toBe(viaDefault); // no model → cl100k
		expect(countTokens(text, "gpt-4-turbo")).toBe(viaDefault); // gpt-4 family → cl100k
		expect(getTokenCountLayerStatsForTests().encodes).toBe(1);
	});

	test("after a memory reset the FIRST post-reset call returns the stored count with ZERO encodes", () => {
		// TC-8 retightening: this pin's TC-2 form allowed "the sync path must
		// encode once more" — that comment codified the defect (TC-7 measured
		// it: one re-encode per text per pass re-encoded an entire long-chat
		// snapshot on every pass). The store must be consulted SYNCHRONOUSLY
		// before the encode decision: with a stored row, the first post-reset
		// call answers from the store and encodes nothing.
		const texts = [
			"counted once yesterday, stored, reread today",
			"a second stored text from the same snapshot pass",
			"and a third, so the pin covers a whole pass, not one text",
		];
		const fake = makeFakeStore();
		setPersistentTokenCountStore(fake.store);
		const first = texts.map((text) => countTokens(text, "gpt-4o")); // encodes + write-through
		expect(fake.puts.length).toBe(texts.length);
		for (const [i, put] of fake.puts.entries()) {
			expect(put.tokenizer).toBe("tiktoken:o200k_base");
			expect(put.tokenCount).toBe(first[i]);
		}
		// Simulate a restart: memory gone; every row exists, held at marker
		// values so the assertions can tell store routing from encoding.
		for (const [i, put] of fake.puts.entries()) {
			fake.rows.set(`${put.tokenizer}::${put.textHash}`, 900_000 + i);
		}
		resetTokenCountLayerForTests();
		const second = texts.map((text) => countTokens(text, "gpt-4o"));
		expect(second).toEqual([900_000, 900_001, 900_002]); // from the store
		const third = texts.map((text) => countTokens(text, "gpt-4o")); // LRU populated by the hits
		expect(third).toEqual([900_000, 900_001, 900_002]);
		const stats = getTokenCountLayerStatsForTests();
		expect(stats.encodes).toBe(0); // ZERO encodes after the reset
		expect(stats.storeReads).toBe(texts.length);
		expect(stats.storeReadHits).toBe(texts.length);
	});

	test("texts above 100 000 chars never reach the store (memory only)", () => {
		const fake = makeFakeStore();
		setPersistentTokenCountStore(fake.store);
		const huge = buildExactLength("joined prompt block that must not hit the table. ", 100_001);
		const first = countTokens(huge, "gpt-4o");
		expect(countTokens(huge, "gpt-4o")).toBe(first); // memory hit
		expect(getTokenCountLayerStatsForTests().encodes).toBe(1);
		expect(fake.gets.length).toBe(0); // no read scheduled either
		expect(fake.puts.length).toBe(0);
		// The 100 000-char boundary itself still persists (the cut is > 100 000).
		const atLimit = buildExactLength("exactly at the persistence limit. ", 100_000);
		countTokens(atLimit, "gpt-4o");
		expect(fake.puts.length).toBe(1);
	});

	test("a provider-exact hit still wins and never touches the local layers", async () => {
		stubTokenizeFetch();
		const fake = makeFakeStore();
		setPersistentTokenCountStore(fake.store);
		const ctx = ctxFor("http://127.0.0.1:9712");
		const text = "exactness outranks every local count";
		const result = await runWithProviderTokenContext(ctx, async () => {
			const first = countTokens(text, "qwen2.5-instruct"); // miss → ladder + warm scheduled
			await waitForTokenWarmIdle();
			const second = countTokens(text, "qwen2.5-instruct"); // exact hit
			return { first, second };
		});
		expect(result.second).toBe(EXACT(text));
		expect(result.first).not.toBe(EXACT(text)); // ladder estimate on the miss
		const stats = getTokenCountLayerStatsForTests();
		expect(stats.encodes).toBe(1); // the exact hit added no encode
		expect(stats.storeWrites).toBe(1); // …and no second write-through
		expect(stats.storeReads).toBe(1); // …and no second store read
	});

	test("with no store injected everything works, memory-only", () => {
		setPersistentTokenCountStore(null); // unit-test / tools mode
		const a = countTokens("unit-test mode has no store", "gemini-2.0-flash");
		expect(countTokens("unit-test mode has no store", "gemini-2.0-flash")).toBe(a);
		const stats = getTokenCountLayerStatsForTests();
		expect(stats.encodes).toBe(1);
		expect(stats.storeReads).toBe(0);
		expect(stats.storeWrites).toBe(0);
	});

	test("evicts least-recent entries beyond the per-tokenizer entry bound", () => {
		configureTokenCountLayerForTests({ maxEntriesPerTokenizer: 3, maxTotalCharsPerTokenizer: 1_000_000 });
		const t = (i: number) => `lru fixture number ${i}`;
		countTokens(t(1), "gpt-4o");
		countTokens(t(2), "gpt-4o");
		countTokens(t(3), "gpt-4o");
		const one = countTokens(t(1), "gpt-4o"); // touch — t(2) becomes least-recent
		countTokens(t(4), "gpt-4o"); // evicts t(2)
		expect(getTokenCountLayerStatsForTests().encodes).toBe(4);
		const two = countTokens(t(2), "gpt-4o"); // re-encoded — was evicted
		expect(getTokenCountLayerStatsForTests().encodes).toBe(5);
		expect(countTokens(t(1), "gpt-4o")).toBe(one); // still cached — no new encode
		expect(getTokenCountLayerStatsForTests().encodes).toBe(5);
	});

	test("evicts by total chars and never caches a text larger than the whole bound", () => {
		configureTokenCountLayerForTests({ maxEntriesPerTokenizer: 1_000, maxTotalCharsPerTokenizer: 60 });
		const a = countTokens("a".repeat(40), "gpt-4o");
		countTokens("b".repeat(40), "gpt-4o"); // evicts the a-text (80 > 60 chars)
		expect(getTokenCountLayerStatsForTests().encodes).toBe(2);
		expect(countTokens("a".repeat(40), "gpt-4o")).toBe(a); // re-encoded, same value
		expect(getTokenCountLayerStatsForTests().encodes).toBe(3);
		const huge = "c".repeat(61); // a single text over the whole bound is never cached
		countTokens(huge, "gpt-4o");
		countTokens(huge, "gpt-4o");
		expect(getTokenCountLayerStatsForTests().encodes).toBe(5);
	});
});
