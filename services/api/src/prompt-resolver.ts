import type { StoreContainer } from "@rp-platform/db";
import {
	type ChatBranchId,
	type ChatId,
	type LoreEntry,
	type RetrievedMemoryHit,
	type Character,
} from "@rp-platform/domain";
import { brandId } from "@rp-platform/domain";
import { notFound } from "./errors.js";
import {
	type CharacterRecord,
	type PersonaRecord,
	toCharacterRecord,
} from "./session-runtime-character.js";
import {
	type PromptAssemblyResolver,
} from "./prompt-assembly-service.js";
import {
	resolveActivatedEntries,
	type LoreActivationState,
} from "./lore-activation-engine.js";

export class StaticPromptResolver implements PromptAssemblyResolver {
	constructor(private readonly stores: StoreContainer) {}

	async getCharacter(characterId: string): Promise<CharacterRecord> {
		const character = await this.stores.characters.getById(characterId);
		if (!character) {
			throw notFound("Character", `Character '${characterId}' was not found.`);
		}
		// No character versions in phase 1
		return toCharacterRecord(character as unknown as Character, null);
	}

	async getPersona(personaId: string): Promise<PersonaRecord | null> {
		const p = await this.stores.personas.getById(personaId);
		if (!p) return null;
		return { id: p.id, name: p.name, description: p.description, pronouns: p.pronouns, avatarAssetId: p.avatarAssetId, avatarFullAssetId: p.avatarFullAssetId };
	}

	async getPromptPreset(presetId: string) {
		const preset = await this.stores.presets.getById(presetId);
		if (!preset) return null;
		return {
			id: preset.id,
			name: preset.name,
			text: preset.systemPrompt,
			jailbreak: preset.postHistoryInstructions,
			summary: preset.summaryPrompt,
			tools: preset.toolsPrompt,
			prefill: preset.assistantPrefix,
			authorsNote: preset.authorsNote,
			authorsNoteDepth: preset.authorsNoteDepth,
		};
	}

	async listActiveLoreEntries(input: {
		chatId: ChatId;
		branchId: ChatBranchId;
		recentText: string;
	}): Promise<LoreEntry[]> {
		const chat = await this.stores.chats.getById(input.chatId);
		if (!chat) return [];

		// 1. Load lorebooks with entries for this chat
		const lorebookSets = await this.stores.lorebooks.listAllActiveForChat(
			chat.characterId,
			chat.personaId,
			input.chatId,
		);

		if (lorebookSets.length === 0) return [];

		// 2. Load messages for scan depth
		const messages = await this.stores.chats.getMessages(input.branchId);
		const recentMessages = messages.map(m => ({
			role: m.role,
			content: m.content,
		}));

		// 3. Load character name for macro resolution + character filter
		const character = await this.stores.characters.getById(chat.characterId);
		if (!character) return [];

		// 4. Build macro map
		const allPersonas = await this.stores.personas.listAll();
		const effectivePersonaId = chat.personaId ?? allPersonas.find(p => p.defaultForNewChats)?.id ?? allPersonas[0]?.id;
		const persona = effectivePersonaId ? await this.stores.personas.getById(effectivePersonaId) : null;
		const macroMap: Record<string, string> = {
			'{{user}}': persona?.name ?? 'User',
			'{{char}}': character.name,
		};

		// 5. Use activation state from typed Chat object (already parsed by mapRow)
		const activationState = (chat.loreActivationState ?? {}) as LoreActivationState;

		// 6. Estimate current turn from message count
		const currentTurn = messages.length;

		// 7. Run activation engine
		const result = resolveActivatedEntries({
			lorebooks: lorebookSets.map(lb => ({
				id: lb.lorebook.id,
				scanDepth: lb.lorebook.scanDepth,
				tokenBudget: lb.lorebook.tokenBudget,
				recursiveScanning: lb.lorebook.recursiveScanning,
				entries: lb.entries,
			})),
			messages: recentMessages,
			mode: 'normal',
			macroMap,
			characterName: character.name,
			characterDescription: character.description,
			personaDescription: persona?.description,
			activationState,
			currentTurn,
		});

		// 8. Persist updated activation state
		await this.stores.chats.updateLoreActivationState(chat.id, result.updatedState);

		// 9. Map activated entries back to domain LoreEntry type
		const activatedIds = new Set(result.activatedEntries.map(e => e.id));
		return lorebookSets
			.flatMap(lb => lb.entries)
			.filter(e => activatedIds.has(e.id))
			.map(e => ({
				id: brandId<LoreEntry['id']>(e.id),
				lorebookId: brandId<LoreEntry['lorebookId']>(e.lorebookId),
				title: e.title,
				content: e.content,
				keys: e.keys,
				secondaryKeys: e.secondaryKeys,
				logic: e.logic as LoreEntry['logic'],
				position: e.position as LoreEntry['position'],
				depth: e.depth,
				priority: e.priority,
				stickyWindow: e.stickyWindow,
				cooldownWindow: e.cooldownWindow,
				delayWindow: e.delayWindow,
				constant: e.constant,
				probability: e.probability,
				role: e.role as LoreEntry['role'],
				group: e.group,
				groupWeight: e.groupWeight,
				prioritizeInclusion: e.prioritizeInclusion,
				excludeRecursion: e.excludeRecursion,
				preventRecursion: e.preventRecursion,
				delayUntilRecursion: e.delayUntilRecursion,
				recursionLevel: e.recursionLevel,
				scanDepthOverride: e.scanDepthOverride,
				caseSensitive: e.caseSensitive,
				matchWholeWords: e.matchWholeWords,
				characterFilter: e.characterFilter as LoreEntry['characterFilter'],
				characterFilterExclude: e.characterFilterExclude,
				triggers: e.triggers as LoreEntry['triggers'],
				matchSources: e.matchSources as LoreEntry['matchSources'],
				enabled: e.enabled,
				sortOrder: e.sortOrder,
				metadata: e.metadata,
			}));
	}

	async listRetrievedMemories(input: {
		chatId: ChatId;
		branchId: ChatBranchId;
		recentText: string;
	}): Promise<RetrievedMemoryHit[]> {
		void input;
		return [];
	}

	getToolInstructions(): string | null {
		return null;
	}
}
