/**
 * Typed fixture builders for the insights cluster (Wave B step 6 —
 * TYPE_SAFETY_CAST_DEBT_REPORT, the `makeActiveChat` pattern generalised).
 *
 * The insights suites used to hand `InsightsAdapter` / `createInsightsRoutes`
 * partial literals through `as unknown as StoreContainer / ObjectiveService /
 * SessionRuntime / InsightsRuntimeApi` — the DK-9 erasure class (e.g. the
 * variant fixture was missing seven required `MessageVariant` fields and the
 * erasure hid every one). These builders take the narrow fixture subset the
 * cluster's tests actually exercise, return the consumer's REAL type (via
 * `strictTestDouble` — unprovided members throw on access), and fill the row
 * builders below with complete stored-shape rows whose unused fields are
 * inert.
 *
 * Builders are infrastructure: they land with this batch's consumers and
 * later step-6 batches may import and extend them.
 */
import type {
	Chat,
	ChatBranch,
	ChatSummary,
	CharacterAssetRow,
	DiceRoll,
	ExperienceAttachmentRow,
	LorebookRow,
	Message,
	MessageVariant,
	RegexStore,
	StoreContainer,
	MessageStore,
	ChatStore,
	PersonaStore,
	PresetStore,
	ChatSummaryStore,
	CharacterAssetStore,
	DiceRollStore,
	ExperienceStore,
	Persona,
	PromptPreset,
} from "@vibe-tavern/db";
import {
	CHAT_MODE,
	brandId,
	createDefaultSceneTrackerConfig,
	defaultObjectiveState,
	normalizeAutoSummaryConfig,
	normalizeInsightsConfig,
	normalizeObjectiveState,
	type CharacterId,
	type ChatBranchId,
	type ChatId,
	type MessageId,
	type MessageVariantId,
	type ObjectiveState,
	type SceneTrackerRecord,
} from "@vibe-tavern/domain";
import type { PromptAssemblyContext } from "@vibe-tavern/prompt-pipeline";
import type {
	ConfigPatchResponse,
	SceneTargetResponse,
	SessionSnapshot,
} from "../src/api/contract/session-types.js";
import type { CharacterRecord } from "../src/domain/character/character-runtime.js";
import type { ObjectiveService } from "../src/domain/insights/objective-service.js";
import type { SceneTrackerService } from "../src/domain/insights/tracker-service.js";
import type { InsightsRuntimeApi } from "../src/api/contract/runtime-api.js";
import type { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { BuiltPipelineContext, PromptAssemblyResolver } from "../src/domain/prompt/prompt-assembly-service.js";
import type { GenerationResult } from "../src/infrastructure/ai/provider-execution-types.js";
import { toCharacterRecord } from "../src/domain/character/character-runtime.js";
import { mapChatBranch, mapChatDto, mapMessageDto } from "../src/runtime/session/session-runtime-dto.js";
import { strictTestDouble, type PartialMembers } from "./strict-test-double.js";
import { makeCharacterRow } from "./copilot-test-builders.js";

const EPOCH = "2026-01-01T00:00:00.000Z";

// ─── Row builders (complete stored shapes) ───────────────────────────────────

/** A complete store-level message row. Defaults carry the canonical insight
 *  fixture ("hello" assistant row — the token-count pins count exactly this
 *  content); overrides win. Replaces the partial `MESSAGE_ROW` literal whose
 *  missing fields the erasure cast hid. */
export function makeMessageRow(
	over: Partial<Message> & Pick<Message, "id">,
): Message {
	return {
		chatId: "chat_1",
		branchId: "branch_1",
		role: "assistant",
		authorType: "assistant",
		position: 0,
		content: "hello",
		state: "",
		createdAt: EPOCH,
		updatedAt: EPOCH,
		...over,
	};
}

/** A complete store-level message variant row. Defaults carry the canonical
 *  insight fixture (the selected "hello" variant); overrides win. Replaces
 *  the partial `VARIANT_ROW` literal, which under the erasure cast was
 *  missing `finishReason`/`reasoning`/`reasoningDurationMs`/`presetName`/
 *  `createdAt`/`ttsAnnotation`/`attachmentsJson` — all seven required on the
 *  real row type. */
export function makeVariantRow(
	over: Partial<MessageVariant> = {},
): MessageVariant {
	return {
		id: "var_1",
		messageId: "msg_1",
		variantIndex: 0,
		content: "hello",
		isSelected: true,
		finishReason: null,
		reasoning: null,
		reasoningDurationMs: null,
		modelId: "m",
		presetName: null,
		createdAt: EPOCH,
		coauthorModuleId: null,
		coauthorSkillId: null,
		sceneTracker: null,
		ttsAnnotation: null,
		attachmentsJson: null,
		...over,
	};
}

/** A complete stored chat row; only `id`/`characterId`/`activeBranchId` carry
 *  fixture identity — the adapter's `ensureChat` reads nothing but truthiness
 *  on this row. The config objects come from the domain's ONE normalizers. */
export function makeChatRow(
	over: Partial<Chat> & Partial<Pick<Chat, "id">> = {},
): Chat {
	return {
		id: "chat_1",
		characterId: "char_1",
		personaId: null,
		title: "Fixture chat",
		summary: "",
		messageHistoryLimit: 0,
		autoSummaryConfig: normalizeAutoSummaryConfig({}),
		insightsConfig: {
			...normalizeInsightsConfig({}),
			tracker: createDefaultSceneTrackerConfig(),
		},
		insightsObjectiveState: defaultObjectiveState(),
		status: "active",
		mode: CHAT_MODE.rp,
		selectedGreetingIndex: 0,
		activeBranchId: "branch_1",
		promptPresetId: null,
		scriptState: {},
		coauthorContextLinks: [],
		coauthorModuleId: null,
		dynamicPrompt: "",
		createdAt: EPOCH,
		updatedAt: EPOCH,
		...over,
	};
}

/** A complete stored branch row (the `getActiveBranch` fixture; only `id` is
 *  read — `ensureLatestAssistantTarget` compares it against the target). */
export function makeChatBranchRow(
	over: Partial<ChatBranch> = {},
): ChatBranch {
	return {
		id: "branch_1",
		chatId: "chat_1",
		parentBranchId: null,
		forkedFromMessageId: null,
		label: "main",
		loreActivationState: {},
		createdAt: EPOCH,
		...over,
	};
}

/** A complete stored chat-summary row (Wave B step 6c). The ranged summary
 *  assembler projects only `id`/`label`/`content` (+ the summarizedFrom/To
 *  window it filters on) — every other column rides inert defaults, and
 *  overrides win. Replaces the `{ id, label?, content, summarizedFrom,
 *  summarizedTo }` fragments the erasure casts let past the compiler, and the
 *  `create` fixtures that used to return `{ id, …input }`. */
export function makeChatSummaryRow(
	over: Partial<ChatSummary> = {},
): ChatSummary {
	return {
		id: "summary_1",
		chatId: "chat_1",
		branchId: "branch_1",
		// The store's create default (`data.label ?? ''`) — a summary without a
		// label must stay EMPTY so the ranged assembler's Trange fallback fires.
		label: "",
		content: "fixture summary body",
		summarizedFrom: 1,
		summarizedTo: 5,
		includeInContext: true,
		excludeSummarized: true,
		source: "auto",
		sortOrder: 0,
		contentHash: null,
		createdAt: EPOCH,
		updatedAt: EPOCH,
		...over,
	};
}

// ─── Rows + stores for the prompt-assembly / lorebook / import suites ───────

/** A complete stored lorebook row; only identity fields carry fixture data —
 *  the import/participating paths read `id` (plus whatever `over` pins for an
 *  assertion). The rest rides inert defaults matching the store's create
 *  shape. Replaces the `{ id, name }` fragments the erasure casts let past. */
export function makeLorebookRow(over: Partial<LorebookRow> = {}): LorebookRow {
	return {
		id: "lb_1",
		name: "Fixture lorebook",
		description: "",
		scopeType: "global",
		scanDepth: 60,
		tokenBudget: 1000,
		tokenBudgetPercent: null,
		tokenBudgetCap: 0,
		recursiveScanning: false,
		useGroupScoring: true,
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
		...over,
	};
}

/** A complete stored character-asset (gallery) row; the prompt-assembly D7
 *  filter reads `description`/`includeInPrompt`/`caption`, the persona-export
 *  legacy-avatar path reads `ext` — everything else rides inert defaults. */
export function makeCharacterAssetRow(
	id: string,
	over: Partial<Omit<CharacterAssetRow, "id">> = {},
): CharacterAssetRow {
	return {
		id,
		characterId: "char_1",
		ext: "png",
		mimeType: "image/png",
		caption: "",
		description: null,
		includeInPrompt: false,
		avatarCropJson: null,
		order: 0,
		createdAt: EPOCH,
		...over,
	};
}

/** The `SessionSnapshot` the full (non-lean) import path returns verbatim:
 *  every required member present, built through the SAME funnels the wire
 *  uses (`mapChatDto`/`toCharacterRecord` over standing row builders). The
 *  import tests only ever assert the snapshot EXISTS, so the body is inert;
 *  overrides win wholesale. Replaces the erased `{ chats: [], messages: [] }`
 *  fragments that satisfied the old cast. */
export function makeSessionSnapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
	// The row → record funnel takes the DOMAIN view; the id is the only
	// brand-differentiated field (the same re-brand prompt-resolver.ts:116 does
	// over its store row).
	const row = makeCharacterRow("char_1");
	const character: CharacterRecord = toCharacterRecord({ ...row, id: brandId<CharacterId>(row.id) });
	const branch = makeChatBranchRow();
	return {
		chats: [],
		allCharacters: [],
		activeChat: mapChatDto(makeChatRow()),
		activeBranch: mapChatBranch(branch),
		branches: [mapChatBranch(branch)],
		messages: [],
		summaries: [],
		promptTrace: null,
		character,
		persona: null,
		...over,
	};
}

