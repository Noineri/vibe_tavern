/**
 * @module providers/unsloth-adapter
 *
 * The Unsloth Studio protocol — wraps llama-server behind OpenAI-compat /v1
 * endpoints. Reuses the OpenAI-compatible probe/test/list operations, but
 * normalizes the base URL to /v1 first (matching the historical gateway switch
 * arm) and defaults the endpoint to http://localhost:8888. Owns its complete
 * {@link ProtocolAdapter} constant.
 *
 * Extracted from protocol-registry.ts (AD-019).
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createReasoningAwareFetch } from "./openai-reasoning-fetch.js";
import { normalizeLocalOpenAiCompatibleBaseUrl } from "./provider-transport.js";
import { PROVIDER_TYPE, SAMPLER_SETS } from "@vibe-tavern/domain";
import type { ProtocolAdapter } from "./protocol-types.js";
import {
	probeOpenAiCompatibleConnection,
	testOpenAiCompatChat,
	listOpenAiCompatModels,
} from "./openai-compat-adapter.js";

export const unslothProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.unsloth,
	capabilities: {
		// Unsloth Studio wraps llama-server behind OpenAI-compat /v1 endpoints.
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: true,
		logitBias: true,
		samplers: SAMPLER_SETS.openai_local,
		textCompletion: false,
	},
	resolveModel(profile, model) {
		const endpoint = normalizeLocalOpenAiCompatibleBaseUrl(profile.endpoint || "http://localhost:8888");
		const apiKey = profile.apiKey ?? "";
		const provider = createOpenAICompatible({
			name: "unsloth",
			apiKey: apiKey || "not-needed",
			baseURL: endpoint,
			fetch: createReasoningAwareFetch(),
		});
		return provider.chatModel(model);
	},
	limitations: [
		"Uses Unsloth Studio's OpenAI-compatible /v1 endpoint (llama-server under the hood).",
		"Requires an sk-unsloth- API key created from Studio Settings → API.",
	],
	probe: (input) => probeOpenAiCompatibleConnection({
		...input,
		baseUrl: normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl),
	}),
	testChat: (input) => testOpenAiCompatChat({
		...input,
		baseUrl: normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl),
	}),
	listModels: (input) => listOpenAiCompatModels({
		...input,
		baseUrl: normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl),
	}),
};
