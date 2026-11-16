import { describe, it, expect } from "bun:test";
import {
	resolveVendor,
	buildDefaultModelsUrl,
	inferCapabilities,
	type OpenAiModelRecord,
	type OpenAiModelsResponse,
} from "../src/domain/providers/vendor-registry.js";

/**
 * Regression coverage for the vendor registry. The previous implementation
 * spread this logic across `detectProviderKind` (regex chain), an 8-arm
 * `extractCapabilities` switch, and an inline URL/filter switch inside
 * listOpenAiCompatModels. These tests pin down the observable behaviour so the
 * registry refactor cannot silently change which capability flags a given
 * aggregator response produces.
 */

describe("vendor-registry — resolveVendor dispatch", () => {
	const cases: Array<[string, string]> = [
		["https://electronhub.ai/v1", "electronhub"],
		["https://openrouter.ai/api/v1", "openrouter"],
		["https://nano-gpt.com/v1", "nanogpt"],
		["https://api.together.xyz/v1", "together"],
		["https://api.deepinfra.com/v1/openai", "deepinfra"],
		["https://api.fireworks.ai/inference/v1", "fireworks"],
		["https://llm.chutes.ai/v1", "chutes"],
		["https://api.x.ai/v1", "xai"],
		["https://api.groq.com/openai/v1", "groq"],
		["https://api.novita.ai/v3/openai", "novita"],
		["https://text.novelai.net/oa/v1", "novelai"],
	];

	for (const [baseUrl, expectedId] of cases) {
		it(`matches ${expectedId} for ${baseUrl}`, () => {
			expect(resolveVendor(baseUrl).id).toBe(expectedId);
		});
	}

	it("falls back to generic for an unknown host", () => {
		expect(resolveVendor("https://api.example.com/v1").id).toBe("generic");
	});

	it("falls back to generic for localhost", () => {
		expect(resolveVendor("http://localhost:8080/v1").id).toBe("generic");
	});
});

