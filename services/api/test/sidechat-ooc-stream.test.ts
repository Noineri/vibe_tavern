import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import type { RecordProposal, CopilotTodoItem } from "@vibe-tavern/api-contracts";
import {
	createStoreContainer,
	type ProviderProfile,
	type StoreContainer,
} from "@vibe-tavern/db";
import {
	brandId,
	type AgentPlan,
	type ChatBranchId,
	type ChatId,
	type ExperienceCopilotThreadId,
} from "@vibe-tavern/domain";
import { PromptAssemblyService } from "../src/domain/prompt/prompt-assembly-service.js";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import { CopilotProfileResolver } from "../src/domain/interactive/copilot/copilot-profile-resolver.js";
import { COPILOT_CONTEXT_BUDGET_TOKENS } from "../src/domain/interactive/copilot/copilot-limits.js";
import { getCopilotContextItems } from "../src/domain/agent/agent-context.js";
import { SIDECHAT_OOC_RECENCY_ANCHOR_TEXT, resolveBuiltinSidechatOocProfile } from "../src/domain/agent/kinds/sidechat-ooc-kind.js";
import { sidechatObjectiveProposalInputSchema } from "../src/domain/agent/kinds/sidechat/sidechat-objective-tools.js";
import { buildContextSearchStoreReads } from "../src/domain/context/context-search-store-reads.js";
import { SidechatOocCompactionService } from "../src/domain/sidechat/sidechat-compaction.js";
import {
	ATTACHED_VARIANT_NOT_IN_BRANCH_CODE,
	type AttachedVariantPair,
} from "../src/domain/sidechat/rp-branch-view.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import { isDomainError, type DomainError } from "../src/shared/errors.js";
import {
	streamSidechatTurn,
	type SidechatStreamDeps,
} from "../src/domain/sidechat/sidechat-stream.js";

/**
 * SC-4b — the sidechat-OOC turn through the REAL `streamSidechatTurn`
 * (generic loop + SC-2c sync + SC-3b package + SC-4b assembly), with the
 * provider boundary faked through the deps' injectable `streamText` (no
 * `mock.module`, no network — the same fake pattern script-agent-stream's
 * tests use) and everything below that boundary REAL: an in-memory store
 * container, the real PromptAssemblyService seam the RP reads go through,
 * and the real SC-0f profile chain (chat choice → kind default → the kind's
 * built-in seed, i.e. the `sidechat_ooc_base` asset). Pins the unit's
 * scenarios:
 *
 * 1. turn 1: the RP branch syncs BEFORE the user message row (the frozen
 *    rp_sync event lands at a LOWER seq), the assembled prompt carries the
 *    base prompt AND the package sections (character + the frozen timeline),
 *    and the reply persists like the other kinds' turns;
 * 2. turn 2 after an RP advance: the sync adds ONLY the delta (the second
 *    rp_sync event's payload carries exactly the one new RP message), and
 *    the turn-1 OOC exchange rides the history;
 * 3. an `@`-pinned lorebook's content reaches the prompt through the shared
 *    pinned-context seam (rendered block + the kind's recency anchor right
 *    after it);
 * 4. SC-4d (variant A): the system message carries the STATIC package only —
 *    no `<rp_sync>` and no OOC lines inside it; the frozen events ride the
 *    message flow as their own user-role messages;
 * 5. exactly-once: an OOC message's text occurs exactly ONCE in the assembled
 *    prompt (count, not contains) — the old timeline-in-system copy is gone;
 * 6. placement: a turn-2 RP delta rides AFTER turn 1's reply and BEFORE turn
 *    2's user message; the pinned block + anchor sit immediately before the
 *    turn's own user message.
 */

// ─── Fakes (the provider boundary only) ──────────────────────────────────────

const REPLY_TEXT = "OOC-REPLY-MARKER";

type CapturedMessage = { role: string; content: unknown };

/** The fake `streamText` records the model-facing messages it was called with. */
let capturedMessages: CapturedMessage[] = [];
/** SC-10: the fake also records the tool set the loop served (the search
 *  pair's wiring — served-ness and execute results — is asserted through
 *  the REAL buildTools seam, no re-implementation). The execute signature
 *  keeps the SDK's second parameter (SC-11's propose_objective reads the
 *  toolCallId from it) typed minimally as what the tests pass. */
let capturedTools: Record<string, { execute: (args: unknown, options?: { toolCallId: string }) => Promise<unknown> }> = {};
let fakeReply = REPLY_TEXT;
/** SC-23e: scripted stream parts for split-turn turns (tool-call +
 *  tool-result chunks); null → the default single text-delta fake reply. */
let fakeParts: unknown[] | null = null;
/** SC-23e: the stopWhen list the loop handed the SDK (the wait-tool stop
 *  conditions' wiring is asserted through it). */
let capturedStopWhen: unknown[] = [];

function makeFakeStreamTextResult(parts: unknown[]): Record<string, unknown> {
	async function* gen(): AsyncGenerator<unknown, void, unknown> {
		for (const p of parts) yield p;
	}
	return {
		stream: gen(),
		finishReason: Promise.resolve("stop"),
		usage: Promise.resolve(undefined),
	};
}

function makeProviderProfile(): ProviderProfile {
	return {
		id: "prov_1",
		name: "Test",
		providerPreset: "openai",
		coauthorTransport: "chatCompletions",
		endpoint: "http://test",
		apiKey: "key",
		defaultModel: "test-model",
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

let stores: StoreContainer;
let deps: SidechatStreamDeps;
let characterId: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-sidechat-stream-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const persona = await stores.personas.create({
		name: "Sable",
		description: "A wandering cartographer.",
		pronouns: "she/her",
		defaultForNewChats: true,
	});
	expect(persona.name).toBe("Sable");
	const character = await stores.characters.create({
		name: "Theron",
		description: "A brooding ranger.",
	});
	characterId = character.id;
	const resolver = new StaticPromptResolver(stores, new RegexHookService(stores));
	const assembly = new PromptAssemblyService(stores, resolver, stores.content.fileStore);
	const profileResolver = new CopilotProfileResolver(stores);
	const profile = makeProviderProfile();
	deps = {
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
			presets: stores.presets,
			assembly,
		},
		// SC-17: the variant-attach freeze — the production wiring's same
		// stores/assembly over the real container.
		attach: {
			chats: stores.chats,
			messages: stores.messages,
			assembly,
			experienceCopilot: stores.experienceCopilot,
		},
		getProviderProfile: async () => profile,
		getEffectiveProviderProfile: async () => profile,
		resolveModel: () => ({}) as LanguageModel,
		// The REAL SC-0f chain — no settings rows exist, so every turn resolves
		// the kind's built-in seed (the `sidechat_ooc_base` asset).
		resolveProfileForChat: (thread) =>
			profileResolver.resolveForChat(thread.chatId, thread.agentKind),
		// The adapter's sidechat pinned-context wiring verbatim: the shared
		// CX-2 loader over the real stores, skill arm inert (SC-5's library).
		resolveContextItems: (links) =>
			getCopilotContextItems(links, {
				characters: stores.characters,
				personas: stores.personas,
				lorebooks: stores.lorebooks,
				scripts: stores.scripts,
				skills: {
					readCatalogEntry: async () => null,
					readFile: async () => null,
				},
			}),
		db: stores.db,
		// Type-erased seam: the fake returns the partial FullStream shape the
		// loop reads (`.stream`, `finishReason`, `usage`), not the SDK's full
		// result.
		streamText: ((opts: { messages: CapturedMessage[]; tools?: Record<string, { execute: (args: unknown) => Promise<unknown> }>; stopWhen?: unknown[] }) => {
			capturedMessages = opts.messages;
			capturedTools = opts.tools ?? {};
			capturedStopWhen = opts.stopWhen ?? [];
			return makeFakeStreamTextResult(fakeParts ?? [{ type: "text-delta", text: fakeReply }]);
		}) as unknown as SidechatStreamDeps["streamText"],
		// SC-10: the ONE extracted store-reads mapping over the real stores, no
		// Co-Author skill catalog — the sidechat's production wiring.
		searchStoreReads: buildContextSearchStoreReads(stores),
		// SC-12: the shared plan store's READ seam — read_plan over the thread
		// row's own branch plan (the production wiring, real store).
		agentPlans: stores.agentPlans,
	};
});

beforeEach(() => {
	capturedMessages = [];
	capturedTools = {};
	fakeReply = REPLY_TEXT;
	fakeParts = null;
	capturedStopWhen = [];
});

