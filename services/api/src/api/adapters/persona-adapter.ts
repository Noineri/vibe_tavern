import type { PersonaRuntimeApi } from "../contract/runtime-api.js";
import { brandId, type PersonaId, type ChatId } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { AssetService } from "../../domain/asset/asset-service.js";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
import { validation } from "../../shared/errors.js";
import { describeAttachments, resolveVisionDescribePrompt } from "../../infrastructure/ai/vision-gate.js";

export class PersonaAdapter implements PersonaRuntimeApi {
	constructor(
		private readonly sessionRuntime: SessionRuntime,
		private readonly stores: StoreContainer,
		private readonly assetService: AssetService,
		private readonly providerProfileService: ProviderProfileService,
	) {}

	listPersonas = () => this.sessionRuntime.persona.list();

	createPersona = (body: {
		name: string;
		description: string;
		pronouns?: string | null;
		defaultForNewChats?: boolean;
	}) => this.sessionRuntime.persona.create(body);

	updatePersona = async (
		personaId: string,
		body: {
			chatId?: string;
			name?: string;
			description?: string;
			pronouns?: string | null;
			avatarAssetId?: string | null;
			avatarFullAssetId?: string | null;
			avatarCropJson?: string | null;
			includeAvatarInPrompt?: boolean;
			avatarDescription?: string | null;
		},
	) => {
		if (body.avatarAssetId !== undefined) {
			const persona = await this.stores.personas.getById(personaId);
			// Folder-resident avatar (avatarExt set) is handled by the folder
			// lifecycle — skip flat cleanup.
			if (!persona?.avatarExt && persona?.avatarAssetId && persona.avatarAssetId !== body.avatarAssetId) {
				this.assetService.cleanup(persona.avatarAssetId);
			}
		}
		return this.sessionRuntime.persona.update(
			personaId,
			{ ...body, chatId: body.chatId != null ? brandId<ChatId>(body.chatId) : undefined },
		);
	};

	deletePersona = async (personaId: string) => {
		const persona = await this.stores.personas.getById(personaId);
		// Folder-resident avatar (avatarExt) is removed by the store's
		// deleteEntityFolder; only legacy flat avatars need explicit cleanup.
		if (!persona?.avatarExt && persona?.avatarAssetId) {
			this.assetService.cleanup(persona.avatarAssetId);
		}
		await this.sessionRuntime.persona.delete(personaId);
	};

	duplicatePersona = (personaId: string) =>
		this.sessionRuntime.persona.duplicate(personaId);

	setDefaultPersona = (personaId: string) =>
		this.sessionRuntime.persona.setDefault(personaId);

	uploadPersonaAvatar = async (personaId: string, file: File): Promise<{ avatarExt: string }> => {
		const { ext } = await this.assetService.writePersonaAvatar(personaId, file);
		await this.stores.personas.setFolderAvatar(personaId, ext);
		return { avatarExt: ext };
	};

	servePersonaAvatar = async (personaId: string): Promise<Response | null> => {
		const persona = await this.stores.personas.getById(personaId);
		if (!persona) return null;
		if (persona.avatarExt) {
			return this.assetService.servePersonaAvatar(personaId, persona.avatarExt);
		}
		if (persona.avatarAssetId) {
			return this.assetService.serve(persona.avatarAssetId);
		}
		return null;
	};

	// ─── Vision describe (A6) ───────────────────────────────────────────
	// Mirrors CharacterAdapter.describeCharacterAvatar (same profile/prompt
	// resolution as chat attachment describe). Persists to `avatarDescription`.

	describePersonaAvatar = async (personaId: string): Promise<{ description: string }> => {
		const persona = await this.stores.personas.getById(personaId);
		if (!persona) throw validation("Persona not found.");
		if (!persona.avatarExt) {
			throw validation("Persona has no avatar.");
		}
		const buffer = await this.assetService.loadPersonaAvatarBuffer(personaId, persona.avatarExt);
		const mimeType = this.assetService.mimeForExt(persona.avatarExt);
		if (!buffer || !mimeType) throw validation("Persona has no avatar.");

		const profile = await this.resolveActiveProfileOrThrow();
		if (!profile.visionModel) {
			throw validation("No vision model configured in the active provider profile. Set one in Provider settings.");
		}
		const prompt = await this.resolveVisionDescribePromptFromPreset();

		const descriptions = await describeAttachments(
			[{ id: "avatar", assetId: "avatar", type: "image", name: `${persona.name} avatar`, mimeType, sizeBytes: 0 }],
			profile.visionModel,
			profile,
			async () => buffer,
			prompt,
		);
		const text = descriptions.get("avatar")?.trim() ?? "";
		await this.stores.personas.setMediaFields(brandId<PersonaId>(personaId), { avatarDescription: text });
		return { description: text };
	};

	// ─── Vision describe helpers (mirror ChatAdapter) ──────────────────

	private async resolveActiveProfileOrThrow() {
		const profile = await this.providerProfileService.resolveActiveProviderProfile();
		if (!profile) {
			throw validation("No active provider profile. Activate one in Provider settings.");
		}
		return { ...profile, defaultModel: profile.defaultModel as string };
	}

	private async resolveVisionDescribePromptFromPreset(): Promise<string> {
		const settings = await this.stores.uiSettings.get();
		let aiAssistantPrompts: Record<string, string> | null = null;
		if (settings?.activePromptPresetId) {
			const preset = await this.stores.presets.getById(settings.activePromptPresetId);
			if (preset?.aiAssistantPrompts) {
				try {
					const parsed = JSON.parse(preset.aiAssistantPrompts);
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						aiAssistantPrompts = Object.fromEntries(
							Object.entries(parsed).filter(([, v]) => typeof v === "string"),
						) as Record<string, string>;
					}
				} catch {}
			}
		}
		return resolveVisionDescribePrompt(aiAssistantPrompts);
	}
}
