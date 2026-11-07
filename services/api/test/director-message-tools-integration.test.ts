import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { LanguageModel } from "ai";
import {
	DIRECTOR_MESSAGE_RECORD_TYPES,
	DIRECTOR_MESSAGE_TOOLS,
	type DirectorMessageEditProposal,
	type DirectorMessageVariantProposal,
	type DirectorSwipeGrantedReceipt,
	type DirectorSwipePermissionMarker,
	type RecordProposal,
} from "@vibe-tavern/api-contracts";
import { EventBus, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import {
	createStoreContainer,
	type Message as DbMessage,
	type MessageVariant as DbMessageVariant,
	type ProviderProfile,
	type StoreContainer,
} from "@vibe-tavern/db";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import { AgentThreadProposalAdapter } from "../src/api/adapters/agent-thread-proposal-adapter.js";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { wireDirectorMessageDelegates } from "../src/api/adapters/runtime-api-adapter.js";
import { createAgentThreadProposalRoutes } from "../src/api/routes/agent-thread-proposals.js";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import { getChatModeStrategy } from "../src/domain/chat/chat-mode-strategy.js";
import { ChatSummaryService } from "../src/domain/chat/chat-summary-service.js";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { ProviderOrchestrator } from "../src/domain/providers/provider-orchestrator.js";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { SceneTrackerService } from "../src/domain/insights/tracker-service.js";
import { PromptAssemblyService } from "../src/domain/prompt/prompt-assembly-service.js";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import { CopilotProfileResolver } from "../src/domain/interactive/copilot/copilot-profile-resolver.js";
import { buildContextSearchStoreReads } from "../src/domain/context/context-search-store-reads.js";
import { resolveBuiltinSidechatOocProfile } from "../src/domain/agent/kinds/sidechat-ooc-kind.js";
import {
	streamSidechatTurn,
	type SidechatStreamDeps,
} from "../src/domain/sidechat/sidechat-stream.js";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import type { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import type { streamProviderExecutor } from "../src/infrastructure/ai/stream-provider-executor.js";
import { isDomainError, httpStatusForDomainError, domainErrorToJson } from "../src/shared/errors.js";

// ════════════════════════════════════════════════════════════════════════════
// DMT-35 (director message tools) — CROSS-BOUNDARY acceptance: the three
// Director message tools verified END TO END through REAL persisted
// proposal/permission rows, the REAL review resolution (the sidechat answer
// path for the permission, the apply/reject HTTP routes for the proposals)
// and the ordinary chat-generation boundary, with provider I/O injected at
// the adapter seams only (T2 tier — the orchestrator's executors and the
// sidechat deps' streamText, never mock.module, never the pipeline).
//
// Harness forked from director-swipe-permission.test.ts (the real adapter
// composition: real stores + SessionRuntime + LiveChatOrchestrator +
// ChatAdapter + wireDirectorMessageDelegates + the real streamSidechatTurn
// deps) and agent-thread-proposals.test.ts (the real route stack: the
// AgentThreadProposalAdapter behind createAgentThreadProposalRoutes over a
// Hono app, with the seeded persisted-row convention for proposal rows).
//
// The four required cases, and what each adds over the sibling suites:
//   1. a normal RP SEND immediately after an allowed directed swipe is clean
//      — the send prompt and the new variant's LINKED TRACE carry no
//      request_instruction layer and no instruction text (the DMT-13 suite
//      pins this for ordinary REGENERATION; the ordinary send boundary is
//      this suite's);
//   2. a manual swipe after a DENIED directed request still works (a new
//      variant appended AND selected with a linked clean trace) — the deny
//      tail is new (the sibling pins deny's absent provider call only);
//   3. reload before a decision: fresh reads of the persisted row decide,
//      and the RESTORING steps (row re-reads, RP run replay, an unrelated
//      turn) start NO generation; the decision runs with the EXACT approved
//      text through the normal trace (the sibling's reload test pins the
//      receipt only);
//   4. replay after a decision: the RP run replay re-emits its events and
//      starts no second provider run, a competing answer is refused, the
//      directed trace still carries the exact approved instruction (the
//      sibling pins the counts; the trace durability is new here).
// Plus the review resolution half: persisted message-edit / message-variant
// proposal rows resolve through the REAL apply routes with the target-scoped
// message companion while NO provider ever runs (the route-level suite has
// no providers wired, so "review resolution never generates" is only
// observable here), and a replayed apply is the typed already-resolved 409.
//
// In every case the EXACT instruction is verified through the NORMAL prompt
// trace (getTraceByVariant over the real assembly) — never a test-only
// payload assembled beside production code.
// ════════════════════════════════════════════════════════════════════════════

const GREETING = "Hello there, traveler.";
const USER_TURN = "What is behind the door?";
const TARGET_REPLY = "The door creaks open, revealing a dusty study.";
const DIRECTED_REPLY = "Directed swipe reply, freshly generated.";
const ORDINARY_REPLY = "Ordinary generation reply.";
const PARTIAL_REPLY = "Partial swipe reply before the Stop.";
const NEXT_USER_TURN = "Let us move on to the garden.";
const DRAFT_INSTRUCTION = "DRAFT: rewrite the reply about the dusty study.";
const EDITED_INSTRUCTION = "EDITED: rewrite the reply, mention the brass key.";

/** The toolCallId the scripted request turn persists the marker under. */
const SWIPE_TOOL_CALL_ID = "tc_swipe_perm_1";

// ─── The RP provider boundary (the orchestrator's executor seam) ─────────────

interface RpExecutorState {
	/** The streaming executor's captured inputs (the DIRECTED run's prompts)
	 *  and its call count — the "exactly one generation" pin. */
	streamInputs: ProviderExecutionInput[];
	streamCalls: number;
	/** The non-streaming executor's captured inputs (the ordinary SEND and
	 *  manual-regenerate prompts — the "no leak" pins). */
	nonstreamingInputs: ProviderExecutionInput[];
	nonstreamingCalls: number;
	/** Per-test behavior of the NEXT streaming call: plain text, provider
	 *  failure, or an ordinary mid-stream Stop (the RP run's own stop). */
	streamMode: "text" | "fail" | "stop";
}

function makeRpExecutorState(): RpExecutorState {
	return {
		streamInputs: [],
		streamCalls: 0,
		nonstreamingInputs: [],
		nonstreamingCalls: 0,
		streamMode: "text",
	};
}

function streamingExecutor(rp: RpExecutorState, stopChat: () => void): typeof streamProviderExecutor {
	return async (input) => {
		rp.streamCalls += 1;
		rp.streamInputs.push(input);
		if (rp.streamMode === "fail") throw new Error("RP provider failure");
		if (rp.streamMode === "stop") {
			// The ordinary RP Stop mid-stream: one delta lands, the chat run's
			// slot is stopped (the same registry stop the Stop endpoint calls),
			// a doomed tail follows — drainStream takes the savePartial path.
			return {
				stream: (async function* () {
					yield { type: "text-delta" as const, delta: PARTIAL_REPLY };
					stopChat();
					yield { type: "text-delta" as const, delta: " doomed tail" };
				})(),
				finished: Promise.resolve({ finishReason: "stop" }),
				text: Promise.resolve(PARTIAL_REPLY),
				reasoning: Promise.resolve(undefined),
				providerResponse: { mode: "stream" as const, steps: [] },
			};
		}
		return {
			stream: (async function* () {
				yield { type: "text-delta" as const, delta: DIRECTED_REPLY };
			})(),
			finished: Promise.resolve({ finishReason: "stop" }),
			text: Promise.resolve(DIRECTED_REPLY),
			reasoning: Promise.resolve(undefined),
			providerResponse: { mode: "stream" as const, steps: [] },
		};
	};
}

function nonstreamingExecutor(rp: RpExecutorState): typeof nonstreamingProviderExecute {
	return async (input) => {
		rp.nonstreamingCalls += 1;
		rp.nonstreamingInputs.push(input);
		return { text: ORDINARY_REPLY, providerResponse: { mode: "nonstream" as const, steps: [] } };
	};
}

// ─── The sidechat LLM boundary (the deps' injectable streamText) ─────────────

type CapturedMessage = { role: string; content: unknown };
let capturedMessages: CapturedMessage[] = [];
let capturedTools: Record<string, { execute: (args: unknown, options?: { toolCallId: string }) => Promise<unknown> }> = {};
let fakeReply = "OOC sidechat reply.";
let fakeParts: unknown[] | null = null;

function makeFakeStreamTextResult(parts: unknown[]): Record<string, unknown> {
	async function* gen(): AsyncGenerator<unknown, void, unknown> {
		for (const part of parts) yield part;
	}
	return {
		stream: gen(),
		finishReason: Promise.resolve("stop"),
		usage: Promise.resolve(undefined),
	};
}

function makeSidechatProviderProfile(): ProviderProfile {
	return {
		id: "prov_1",
		name: "Sidechat test",
		providerPreset: "openai",
		coauthorTransport: "chatCompletions",
		endpoint: "http://sidechat.test",
		apiKey: "key",
		defaultModel: "sidechat-model",
		contextBudget: null,
		pinContextBudget: false,
		bindPerModel: false,
		maxTokens: 2000,
		temperature: 0.3,
		proxyMode: "inherit",
		proxyId: null,
		isActive: true,
	} as unknown as ProviderProfile;
}

// ─── Real-container harness ──────────────────────────────────────────────────

/** The route-level suite's uncalled-seam stubs (typed per site — the insights
 *  seams behind the proposal adapter are never addressed by the message-type
 *  rows this suite resolves). */
const stubSessionRuntime = {
	buildConfigPatchResponse: async () => ({}),
} as unknown as SessionRuntime;
const stubUncalledProviders = {} as unknown as ProviderProfileService;
const stubUncalledTracker = {} as unknown as SceneTrackerService;

let stores: StoreContainer;
let runtime: SessionRuntime;
let chatAdapter: ChatAdapter;
let copilot: ExperienceCopilotAdapter;
let rp: RpExecutorState;
let sidechatDepsBase: SidechatStreamDeps;
let proposalApp: Hono;
let copilotWire: ExperienceCopilotAdapter;
let chatId: ChatId;
let branchId: ChatBranchId;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-dmt35-integration-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const profiles = createProviderProfileService(stores.providers, stores.proxies);
	const providerRow = await stores.providers.create({
		name: "RP provider",
		providerPreset: "openai",
		endpoint: "https://rp-provider.invalid/v1",
		defaultModel: "test-model",
		contextBudget: 16000,
		maxTokens: 512,
		bindPerModel: false,
	});
	await profiles.activateProviderProfile(providerRow.id);
	runtime = new SessionRuntime(stores, { getActiveProviderProfile: () => profiles.resolveActiveProviderProfile() });
	const created = await runtime.character.createFromScratch({
		name: "Integration Probe",
		description: "a probe character",
		firstMessage: GREETING,
	});
	chatId = created.activeChatId as ChatId;
	const chatRow = await stores.chats.getById(chatId);
	branchId = chatRow!.activeBranchId as ChatBranchId;

	// The REAL adapters + the ONE production composition for the delegates.
	rp = makeRpExecutorState();
	const orchestrator = new LiveChatOrchestrator(
		runtime.chatRuntime,
		runtime.chatApp,
		new ProviderOrchestrator(profiles),
		new EventBus(),
		async () => getChatModeStrategy("rp"),
		undefined,
		undefined,
		{
			nonstreaming: nonstreamingExecutor(rp),
			// stopChatGeneration closes over the adapter — assigned right below.
			stream: streamingExecutor(rp, () => chatAdapter.stopChatGeneration(chatId)),
		},
	);
	copilot = new ExperienceCopilotAdapter(stores);
	chatAdapter = new ChatAdapter(
		stores,
		runtime,
		orchestrator,
		new ChatSummaryService(stores, runtime, profiles),
		profiles,
		new AssetService(join(dataRoot, "assets")),
		async () => null,
		undefined,
		copilot.agentRuns,
	);
	wireDirectorMessageDelegates({ stores, sessionRuntime: runtime, chat: chatAdapter, experienceCopilot: copilot });

	// The REAL proposal routes over the SAME adapter graph (the production
	// closures — sessionRuntime.chatApp — for the DMT-22 message handlers;
	// the insights seams behind them stay the route suite's typed stubs).
	const proposalAdapter = new AgentThreadProposalAdapter(stores, {
		addObjectiveTask: () => {
			throw new Error("not addressed by this suite");
		},
		addShortTermGoal: () => {
			throw new Error("not addressed by this suite");
		},
		insertNextStoryEvent: () => {
			throw new Error("not addressed by this suite");
		},
		applyStoryPlan: () => {
			throw new Error("not addressed by this suite");
		},
		updateObjectiveConfig: () => {
			throw new Error("not addressed by this suite");
		},
		applyTrackerScene: () => {
			throw new Error("not addressed by this suite");
		},
		readInsightsPatch: () => stubSessionRuntime.buildConfigPatchResponse(brandId<ChatId>(chatId), { activeChat: true }),
		editMessage: (messageId, content, expectedVariantId, expectedBaseContent) =>
			runtime.chatApp.editMessage(messageId, content, expectedVariantId, expectedBaseContent),
		addEditorVariant: (messageId, input) => runtime.chatApp.addEditorVariant(messageId, input),
	});
	proposalApp = new Hono();
	proposalApp.onError((err, c) => {
		if (isDomainError(err)) {
			return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 500);
		}
		return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
	});
	proposalApp.route("/", createAgentThreadProposalRoutes(proposalAdapter));
	copilotWire = new ExperienceCopilotAdapter(stores);

	// The sidechat stream deps — the production wiring shape over the REAL
	// stores, with the two provider-boundary fakes and the swipe/edit toggles
	// enabled (the director-swipe-permission suite's stand-in for the seed
	// defaults). The delegate factories are the REAL configured slot entries.
	const resolver = new StaticPromptResolver(stores, new RegexHookService(stores));
	const assembly = new PromptAssemblyService(stores, resolver, stores.content.fileStore);
	const profileResolver = new CopilotProfileResolver(stores);
	const sidechatProfile = makeSidechatProviderProfile();
	const enabledProfile = async () => ({
		...(await resolveBuiltinSidechatOocProfile()),
		toolSet: {
			[DIRECTOR_MESSAGE_TOOLS.requestMessageSwipe]: true,
			[DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit]: true,
		},
	});
	sidechatDepsBase = {
		store: stores.experienceCopilot,
		sync: {
			chats: stores.chats,
			messages: stores.messages,
			assembly,
			experienceCopilot: stores.experienceCopilot,
		},
		context: {
			chats: stores.chats,
			characters: stores.characters,
			messages: stores.messages,
			traces: stores.traces,
			chatSummaries: stores.chatSummaries,
			experienceCopilot: stores.experienceCopilot,
			agentPlans: stores.agentPlans,
			presets: stores.presets,
			assembly,
		},
		attach: {
			chats: stores.chats,
			messages: stores.messages,
			assembly,
			experienceCopilot: stores.experienceCopilot,
		},
		getProviderProfile: async () => sidechatProfile,
		getEffectiveProviderProfile: async () => sidechatProfile,
		resolveModel: () => ({}) as LanguageModel,
		resolveProfileForChat: enabledProfile,
		db: stores.db,
		searchStoreReads: buildContextSearchStoreReads(stores),
		agentPlans: stores.agentPlans,
		...copilot.directorDelegates.sidechatStreamEntries(),
		streamText: ((opts: { messages: CapturedMessage[]; tools?: Record<string, { execute: (args: unknown) => Promise<unknown> }> }) => {
			capturedMessages = opts.messages;
			capturedTools = (opts.tools ?? {}) as typeof capturedTools;
			return makeFakeStreamTextResult(fakeParts ?? [{ type: "text-delta", text: fakeReply }]);
		}) as unknown as SidechatStreamDeps["streamText"],
	};
	void profileResolver;
});