/**
 * The `StoreContainer` double for `PromptAssemblyService` (and the
 * `StaticPromptResolver`/`RegexHookService` pair that share the container).
 * The service reads exactly the slices wired below; every other store throws a
 * labeled miss on access. Replaces the six suites' `as unknown as
 * StoreContainer` literals — which, silently INCOMPLETE, also carried the dead
 * pre-TH-11 seams (`chats.getMessages`, `characterAssets.listGalleryByCharacter`
 * — neither exists on the real stores); the typed double drops them, so a
 * regression that revives a dead seam fails loudly instead of reading
 * `undefined`.
 *
 * The chat row is completed through {@link makeChatRow} (DK-9: the erased
 * literals omitted required columns); `fixture.chat` overrides win. History
 * rows ride {@link makeMessageRow}; summaries {@link makeChatSummaryRow}.
 */
export interface PromptAssemblyStoresFixture {
	/** Overrides merged over the canonical chat row (`promptPresetId`,
	 *  `personaId`, `insightsConfig`, `messageHistoryLimit`, …). */
	chat?: Partial<Chat>;
	/** `chats.getById` returns null (the fail-closed not-found paths). */
	chatMissing?: boolean;
	/** `chats.getBranches` rows (defaults to the canonical branch_1 row). */
	branches?: ChatBranch[];
	/** `messages.getMessages(branchId)` rows (defaults to []). */
	messages?: Message[];
	/** `messages.getSelectedSceneHistory` rows + capture (SCN-7 fixtures). */
	selectedSceneHistory?: Array<{
		messageId: string;
		variantId: string;
		record: {
			variantId: string;
			schemaHash: string;
			configRevision: number;
			sourceHash: string;
			sceneState: Record<string, unknown>;
			modelId: string | null;
			generatedAt: string;
		};
	}>;
	onSceneHistoryQuery?: (branchId: string, scanLimit: number) => void;
	personas?: Persona[];
	presets?: PromptPreset[];
	/** `chatSummaries.listByChatBranch` rows. */
	summaries?: ChatSummary[];
	/** `characterAssets.listByCharacter` rows (the D7 gallery filter). */
	characterAssets?: CharacterAssetRow[];
	/** `diceRolls.getRollsForMessages` result, copied per call. */
	diceRolls?: Map<string, DiceRoll[]>;
	/** Captures the dice batch query (the no-N+1 pins). */
	onDiceQuery?: () => void;
	/** `experiences.getAttachmentsForMessages` result, copied per call. */
	experienceAttachments?: Map<string, ExperienceAttachmentRow[]>;
	/** Captures the experience batch query (the no-N+1 pins). */
	onAttachmentQuery?: () => void;
	/** A complete `regex` slice override (the RX-13 fixtures build their own
	 *  strict double around `resolveActiveRegexPresets`). */
	regex?: RegexStore;
}

