/**
 * Complete wire-record factories for tests. The types are the route-inferred
 * records from `src/api/types.ts`, so a field the server adds to a response
 * breaks this file once instead of every fixture. Spread a factory first, then
 * override only what the test pins.
 *
 * Session-side factories (step 7a of TYPE_SAFETY_CAST_DEBT_REPORT — the chat
 * message cluster): the defaults mirror the wire funnels a real snapshot
 * passes through — `mapChatDto` / `mapMessageDto` (services/api/src/runtime/
 * session/session-runtime-dto.ts) for the row shapes, and the domain's own
 * persisted-column normalizers (`normalizeAutoSummaryConfig`,
 * `normalizeInsightsConfig`, `normalizeObjectiveState`) for the JSON columns,
 * so a fixture carries the same defaults production writes. Branded ids are
 * minted here at the fixture edge via `brandId` (the sanctioned boundary);
 * callers override with their own `brandId<…>` values when a pin needs a
 * specific id.
 */
import { brandId, normalizeAutoSummaryConfig, normalizeInsightsConfig, normalizeObjectiveState, REGEX_PLACEMENT, REGEX_SUBSTITUTE } from "@vibe-tavern/domain";
import type { AssemblePromptResponse, Attachment, ChatBranch, ChatBranchId, CharacterId, ChatId, MessageId, MessageVariantId, PromptPresetDto, RegexPresetId } from "@vibe-tavern/domain";
import type { AppCharacter, AppMessage, AppSnapshot, ChatListItem, LoreEntryRecord, LorebookRecord, PersonaRecord, ProviderProfileRecord, RegexPresetRecord, ScriptRecord, UiSettingsRecord } from "../src/api/types.js";
import type { TtsProfileRecord } from "../src/api/tts-api.js";

const EPOCH = "2026-01-01T00:00:00.000Z";

/** The active-chat wire row (`mapChatDto` shape) — AppSnapshot's fields are Partial. */
type AppChatDto = NonNullable<AppSnapshot["activeChat"]>;
/** The wire message variant (`mapMessageDto` shape with its TC-4 count). */
type AppMessageVariant = AppMessage["variants"][number];

export function wireCharacter(overrides: Partial<AppCharacter> = {}): AppCharacter {
	return {
		id: "char-1",
		name: "Character",
		description: "",
		scenario: "",
		systemPrompt: "",
		personality: null,
		personalitySummary: null,
		firstMessage: null,
		mesExample: null,
		mesExampleMode: "always",
		mesExampleDepth: 4,
		alternateGreetings: [],
		postHistoryInstructions: null,
		creatorNotes: null,
		characterBook: null,
		depthPrompt: null,
		depthPromptDepth: null,
		depthPromptRole: null,
		extensions: {},
		tags: [],
		subtitle: "",
		avatarAssetId: null,
		avatarFullAssetId: null,
		avatarCropJson: null,
		avatarExt: null,
		avatarFullExt: null,
		updatedAt: EPOCH,
		avatarDescription: null,
		includeAvatarInPrompt: false,
		includeGalleryInPrompt: false,
		...overrides,
	};
}

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
		chatImpersonateEnhanceDraft: false,
		summaryProviderId: null,
		summaryModelName: null,
		messageEditorProviderId: null,
		messageEditorModelName: null,
		coauthorProviderId: null,
		coauthorLoreProviderId: null,
		coauthorLoreModelName: null,
		githubStarred: false,
		userMessageCount: 0,
		nextStarPromptAt: 10,
		starPromptDeferrals: 0,
		copilotProviderId: null,
		copilotModelName: null,
		activeServicePromptProfileId: null,
		activeImagePromptProfileId: null,
		imagePromptVariantsMigrated: false,
		servicePromptPresetMigrated: false,
		stockImageGenSamplerSetsSeeded: false,
		stockImageGenFleetSamplerSetsSeeded: false,
		stockImageGenSetWorkflowFamiliesBackfilled: false,
		activeDictationProfileId: null,
		activeVoiceMessageProfileId: null,
		updatedAt: EPOCH,
	};
}

