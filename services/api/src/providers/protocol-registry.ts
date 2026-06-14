/**
 * @module providers/protocol-registry
 *
 * Protocol registry — one {@link ProtocolAdapter} per {@link ProviderType}.
 *
 * This is the single source of truth for per-protocol knowledge. It collapses
 * four sites that were previously kept in sync by hand:
 *
 *   1. `mapProfileToSdkModel` 7-arm switch (`ai/provider-profile-mapper.ts`)
 *   2. `PROVIDER_CAPABILITIES` map (`ai/provider-capabilities.ts`)
 *   3. `provider-gateway` probe/test/list switches
 *   4. `SAMPLER_SETS` per-protocol lookup
 *
 * Adding a new native provider (e.g. Vertex AI) is now one object entry here,
 * not a four-site lock-step edit.
 *
 * Refactor plan: `CODE_REVIEW_REFACTOR_PLAN.md` §5.3.2 (registry) and §5.3.3
 * (the request-mode / `textCompletion` axis — the field is present now, default
 * false; Novel Mode flips it per protocol when text-completion wiring lands).
 *
 * NOTE: providers/ imports nothing from ai/. The generation pipeline (ai/)
 * depends on providers/ one-way. Do not invert this.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import {
	PROVIDER_TYPE,
	SAMPLER_SETS,
} from "@vibe-tavern/domain";
import type { ProviderType, SamplerCapabilityFlags } from "@vibe-tavern/domain";
import { providerError } from "../errors.js";
import { createReasoningAwareFetch } from "./openai-reasoning-fetch.js";
import { createKoboldCppModel } from "./koboldcpp-adapter.js";
import { createOllamaModel } from "./ollama-adapter.js";

// ---------------------------------------------------------------------------
// Capability flags (canonical type — source of truth lives here now)
// ---------------------------------------------------------------------------

export interface ProviderCapabilityFlags {
	/** Provider can produce a complete non-streamed reply. */
	nonStreamGeneration: boolean;
	/** Provider execution respects an AbortSignal for cancellation. */
	abortSignal: boolean;
	/** Provider supports SSE/streaming responses. */
	streaming: boolean;
	/** Provider supports prefill (prefixing assistant content). */
	prefill: boolean;
	/** Provider supports logit bias (token-level output control). */
	logitBias: boolean;
	/** Granular sampler controls supported by this provider type. */
	samplers: SamplerCapabilityFlags;
	/**
	 * Whether this protocol can serve a raw text-completion request
	 * (`/v1/completions` or a native equivalent like KoboldCPP `/api/v1/generate`),
	 * as required by Novel Mode's flat-prompt assembler.
	 *
	 * Refactor plan §5.3.3. Default false everywhere until Novel Mode's
	 * text-completion wiring lands; flipping a flag here is the only change
	 * needed to opt a protocol in.
	 */
	textCompletion: boolean;
}

export interface ProviderProfileInput {
	providerPreset: string;
	endpoint: string;
	apiKey: string | null;
}

// ---------------------------------------------------------------------------
// Protocol adapter
// ---------------------------------------------------------------------------

export interface ProtocolAdapter {
	id: ProviderType;
	capabilities: ProviderCapabilityFlags;
	/**
	 * Resolve a Vercel AI SDK chat {@link LanguageModel} for this protocol.
	 *
	 * (Text-completion mode lands with §5.3.3; for now every protocol resolves
	 * a chat model.)
	 */
	resolveModel(profile: ProviderProfileInput, model: string): LanguageModel;
	/** Human-readable limitations surfaced to the UI. */
	limitations: string[];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Strip trailing slashes and append `/v1` for local OpenAI-compat servers. */
function normalizeLocalOpenAiCompatibleBaseUrl(endpoint: string): string {
	const normalized = (endpoint || "").trim().replace(/\/+$/, "");
	if (!normalized) return "http://localhost:11434/v1";
	if (normalized.endsWith("/v1")) return normalized;
	if (normalized.endsWith("/api")) return `${normalized.slice(0, -"/api".length)}/v1`;
	return `${normalized}/v1`;
}

// ---------------------------------------------------------------------------
// Per-protocol adapters
// ---------------------------------------------------------------------------

const openaiCompatProtocol: ProtocolAdapter = {
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
};

const anthropicProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.anthropic,
	capabilities: {
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: false,
		logitBias: false,
		samplers: SAMPLER_SETS.anthropic,
		textCompletion: false,
	},
	resolveModel(profile, model) {
		const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
		const apiKey = profile.apiKey ?? "";
		const provider = createAnthropic({
			apiKey: apiKey || "not-needed",
			baseURL: endpoint || undefined,
		});
		return provider(model);
	},
	limitations: [],
};

const googleProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.google,
	capabilities: {
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: false,
		logitBias: false,
		samplers: SAMPLER_SETS.minimal_reasoning,
		textCompletion: false,
	},
	resolveModel(profile, model) {
		const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
		const apiKey = profile.apiKey ?? "";
		// Google SDK defaults to https://generativelanguage.googleapis.com/v1beta.
		// Only override baseURL if the user explicitly changed it (e.g. Vertex AI
		// proxy).
		const defaultGoogleBase = "https://generativelanguage.googleapis.com";
		const googleBaseUrl = (!endpoint || endpoint === defaultGoogleBase)
			? undefined
			: endpoint;
		const provider = createGoogleGenerativeAI({
			apiKey: apiKey || "not-needed",
			baseURL: googleBaseUrl,
		});
		return provider(model);
	},
	limitations: [],
};

const ollamaProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.ollama,
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
		const endpoint = (profile.endpoint || "").replace(/\/+$/, "") || "http://localhost:11434";
		return createOllamaModel({ baseURL: endpoint, modelId: model });
	},
	limitations: [
		"Uses Ollama native /api/chat endpoint for full sampler support.",
		"Model list uses Ollama's native /api/tags endpoint.",
	],
};

const llamaCppProtocol: ProtocolAdapter = {
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
			fetch: createReasoningAwareFetch(),
		});
		return provider.chatModel(model);
	},
	limitations: [
		"Uses llama.cpp server's OpenAI-compatible /v1 endpoint for generation.",
		"Sampling parameters top_k, typical_p, min_p, rep_pen, freq_pen, pres_pen are not forwarded via OpenAI-compatible adapter.",
		"Model selection is limited to the single loaded model on the llama.cpp server.",
	],
};

const koboldCppProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.koboldCpp,
	capabilities: {
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: false,
		logitBias: false,
		samplers: SAMPLER_SETS.koboldcpp_native,
		textCompletion: false,
	},
	resolveModel(profile, model) {
		const endpoint = (profile.endpoint || "").replace(/\/+$/, "") || "http://localhost:5001";
		return createKoboldCppModel({ baseURL: endpoint, modelId: model ?? "koboldcpp" });
	},
	limitations: [
		"Uses KoboldCPP native /api/v1/generate endpoint (not OpenAI-compat).",
		"Chat messages are serialized into a flat text prompt.",
		"Tool calling is not supported.",
	],
};

const unslothProtocol: ProtocolAdapter = {
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
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const protocols: Record<ProviderType, ProtocolAdapter> = {
	[PROVIDER_TYPE.openaiCompat]: openaiCompatProtocol,
	[PROVIDER_TYPE.anthropic]: anthropicProtocol,
	[PROVIDER_TYPE.google]: googleProtocol,
	[PROVIDER_TYPE.ollama]: ollamaProtocol,
	[PROVIDER_TYPE.llamaCpp]: llamaCppProtocol,
	[PROVIDER_TYPE.koboldCpp]: koboldCppProtocol,
	[PROVIDER_TYPE.unsloth]: unslothProtocol,
};

/**
 * Resolve the {@link ProtocolAdapter} for a canonical {@link ProviderType}.
 *
 * Callers holding a raw preset ID must normalise it first via
 * `normalizeProviderType()` from `@vibe-tavern/domain`.
 *
 * Throws for an unknown type. In practice this is unreachable: the
 * `protocols` record is exhaustive over the `ProviderType` union, and
 * `normalizeProviderType` falls back to `openai_compat`.
 */
export function resolveProtocol(type: ProviderType): ProtocolAdapter {
	const adapter = protocols[type];
	if (!adapter) {
		throw providerError(
			`Unknown provider type '${type}'. ` +
				`Supported types: ${Object.values(PROVIDER_TYPE).join(", ")}.`,
			{ providerType: type },
		);
	}
	return adapter;
}

/**
 * Derived capability map (keyed by provider type). Kept as an export so the
 * compatibility shim in `ai/provider-capabilities.ts` can re-export the legacy
 * `PROVIDER_CAPABILITIES` name without duplicating data.
 */
export const PROTOCOL_CAPABILITIES: Record<ProviderType, ProviderCapabilityFlags> =
	Object.fromEntries(
		Object.values(protocols).map((adapter) => [adapter.id, adapter.capabilities]),
	) as Record<ProviderType, ProviderCapabilityFlags>;
