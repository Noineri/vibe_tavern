/**
 * Token-count cache (LOCAL_SUPPORT_PLAN LS-1b/LS-1e) — the async-warmed,
 * synchronously-read LRU behind the counting seam.
 *
 * Pins:
 * - miss → the local family/cl100k ladder estimate, plus a scheduled warm;
 * - after the warm settles, the same text reads the backend-exact count;
 * - a cache hit makes NO fetch call;
 * - TTL expiry re-misses and re-warms;
 * - endpoint absent/offline (fetch reject / HTTP error) → ladder estimate,
 *   NEVER a throw, and a per-provider cooldown stops re-hammering;
 * - no provider context in scope → pure ladder, zero fetches.
 *
 * Doubles: globalThis.fetch stub (the T2 network boundary — the counting layer
 * delegates to the real protocol adapters, which default to global fetch).
 * Restored in afterEach; this file shares a bun process with other api tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { countTokens } from "../src/infrastructure/ai/tokenizer-service.js";
import {
	type ProviderTokenContext,
	runWithProviderTokenContext,
	configureTokenCountCache,
	resetTokenCountCache,
	waitForTokenWarmIdle,
} from "../src/infrastructure/ai/token-count-cache.js";

const originalFetch = globalThis.fetch;
const ORIGINAL_CONFIG = { ttlMs: 30 * 60_000, capacity: 512, warmQueueMax: 64, offlineCooldownMs: 60_000 };

interface CapturedCall {
	url: string;
	body: Record<string, unknown>;
}

let calls: CapturedCall[] = [];
/** Served by the stubbed llama-server /tokenize: exact count = 1000 + text.length. */
const EXACT = (text: string) => 1000 + text.length;

