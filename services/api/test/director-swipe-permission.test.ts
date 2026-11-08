import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import {
	DIRECTOR_MESSAGE_TOOLS,
	type DirectorSwipeGrantedReceipt,
	type DirectorSwipePermissionMarker,
} from "@vibe-tavern/api-contracts";
import { EventBus, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { wireDirectorMessageDelegates } from "../src/api/adapters/runtime-api-adapter.js";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import { getChatModeStrategy } from "../src/domain/chat/chat-mode-strategy.js";
import { ChatSummaryService } from "../src/domain/chat/chat-summary-service.js";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { ProviderOrchestrator } from "../src/domain/providers/provider-orchestrator.js";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
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
import type { StreamTextPart } from "./provider-boundary-test-builders.js";
import { makeSidechatProviderProfile, makeStreamTextDouble } from "./provider-boundary-test-builders.js";

// ════════════════════════════════════════════════════════════════════════════
// DMT-24 (director message tools) — an allowed `request_message_swipe` runs
// EXACTLY ONE ordinary server-owned RP regeneration through the REAL adapter
// composition: the sidechat split-turn (real stores, real marker rows, real
// answer application) → the DMT-23 injected seam → the DMT-24 domain delegate
// (`runDirectorSwipeGeneration`) → the runtime composition's closures
// (`wireDirectorMessageDelegates` — the SAME function the production server
// calls) → the chat adapter's branch-pinned run (the normal `chat:<chatId>`
// reservation, the thread's branch) → the real orchestrator streaming
// regenerate with the DMT-13 `requestInstruction` → real variant/trace
// persistence.
//
// The only fakes are the TWO provider boundaries (AGENTS.md tier policy —
// the executor seams, never mock.module):
// - the RP provider, through the orchestrator's `executors` injection
//   (capturing/failing/stopping streaming + non-streaming executors, the
//   director-swipe-regeneration / chat-generation-background-routes pattern);
// - the sidechat LLM, through the deps' injectable `streamText` (the
//   sidechat-ooc-stream pattern) so the real turn loop serves the real tools
//   and persists the real marker rows.
//
// Lifecycle pins (the unit's heart):
//   Allow → one generation, variant appended, trace carries the APPROVED
//   instruction (edited text, never the draft), reservation released;
//   Deny → no provider call; an already-running RP generation is an EXPLICIT
//   conflict (the row stays awaiting, nothing queued); source/branch deletion
//   refuses; duplicate decisions cannot start a second generation and replay
//   does not re-execute; the request survives reload undecided and the
//   decision/result is durable after; provider abort/failure leaves the
//   instruction owned by the accepted invocation only — a later manual swipe
//   never inherits it.
// ════════════════════════════════════════════════════════════════════════════

const GREETING = "Hello there, traveler.";
const USER_TURN = "What is behind the door?";
const TARGET_REPLY = "The door creaks open, revealing a dusty study.";
const DIRECTED_REPLY = "Directed swipe reply, freshly generated.";
const ORDINARY_REPLY = "Ordinary manual swipe reply.";
const PARTIAL_REPLY = "Partial swipe reply before the Stop.";
const DRAFT_INSTRUCTION = "DRAFT: rewrite the reply about the dusty study.";
const EDITED_INSTRUCTION = "EDITED: rewrite the reply, mention the brass key.";

/** The toolCallId the scripted request turn persists the marker under. */
const SWIPE_TOOL_CALL_ID = "tc_swipe_perm_1";

// ─── The RP provider boundary (the orchestrator's executor seam) ─────────────

interface RpExecutorState {
	/** The streaming executor's captured inputs (prompts for instruction
	 *  assertions) and its call count — the "exactly one generation" pin. */
	streamInputs: ProviderExecutionInput[];
	streamCalls: number;
	/** The non-streaming executor's captured inputs (the MANUAL regenerate
	 *  path's prompts — the "later generations never inherit" pin). */
	nonstreamingInputs: ProviderExecutionInput[];
	nonstreamingCalls: number;
	/** Per-test behavior of the NEXT streaming call: plain text, provider
	 *  failure, or an ordinary mid-stream Stop (the RP run's own stop). */
	streamMode: "text" | "fail" | "stop";
	/** The parked-conflict machinery: when set, the NON-STREAMING executor
	 *  signals `enteredResolve` on entry and parks until `release` resolves —
	 *  the manual generation holding the chat slot while a swipe Allow races
	 *  it. */
	park: { enteredResolve: () => void; release: Promise<void> } | null;
}

function makeRpExecutorState(): RpExecutorState {
	return {
		streamInputs: [],
		streamCalls: 0,
		nonstreamingInputs: [],
		nonstreamingCalls: 0,
		streamMode: "text",
		park: null,
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
		if (rp.park !== null) {
			rp.park.enteredResolve();
			await rp.park.release;
			input.signal?.throwIfAborted();
		}
		return { text: ORDINARY_REPLY, providerResponse: { mode: "nonstream" as const, steps: [] } };
	};
}

// ─── The sidechat LLM boundary (the deps' injectable streamText) ─────────────

type CapturedMessage = { role: string; content: unknown };
/** The suite's view of the captured production tools. The SDK's Tool union
 *  assigns straight into this method-typed probe (method syntax is bivariant
 *  under strictFunctionTypes, so no cast sits at the capture boundary);
 *  `execute` stays optional because the SDK types it optional — the
 *  `tool!.execute!(…)` at the call sites carries the buildTools-always-wires-
 *  execute proof (and the `expect(tool).toBeDefined()` pin above each call). */
interface CapturedToolProbe {
	execute?(args: unknown, options?: { toolCallId: string; abortSignal?: AbortSignal }): unknown;
}
let capturedMessages: CapturedMessage[] = [];
let capturedTools: Record<string, CapturedToolProbe> = {};
let fakeReply = "OOC sidechat reply.";
let fakeParts: StreamTextPart[] | null = null;

// ─── Real-container harness ──────────────────────────────────────────────────

let stores: StoreContainer;
let runtime: SessionRuntime;
let chatAdapter: ChatAdapter;
let copilot: ExperienceCopilotAdapter;
let rp: RpExecutorState;
let sidechatDepsBase: SidechatStreamDeps;
let chatId: ChatId;
let branchId: ChatBranchId;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-director-swipe-permission-"));
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
		name: "Swipe Probe",
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

	// The sidechat stream deps — the production wiring shape over the REAL
	// stores (real sync + SC-3b package + SC-4b assembly + SC-0f profile
	// chain), with the two provider-boundary fakes and the swipe/edit toggles
	// enabled (the toggle keys are not public until DMT-34 — the DMT-23
	// suite's same stand-in). The delegate factories are the REAL configured
	// slot entries (wireDirectorMessageDelegates above), never test doubles.
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
			// DK-5b: the branch-deck read for the <story_deck> section.
			storyDecks: stores.storyDecks,
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
		streamText: makeStreamTextDouble((options) => {
			capturedMessages = options.messages ?? [];
			capturedTools = options.tools ?? {};
			return { parts: fakeParts ?? [{ type: "text-delta", id: "swipe-fake", text: fakeReply }] };
		}, "sidechat streamText (director-swipe-permission)"),
	};
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
	rp.park = null;
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
	 *  lookup must use (the module-level branch can be deleted by the
	 *  branch-deletion scenario; later threads resolve the chat's then-active
	 *  branch). */
	branchId: string;
	targetMessageId: string;
	targetPosition: number;
	targetVariantId: string;
}> {
	await runtime.chatRuntime.prepareLiveTurn(chatId, USER_TURN, "test-model");
	const appended = await runtime.chatRuntime.appendAssistantReply(chatId, TARGET_REPLY, 42);
	const targetMessageId = appended.messageId as string;
	const branch = appended.branchId as string;
	const branchMessages = await stores.messages.getMessages(branch);
	const targetPosition = branchMessages.find((row) => row.id === targetMessageId)!.position;
	const targetVariantId = (await stores.messages.getVariants(targetMessageId)).find(
		(variant) => variant.isSelected,
	)!.id;
	const thread = await stores.experienceCopilot.startNewChatSession(chatId as string, branch, "sidechat-ooc");
	return { threadId: thread.id, branchId: branch, targetMessageId, targetPosition, targetVariantId };
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
	const marker = (await tool!.execute!(
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

/** The stored tool-result row for a toolCallId, parsed fresh from the store.
 *  The output type parameter narrows at the ONE wire boundary — JSON.parse —
 *  so the receipt/marker readers take a real typed output instead of an
 *  `as unknown as` downcast at every use site. Default stays the loose
 *  record the status pins read through. */
async function storedToolRow<T = Record<string, unknown>>(
	threadId: string,
	toolCallId: string,
): Promise<{ toolName: string; output: T } | null> {
	const rows = await stores.experienceCopilot.listMessages(threadId);
	const row = rows.find((m) => m.role === "tool" && m.toolCallId === toolCallId);
	if (!row) return null;
	return JSON.parse(row.content) as { toolName: string; output: T };
}

/** Every model-facing message flattened to one string. */
function promptText(): string {
	return capturedMessages
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
		.join("\n");
}

function instructionOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/** The chat run slot's occupancy (the reservation-taken/released pin). */
function activeChatRunCount(): number {
	return chatAdapter.agentRuns.active().filter(
		(run) => run.owner.kind === "chat" && run.owner.chatId === (chatId as string),
	).length;
}

/** The request_instruction layer of a captured prompt, if any. */
function requestInstructionLayer(prompt: ProviderExecutionInput["prompt"]): { text?: string; injectionDepth?: number } | undefined {
	const layers = (prompt as { layers?: Array<{ id: string; text?: string; injectionDepth?: number }> }).layers ?? [];
	const layer = layers.find((candidate) => candidate.id === "request_instruction");
	if (layer === undefined) return undefined;
	return { text: layer.text, injectionDepth: layer.injectionDepth };
}

// ─── The lifecycle pins ──────────────────────────────────────────────────────

// Heavy real-boundary tests: every scenario runs MULTIPLE full RP/sidechat
// assemblies over the shared real SQLite (growing branch context), so the
// per-test timeout is the runner's default 5s RAISED to cover the actual
// deterministic workload — never to mask a race (all waits are awaited
// completions; no sleeps).
const HEAVY_TIMEOUT = 120_000;

describe("director swipe permission — Allow through the real adapter composition", () => {
	it("Allow runs exactly ONE normal RP generation: variant appended and selected, trace carries the EDITED approved instruction, reservation released", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition, targetVariantId } = await makeSwipeThread();
		const marker = await pauseOnSwipeMarker(threadId, targetPosition);
		expect(marker.variantId).toBe(targetVariantId);
		expect(activeChatRunCount()).toBe(0);

		const chunks = await drainAnswerTurn(threadId, {
			toolCallId: SWIPE_TOOL_CALL_ID,
			decision: "allow",
			instruction: `  ${EDITED_INSTRUCTION}  `,
		});
		expect(chunks.map((c) => c.event)).toContain("finish");
		expect(chunks.map((c) => c.event)).not.toContain("error");

		// Exactly ONE streaming RP generation, carrying the final approved text.
		expect(rp.streamCalls).toBe(1);
		const layer = requestInstructionLayer(rp.streamInputs[0]!.prompt);
		expect(layer).toBeDefined();
		expect(layer!.text).toBe(EDITED_INSTRUCTION);
		// Payload identity (the DMT-13 pin's scope): the instruction rides the
		// provider payload exactly once, and never as the draft.
		const directedPayload = JSON.stringify(
			(rp.streamInputs[0]!.prompt as { finalPayload: unknown }).finalPayload,
		);
		expect(instructionOccurrences(directedPayload, EDITED_INSTRUCTION)).toBe(1);
		expect(instructionOccurrences(directedPayload, DRAFT_INSTRUCTION)).toBe(0);

		// The variant appended through the NORMAL persistence path, selected,
		// with a LINKED trace carrying the same instruction layer.
		const variants = await stores.messages.getVariants(targetMessageId);
		const directed = variants.find((variant) => variant.content === DIRECTED_REPLY);
		expect(directed).toBeDefined();
		expect(directed!.isSelected).toBe(true);
		const trace = await stores.traces.getTraceByVariant(chatId as string, threadBranchId, directed!.id);
		expect(trace).not.toBeNull();
		const traceLayers = trace!.assembledLayers.filter((candidate) => candidate.id === "request_instruction");
		expect(traceLayers).toHaveLength(1);
		expect(traceLayers[0]!.text).toBe(EDITED_INSTRUCTION);
		expect(traceLayers[0]!.position).toBe("in_chat");
		expect(traceLayers[0]!.injectionDepth).toBe(1);

		// The receipt stores the FINAL approved text (the durable decision).
		const row = await storedToolRow<DirectorSwipeGrantedReceipt>(threadId, SWIPE_TOOL_CALL_ID);
		expect(row!.toolName).toBe(DIRECTOR_MESSAGE_TOOLS.requestMessageSwipe);
		const receipt = row!.output;
		expect(receipt.status).toBe("granted");
		expect(receipt.instruction).toBe(EDITED_INSTRUCTION);
		expect(receipt.messageId).toBe(targetMessageId);

		// The reservation was TAKEN and RELEASED (no active chat run remains).
		expect(activeChatRunCount()).toBe(0);

		// The resumed model reads generation facts (approved + final text),
		// never the prompt-read payload.
		const toolMsg = [...capturedMessages].reverse().find((m) => m.role === "tool");
		const part = (toolMsg!.content as Array<{ type: string; output?: { value?: string } }>)[0]!;
		const wire = JSON.parse(part.output!.value!) as Record<string, unknown>;
		expect(wire).toMatchObject({ approved: true, instruction: EDITED_INSTRUCTION });
	}, HEAVY_TIMEOUT);

	it("Allow without an edit runs the recorded DRAFT (the trace text is the draft)", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		await pauseOnSwipeMarker(threadId, targetPosition);
		await drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow" });
		expect(rp.streamCalls).toBe(1);
		const layer = requestInstructionLayer(rp.streamInputs[0]!.prompt);
		expect(layer!.text).toBe(DRAFT_INSTRUCTION);
		const variants = await stores.messages.getVariants(targetMessageId);
		const directed = variants.find((variant) => variant.content === DIRECTED_REPLY)!;
		const trace = await stores.traces.getTraceByVariant(chatId as string, threadBranchId, directed.id);
		expect(trace!.assembledLayers.find((candidate) => candidate.id === "request_instruction")!.text).toBe(DRAFT_INSTRUCTION);
	}, HEAVY_TIMEOUT);

	it("a LATER ordinary (manual) regeneration carries no instruction — the approved text is request-local", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		await pauseOnSwipeMarker(threadId, targetPosition);
		await drainAnswerTurn(threadId, {
			toolCallId: SWIPE_TOOL_CALL_ID,
			decision: "allow",
			instruction: EDITED_INSTRUCTION,
		});
		expect(rp.streamCalls).toBe(1);

		// The ordinary manual swipe (the public adapter path — no instruction).
		await chatAdapter.regenerateMessage(chatId as string, targetMessageId);
		expect(rp.nonstreamingCalls).toBe(1);
		const ordinaryPrompt = rp.nonstreamingInputs[0]!.prompt;
		expect(requestInstructionLayer(ordinaryPrompt)).toBeUndefined();
		expect(instructionOccurrences(JSON.stringify(ordinaryPrompt), EDITED_INSTRUCTION)).toBe(0);
		const ordinaryVariant = (await stores.messages.getVariants(targetMessageId)).find(
			(variant) => variant.content === ORDINARY_REPLY,
		)!;
		const ordinaryTrace = await stores.traces.getTraceByVariant(chatId as string, threadBranchId, ordinaryVariant.id);
		expect(ordinaryTrace).not.toBeNull();
		expect(ordinaryTrace!.assembledLayers.find((candidate) => candidate.id === "request_instruction")).toBeUndefined();
		expect(instructionOccurrences(JSON.stringify(ordinaryTrace!.finalPayload), EDITED_INSTRUCTION)).toBe(0);
	}, HEAVY_TIMEOUT);
});