describe("vendor-registry — per-vendor capability extraction", () => {
	it("openrouter reads architecture.modality + supported_parameters", () => {
		const vendor = resolveVendor("https://openrouter.ai/api/v1");
		const record: OpenAiModelRecord = {
			architecture: { modality: "text+image->text" },
			supported_parameters: ["reasoning", "tools"],
		};
		expect(vendor.extractCapabilities(record)).toEqual({
			vision: true,
			reasoning: true,
			tools: true,
		});
	});

	it("openrouter reports text-only and absent authoritative features as unsupported", () => {
		const vendor = resolveVendor("https://openrouter.ai/api/v1");
		const record: OpenAiModelRecord = {
			architecture: { modality: "text->text" },
			supported_parameters: ["tools"],
		};
		expect(vendor.extractCapabilities(record)).toEqual({ vision: false, reasoning: false, tools: true });
	});

	it("together reads capabilities.tool_use", () => {
		const vendor = resolveVendor("https://api.together.xyz/v1");
		const record: OpenAiModelRecord = {
			capabilities: { vision: true, reasoning: true, tool_use: true, web_search: true },
		};
		expect(vendor.extractCapabilities(record)).toEqual({
			vision: true,
			reasoning: true,
			tools: true,
			webSearch: true,
		});
	});

	it("together falls back to function_calling when tool_use absent", () => {
		const vendor = resolveVendor("https://api.together.xyz/v1");
		const record: OpenAiModelRecord = {
			capabilities: { function_calling: true },
		};
		expect(vendor.extractCapabilities(record)).toEqual({ tools: true });
	});

	it("fireworks reads supports_* flags", () => {
		const vendor = resolveVendor("https://api.fireworks.ai/inference/v1");
		const record: OpenAiModelRecord = {
			supports_vision: true,
			supports_tools: true,
			supports_reasoning: true,
		};
		expect(vendor.extractCapabilities(record)).toEqual({
			vision: true,
			reasoning: true,
			tools: true,
		});
	});

	it("fireworks returns undefined when no supports_* flags present", () => {
		const vendor = resolveVendor("https://api.fireworks.ai/inference/v1");
		const record: OpenAiModelRecord = { id: "fw-model" };
		expect(vendor.extractCapabilities(record)).toBeUndefined();
	});

	it("xai sets tools:true unconditionally and vision from input_modalities", () => {
		const vendor = resolveVendor("https://api.x.ai/v1");
		const record: OpenAiModelRecord = {
			input_modalities: ["text", "image"],
		};
		expect(vendor.extractCapabilities(record)).toEqual({ vision: true, tools: true });
	});

	it("xai returns undefined when input_modalities is absent (pinned quirk)", () => {
		// Quirk preserved from the legacy extractCapabilities: the `tools: true`
		// reading is nested inside the `record.input_modalities ?` branch, so it
		// is only emitted when input_modalities is present. With no
		// input_modalities and nothing else signalable, the result is undefined.
		// This is intentionally pinned — the registry refactor must not change it.
		const vendor = resolveVendor("https://api.x.ai/v1");
		const record: OpenAiModelRecord = { id: "grok-3" };
		expect(vendor.extractCapabilities(record)).toBeUndefined();
	});

	it("electronhub reads metadata.* and premium_model", () => {
		const vendor = resolveVendor("https://electronhub.ai/v1");
		const record: OpenAiModelRecord = {
			metadata: { vision: true, reasoning: true, function_call: true, web_search: true },
			premium_model: true,
		};
		expect(vendor.extractCapabilities(record)).toEqual({
			vision: true,
			reasoning: true,
			tools: true,
			webSearch: true,
			premium: true,
		});
	});

	it("electronhub with no metadata falls back to inference only", () => {
		const vendor = resolveVendor("https://electronhub.ai/v1");
		const record: OpenAiModelRecord = { id: "eh-model" };
		expect(vendor.extractCapabilities(record)).toBeUndefined();
	});

	it("nanogpt reads capabilities.tool_calling", () => {
		const vendor = resolveVendor("https://nano-gpt.com/v1");
		const record: OpenAiModelRecord = {
			capabilities: { vision: true, reasoning: true, tool_calling: true },
		};
		expect(vendor.extractCapabilities(record)).toEqual({
			vision: true,
			reasoning: true,
			tools: true,
		});
	});

	it("deepinfra reads metadata.tags (the current wire signal)", () => {
		const vendor = resolveVendor("https://api.deepinfra.com/v1/openai");
		// Captured live from GET https://api.deepinfra.com/v1/openai/models?filter=with_meta
		// (fix-wave FW-4 probe, 2026-11-14): the vendor no longer sends the top-level
		// `modality` field nor a `capabilities` object — capability flags live in
		// metadata.tags ("vision", "reasoning", …). Verbatim wire record, nothing trimmed.
		const record = {
			id: "Qwen/Qwen3.6-27B",
			object: "model",
			created: 0,
			owned_by: "deepinfra",
			root: "Qwen/Qwen3.6-27B",
			parent: null,
			metadata: {
				description: "",
				context_length: 262144,
				max_tokens: 262144,
				pricing: { input_tokens: 0.32, output_tokens: 3.2 },
				discount: null,
				tags: ["chat", "vlm", "vision", "reasoning_effort", "reasoning"],
				default_width: null,
				default_height: null,
				default_iterations: null,
			},
		};
		expect(vendor.extractCapabilities(record)).toEqual({ vision: true, reasoning: true });
	});

	it("deepinfra reports no vision/reasoning when tags carry neither", () => {
		const vendor = resolveVendor("https://api.deepinfra.com/v1/openai");
		// Captured live (same 2026-11-14 probe): an embed-tagged record carries neither
		// capability tag, and tags are the only DeepInfra signal — so the arm reports
		// authoritative `false` for both instead of undefined. Verbatim wire record.
		const record = {
			id: "Qwen/Qwen3-Embedding-0.6B",
			object: "model",
			created: 0,
			owned_by: "deepinfra",
			root: "Qwen/Qwen3-Embedding-0.6B",
			parent: null,
			metadata: {
				description: "The Qwen3 Embedding model series is the latest proprietary model of the Qwen family, specifically designed for text embedding and ranking tasks. Building upon the dense foundational models of the Qwen3 series, it provides a comprehensive range of text embeddings and reranking models in various sizes (0.6B, 4B, and 8B).",
				context_length: 32768,
				max_tokens: 32768,
				pricing: { input_tokens: 0.01 },
				discount: null,
				tags: ["embed"],
				default_width: null,
				default_height: null,
				default_iterations: null,
			},
		};
		expect(vendor.extractCapabilities(record)).toEqual({ vision: false, reasoning: false });
	});

	it("chutes reads input_modalities + capabilities.tools", () => {
		const vendor = resolveVendor("https://llm.chutes.ai/v1");
		const record: OpenAiModelRecord = {
			input_modalities: ["text", "image"],
			capabilities: { reasoning: true, tools: true },
		};
		expect(vendor.extractCapabilities(record)).toEqual({
			vision: true,
			reasoning: true,
			tools: true,
		});
	});

	it("groq uses generic inference (no special arm)", () => {
		const vendor = resolveVendor("https://api.groq.com/openai/v1");
		const record: OpenAiModelRecord = {
			capabilities: { tool_calling: true, reasoning: true },
		};
		expect(vendor.extractCapabilities(record)).toEqual({ reasoning: true, tools: true });
	});

	it("novita uses generic inference (no special arm)", () => {
		const vendor = resolveVendor("https://api.novita.ai/v3/openai");
		const record: OpenAiModelRecord = {
			capabilities: { vision: true },
		};
		expect(vendor.extractCapabilities(record)).toEqual({ vision: true });
	});

	it("generic vendor uses inference only", () => {
		const vendor = resolveVendor("https://api.example.com/v1");
		const record: OpenAiModelRecord = {
			supports_vision: true,
			supports_tools: true,
		};
		// generic adapter does not read supports_* — those are Fireworks-specific.
		// It only runs inferCapabilities, which does read supports_vision/supports_tools.
		expect(vendor.extractCapabilities(record)).toEqual({ vision: true, tools: true });
	});
});