beforeEach(() => {
	capturedMessages = [];
	capturedTools = {};
	fakeReply = "OOC sidechat reply.";
	fakeParts = null;
	rp.streamInputs = [];
	rp.streamCalls = 0;
	rp.nonstreamingInputs = [];
	rp.nonstreamingCalls = 0;
	rp.streamMode = "text";
});

afterAll(async () => {
	// Join any surviving run so the swept TEMP root never races persistence.
	for (const active of chatAdapter.agentRuns.active()) {
		chatAdapter.agentRuns.stop(active.threadId);
		const subscription = chatAdapter.agentRuns.subscribe(active.threadId);
		if (subscription) for await (const _frame of subscription) { /* join */ }
	}
});

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/** Seed the RP exchange (greeting + user turn + committed assistant target)
 *  through the REAL runtime, then open a chat-owned sidechat thread on the
 *  branch. Returns the target's frozen identity inputs. */
async function makeSwipeThread(): Promise<{
	threadId: string;
	/** The branch THIS thread was created on — the frozen scope every trace
	 *  lookup must use. */
	branchId: string;
	targetMessageId: string;
	targetPosition: number;
	targetVariantId: string;
}> {
	await runtime.chatRuntime.prepareLiveTurn(chatId, USER_TURN, "test-model");
	const appended = await runtime.chatRuntime.appendAssistantReply(chatId, TARGET_REPLY, 42);
	const targetMessageId = appended.messageId as string;
	const threadBranch = appended.branchId as string;
	const branchMessages = await stores.messages.getMessages(threadBranch);
	const targetPosition = branchMessages.find((row) => row.id === targetMessageId)!.position;
	const targetVariantId = (await stores.messages.getVariants(targetMessageId)).find(
		(variant) => variant.isSelected,
	)!.id;
	const thread = await stores.experienceCopilot.startNewChatSession(chatId as string, threadBranch, "sidechat-ooc");
	return { threadId: thread.id, branchId: threadBranch, targetMessageId, targetPosition, targetVariantId };
}