describe("director swipe permission — Deny and explicit conflict", () => {
	it("Deny makes NO provider call, mutates no RP message, and stores the denied marker", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		const variantsBefore = (await stores.messages.getVariants(targetMessageId)).map((variant) => variant.id);
		await pauseOnSwipeMarker(threadId, targetPosition);

		const chunks = await drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "deny" });
		expect(chunks.map((c) => c.event)).toContain("finish");
		expect(rp.streamCalls).toBe(0);
		expect(rp.nonstreamingCalls).toBe(0);
		expect((await stores.messages.getVariants(targetMessageId)).map((variant) => variant.id)).toEqual(variantsBefore);
		const row = await storedToolRow(threadId, SWIPE_TOOL_CALL_ID);
		expect(row!.output).toEqual({ status: "denied" });
		expect(activeChatRunCount()).toBe(0);
	}, HEAVY_TIMEOUT);

	it("an already-running RP generation is an EXPLICIT conflict: the answer refuses, the row stays awaiting, the instruction is never queued", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		await pauseOnSwipeMarker(threadId, targetPosition);

		// Occupy the chat's run slot with an ordinary (parked) manual regenerate.
		let releasePark!: () => void;
		const release = new Promise<void>((resolve) => {
			releasePark = resolve;
		});
		let enteredResolve!: () => void;
		const entered = new Promise<void>((resolve) => {
			enteredResolve = resolve;
		});
		rp.park = { enteredResolve, release };
		const parkedRun = chatAdapter.regenerateMessage(chatId as string, targetMessageId);
		await entered;
		expect(activeChatRunCount()).toBe(1);

		// The Allow races the running generation → the registry's explicit
		// conflict, never a silent queue.
		await expect(
			drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow", instruction: EDITED_INSTRUCTION }),
		).rejects.toThrow(/already running/);
		expect(rp.streamCalls).toBe(0);
		const row = await storedToolRow(threadId, SWIPE_TOOL_CALL_ID);
		expect(row!.output.status).toBe("awaiting_permission");
		expect(activeChatRunCount()).toBe(1);

		// Release the manual generation; the SAME request can now be allowed —
		// exactly one generation runs with the approved text (no queued double).
		releasePark();
		await parkedRun;
		expect(activeChatRunCount()).toBe(0);
		await drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow", instruction: EDITED_INSTRUCTION });
		expect(rp.streamCalls).toBe(1);
		expect(requestInstructionLayer(rp.streamInputs[0]!.prompt)!.text).toBe(EDITED_INSTRUCTION);
		const rowAfter = await storedToolRow(threadId, SWIPE_TOOL_CALL_ID);
		expect(rowAfter!.output.status).toBe("granted");
	}, HEAVY_TIMEOUT);
});

