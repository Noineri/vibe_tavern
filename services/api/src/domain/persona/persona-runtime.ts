import type { StoreContainer } from "@vibe-tavern/db";
import { STORAGE_FOLDERS } from "@vibe-tavern/db";
import {
	brandId,
	type ChatBranchId,
	type ChatId,
	type PersonaId,
} from "@vibe-tavern/domain";
import {
	conflict,
	internal,
	isDomainError,
	notFound,
	validation,
} from "../../shared/errors.js";
import type { IChatOrder } from "../../runtime/session/session-runtime-chat-order.js";
import type { SessionSnapshot, ConfigPatchResponse } from "../../api/contract/session-types.js";

/**
 * Canonical persona shape — the single source of truth for the backend.
 * Returned by `PersonaRuntime.list/create/duplicate`, used as
 * `SessionSnapshot.persona`, and returned by `StaticPromptResolver.getPersona`.
 * The contract re-exports this type (see `runtime-api.ts`); the frontend
 * mirrors it in `apps/web/src/api/types.ts` (`PersonaRecord` / `AppPersona`).
 * Every field exists on the persona DB row (`persona-store.ts` `Persona`).
 */
export type PersonaRecord = {
	id: string;
	name: string;
	description: string;
	pronouns: string | null;
	avatarAssetId: string | null;
	avatarFullAssetId: string | null;
	avatarCropJson: string | null;
	avatarExt: string | null;
	avatarFullExt: string | null;
	defaultForNewChats: boolean;
	// ─── Media injection (A7) ────────────────────────────────────────────
	/** Vision-generated appearance description of the avatar. Null = undescribed. */
	avatarDescription: string | null;
	/** Whether the avatar appearance is injected into the prompt. */
	includeAvatarInPrompt: boolean;
	/** ISO timestamp of the last row update; avatar cache-bust key (symmetric with `CharacterRecord.updatedAt`). */
	updatedAt: string;
};

export interface PersonaRuntimeDeps {
	stores: StoreContainer;
	chatOrder: IChatOrder;
	getSnapshot: (chatId: ChatId) => Promise<SessionSnapshot>;
	/** Narrowed config-patch response: set-persona / persona-update (CFR Wave B1.5). */
	buildConfigPatchResponse: (
		chatId: ChatId,
		opts?: { persona?: boolean; character?: boolean; activeChat?: boolean },
	) => Promise<ConfigPatchResponse>;
}

export class PersonaRuntime {
	private readonly deps: PersonaRuntimeDeps;

	constructor(deps: PersonaRuntimeDeps) {
		this.deps = deps;
	}

	async list(): Promise<PersonaRecord[]> {
		const personas = await this.deps.stores.personas.listAll();
		return personas.map((p) => ({
			id: p.id,
			name: p.name,
			description: p.description,
			pronouns: p.pronouns,
			avatarAssetId: p.avatarAssetId,
			avatarFullAssetId: p.avatarFullAssetId,
			avatarCropJson: p.avatarCropJson,
			avatarExt: p.avatarExt,
			avatarFullExt: p.avatarFullExt,
			defaultForNewChats: p.defaultForNewChats,
			avatarDescription: p.avatarDescription,
			includeAvatarInPrompt: p.includeAvatarInPrompt,
			updatedAt: p.updatedAt,
		}));
	}

	async create(input: {
		name: string;
		description: string;
		pronouns?: string | null;
		defaultForNewChats?: boolean;
	}): Promise<PersonaRecord> {
		const trimmedName = (input.name ?? "").trim();
		const trimmedDescription = (input.description ?? "").trim();
		if (!trimmedName) {
			throw validation("Persona name is required.");
		}
		const persona = await this.deps.stores.personas.create({
			name: trimmedName,
			description: trimmedDescription,
			pronouns: input.pronouns?.trim() || null,
			defaultForNewChats: input.defaultForNewChats === true,
		});
		return {
			id: persona.id,
			name: persona.name,
			description: persona.description,
			pronouns: persona.pronouns,
			avatarAssetId: persona.avatarAssetId,
			avatarFullAssetId: persona.avatarFullAssetId,
			avatarCropJson: persona.avatarCropJson,
			avatarExt: persona.avatarExt,
			avatarFullExt: persona.avatarFullExt,
			defaultForNewChats: persona.defaultForNewChats,
			avatarDescription: persona.avatarDescription,
			includeAvatarInPrompt: persona.includeAvatarInPrompt,
			updatedAt: persona.updatedAt,
		};
	}