describe("vendor-registry — vendor-specific URL building", () => {
	it("nanogpt builds the subscription models URL and strips /v1", () => {
		const vendor = resolveVendor("https://nano-gpt.com/v1");
		expect(vendor.buildModelsUrl?.("https://nano-gpt.com/v1")).toBe(
			"https://nano-gpt.com/subscription/v1/models?detailed=true",
		);
	});

	it("deepinfra appends the with_meta filter", () => {
		const vendor = resolveVendor("https://api.deepinfra.com/v1/openai");
		expect(vendor.buildModelsUrl?.("https://api.deepinfra.com/v1/openai")).toBe(
			"https://api.deepinfra.com/v1/openai/models?filter=with_meta",
		);
	});

	it("xai builds the language-models URL and strips /v1", () => {
		const vendor = resolveVendor("https://api.x.ai/v1");
		expect(vendor.buildModelsUrl?.("https://api.x.ai/v1")).toBe(
			"https://api.x.ai/v1/language-models",
		);
	});

	it("vendors without an override use the default /models path", () => {
		expect(resolveVendor("https://openrouter.ai/api/v1").buildModelsUrl).toBeUndefined();
		expect(buildDefaultModelsUrl("https://api.openai.com/v1")).toBe(
			"https://api.openai.com/v1/models",
		);
	});
});

describe("vendor-registry — record extraction (xAI envelope)", () => {
	it("xai reads payload.models instead of payload.data", () => {
		const vendor = resolveVendor("https://api.x.ai/v1");
		const payload: OpenAiModelsResponse = {
			models: [{ id: "grok-3" }, { id: "grok-3-mini" }],
		};
		expect(vendor.extractRecords?.(payload)).toEqual([
			{ id: "grok-3" },
			{ id: "grok-3-mini" },
		]);
	});

	it("xai returns empty array when models is missing", () => {
		const vendor = resolveVendor("https://api.x.ai/v1");
		expect(vendor.extractRecords?.({ data: [{ id: "ignored" }] })).toEqual([]);
	});

	it("vendors without override have no extractRecords", () => {
		expect(resolveVendor("https://openrouter.ai/api/v1").extractRecords).toBeUndefined();
	});
});

