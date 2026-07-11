/**
 * @module providers/openai-compat-adapter
 *
 * The OpenAI-compatible protocol — the broadest protocol family in the app
 * (aggregators, real OpenAI, local OpenAI-compat servers). Owns its probe /
 * test-chat / list-models HTTP operations and its complete {@link ProtocolAdapter}
 * constant. llama.cpp and Unsloth (in their own modules) reuse these operations
 * with a normalized local base URL.
 *
 * Extracted from protocol-registry.ts (AD-019, colocation at protocol granularity).
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createReasoningAwareFetch } from "./openai-reasoning-fetch.js";
import { resolveVendor, buildDefaultModelsUrl, type OpenAiModelsResponse } from "./vendor-registry.js";
import {
	PROBE_TIMEOUT_MS,
	MODEL_LIST_TIMEOUT_MS,
	TEST_CHAT_TIMEOUT_MS,
	normalizeOpenAiCompatibleBaseUrl,
	buildHeaders,
	tryParseUrl,
	extractChoiceContent,
	wrapProviderNetworkError,
	type ProviderConnectionInput,
	type ProviderModelOption,
	type ProviderProbeResult,
	type TestChatResult,
	type OpenAiChatCompletionResponse,
} from "./provider-transport.js";
import { interpretProbeResponse } from "./probe-helpers.js";
import { PROVIDER_TYPE, SAMPLER_SETS } from "@vibe-tavern/domain";
import type { ProtocolAdapter, ProbeInput, ListModelsInput } from "./protocol-types.js";

export async function probeOpenAiCompatibleConnection(input: ProbeInput): Promise<ProviderProbeResult> {
	const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
	if (!baseUrl) {
		return { success: false, error: "Provider endpoint is required." };
	}
	const parsed = tryParseUrl(baseUrl);
	if (!parsed) {
		return { success: false, error: "Provider endpoint is invalid." };
	}
	if (!/^https?:$/.test(parsed.protocol)) {
		return {
			success: false,
			error: "Provider endpoint must use http or https.",
		};
	}

	let response: Response;
	try {
		response = await fetch(buildDefaultModelsUrl(baseUrl), {
			method: "GET",
			headers: buildHeaders(input.apiKey),
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
	} catch (error) {
		return {
			success: false,
			error: `Network error during probe: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	return interpretProbeResponse(response, (payload) => {
		const models = (payload as OpenAiModelsResponse).data;
		return Array.isArray(models) ? models.length : undefined;
	});
}

export async function testOpenAiCompatChat(input: ProviderConnectionInput): Promise<TestChatResult> {
	const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
	if (!baseUrl)
		return { success: false, error: "Provider endpoint is required." };
	if (!input.model) return { success: false, error: "Model is required." };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TEST_CHAT_TIMEOUT_MS);

	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: buildHeaders(input.apiKey, true),
			body: JSON.stringify({
				model: input.model,
				messages: [{ role: "user", content: "Hi" }],
				max_tokens: 64,
				temperature: 0.7,
				stream: false,
			}),
			signal: controller.signal,
		});
		clearTimeout(timer);

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			return {
				success: false,
				error: `${response.status} ${response.statusText}${errorText ? `: ${errorText.slice(0, 200)}` : ""}`,
			};
		}

		const payload = (await response.json()) as OpenAiChatCompletionResponse & {
			choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }>; reasoning_content?: string | null } }> };
		const choice = payload.choices?.[0];
		const content = extractChoiceContent(choice, { skipReasoning: true });
		if (!content && choice?.message?.reasoning_content) {
			return { success: true, reply: "(reasoning only, no visible output)" };
		}
		return { success: true, reply: content || "(empty response)" };
	} catch (error) {
		clearTimeout(timer);
		const msg = error instanceof Error ? error.message : "Unknown error";
		if (
			error instanceof Error &&
			(error.name === "TimeoutError" || /aborted/i.test(error.message))
		) {
			return {
				success: false,
				error: `Timed out after ${Math.floor(TEST_CHAT_TIMEOUT_MS / 1000)}s.`,
			};
		}
		return { success: false, error: msg };
	}
}

export async function listOpenAiCompatModels(input: ListModelsInput): Promise<ProviderModelOption[]> {
	const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);

	if (!baseUrl || !tryParseUrl(baseUrl)) {
		throw new Error(`Invalid provider endpoint: ${input.baseUrl}`);
	}

	const vendor = resolveVendor(baseUrl);

	// Vendor-specific endpoint URL (defaults to the standard /models path).
	const url = vendor.buildModelsUrl?.(baseUrl) ?? buildDefaultModelsUrl(baseUrl);

	let response: Response;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

	try {
		response = await fetch(url, {
			method: "GET",
			headers: buildHeaders(input.apiKey),
			signal: controller.signal,
		});
		clearTimeout(timer);
	} catch (error) {
		clearTimeout(timer);
		throw wrapProviderNetworkError(error, {
			operation: "Model list request",
			timeoutMs: MODEL_LIST_TIMEOUT_MS,
		});
	}

	if (!response.ok) {
		throw new Error(
			`Model list request failed: ${response.status} ${response.statusText}`,
		);
	}

	const payload = (await response.json()) as OpenAiModelsResponse;
	// Vendor-specific record extraction (xAI uses { models: [...] }; default { data: [...] }).
	const rawRecords = vendor.extractRecords?.(payload)
		?? (Array.isArray(payload.data) ? payload.data : []);

	// Vendor-specific filtering (ElectronHub keeps only chat-completions endpoints).
	const chatRecords = vendor.filterRecords ? vendor.filterRecords(rawRecords) : rawRecords;

	return chatRecords
		.map((record) => {
			const id = (record.id ?? record.name ?? "").trim();
			if (!id) return null;

			const opt: ProviderModelOption = {
				id,
				label: (record.name ?? "").trim() || id,
			};

			// Context length — try all known field names
			const contextLength = record.context_length
				?? record.context_length_total
				?? record.tokens
				?? record.top_provider?.context_length;
			if (contextLength) opt.contextLength = contextLength;

			if (record.description) opt.description = record.description;

			// Pricing
			if (record.pricing) {
				const inputPrice = record.pricing.input ?? record.pricing.prompt;
				const outputPrice = record.pricing.output ?? record.pricing.completion;
				if (inputPrice !== undefined || outputPrice !== undefined) {
					opt.pricing = { input: inputPrice, output: outputPrice };
				}
			}

			// Capabilities — vendor-specific extraction
			const capabilities = vendor.extractCapabilities(record);
			if (capabilities) opt.capabilities = capabilities;

			return opt;
		})
		.filter((record): record is ProviderModelOption => Boolean(record))
		.sort((left, right) => left.label.localeCompare(right.label));
}

export const openaiCompatProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.openaiCompat,
	capabilities: {
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: true,
		logitBias: true,
		samplers: SAMPLER_SETS.openai_compat_minimal,
		textCompletion: false,
	},
	resolveModel(profile, model) {
		const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
		const apiKey = profile.apiKey ?? "";
		// `openai_compat` is intentionally broad: in this app it covers
		// aggregators and non-OpenAI model-family providers, not only the real
		// OpenAI Chat API. The stricter OpenAI-only sampler surface is selected
		// elsewhere by preset-level resolveSamplerCapabilities("openai", ...).
		const provider = createOpenAICompatible({
			name: "openai_compat",
			apiKey: apiKey || "not-needed",
			baseURL: endpoint || "https://api.openai.com/v1",
			fetch: createReasoningAwareFetch(),
			// Many OpenAI-compatible aggregators/models support response_format:
			// json_schema, but the generic provider defaults this capability to
			// false unless declared.
			supportsStructuredOutputs: true,
		});
		return provider.chatModel(model);
	},
	limitations: [],
	probe: probeOpenAiCompatibleConnection,
	testChat: testOpenAiCompatChat,
	listModels: listOpenAiCompatModels,
};
