import type { CharacterRuntimeApi } from "../contract/runtime-api.js";
import { brandId, type CharacterId, type ChatId } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { AssetService } from "../../domain/asset/asset-service.js";

export class CharacterAdapter implements CharacterRuntimeApi {
	constructor(
		private readonly sessionRuntime: SessionRuntime,
		private readonly stores: StoreContainer,
		private readonly assetService: AssetService,
	) {}

	createCharacterFromScratch = (body: {
		name: string;
		description?: string;
		firstMessage?: string;
		scenario?: string;
		personalitySummary?: string;
		mesExample?: string;
		mesExampleMode?: string;
		mesExampleDepth?: number;
		alternateGreetings?: string[];
		postHistoryInstructions?: string;
		creatorNotes?: string;
		systemPrompt?: string;
		depthPrompt?: string;
		depthPromptDepth?: number;
		depthPromptRole?: string;
		tags?: string[];
	}) => this.sessionRuntime.character.createFromScratch(body);

	updateCharacter = async (
		characterId: string,
		body: {
			chatId?: string;
			name?: string;
			description?: string;
			personalitySummary?: string | null;
			scenario?: string;
			systemPrompt?: string;
			firstMessage?: string | null;
			mesExample?: string | null;
			mesExampleMode?: string;
			mesExampleDepth?: number;
			alternateGreetings?: string[];
			postHistoryInstructions?: string | null;
			creatorNotes?: string | null;
			depthPrompt?: string | null;
			depthPromptDepth?: number | null;
			depthPromptRole?: string | null;
			tags?: string[];
			avatarAssetId?: string | null;
			avatarFullAssetId?: string | null;
			avatarCropJson?: string | null;
		},
	) => {
		if (body.avatarAssetId !== undefined) {
			const character = await this.stores.characters.getById(brandId<CharacterId>(characterId));
			// Folder-resident avatar (avatarExt set) is handled by the folder
			// lifecycle — skip flat cleanup. Only legacy flat avatars
			// (avatarExt null) get the old cleanup-on-change behavior.
			if (!character?.avatarExt && character?.avatarAssetId && character.avatarAssetId !== body.avatarAssetId) {
				this.assetService.cleanup(character.avatarAssetId);
			}
		}
		return this.sessionRuntime.character.update(
			brandId<CharacterId>(characterId),
			{ ...body, chatId: body.chatId != null ? brandId<ChatId>(body.chatId) : undefined },
			{ rebuildChatOrder: () => this.sessionRuntime.rebuildChatOrder() },
		);
	};

	archiveCharacter = (characterId: string) => this.sessionRuntime.character.archive(characterId);
	unarchiveCharacter = (characterId: string) => this.sessionRuntime.character.unarchive(characterId);

	deleteCharacter = async (characterId: string) => {
		const character = await this.stores.characters.getById(brandId<CharacterId>(characterId));
		// Folder-resident avatar (avatarExt) is removed by the store's
		// deleteEntityFolder; only legacy flat avatars need explicit cleanup.
		if (!character?.avatarExt && character?.avatarAssetId) {
			this.assetService.cleanup(character.avatarAssetId);
		}
		await this.sessionRuntime.character.delete(characterId);
	};

	exportCharacter = (characterId: string) => this.sessionRuntime.exportCharacter(characterId);

	duplicateCharacter = (characterId: string) =>
		this.sessionRuntime.character.duplicate(brandId<CharacterId>(characterId));

	uploadCharacterAvatar = async (characterId: string, file: File): Promise<{ avatarExt: string }> => {
		const { ext } = await this.assetService.writeCharacterAvatar(characterId, file);
		await this.stores.characters.setFolderAvatar(brandId<CharacterId>(characterId), ext);
		return { avatarExt: ext };
	};

	serveCharacterAvatar = async (characterId: string): Promise<Response | null> => {
		const character = await this.stores.characters.getById(brandId<CharacterId>(characterId));
		if (!character) return null;
		// Folder-resident avatar (post-migration) — serve directly.
		if (character.avatarExt) {
			return this.assetService.serveCharacterAvatar(characterId, character.avatarExt);
		}
		// Legacy flat avatar (avatarAssetId set, not yet migrated / flat asset
		// missing so B4 left it as-is) — delegate to the flat serve path.
		if (character.avatarAssetId) {
			return this.assetService.serve(character.avatarAssetId);
		}
		return null;
	};
}
