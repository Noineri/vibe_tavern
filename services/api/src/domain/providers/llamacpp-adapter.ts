/**
 * @module providers/llamacpp-adapter
 *
 * The llama.cpp protocol — wraps a local llama-server behind its OpenAI-compat
 * /v1 endpoint. Reuses the OpenAI-compatible probe/test/list operations, but
 * normalizes the base URL to /v1 first (matching the historical gateway switch
 * arm). Owns its complete {@link ProtocolAdapter} constant.
 *
 * Extracted from protocol-registry.ts (AD-019).
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { normalizeLocalOpenAiCompatibleBaseUrl } from "./provider-transport.js";
import { PROVIDER_TYPE, SAMPLER_SETS } from "@vibe-tavern/domain";
import type { ProtocolAdapter } from "./protocol-types.js";
import type { ProviderFetch } from "./provider-fetch-factory.js";
import {
	probeOpenAiCompatibleConnection,
	testOpenAiCompatChat,
	listOpenAiCompatModels,
} from "./openai-compat-adapter.js";

export const llamaCppProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.llamaCpp,
	capabilities: {
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: true,
		logitBias: true,
		samplers: SAMPLER_SETS.llamacpp_native,
		textCompletion: false,
	},
	resolveModel(profile, model, fetch?: ProviderFetch) {
		const endpoint = normalizeLocalOpenAiCompatibleBaseUrl(profile.endpoint);
		const apiKey = profile.apiKey ?? "";
		const provider = createOpenAICompatible({
			name: "llamacpp",
			apiKey: apiKey || "not-needed",
			baseURL: endpoint,
			...(fetch ? { fetch } : {}),
		});
		return provider.chatModel(model);
	},
	limitations: [
		"Uses llama.cpp server's OpenAI-compatible /v1 endpoint for generation.",
		"Sampling parameters are forwarded as JSON body fields; exotic samplers (dry, xtc, adaptive-p) are applied only when the mapper also sends the `samplers` chain.",
		"Model selection is limited to the single loaded model on the llama.cpp server.",
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