export function wireProviderProfile(overrides: Partial<ProviderProfileRecord> = {}): ProviderProfileRecord {
	return {
		id: "profile-1",
		name: "Provider",
		providerPreset: "openaiCompat",
		coauthorTransport: "chat_completions",
		generationMode: "chat",
		endpoint: "https://api.test/v1",
		defaultModel: null,
		visionModel: null,
		contextBudget: null,
		pinContextBudget: false,
		tokenPadding: 0,
		bindPerModel: false,
		modelFreeOnly: false,
		modelGroupByOwner: false,
		maxTokens: 4096,
		temperature: 0.7,
		topP: 1,
		topK: 0,
		minP: 0,
		topA: 0,
		typicalP: 1,
		tfsZ: 1,
		adaptiveTarget: -1,
		adaptiveDecay: 0.9,
		dynatempRange: 0,
		dynatempExponent: 1,
		topNSigma: 0,
		smoothingFactor: 0,
		repeatLastN: -1,
		mirostat: 0,
		mirostatTau: 5,
		mirostatEta: 0.1,
		dryMultiplier: 0,
		dryBase: 1.75,
		dryAllowedLength: 2,
		drySequenceBreakers: [],
		bannedStrings: [],
		dryPenaltyLastN: -1,
		xtcThreshold: 0.1,
		xtcProbability: 0,
		frequencyPenalty: 0,
		presencePenalty: 0,
		repetitionPenalty: 1,
		unifiedLinear: 1,
		unifiedQuad: 0,
		unifiedConf: 0,
		repetitionPenaltySlope: 0,
		phraseRepPen: "off",
		thinkingMode: "auto",
		stopSequences: [],
		logitBias: [],
		seed: null,
		reasoningEffort: "default",
		showReasoning: true,
		streamResponse: true,
		customSamplers: false,
		isActive: false,
		createdAt: EPOCH,
		updatedAt: EPOCH,
		proxyMode: "inherit",
		proxyId: null,
		samplerSetId: null,
		generationFormat: null,
		hasStoredApiKey: true,
		...overrides,
	};
}

/** Complete TTS profile row (tts-api.ts wire shape): a saved Kokoro row with
 *  a stored key and no provider link — override what the pin exercises. */
export function wireTtsProfile(overrides: Partial<TtsProfileRecord> = {}): TtsProfileRecord {
	return {
		id: "tts-1",
		name: "Profile",
		backend: "kokoro",
		config: {},
		hasStoredApiKey: true,
		providerRef: null,
		autoKeyProviderName: null,
		voiceId: "",
		narratorVoiceId: null,
		lang: "en",
		sortOrder: 0,
		isDefault: false,
		createdAt: EPOCH,
		updatedAt: EPOCH,
		...overrides,
	};
}

/** Complete regex-preset row (the domain `RegexPreset`, regex-api.ts wire
 *  shape): a global ST-parity rule with no profile binding and the placement
 *  the indicator pins exercise — override what the pin needs. */
export function wireRegexPreset(overrides: Partial<RegexPresetRecord> = {}): RegexPresetRecord {
	return {
		id: brandId<RegexPresetId>("rx_1"),
		name: "Preset",
		findRegex: "/x/g",
		replaceString: "y",
		trimStrings: [],
		substituteRegex: REGEX_SUBSTITUTE.None,
		disabled: false,
		markdownOnly: false,
		promptOnly: false,
		runOnEdit: false,
		minDepth: null,
		maxDepth: null,
		placement: [REGEX_PLACEMENT.AiOutput],
		isGlobal: true,
		sortOrder: 0,
		profileId: null,
		createdAt: EPOCH,
		updatedAt: EPOCH,
		...overrides,
	};
}