async function drainTurn(threadId: string, content: string): Promise<Array<{ event: string; data: string }>> {
	const chunks: Array<{ event: string; data: string }> = [];
	for await (const chunk of streamSidechatTurn(
		{ threadId, content, providerProfileId: "prov_1" },
		sidechatDepsBase,
	)) {
		chunks.push(chunk);
	}
	return chunks;
}

async function drainAnswerTurn(
	threadId: string,
	answer: { toolCallId: string; decision: "allow" | "deny"; instruction?: string },
): Promise<Array<{ event: string; data: string }>> {
	const chunks: Array<{ event: string; data: string }> = [];
	for await (const chunk of streamSidechatTurn(
		{ threadId, answer, providerProfileId: "prov_1" },
		sidechatDepsBase,
	)) {
		chunks.push(chunk);
	}
	return chunks;
}

/** Pause a thread on a REAL awaiting swipe marker: serve the tool through the
 *  real buildTools seam, execute it against the real stores, and run the
 *  scripted marker turn that persists the awaiting row. */
async function pauseOnSwipeMarker(
	threadId: string,
	targetPosition: number,
): Promise<DirectorSwipePermissionMarker> {
	await drainTurn(threadId, "Give me another take");
	const tool = capturedTools[DIRECTOR_MESSAGE_TOOLS.requestMessageSwipe];
	expect(tool).toBeDefined();
	const marker = (await tool!.execute(
		{ position: targetPosition, instruction: DRAFT_INSTRUCTION },
		{ toolCallId: SWIPE_TOOL_CALL_ID },
	)) as DirectorSwipePermissionMarker;
	expect(marker.status).toBe("awaiting_permission");
	fakeParts = [
		{
			type: "tool-call",
			toolCallId: SWIPE_TOOL_CALL_ID,
			toolName: DIRECTOR_MESSAGE_TOOLS.requestMessageSwipe,
			input: { position: targetPosition, instruction: DRAFT_INSTRUCTION },
		},
		{ type: "tool-result", toolCallId: SWIPE_TOOL_CALL_ID, toolName: DIRECTOR_MESSAGE_TOOLS.requestMessageSwipe, output: marker },
	];
	await drainTurn(threadId, "That one, please.");
	fakeParts = null;
	// The awaiting row persisted (fresh read = the reload view).
	const row = await storedToolRow(threadId, SWIPE_TOOL_CALL_ID);
	expect(row!.output.status).toBe("awaiting_permission");
	return marker;
}