export function makePromptAssemblyStores(
	fixture: PromptAssemblyStoresFixture = {},
	label = "PromptAssemblyService stores",
): StoreContainer {
	const storeLabel = (slice: string) => `${label}: ${slice}`;
	const rollMap = new Map(fixture.diceRolls ?? []);
	const attachmentMap = new Map(fixture.experienceAttachments ?? []);
	return strictTestDouble<StoreContainer>(
		{
			chats: strictTestDouble<ChatStore>(
				{
					getById: async () => (fixture.chatMissing ? null : makeChatRow(fixture.chat)),
					getBranches: async () => fixture.branches ?? [makeChatBranchRow()],
				},
				storeLabel("chats"),
			),
			messages: strictTestDouble<MessageStore>(
				{
					getMessages: async () => fixture.messages ?? [],
					...(fixture.selectedSceneHistory || fixture.onSceneHistoryQuery
						? {
								getSelectedSceneHistory: async (branchId: string, scanLimit: number) => {
									fixture.onSceneHistoryQuery?.(branchId, scanLimit);
									return fixture.selectedSceneHistory ?? [];
								},
							}
						: {}),
				},
				storeLabel("messages"),
			),
			personas: strictTestDouble<PersonaStore>(
				{ listAll: async () => fixture.personas ?? [] },
				storeLabel("personas"),
			),
			presets: strictTestDouble<PresetStore>(
				{ listAll: async () => fixture.presets ?? [] },
				storeLabel("presets"),
			),
			chatSummaries: strictTestDouble<ChatSummaryStore>(
				{ listByChatBranch: async () => fixture.summaries ?? [] },
				storeLabel("chatSummaries"),
			),
			characterAssets: strictTestDouble<CharacterAssetStore>(
				{ listByCharacter: async () => fixture.characterAssets ?? [] },
				storeLabel("characterAssets"),
			),
			diceRolls: strictTestDouble<DiceRollStore>(
				{
					getRollsForMessages: async () => {
						fixture.onDiceQuery?.();
						return new Map(rollMap);
					},
				},
				storeLabel("diceRolls"),
			),
			experiences: strictTestDouble<ExperienceStore>(
				{
					getAttachmentsForMessages: async () => {
						fixture.onAttachmentQuery?.();
						return new Map(attachmentMap);
					},
				},
				storeLabel("experiences"),
			),
			...(fixture.regex ? { regex: fixture.regex } : {}),
		},
		label,
	);
}

