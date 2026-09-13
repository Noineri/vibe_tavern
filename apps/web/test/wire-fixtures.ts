/**
 * Complete wire-record factories for tests. The types are the route-inferred
 * records from `src/api/types.ts`, so a field the server adds to a response
 * breaks this file once instead of every fixture. Spread a factory first, then
 * override only what the test pins.
 */
import type { LoreEntryRecord, LorebookRecord, ScriptRecord, UiSettingsRecord } from "../src/api/types.js";

const EPOCH = "2026-01-01T00:00:00.000Z";

export function wireUiSettings(): UiSettingsRecord {
	return {
		id: "default",
		theme: "dark",
		chatFontSize: 15,
		uiFontSize: 14,
		messageWidth: 700,
		language: "en",
		activePromptPresetId: null,
		aiAssistantProviderId: null,
		aiAssistantModelName: null,
		summaryProviderId: null,
		summaryModelName: null,
		messageEditorProviderId: null,
		messageEditorModelName: null,
		coauthorProviderId: null,
		coauthorModelName: null,
		coauthorMaxTokens: null,
		coauthorContextBudget: null,
		githubStarred: false,
		userMessageCount: 0,
		nextStarPromptAt: 10,
		starPromptDeferrals: 0,
		copilotProviderId: null,
		copilotModelName: null,
		activeServicePromptProfileId: null,
		servicePromptPresetMigrated: false,
		activeDictationProfileId: null,
		activeVoiceMessageProfileId: null,
		updatedAt: EPOCH,
	};
}

export function wireScript(): ScriptRecord {
	return {
		id: "script",
		name: "",
		description: "",
		code: "",
		enabled: true,
		scriptKind: "prompt",
		creationIntentId: null,
		scopeType: "global",
		sortOrder: 0,
		characterId: null,
		personaId: null,
		chatId: null,
		defaultVisualId: null,
		copilotProfileId: null,
		extensions: {},
		createdAt: EPOCH,
		updatedAt: EPOCH,
	};
}

export function wireLorebook(): LorebookRecord {
	return {
		id: "lorebook",
		name: "",
		description: "",
		scopeType: "global",
		scanDepth: 4,
		tokenBudget: 2048,
		tokenBudgetPercent: null,
		recursiveScanning: false,
		useGroupScoring: false,
		maxRecursionSteps: 5,
		includeNames: false,
		minActivations: 0,
		minActivationsDepthMax: 0,
		overflowAlert: false,
		characterStrategy: 0,
		sortOrder: 0,
		enabled: true,
		characterId: null,
		personaId: null,
		chatId: null,
		extensions: {},
		createdAt: EPOCH,
		updatedAt: EPOCH,
	};
}

export function wireLoreEntry(): LoreEntryRecord {
	return {
		id: "entry",
		lorebookId: "lorebook",
		title: "",
		content: "",
		keys: [],
		secondaryKeys: [],
		logic: "AND_ANY",
		position: "before_char",
		depth: 4,
		priority: 10,
		stickyWindow: 0,
		cooldownWindow: 0,
		delayWindow: 0,
		constant: false,
		probability: 100,
		ignoreBudget: false,
		role: "system",
		groupName: "",
		groupWeight: 100,
		prioritizeInclusion: false,
		useGroupScoring: null,
		excludeRecursion: false,
		preventRecursion: false,
		delayUntilRecursion: false,
		recursionLevel: 0,
		scanDepthOverride: null,
		caseSensitive: false,
		matchWholeWords: false,
		characterFilter: [],
		characterFilterExclude: false,
		matchSources: [],
		enabled: true,
		sortOrder: 0,
		automationId: "",
		metadata: {},
		createdAt: EPOCH,
		updatedAt: EPOCH,
	};
}