/** A chat + its active branch + a chat-owned sidechat thread on it, optionally
 *  seeded with one RP assistant message (the SC-2a view's input). */
async function makeSidechatThread(rpSeed?: string): Promise<{
	threadId: ExperienceCopilotThreadId;
	chatId: ChatId;
	branchId: ChatBranchId;
}> {
	const chat = await stores.chats.createChat({
		characterId,
		title: "SC-4b stream fixture",
	});
	const branchId = chat.activeBranchId;
	if (rpSeed !== undefined) {
		await stores.messages.addMessage({
			chatId: brandId<ChatId>(chat.id),
			branchId: brandId<ChatBranchId>(branchId),
			role: "assistant",
			authorType: "assistant",
			content: rpSeed,
		});
	}
	const thread = await stores.experienceCopilot.startNewChatSession(chat.id, branchId, "sidechat-ooc");
	return {
		threadId: thread.id,
		chatId: brandId<ChatId>(chat.id),
		branchId: brandId<ChatBranchId>(branchId),
	};
}

async function drainTurn(
	threadId: string,
	content: string,
	depsOverride?: SidechatStreamDeps,
	attachedVariants?: readonly AttachedVariantPair[],
): Promise<Array<{ event: string; data: string }>> {
	const chunks: Array<{ event: string; data: string }> = [];
	for await (const chunk of streamSidechatTurn(
		{
			threadId,
			content,
			providerProfileId: "prov_1",
			...(attachedVariants !== undefined ? { attachedVariants: [...attachedVariants] } : {}),
		},
		depsOverride ?? deps,
	)) {
		chunks.push(chunk);
	}
	return chunks;
}

/** Every model-facing message flattened to one string for marker assertions. */
function promptText(): string {
	return capturedMessages
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
		.join("\n");
}

/** Count literal occurrences — the exactly-once pins (count, not contains). */
function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/** The assembled prompt's system message text (it rides first, role "system"). */
function systemMessageText(): string {
	const first = capturedMessages[0]!;
	if (first.role !== "system") throw new Error("fixture: expected the system message to ride first");
	return String(first.content);
}

/** The index of the first captured message whose text contains the needle. */
function messageIndexContaining(needle: string): number {
	const index = capturedMessages.findIndex((message) =>
		typeof message.content === "string"
			? message.content.includes(needle)
			: JSON.stringify(message.content).includes(needle),
	);
	if (index < 0) throw new Error(`fixture: no captured message contains ${JSON.stringify(needle)}`);
	return index;
}

// ─── SC-9: meter-segment helpers ────────────────────────────────────────────

/** The finish event's metrics payload (the shape this suite pins — the
 *  segments field is SC-9's producer side; the wire schema is SC-0j's). */
interface FinishMetrics {
	systemTokens: number;
	digestTokens: number;
	historyTokens: number;
	attachedTokens: number;
	totalTokens: number;
	source: string;
	segments?: Array<{ key: string; tokens: number }>;
}

function finishMetrics(chunks: Array<{ event: string; data: string }>): FinishMetrics {
	const data = JSON.parse(
		chunks.find((chunk) => chunk.event === "finish")!.data,
	) as { metrics: FinishMetrics };
	return data.metrics;
}

function segmentMap(metrics: FinishMetrics): Record<string, number> {
	const map: Record<string, number> = {};
	for (const segment of metrics.segments ?? []) map[segment.key] = segment.tokens;
	return map;
}

/** The kind's five segment keys pinned as LITERALS — a production typo in
 *  the key list must fail here, not surface as a raw label in the meter. */
const FIVE_SEGMENT_KEYS = ["context", "rp_summaries", "rp_messages", "digest", "discussion"];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("streamSidechatTurn (SC-4b)", () => {
	it("a turn syncs the RP branch before the user message, assembles base prompt + package, and persists the reply", async () => {
		const { threadId } = await makeSidechatThread("The tavern door swings open.");

		const chunks = await drainTurn(threadId, "What drives Theron right now?");
		const events = chunks.map((chunk) => chunk.event);

		expect(events).toContain("text-delta");
		expect(events).toContain("finish");
		// The finish metrics carry the shared owner-fixed copilot budget — no
		// sidechat-specific number anywhere.
		const finishData = JSON.parse(
			chunks.find((chunk) => chunk.event === "finish")!.data,
		) as { metrics: { budgetTokens: number; source: string } };
		expect(finishData.metrics.budgetTokens).toBe(COPILOT_CONTEXT_BUDGET_TOKENS);

		// Assembled prompt: the profile's base prompt AND the SC-3b static
		// package sections (character among them) — both in the SYSTEM message.
		const prompt = promptText();
		expect(prompt).toContain("You are the sidechat assistant.");
		expect(prompt).toContain('<character name="Theron">');
		expect(prompt).toContain("<rp_sync");
		expect(prompt).toContain("The tavern door swings open.");
		// SC-4d (variant A): the system message carries the STATIC package only —
		// no timeline section, so no rendered event inside it (the base prompt's
		// own grammar MENTIONS `<rp_sync>` in prose; the rendered form always
		// opens with `from=`, so that is the needle); the frozen rp_sync rides
		// the message flow as its own USER-role message, placed before the
		// turn's own user message (the timeline lags one message behind by
		// construction — the sync runs first).
		const systemMessage = systemMessageText();
		expect(systemMessage).toContain("You are the sidechat assistant.");
		expect(systemMessage).toContain('<character name="Theron">');
		expect(systemMessage).not.toContain('<rp_sync from=');
		const syncMessageIdx = messageIndexContaining('<rp_sync from=');
		expect(capturedMessages[syncMessageIdx]!.role).toBe("user");
		// Exactly-once: the OOC text reaches the model ONCE — the turn's own
		// user message (was: twice — the system timeline's `User:` line + the
		// history row).
		expect(occurrences(prompt, "What drives Theron right now?")).toBe(1);

		// Sync order: the frozen rp_sync event sits BELOW the user message's
		// seq on the merged timeline (syncBeforeUserMessage ran before the
		// generic loop persisted the input).
		const timeline = await stores.experienceCopilot.listTimeline(threadId);
		const syncIdx = timeline.findIndex(
			(entry) => entry.rowType === "event" && entry.kind === "rp_sync",
		);
		expect(syncIdx).toBeGreaterThanOrEqual(0);
		const userRows = timeline
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => entry.rowType === "message" && entry.role === "user");
		expect(userRows).toHaveLength(1);
		const syncEntry = timeline[syncIdx]!;
		if (syncEntry.rowType !== "event") throw new Error("fixture: expected the rp_sync event row");
		const userEntry = userRows[0]!.entry;
		if (userEntry.rowType !== "message") throw new Error("fixture: expected the user message row");
		expect(syncEntry.seq).not.toBeNull();
		expect(userEntry.seq).not.toBeNull();
		expect(syncEntry.seq!).toBeLessThan(userEntry.seq!);

		// The reply persists like the other kinds' turns: an assistant row with
		// the streamed text, after the user row.
		const messages = await stores.experienceCopilot.listMessages(threadId);
		expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
		const assistantRows = messages.filter((m) => m.role === "assistant");
		expect(assistantRows).toHaveLength(1);
		expect(assistantRows[0]!.content).toBe(REPLY_TEXT);
		expect(assistantRows[0]!.seq).not.toBeNull();
		expect(assistantRows[0]!.seq!).toBeGreaterThan(userEntry.seq!);
	});

	it("a second turn after an RP advance adds only the delta event", async () => {
		const { threadId, chatId, branchId } = await makeSidechatThread("The tavern door swings open.");
		await drainTurn(threadId, "First OOC turn");

		// The RP advances by exactly one message between the sidechat turns.
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "The bard strikes up a nervous tune.",
		});

		const events = (await drainTurn(threadId, "And now?")).map((chunk) => chunk.event);
		expect(events).toContain("finish");

		// Only the delta: exactly one more rp_sync event, whose payload carries
		// exactly the one new RP message (the turn-1 OOC rows are thread
		// messages, never RP-chat rows — they cannot re-sync).
		const timeline = await stores.experienceCopilot.listTimeline(threadId);
		const syncEvents = timeline.filter(
			(entry) => entry.rowType === "event" && entry.kind === "rp_sync",
		);
		expect(syncEvents).toHaveLength(2);
		const secondPayload = syncEvents[1]!.payload as { messages: Array<{ text: string }> };
		expect(secondPayload.messages).toHaveLength(1);
		expect(secondPayload.messages[0]!.text).toBe("The bard strikes up a nervous tune.");

		// Turn 2's prompt: the static package re-renders (still no events inside
		// it), and the turn-1 OOC exchange rides the flow EXACTLY ONCE each
		// (was: every OOC text also re-rendered inside the system timeline).
		const prompt = promptText();
		expect(prompt).toContain('<character name="Theron">');
		expect(prompt).toContain("The bard strikes up a nervous tune.");
		expect(occurrences(prompt, "First OOC turn")).toBe(1);
		expect(occurrences(prompt, REPLY_TEXT)).toBe(1);
		expect(systemMessageText()).not.toContain('<rp_sync from=');
		// SC-4d placement: the turn-2 RP delta rides as its own user message
		// AFTER turn 1's reply and BEFORE turn 2's user message.
		const turn1ReplyIdx = messageIndexContaining(REPLY_TEXT);
		const deltaIdx = messageIndexContaining("The bard strikes up a nervous tune.");
		const turn2UserIdx = messageIndexContaining("And now?");
		expect(deltaIdx).toBeGreaterThan(turn1ReplyIdx);
		expect(deltaIdx).toBeLessThan(turn2UserIdx);
		expect(capturedMessages[deltaIdx]!.role).toBe("user");
	});

	it("an @-pinned lorebook reaches the prompt through the pinned-context seam", async () => {
		const book = await stores.lorebooks.createLorebook({
			name: "SC-4b pin book",
			scopeType: "entity",
		});
		await stores.lorebooks.createEntry(book.id, {
			title: "Moonbridge",
			content: "MOONBRIDGE-PIN-MARKER The moonbridge opens only at dusk.",
		});
		const { threadId } = await makeSidechatThread("The tavern door swings open.");
		await stores.experienceCopilot.setContextLinks(threadId, [
			{ targetType: "lorebook", targetId: book.id },
		]);

		const events = (await drainTurn(threadId, "Where does that bridge lead?")).map(
			(chunk) => chunk.event,
		);
		expect(events).toContain("finish");

		const prompt = promptText();
		expect(prompt).toContain("# Pinned context (read-only reference — do NOT edit)");
		expect(prompt).toContain("## [Lorebook] Moonbridge");
		expect(prompt).toContain("MOONBRIDGE-PIN-MARKER");
		// The kind's recency anchor sits right after the pinned block, so the
		// attached RP material is never read as instructions.
		const blockIdx = prompt.indexOf("# Pinned context");
		const anchorIdx = prompt.indexOf(SIDECHAT_OOC_RECENCY_ANCHOR_TEXT);
		expect(blockIdx).toBeGreaterThanOrEqual(0);
		expect(anchorIdx).toBeGreaterThan(blockIdx);
		// SC-4d: in the MESSAGE ARRAY the pinned block + anchor sit IMMEDIATELY
		// before the turn's own user message — the frozen event messages joined
		// the flow EARLIER (by placement), and the pinned block stays
		// last-before-the-turn.
		const turnUser = capturedMessages[capturedMessages.length - 1]!;
		expect(turnUser.role).toBe("user");
		expect(String(turnUser.content)).toBe("Where does that bridge lead?");
		const anchorMessage = capturedMessages[capturedMessages.length - 2]!;
		expect(String(anchorMessage.content)).toBe(SIDECHAT_OOC_RECENCY_ANCHOR_TEXT);
		const pinnedMessage = capturedMessages[capturedMessages.length - 3]!;
		expect(String(pinnedMessage.content)).toContain("# Pinned context");
	});
});

