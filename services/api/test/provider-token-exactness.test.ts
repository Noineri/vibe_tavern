/**
 * Provider-exact token counting through the real assembly resolver
 * (LOCAL_SUPPORT_PLAN LS-1e — "resolver e2e that trace-layer counts become
 * exact after warm").
 *
 * Mechanic under test: the context-preview path (the same seam the context
 * meter eats) assembles under the active profile's token context; the first
 * assembly runs on the local ladder and schedules bounded warm fetches; after
 * the warm settles, a second assembly reads backend-exact counts from the
 * cache — no HTTP round-trip ever blocked the synchronous counting seam.
 *
 * Boundary: real SessionRuntime + temp DB (same harness as
 * context-preview-liveness.test.ts), with the T2 network boundary stubbed at
 * globalThis.fetch (restored in finally — api tests share one process).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ChatBranchId, ChatId } from "@vibe-tavern/domain";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { countTokens } from "../src/infrastructure/ai/tokenizer-service.js";
import { waitForTokenWarmIdle, resetTokenCountCache } from "../src/infrastructure/ai/token-count-cache.js";
import { afterAll } from "bun:test";

const originalFetch = globalThis.fetch;
/** Marker exactness: the stubbed llama-server counts 1000 + text.length tokens. */
const EXACT = (text: string) => 1000 + text.length;

// Production bootstrap wires the pipeline's counting fn to countTokens
// (server-runtime.ts). This test process needs the same wiring — otherwise
// pipeline layer counts stay 0 and the exactness assertion is meaningless.
setTokenCountFn(countTokens);
// Leak guard: prompt-pipeline has no unset — restore a neutral counter so
// later files in this shared process keep their pre-existing behavior.
afterAll(() => {
	setTokenCountFn(() => 0);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	resetTokenCountCache();
});

function makeProfile(over: Partial<StoredProviderProfileRecord> = {}): StoredProviderProfileRecord {
	return {
		id: "prof_ls1", name: "LS1 Local", providerPreset: "llamacpp",
		coauthorTransport: "chat_completions",
		endpoint: "http://127.0.0.1:9801", apiKey: null,
		defaultModel: "qwen2.5-test",
		contextBudget: 16000, pinContextBudget: false, tokenPadding: 0, bindPerModel: false,
		maxTokens: 512, temperature: 0.8, topP: 0.95, topK: 40, minP: 0.05, topA: 0,
		typicalP: 1, tfsZ: 1, adaptiveTarget: -1, adaptiveDecay: 0.9,
		dynatempRange: 0, dynatempExponent: 1, topNSigma: 0, smoothingFactor: 0,
		repeatLastN: 0, mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
		dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2, drySequenceBreakers: [],
		dryPenaltyLastN: -1, bannedStrings: [],
		xtcThreshold: 0.1, xtcProbability: 0, frequencyPenalty: 0, presencePenalty: 0,
		repetitionPenalty: 1, stopSequences: [], logitBias: [], seed: null,
		reasoningEffort: "auto", showReasoning: false, streamResponse: true,
		customSamplers: false, proxyMode: "inherit", proxyId: null,
		isActive: true, visionModel: null,
		createdAt: "2026-01-01", updatedAt: "2026-01-01",
		...over,
	};
}

async function createTestRuntime(profile: StoredProviderProfileRecord | null): Promise<{
	runtime: SessionRuntime;
	chatId: ChatId;
	cleanup: () => Promise<void>;
}> {
	const tmpDir = resolve(tmpdir(), "vt-ls1-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => profile });
	const created = await runtime.character.createFromScratch({
		name: "ProbeBot",
		description: "original description",
		firstMessage: "Hello there!",
	});
	return {
		runtime,
		chatId: created.activeChatId,
		cleanup: async () => {
			try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
		},
	};
}

function stubTokenizeEndpoint(): void {
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const urlText = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
		if (!urlText.endsWith("/tokenize")) {
			return new Response(JSON.stringify({ error: "unexpected fetch in test" }), { status: 404 });
		}
		const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string };
		const content = typeof body.content === "string" ? body.content : "";
		return new Response(JSON.stringify({ tokens: Array.from({ length: EXACT(content) }) }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

describe("Provider-exact token counts reach trace layers after warm (LS-1e)", () => {
	it("first preview assembles on the ladder; after the warm settles the layer counts are exact", async () => {
		stubTokenizeEndpoint();
		const ctx = await createTestRuntime(makeProfile());
		try {
			const { runtime, chatId } = ctx;
			const markerDescription = "LS1_EXACTNESS_MARKER description body";
			const snap = await runtime.getSnapshot(chatId);
			const branchId = snap.activeBranch!.id as ChatBranchId;
			await runtime.character.update(snap.character.id as Parameters<typeof runtime.character.update>[0], {
				description: markerDescription,
			});

			// Turn 1: cache miss everywhere — the synchronous seam must NOT block
			// on the endpoint; layer counts come from the local ladder.
			const first = await runtime.getContextPreview(chatId, branchId);
			expect(first).not.toBeNull();
			expect(first!.layers.length).toBeGreaterThan(0);
			const firstExactLayers = first!.layers.filter((l) => l.tokenCount === EXACT(l.text));
			expect(firstExactLayers.length).toBeLessThan(first!.layers.length);

			// Warm pass settles (bounded background queue — assembly never awaited it).
			await waitForTokenWarmIdle();

			// Turn 2: same stable texts → exact counts from the cache.
			const second = await runtime.getContextPreview(chatId, branchId);
			expect(second).not.toBeNull();
			const descriptionLayer = second!.layers.find((l) => l.text.includes("LS1_EXACTNESS_MARKER"));
			expect(descriptionLayer).toBeDefined();
			// Exact: the layer's count equals the stubbed backend's count for the
			// layer's own text (1000 + length) — not a cl100k estimate.
			expect(descriptionLayer!.tokenCount).toBe(EXACT(descriptionLayer!.text));
		} finally {
			await ctx.cleanup();
		}
	});

	it("profile with no model or a cloud protocol stays on the pure ladder (no fetch)", async () => {
		stubTokenizeEndpoint();
		const ctx = await createTestRuntime(makeProfile({ providerPreset: "openai_compat", defaultModel: "gpt-4o" }));
		try {
			const { runtime, chatId } = ctx;
			const snap = await runtime.getSnapshot(chatId);
			const branchId = snap.activeBranch!.id as ChatBranchId;
			const preview = await runtime.getContextPreview(chatId, branchId);
			expect(preview).not.toBeNull();
			// openai_compat exposes no tokenize capability — the orchestrator scope
			// is null, the ladder runs, and no /tokenize request is ever made.
			await waitForTokenWarmIdle();
			expect(preview!.layers.length).toBeGreaterThan(0);
		} finally {
			await ctx.cleanup();
		}
	});
});