// ─── Scene tracker ───────────────────────────────────────────────────────────

/** A complete Scene record as the tracker service really returns it (the
 *  domain type — every field inert unless overridden; the id is branded here,
 *  the builder's only seam). */
export function makeSceneTrackerRecord(
	over: {
		variantId?: string;
		schemaHash?: string;
		configRevision?: number;
		sourceHash?: string;
		sceneState?: Record<string, unknown>;
		modelId?: string | null;
		generatedAt?: string;
	} = {},
): SceneTrackerRecord {
	return {
		variantId: brandId<MessageVariantId>(over.variantId ?? "var_1"),
		schemaHash: over.schemaHash ?? "",
		configRevision: over.configRevision ?? 0,
		sourceHash: over.sourceHash ?? "",
		sceneState: over.sceneState ?? {},
		modelId: over.modelId ?? null,
		generatedAt: over.generatedAt ?? EPOCH,
	};
}

/** A minimal-but-complete prompt assembly context: `identity`/`character`/
 *  `chat.recentMessages` are the interface's only required members, and the
 *  insight one-shot paths read `context` only to hand it to the service
 *  double. */
export function makePromptContext(
	over: Partial<PromptAssemblyContext> = {},
): PromptAssemblyContext {
	return {
		identity: { chatId: "chat_1" },
		character: { id: "char_1", name: "Fixture character", description: "" },
		chat: { recentMessages: [] },
		...over,
	};
}

/** Completes a narrow `{ context }` fixture return into the REAL
 *  `BuiltPipelineContext` the `chatLifecycle.buildPipelineContext` /
 *  `buildChatImpersonationPipelineContext` contracts carry. The consumers on
 *  the exercised paths read `built.context` only (the lifecycle returns it to
 *  the insight one-shots; the AI-assistant impersonation branch spreads it) —
 *  every other member below is an inert default. One derivation: the
 *  makeSessionRuntime wrapper below and the ChatLifecycle / AI-assistant
 *  stream doubles (step 14i) all complete through this. */
export function makeBuiltPipelineContext(context: PromptAssemblyContext): BuiltPipelineContext {
	return {
		context,
		branchId: brandId<ChatBranchId>("branch_1"),
		chatId: brandId<ChatId>("chat_1"),
		chatPromptPresetId: null,
		promptPresetId: null,
		promptPresetName: null,
		activeLoreEntries: [],
		overflowedLorebooks: [],
		retrievedMemories: [],
		scriptResult: {
			personality: "",
			scenario: "",
			injectedMessages: [],
			errors: [],
			scriptRuns: [],
		},
		recentMessageCount: 0,
	};
}