// ─── SC-8c: the turn after a compaction ─────────────────────────────────

/** The sidechat compaction service over the REAL store with the provider
 *  boundary faked (injectable executor — no `mock.module`, no network). */
function makeCompactionService(
	execute: (input: Record<string, unknown>) => Promise<{ text: string; providerResponse: Record<string, unknown> }>,
): SidechatOocCompactionService {
	const profile = makeProviderProfile();
	const providerProfiles = {
		getProviderProfile: async () => profile,
		getProviderModelSettings: async () => null,
	};
	return new SidechatOocCompactionService(
		stores.experienceCopilot,
		providerProfiles as unknown as ProviderProfileService,
		execute as unknown as typeof nonstreamingProviderExecute,
		stores.db,
	);
}

describe("streamSidechatTurn after a compaction (SC-8c)", () => {
	// A deterministic counter (1 char = 1 token) for the auto-rule wiring
	// assertions; restored after the block (the suite shares one process —
	// the sidechat-rp-summary overflow suite's pattern).
	beforeAll(() => {
		setTokenCountFn((text) => text.length);
	});
	afterAll(() => {
		setTokenCountFn(() => 0);
	});

	/** The shared fixture: five turns (ten OOC rows) each preceded by an RP
	 *  advance, so five rp_sync events interleave the OOC rows on the merged
	 *  timeline; then a manual compaction folds the first pair (the shell's
	 *  keep-window keeps 8). */
	async function makeCompactedThread(): Promise<{
		threadId: ExperienceCopilotThreadId;
		chatId: ChatId;
		branchId: ChatBranchId;
	}> {
		const { threadId, chatId, branchId } = await makeSidechatThread("RP-SEED-OPENING");
		await drainTurn(threadId, "OOC-Q1 first question");
		for (let turn = 2; turn <= 5; turn++) {
			await stores.messages.addMessage({
				chatId,
				branchId,
				role: "assistant",
				authorType: "assistant",
				content: `RP-ADVANCE-${turn} the story moves on.`,
			});
			await drainTurn(threadId, `OOC-Q${turn} discussion continues`);
		}
		const service = makeCompactionService(async () => ({
			text: "DIGEST-BODY-MARKER what was discussed",
			providerResponse: {},
		}));
		await service.compact({ threadId });
		return { threadId, chatId, branchId };
	}

	it("a turn after compaction assembles without the guard firing (was: the SC-4d count-check throw)", async () => {
		const { threadId, chatId, branchId } = await makeCompactedThread();
		// The digest split is exactly the state the SC-4d guard refused (the
		// loop's history carries 8 rows, the timeline 11): the digest-aware
		// flow must assemble it — a FINISH event, never a throw.
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "RP-ADVANCE-6 the story moves on.",
		});
		const events = (await drainTurn(threadId, "OOC-Q6 after the digest")).map((chunk) => chunk.event);
		expect(events).toContain("finish");
		expect(events).not.toContain("error");
		// The covered rows left the model window; the digest stands in for
		// them exactly once.
		const prompt = promptText();
		expect(occurrences(prompt, "OOC-Q1 first question")).toBe(0);
		expect(occurrences(prompt, "DIGEST-BODY-MARKER")).toBe(1);
	});

	it("after compaction the assembly is static context → RP layer → digest → verbatim tail", async () => {
		const { threadId, chatId, branchId } = await makeCompactedThread();
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "RP-ADVANCE-6 the story moves on.",
		});
		await drainTurn(threadId, "OOC-Q6 after the digest");

		// [0] system: the STATIC package — the digest does NOT ride it.
		const systemMessage = systemMessageText();
		expect(systemMessage).toContain('<character name="Theron">');
		expect(systemMessage).not.toContain("# Compacted context (digest)");
		// [1..2] the pre-boundary RP layer: the first two sync events (their
		// position predates the keep boundary) as user-role messages.
		expect(capturedMessages[1]!.role).toBe("user");
		expect(String(capturedMessages[1]!.content)).toContain('<rp_sync from=');
		expect(String(capturedMessages[1]!.content)).toContain("RP-SEED-OPENING");
		expect(String(capturedMessages[2]!.content)).toContain("RP-ADVANCE-2");
		// [3] the digest: its own user-role message, the shell's digest-section
		// rendering, seated AFTER the pre-boundary RP layer.
		expect(capturedMessages[3]!.role).toBe("user");
		expect(String(capturedMessages[3]!.content)).toContain("# Compacted context (digest)");
		expect(String(capturedMessages[3]!.content)).toContain("DIGEST-BODY-MARKER");
		// [4] the verbatim tail begins at the first KEPT OOC row (turn 2's
		// question); the post-boundary sync events interleave inside the tail.
		expect(capturedMessages[4]!.role).toBe("user");
		expect(String(capturedMessages[4]!.content)).toBe("OOC-Q2 discussion continues");
		const idxAdvance3 = messageIndexContaining("RP-ADVANCE-3");
		const idxQ3 = messageIndexContaining("OOC-Q3 discussion continues");
		const idxQ2 = messageIndexContaining("OOC-Q2 discussion continues");
		expect(idxAdvance3).toBeGreaterThan(idxQ2);
		expect(idxAdvance3).toBeLessThan(idxQ3);
		// The turn's own user message rides LAST, after the turn-6 sync event.
		const idxAdvance6 = messageIndexContaining("RP-ADVANCE-6");
		const idxQ6 = messageIndexContaining("OOC-Q6 after the digest");
		expect(idxAdvance6).toBeLessThan(idxQ6);
		expect(idxQ6).toBe(capturedMessages.length - 1);
	});

	it("the post-compaction turn's meter segments split digest, RP layer and tail (SC-9)", async () => {
		const { threadId, chatId, branchId } = await makeCompactedThread();
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "RP-ADVANCE-6 the story moves on.",
		});
		const chunks = await drainTurn(threadId, "OOC-Q6 after the digest");

		const metrics = finishMetrics(chunks);
		expect((metrics.segments ?? []).map((s) => s.key)).toEqual(FIVE_SEGMENT_KEYS);
		expect(metrics.source).toBe("estimate");
		const seg = segmentMap(metrics);
		// The digest segment is the SAME number the shell accounts as
		// digestTokens — SC-8c's pressure discussion (digest + OOC rows) and
		// the meter's digest + discussion split draw one line, not two.
		expect(seg["digest"]!).toBe(metrics.digestTokens);
		expect(seg["digest"]!).toBeGreaterThan(0);
		// The pre-boundary sync events lead + the post-boundary ones interleave —
		// all rp_messages (this fixture carries no summaries).
		expect(seg["rp_messages"]!).toBeGreaterThan(0);
		expect(seg["rp_summaries"]!).toBe(0);
		// The kept OOC rows + the turn's own message → discussion; the static
		// system message (+ nothing pinned) → context.
		expect(seg["discussion"]!).toBeGreaterThan(0);
		expect(seg["context"]!).toBe(metrics.systemTokens + metrics.attachedTokens);
		expect(seg["context"]!).toBeGreaterThan(0);
		// The invariant: the five reconstruct the metered total exactly, the
		// three history classes the history segment.
		expect((metrics.segments ?? []).reduce((acc, s) => acc + s.tokens, 0)).toBe(metrics.totalTokens);
		expect(seg["rp_summaries"]! + seg["rp_messages"]! + seg["discussion"]!).toBe(metrics.historyTokens);
	});

	it("wires the loop's auto hook to the sidechat rule with the assembly's pressure", async () => {
		const { threadId } = await makeSidechatThread("RP-SEED-AUTO");
		let executed = 0;
		const service = makeCompactionService(async () => {
			executed += 1;
			return { text: "should not run", providerResponse: {} };
		});
		const fired: Array<{ threadId: string; discussionTokens: number; roomTokens: number }> = [];
		service.autoCompactAfterSidechatTurn = async (firedThreadId, pressure) => {
			fired.push({
				threadId: firedThreadId,
				discussionTokens: pressure.discussionTokens,
				roomTokens: pressure.roomTokens,
			});
		};
		const events = (await drainTurn(threadId, "auto wiring turn", { ...deps, compaction: service })).map(
			(chunk) => chunk.event,
		);
		expect(events).toContain("finish");
		// The loop fired the kind's hook exactly once, with the thread id and
		// this turn's pressure; the tiny fixture discussion sits far below
		// 80 % of its room, so the gate itself does NOT run the compaction
		// (the fired numbers are the wiring's proof, not a gate fixture).
		expect(fired).toHaveLength(1);
		expect(fired[0]!.threadId).toBe(threadId);
		expect(fired[0]!.discussionTokens).toBeGreaterThan(0);
		// The room is the budget minus the static context (base prompt +
		// package, both non-empty here) minus the RP layer (the seed's sync
		// event) — strictly below the raw budget.
		expect(fired[0]!.roomTokens).toBeLessThan(COPILOT_CONTEXT_BUDGET_TOKENS);
		expect(fired[0]!.roomTokens).toBeGreaterThan(0);
		expect(executed).toBe(0);
	});
});

