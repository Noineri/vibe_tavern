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

import { GENERATION_MODE, PROVIDER_TYPE, SAMPLER_SETS } from "@vibe-tavern/domain";
import { normalizeLocalOpenAiCompatibleBaseUrl, TOKENIZE_TIMEOUT_MS, type ProviderConnectionInput, type ProviderModelOption } from "./provider-transport.js";
import { resolveOpenAiCompatLanguageModel } from "./completion-model.js";
import type { ProtocolAdapter, CompletionFormatHandoff, TokenizeInput, ListModelsInput } from "./protocol-types.js";
import type { ProviderFetch } from "./provider-fetch-factory.js";
import {
	probeOpenAiCompatibleConnection,
	testOpenAiCompatChat,
	listOpenAiCompatModels,
} from "./openai-compat-adapter.js";

// ─── Model list + server context (LS-7) ──────────────────────────────────

/** llama-server GET /props response — only the field LS-7 consumes. */
interface LlamaCppPropsResponse {
	default_generation_settings?: {
		n_ctx?: unknown;
	};
}

/** Timeout for the /props enrichment call — model lists must stay snappy. */
const PROPS_TIMEOUT_MS = 5_000;

/**
 * List models from llama-server, enriching each option with the server's
 * launch-time context. llama-server's /v1/models carries no context field,
 * but GET /props reports the actual `-c` the server was started with
 * (`default_generation_settings.n_ctx` — live-verified). Failure of /props
 * (non-llama OpenAI-compat backend on this preset, older build) is graceful:
 * models are returned without context and the context-budget auto-fill just
 * doesn't fire for them.
 */
export async function listLlamaCppModels(input: ListModelsInput): Promise<ProviderModelOption[]> {
	const models = await listOpenAiCompatModels({
		...input,
		baseUrl: normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl),
	});

	try {
		// /props lives at the server root, not under /v1.
		const base = normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl).replace(/\/v1$/, "");
		const doFetch: ProviderFetch = input.fetch ?? fetch;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROPS_TIMEOUT_MS);
		try {
			const response = await doFetch(`${base}/props`, { method: "GET", signal: controller.signal });
			if (response.ok) {
				const props = (await response.json()) as LlamaCppPropsResponse;
				const raw = props.default_generation_settings?.n_ctx;
				if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
					return models.map((m) => ({ ...m, contextLength: m.contextLength ?? raw }));
				}
			}
		} finally {
			clearTimeout(timer);
		}
	} catch {
		// Graceful: no /props → no context enrichment. The models list itself
		// already succeeded, so surface it as-is.
	}
	return models;
}

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
		// LS-3c: llama-server offloads the model's own Jinja chat template via
		// `POST /apply-template` (verified live on b10786, 2026-09-09) — TC-mode
		// AUTO format renders server-side; a failure falls back to the default
		// template inside the completion seam.
		backendTemplate: true,
	},
	resolveModel(profile, model, fetch?: ProviderFetch, format?: CompletionFormatHandoff) {
		// LS-2b: chat by default; generationMode "completion" serves the raw
		// /completions model (flat prompt via the LS-2c serialization seam).
		const isCompletion = profile.generationMode === GENERATION_MODE.completion;
		// LS-3c: the native /apply-template endpoint lives at the server ROOT
		// (next to /v1, NOT under it). Only set it when a root is derivable — an
		// empty endpoint falls back to the default template via the seam.
		const templateRoot = llamaCppRoot(profile.endpoint);
		return resolveOpenAiCompatLanguageModel({
			name: "llamacpp",
			baseURL: normalizeLocalOpenAiCompatibleBaseUrl(profile.endpoint),
			apiKey: profile.apiKey,
			model,
			...(fetch ? { fetch } : {}),
			generationMode: profile.generationMode,
			...(isCompletion
				? {
						// LS-3b: the preset's manual sequences render through the seam.
						...(format?.completionFormat ? { completionFormat: format.completionFormat } : {}),
						// LS-3c: AUTO renders through the backend's own template.
						...(templateRoot ? { applyTemplateUrl: `${templateRoot}/apply-template` } : {}),
					}
				: {}),
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
	listModels: (input) => listLlamaCppModels(input),
	tokenize: tokenizeLlamaCpp,
};
