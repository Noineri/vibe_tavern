import type { StoreContainer } from "@vibe-tavern/db";
import { countTokens } from "../../infrastructure/ai/tokenizer-service.js";
import {
	type ChatBranchId,
	type ChatId,
	type CharacterId,
	type LoreEntry,
	type ActiveLoreEntry,
	type ActiveLoreEntriesResult,
	type RetrievedMemoryHit,
	type CustomInjection,
	type GenerationFormat,
	type PromptOrderEntry,
} from "@vibe-tavern/domain";
import { brandId } from "@vibe-tavern/domain";
import { buildPromptVariableContext, createFullMacroEngine } from "@vibe-tavern/prompt-pipeline";
import { notFound } from "../../shared/errors.js";
import {
	type CharacterRecord,
	toCharacterRecord,
} from "../character/character-runtime.js";
import { resolveSummaryPrompt } from "./summary-prompt.js";
import type { PersonaRecord } from "../persona/persona-runtime.js";
import {
	type PromptAssemblyResolver,
} from "./prompt-assembly-service.js";
import {
	resolveActivatedEntries,
	type LoreActivationState,
} from "./lore-activation-engine.js";
import { executeScripts } from "../scripts-engine/script-sandbox.js";
import { RegexHookService } from "../regex/regex-hook-service.js";

export class StaticPromptResolver implements PromptAssemblyResolver {
	constructor(
		private readonly stores: StoreContainer,
		/** WORLD_INFO regex hook (RX-9) — transforms activated lore-entry content. */
		private readonly regexHooks: RegexHookService,
	) {}

	async getCharacter(characterId: string): Promise<CharacterRecord> {
		const character = await this.stores.characters.getById(characterId);
		if (!character) {
			throw notFound("Character", `Character '${characterId}' was not found.`);
		}
		return toCharacterRecord({ ...character, id: brandId<CharacterId>(character.id) });
	}