// ─── SC-9: the kind's five meter segments ─────────────────────────────

describe("streamSidechatTurn meter segments (SC-9)", () => {
	// A deterministic counter (1 char = 1 token) so the segment values are
	// real measurements, not the unset-tokenizer zeros; restored after the
	// block (the suite shares one process — the SC-8c block's pattern).
	beforeAll(() => {
		setTokenCountFn((text) => text.length);
	});
	afterAll(() => {
		setTokenCountFn(() => 0);
	});

	it("carries the five segments with the right contents, summing to the total", async () => {
		// Two RP messages (positions 0 and 1) + a summary covering only T1
		// (position 0): the frozen batch splits into an <rp_summary> row
		// (rp_summaries) and a surviving position-1 run (rp_messages); the OOC
		// turn rides the discussion.
		const { threadId, chatId, branchId } = await makeSidechatThread("RP-SEED-ONE the tavern opens.");
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "RP-SEED-TWO the keeper greets you.",
		});
		await stores.chatSummaries.create({
			chatId,
			branchId,
			label: "SC-9 chapter",
			summarizedFrom: 1,
			summarizedTo: 1,
			includeInContext: true,
			excludeSummarized: true,
			content: "SC9-SUMMARY the opening exchange compressed.",
		});

		const chunks = await drainTurn(threadId, "meter segments turn");
		const metrics = finishMetrics(chunks);

		// The rendered rows the segments measure are actually in the prompt.
		const prompt = promptText();
		expect(prompt).toContain("<rp_summary");
		expect(prompt).toContain("SC9-SUMMARY");
		expect(prompt).toContain("RP-SEED-TWO");

		// Five keys, exactly, in the kind's settled order.
		expect((metrics.segments ?? []).map((s) => s.key)).toEqual(FIVE_SEGMENT_KEYS);
		// The fixture's fake streamText reports no usage → the total is the
		// assembler's estimate — the frame where the sum invariant is exact
		// (a provider-sourced total is the honest exception, CM-4's rule).
		expect(metrics.source).toBe("estimate");

		const seg = segmentMap(metrics);
		// context = everything constant: the system message (base prompt +
		// static package — card, persona, …) plus the attached block (nothing
		// pinned here, so attached is 0).
		expect(seg["context"]!).toBe(metrics.systemTokens + metrics.attachedTokens);
		expect(seg["context"]!).toBeGreaterThan(0);
		expect(seg["rp_summaries"]!).toBeGreaterThan(0);
		expect(seg["rp_messages"]!).toBeGreaterThan(0);
		expect(seg["digest"]!).toBe(0);
		expect(seg["discussion"]!).toBeGreaterThan(0);

		// The invariant: the five reconstruct the metered total exactly, and
		// the three history classes partition the history segment.
		expect((metrics.segments ?? []).reduce((acc, s) => acc + s.tokens, 0)).toBe(metrics.totalTokens);
		expect(seg["rp_summaries"]! + seg["rp_messages"]! + seg["discussion"]!).toBe(metrics.historyTokens);

		// The persisted metrics keep the segments verbatim (loop → store).
		const persisted = await stores.experienceCopilot.getById(threadId);
		expect(persisted?.contextMetrics?.segments).toEqual(metrics.segments);
	});

	it("an empty-RP turn segments to context + discussion only", async () => {
		const { threadId } = await makeSidechatThread();

		const chunks = await drainTurn(threadId, "no rp yet turn");
		const metrics = finishMetrics(chunks);

		expect((metrics.segments ?? []).map((s) => s.key)).toEqual(FIVE_SEGMENT_KEYS);
		const seg = segmentMap(metrics);
		// No frozen events, no summaries, no digest — only the constant system
		// message and the turn's own OOC row.
		expect(seg["rp_summaries"]!).toBe(0);
		expect(seg["rp_messages"]!).toBe(0);
		expect(seg["digest"]!).toBe(0);
		expect(seg["context"]!).toBe(metrics.systemTokens + metrics.attachedTokens);
		expect(seg["context"]!).toBeGreaterThan(0);
		// The discussion carries the whole history segment (the discussion
		// takes the remainder — with both RP classes empty it IS the whole).
		expect(seg["discussion"]!).toBe(metrics.historyTokens);
		expect(seg["discussion"]!).toBeGreaterThan(0);
		expect((metrics.segments ?? []).reduce((acc, s) => acc + s.tokens, 0)).toBe(metrics.totalTokens);
	});
});

// ─── SC-10: the kind's search tools ─────────────────────────────────

/** One search_context result row (the fields the assertions read). */
interface SearchRow {
	type: string;
	id: string;
	title: string;
	meta: Record<string, string | null>;
}

/** Execute the served search_context (the fake's captured tool set) — the
 *  REAL buildTools wiring, session, mapping and branch view included. */