/** The stored tool-result row for a toolCallId, parsed (fresh store read). */
async function storedToolRow(
	threadId: string,
	toolCallId: string,
): Promise<{ toolName: string; output: Record<string, unknown> } | null> {
	const rows = await stores.experienceCopilot.listMessages(threadId);
	const row = rows.find((m) => m.role === "tool" && m.toolCallId === toolCallId);
	if (!row) return null;
	return JSON.parse(row.content) as { toolName: string; output: Record<string, unknown> };
}

function instructionOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/** The request_instruction layer of a captured prompt, if any. */
function requestInstructionLayer(prompt: ProviderExecutionInput["prompt"]): { text?: string; injectionDepth?: number } | undefined {
	const layers = (prompt as { layers?: Array<{ id: string; text?: string; injectionDepth?: number }> }).layers ?? [];
	const layer = layers.find((candidate) => candidate.id === "request_instruction");
	if (layer === undefined) return undefined;
	return { text: layer.text, injectionDepth: layer.injectionDepth };
}

/** The directed variant + its LINKED trace carry the EXACT approved text
 *  through the NORMAL trace (the packet's "never a test-only payload" pin —
 *  getTraceByVariant over the real assembly, the DMT-13 convention). */
async function assertDirectedTrace(
	threadBranchId: string,
	targetMessageId: string,
	expectedInstruction: string,
): Promise<void> {
	const directed = (await stores.messages.getVariants(targetMessageId)).find(
		(variant) => variant.content === DIRECTED_REPLY,
	);
	expect(directed).toBeDefined();
	const trace = await stores.traces.getTraceByVariant(chatId as string, threadBranchId, directed!.id);
	expect(trace).not.toBeNull();
	const instructionLayers = trace!.assembledLayers.filter((candidate) => candidate.id === "request_instruction");
	expect(instructionLayers).toHaveLength(1);
	expect(instructionLayers[0]!.text).toBe(expectedInstruction);
	expect(instructionLayers[0]!.position).toBe("in_chat");
	expect(instructionLayers[0]!.injectionDepth).toBe(1);
	expect(instructionLayers[0]!.sourceType).toBe("request_instruction");
	expect(instructionOccurrences(JSON.stringify(trace!.finalPayload), expectedInstruction)).toBe(1);
}