	async setDefault(personaId: string): Promise<void> {
		const persona = await this.deps.stores.personas.getById(brandId<PersonaId>(personaId));
		if (!persona) {
			throw notFound("Persona", `Persona '${personaId}' was not found.`);
		}
		await this.deps.stores.personas.setDefault(personaId);
	}

	async delete(personaId: string): Promise<void> {
		try {
			await this.deps.stores.personas.delete(brandId<PersonaId>(personaId));
		} catch (error) {
			if (isDomainError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (/referenced by one or more chats/i.test(message)) {
				throw conflict(message);
			}
			if (/not found/i.test(message)) {
				throw notFound("Persona", message);
			}
			throw error;
		}
	}

	async update(
		personaId: string,
		input: {
			chatId?: ChatId;
			name?: string;
			description?: string;
			pronouns?: string | null;
			avatarAssetId?: string | null;
			avatarFullAssetId?: string | null;
			avatarCropJson?: string | null;
			// Avatar-appearance prompt injection (MEDIA_GALLERY).
			includeAvatarInPrompt?: boolean;
			avatarDescription?: string | null;
		},
	): Promise<ConfigPatchResponse | { id: string }> {
		const currentPersona = await this.deps.stores.personas.getById(brandId<PersonaId>(personaId));
		if (!currentPersona) {
			throw notFound("Persona", `Persona '${personaId}' was not found.`);
		}

		const nextName = (input.name ?? currentPersona.name).trim();
		if (!nextName) {
			throw validation("Persona name is required.");
		}

		const nextDescription = input.description ?? currentPersona.description;
		const nextPronouns = input.pronouns !== undefined ? input.pronouns : currentPersona.pronouns;
		const nextAvatarAssetId = input.avatarAssetId !== undefined ? input.avatarAssetId : currentPersona.avatarAssetId;
		const nextAvatarFullAssetId = input.avatarFullAssetId !== undefined ? input.avatarFullAssetId : currentPersona.avatarFullAssetId;
		const nextAvatarCropJson = input.avatarCropJson !== undefined ? input.avatarCropJson : currentPersona.avatarCropJson;

		await this.deps.stores.personas.update(personaId, {
			name: nextName,
			description: nextDescription,
			pronouns: nextPronouns,
			avatarAssetId: nextAvatarAssetId,
			avatarFullAssetId: nextAvatarFullAssetId,
			avatarCropJson: nextAvatarCropJson,
			includeAvatarInPrompt: input.includeAvatarInPrompt !== undefined
				? input.includeAvatarInPrompt
				: currentPersona.includeAvatarInPrompt,
			avatarDescription: input.avatarDescription !== undefined
				? input.avatarDescription
				: currentPersona.avatarDescription,
		});

		const preferredChat = input.chatId
			? await this.deps.stores.chats.getById(input.chatId)
			: null;
		const targetChatId =
			((preferredChat?.personaId === personaId ? preferredChat.id : null) ??
			(await this.deps.stores.chats.listAll()).find((chat) => chat.personaId === personaId)?.id ??
			this.deps.chatOrder.items[0]) as ChatId | undefined;

		if (!targetChatId) {
			return { id: personaId };
		}

		return this.deps.buildConfigPatchResponse(targetChatId, { persona: true });
	}

	async setChatPersona(chatId: ChatId, personaId: string): Promise<ConfigPatchResponse> {
		const [chat, persona] = await Promise.all([
			this.deps.stores.chats.getById(chatId),
			this.deps.stores.personas.getById(brandId<PersonaId>(personaId)),
		]);
		if (!chat) {
			throw notFound("Chat", `Chat '${chatId}' was not found.`);
		}
		if (!persona) {
			throw notFound("Persona", `Persona '${personaId}' was not found.`);
		}
		await this.deps.stores.chats.setPersona(chatId, personaId);
		return this.deps.buildConfigPatchResponse(chatId, { persona: true });
	}

	/**
	 * Resolves the default persona ID, creating one if none exists.
	 * Note: callers should ensure preset defaults are seeded separately
	 * (this method only handles persona defaults).
	 */
	async resolveDefaultId(): Promise<PersonaId> {
		const personas = await this.deps.stores.personas.listAll();
		if (personas.length === 0) {
			const created = await this.deps.stores.personas.create({
				name: "User",
				description: "",
				pronouns: null,
				defaultForNewChats: true,
			});
			return created.id as PersonaId;
		}

		const defaultPersona =
			personas.find((persona) => persona.defaultForNewChats) ?? personas[0];
		if (!defaultPersona) {
			throw internal("No persona is available for new chats.");
		}
		return defaultPersona.id as PersonaId;
	}

	async duplicate(personaId: string): Promise<PersonaRecord> {
		const source = await this.deps.stores.personas.getById(brandId<PersonaId>(personaId));
		if (!source) {
			throw notFound("Persona", `Persona '${personaId}' was not found.`);
		}

		const persona = await this.deps.stores.personas.create({
			name: source.name + " (copy)",
			description: source.description,
			pronouns: source.pronouns,
			avatarAssetId: source.avatarAssetId,
			avatarFullAssetId: source.avatarFullAssetId,
			avatarCropJson: source.avatarCropJson,
			avatarExt: source.avatarExt,
			avatarFullExt: source.avatarFullExt,
			avatarDescription: source.avatarDescription,
			includeAvatarInPrompt: source.includeAvatarInPrompt,
		});

		// Copy the folder-resident avatar (if any) into the duplicate's own folder.
		if (source.avatarExt) {
			const buf = await this.deps.stores.content.readBinary(STORAGE_FOLDERS.personas, source.id, `avatar.${source.avatarExt}`);
			if (buf) {
				await this.deps.stores.content.writeBinary(STORAGE_FOLDERS.personas, persona.id, `avatar.${source.avatarExt}`, new Uint8Array(buf));
			}
		}
		// Copy the folder-resident FULL avatar (if any) into the duplicate's folder.
		if (source.avatarFullExt) {
			const buf = await this.deps.stores.content.readBinary(STORAGE_FOLDERS.personas, source.id, `avatar-full.${source.avatarFullExt}`);
			if (buf) {
				await this.deps.stores.content.writeBinary(STORAGE_FOLDERS.personas, persona.id, `avatar-full.${source.avatarFullExt}`, new Uint8Array(buf));
			}
		}

		// Duplicate persona-scoped lorebooks
		const sourceLorebooks = await this.deps.stores.lorebooks.listLorebooksByScope("persona", personaId);
		for (const lb of sourceLorebooks) {
			const entries = await this.deps.stores.lorebooks.listEntries(lb.id);
			const newLb = await this.deps.stores.lorebooks.createLorebook({
				name: lb.name,
				description: lb.description,
				scopeType: "persona",
				personaId: persona.id,
				scanDepth: lb.scanDepth,
				recursiveScanning: lb.recursiveScanning,
				enabled: lb.enabled,
			});
			await this.deps.stores.lorebooks.bulkCreateEntries(newLb.id, entries.map(e => ({
				keys: e.keys,
				secondaryKeys: e.secondaryKeys,
				content: e.content,
				logic: e.logic,
				position: e.position,
				depth: e.depth,
				priority: e.priority,
				probability: e.probability,
				constant: e.constant,
				enabled: e.enabled,
				groupName: e.groupName,
				groupWeight: e.groupWeight,
				cooldownWindow: e.cooldownWindow,
				delayWindow: e.delayWindow,
				stickyWindow: e.stickyWindow,
				scanDepthOverride: e.scanDepthOverride,
				matchWholeWords: e.matchWholeWords,
				matchSources: e.matchSources,
				triggers: e.triggers,
				characterFilter: e.characterFilter,
				excludeRecursion: e.excludeRecursion,
				preventRecursion: e.preventRecursion,
				caseSensitive: e.caseSensitive,
			})));
		}

		// Duplicate persona-scoped scripts
		const sourceScripts = await this.deps.stores.scripts.listByScope("persona", personaId);
		for (const sc of sourceScripts) {
			await this.deps.stores.scripts.create({
				name: sc.name,
				description: sc.description,
				code: sc.code,
				scopeType: "persona",
				personaId: persona.id,
				enabled: sc.enabled,
				sortOrder: sc.sortOrder,
			});
		}

		return {
			id: persona.id,
			name: persona.name,
			description: persona.description,
			pronouns: persona.pronouns,
			avatarAssetId: persona.avatarAssetId,
			avatarFullAssetId: persona.avatarFullAssetId,
			avatarCropJson: persona.avatarCropJson,
			avatarExt: persona.avatarExt,
			avatarFullExt: persona.avatarFullExt,
			defaultForNewChats: persona.defaultForNewChats,
			avatarDescription: persona.avatarDescription,
			includeAvatarInPrompt: persona.includeAvatarInPrompt,
			updatedAt: persona.updatedAt,
		};
	}
}