function stubTokenizeFetch(overrides?: { fail?: boolean; status?: number }) {
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const urlText = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		calls.push({ url: urlText, body });
		if (overrides?.fail) throw new Error("ECONNREFUSED");
		const content = typeof body.content === "string" ? body.content : "";
		return new Response(JSON.stringify({ tokens: Array.from({ length: EXACT(content) }) }), {
			status: overrides?.status ?? 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

function ctxFor(baseUrl: string): ProviderTokenContext {
	return {
		protocol: "llamacpp",
		baseUrl,
		apiKey: null,
		modelId: "qwen-test",
		providerKey: `llamacpp|${baseUrl}|qwen-test`,
	};
}

beforeEach(() => {
	globalThis.fetch = originalFetch;
	calls = [];
	configureTokenCountCache(ORIGINAL_CONFIG);
	resetTokenCountCache();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	resetTokenCountCache();
});

describe("token-count-cache (LS-1b)", () => {
	it("miss returns the ladder estimate and schedules a warm; after idle the count is exact", async () => {
		stubTokenizeFetch();
		const ctx = ctxFor("http://127.0.0.1:9701");
		const text = "A wound-up spring of a first turn.";

		const before = runWithProviderTokenContext(ctx, () => countTokens(text));
		// Miss → local cl100k ladder (not the exact 1000+len marker).
		expect(before).not.toBe(EXACT(text));
		expect(before).toBeGreaterThan(0);

		await waitForTokenWarmIdle();
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("http://127.0.0.1:9701/tokenize");
		expect(calls[0]!.body.content).toBe(text);

		// Second assembly (same provider, same text): exact from cache.
		const after = runWithProviderTokenContext(ctx, () => countTokens(text));
		expect(after).toBe(EXACT(text));
		expect(calls).toHaveLength(1); // hit — no refetch
	});

	it("cache hit makes no fetch call at all", async () => {
		stubTokenizeFetch();
		const ctx = ctxFor("http://127.0.0.1:9702");
		const text = "stable old message";
		runWithProviderTokenContext(ctx, () => countTokens(text));
		await waitForTokenWarmIdle();
		const fetched = calls.length;

		for (let i = 0; i < 5; i++) {
			expect(runWithProviderTokenContext(ctx, () => countTokens(text))).toBe(EXACT(text));
		}
		expect(calls.length).toBe(fetched);
	});

	it("TTL expiry re-misses and re-warms", async () => {
		configureTokenCountCache({ ttlMs: 5 });
		stubTokenizeFetch();
		const ctx = ctxFor("http://127.0.0.1:9703");
		const text = "expires quickly";

		runWithProviderTokenContext(ctx, () => countTokens(text));
		await waitForTokenWarmIdle();
		expect(runWithProviderTokenContext(ctx, () => countTokens(text))).toBe(EXACT(text));
		const fetched = calls.length;

		await new Promise((r) => setTimeout(r, 12)); // past the 5ms TTL
		// Expired → miss → ladder estimate again + a fresh warm scheduled.
		expect(runWithProviderTokenContext(ctx, () => countTokens(text))).not.toBe(EXACT(text));
		await waitForTokenWarmIdle();
		expect(calls.length).toBeGreaterThan(fetched);
		expect(runWithProviderTokenContext(ctx, () => countTokens(text))).toBe(EXACT(text));
	});

	it("endpoint offline: fetch reject → ladder estimate, no throw, cooldown stops re-hammering", async () => {
		configureTokenCountCache({ offlineCooldownMs: 60_000 });
		stubTokenizeFetch({ fail: true });
		const ctx = ctxFor("http://127.0.0.1:9704");
		const text = "server is down";

		// The counting seam must NEVER throw on an unreachable endpoint.
		expect(() => runWithProviderTokenContext(ctx, () => countTokens(text))).not.toThrow();
		const estimate = runWithProviderTokenContext(ctx, () => countTokens(text));
		expect(estimate).toBe(countTokensDefaultRef(text));
		await waitForTokenWarmIdle();
		const attempted = calls.length;
		expect(attempted).toBeGreaterThan(0); // the warm was attempted

		// Cooldown: a subsequent miss schedules nothing.
		runWithProviderTokenContext(ctx, () => countTokens("a different chunk"));
		await waitForTokenWarmIdle();
		expect(calls.length).toBe(attempted);
	});

	it("HTTP error response also cools down and never throws", async () => {
		configureTokenCountCache({ offlineCooldownMs: 60_000 });
		stubTokenizeFetch({ status: 404 });
		const ctx = ctxFor("http://127.0.0.1:9705");
		const estimate = runWithProviderTokenContext(ctx, () => countTokens("no such route"));
		expect(estimate).toBe(countTokensDefaultRef("no such route"));
		await waitForTokenWarmIdle();
		expect(calls.length).toBe(1);
	});

	it("without a provider context the seam is byte-identical ladder behavior (no fetches)", async () => {
		stubTokenizeFetch();
		const text = "cloud provider, no tokenize route";
		expect(countTokens(text)).toBe(countTokensDefaultRef(text));
		await waitForTokenWarmIdle();
		expect(calls).toHaveLength(0);
	});

	it("different providers (providerKey) do not share cache entries", async () => {
		stubTokenizeFetch();
		const a = ctxFor("http://127.0.0.1:9706");
		const b = ctxFor("http://127.0.0.1:9707");
		const text = "same text, two backends";
		runWithProviderTokenContext(a, () => countTokens(text));
		await waitForTokenWarmIdle();
		expect(runWithProviderTokenContext(a, () => countTokens(text))).toBe(EXACT(text));
		// Other provider: still a miss (its own warm scheduled).
		expect(runWithProviderTokenContext(b, () => countTokens(text))).not.toBe(EXACT(text));
		await waitForTokenWarmIdle();
		expect(calls).toHaveLength(2);
	});
});

/** The ladder's bottom step, computed OUTSIDE any provider scope. */
function countTokensDefaultRef(text: string): number {
	return countTokens(text);
}
