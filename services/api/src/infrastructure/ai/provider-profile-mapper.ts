/**
 * @module ai/provider-profile-mapper
 *
 * Thin compatibility shim over the protocol registry
 * (`providers/protocol-registry.ts`). The per-protocol switch lived here
 * historically; it now delegates to {@link resolveProtocol}.
 *
 * Refactor plan: `CODE_REVIEW_REFACTOR_PLAN.md` §5.3.2.
 */

import type { LanguageModel } from "ai";
import { normalizeProviderType } from "@vibe-tavern/domain";
import type { ProviderType } from "@vibe-tavern/domain";
import {
	resolveProtocol,
	type ProviderCapabilityFlags,
	type ProviderProfileInput,
} from "../../domain/providers/protocol-registry.js";

export { normalizeProviderType };
export type { ProviderProfileInput };

export interface ProviderMappingResult {
	/** The resolved AI SDK language model. */
	model: LanguageModel;
	/** Capability flags for this provider kind. */
	capabilities: ProviderCapabilityFlags;
	/** Human-readable description of any limitations. */
	limitations: string[];
}

/**
 * Resolve a stored provider profile + model name into an AI SDK LanguageModel.
 *
 * Delegates to the canonical protocol registry — the single mapping point.
 */
export function mapProfileToSdkModel(
	profile: { providerPreset: string; endpoint: string; apiKey: string | null },
	model: string,
): ProviderMappingResult {
	const providerType = normalizeProviderType(profile.providerPreset);
	const adapter = resolveProtocol(providerType);
	return {
		model: adapter.resolveModel(profile, model),
		capabilities: adapter.capabilities,
		limitations: adapter.limitations,
	};
}

/**
 * Check whether a provider type is explicitly unsupported (neither streaming
 * nor non-streaming generation).
 */
export function isUnsupportedProvider(type: ProviderType): boolean {
	const caps = resolveProtocol(type).capabilities;
	return !caps.nonStreamGeneration && !caps.streaming;
}
