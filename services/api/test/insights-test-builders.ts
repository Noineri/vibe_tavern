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
	Message,
	MessageVariant,
	StoreContainer,
	MessageStore,
	ChatStore,
} from "@vibe-tavern/db";
import {
	CHAT_MODE,
	brandId,
	createDefaultSceneTrackerConfig,
	defaultObjectiveState,
	normalizeAutoSummaryConfig,
	normalizeInsightsConfig,
	normalizeObjectiveState,
	type ChatBranchId,
	type ChatId,
	type MessageVariantId,
	type ObjectiveState,
	type SceneTrackerRecord,
} from "@vibe-tavern/domain";
import type { PromptAssemblyContext } from "@vibe-tavern/prompt-pipeline";
import type { ConfigPatchResponse, SceneTargetResponse } from "../src/api/contract/session-types.js";
import type { ObjectiveService } from "../src/domain/insights/objective-service.js";
import type { SceneTrackerService } from "../src/domain/insights/tracker-service.js";
import type { InsightsRuntimeApi } from "../src/api/contract/runtime-api.js";
import type { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { BuiltPipelineContext } from "../src/domain/prompt/prompt-assembly-service.js";
import { mapChatDto, mapMessageDto } from "../src/runtime/session/session-runtime-dto.js";
import { strictTestDouble, type PartialMembers } from "./strict-test-double.js";

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
								return {
									context: built.context,
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