/** The `ConfigPatchResponse` the refresh path returns (`activeChat` rides
 *  `mapChatDto` over a real chat row — the same DTO the wire sees). */
export function makeConfigPatchResponse(chatId = "chat_1"): ConfigPatchResponse {
	return { activeChat: mapChatDto(makeChatRow({ id: chatId })) };
}

/** The Scene mutation response the route fixtures return: the target plus a
 *  REAL message DTO over the canonical insight rows (the routes `c.json` the
 *  whole response; the tests assert the target and the capture args — the
 *  message body rides the same mapMessageDto funnel the wire uses). */
export function makeSceneTargetResponse(chatId = "chat_1"): SceneTargetResponse {
	return {
		target: { chatId, branchId: "branch_1", messageId: "msg_1", variantId: "var_1" },
		message: mapMessageDto(
			makeMessageRow({ id: "msg_1", chatId }),
			[makeVariantRow({ messageId: "msg_1" })],
		),
	};
}

// ─── DI doubles ──────────────────────────────────────────────────────────────

/**
 * The StoreContainer double for `InsightsAdapter` (its constructor reads
 * nothing eagerly — every member access happens inside an exercised call, so
 * an unprovided member throws exactly where the erased `undefined` used to
 * explode as `TypeError: x.y is not a function`).
 */
export interface InsightsStoresFixture {
	chats?: Partial<Pick<ChatStore, "getById" | "getActiveBranch">>;
	messages?: Partial<
		Pick<MessageStore, "getMessageById" | "getVariants" | "getLatestSelectedVariant">
	>;
}

export function makeInsightsStores(fixture: InsightsStoresFixture): StoreContainer {
	return strictTestDouble<StoreContainer>(
		{
			...(fixture.chats ? { chats: fixture.chats } : {}),
			...(fixture.messages ? { messages: fixture.messages } : {}),
		},
		"InsightsAdapter stores",
	);
}

/** A strict `ObjectiveService` double — each test provides exactly the
 *  members its route touches (getState / waitForForwardState /
 *  resolveInsightProvider / generateTasks / the OGM mutators). */
export function makeObjectiveService(
	provided: PartialMembers<ObjectiveService> = {},
): ObjectiveService {
	return strictTestDouble<ObjectiveService>(provided, "ObjectiveService");
}

/** The `SessionRuntime` double for the generate path: the adapter reads
 *  `chatLifecycle.buildPipelineContext` (and returns `built.context` BY
 *  REFERENCE — the fixture's context object must survive) and
 *  `buildConfigPatchResponse`. The wrapper completes the fixture's narrow
 *  `{ context }` return into the real `BuiltPipelineContext` shape with inert
 *  defaults, so the double returns the type the adapter really consumes. */
export interface SessionRuntimeFixture {
	chatLifecycle?: {
		buildPipelineContext(input: {
			chatId: ChatId;
			/** Background triggers pass the committed event's branch explicitly
			 *  (session-runtime-chat-lifecycle.ts input); the objective-suite
			 *  orchestration pins assert it (getContextBranchIds). */
			branchId?: ChatBranchId;
			/** The backfill runner binds each manifest item to its own history
			 *  prefix (session-runtime-chat-lifecycle.ts input member); the SCN-14
			 *  freeze pins assert it (tracker-backfill.test.ts throughMessageId). */
			throughMessageId?: MessageId;
			model: string;
			recentMessageLimit?: number;
			dryRun?: boolean;
		}): Promise<{ context: PromptAssemblyContext }>;
	};
	buildConfigPatchResponse?(
		chatId: ChatId,
		opts?: { persona?: boolean; character?: boolean; activeChat?: boolean },
	): Promise<ConfigPatchResponse>;
}

export function makeSessionRuntime(fixture: SessionRuntimeFixture = {}): SessionRuntime {
	return strictTestDouble<SessionRuntime>(
		{
			...(fixture.chatLifecycle
				? {
						chatLifecycle: {
							buildPipelineContext: async (
								input: Parameters<
									SessionRuntime["chatLifecycle"]["buildPipelineContext"]
								>[0],
							): Promise<BuiltPipelineContext> => {
								const built = await fixture.chatLifecycle!.buildPipelineContext(input);
								return makeBuiltPipelineContext(built.context);
							},
						},
					}
				: {}),
			...(fixture.buildConfigPatchResponse
				? { buildConfigPatchResponse: fixture.buildConfigPatchResponse }
				: {}),
		},
		"SessionRuntime",
	);
}

