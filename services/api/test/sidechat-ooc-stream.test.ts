import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
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
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import { CopilotProfileResolver } from "../src/domain/interactive/copilot/copilot-profile-resolver.js";
import { COPILOT_CONTEXT_BUDGET_TOKENS } from "../src/domain/interactive/copilot/copilot-limits.js";
import { getCopilotContextItems } from "../src/domain/agent/agent-context.js";
import { SIDECHAT_OOC_RECENCY_ANCHOR_TEXT } from "../src/domain/agent/kinds/sidechat-ooc-kind.js";
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
		streamText: ((opts: { messages: CapturedMessage[] }) => {
			capturedMessages = opts.messages;
			return makeFakeStreamTextResult([{ type: "text-delta", text: fakeReply }]);
		}) as unknown as SidechatStreamDeps["streamText"],
	};
});

beforeEach(() => {
	capturedMessages = [];
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
): Promise<Array<{ event: string; data: string }>> {
	const chunks: Array<{ event: string; data: string }> = [];
	for await (const chunk of streamSidechatTurn(
		{ threadId, content, providerProfileId: "prov_1" },
		deps,
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
