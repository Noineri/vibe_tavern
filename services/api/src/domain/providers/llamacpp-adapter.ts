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
		samplers: SAMPLER_SETS.openai_local,
		textCompletion: false,
	},
	resolveModel(profile, model) {
		const endpoint = normalizeLocalOpenAiCompatibleBaseUrl(profile.endpoint);
		const apiKey = profile.apiKey ?? "";
		const provider = createOpenAICompatible({
			name: "llamacpp",
			apiKey: apiKey || "not-needed",
			baseURL: endpoint,
		});
		return provider.chatModel(model);
	},
	limitations: [
		"Uses llama.cpp server's OpenAI-compatible /v1 endpoint for generation.",
		"Sampling parameters top_k, typical_p, min_p, rep_pen, freq_pen, pres_pen are not forwarded via OpenAI-compatible adapter.",
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