async function searchTools(query: string): Promise<SearchRow[]> {
	const tool = capturedTools["search_context"];
	if (tool === undefined) throw new Error("fixture: search_context was not served");
	const out = (await tool.execute({ query })) as { results: SearchRow[] };
	return out.results;
}

async function readTool(type: string, id: string): Promise<{ title: string; content: string }> {
	const tool = capturedTools["read_context_item"];
	if (tool === undefined) throw new Error("fixture: read_context_item was not served");
	return (await tool.execute({ type, id })) as { title: string; content: string };
}

describe("streamSidechatTurn search tools (SC-10)", () => {
	it("serves the pair on the seed's toggles; a stored {{user}} comes back RESOLVED with neighbours and the current-text mark", async () => {
		const { threadId, chatId, branchId } = await makeSidechatThread(
			"Well met, {{user}}! The lantern room glows.",
		);
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "user",
			authorType: "user",
			content: "I fold the map by the window.",
		});
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "Theron nods and banks the fire.",
		});

		const events = (await drainTurn(threadId, "Find that lantern scene")).map((c) => c.event);
		expect(events).toContain("finish");
		// SC-10's toggles are ON in the kind's default set and the builtin seed,
		// SC-11 flipped propose_objective, SC-12 flipped todo + read_plan, and
		// SC-23e flipped read_message_prompt — all six tools are served,
		// nothing else.
		expect(Object.keys(capturedTools).sort()).toEqual([
			"propose_objective",
			"read_context_item",
			"read_message_prompt",
			"read_plan",
			"search_context",
			"todo",
		]);

		const results = await searchTools("lantern");
		const hit = results.find((r) => r.type === "rp-message");
		expect(hit).toBeDefined();
		expect(hit!.title).toBe("RP message #1");
		expect(hit!.meta.role).toBe("assistant");
		expect(hit!.meta.author).toBe("Theron");
		expect(hit!.meta.position).toBe("0");

		// The read returns the CURRENT text (the sync's SC-2a view): the stored
		// raw `{{user}}` macro arrives RESOLVED — never the raw form — plus the
		// immediate neighbours in story order, marked as current, not frozen.
		const item = await readTool("rp-message", hit!.id);
		expect(item.title).toBe("RP message #1");
		expect(item.content).toContain("Well met, Sable!");
		expect(item.content).not.toContain("{{user}}");
		expect(item.content).toContain("Current text as the RP model sees it now");
		expect(item.content).toContain("not a frozen event copy");
		expect(item.content).toContain("## After — RP message #2 (user — Sable)");
		expect(item.content).toContain("I fold the map by the window.");
		expect(item.content).not.toContain("Theron nods and banks the fire.");
	});

	it("a summary-covered RP message is still found — the view keeps what the window dropped", async () => {
		const { threadId, chatId, branchId } = await makeSidechatThread(
			"COVERED-OPENING the pact is sealed at midnight.",
		);
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "The witness speaks.",
		});
		await stores.chatSummaries.create({
			chatId,
			branchId,
			label: "SC-10 covered chapter",
			summarizedFrom: 1,
			summarizedTo: 1,
			includeInContext: true,
			excludeSummarized: true,
			content: "SC10-SUMMARY the pact scene compressed.",
		});

		const events = (await drainTurn(threadId, "What happened at midnight?")).map((c) => c.event);
		expect(events).toContain("finish");
		// The covered message left the MODEL WINDOW (the summary stands in for
		// it — SC-6's read-time coverage over the frozen timeline)...
		const prompt = promptText();
		expect(prompt).not.toContain("COVERED-OPENING");
		expect(prompt).toContain("SC10-SUMMARY");
		// ...but the search still finds it: the whole-branch view (SC-2a, since
		// SC-6) keeps summary-covered messages — exactly the old material this
		// search exists to find.
		const results = await searchTools("midnight");
		const hit = results.find((r) => r.type === "rp-message");
		expect(hit).toBeDefined();
		const item = await readTool("rp-message", hit!.id);
		expect(item.content).toContain("COVERED-OPENING the pact is sealed at midnight.");
	});

	it("with the toggles off the tools are not served", async () => {
		const { threadId } = await makeSidechatThread("Toggle-off scene.");
		// An explicit profile with EVERY toggle off (the wire schema's `{}`) —
		// the resolved profile is what buildTools gates on, never the kind's
		// declarative defaults alone.
		const allOff = { ...(await resolveBuiltinSidechatOocProfile()), toolSet: {} };
		const events = (
			await drainTurn(threadId, "no tools turn", {
				...deps,
				resolveProfileForChat: async () => allOff,
			})
		).map((c) => c.event);
		expect(events).toContain("finish");
		expect(capturedTools).toEqual({});
		// SC-12 extension: the checklist + branch-plan-read pair is gated by
		// the SAME per-key filter — with the toggles off neither is served
		// (named, beside the set-wide `{}` pin above).
		expect(capturedTools["todo"]).toBeUndefined();
		expect(capturedTools["read_plan"]).toBeUndefined();
	});

	it("other branches never match — the session indexes the thread's branch only", async () => {
		const own = await makeSidechatThread("OWN-BRANCH the harbour bell rings.");
		// A SECOND chat+branch (its own sidechat thread) carries a distinctive
		// keyword; the first thread's turn must not see it in its index.
		const other = await makeSidechatThread("OTHER-BRANCH the moonpool shatters quietly.");
		await drainTurn(other.threadId, "other branch turn");

		const events = (await drainTurn(own.threadId, "own branch turn")).map((c) => c.event);
		expect(events).toContain("finish");
		const results = await searchTools("moonpool");
		expect(results.filter((r) => r.type === "rp-message")).toEqual([]);
		// And the own branch's text IS there (the empty result is isolation, not
		// a broken index).
		const ownHits = await searchTools("harbour");
		expect(ownHits.some((r) => r.type === "rp-message")).toBe(true);
	});
});

// ─── SC-11: the objective-proposal tool ────────────────────────────────

describe("streamSidechatTurn objective proposal tool (SC-11)", () => {
	it("serves propose_objective on the seed's toggles; execute returns the pending record proposal keyed by the tool call", async () => {
		const { threadId } = await makeSidechatThread("The bridge is out.");
		await drainTurn(threadId, "What should we track next?");
		// SC-11's toggle is ON in the kind's default set and the builtin seed —
		// the tool rides the same buildTools seam beside the search pair.
		const tool = capturedTools["propose_objective"];
		expect(tool).toBeDefined();

		// The persisted-output contract: a pending objective CREATE proposal
		// whose id IS the tool call id (the apply/reject route's key), payload
		// the tool input verbatim (reason omitted when the model omitted it).
		const proposal = (await tool!.execute(
			{ description: "Find another way across the ravine", reason: "The map shows a ford" },
			{ toolCallId: "tc_sc11_1" },
		)) as RecordProposal;
		expect(proposal).toEqual({
			kind: "record",
			id: "tc_sc11_1",
			recordType: "objective",
			op: "create",
			payload: { description: "Find another way across the ravine", reason: "The map shows a ford" },
			status: "pending",
		});
		const bare = (await tool!.execute(
			{ description: "Rest at the waystation" },
			{ toolCallId: "tc_sc11_2" },
		)) as RecordProposal;
		expect(bare.payload).toEqual({ description: "Rest at the waystation" });
	});

	it("the input schema rejects an empty description (the loop's validation contract)", async () => {
		expect(sidechatObjectiveProposalInputSchema.safeParse({ description: "" }).success).toBe(false);
		expect(sidechatObjectiveProposalInputSchema.safeParse({ description: " " }).success).toBe(false);
		expect(sidechatObjectiveProposalInputSchema.safeParse({ description: "Scout the ford" }).success).toBe(true);
		expect(
			sidechatObjectiveProposalInputSchema.safeParse({ description: "Scout the ford", reason: "Low water" }).success,
		).toBe(true);
	});

	it("a profile with only the objective toggle off serves the search pair but no propose_objective", async () => {
		const { threadId } = await makeSidechatThread("Toggle-off objective scene.");
		// The SC-10 pair stays on; SC-11's key is absent (tool sets store only
		// enabled keys — an absent key IS off). buildTools gates per key on the
		// resolved profile, so the search pair still serves.
		const searchOnly = {
			...(await resolveBuiltinSidechatOocProfile()),
			toolSet: { search_context: true, read_context_item: true },
		};
		await drainTurn(threadId, "toggle check turn", {
			...deps,
			resolveProfileForChat: async () => searchOnly,
		});
		expect(Object.keys(capturedTools).sort()).toEqual(["read_context_item", "search_context"]);
	});
});

