import type { ProviderRuntimeApi } from "../contract/runtime-api.js";
import type { ClientProviderProfileRecord } from "../../session/session-runtime-dto.js";
import { notFound } from "../../shared/errors.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
import {
	probeProviderConnection,
	testProviderChat,
	listProviderModels,
	normalizeOpenAiCompatibleBaseUrl,
} from "../../domain/providers/provider-gateway.js";

export class ProviderAdapter implements ProviderRuntimeApi {
	constructor(
		private readonly stores: StoreContainer,
		private readonly providerProfileService: ProviderProfileService,
	) {}

	listProviderProfiles = () => this.providerProfileService.listProviderProfiles();

	fetchProviderProfile = async (providerProfileId: string): Promise<ClientProviderProfileRecord> => {
		const profile = await this.providerProfileService.getProviderProfileForClient(providerProfileId);
		if (!profile) {
			throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
		}
		return profile;
	};

	activateProviderProfile = (providerProfileId: string) =>
		this.providerProfileService.activateProviderProfile(providerProfileId);

	updateProviderProfile = (providerProfileId: string, body: Record<string, unknown>) =>
		this.providerProfileService.updateProviderProfile(providerProfileId, body);

	saveProviderDraft = (body: Record<string, unknown>) =>
		this.providerProfileService.saveProviderProfile(body);

	testProviderDraft = (body: { endpoint?: string; apiKey?: string; providerType?: string } | null) => {
		const endpoint = (body?.endpoint ?? "").trim();
		const apiKey = (body?.apiKey ?? "").trim();
		return probeProviderConnection({ baseUrl: endpoint, apiKey, providerType: body?.providerType });
	};

	testProviderProfile = async (providerProfileId: string) => {
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		return probeProviderConnection({
			baseUrl: profile.endpoint,
			apiKey: profile.apiKey ?? "",
			providerType: profile.providerPreset,
		});
	};

	deleteProviderProfile = (providerProfileId: string) =>
		this.providerProfileService.deleteProviderProfile(providerProfileId);

	fetchProviderModels = async (providerProfileId: string) => {
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		const models = await listProviderModels({
			baseUrl: profile.endpoint,
			apiKey: profile.apiKey ?? "",
			providerType: profile.providerPreset,
			requiresAuthForModels: profile.providerPreset === "anthropic" || profile.providerPreset === "google" || profile.providerPreset === "unsloth",
		});

		// Persist to DB cache so send path has capability data
		const normalized = models.map((m) => ({
			id: m.id,
			label: m.label ?? m.id,
			...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
			...(m.capabilities ? { capabilities: { thinking: m.capabilities.reasoning, tools: m.capabilities.tools, vision: m.capabilities.vision } } : {}),
		}));
		await this.providerProfileService.setCachedProviderModels(providerProfileId, normalized);

		return { models };
	};

	listFavoriteProviderModels = (providerProfileId: string) =>
		this.providerProfileService.listFavoriteProviderModels(providerProfileId);

	addFavoriteProviderModel = (
		providerProfileId: string,
		body: { modelId: string; label?: string | null; contextLength?: number | null },
	) => this.providerProfileService.addFavoriteProviderModel(providerProfileId, body);

	removeFavoriteProviderModel = (providerProfileId: string, modelId: string) =>
		this.providerProfileService.removeFavoriteProviderModel(providerProfileId, modelId);

	fetchModelsByEndpoint = async (baseUrl: string, apiKey?: string, providerType?: string) => {
		const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl);
		const requiresAuth = providerType === "anthropic" || providerType === "google" || providerType === "unsloth";
		return listProviderModels({
			baseUrl: normalized,
			apiKey: apiKey ?? "",
			providerType,
			requiresAuthForModels: requiresAuth,
		});
	};

	testProviderChatByEndpoint = (opts: {
		baseUrl: string;
		apiKey: string;
		model: string;
		providerType?: string;
	}) => testProviderChat(opts);

	testProviderChatByProfile = async (providerProfileId: string, model: string) => {
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		return testProviderChat({
			baseUrl: profile.endpoint,
			apiKey: profile.apiKey ?? "",
			model,
			providerType: profile.providerPreset,
		});
	};

	private async getRequiredProviderProfile(providerProfileId: string) {
		const profile = await this.providerProfileService.getProviderProfile(providerProfileId);
		if (!profile) {
			throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
		}
		return profile;
	}
}