export function wireScript(): ScriptRecord {
	return {
		id: "script",
		name: "",
		description: "",
		code: "",
		enabled: true,
		origin: "in_app",
		firstEnabledAt: null,
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
		tokenBudgetCap: 0,
		recursiveScanning: false,
		useGroupScoring: false,
		caseSensitive: false,
		matchWholeWords: false,
		maxRecursionSteps: 0,
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
		minChatMessages: 0,
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

// ─── Session snapshot elements (step 7a) ──────────────────────────────

/** Complete domain `Attachment` — an image by default (the type drives the
 *  preview and prompt-pipeline paths); callers override `type`/`mimeType` for
 *  file/audio drafts. */
export function wireAttachment(overrides: Partial<Attachment> = {}): Attachment {
	return {
		id: "att-1",
		assetId: "asset-1",
		type: "image",
		name: "image.png",
		mimeType: "image/png",
		sizeBytes: 1024,
		...overrides,
	};
}

/** Complete `PromptPresetDto` (the bootstrap prompt-presets row): empty prompt
 *  slots and the LS-8 prefill opt-out, so a fixture pins only what the
 *  component under test reads (typically `name` / `perSendPrefillEnabled`). */
export function wirePromptPreset(overrides: Partial<PromptPresetDto> = {}): PromptPresetDto {
	return {
		id: "preset-1",
		name: "Preset",
		system: "",
		jailbreak: "",
		prefill: "",
		authorsNote: "",
		authorsNoteDepth: 4,
		authorsNotePosition: "in_prompt",
		authorsNoteRole: "system",
		summary: "",
		tools: "",
		nsfw: "",
		enhanceDefinitions: "",
		customInjections: [],
		promptOrder: [],
		advancedMode: false,
		mergeConsecutiveRoles: false,
		perSendPrefillEnabled: false,
		scriptAiSystemPrompt: "",
		aiAssistantPrompts: "",
		createdAt: EPOCH,
		updatedAt: EPOCH,
		...overrides,
	};
}

/** Complete `AssemblePromptResponse` (domain api-types.ts): a preview with no
 *  layers whose token accounting carries only `total` — the one member the
 *  trace/preview consumers pin. The remaining required members ride as empty
 *  collections, exactly the shape an empty-context assembly produces; override
 *  fields a pin exercises. */
export function wirePromptPreview(tokenTotal: number): AssemblePromptResponse {
	return {
		layers: [],
		tokenAccounting: { total: tokenTotal },
		activatedLoreEntries: [],
		scriptInjections: [],
		retrievedMemories: [],
		finalPayload: {},
	};
}

/** Complete `PersonaRecord` — the wire persona row (wire-types.ts). */
export function wirePersona(overrides: Partial<PersonaRecord> = {}): PersonaRecord {
	return {
		id: "persona-1",
		name: "Persona",
		description: "",
		pronouns: null,
		pronounForms: null,
		avatarAssetId: null,
		avatarFullAssetId: null,
		avatarCropJson: null,
		avatarExt: null,
		avatarFullExt: null,
		defaultForNewChats: false,
		avatarDescription: null,
		includeAvatarInPrompt: false,
		updatedAt: EPOCH,
		...overrides,
	};
}

/** Complete sidebar `ChatListItem` (wire-types.ts) — `lastMessageAt` included
 *  (drives the sidebar's "recent" sort; unread by the chat-surface pins). */
export function wireChatListItem(overrides: Partial<ChatListItem> = {}): ChatListItem {
	return {
		id: brandId<ChatId>("chat-1"),
		title: "Chat",
		characterId: brandId<CharacterId>("c1"),
		characterName: "Character",
		subtitle: "",
		activeBranchLabel: "main",
		mode: "rp",
		messageCount: 0,
		lastMessageAt: EPOCH,
		updatedAt: EPOCH,
		...overrides,
	};
}

/** Complete `ChatBranch` (domain entity) — `b1` on `chat-1`, matching the
 *  session fixtures' default chat/branch pair. */
export function wireBranch(overrides: Partial<ChatBranch> = {}): ChatBranch {
	return {
		id: brandId<ChatBranchId>("b1"),
		chatId: brandId<ChatId>("chat-1"),
		parentBranchId: null,
		forkedFromMessageId: null,
		label: "main",
		createdAt: EPOCH,
		...overrides,
	};
}

/** Complete `ChatDto` (the active-chat row) — JSON columns ride the domain's
 *  own normalizers so a fixture carries production's persisted defaults. */
export function wireChat(overrides: Partial<AppChatDto> = {}): AppChatDto {
	return {
		id: brandId<ChatId>("chat-1"),
		characterId: brandId<CharacterId>("c1"),
		personaId: null,
		title: "Chat",
		status: "active",
		mode: "rp",
		activeBranchId: brandId<ChatBranchId>("b1"),
		promptPresetId: null,
		selectedGreetingIndex: 0,
		coauthorContextLinks: [],
		coauthorModuleId: null,
		dynamicPrompt: "",
		createdAt: EPOCH,
		updatedAt: EPOCH,
		summary: "",
		messageHistoryLimit: 0,
		autoSummaryConfig: normalizeAutoSummaryConfig({}),
		insightsConfig: normalizeInsightsConfig({}),
		insightsObjectiveState: normalizeObjectiveState({}),
		...overrides,
	};
}

/** Complete wire variant (`MessageVariantDto`): the required domain members
 *  plus the TC-4 `tokenCount`. Fixture id convention `${messageId}-v${index}`
 *  (production variant ids are unspeaking row ids; no pin reads them). */
export function wireVariant(
	messageId: string,
	variantIndex: number,
	overrides: Partial<AppMessageVariant> = {},
): AppMessageVariant {
	return {
		id: brandId<MessageVariantId>(`${messageId}-v${variantIndex}`),
		messageId: brandId<MessageId>(messageId),
		variantIndex,
		content: "",
		isSelected: false,
		finishReason: null,
		createdAt: EPOCH,
		tokenCount: 0,
		...overrides,
	};
}

/** Complete wire message (`MessageDto`): the `mapMessageDto` row shape.
 *  `tokenCount: 0` is the TC-4 travel-with-the-message count — override when
 *  a pin exercises context counters; the real funnel computes cl100k. */
export function wireMessage(id: string, overrides: Partial<AppMessage> = {}): AppMessage {
	return {
		id: brandId<MessageId>(id),
		chatId: brandId<ChatId>("chat-1"),
		branchId: brandId<ChatBranchId>("b1"),
		role: "assistant",
		authorType: "assistant",
		position: 0,
		content: "",
		state: "complete",
		createdAt: EPOCH,
		updatedAt: EPOCH,
		variants: [],
		selectedVariantIndex: null,
		tokenCount: 0,
		modelId: null,
		sceneTracker: null,
		...overrides,
	};
}
