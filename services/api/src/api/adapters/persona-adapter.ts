import type { PersonaRuntimeApi } from "../contract/runtime-api.js";
import { brandId, type CharacterId, type ChatId } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { AssetService } from "../../domain/asset/asset-service.js";

export class PersonaAdapter implements PersonaRuntimeApi {
	constructor(
		private readonly sessionRuntime: SessionRuntime,
		private readonly stores: StoreContainer,
		private readonly assetService: AssetService,
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
}