	async getPersona(personaId: string): Promise<PersonaRecord | null> {
		const p = await this.stores.personas.getById(personaId);
		if (!p) return null;
		return { id: p.id, name: p.name, description: p.description, pronouns: p.pronouns, pronounForms: p.pronounForms, avatarAssetId: p.avatarAssetId, avatarFullAssetId: p.avatarFullAssetId, avatarCropJson: p.avatarCropJson, avatarExt: p.avatarExt, avatarFullExt: p.avatarFullExt, defaultForNewChats: p.defaultForNewChats, avatarDescription: p.avatarDescription, includeAvatarInPrompt: p.includeAvatarInPrompt, updatedAt: p.updatedAt };
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
		mergeConsecutiveRoles: boolean;
		/** Generation format (LOCAL_SUPPORT_PLAN LS-3a). Absent = auto. */
		generationFormat?: GenerationFormat;
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
			summary: await resolveSummaryPrompt(this.stores.db),
			tools: preset.toolsPrompt,
			prefill: preset.assistantPrefix,
			authorsNote: preset.authorsNote,
			authorsNoteDepth: preset.authorsNoteDepth,
			authorsNotePosition: (preset.authorsNotePosition as "in_prompt" | "in_chat" | "after_chat") ?? "in_chat",
			authorsNoteRole: (preset.authorsNoteRole as "system" | "user" | "assistant") ?? "system",
			nsfw: preset.nsfwPrompt,
			enhanceDefinitions: preset.enhanceDefinitionsPrompt,
			advancedMode: preset.advancedMode,
			mergeConsecutiveRoles: preset.mergeConsecutiveRoles,
			generationFormat: preset.generationFormat,
			customInjections: preset.customInjections,
			promptOrder: preset.promptOrder,
		};
	}

	async listActiveLoreEntries(input: {
		chatId: ChatId;
		branchId: ChatBranchId;
		recentText: string;
		scanMessages: Array<{ role: string; content: string }>;
		/** Effective preset Author's Note, passed from prompt assembly (P15). */
		authorsNote?: string;
		/** Enabled summary texts, passed from prompt assembly (P15). */
		summaries?: string[];
		/** Turn clock override — the FULL branch count. Defaults to the scan
		 * count only for direct test callers; production passes the branch total
		 * so sticky/cooldown windows don't shift with prompt exclusions (P13). */
		currentTurn?: number;
		/** Resolve active entries without changing branch timed state. */
		dryRun?: boolean;
		maxContextTokens?: number;
	}): Promise<ActiveLoreEntriesResult> {
		const chat = await this.stores.chats.getById(input.chatId);
		if (!chat) return { entries: [], overflowedLorebooks: [] };

		// 1. Load lorebooks with entries for this chat
		const lorebookSets = await this.stores.lorebooks.listAllActiveForChat(
			chat.characterId,
			chat.personaId,
			input.chatId,
		);

		if (lorebookSets.length === 0) return { entries: [], overflowedLorebooks: [] };

		// 2. Scan the assembly's effective branch messages. P13 deliberately keeps
		// this separate from the prompt's history-limit window; see the assembly's
		// ST coreChat rationale (public/script.js:4437–4440).
		const recentMessages = input.scanMessages;

		// 3. Load character name for macro resolution + character filter
		const character = await this.stores.characters.getById(chat.characterId);
		if (!character) return { entries: [], overflowedLorebooks: [] };

		// 4. Build macro map
		const allPersonas = await this.stores.personas.listAll();
		const effectivePersonaId = chat.personaId ?? allPersonas.find(p => p.defaultForNewChats)?.id ?? allPersonas[0]?.id;
		const persona = effectivePersonaId ? await this.stores.personas.getById(effectivePersonaId) : null;
		const macroMap: Record<string, string> = {
			'{{user}}': persona?.name ?? 'User',
			'{{char}}': character.name,
		};
		// P16: lore keys/content share the pipeline's full macro vocabulary. A
		// fresh synchronous engine is bound for this activation resolve, so the
		// pure lore engine receives only text→text substitution and stays free of
		// prompt-context construction or I/O.
		const macroEngine = createFullMacroEngine();
		const macroContext = buildPromptVariableContext({
			character: {
				name: character.name,
				description: character.description,
				personality: character.personalitySummary,
				scenario: character.defaultScenario,
				firstMessage: character.firstMessage,
				alternateGreetings: character.alternateGreetings,
				mesExample: character.mesExample,
				postHistoryInstructions: character.postHistoryInstructions,
				creatorNotes: character.creatorNotes,
				depthPrompt: character.depthPrompt,
				depthPromptDepth: character.depthPromptDepth,
				depthPromptRole: character.depthPromptRole,
				systemPrompt: character.systemPrompt,
			},
			persona: persona ? {
				name: persona.name,
				description: persona.description,
				pronouns: persona.pronouns,
				pronounForms: persona.pronounForms,
			} : undefined,
			chat: {
				messages: recentMessages.map((message, index) => ({
					id: `lore_scan_${index}`,
					role: message.role,
					content: message.content,
				})),
				lastMessage: recentMessages.at(-1)?.content ?? null,
				lastUserMessage: recentMessages.findLast(message => message.role === "user")?.content ?? null,
				lastCharMessage: recentMessages.findLast(message => message.role === "assistant")?.content ?? null,
			},
			prompt: {
				authorsNote: input.authorsNote ?? null,
				summary: chat.summary ?? "",
			},
			runtime: { contextBudget: input.maxContextTokens ?? null },
		});
		const recentMessagesWithNames = recentMessages.map(message => ({
			...message,
			// ST scans `${name}: ${message}` when includeNames is enabled
			// (public/script.js 4563-4572); ST's name1 defaults to "User", so the
			// persona-less fallback mirrors both ST and the macroMap above.
			// System/tool messages have no real speaker name — engine keeps them
			// unprefixed.
			name: message.role === "assistant"
				? character.name
				: message.role === "user"
					? persona?.name ?? "User"
					: undefined,
		}));

		// 5. Timed state belongs to the selected branch, not its parent chat:
		// SillyTavern branches are separate chat files with independent metadata.
		const branch = await this.stores.chats.getBranch(input.branchId);
		if (!branch || branch.chatId !== chat.id) return { entries: [], overflowedLorebooks: [] };
		const activationState = branch.loreActivationState as LoreActivationState;

		// 6. Turn clock: the full branch count when the assembly provides it; the
		// scan count is only a fallback for direct callers (sticky/cooldown
		// windows must not shift when the prompt excludes messages — P13 keeps
		// exclusions scoped to the scan input).
		const currentTurn = input.currentTurn ?? recentMessages.length;

		// 7. Run activation engine
		const result = resolveActivatedEntries({
			lorebooks: lorebookSets.map(lb => ({
				id: lb.lorebook.id,
				scanDepth: lb.lorebook.scanDepth,
				tokenBudget: lb.lorebook.tokenBudget,
				tokenBudgetPercent: lb.lorebook.tokenBudgetPercent,
				tokenBudgetCap: lb.lorebook.tokenBudgetCap,
				recursiveScanning: lb.lorebook.recursiveScanning,
				useGroupScoring: lb.lorebook.useGroupScoring,
				caseSensitive: lb.lorebook.caseSensitive,
				matchWholeWords: lb.lorebook.matchWholeWords,
				maxRecursionSteps: lb.lorebook.maxRecursionSteps,
				includeNames: lb.lorebook.includeNames,
				minActivations: lb.lorebook.minActivations,
				minActivationsDepthMax: lb.lorebook.minActivationsDepthMax,
				entries: lb.entries,
			})),
			messages: recentMessagesWithNames,
			macroMap,
			resolveMacros: (text) => macroEngine.resolve(text, macroContext),
			characterId: character.id,
			characterName: character.name,
			characterDescription: character.description,
			personaDescription: persona?.description,
			characterPersonality: character.personalitySummary ?? undefined,
			characterNote: character.depthPrompt ?? undefined,
			scenario: character.defaultScenario ?? undefined,
			creatorNotes: character.creatorNotes ?? undefined,
			authorsNote: input.authorsNote,
			summaries: input.summaries,
			activationState,
			currentTurn,
			dryRun: input.dryRun,
			estimateTokenCount: countTokens,
			maxContextTokens: input.maxContextTokens,
		});

		// 8. Only live generation resolves persist timed state. Dry-run callers
		// receive the same active-entry view without consuming sticky/cooldown.
		if (!input.dryRun) {
			await this.stores.chats.updateLoreActivationState(branch.id, result.updatedState);
		}

		// 9. Map activated entries back to domain LoreEntry type, carrying the
		//    structured activation reason through for the prompt trace.
		const reasonById = new Map(result.activatedEntries.map(e => [e.id, e]));
		const activatedIds = new Set(result.activatedEntries.map(e => e.id));
		const activeEntries: ActiveLoreEntry[] = lorebookSets
			.flatMap(lb => lb.entries)
			.filter(e => activatedIds.has(e.id))
			.map(e => {
				const detail = reasonById.get(e.id)!;
				return {
					id: brandId<LoreEntry['id']>(e.id),
					lorebookId: brandId<LoreEntry['lorebookId']>(e.lorebookId),
					title: e.title,
					// The engine commits macro-expanded content; keep the stored row
					// raw while carrying its resolved prompt view through regex/assembly.
					content: detail.content,
					keys: e.keys,
				secondaryKeys: e.secondaryKeys,
				logic: e.logic as LoreEntry['logic'],
				position: e.position as LoreEntry['position'],
				depth: e.depth,
				priority: e.priority,
				stickyWindow: e.stickyWindow,
				cooldownWindow: e.cooldownWindow,
				minChatMessages: e.minChatMessages,
				constant: e.constant,
				probability: e.probability,
				ignoreBudget: e.ignoreBudget,
				role: e.role as LoreEntry['role'],
				groupName: e.groupName,
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
				matchSources: e.matchSources as LoreEntry['matchSources'],
				enabled: e.enabled,
				sortOrder: e.sortOrder,
				automationId: e.automationId,
				metadata: e.metadata,
				activationReason: detail.reason,
				matchedKeys: detail.matchedKeys,
				matchCount: detail.matchCount,
			};
		});

		// 10. WORLD_INFO regex hook (RX-9): the activation engine has already
		//     macro-expanded this lore-only prompt view before recursion commits.
		//     The hook therefore sees the same expanded content ST passes to its
		//     WORLD_INFO regex scripts (world-info.js:4938-4939, 5085-5086). The
		//     lorebook row remains raw and is never rewritten.
		const entries = await this.regexHooks.transformWorldInfo(input.chatId, activeEntries, {
			characterId: chat.characterId,
			presetId: chat.promptPresetId ?? null,
			macroMap,
		});

		// P21 (overflowAlert): enrich the engine's per-book overflow report with
		// the book's name + its overflowAlert flag — the single place that has
		// both (the engine knows only ids; the flag is a per-book setting, not
		// engine logic). The trace keeps the full list; the live-turn finish
		// event filters to alert-on books (see appendAssistantReply).
		const lorebookById = new Map(lorebookSets.map(set => [set.lorebook.id, set.lorebook]));
		const overflowedLorebooks = result.overflowedBooks.map(o => ({
			lorebookId: o.lorebookId,
			name: lorebookById.get(o.lorebookId)?.name ?? o.lorebookId,
			dropped: o.dropped,
			alert: lorebookById.get(o.lorebookId)?.overflowAlert ?? false,
		}));

		return { entries, overflowedLorebooks };
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
		/** Effective persona for the turn. Passed through to the sandbox as
		 *  `context.persona` (read-only). Optional — absent when no persona is
		 *  resolved, in which case scripts see `context.persona` as undefined. */
		persona?: { name: string; description: string };
	}): Promise<{
		personality: string;
		scenario: string;
		injectedMessages: Array<{ content: string; role: 'system' | 'user' | 'assistant' }>;
		errors: Array<{ scriptId: string; scriptName: string; error: string }>;
		/** Per-script breakdown of the turn (P4). Order matches execution order.
		 *  Empty when no scripts ran. Carries each script's status, mutations,
		 *  injected messages, console, and error so the trace can render them. */
		scriptRuns: Array<{
			scriptId: string;
			scriptName: string;
			status: 'ran' | 'errored';
			personalityMutation: string;
			scenarioMutation: string;
			injectedMessages: Array<{ content: string; role: 'system' | 'user' | 'assistant' }>;
			console: Array<{ level: 'log' | 'warn' | 'error'; args: string }>;
			error?: string;
			line?: number;
		}>;
	}> {
		const defaultResult = {
			personality: input.characterRecord.personality ?? '',
			scenario: input.characterRecord.scenario ?? '',
			injectedMessages: [] as Array<{ content: string; role: 'system' | 'user' | 'assistant' }>,
			errors: [] as Array<{ scriptId: string; scriptName: string; error: string }>,
			scriptRuns: [] as Array<{
				scriptId: string;
				scriptName: string;
				status: 'ran' | 'errored';
				personalityMutation: string;
				scenarioMutation: string;
				injectedMessages: Array<{ content: string; role: 'system' | 'user' | 'assistant' }>;
				console: Array<{ level: 'log' | 'warn' | 'error'; args: string }>;
				error?: string;
				line?: number;
			}>,
		};

		const chat = await this.stores.chats.getById(input.chatId);
		if (!chat) return defaultResult;

		// 1. Load enabled PROMPT scripts for this chat. listAllEnabledForChat is
		//    already prompt-kind-only (Wave B1 store split), so Dice and interactive
		//    scripts never reach here in production. The filter below is
		//    defense-in-depth: even if a non-prompt record somehow crossed the store
		//    boundary, it would never execute inside the prompt-script VM
		//    (script-sandbox.ts). A Dice script has its own isolated runtime
		//    (dice-script-sandbox.ts) and an interactive script its own experience
		//    kernel (interactive/experience-kernel.ts); neither may mutate prompt
		//    fields, inject messages, or run during assembly.
		const scripts = (await this.stores.scripts.listAllEnabledForChat(
			chat.characterId,
			chat.personaId,
			input.chatId,
		)).filter(s => s.scriptKind !== 'dice' && s.scriptKind !== 'interactive');

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
			persona: input.persona,
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
			scriptRuns: result.scriptRuns.map(r => ({
				scriptId: r.scriptId,
				scriptName: r.scriptName,
				status: r.status,
				personalityMutation: r.personalityMutation,
				scenarioMutation: r.scenarioMutation,
				injectedMessages: r.injectedMessages,
				console: r.console,
				error: r.error,
				line: r.line,
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
