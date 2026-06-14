import type { CharacterRuntimeApi } from "../api/contract/runtime-api.js";
import { brandId, type CharacterId, type ChatId } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../session/session-runtime.js";
import type { AssetService } from "../asset-service.js";

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
			if (character?.avatarAssetId && character.avatarAssetId !== body.avatarAssetId) {
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
		if (character?.avatarAssetId) this.assetService.cleanup(character.avatarAssetId);
		await this.sessionRuntime.character.delete(characterId);
	};

	exportCharacter = (characterId: string) => this.sessionRuntime.exportCharacter(characterId);

	duplicateCharacter = (characterId: string) =>
		this.sessionRuntime.character.duplicate(brandId<CharacterId>(characterId));
}