describe("vendor-registry — NovelAI /oa/v1 record extraction", () => {
	it("falls back to the static xialong/glm list when data is empty", () => {
		const vendor = resolveVendor("https://text.novelai.net/oa/v1");
		expect(vendor.extractRecords?.({ data: [] })).toEqual([
			{ id: "xialong-v1", name: "Xialong" },
			{ id: "glm-4-6", name: "GLM-4.6" },
		]);
	});

	it("falls back to the static list when data is missing", () => {
		const vendor = resolveVendor("https://text.novelai.net/oa/v1");
		expect(vendor.extractRecords?.({})).toEqual([
			{ id: "xialong-v1", name: "Xialong" },
			{ id: "glm-4-6", name: "GLM-4.6" },
		]);
	});

	it("returns live records only when data is non-empty", () => {
		const vendor = resolveVendor("https://text.novelai.net/oa/v1");
		expect(vendor.extractRecords?.({ data: [{ id: "live-model" }] })).toEqual([
			{ id: "live-model" },
		]);
	});

	it("uses generic inference for capabilities (no special arm)", () => {
		const vendor = resolveVendor("https://text.novelai.net/oa/v1");
		const record: OpenAiModelRecord = { capabilities: { tool_calling: true } };
		expect(vendor.extractCapabilities(record)).toEqual({ tools: true });
	});
});

describe("vendor-registry — ElectronHub endpoint filtering", () => {
	it("electronhub keeps only records exposing a chat-completions endpoint", () => {
		const vendor = resolveVendor("https://electronhub.ai/v1");
		const records: OpenAiModelRecord[] = [
			{ id: "chat-model", endpoints: ["/v1/chat/completions"] },
			{ id: "embed-model", endpoints: ["/v1/embeddings"] },
			{ id: "no-endpoints" },
		];
		// only the first survives — the others don't expose /v1/chat/completions
		expect(vendor.filterRecords?.(records)).toEqual([
			{ id: "chat-model", endpoints: ["/v1/chat/completions"] },
		]);
	});

	it("electronhub does not filter when no record declares endpoints", () => {
		const vendor = resolveVendor("https://electronhub.ai/v1");
		const records: OpenAiModelRecord[] = [
			{ id: "a" },
			{ id: "b" },
		];
		expect(vendor.filterRecords?.(records)).toEqual(records);
	});

	it("vendors without override have no filterRecords", () => {
		expect(resolveVendor("https://openrouter.ai/api/v1").filterRecords).toBeUndefined();
	});
});

describe("vendor-registry — inferCapabilities (vendor-agnostic fallback)", () => {
	it("reads every known field location", () => {
		// exercises each branch of the inference fallback at least once
		expect(inferCapabilities({ input_modalities: ["image"] })).toEqual({ vision: true });
		expect(inferCapabilities({ supports_vision: true, supports_tools: true, supports_reasoning: true }))
			.toEqual({ vision: true, reasoning: true, tools: true });
		expect(inferCapabilities({ capabilities: { web_search: true } })).toEqual({ webSearch: true });
		expect(inferCapabilities({ premium_model: true })).toEqual({ premium: true });
	});

	it("returns undefined when nothing is signalled", () => {
		expect(inferCapabilities({ id: "x" })).toBeUndefined();
	});

	it("preserves explicit false capability metadata", () => {
		expect(inferCapabilities({
			metadata: { vision: false, reasoning: false, function_call: false, web_search: false },
			premium_model: false,
		})).toEqual({ vision: false, reasoning: false, tools: false, webSearch: false, premium: false });
	});

	it("uses authoritative supported-parameters metadata to report unsupported features", () => {
		expect(inferCapabilities({ supported_parameters: ["temperature"] })).toEqual({ reasoning: false, tools: false });
	});

	it("keeps vendor-specific explicit false ahead of generic inference", () => {
		const fireworks = resolveVendor("https://api.fireworks.ai/inference/v1");
		expect(fireworks.extractCapabilities({ supports_tools: false, capabilities: { tool_calling: true } }))
			.toMatchObject({ tools: false });
	});
});