// ─── SC-12: the checklist + branch-plan read ──────────────────────

/** A minimal valid branch plan (the domain's normalizeAgentPlan shape). */
const branchPlan = (goal: string): AgentPlan => ({
	goal,
	constraints: [],
	tasks: [{ id: "t1", title: "First step", body: "Do it.", status: "pending" }],
});

describe("streamSidechatTurn checklist + branch-plan read (SC-12)", () => {
	it("serves todo and read_plan on the seed's toggles and NEVER a plan-write tool", async () => {
		const { threadId } = await makeSidechatThread("The checklist scene.");
		await drainTurn(threadId, "What is on the plan?");
		// The unit's pair is served on the default seed's toggles...
		expect(capturedTools["todo"]).toBeDefined();
		expect(capturedTools["read_plan"]).toBeDefined();
		// ...and the shared plan tools' WRITE arm ("plan" — the non-readOnly
		// factory entry) is absent: readOnly builds no plan-write tool, so no
		// branch-plan write can ever reach the sidechat model.
		expect(capturedTools["plan"]).toBeUndefined();
	});

	it("read_plan returns THE THREAD'S OWN branch plan — a foreign branch's plan is not returned", async () => {
		const own = await makeSidechatThread("OWN-BRANCH the mill wheel turns.");
		const foreign = await makeSidechatThread("FOREIGN-BRANCH the ferry waits.");
		await stores.agentPlans.save(
			{ kind: "chatBranch", chatId: own.chatId, branchId: own.branchId },
			branchPlan("OWN-GOAL settle the millwright's debt"),
		);
		await stores.agentPlans.save(
			{ kind: "chatBranch", chatId: foreign.chatId, branchId: foreign.branchId },
			branchPlan("FOREIGN-GOAL cross the estuary"),
		);

		// Each thread's own turn (the REAL buildTools seam): the owner is the
		// THREAD ROW's chat + branch, so each read returns its own branch's
		// plan — never the other's.
		await drainTurn(own.threadId, "Read our plan");
		const ownResult = (await capturedTools["read_plan"]!.execute({})) as AgentPlan;
		expect(ownResult.goal).toBe("OWN-GOAL settle the millwright's debt");

		await drainTurn(foreign.threadId, "Read our plan");
		const foreignResult = (await capturedTools["read_plan"]!.execute({})) as AgentPlan;
		expect(foreignResult.goal).toBe("FOREIGN-GOAL cross the estuary");
	});

	it("a todo call persists the full rewritten list through updateTodo and returns the shared envelope", async () => {
		const { threadId } = await makeSidechatThread("The checklist scene.");
		await drainTurn(threadId, "Track the session steps");
		const todo = capturedTools["todo"];
		if (todo === undefined) throw new Error("fixture: todo was not served");

		const items: CopilotTodoItem[] = [
			{ title: "Outline the tavern scene", status: "active" },
			{ title: "List open threads", status: "pending" },
			{ title: "Draft the recap", status: "completed" },
		];
		const result = (await todo.execute({ items })) as {
			ok: boolean;
			items: CopilotTodoItem[];
			activeTitle?: string;
			remaining?: number;
		};
		// The shared factory's envelope, byte-identical (SC-13 renders through
		// the same parseAgentToolOutput path the experience panel uses).
		expect(result).toEqual({
			ok: true,
			items,
			activeTitle: "Outline the tavern scene",
			remaining: 2,
		});
		// Persistence went through the thread store's updateTodo: the row's
		// own checklist column carries the full rewritten list.
		const thread = await stores.experienceCopilot.getById(threadId);
		expect(thread?.todo).toEqual(items);
	});
});

// ─── SC-17: attaching RP variants to a sidechat turn ──────────────────

