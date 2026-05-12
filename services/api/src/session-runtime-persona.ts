import type { StoreContainer } from "@rp-platform/db";
import {
	brandId,
	type ChatBranchId,
	type ChatId,
	type PersonaId,
} from "@rp-platform/domain";
import {
	conflict,
	internal,
	isDomainError,
	notFound,
	validation,
} from "./errors.js";
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
	}>> {
		const personas = await this.deps.stores.personas.listAll();
		return personas.map((p) => ({
			id: p.id,
			name: p.name,
			description: p.description,
			pronouns: p.pronouns,
			avatarAssetId: p.avatarAssetId,
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

		await this.deps.stores.personas.update(personaId, {
			name: nextName,
			description: nextDescription,
			pronouns: nextPronouns,
			avatarAssetId: nextAvatarAssetId,
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
}
