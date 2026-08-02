import type { ProviderRuntimeApi } from "../contract/runtime-api.js";
import type { ClientProviderProfileRecord } from "../../runtime/session/session-runtime-dto.js";
import { notFound } from "../../shared/errors.js";
import type { StoreContainer } from "@vibe-tavern/db";
import { COAUTHOR_TRANSPORT, PROXY_MODE, type CoauthorTransport, type ModelFavoriteScope, type ModelSettingsOverlay, type ProviderProxyMode } from "@vibe-tavern/domain";
import { generateText } from "ai";
import { resolveModel } from "../../infrastructure/ai/provider-executor-utils.js";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
import {
	probeProviderConnection,
	testProviderChat,
	listProviderModels,
	normalizeOpenAiCompatibleBaseUrl,
} from "../../domain/providers/provider-gateway.js";
import { resolveProviderFetchForProfile } from "../../domain/providers/provider-fetch-factory.js";
import { validateProviderProxyPolicy } from "../../domain/providers/proxy-service.js";

export class ProviderAdapter implements ProviderRuntimeApi {
	constructor(
		private readonly stores: StoreContainer,
		private readonly providerProfileService: ProviderProfileService,
	) {}

	listProviderProfiles = () => this.providerProfileService.listProviderProfiles();
	reorderProviderProfiles = (updates: Array<{ id: string; sortOrder: number }>) => this.providerProfileService.reorderProviderProfiles(updates);

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

	/** Resolve the proxy-aware fetch for a draft policy carried by an unsaved
	 *  Test Connection / Fetch Models / Test Chat call. */
	private resolveDraftFetch = async (
		proxyMode: ProviderProxyMode | undefined,
		proxyId: string | null | undefined,
	): ReturnType<typeof resolveProviderFetchForProfile> => {
		const policy = await validateProviderProxyPolicy(
			proxyMode ?? PROXY_MODE.inherit,
			proxyId,
			this.stores.proxies,
		);
		return resolveProviderFetchForProfile(policy);
	};

	testProviderDraft = async (body: { endpoint?: string; apiKey?: string; providerType?: string; proxyMode?: ProviderProxyMode; proxyId?: string | null } | null) => {
		const endpoint = (body?.endpoint ?? "").trim();
		const apiKey = (body?.apiKey ?? "").trim();
		const fetch = await this.resolveDraftFetch(body?.proxyMode, body?.proxyId);
		return probeProviderConnection({ baseUrl: endpoint, apiKey, providerType: body?.providerType, ...(fetch ? { fetch } : {}) });
	};

	testProviderProfile = async (providerProfileId: string) => {
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		const fetch = await resolveProviderFetchForProfile(profile);
		return probeProviderConnection({
			baseUrl: profile.endpoint,
			apiKey: profile.apiKey ?? "",
			providerType: profile.providerPreset,
			...(fetch ? { fetch } : {}),
		});
	};

	deleteProviderProfile = (providerProfileId: string) =>
		this.providerProfileService.deleteProviderProfile(providerProfileId);

	fetchProviderModels = async (providerProfileId: string) => {
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		const fetch = await resolveProviderFetchForProfile(profile);
		const models = await listProviderModels({
			baseUrl: profile.endpoint,
			apiKey: profile.apiKey ?? "",
			providerType: profile.providerPreset,
			requiresAuthForModels: profile.providerPreset === "anthropic" || profile.providerPreset === "google" || profile.providerPreset === "unsloth",
			...(fetch ? { fetch } : {}),
		});

		// Persist to DB cache so send path has capability data
		const normalized = models.map((m) => ({
			id: m.id,
			label: m.label ?? m.id,
			...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
			...(m.capabilities ? { capabilities: { reasoning: m.capabilities.reasoning, tools: m.capabilities.tools, vision: m.capabilities.vision } } : {}),
		}));
		await this.providerProfileService.setCachedProviderModels(providerProfileId, normalized);

		return { models };
	};

	listFavoriteProviderModels = (providerProfileId: string, scope: ModelFavoriteScope) =>
		this.providerProfileService.listFavoriteProviderModels(providerProfileId, scope);

	addFavoriteProviderModel = (
		providerProfileId: string,
		body: { modelId: string; label?: string | null; contextLength?: number | null; scope: ModelFavoriteScope },
	) => this.providerProfileService.addFavoriteProviderModel(providerProfileId, body);

	removeFavoriteProviderModel = (providerProfileId: string, body: { modelId: string; scope: ModelFavoriteScope }) =>
		this.providerProfileService.removeFavoriteProviderModel(providerProfileId, body);

	listProviderModelSettings = (providerProfileId: string) =>
		this.providerProfileService.listProviderModelSettings(providerProfileId);

	getProviderModelSettings = (providerProfileId: string, modelId: string) =>
		this.providerProfileService.getProviderModelSettings(providerProfileId, modelId);

	upsertProviderModelSettings = (
		providerProfileId: string,
		modelId: string,
		settings: ModelSettingsOverlay,
	) => this.providerProfileService.upsertProviderModelSettings(providerProfileId, modelId, settings);

	deleteProviderModelSettings = (providerProfileId: string, modelId: string) =>
		this.providerProfileService.deleteProviderModelSettings(providerProfileId, modelId);

	fetchModelsByEndpoint = async (
		baseUrl: string,
		apiKey?: string,
		providerType?: string,
		proxyMode?: ProviderProxyMode,
		proxyId?: string | null,
	) => {
		const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl);
		const requiresAuth = providerType === "anthropic" || providerType === "google" || providerType === "unsloth";
		const fetch = await this.resolveDraftFetch(proxyMode, proxyId);
		return listProviderModels({
			baseUrl: normalized,
			apiKey: apiKey ?? "",
			providerType,
			requiresAuthForModels: requiresAuth,
			...(fetch ? { fetch } : {}),
		});
	};

	testProviderChatByEndpoint = async (opts: {
		baseUrl: string;
		apiKey: string;
		model: string;
		providerType?: string;
		proxyMode?: ProviderProxyMode;
		proxyId?: string | null;
	}) => {
		const fetch = await this.resolveDraftFetch(opts.proxyMode, opts.proxyId);
		return testProviderChat({ ...opts, ...(fetch ? { fetch } : {}) });
	};

	testProviderChatByProfile = async (providerProfileId: string, model: string, transport?: CoauthorTransport) => {
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		const fetch = await resolveProviderFetchForProfile(profile);
		if (transport !== COAUTHOR_TRANSPORT.responses) {
			return testProviderChat({
				baseUrl: profile.endpoint,
				apiKey: profile.apiKey ?? "",
				model,
				providerType: profile.providerPreset,
				...(fetch ? { fetch } : {}),
			});
		}
		try {
			const result = await generateText({
				model: resolveModel(profile, model, COAUTHOR_TRANSPORT.responses, fetch),
				prompt: "Hi",
				maxOutputTokens: 64,
			});
			return { success: true, reply: result.text || "(empty response)" };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	};

	private async getRequiredProviderProfile(providerProfileId: string) {
		const profile = await this.providerProfileService.getProviderProfile(providerProfileId);
		if (!profile) {
			throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
		}
		return profile;
	}
}
