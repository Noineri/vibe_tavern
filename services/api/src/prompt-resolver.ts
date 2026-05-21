import type { StoreContainer } from "@rp-platform/db";
import {
	type ChatBranchId,
	type ChatId,
	type LoreEntry,
	type RetrievedMemoryHit,
	type Character,
} from "@rp-platform/domain";
import { notFound } from "./errors.js";
import {
	type CharacterRecord,
	type PersonaRecord,
	toCharacterRecord,
} from "./session-runtime-character.js";
import {
	type PromptAssemblyResolver,
} from "./prompt-assembly-service.js";

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
		// Phase 1: no lorebook support
		void input;
		return [];
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