describe("director swipe permission — deletion, duplicates, reload durability", () => {
	it("source deletion before Allow refuses the allowance: no generation, the row stays awaiting", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		await pauseOnSwipeMarker(threadId, targetPosition);
		await chatAdapter.deleteMessage(chatId as string, targetMessageId);

		await expect(
			drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow", instruction: EDITED_INSTRUCTION }),
		).rejects.toThrow(/no longer exists/);
		expect(rp.streamCalls).toBe(0);
		const row = await storedToolRow(threadId, SWIPE_TOOL_CALL_ID);
		expect(row!.output.status).toBe("awaiting_permission");
	}, HEAVY_TIMEOUT);

	it("branch deletion before Allow removes the request with its frozen scope: no generation ever runs", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		await pauseOnSwipeMarker(threadId, targetPosition);
		// Fork from the target (activateFork activates the NEW branch), then
		// delete the ORIGINAL branch the thread row still pins. The schema's
		// HARD FK cascade (experience_copilot_threads.branch_id -> chat_branches,
		// onDelete: "cascade") removes the chat-owned thread — and its awaiting
		// request — WITH its branch: a deleted scope can never redirect a
		// confirmation because nothing survives to decide on.
		await chatAdapter.forkBranch(chatId as string, targetMessageId);
		await chatAdapter.deleteBranch(chatId as string, threadBranchId);
		expect(await stores.experienceCopilot.getById(threadId)).toBeNull();

		// The answer turn refuses (the thread row is gone) and no RP provider
		// call ever fires — the allowance cannot execute against a dead scope.
		await expect(
			drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow", instruction: EDITED_INSTRUCTION }),
		).rejects.toThrow();
		expect(rp.streamCalls).toBe(0);
	}, HEAVY_TIMEOUT);

	it("duplicate decisions cannot start a second generation; replaying the RP run re-executes nothing", async () => {
		const { threadId, targetPosition } = await makeSwipeThread();
		await pauseOnSwipeMarker(threadId, targetPosition);
		await drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow", instruction: EDITED_INSTRUCTION });
		expect(rp.streamCalls).toBe(1);
		const resolvedRow = await storedToolRow(threadId, SWIPE_TOOL_CALL_ID);
		expect(resolvedRow!.output.status).toBe("granted");

		// A competing answer on the RESOLVED row is refused (never re-executed).
		await expect(
			drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow", instruction: "SECOND" }),
		).rejects.toThrow(/no longer awaiting/);
		expect(rp.streamCalls).toBe(1);

		// Restoring the UI: replaying the finished RP run's log re-emits its
		// events and starts NO new generation.
		const replayed: Array<{ event: string }> = [];
		const subscription = chatAdapter.subscribeChatGeneration(chatId as string, 0);
		expect(subscription).not.toBeNull();
		for await (const frame of subscription!) replayed.push({ event: frame.event });
		expect(rp.streamCalls).toBe(1);
		expect(activeChatRunCount()).toBe(0);

		// A later content turn reads the resolved history and executes nothing.
		await drainTurn(threadId, "Thanks!");
		expect(rp.streamCalls).toBe(1);
		expect((await storedToolRow(threadId, SWIPE_TOOL_CALL_ID))!.output).toEqual(resolvedRow!.output);
	}, HEAVY_TIMEOUT);

	it("reload before a decision keeps the request undecided; an unrelated turn preserves the awaiting row", async () => {
		const { threadId, targetPosition } = await makeSwipeThread();
		await pauseOnSwipeMarker(threadId, targetPosition);

		// An unrelated discussion turn (the user moved on without deciding).
		await drainTurn(threadId, "Never mind for now.");
		const row = await storedToolRow(threadId, SWIPE_TOOL_CALL_ID);
		expect(row!.output.status).toBe("awaiting_permission");

		// The still-awaiting request remains decidable (reload → decide).
		await drainAnswerTurn(threadId, { toolCallId: SWIPE_TOOL_CALL_ID, decision: "allow", instruction: EDITED_INSTRUCTION });
		expect(rp.streamCalls).toBe(1);
		const decided = await storedToolRow<DirectorSwipeGrantedReceipt>(threadId, SWIPE_TOOL_CALL_ID);
		expect(decided!.output.status).toBe("granted");
		expect(decided!.output.instruction).toBe(EDITED_INSTRUCTION);
	}, HEAVY_TIMEOUT);
});

