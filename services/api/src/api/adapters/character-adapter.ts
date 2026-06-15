import type { CharacterRuntimeApi, CharacterAssetRuntimeApi } from "../contract/runtime-api.js";
import { brandId, type CharacterId, type ChatId } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { AssetService } from "../../domain/asset/asset-service.js";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
import { validation } from "../../shared/errors.js";
import { describeAttachments, resolveVisionDescribePrompt } from "../../infrastructure/ai/vision-gate.js";

export class CharacterAdapter implements CharacterRuntimeApi, CharacterAssetRuntimeApi {
	constructor(
		private readonly sessionRuntime: SessionRuntime,
		private readonly stores: StoreContainer,
		private readonly assetService: AssetService,
		private readonly providerProfileService: ProviderProfileService,
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

	// ─── Vision describe (A6) ───────────────────────────────────────
	// Reuses the SAME vision resolution path as chat attachment describe:
	// active profile's visionModel + the `vision_describe` system prompt (preset
	// override → default). Mirrors ChatAdapter's resolveActiveProfileOrThrow /
	// resolveVisionDescribePromptFromPreset verbatim (same deps, same fallbacks).

	/** Describe gallery images in a batch. If `assetRowIds` is omitted/empty,
	 *  describes all currently-undescribed rows for this character. Rows whose
	 *  file can't be loaded go to `failed` (no throw); the rest are described
	 *  in one describeAttachments call and persisted. */
	describeCharacterAssets = async (
		characterId: string,
		assetRowIds?: string[],
	): Promise<{ updated: string[]; failed: string[] }> => {
		const all = await this.stores.characterAssets.listByCharacter(characterId);
		const requested = assetRowIds && assetRowIds.length > 0 ? new Set(assetRowIds) : null;
		// Ownership: `all` is already scoped to characterId, so intersecting with
		// it drops any foreign ids the caller passed in assetRowIds.
		const target = all.filter((r) => (requested ? requested.has(r.id) : r.description == null));

		const failed: string[] = [];
		const loadable: Array<{ row: (typeof all)[number]; buffer: Buffer }> = [];
		for (const row of target) {
			const buffer = await this.assetService.loadGalleryImageBuffer(characterId, row.id, row.ext);
			if (!buffer) failed.push(row.id);
			else loadable.push({ row, buffer });
		}
		if (loadable.length === 0) return { updated: [], failed };

		const profile = await this.resolveActiveProfileOrThrow();
		if (!profile.visionModel) {
			throw validation("No vision model configured in the active provider profile. Set one in Provider settings.");
		}
		const prompt = await this.resolveVisionDescribePromptFromPreset();

		const byId = new Map(loadable.map((x) => [x.row.id, x.buffer] as const));
		const attachments = loadable.map((x) => ({
			id: x.row.id,
			assetId: x.row.id, // loader key
			type: "image" as const,
			name: x.row.caption || `gallery-${x.row.id}`,
			mimeType: x.row.mimeType,
			sizeBytes: 0,
			description: x.row.description ?? undefined,
		}));
		// Preloaded loader — describeAttachments won't hit the disk again, and a
		// missing buffer can't surprise us mid-batch (those rows are already failed).
		const assetLoader = async (assetId: string) => byId.get(assetId) ?? null;

		const descriptions = await describeAttachments(
			attachments,
			profile.visionModel,
			profile,
			assetLoader,
			prompt,
		);
		const updated: string[] = [];
		for (const [id, text] of descriptions) {
			await this.stores.characterAssets.update(id, { description: text });
			updated.push(id);
		}
		return { updated, failed };
	};

	/** Describe the character's avatar and persist to `avatarDescription`. Uses
	 *  the same priority chain as the serve route: folder-resident avatar
	 *  (`avatarExt`, which getById's B4 lazy migrator populates for legacy flat
	 *  avatars). 400 if there's no avatar at all. */
	describeCharacterAvatar = async (characterId: string): Promise<{ description: string }> => {
		const character = await this.stores.characters.getById(brandId<CharacterId>(characterId));
		if (!character) throw validation("Character not found.");
		if (!character.avatarExt) {
			throw validation("Character has no avatar.");
		}
		const buffer = await this.assetService.loadCharacterAvatarBuffer(characterId, character.avatarExt);
		const mimeType = this.assetService.mimeForExt(character.avatarExt);
		if (!buffer || !mimeType) throw validation("Character has no avatar.");

		const profile = await this.resolveActiveProfileOrThrow();
		if (!profile.visionModel) {
			throw validation("No vision model configured in the active provider profile. Set one in Provider settings.");
		}
		const prompt = await this.resolveVisionDescribePromptFromPreset();

		const descriptions = await describeAttachments(
			[{ id: "avatar", assetId: "avatar", type: "image", name: `${character.name} avatar`, mimeType, sizeBytes: 0 }],
			profile.visionModel,
			profile,
			async () => buffer,
			prompt,
		);
		const text = descriptions.get("avatar")?.trim() ?? "";
		await this.stores.characters.setMediaFields(brandId<CharacterId>(characterId), { avatarDescription: text });
		return { description: text };
	};

	// ─── Vision describe helpers (mirror ChatAdapter) ────────────────

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