/** The post-resolution ordinary generation is CLEAN: the captured prompt has
 *  no request_instruction layer and neither the draft nor the approved text
 *  anywhere in it, and the new reply's LINKED trace says the same. The reply
 *  id is the caller's: a manual swipe appends a VARIANT of the target, an
 *  ordinary send a NEW message row. */
async function assertCleanOrdinaryGeneration(
	threadBranchId: string,
	replyMessageId: string,
	capturedIndex: number,
): Promise<void> {
	const prompt = rp.nonstreamingInputs[capturedIndex]!;
	expect(requestInstructionLayer(prompt.prompt)).toBeUndefined();
	const payload = JSON.stringify((prompt.prompt as { finalPayload: unknown }).finalPayload);
	expect(instructionOccurrences(payload, EDITED_INSTRUCTION)).toBe(0);
	expect(instructionOccurrences(payload, DRAFT_INSTRUCTION)).toBe(0);
	const ordinary = (await stores.messages.getVariants(replyMessageId)).find(
		(variant) => variant.content === ORDINARY_REPLY,
	);
	expect(ordinary).toBeDefined();
	const trace = await stores.traces.getTraceByVariant(chatId as string, threadBranchId, ordinary!.id);
	expect(trace).not.toBeNull();
	expect(trace!.assembledLayers.find((candidate) => candidate.id === "request_instruction")).toBeUndefined();
	expect(instructionOccurrences(JSON.stringify(trace!.finalPayload), EDITED_INSTRUCTION)).toBe(0);
	expect(instructionOccurrences(JSON.stringify(trace!.finalPayload), DRAFT_INSTRUCTION)).toBe(0);
}

// ─── The proposal-row fixtures (agent-thread-proposals.test.ts convention) ──

/** An assistant reply on the chat's active branch with the given swipe texts
 *  (the same store path the RP send path uses). */
async function addReply(variants: string[], selectedVariantIndex = 0): Promise<DbMessage> {
	return stores.messages.addMessage({
		chatId: chatId as string,
		branchId: branchId as string,
		role: "assistant",
		authorType: "assistant",
		content: variants[selectedVariantIndex] ?? variants[0]!,
		variants,
		selectedVariantIndex,
	});
}

const EDIT_CANDIDATE = "She opened the door quietly.";
const VARIANT_SAVE_TEXT = "The Director's own alternative reply.";

/** A `message-edit` proposal frozen from a real swipe row — the exact payload
 *  shape the DMT-21 tool persists. */
function makeEditProposal(id: string, message: DbMessage, variant: DbMessageVariant): RecordProposal {
	const payload: DirectorMessageEditProposal = {
		source: {
			messageId: message.id,
			variantId: variant.id,
			position: message.position,
			variantNumber: variant.variantIndex + 1,
		},
		sourceText: variant.content,
		instruction: "Fix the adverb.",
		candidate: EDIT_CANDIDATE,
		editor: { modelId: "editor_model_1" },
	};
	return {
		kind: "record",
		id,
		recordType: DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit,
		op: "update",
		targetId: message.id,
		payload,
		status: "pending",
	};
}

/** A `message-variant` proposal frozen from real swipe rows — the DMT-21
 *  shape: frozen source identities + the complete Director-written text. */
function makeVariantProposal(id: string, message: DbMessage, sources: readonly DbMessageVariant[], content: string): RecordProposal {
	const payload: DirectorMessageVariantProposal = {
		sources: sources.map((variant) => ({
			messageId: message.id,
			variantId: variant.id,
			position: message.position,
			variantNumber: variant.variantIndex + 1,
		})),
		content,
	};
	return {
		kind: "record",
		id,
		recordType: DIRECTOR_MESSAGE_RECORD_TYPES.messageVariant,
		op: "create",
		targetId: message.id,
		payload,
		status: "pending",
	};
}

/** One persisted proposal tool row of the given type on a REAL chat-owned
 *  sidechat thread — exactly the shape the generic loop writes for a
 *  proposal tool result (`{ toolName, output }` keyed by the proposal id). */
async function seedProposalRow(toolName: string, proposal: RecordProposal): Promise<{ threadId: string; toolCallId: string }> {
	const thread = await stores.experienceCopilot.startNewChatSession(chatId as string, branchId as string, "sidechat-ooc");
	await stores.experienceCopilot.appendMessage(thread.id, {
		role: "tool",
		content: JSON.stringify({ toolName, output: proposal }),
		toolCallId: proposal.id,
	});
	return { threadId: thread.id, toolCallId: proposal.id };
}

