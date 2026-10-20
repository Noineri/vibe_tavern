import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import {
	createStoreContainer,
	type ProviderProfile,
	type StoreContainer,
} from "@vibe-tavern/db";
import {
	brandId,
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
import { buildContextSearchStoreReads } from "../src/domain/context/context-search-store-reads.js";
import { SidechatOocCompactionService } from "../src/domain/sidechat/sidechat-compaction.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
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
 *  the REAL buildTools seam, no re-implementation). */
let capturedTools: Record<string, { execute: (args: unknown) => Promise<unknown> }> = {};
let fakeReply = REPLY_TEXT;

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
			assembly,
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
		streamText: ((opts: { messages: CapturedMessage[]; tools?: Record<string, { execute: (args: unknown) => Promise<unknown> }> }) => {
			capturedMessages = opts.messages;
			capturedTools = opts.tools ?? {};
			return makeFakeStreamTextResult([{ type: "text-delta", text: fakeReply }]);
		}) as unknown as SidechatStreamDeps["streamText"],
		// SC-10: the ONE extracted store-reads mapping over the real stores, no
		// Co-Author skill catalog — the sidechat's production wiring.
		searchStoreReads: buildContextSearchStoreReads(stores),
	};
});

beforeEach(() => {
	capturedMessages = [];
	capturedTools = {};
	fakeReply = REPLY_TEXT;
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
): Promise<Array<{ event: string; data: string }>> {
	const chunks: Array<{ event: string; data: string }> = [];
	for await (const chunk of streamSidechatTurn(
		{ threadId, content, providerProfileId: "prov_1" },
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
		// SC-10's toggles are ON in the kind's default set and the builtin seed —
		// both tools are served, nothing else.
		expect(Object.keys(capturedTools).sort()).toEqual(["read_context_item", "search_context"]);

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
