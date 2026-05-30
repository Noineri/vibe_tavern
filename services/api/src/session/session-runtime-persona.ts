import type { StoreContainer } from "@vibe-tavern/db";
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
} from "../errors.js";
import type { IChatOrder } from "./session-runtime-chat-order.js";
import type { SessionSnapshot } from "./session-runtime.js";

export interface PersonaRuntimeDeps {
	stores: StoreContainer;
	chatOrder: IChatOrder;
	getSnapshot: (chatId: ChatId) => Promise<SessionSnapshot>;
}

export class PersonaRuntime {
	private readonly deps: PersonaRuntimeDeps;

	constructor(deps: PersonaRuntimeDeps) {
		this.deps = deps;
	}

	async list(): Promise<Array<{
		id: string;
		name: string;
		description: string;
		pronouns: string | null;
		avatarAssetId: string | null;
		avatarFullAssetId: string | null;
	}>> {
		const personas = await this.deps.stores.personas.listAll();
		return personas.map((p) => ({
			id: p.id,
			name: p.name,
			description: p.description,
			pronouns: p.pronouns,
			avatarAssetId: p.avatarAssetId,
			avatarFullAssetId: p.avatarFullAssetId,
		}));
	}

	async create(input: {
		name: string;
		description: string;
		pronouns?: string | null;
		defaultForNewChats?: boolean;
	}): Promise<{
		id: string;
		name: string;
		description: string;
		pronouns: string | null;
		avatarAssetId: string | null;
		avatarFullAssetId: string | null;
	}> {
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
		};
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
		},
	): Promise<SessionSnapshot> {
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

		await this.deps.stores.personas.update(personaId, {
			name: nextName,
			description: nextDescription,
			pronouns: nextPronouns,
			avatarAssetId: nextAvatarAssetId,
			avatarFullAssetId: nextAvatarFullAssetId,
		});

		const preferredChat = input.chatId
			? await this.deps.stores.chats.getById(input.chatId)
			: null;
		const targetChatId =
			((preferredChat?.personaId === personaId ? preferredChat.id : null) ??
			(await this.deps.stores.chats.listAll()).find((chat) => chat.personaId === personaId)?.id ??
			this.deps.chatOrder.items[0]) as ChatId | undefined;

		if (!targetChatId) {
			throw notFound("Chat", "No chat is available for the updated persona.");
		}

		return this.deps.getSnapshot(targetChatId);
	}

	async setChatPersona(chatId: ChatId, personaId: string): Promise<SessionSnapshot> {
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
		return this.deps.getSnapshot(chatId);
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

	async duplicate(personaId: string): Promise<{
		id: string;
		name: string;
		description: string;
		pronouns: string | null;
		avatarAssetId: string | null;
		avatarFullAssetId: string | null;
	}> {
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
		});

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
				groupName: e.group,
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
		};
	}
}