function applyUrl(threadId: string, toolCallId: string): string {
	return `/api/agent/threads/${threadId}/proposals/${toolCallId}/apply`;
}

async function rowStatus(threadId: string, toolCallId: string): Promise<string> {
	const row = (await stores.experienceCopilot.listMessages(threadId)).find(
		(message) => message.toolCallId === toolCallId,
	);
	return (JSON.parse(row!.content as string) as { output: RecordProposal }).output.status;
}

/** Both provider boundaries stayed silent (review resolution never runs a
 *  generation — the packet's cross-boundary pin the route-level suite cannot
 *  observe, having no providers wired). */
function expectNoProviderRuns(): void {
	expect(rp.streamCalls).toBe(0);
	expect(rp.nonstreamingCalls).toBe(0);
	expect(capturedMessages).toEqual([]);
}

// Heavy real-boundary tests: every scenario runs MULTIPLE full RP/sidechat
// assemblies over the shared real SQLite (growing branch context), so the
// per-test timeout is the runner's default 5s RAISED to cover the actual
// deterministic workload — never to mask a race (all waits are awaited
// completions; no sleeps).
const HEAVY_TIMEOUT = 120_000;

// ─── Case 1: the ordinary send boundary after a directed swipe ───────────────

describe("ordinary RP generation after a directed swipe (DMT-35)", () => {
	it("a normal send immediately after an allowed swipe is clean: no instruction layer in its prompt or its variant's linked trace", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		await pauseOnSwipeMarker(threadId, targetPosition);
		await drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow", instruction: EDITED_INSTRUCTION });
		expect(rp.streamCalls).toBe(1);
		const directedLayer = requestInstructionLayer(rp.streamInputs[0]!.prompt);
		expect(directedLayer!.text).toBe(EDITED_INSTRUCTION);
		await assertDirectedTrace(threadBranchId, targetMessageId, EDITED_INSTRUCTION);

		// The ordinary RP send (the public adapter path — the NEXT user turn,
		// never a regenerate): it must be clean. A send appends its own NEW
		// message row (a variant of that row), never a variant of the target.
		await chatAdapter.sendMessage(chatId as string, { content: NEXT_USER_TURN });
		expect(rp.nonstreamingCalls).toBe(1);
		const branchMessages = await stores.messages.getMessages(threadBranchId);
		const sendUserRow = branchMessages.find((row) => row.role === "user" && row.content === NEXT_USER_TURN);
		expect(sendUserRow).toBeDefined();
		const sendReply = branchMessages.filter((row) => row.role === "assistant").at(-1)!;
		expect(sendReply.content).toBe(ORDINARY_REPLY);
		await assertCleanOrdinaryGeneration(threadBranchId, sendReply.id, 0);
		// The send's own history is intact (the greeting and both turns ride).
		const sendPayload = JSON.stringify((rp.nonstreamingInputs[0]!.prompt as { finalPayload: unknown }).finalPayload);
		expect(sendPayload).toContain(GREETING);
		expect(sendPayload).toContain(USER_TURN);
		expect(sendPayload).toContain(NEXT_USER_TURN);
	}, HEAVY_TIMEOUT);
});

// ─── Case 2: manual swipes after DENIED / STOPPED / FAILED requests ──────────

describe("manual swipe after an unresolved-or-absorbed directed request (DMT-35)", () => {
	it("after a DENIED directed request a manual swipe still works and carries no instruction", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		await pauseOnSwipeMarker(threadId, targetPosition);
		await drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "deny" });
		expect(rp.streamCalls).toBe(0);
		const row = await storedToolRow(threadId, SWIPE_TOOL_CALL_ID);
		expect(row!.output).toEqual({ status: "denied" });

		// The manual swipe still works: exactly one ordinary generation, the
		// new variant appended AND selected, its linked trace clean.
		await chatAdapter.regenerateMessage(chatId as string, targetMessageId);
		expect(rp.nonstreamingCalls).toBe(1);
		await assertCleanOrdinaryGeneration(threadBranchId, targetMessageId, 0);
		const deniedAfter = (await stores.messages.getVariants(targetMessageId)).find(
			(variant) => variant.content === ORDINARY_REPLY,
		);
		expect(deniedAfter!.isSelected).toBe(true);
		// The denied request stays denied — a decision, not a retry queue.
		expect((await storedToolRow(threadId, SWIPE_TOOL_CALL_ID))!.output).toEqual({ status: "denied" });
	}, HEAVY_TIMEOUT);

	it("after a STOPPED directed request a manual swipe still works and carries no instruction", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		await pauseOnSwipeMarker(threadId, targetPosition);
		rp.streamMode = "stop";
		await drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow", instruction: EDITED_INSTRUCTION });
		expect(rp.streamCalls).toBe(1);
		// The partial variant kept the instruction in ITS trace (the directed
		// run's own trace — exact text through the normal trace).
		const partial = (await stores.messages.getVariants(targetMessageId)).find(
			(variant) => variant.content === PARTIAL_REPLY,
		);
		expect(partial).toBeDefined();
		const partialTrace = await stores.traces.getTraceByVariant(chatId as string, threadBranchId, partial!.id);
		expect(partialTrace).not.toBeNull();
		expect(partialTrace!.assembledLayers.find((candidate) => candidate.id === "request_instruction")!.text).toBe(EDITED_INSTRUCTION);

		// The manual swipe still works: one ordinary generation, new variant
		// appended AND selected, its linked trace clean.
		await chatAdapter.regenerateMessage(chatId as string, targetMessageId);
		expect(rp.nonstreamingCalls).toBe(1);
		await assertCleanOrdinaryGeneration(threadBranchId, targetMessageId, 0);
		const stopAfter = (await stores.messages.getVariants(targetMessageId)).find(
			(variant) => variant.content === ORDINARY_REPLY,
		);
		expect(stopAfter!.isSelected).toBe(true);
	}, HEAVY_TIMEOUT);

	it("after a FAILED directed request a manual swipe still works and carries no instruction", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		const variantsBefore = (await stores.messages.getVariants(targetMessageId)).map((variant) => variant.id);
		await pauseOnSwipeMarker(threadId, targetPosition);
		rp.streamMode = "fail";
		await drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow", instruction: EDITED_INSTRUCTION });
		expect(rp.streamCalls).toBe(1);
		// The failure was absorbed: the decision is durable, no variant landed.
		const row = await storedToolRow(threadId, SWIPE_TOOL_CALL_ID);
		expect(row!.output.status).toBe("granted");
		expect((row!.output as unknown as DirectorSwipeGrantedReceipt).instruction).toBe(EDITED_INSTRUCTION);
		expect((await stores.messages.getVariants(targetMessageId)).map((variant) => variant.id)).toEqual(variantsBefore);

		// The manual swipe still works: one ordinary generation, new variant
		// appended AND selected, its linked trace clean.
		await chatAdapter.regenerateMessage(chatId as string, targetMessageId);
		expect(rp.nonstreamingCalls).toBe(1);
		await assertCleanOrdinaryGeneration(threadBranchId, targetMessageId, 0);
		const failAfter = (await stores.messages.getVariants(targetMessageId)).find(
			(variant) => variant.content === ORDINARY_REPLY,
		);
		expect(failAfter!.isSelected).toBe(true);
	}, HEAVY_TIMEOUT);
});