describe("director swipe permission — provider failure and user Stop", () => {
	it("provider failure: the decision stays durable (granted receipt), no variant, and the next manual swipe inherits nothing", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		const variantsBefore = (await stores.messages.getVariants(targetMessageId)).map((variant) => variant.id);
		await pauseOnSwipeMarker(threadId, targetPosition);
		rp.streamMode = "fail";

		const chunks = await drainAnswerTurn(threadId, {
			toolCallId: SWIPE_TOOL_CALL_ID,
			decision: "allow",
			instruction: EDITED_INSTRUCTION,
		});
		// The failure is absorbed into the outcome: the decision is DURABLE —
		// the row stores the granted receipt (never a fresh undecided request).
		expect(rp.streamCalls).toBe(1);
		const row = await storedToolRow<DirectorSwipeGrantedReceipt>(threadId, SWIPE_TOOL_CALL_ID);
		expect(row!.output.status).toBe("granted");
		expect(row!.output.instruction).toBe(EDITED_INSTRUCTION);
		expect(chunks.some((c) => c.event === "finish")).toBe(true);
		expect((await stores.messages.getVariants(targetMessageId)).map((variant) => variant.id)).toEqual(variantsBefore);
		expect(activeChatRunCount()).toBe(0);

		// The next ordinary generation (manual swipe) carries no instruction.
		await chatAdapter.regenerateMessage(chatId as string, targetMessageId);
		expect(rp.nonstreamingCalls).toBe(1);
		expect(requestInstructionLayer(rp.nonstreamingInputs[0]!.prompt)).toBeUndefined();
		expect(instructionOccurrences(JSON.stringify(rp.nonstreamingInputs[0]!.prompt), EDITED_INSTRUCTION)).toBe(0);
	}, HEAVY_TIMEOUT);

	it("user Stop mid-generation: the partial variant keeps the instruction in ITS trace; the next manual swipe inherits nothing", async () => {
		const { threadId, branchId: threadBranchId, targetMessageId, targetPosition } = await makeSwipeThread();
		await pauseOnSwipeMarker(threadId, targetPosition);
		rp.streamMode = "stop";

		await drainAnswerTurn(threadId, {
			toolCallId: SWIPE_TOOL_CALL_ID,
			decision: "allow",
			instruction: EDITED_INSTRUCTION,
		});
		expect(rp.streamCalls).toBe(1);
		// The ordinary Stop outcome lives on the RP RUN channel (the answer
		// turn's SSE is the sidechat's, not the RP run's): the replay carries
		// the abort event, the partial saved through the ordinary onAbort path.
		const stopReplay: Array<{ event: string }> = [];
		const runSubscription = chatAdapter.subscribeChatGeneration(chatId as string, 0);
		expect(runSubscription).not.toBeNull();
		for await (const frame of runSubscription!) stopReplay.push({ event: frame.event });
		expect(stopReplay.some((frame) => frame.event === "abort")).toBe(true);
		const partial = (await stores.messages.getVariants(targetMessageId)).find(
			(variant) => variant.content === PARTIAL_REPLY,
		);
		expect(partial).toBeDefined();
		const allTraces = await stores.traces.getTracesByChat(chatId as string);
		console.log("DBG stop traces:", JSON.stringify(allTraces.map((t) => ({ id: t.id, branchId: t.branchId, messageId: t.messageId, variantId: t.variantId })), null, 1));
		console.log("DBG partial:", partial!.id, "module branchId:", branchId);
		const partialTrace = await stores.traces.getTraceByVariant(chatId as string, threadBranchId, partial!.id);
		expect(partialTrace).not.toBeNull();
		expect(partialTrace!.assembledLayers.find((candidate) => candidate.id === "request_instruction")!.text).toBe(EDITED_INSTRUCTION);
		// The decision is durable; the run channel carries the ordinary stop.
		const row = await storedToolRow(threadId, SWIPE_TOOL_CALL_ID);
		expect(row!.output.status).toBe("granted");

		// The next ordinary generation (manual swipe) carries no instruction.
		await chatAdapter.regenerateMessage(chatId as string, targetMessageId);
		expect(rp.nonstreamingCalls).toBe(1);
		expect(requestInstructionLayer(rp.nonstreamingInputs[0]!.prompt)).toBeUndefined();
		expect(instructionOccurrences(JSON.stringify(rp.nonstreamingInputs[0]!.prompt), EDITED_INSTRUCTION)).toBe(0);
	}, HEAVY_TIMEOUT);
});

describe("director swipe permission — the injected editor delegate", () => {
	it("propose_message_edit generates through the injected DMT-14 delegate (unconfigured editor → the ordinary refusal text, no RP writes)", async () => {
		const { threadId, targetPosition, targetMessageId } = await makeSwipeThread();
		await drainTurn(threadId, "Fix the names in that reply, please.");
		const tool = capturedTools[DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit];
		expect(tool).toBeDefined();
		// No message-editor provider is configured in uiSettings → the
		// delegate reports editor_not_configured and the tool returns the
		// model-facing refusal text. No RP message changed either way.
		const outcome = (await tool!.execute!(
			{ position: targetPosition, instruction: "Fix the name spelling" },
			{ toolCallId: "tc_edit_perm_1" },
		)) as string;
		expect(outcome).toContain("no message editor is configured");
		const variants = await stores.messages.getVariants(targetMessageId);
		expect(variants).toHaveLength(1);
		expect(rp.streamCalls).toBe(0);
		expect(rp.nonstreamingCalls).toBe(0);
	}, HEAVY_TIMEOUT);
});
