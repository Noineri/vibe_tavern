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
 * This file is the exhaustive lookup table only. Each protocol's COMPLETE
 * adapter — capability flags, SDK model resolver, human-readable limitations,
 * AND probe / test-chat / list-models operations — lives in its own module
 * (`openai-compat-adapter.ts`, `google-adapter.ts`, `ollama-adapter.ts`, …).
 * Adding a new native provider (e.g. Vertex AI) is one new protocol module
 * plus one entry in the `protocols` record below, not a four-site lock-step
 * edit.
 *
 * Refactor plan: `CODE_REVIEW_REFACTOR_PLAN.md` §5.3.2 (registry) and §5.3.3
 * (the request-mode / `textCompletion` axis — the field is present now, default
 * false; Novel Mode flips it per protocol when text-completion wiring lands).
 *
 * NOTE: providers/ imports nothing from ai/. The generation pipeline (ai/)
 * depends on providers/ one-way. Do not invert this.
 */

import { PROVIDER_TYPE } from "@vibe-tavern/domain";
import type { ProviderType } from "@vibe-tavern/domain";
import { providerError } from "../../shared/errors.js";
import { koboldCppProtocol } from "./koboldcpp-adapter.js";
import { ollamaProtocol } from "./ollama-adapter.js";
import { openaiCompatProtocol } from "./openai-compat-adapter.js";
import { llamaCppProtocol } from "./llamacpp-adapter.js";
import { unslothProtocol } from "./unsloth-adapter.js";
import { googleProtocol } from "./google-adapter.js";
import { anthropicProtocol } from "./anthropic-adapter.js";
import type { ProtocolAdapter, ProviderCapabilityFlags } from "./protocol-types.js";

// Protocol contracts (ProviderCapabilityFlags / ProtocolAdapter / etc.) live in
// protocol-types.ts now — extracted so per-protocol adapter modules can import
// their own contract without the registry importing them back (a circular dep).
// Re-exported here for public compatibility; the registry was their historical home.
export type {
	ProviderCapabilityFlags,
	ProviderProfileInput,
	ProbeInput,
	ListModelsInput,
	ProtocolAdapter,
} from "./protocol-types.js";

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
 * Derived capability map (keyed by provider type). The canonical capability
 * surface — consumers read it directly (the legacy `PROVIDER_CAPABILITIES`
 * alias and its compatibility shim were removed once all callers reached the
 * registry directly).
 */
export const PROTOCOL_CAPABILITIES: Record<ProviderType, ProviderCapabilityFlags> =
	Object.fromEntries(
		Object.values(protocols).map((adapter) => [adapter.id, adapter.capabilities]),
	) as Record<ProviderType, ProviderCapabilityFlags>;