// ─── Cases 3 + 4: reload before a decision, replay after a decision ──────────

describe("reload and replay around a swipe decision (DMT-35)", () => {
	it("reload before a decision: fresh persisted rows still decide, and restoring state starts no generation", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		await pauseOnSwipeMarker(threadId, targetPosition);

		// The reload view: fresh reads of the persisted rows parse the awaiting
		// marker back with its full draft (what a restored client decides on).
		const row = await storedToolRow(threadId, SWIPE_TOOL_CALL_ID);
		expect(row!.toolName).toBe(DIRECTOR_MESSAGE_TOOLS.requestMessageSwipe);
		const marker = row!.output as unknown as DirectorSwipePermissionMarker;
		expect(marker.status).toBe("awaiting_permission");
		expect(marker.instruction).toBe(DRAFT_INSTRUCTION);
		expect(marker.messageId).toBe(targetMessageId);

		// Restoring state starts NOTHING: a retained run (from any earlier
		// generation on this chat — the registry retains logs until the next
		// run) replays READ-ONLY — draining it executes no provider call —
		// and an unrelated content turn over the re-read history executes no
		// generation either.
		const retainedReplay = chatAdapter.subscribeChatGeneration(chatId as string, 0);
		if (retainedReplay !== null) for await (const _frame of retainedReplay) { /* drain */ }
		expect(rp.streamCalls).toBe(0);
		expect(rp.nonstreamingCalls).toBe(0);
		await drainTurn(threadId, "Never mind for now.");
		expect(rp.streamCalls).toBe(0);
		expect(rp.nonstreamingCalls).toBe(0);
		// The unrelated turn preserved the awaiting row.
		expect((await storedToolRow(threadId, SWIPE_TOOL_CALL_ID))!.output.status).toBe("awaiting_permission");

		// The persisted row still decides: exactly one generation with the
		// EXACT approved text through the normal trace.
		await drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow", instruction: EDITED_INSTRUCTION });
		expect(rp.streamCalls).toBe(1);
		expect(requestInstructionLayer(rp.streamInputs[0]!.prompt)!.text).toBe(EDITED_INSTRUCTION);
		await assertDirectedTrace(threadBranchId, targetMessageId, EDITED_INSTRUCTION);
		const decided = await storedToolRow(threadId, SWIPE_TOOL_CALL_ID);
		expect(decided!.output.status).toBe("granted");
		expect((decided!.output as unknown as DirectorSwipeGrantedReceipt).instruction).toBe(EDITED_INSTRUCTION);
	}, HEAVY_TIMEOUT);

	it("replay after a decision: no duplicate apply, no second provider run, the approved trace stays exact", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		await pauseOnSwipeMarker(threadId, targetPosition);
		await drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow", instruction: EDITED_INSTRUCTION });
		expect(rp.streamCalls).toBe(1);
		const resolvedRow = await storedToolRow(threadId, SWIPE_TOOL_CALL_ID);
		expect(resolvedRow!.output.status).toBe("granted");

		// A competing answer on the RESOLVED row is refused — never re-executed.
		await expect(
			drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow", instruction: "SECOND" }),
		).rejects.toThrow(/no longer awaiting/);
		expect(rp.streamCalls).toBe(1);

		// Restoring the UI: replaying the finished RP run's log re-emits its
		// events and starts NO new generation; the replayed state's directed
		// trace still carries the EXACT approved text (the durable decision).
		const replayed: Array<{ event: string }> = [];
		const subscription = chatAdapter.subscribeChatGeneration(chatId as string, 0);
		expect(subscription).not.toBeNull();
		for await (const frame of subscription!) replayed.push({ event: frame.event });
		expect(rp.streamCalls).toBe(1);
		expect(rp.nonstreamingCalls).toBe(0);
		await assertDirectedTrace(threadBranchId, targetMessageId, EDITED_INSTRUCTION);
		// The receipt is intact after the replay (the decision, not a fresh row).
		expect(await storedToolRow(threadId, SWIPE_TOOL_CALL_ID)).toEqual(resolvedRow);

		// A later content turn reads the resolved history and executes nothing.
		await drainTurn(threadId, "Thanks!");
		expect(rp.streamCalls).toBe(1);
		expect(rp.nonstreamingCalls).toBe(0);
	}, HEAVY_TIMEOUT);
});

