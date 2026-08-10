import { describe, expect, test } from "bun:test";
import {
	PROVIDER_QUOTA_KIND,
	PROVIDER_QUOTA_NONE_REASON,
	REMOTE_PROVIDER_PRESET_IDS,
} from "@vibe-tavern/domain";
import { QUOTA_ADAPTERS, findQuotaAdapterById, resolveQuotaAdapter } from "../src/domain/quota/quota-registry.js";
import { isPollableCapability } from "../src/domain/quota/quota-capability-types.js";

/** Endpoint each preset ships with — resolution must not depend on it when the preset is known. */
const PRESET_ENDPOINTS: Readonly<Record<string, string>> = {
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
	deepseek: "https://api.deepseek.com",
	groq: "https://api.groq.com/openai/v1",
	xai: "https://api.x.ai/v1",
	mistral: "https://api.mistral.ai/v1",
	fireworks: "https://api.fireworks.ai/inference/v1",
	perplexity: "https://api.perplexity.ai",
	moonshot: "https://api.moonshot.ai/v1",
	kimi: "https://api.kimi.com/coding/v1",
	ai21: "https://api.ai21.com/studio/v1",
	mimo: "https://api.xiaomimimo.com/v1",
	nanogpt: "https://nano-gpt.com/api/v1",
	chutes: "https://llm.chutes.ai/v1",
	electronhub: "https://api.electronhub.ai/v1",
	zai: "https://api.z.ai/api/paas/v4",
	"zai-coding": "https://api.z.ai/api/coding/paas/v4",
	siliconflow: "https://api.siliconflow.com/v1",
	togetherai: "https://api.together.xyz/v1",
	pollinations: "https://gen.pollinations.ai/v1",
	anthropic: "https://api.anthropic.com/v1",
	google: "https://generativelanguage.googleapis.com",
};

const SUPPORTED = new Map<string, string>([
	["zai", "zai"],
	["zai-coding", "zai"],
	["kimi", "kimi"],
	["nanogpt", "nanogpt"],
	["moonshot", "moonshot"],
	["deepseek", "deepseek"],
	["openrouter", "openrouter"],
]);

describe("resolveQuotaAdapter", () => {
	test("resolves every remote preset — none falls through unclassified", () => {
		for (const presetId of REMOTE_PROVIDER_PRESET_IDS) {
			const capability = resolveQuotaAdapter(presetId, PRESET_ENDPOINTS[presetId]!);
			expect(capability).toBeDefined();
			if (SUPPORTED.has(presetId)) {
				expect(isPollableCapability(capability)).toBe(true);
			} else {
				expect(capability.kind).toBe(PROVIDER_QUOTA_KIND.none);
			}
		}
	});

	test("the seven supported presets map to their adapters", () => {
		for (const [presetId, adapterId] of SUPPORTED) {
			const capability = resolveQuotaAdapter(presetId, PRESET_ENDPOINTS[presetId]!);
			expect(isPollableCapability(capability) ? capability.id : null).toBe(adapterId);
		}
	});

	test("the other fifteen report not_exposed with a maintainer note", () => {
		const unsupported = REMOTE_PROVIDER_PRESET_IDS.filter((id) => !SUPPORTED.has(id));
		expect(unsupported).toHaveLength(15);
		for (const presetId of unsupported) {
			const capability = resolveQuotaAdapter(presetId, PRESET_ENDPOINTS[presetId]!);
			expect(capability.kind).toBe(PROVIDER_QUOTA_KIND.none);
			if (!isPollableCapability(capability)) {
				expect(capability.reason).toBe(PROVIDER_QUOTA_NONE_REASON.notExposed);
				expect(capability.note.length).toBeGreaterThan(0);
			}
		}
	});

	test("Together AI stays excluded until its schema is fixture-verified", () => {
		const capability = resolveQuotaAdapter("togetherai", PRESET_ENDPOINTS.togetherai!);
		expect(capability.kind).toBe(PROVIDER_QUOTA_KIND.none);
	});

	test("the preset wins over the endpoint — a zai preset on a foreign host is still the zai adapter", () => {
		const capability = resolveQuotaAdapter("zai", "https://openrouter.ai/api/v1");
		expect(isPollableCapability(capability) ? capability.id : null).toBe("zai");
	});

	test("a custom preset on a known origin resolves by origin", () => {
		const capability = resolveQuotaAdapter("custom", "https://api.deepseek.com");
		expect(isPollableCapability(capability) ? capability.id : null).toBe("deepseek");
	});

	test.each([
		["ollama", "http://localhost:11434"],
		["llamacpp", "http://localhost:8080"],
		["koboldcpp", "http://localhost:5001"],
		["vllm", "http://localhost:8000/v1"],
	])("local preset %s is not_applicable", (presetId, endpoint) => {
		const capability = resolveQuotaAdapter(presetId, endpoint);
		expect(capability.kind).toBe(PROVIDER_QUOTA_KIND.none);
		if (!isPollableCapability(capability)) {
			expect(capability.reason).toBe(PROVIDER_QUOTA_NONE_REASON.notApplicable);
		}
	});

	test("an unknown host is not_applicable, not a guess", () => {
		const capability = resolveQuotaAdapter("custom", "https://some-unknown-gateway.example/v1");
		expect(capability.kind).toBe(PROVIDER_QUOTA_KIND.none);
	});

	test("a malformed endpoint on a custom preset is not_applicable, not a throw", () => {
		expect(resolveQuotaAdapter("custom", "not a url").kind).toBe(PROVIDER_QUOTA_KIND.none);
	});

	test("the dev stub is absent unless VIBE_TAVERN_QUOTA_STUB is set", () => {
		expect(Bun.env.VIBE_TAVERN_QUOTA_STUB).not.toBe("1");
		expect(resolveQuotaAdapter("custom", "http://127.0.0.1:8799").kind).toBe(PROVIDER_QUOTA_KIND.none);
		expect(findQuotaAdapterById("__quota_stub__")).toBeNull();
	});
});

describe("findQuotaAdapterById", () => {
	test("finds every shipped adapter by the id snapshots record", () => {
		for (const adapter of QUOTA_ADAPTERS) {
			expect(findQuotaAdapterById(adapter.id)).toBe(adapter);
		}
	});

	test("returns null for an id that no longer exists", () => {
		expect(findQuotaAdapterById("retired-vendor")).toBeNull();
	});
});
