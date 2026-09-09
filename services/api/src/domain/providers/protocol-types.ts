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
import type { GenerationMode, ProviderType, SamplerCapabilityFlags } from "@vibe-tavern/domain";
import type {
	ProviderConnectionInput,
	ProviderModelOption,
	ProviderProbeResult,
	TestChatResult,
} from "./provider-transport.js";
import type { ProviderFetch } from "./provider-fetch-factory.js";
import type { CompletionFormatSource } from "./completion-model.js";

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
	 * Whether this protocol serves the OPT-IN text-completion generation mode
	 * (LOCAL_SUPPORT_PLAN LS-2): a profile with `generationMode: "completion"`
	 * resolves to the protocol's OpenAI-style `/completions` model instead of
	 * its chat model. Protocols without such an endpoint (clouds other than
	 * the OpenAI-compat family, google, anthropic) stay `false` — a profile
	 * that somehow carries `completion` there silently resolves chat.
	 *
	 * Deliberate exclusions: `koboldcpp` is ALWAYS text completion natively
	 * (its adapter serializes the flat prompt itself — no toggle to expose),
	 * and `ollama`/`unsloth` have no OpenAI-compat completion surface.
	 */
	textCompletion: boolean;
	/**
	 * Whether this protocol's backend can render its OWN chat template for a
	 * raw completion prompt (LOCAL_SUPPORT_PLAN LS-3c): llama-server exposes
	 * `POST /apply-template` (verified live on b10786, 2026-09-09), so TC-mode
	 * AUTO format offloads the Jinja render to the server. When false, auto
	 * falls to the documented default template (VT's role-prefixed shape).
	 * KoboldCPP is `false` here by design — it is `native` (its adapter builds
	 * the prompt itself; auto is a no-op), not backend-rendered.
	 */
	backendTemplate: boolean;
}

export interface ProviderProfileInput {
	providerPreset: string;
	endpoint: string;
	apiKey: string | null;
	/** Generation mode (LS-2a). Optional so call sites holding partial profile
	 *  shapes stay valid; absent/undefined resolves the CHAT model (the
	 *  historical behavior — the flip is silent and backward-compatible). */
	generationMode?: GenerationMode;
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

/**
 * LS-3b/c handoff: the generation format resolved for THIS generation call,
 * threaded from the assembled prompt (`AssemblePromptResponse.completionFormat`)
 * through the executors into the protocol adapters. Absent behaves like auto.
 */
export interface CompletionFormatHandoff {
	/** The preset's format: `manual` renders the preset's sequences; auto/absent
	 *  uses the backend template when the protocol declares `backendTemplate`.
	 */
	completionFormat?: CompletionFormatSource;
}

export interface ProtocolAdapter {
	id: ProviderType;
	capabilities: ProviderCapabilityFlags;
	/**
	 * Resolve a Vercel AI SDK {@link LanguageModel} for this protocol.
	 *
	 * The profile's `generationMode` (LS-2b) selects which model flavor the
	 * OpenAI-compat-backed protocols resolve: `"completion"` → the raw
	 * text-completion model (`/completions`), anything else → the chat model.
	 * Protocols without a completion endpoint ignore the mode entirely.
	 *
	 * The optional {@link ProviderFetch} is injected into the AI SDK provider
	 * factory's custom-`fetch` option so generation honors the profile's proxy
	 * policy; when omitted the SDK's default (direct) fetch is used.
	 *
	 * The optional {@link CompletionFormatHandoff} (LS-3b/c) reaches only the
	 * OpenAI-compat-backed protocols that serve the raw completion model;
	 * protocols without a completion endpoint ignore it entirely.
	 */
	resolveModel(profile: ProviderProfileInput, model: string, fetch?: ProviderFetch, format?: CompletionFormatHandoff): LanguageModel;
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
