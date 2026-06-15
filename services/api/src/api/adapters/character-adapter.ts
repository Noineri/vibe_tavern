import type { CharacterRuntimeApi, CharacterAssetRuntimeApi } from "../contract/runtime-api.js";
import { brandId, type CharacterId, type ChatId } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { AssetService } from "../../domain/asset/asset-service.js";

export class CharacterAdapter implements CharacterRuntimeApi, CharacterAssetRuntimeApi {
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

	// ─── Character media gallery (CharacterAssetRuntimeApi) ─────────────
	// Gallery images live at {characterId}/gallery/{rowId}.{ext}; the row id IS
	// the file identifier (no separate assetId). Upload writes the file first,
	// then the row, so a failed write leaves no orphan row; a failed row insert
	// leaves an orphan file that the character-delete folder cascade reclaims.

	listCharacterAssets = async (characterId: string) => {
		return this.stores.characterAssets.listByCharacter(characterId);
	};

	serveCharacterAsset = async (characterId: string, assetRowId: string): Promise<Response | null> => {
		const row = await this.stores.characterAssets.getById(assetRowId);
		// Guard against cross-character reads: a row belonging to another
		// character must 404 here, not serve its bytes.
		if (!row || row.characterId !== characterId) return null;
		return this.assetService.serveGalleryImage(characterId, assetRowId, row.ext);
	};

	uploadCharacterAsset = async (characterId: string, file: File) => {
		// Generate the row id up front so the file and the row share it.
		const rowId = this.stores.characterAssets.nextId();
		const { ext, mimeType } = await this.assetService.writeGalleryImage(characterId, rowId, file);
		// order = last order + 1 so new images append to the end (listByCharacter
		// returns ordered by `order` asc, so the last entry holds the current max).
		const existing = await this.stores.characterAssets.listByCharacter(characterId);
		const order = existing.length === 0 ? 0 : existing[existing.length - 1]!.order + 1;
		return this.stores.characterAssets.create({ id: rowId, characterId, ext, mimeType, order });
	};

	updateCharacterAsset = async (
		characterId: string,
		assetRowId: string,
		patch: { caption?: string; description?: string | null },
	) => {
		// Verify ownership before updating (cross-character guard).
		const row = await this.stores.characterAssets.getById(assetRowId);
		if (!row || row.characterId !== characterId) {
			throw new Error("Character asset not found");
		}
		const updated = await this.stores.characterAssets.update(assetRowId, patch);
		if (!updated) throw new Error("Character asset not found");
		return updated;
	};

	reorderCharacterAssets = async (characterId: string, orderedIds: string[]) => {
		await this.stores.characterAssets.reorder(characterId, orderedIds);
	};

	deleteCharacterAsset = async (characterId: string, assetRowId: string): Promise<void> => {
		const row = await this.stores.characterAssets.getById(assetRowId);
		if (!row || row.characterId !== characterId) {
			throw new Error("Character asset not found");
		}
		// Row first (returns ext), then remove the file — the only filesystem touch.
		const result = await this.stores.characterAssets.delete(assetRowId);
		if (result) {
			await this.assetService.deleteGalleryImage(result.characterId, assetRowId, result.ext);
		}
	};
}
