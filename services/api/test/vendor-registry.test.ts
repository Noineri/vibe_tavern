import { describe, it, expect } from "bun:test";
import {
	resolveVendor,
	buildDefaultModelsUrl,
	inferCapabilities,
	type OpenAiModelRecord,
	type OpenAiModelsResponse,
} from "../src/providers/vendor-registry.js";

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

	it("openrouter does not set vision when modality is text-only", () => {
		const vendor = resolveVendor("https://openrouter.ai/api/v1");
		const record: OpenAiModelRecord = {
			architecture: { modality: "text->text" },
			supported_parameters: ["tools"],
		};
		expect(vendor.extractCapabilities(record)).toEqual({ tools: true });
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

	it("deepinfra reads capabilities + modality fallback", () => {
		const vendor = resolveVendor("https://api.deepinfra.com/v1/openai");
		const record: OpenAiModelRecord = {
			modality: ["text", "image"],
			capabilities: { reasoning: true, tool_calling: true },
		};
		expect(vendor.extractCapabilities(record)).toEqual({
			vision: true,
			reasoning: true,
			tools: true,
		});
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
});