describe("streamSidechatTurn attached variants (SC-17)", () => {
	/** A chat-owned thread whose branch carries msgA (TWO variants — the
	 *  selected one plus an alternative, both with a raw {{user}} macro) and
	 *  msgB after it (one variant), plus the variant rows for pair building. */
	async function makeAttachFixture(): Promise<{
		threadId: ExperienceCopilotThreadId;
		msgA: { id: string; selectedId: string; alternativeId: string };
		msgB: { id: string; variantId: string };
	}> {
		const { threadId, chatId, branchId } = await makeSidechatThread();
		const a = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "The door creaks open before {{user}}.",
			variants: ["The door creaks open before {{user}}.", "The door SLAMS open before {{user}}."],
			selectedVariantIndex: 0,
		});
		const b = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "The bard tunes his lute.",
		});
		const aVariants = await stores.messages.getVariants(a.id);
		const bVariants = await stores.messages.getVariants(b.id);
		const aSelected = aVariants.find((v) => v.isSelected)!;
		const aAlternative = aVariants.find((v) => !v.isSelected)!;
		return {
			threadId,
			msgA: { id: a.id, selectedId: aSelected.id, alternativeId: aAlternative.id },
			msgB: { id: b.id, variantId: bVariants[0]!.id },
		};
	}

	/** One frozen variant row — the stored `variants_attached` payload's item
	 *  shape since SC-23a (provenance fields included). */
	interface AttachedVariantRow {
		text: string;
		selected: boolean;
		number: number;
		model: string | null;
		preset: string | null;
	}

	/** The thread's variants_attached events (payload cast to the frozen shape). */
	async function attachedEvents(
		threadId: ExperienceCopilotThreadId,
	): Promise<Array<{ seq: number; payload: { position: number; variants: AttachedVariantRow[] } }>> {
		const timeline = await stores.experienceCopilot.listTimeline(threadId);
		return timeline
			.filter((entry) => entry.rowType === "event" && entry.kind === "variants_attached")
			.map((entry) => entry as {
				seq: number;
				payload: { position: number; variants: AttachedVariantRow[] };
			});
	}

	it("freezes ONE event per attached message in POSITION order, texts transformed, selected from the DB — and the RP selection never changes", async () => {
		const { threadId, msgA, msgB } = await makeAttachFixture();
		// The RP's own selection at freeze time (the request cannot set it — the
		// pair schema has no marker field at all).
		const selectionBefore = (await stores.messages.getVariants(msgA.id)).map(
			(v) => ({ id: v.id, isSelected: v.isSelected }),
		);

		// Pairs given in REVERSE position order (msgB before msgA, and msgA's
		// alternative before its selected variant): event order and the
		// selected marker must come from the branch and the store, never from
		// this array's order.
		const chunks = await drainTurn(threadId, "Compare those two takes for me", undefined, [
			{ messageId: msgB.id, variantId: msgB.variantId },
			{ messageId: msgA.id, variantId: msgA.alternativeId },
			{ messageId: msgA.id, variantId: msgA.selectedId },
		]);
		expect(chunks.map((c) => c.event)).toContain("finish");

		const events = await attachedEvents(threadId);
		// ONE event per attached MESSAGE (msgA's two variants share one event;
		// two messages never share one) — two events, not three.
		expect(events).toHaveLength(2);
		// POSITION order, never request order: msgA (position 0) froze first.
		expect(events[0]!.payload.position).toBe(0);
		expect(events[1]!.payload.position).toBe(1);

		// msgA's event carries BOTH variants; each text is the TRANSFORMED one
		// (the raw {{user}} never reaches the store or the model) and each
		// `selected` flag is the RP's OWN marker read from message_variants.
		const aVariants = events[0]!.payload.variants;
		expect(aVariants).toHaveLength(2);
		const alternative = aVariants.find((v) => v.text.includes("SLAMS"))!;
		const selected = aVariants.find((v) => !v.text.includes("SLAMS"))!;
		expect(alternative.text).toBe("The door SLAMS open before Sable.");
		expect(alternative.selected).toBe(false);
		expect(selected.text).toBe("The door creaks open before Sable.");
		expect(selected.selected).toBe(true);
		expect(events[1]!.payload.variants).toEqual([
			// SC-23a: the single-variant message's row — number 1
			// (variantIndex 0 + 1), no model/preset on this fixture's seed.
			{ text: "The bard tunes his lute.", selected: true, number: 1, model: null, preset: null },
		]);

		// Freeze order on the merged timeline: after the sync's rp_sync event,
		// BEFORE this turn's user message row (mirrors the sync's anchoring).
		const timeline = await stores.experienceCopilot.listTimeline(threadId);
		const seqOf = (predicate: (entry: (typeof timeline)[number]) => boolean): number => {
			const entry = timeline.find(predicate)!;
			if (entry.rowType !== "event" && entry.rowType !== "message") throw new Error("fixture: bad row");
			if (entry.seq === null) throw new Error("fixture: expected an allocated seq");
			return entry.seq;
		};
		const userSeq = seqOf((entry) => entry.rowType === "message" && entry.role === "user");
		const syncSeq = seqOf((entry) => entry.rowType === "event" && entry.kind === "rp_sync");
		expect(syncSeq).toBeLessThan(events[0]!.seq);
		expect(events[0]!.seq).toBeLessThan(events[1]!.seq);
		expect(events[1]!.seq).toBeLessThan(userSeq);

		// THIS turn's prompt already carries the frozen rows (the freeze ran
		// before the SC-3b loader's timeline read) — rendered, not raw.
		const prompt = promptText();
		expect(prompt).toContain('<rp_variants position="0">');
		expect(prompt).toContain("The door SLAMS open before Sable.");
		expect(prompt).not.toContain("{{user}}");

		// The RP selection NEVER changes: identical isSelected per variant id.
		const selectionAfter = (await stores.messages.getVariants(msgA.id)).map(
			(v) => ({ id: v.id, isSelected: v.isSelected }),
		);
		expect(selectionAfter).toEqual(selectionBefore);
		expect(selectionAfter.filter((v) => v.isSelected)).toHaveLength(1);
	});

	it("a foreign message (another chat's branch) is a typed 400 and NOTHING is frozen — the valid pair in the same request included", async () => {
		const own = await makeAttachFixture();
		const foreign = await makeAttachFixture();

		let thrown: unknown;
		try {
			await drainTurn(own.threadId, "discuss this", undefined, [
				{ messageId: own.msgA.id, variantId: own.msgA.selectedId },
			{ messageId: foreign.msgA.id, variantId: foreign.msgA.selectedId },
			]);
		} catch (err) {
			thrown = err;
		}
		expect(isDomainError(thrown)).toBe(true);
		const error = thrown as DomainError;
		expect(error.kind).toBe("Validation");
		expect(error.details?.code).toBe(ATTACHED_VARIANT_NOT_IN_BRANCH_CODE);
		expect(error.details?.messageId).toBe(foreign.msgA.id);

		// All-or-nothing: not even the VALID pair froze, no event of any kind,
		// and the turn refused before its user message persisted.
		expect(await attachedEvents(own.threadId)).toEqual([]);
		const timeline = await stores.experienceCopilot.listTimeline(own.threadId);
		expect(timeline.filter((entry) => entry.rowType === "message" && entry.role === "user")).toEqual([]);
	});

	it("a foreign variant (another message's variant, same branch) is the same typed 400 with nothing frozen", async () => {
		const { threadId, msgA, msgB } = await makeAttachFixture();

		let thrown: unknown;
		try {
			// msgB's variant attached under msgA's message id — the variant does
			// not belong to that message.
			await drainTurn(threadId, "discuss this", undefined, [
				{ messageId: msgA.id, variantId: msgB.variantId },
			]);
		} catch (err) {
			thrown = err;
		}
		expect(isDomainError(thrown)).toBe(true);
		const error = thrown as DomainError;
		expect(error.kind).toBe("Validation");
		expect(error.details?.code).toBe(ATTACHED_VARIANT_NOT_IN_BRANCH_CODE);
		expect(error.details?.variantId).toBe(msgB.variantId);
		expect(await attachedEvents(threadId)).toEqual([]);
	});

	it("an attached variant freezes its number and the model/preset that wrote it (SC-23a) — and the prompt renders them", async () => {
		const { threadId, chatId, branchId } = await makeSidechatThread();
		// addMessage records model/preset on the SELECTED variant only — so the
		// chosen take (index 0) carries provenance and the alternative (index 1)
		// carries none: both halves of the pin in one message.
		const msg = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "The chosen regeneration.",
			variants: ["The chosen regeneration.", "The discarded take."],
			selectedVariantIndex: 0,
			modelId: "flash-latest",
			presetName: "Agentic Narrator",
		});
		const variants = await stores.messages.getVariants(msg.id);
		const selected = variants.find((v) => v.isSelected)!;
		const alternative = variants.find((v) => !v.isSelected)!;

		const chunks = await drainTurn(threadId, "Which model wrote each take?", undefined, [
			{ messageId: msg.id, variantId: selected.id },
			{ messageId: msg.id, variantId: alternative.id },
		]);
		expect(chunks.map((c) => c.event)).toContain("finish");

		// The frozen payload: number = variantIndex + 1 per variant, model/preset
		// straight off the variant rows (null on the alternative's row).
		const events = await attachedEvents(threadId);
		expect(events).toHaveLength(1);
		expect(events[0]!.payload.variants).toEqual([
			{ text: "The chosen regeneration.", selected: true, number: 1, model: "flash-latest", preset: "Agentic Narrator" },
			{ text: "The discarded take.", selected: false, number: 2, model: null, preset: null },
		]);

		// The rendered prompt carries the attributes — number on both variants,
		// model/preset only where the row has them.
		const prompt = promptText();
		expect(prompt).toContain(
			'<variant selected="true" number="1" model="flash-latest" preset="Agentic Narrator">The chosen regeneration.</variant>',
		);
		expect(prompt).toContain('<variant selected="false" number="2">The discarded take.</variant>');
	});
});

// ─── SC-23e: the reply-prompt read's permission split-turn ──────────────────

/** The SC-23e fixtures' shared helper: a sidechat thread whose RP branch has
 *  a linked trace on the assistant reply's selected variant (the real
 *  send-path draft through the same assembly seam the RP uses), so the tool's
 *  resolution finds the exact prompt. */
async function makePromptReadThread(replyText: string): Promise<{
	threadId: ExperienceCopilotThreadId;
	chatId: ChatId;
	branchId: ChatBranchId;
	replyId: string;
}> {
	const resolver = new StaticPromptResolver(stores, new RegexHookService(stores));
	const assembly = new PromptAssemblyService(stores, resolver, stores.content.fileStore);
	const chat = await stores.chats.createChat({ characterId, title: "SC-23e stream fixture" });
	const branchId = chat.activeBranchId;
	await stores.messages.addMessage({
		chatId: brandId<ChatId>(chat.id),
		branchId: brandId<ChatBranchId>(branchId),
		role: "user",
		authorType: "user",
		content: "We enter the tavern.",
	});
	const reply = await stores.messages.addMessage({
		chatId: brandId<ChatId>(chat.id),
		branchId: brandId<ChatBranchId>(branchId),
		role: "assistant",
		authorType: "assistant",
		content: replyText,
	});
	const variants = await stores.messages.getVariants(reply.id);
	const selected = variants.find((variant) => variant.isSelected)!;
	const assembled = await assembly.assembleForChat({
		chatId: brandId<ChatId>(chat.id),
		branchId: brandId<ChatBranchId>(branchId),
		model: "sc23e-model",
	});
	await stores.traces.saveTrace({
		...assembled.promptTraceDraft,
		presetName: assembled.promptTraceDraft.presetName ?? "(none)",
		messageId: reply.id,
		variantId: selected.id,
	});
	const thread = await stores.experienceCopilot.startNewChatSession(chat.id, branchId, "sidechat-ooc");
	return {
		threadId: thread.id,
		chatId: brandId<ChatId>(chat.id),
		branchId: brandId<ChatBranchId>(branchId),
		replyId: reply.id,
	};
}

/** Drain an ANSWER-mode turn (the split-turn resume: no content, the answer
 *  body instead — the same shape the route relays). */
async function drainAnswerTurn(
	threadId: string,
	answer: { toolCallId: string; decision: "allow" | "deny" },
): Promise<Array<{ event: string; data: string }>> {
	const chunks: Array<{ event: string; data: string }> = [];
	for await (const chunk of streamSidechatTurn(
		{ threadId, answer, providerProfileId: "prov_1" },
		deps,
	)) {
		chunks.push(chunk);
	}
	return chunks;
}

/** The stored tool-result row for a toolCallId, parsed. */
async function storedToolRow(threadId: string, toolCallId: string): Promise<{ toolName: string; output: Record<string, unknown> } | null> {
	const rows = await stores.experienceCopilot.listMessages(threadId);
	const row = rows.find((m) => m.role === "tool" && m.toolCallId === toolCallId);
	if (!row) return null;
	return JSON.parse(row.content) as { toolName: string; output: Record<string, unknown> };
}

/** The model-visible wire object of the LAST tool-role message (the same
 *  read the ask-answer suites use — the wire contract parses to an object). */