// ─── Review resolution through the REAL proposal routes ──────────────────────

describe("persisted proposal rows resolve through the real routes (DMT-35)", () => {
	it("a message-edit proposal applies with the target-scoped companion while NO provider ever runs; a replayed apply is the typed 409", async () => {
		const reply = await addReply(["She opened the door slowly.", "She pushed the door open."]);
		const [v0] = await stores.messages.getVariants(reply.id);
		const proposal = makeEditProposal("tc_dmt35_edit", reply, v0!);
		const { threadId, toolCallId } = await seedProposalRow(DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit, proposal);

		const response = await proposalApp.request(applyUrl(threadId, toolCallId), { method: "POST" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			proposal: RecordProposal;
			message?: {
				chatId: string;
				branchId: string;
				message: { id: string; content: string };
				variants: Array<{ id: string; content: string; isSelected: boolean }>;
			};
		};
		expect(body.proposal).toEqual({ ...proposal, status: "applied" });
		// The companion is TARGET-SCOPED: the affected message + its full
		// variant list, with the chat/branch scope attached.
		expect(body.message?.chatId).toBe(chatId);
		expect(body.message?.branchId).toBe(branchId);
		expect(body.message?.message).toMatchObject({ id: reply.id, content: EDIT_CANDIDATE });
		expect(body.message?.variants[0]).toMatchObject({ id: v0!.id, content: EDIT_CANDIDATE, isSelected: true });
		expect(body.message?.variants[1]).toMatchObject({ content: "She pushed the door open.", isSelected: false });

		// Review resolution NEVER runs a generation — neither RP boundary nor
		// the sidechat LLM was touched.
		expectNoProviderRuns();

		// Replay (a second apply of the resolved row) is the typed 409 and
		// writes nothing — no duplicate apply.
		const second = await proposalApp.request(applyUrl(threadId, toolCallId), { method: "POST" });
		expect(second.status).toBe(409);
		const conflict = (await second.json()) as { error: { details?: { code?: string } } };
		expect(conflict.error.details?.code).toBe("objective_proposal_already_resolved");
		expect((await stores.messages.getVariants(reply.id))[0]?.content).toBe(EDIT_CANDIDATE);
		expect(await rowStatus(threadId, toolCallId)).toBe("applied");

		// The reload view: the wire row parses back applied with no refetch.
		const messages = await copilotWire.experienceCopilotListMessages(threadId);
		const parsed = JSON.parse(messages.find((m) => m.toolCallId === toolCallId)!.content) as { toolName: string; output: RecordProposal };
		expect(parsed.toolName).toBe(DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit);
		expect(parsed.output.status).toBe("applied");
		expectNoProviderRuns();
	}, HEAVY_TIMEOUT);

	it("a message-variant proposal saves as a separate selected swipe through the route; a replayed save is refused; no provider ever runs", async () => {
		const reply = await addReply(["Original reply."]);
		const variants = await stores.messages.getVariants(reply.id);
		const proposal = makeVariantProposal("tc_dmt35_variant", reply, variants, VARIANT_SAVE_TEXT);
		const { threadId, toolCallId } = await seedProposalRow(DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant, proposal);

		const response = await proposalApp.request(applyUrl(threadId, toolCallId), { method: "POST" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			proposal: RecordProposal;
			message?: { chatId: string; branchId: string; message: { content: string }; variants: Array<{ content: string; isSelected: boolean }> };
		};
		expect(body.proposal).toEqual({ ...proposal, status: "applied" });
		expect(body.message?.chatId).toBe(chatId);
		// The appended swipe: content verbatim, selected, DIRECTOR authorship
		// (no RP provenance).
		const after = await stores.messages.getVariants(reply.id);
		expect(after).toHaveLength(2);
		expect(after[0]).toMatchObject({ content: "Original reply.", isSelected: false });
		expect(after[1]).toMatchObject({ content: VARIANT_SAVE_TEXT, isSelected: true });
		expect((await stores.messages.getMessageById(reply.id))?.content).toBe(VARIANT_SAVE_TEXT);

		expectNoProviderRuns();

		// The replayed save is the typed 409; exactly one swipe was appended.
		const second = await proposalApp.request(applyUrl(threadId, toolCallId), { method: "POST" });
		expect(second.status).toBe(409);
		expect(((await second.json()) as { error: { details?: { code?: string } } }).error.details?.code).toBe(
			"objective_proposal_already_resolved",
		);
		expect(await stores.messages.getVariants(reply.id)).toHaveLength(2);

		// The reload view parses back applied, and no provider ever ran.
		const messages = await copilotWire.experienceCopilotListMessages(threadId);
		const parsed = JSON.parse(messages.find((m) => m.toolCallId === toolCallId)!.content) as { output: RecordProposal };
		expect(parsed.output.status).toBe("applied");
		expectNoProviderRuns();
	}, HEAVY_TIMEOUT);
});
