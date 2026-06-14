/**
 * @module providers/provider-gateway
 *
 * Public entry points for provider connection probing, test-chat, and model
 * listing. Each function normalises the raw preset to a {@link ProviderType}
 * and delegates to the matching {@link ProtocolAdapter} in
 * `protocol-registry.ts`.
 *
 * The per-protocol HTTP shapes (and capability/model-resolution logic) live in
 * the registry now — this file is just the dispatch surface + the
 * cross-cutting `requiresAuthForModels` guard. Adding a provider is a registry
 * entry, not an edit here.
 *
 * Refactor plan: `CODE_REVIEW_REFACTOR_PLAN.md` §5.3.2.
 */

import { normalizeProviderType } from "@vibe-tavern/domain";
import { resolveProtocol } from "./protocol-registry.js";
import {
	normalizeOpenAiCompatibleBaseUrl,
	type ProviderConnectionInput,
	type ProviderModelOption,
	type ProviderModelPricing,
	type ProviderProbeResult,
	type TestChatResult,
} from "./provider-transport.js";

// Re-exported for backward compatibility (adapters/routes import these from
// here). The definitions live in provider-transport.ts.
export {
	normalizeOpenAiCompatibleBaseUrl,
	type ProviderConnectionInput,
	type ProviderModelOption,
	type ProviderModelPricing,
	type ProviderProbeResult,
	type TestChatResult,
};

/**
 * Probe a provider's connectivity by hitting its models/tags endpoint.
 */
export async function probeProviderConnection(input: {
	baseUrl: string;
	apiKey: string;
	providerType?: string;
}): Promise<ProviderProbeResult> {
	const type = normalizeProviderType(input.providerType ?? "openai_compat");
	return resolveProtocol(type).probe({
		baseUrl: input.baseUrl,
		apiKey: input.apiKey,
	});
}

/**
 * Send a minimal "Hi" chat request to verify the provider can generate.
 */
export async function testProviderChat(
	input: ProviderConnectionInput & { providerType?: string },
): Promise<TestChatResult> {
	const type = normalizeProviderType(input.providerType ?? "openai_compat");
	return resolveProtocol(type).testChat(input);
}

/**
 * List available models from a provider's models/tags endpoint.
 */
export async function listProviderModels(
	input: Omit<ProviderConnectionInput, "model"> & {
		providerType?: string;
		requiresAuthForModels?: boolean;
	},
): Promise<ProviderModelOption[]> {
	if (input.requiresAuthForModels && !input.apiKey) {
		throw new Error("API key required to fetch models for this provider.");
	}

	const type = normalizeProviderType(input.providerType ?? "openai_compat");
	return resolveProtocol(type).listModels(input);
}
