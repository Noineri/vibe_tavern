import type { StoreContainer } from "@vibe-tavern/db";
import { countTokens } from "../../infrastructure/ai/tokenizer-service.js";
import {
	type ChatBranchId,
	type ChatId,
	type CharacterId,
	type LoreEntry,
	type RetrievedMemoryHit,
	type CustomInjection,
	type PromptOrderEntry,
} from "@vibe-tavern/domain";
import { brandId } from "@vibe-tavern/domain";
import { notFound } from "../../shared/errors.js";
import {
	type CharacterRecord,
	toCharacterRecord,
} from "../character/character-runtime.js";
import type { PersonaRecord } from "../persona/persona-runtime.js";
import {
	type PromptAssemblyResolver,
} from "./prompt-assembly-service.js";
import {
	resolveActivatedEntries,
	type LoreActivationState,
} from "./lore-activation-engine.js";
import { executeScripts } from "../scripts-engine/script-sandbox.js";

export class StaticPromptResolver implements PromptAssemblyResolver {
	constructor(private readonly stores: StoreContainer) {}

	async getCharacter(characterId: string): Promise<CharacterRecord> {
		const character = await this.stores.characters.getById(characterId);
		if (!character) {
			throw notFound("Character", `Character '${characterId}' was not found.`);
		}
		// No character versions in phase 1
		return toCharacterRecord({ ...character, id: brandId<CharacterId>(character.id) }, null);
	}

	async getPersona(personaId: string): Promise<PersonaRecord | null> {
		const p = await this.stores.personas.getById(personaId);
		if (!p) return null;
		return { id: p.id, name: p.name, description: p.description, pronouns: p.pronouns, avatarAssetId: p.avatarAssetId, avatarFullAssetId: p.avatarFullAssetId, avatarCropJson: p.avatarCropJson };
	}

	async getPromptPreset(presetId: string): Promise<{
		id: string;
		name: string;
		text: string;
		jailbreak: string;
		summary: string;
		tools: string;
		prefill: string;
		authorsNote: string;
		authorsNoteDepth: number;
		authorsNotePosition: string;
		authorsNoteRole: string;
		nsfw: string;
		enhanceDefinitions: string;
		/** Whether this preset is in advanced (canvas) mode. */
		advancedMode: boolean;
		customInjections: CustomInjection[];
		promptOrder: PromptOrderEntry[];
	} | null> {
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
			authorsNotePosition: (preset.authorsNotePosition as "in_prompt" | "in_chat" | "after_chat") ?? "in_chat",
			authorsNoteRole: (preset.authorsNoteRole as "system" | "user" | "assistant") ?? "system",
			nsfw: preset.nsfwPrompt,
			enhanceDefinitions: preset.enhanceDefinitionsPrompt,
			advancedMode: preset.advancedMode,
			customInjections: preset.customInjections,
			promptOrder: preset.promptOrder,
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
				maxRecursionSteps: lb.lorebook.maxRecursionSteps,
				includeNames: lb.lorebook.includeNames,
				minActivations: lb.lorebook.minActivations,
				minActivationsDepthMax: lb.lorebook.minActivationsDepthMax,
				entries: lb.entries,
			})),
			messages: recentMessages,
			mode: 'normal',
			macroMap,
			characterName: character.name,
			characterDescription: character.description,
			personaDescription: persona?.description,
			characterPersonality: character.personalitySummary ?? undefined,
			characterNote: character.depthPrompt ?? undefined,
			scenario: character.defaultScenario ?? undefined,
			creatorNotes: character.creatorNotes ?? undefined,
			activationState,
			currentTurn,
			estimateTokenCount: countTokens,
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
				ignoreBudget: e.ignoreBudget,
				role: e.role as LoreEntry['role'],
				group: e.group,
				groupWeight: e.groupWeight,
				prioritizeInclusion: e.prioritizeInclusion,
				useGroupScoring: e.useGroupScoring,
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
				automationId: e.automationId,
				metadata: e.metadata,
			}));
	}

	async executeScripts(input: {
		chatId: ChatId;
		characterRecord: {
			name: string;
			personality: string | null;
			scenario: string | null;
		};
		messages: Array<{ role: string; content: string }>;
		activeLoreEntries: LoreEntry[];
		mode: string;
	}): Promise<{
		personality: string;
		scenario: string;
		injectedMessages: Array<{ content: string; role: 'system' | 'user' | 'assistant' }>;
		errors: Array<{ scriptId: string; scriptName: string; error: string }>;
	}> {
		const defaultResult = {
			personality: input.characterRecord.personality ?? '',
			scenario: input.characterRecord.scenario ?? '',
			injectedMessages: [] as Array<{ content: string; role: 'system' | 'user' | 'assistant' }>,
			errors: [] as Array<{ scriptId: string; scriptName: string; error: string }>,
		};

		const chat = await this.stores.chats.getById(input.chatId);
		if (!chat) return defaultResult;

		// 1. Load enabled scripts for this chat
		const scripts = await this.stores.scripts.listAllEnabledForChat(
			chat.characterId,
			chat.personaId,
			input.chatId,
		);

		if (scripts.length === 0) return defaultResult;

		// 2. Read current script state from typed Chat object
		const scriptState = chat.scriptState ?? {};

		// 3. Run scripts
		const result = executeScripts({
			scripts: scripts.map(s => ({
				id: s.id,
				name: s.name,
				code: s.code,
				sortOrder: s.sortOrder,
			})).sort((a, b) => a.sortOrder - b.sortOrder),
			chat: {
				messages: input.messages.map(m => ({
					message: m.content,
					role: m.role,
				})),
			},
			character: {
				name: input.characterRecord.name,
				personality: input.characterRecord.personality ?? '',
				scenario: input.characterRecord.scenario ?? '',
			},
			activeLoreEntries: input.activeLoreEntries.map(e => ({
				title: e.title,
				content: e.content,
				keys: e.keys,
			})),
			scriptState,
		});

		// 4. Persist updated script state
		try {
			await this.stores.chats.updateScriptState(chat.id, result.updatedScriptState);
		} catch { /* don't crash pipeline on state persistence failure */ }

		return {
			personality: result.character.personality,
			scenario: result.character.scenario,
			injectedMessages: result.injectedMessages,
			errors: result.errors.map(e => ({
				scriptId: e.scriptId,
				scriptName: e.scriptName,
				error: e.error,
			})),
		};
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
