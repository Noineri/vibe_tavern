/**
 * @module providers/protocol-types
 *
 * Shared contracts for the protocol registry — extracted from
 * `protocol-registry.ts` so each per-protocol adapter module can import its
 * own contract WITHOUT importing the registry that imports it back (that would
 * be a circular dependency: adapter → registry → adapter). The registry
 * re-exports these for public compatibility.
 *
 * See AD-019 (Protocol Registry over Switch-Ladders for Provider Knowledge).
 */

import type { LanguageModel } from "ai";
import type { ProviderType, SamplerCapabilityFlags } from "@vibe-tavern/domain";
import type {
	ProviderConnectionInput,
	ProviderModelOption,
	ProviderProbeResult,
	TestChatResult,
} from "./provider-transport.js";
import type { ProviderFetch } from "./provider-fetch-factory.js";

// ---------------------------------------------------------------------------
// Capability flags (canonical type — source of truth lives here)
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

/** Input for a connection probe (no model required). */
export interface ProbeInput {
	baseUrl: string;
	apiKey: string;
	/** Optional proxy-aware fetch. Omitted/undefined → global fetch (direct). */
	fetch?: ProviderFetch;
}

/** Input for a model list request (no model required). */
export type ListModelsInput = Omit<ProviderConnectionInput, "model">;

/** Input for a backend tokenize request (LOCAL_SUPPORT_PLAN LS-1a — exact token counting). */
export interface TokenizeInput {
	baseUrl: string;
	apiKey: string | null;
	text: string;
	/**
	 * Model id. Optional in the interface only because most tokenize endpoints
	 * tokenize with the server's loaded model; Ollama's /api/tokenize names the
	 * model in the request body, so callers pass it when the context has one.
	 */
	modelId?: string;
	/** Optional proxy-aware fetch. Omitted/undefined → global fetch (direct). */
	fetch?: ProviderFetch;
}

export interface ProtocolAdapter {
	id: ProviderType;
	capabilities: ProviderCapabilityFlags;
	/**
	 * Resolve a Vercel AI SDK chat {@link LanguageModel} for this protocol.
	 *
	 * (Text-completion mode lands with §5.3.3; for now every protocol resolves
	 * a chat model.)
	 *
	 * The optional {@link ProviderFetch} is injected into the AI SDK provider
	 * factory's custom-`fetch` option so generation honors the profile's proxy
	 * policy; when omitted the SDK's default (direct) fetch is used.
	 */
	resolveModel(profile: ProviderProfileInput, model: string, fetch?: ProviderFetch): LanguageModel;
	/** Human-readable limitations surfaced to the UI. */
	limitations: string[];
	/** Connectivity probe (hit a models/tags endpoint, return success + count). */
	probe(input: ProbeInput): Promise<ProviderProbeResult>;
	/** Send a minimal "Hi" chat request to verify generation works. */
	testChat(input: ProviderConnectionInput): Promise<TestChatResult>;
	/** List available models from the provider's models/tags endpoint. */
	listModels(input: ListModelsInput): Promise<ProviderModelOption[]>;
	/**
	 * Count tokens exactly via the backend's tokenize endpoint
	 * (LOCAL_SUPPORT_PLAN LS-1a). OPTIONAL — protocols without a public tokenize
	 * route (LM Studio's OpenAI-compat surface, cloud providers) omit it; the
	 * counting layer then stays on the local tokenizer ladder
	 * (family tokenizer → cl100k). Throws on transport/HTTP/shape errors;
	 * callers must catch and fall back — never propagate into prompt assembly.
	 */
	tokenize?(input: TokenizeInput): Promise<number>;
}
