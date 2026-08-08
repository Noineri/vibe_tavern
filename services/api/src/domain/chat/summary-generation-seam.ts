/**
 * Shared summary-generation seam (IR-42 / Wave 4).
 *
 * The effective-profile resolution + provider-API-key validation that
 * `ChatSummaryService` uses to generate summaries, extracted so the
 * interactive-runtime context service can REUSE the exact same resolution for
 * `compact_summary` capture without duplicating the binding/overlay logic (and
 * without writing to `chat_summaries`). Behavior-preserving extraction — the
 * functions are byte-identical to their former private/module-level forms in
 * `chat-summary-service.ts`; that service now imports them from here.
 */
import {
	normalizeProviderType,
	PROVIDER_TYPE,
	resolveEffectiveSettings,
	type StoredProviderProfileRecord,
} from "@vibe-tavern/domain";

/**
 * Minimal structural dependency for the overlay lookup. Matches the relevant
 * slice of `ProviderProfileService.getProviderModelSettings` so this seam stays
 * decoupled from the concrete service type (and from the api-contracts type).
 */
export interface SummaryProfileOverlayLookup {
	getProviderModelSettings(
		providerProfileId: string,
		modelId: string,
	): Promise<{ settings: Record<string, unknown> | null } | null>;
}

/**
 * Provider presets whose APIs do not require a saved API key (local / BYOK
 * servers). A summary generation is allowed for these even with no stored key.
 */
export const API_KEY_OPTIONAL_PROVIDER_PRESETS = new Set([
	PROVIDER_TYPE.ollama,
	PROVIDER_TYPE.llamaCpp,
	PROVIDER_TYPE.koboldCpp,
	"vllm",
	"ooba",
	"tabby",
	"aphrodite",
]);

/** Whether a provider preset requires a saved API key before it can be used. */
export function providerRequiresApiKey(providerPreset: string): boolean {
	const preset = providerPreset.trim();
	if (API_KEY_OPTIONAL_PROVIDER_PRESETS.has(preset)) return false;

	const providerType = normalizeProviderType(preset);
	return (
		providerType === PROVIDER_TYPE.openaiCompat ||
		providerType === PROVIDER_TYPE.anthropic ||
		providerType === PROVIDER_TYPE.google
	);
}

/**
 * Resolve the EFFECTIVE profile for summarization: merge the active model's
 * overlay (when binding is ON) so a bound model's per-model contextBudget /
 * samplers reach the summary generation. `model` is the resolved summary model.
 *
 * Mirrors the chat-adapter generation boundary: when `bindPerModel` is off the
 * profile is returned unchanged; otherwise the model's stored settings overlay
 * is merged via `resolveEffectiveSettings` (the same merge the chat turn uses).
 */
export async function resolveEffectiveSummaryProfile(
	profile: StoredProviderProfileRecord,
	model: string,
	overlays: SummaryProfileOverlayLookup,
): Promise<StoredProviderProfileRecord> {
	if (!profile.bindPerModel) return profile;
	const overlay = await overlays.getProviderModelSettings(profile.id, model);
	return resolveEffectiveSettings(profile, overlay?.settings ?? null);
}