/** A real {@link GenerationResult} for the injected-execute doubles. The
 *  insight services read only `.text`, but `providerResponse` is the required
 *  trace member the type carries (`{ text }` alone is NOT a GenerationResult —
 *  the fiction the erasure casts hid, surfaced in step 14a). The trace shape
 *  mirrors the executor's nonstream mode with no steps; nothing under test
 *  reads it. Fork bookkeeping: fork #1 of the file-local `execResult` in
 *  objective-service.test.ts (its original 14a header cannot carry
 *  `forks: 1` within step 14d's four-file scope — fold both here when that
 *  file is next touched). Consumers: tracker-service / tracker-backfill /
 *  tracker-coordinator suites. */
export function execResult(text: string): GenerationResult {
	return { text, providerResponse: { mode: "nonstream", steps: [] } };
}

/** A strict `SceneTrackerService` double — the tests wrap their partial
 *  tracker fixture (the per-test `noopTracker` stays in the suite file) so
 *  the adapter receives the full service type with loud misses. */
export function makeSceneTracker(
	provided: PartialMembers<SceneTrackerService>,
): SceneTrackerService {
	return strictTestDouble<SceneTrackerService>(provided, "SceneTrackerService");
}

/** A strict `InsightsRuntimeApi` double for the route layer — each route-level
 *  test provides exactly the members its endpoints touch; a route that calls
 *  an unprovided member throws loudly instead of 500ing on
 *  `runtime.x is not a function`. */
export function makeInsightsRuntime(
	provided: PartialMembers<InsightsRuntimeApi>,
): InsightsRuntimeApi {
	return strictTestDouble<InsightsRuntimeApi>(provided, "InsightsRuntimeApi");
}

// ─── Objective-service cluster (objective-service.test.ts) ───────────────────

/**
 * A complete chat row for the objective-suite fixtures. The service reads
 * `insightsObjectiveState` on EVERY path and `id`/`activeBranchId` +
 * `insightsConfig.objectiveEnabled` on the auto-check path (INS-4) — those are
 * the only overrides the builder exposes; everything else rides the
 * {@link makeChatRow} inert defaults. The state goes in through the domain's
 * ONE persisted-column seam: `normalizeObjectiveState(raw: unknown)` is what
 * production feeds the stored JSON blob to, and the suite's corrupt-legacy
 * fixtures (invalid statuses, whitespace descriptions, duplicate actives) are
 * deliberately outside `ObjectiveState` — they are the data that seam exists
 * to heal.
 */
export function makeObjectiveChatRow(
	insightsObjectiveState: unknown,
	over: { id?: string; activeBranchId?: string; objectiveEnabled?: boolean } = {},
): Chat {
	return makeChatRow({
		id: over.id ?? "chat_1",
		activeBranchId: over.activeBranchId ?? "branch_1",
		insightsObjectiveState: normalizeObjectiveState(insightsObjectiveState),
		insightsConfig: {
			...normalizeInsightsConfig({}),
			tracker: createDefaultSceneTrackerConfig(),
			...(over.objectiveEnabled !== undefined ? { objectiveEnabled: over.objectiveEnabled } : {}),
		},
	});
}

/** The `StoreContainer` double for `ObjectiveService`: the service touches
 *  `chats.getById` + `chats.updateInsightsObjectiveState` (and never the
 *  messages store on current paths — `getMessages` stays provided where a
 *  fixture had it, inert). Replaces the `as unknown as StoreContainer`
 *  literals; an unprovided top-level store throws on access. */
export interface ObjectiveStoresFixture {
	chats?: {
		getById: () => Promise<Chat>;
		updateInsightsObjectiveState?: ChatStore["updateInsightsObjectiveState"];
	};
	messages?: { getMessages: () => Promise<Message[]> };
}

export function makeObjectiveStores(fixture: ObjectiveStoresFixture = {}): StoreContainer {
	return strictTestDouble<StoreContainer>(
		{
			...(fixture.chats
				? {
						chats: {
							getById: fixture.chats.getById,
							...(fixture.chats.updateInsightsObjectiveState
								? { updateInsightsObjectiveState: fixture.chats.updateInsightsObjectiveState }
								: {}),
						},
					}
				: {}),
			...(fixture.messages
				? { messages: { getMessages: fixture.messages.getMessages } }
				: {}),
		},
		"ObjectiveService stores",
	);
}
