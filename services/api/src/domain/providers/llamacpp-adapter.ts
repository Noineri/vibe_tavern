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

import { PROVIDER_TYPE, SAMPLER_SETS } from "@vibe-tavern/domain";
import { normalizeLocalOpenAiCompatibleBaseUrl, TOKENIZE_TIMEOUT_MS } from "./provider-transport.js";
import { resolveOpenAiCompatLanguageModel } from "./completion-model.js";
import type { ProtocolAdapter, TokenizeInput } from "./protocol-types.js";
import type { ProviderFetch } from "./provider-fetch-factory.js";
import {
	probeOpenAiCompatibleConnection,
	testOpenAiCompatChat,
	listOpenAiCompatModels,
} from "./openai-compat-adapter.js";

// ─── Tokenize (LS-1a) ────────────────────────────────────────────────────

/** llama-server response for POST /tokenize. */
interface LlamaCppTokenizeResponse {
	tokens?: unknown;
}

/**
 * Derive the llama-server ROOT url for native endpoints (`/tokenize` is served
 * at the server root, next to /v1 — NOT under it). The profile stores either
 * the bare root or an OpenAI-compat /v1 URL; strip a trailing /v1 when present.
 */
function llamaCppRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1\/?$/, "");
}

/**
 * Exact token count via llama-server's native `POST /tokenize`
 * (V1f-probed shape: `{"content"}` → `{"tokens": [...]}` — no special tokens).
 * Throws on transport/HTTP/shape errors; the counting layer falls back to the
 * local tokenizer ladder.
 */
export async function tokenizeLlamaCpp(input: TokenizeInput): Promise<number> {
	const root = llamaCppRoot(input.baseUrl);
	if (!root) throw new Error("llama.cpp tokenize: provider endpoint is required.");
	const doFetch: typeof fetch = input.fetch ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TOKENIZE_TIMEOUT_MS);
	try {
		const response = await doFetch(`${root}/tokenize`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ content: input.text }),
			signal: controller.signal,
		});
		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			throw new Error(`llama.cpp tokenize failed (${response.status})${errorText ? `: ${errorText.slice(0, 200)}` : ""}`);
		}
		const payload = (await response.json()) as LlamaCppTokenizeResponse;
		if (!Array.isArray(payload.tokens)) {
			throw new Error("llama.cpp tokenize: unexpected response shape (missing tokens array).");
		}
		return payload.tokens.length;
	} finally {
		clearTimeout(timer);
	}
}

export const llamaCppProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.llamaCpp,
	capabilities: {
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: true,
		logitBias: true,
		samplers: SAMPLER_SETS.llamacpp_native,
		// LS-2e: llama-server serves OpenAI-style /completions, so the profile's
		// TC generation mode resolves a raw completion model (see resolveModel).
		textCompletion: true,
	},
	resolveModel(profile, model, fetch?: ProviderFetch) {
		// LS-2b: chat by default; generationMode "completion" serves the raw
		// /completions model (flat prompt via the LS-2c serialization seam).
		return resolveOpenAiCompatLanguageModel({
			name: "llamacpp",
			baseURL: normalizeLocalOpenAiCompatibleBaseUrl(profile.endpoint),
			apiKey: profile.apiKey,
			model,
			...(fetch ? { fetch } : {}),
			generationMode: profile.generationMode,
		});
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
	tokenize: tokenizeLlamaCpp,
};
