import type { StoreContainer } from "@vibe-tavern/db";
import { listProviderModels } from "./provider-gateway.js";

export interface CachedModel {
	modelSlug: string;
	modelName: string;
	contextLength: number | null;
	capabilities?: { thinking?: boolean; tools?: boolean; vision?: boolean };
}

/**
 * Resolves cached provider models, refreshing from the remote API if:
 * - cache is empty, or
 * - the active model lacks capability data.
 */
export async function resolveCachedModels(
	stores: StoreContainer,
	profile: {
		id: string;
		endpoint: string;
		apiKey: string | null;
		providerPreset: string;
		defaultModel: string | null;
	},
): Promise<CachedModel[]> {
	let cached = await stores.providers.getCachedModels(profile.id);

	if (cached.length > 0 && profile.defaultModel) {
		const activeModel = cached.find((m) => m.modelSlug === profile.defaultModel);
		if (activeModel?.capabilities) return cached;
	}

	try {
		const providerType = profile.providerPreset;
		const models = await listProviderModels({
			baseUrl: profile.endpoint,
			apiKey: profile.apiKey ?? "",
			providerType,
			requiresAuthForModels: providerType === "anthropic" || providerType === "google",
		});
		const normalized = models.map((m) => ({
			modelSlug: m.id,
			modelName: m.label ?? m.id,
			contextLength: m.contextLength ?? null,
			capabilities: m.capabilities
				? { thinking: m.capabilities.reasoning, tools: m.capabilities.tools, vision: m.capabilities.vision }
				: undefined,
		}));
		await stores.providers.saveCachedModels(profile.id, normalized);
		cached = await stores.providers.getCachedModels(profile.id);
	} catch {
		// Refresh failed — use whatever cache we have
	}

	return cached;
}