function lastToolWireObject(): Record<string, unknown> {
	const toolMsg = [...capturedMessages].reverse().find((m) => m.role === "tool");
	const part = (toolMsg!.content as Array<{ type: string; output?: { value?: string } }>)[0]!;
	return JSON.parse(part.output!.value!) as Record<string, unknown>;
}

describe("streamSidechatTurn read_message_prompt permission split-turn (SC-23e)", () => {
	beforeAll(() => {
		// Deterministic counts for the marker/granted estimate assertions;
		// restored (process-global state, the shared services/api worker).
		setTokenCountFn((text) => text.length);
	});
	afterAll(() => {
		setTokenCountFn(() => 0);
	});

	it("stopWhen = the ceiling + the MARKER-AWARE condition (a call answering unknown does not stop)", async () => {
		const { threadId } = await makePromptReadThread("The studied reply.");
		await drainTurn(threadId, "By which prompt was that written?");

		// Two entries: the tool-loop ceiling, then the sidechat's single
		// wait-tool condition — the SDK's isStepCount plus the marker-aware
		// helper, NOT the name-based hasToolCall (unknown answers relay
		// in-turn).
		expect(capturedStopWhen).toHaveLength(2);
		const markerCondition = capturedStopWhen[1] as (o: {
			steps: Array<{ toolResults?: Array<{ toolName?: string; output?: unknown }> }>;
		}) => boolean;
		expect(
			markerCondition({
				steps: [{ toolResults: [{ toolName: "read_message_prompt", output: { status: "awaiting_permission" } }] }],
			}),
		).toBe(true);
		expect(
			markerCondition({
				steps: [{ toolResults: [{ toolName: "read_message_prompt", output: { status: "unknown_prompt" } }] }],
			}),
		).toBe(false);
	});

	it("the marker turn stops WITH the estimate: the marker row persists, the SSE carries it, the turn finishes", async () => {
		const { threadId } = await makePromptReadThread("Theron pours two cups.\nAnd smiles.");
		// Capture the tool set first (a plain turn), then run the REAL
		// execute to produce the marker the scripted turn will persist.
		await drainTurn(threadId, "By which prompt was that written?");
		const marker = (await capturedTools.read_message_prompt!.execute(
			{ position: 1 },
			{ toolCallId: "tc_pr_1" },
		)) as Record<string, unknown>;
		expect(marker.status).toBe("awaiting_permission");
		expect(marker.replyFirstLine).toBe("Theron pours two cups.");
		expect(marker.variantNumber).toBe(1);
		expect(marker.promptTokens).toBeGreaterThan(0);

		fakeParts = [
			{ type: "tool-call", toolCallId: "tc_pr_1", toolName: "read_message_prompt", input: { position: 1 } },
			{ type: "tool-result", toolCallId: "tc_pr_1", toolName: "read_message_prompt", output: marker },
		];
		const chunks = await drainTurn(threadId, "That one, please.");
		// The SSE relays the call and the marker verbatim; the turn FINISHES
		// (the stop is a normal end, never an error).
		expect(chunks.map((c) => c.event)).toContain("tool-call");
		const toolResultEvt = chunks.find((c) => c.event === "tool-result")!;
		expect((JSON.parse(toolResultEvt.data) as { output: { status: string } }).output.status).toBe("awaiting_permission");
		expect(chunks.map((c) => c.event)).toContain("finish");
		expect(chunks.map((c) => c.event)).not.toContain("error");
		// The marker row persisted with the card's data intact.
		expect(await storedToolRow(threadId, "tc_pr_1")).toEqual({
			toolName: "read_message_prompt",
			output: marker,
		});
	});

	it("ALLOW: no user row; the row is rewritten with the REAL rendered prompt; the model reads it through the wire", async () => {
		const { threadId } = await makePromptReadThread("The allowed reply.");
		await drainTurn(threadId, "By which prompt?");
		const marker = await capturedTools.read_message_prompt!.execute({ position: 1 }, { toolCallId: "tc_pr_2" });
		fakeParts = [
			{ type: "tool-call", toolCallId: "tc_pr_2", toolName: "read_message_prompt", input: { position: 1 } },
			{ type: "tool-result", toolCallId: "tc_pr_2", toolName: "read_message_prompt", output: marker },
		];
		await drainTurn(threadId, "This one.");

		const rowsBefore = await stores.experienceCopilot.listMessages(threadId);
		const userRowsBefore = rowsBefore.filter((m) => m.role === "user").length;

		const chunks = await drainAnswerTurn(threadId, { toolCallId: "tc_pr_2", decision: "allow" });
		expect(chunks.map((c) => c.event)).toContain("finish");

		// No user row for an answer turn — the decision IS the tool-result.
		const rowsAfter = await stores.experienceCopilot.listMessages(threadId);
		expect(rowsAfter.filter((m) => m.role === "user")).toHaveLength(userRowsBefore);

		// The row was rewritten to the granted payload: the full view text
		// and the token estimate, no marker left.
		const row = await storedToolRow(threadId, "tc_pr_2");
		expect(row!.toolName).toBe("read_message_prompt");
		expect(row!.output.status).toBe("granted");
		expect(String(row!.output.prompt)).toContain("<rp_prompt");
		expect(String(row!.output.prompt)).toContain("</rp_prompt>");
		expect(row!.output.promptTokens).toBeGreaterThan(0);

		// The resumed model reads the prompt through the self-describing wire
		// object — never the stored status enum.
		const wire = lastToolWireObject();
		expect(wire).toEqual({ prompt: row!.output.prompt, promptTokens: row!.output.promptTokens });
	});

	it("DENY: the row stores the denied marker; the model reads { denied: true }", async () => {
		const { threadId } = await makePromptReadThread("The denied reply.");
		await drainTurn(threadId, "By which prompt?");
		const marker = await capturedTools.read_message_prompt!.execute({ position: 1 }, { toolCallId: "tc_pr_3" });
		fakeParts = [
			{ type: "tool-call", toolCallId: "tc_pr_3", toolName: "read_message_prompt", input: { position: 1 } },
			{ type: "tool-result", toolCallId: "tc_pr_3", toolName: "read_message_prompt", output: marker },
		];
		await drainTurn(threadId, "That one.");
		const chunks = await drainAnswerTurn(threadId, { toolCallId: "tc_pr_3", decision: "deny" });
		expect(chunks.map((c) => c.event)).toContain("finish");
		expect(await storedToolRow(threadId, "tc_pr_3")).toEqual({
			toolName: "read_message_prompt",
			output: { status: "denied" },
		});
		expect(lastToolWireObject()).toEqual({ denied: true });
	});

	it("the resume REPLAYS the call with its provider metadata (the replay fix's providerOptions)", async () => {
		const { threadId } = await makePromptReadThread("The signed reply.");
		await drainTurn(threadId, "By which prompt?");
		const marker = await capturedTools.read_message_prompt!.execute({ position: 1 }, { toolCallId: "tc_pr_4" });
		// The provider's replay metadata rides the tool-call chunk (what
		// createMappedStream renames to providerOptions) — Gemini 3's
		// thoughtSignature must survive the round-trip into the resumed turn.
		fakeParts = [
			{
				type: "tool-call",
				toolCallId: "tc_pr_4",
				toolName: "read_message_prompt",
				input: { position: 1 },
				providerMetadata: { google: { thoughtSignature: "sig_tc_pr_4" } },
			},
			{ type: "tool-result", toolCallId: "tc_pr_4", toolName: "read_message_prompt", output: marker },
		];
		await drainTurn(threadId, "This one.");
		await drainAnswerTurn(threadId, { toolCallId: "tc_pr_4", decision: "allow" });

		const callParts = capturedMessages
			.flatMap((m) =>
				m.role === "assistant" && Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [])
			.filter((p) => p.type === "tool-call") as Array<Record<string, unknown>>;
		expect(callParts).toHaveLength(1);
		expect(callParts[0]!.toolName).toBe("read_message_prompt");
		expect(callParts[0]!.providerOptions).toEqual({ google: { thoughtSignature: "sig_tc_pr_4" } });
	});

	it("a decision for a row that is not an awaiting permission marker is refused", async () => {
		const { threadId } = await makePromptReadThread("Any reply.");
		await drainTurn(threadId, "Hello.");
		let threw: unknown = null;
		try {
			await drainAnswerTurn(threadId, { toolCallId: "tc_never_existed", decision: "allow" });
		} catch (err) {
			threw = err;
		}
		expect(threw).toBeTruthy();
		expect(String((threw as { message?: string }).message)).toContain(
			"permission request being answered was not found",
		);
	});
});
