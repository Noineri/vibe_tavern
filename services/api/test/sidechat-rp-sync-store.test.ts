import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createStoreContainer,
	type AgentThreadRpFrontier,
	type AgentThreadTimelineEntry,
	type StoreContainer,
} from "@vibe-tavern/db";
import { brandId, type ChatBranchId, type ChatId, type ExperienceCopilotThreadId } from "@vibe-tavern/domain";
import { PromptAssemblyService } from "../src/domain/prompt/prompt-assembly-service.js";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import {
	RpSyncThreadNotChatOwnedError,
	syncBeforeUserMessage,
	type RpSyncDeps,
} from "../src/domain/sidechat/rp-sync.js";

/**
 * SC-2c — syncBeforeUserMessage on REAL rows (in-memory store container, the
 * same StaticPromptResolver + PromptAssemblyService seam a chat turn and the
 * SC-2a reader go through). Pins the unit's scenarios:
 *
 * 1. the first sync freezes the whole branch as ONE rp_sync event and writes
 *    the frontier (never-synced thread → SC-2b's initial frontier contract);
 * 2. an RP advance after a sync → only the delta event; a follow-up sync with
 *    no change adds nothing;
 * 3. two back-to-back syncs racing on one thread → ONE delta total — the
 *    dedup invariant: the second computes against the first's COMMITTED
 *    frontier (one synchronous store transaction, not two);
 * 4. another branch's messages never appear in the thread's frozen events;
 * 5. a script-owned thread (and a missing thread id) is refused with the
 *    typed error, before any RP-chat read;
 * 6. a hand-broken frontier (claims a pair no stored event froze) → the sync
 *    throws AND leaves the store untouched — no events, frontier unmoved;
 * 7. swipes after the first sync → selection_changed events whose `previous`
 *    text comes from the STORED payloads (the first sync's rp_sync, then the
 *    prior selection_changed's `current` — the swipe chain).
 */

let stores: StoreContainer;
let deps: RpSyncDeps;
let characterId: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-sidechat-rp-sync-store-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const persona = await stores.personas.create({
		name: "Sable",
		description: "A wandering cartographer.",
		defaultForNewChats: true,
	});
	expect(persona.name).toBe("Sable");
	const character = await stores.characters.create({ name: "Theron" });
	characterId = character.id;
	const resolver = new StaticPromptResolver(stores, new RegexHookService(stores));
	const assembly = new PromptAssemblyService(stores, resolver, stores.content.fileStore);
	deps = {
		chats: stores.chats,
		messages: stores.messages,
		assembly,
		experienceCopilot: stores.experienceCopilot,
	};
});

/** A chat with an active branch and a chat-owned sidechat thread on it — the
 *  unit's standard fixture (SC-0a owner columns on the thread row). */
async function makeSidechatFixture(): Promise<{
	threadId: ExperienceCopilotThreadId;
	chatId: ChatId;
	branchId: ChatBranchId;
}> {
	const chat = await stores.chats.createChat({
		characterId,
		title: "SC-2c fixture chat",
		promptPresetId: null,
	});
	const chatId = brandId<ChatId>(chat.id);
	const branchId = brandId<ChatBranchId>(chat.activeBranchId);
	const thread = await stores.experienceCopilot.startNewChatSession(chat.id, chat.activeBranchId, "sidechat-ooc");
	return { threadId: thread.id, chatId, branchId };
}

type TimelineEvent = Extract<AgentThreadTimelineEntry, { rowType: "event" }>;

function eventsOf(timeline: readonly AgentThreadTimelineEntry[]): TimelineEvent[] {
	return timeline.filter((entry): entry is TimelineEvent => entry.rowType === "event");
}

async function timelineEvents(threadId: ExperienceCopilotThreadId): Promise<TimelineEvent[]> {
	return eventsOf(await stores.experienceCopilot.listTimeline(threadId));
}

/** The id of the message's currently selected variant (the view's variantId). */
async function selectedVariantOf(messageId: string): Promise<string> {
	const variants = await stores.messages.getVariants(messageId);
	const selected = variants.find((variant) => variant.isSelected);
	if (!selected) throw new Error(`fixture: message ${messageId} has no selected variant`);
	return selected.id;
}

describe("syncBeforeUserMessage (SC-2c)", () => {
	it("first sync freezes the whole branch as ONE rp_sync event and writes the frontier", async () => {
		const { threadId, chatId, branchId } = await makeSidechatFixture();
		const m1 = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "The tavern door swings open.",
		});
		const m2 = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "user",
			authorType: "user",
			content: "I step inside.",
		});
		const m3 = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "Welcome, traveler.",
		});

		await syncBeforeUserMessage(deps, threadId);

		const events = await timelineEvents(threadId);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: "rp_sync" });
		// The exact payload contract SC-3a renders — ids, positions, speaker
		// names (ST rule), the SELECTED variant, the transformed text.
		expect(events[0]!.payload).toEqual({
			fromPosition: 0,
			toPosition: 2,
			messages: [
				{ id: m1.id, position: 0, role: "assistant", authorName: "Theron", variantId: await selectedVariantOf(m1.id), text: "The tavern door swings open." },
				{ id: m2.id, position: 1, role: "user", authorName: "Sable", variantId: await selectedVariantOf(m2.id), text: "I step inside." },
				{ id: m3.id, position: 2, role: "assistant", authorName: "Theron", variantId: await selectedVariantOf(m3.id), text: "Welcome, traveler." },
			],
		});
		expect(await stores.experienceCopilot.getFrontier(threadId)).toEqual({
			lastPosition: 2,
			selected: {
				[m1.id]: await selectedVariantOf(m1.id),
				[m2.id]: await selectedVariantOf(m2.id),
				[m3.id]: await selectedVariantOf(m3.id),
			},
		});
	});

	it("an RP advance → only the delta event; a follow-up sync with no change adds nothing", async () => {
		const { threadId, chatId, branchId } = await makeSidechatFixture();
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "The tavern door swings open.",
		});
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "user",
			authorType: "user",
			content: "I step inside.",
		});
		await syncBeforeUserMessage(deps, threadId);

		const m3 = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "A new turn arrives.",
		});
		await syncBeforeUserMessage(deps, threadId);

		const events = await timelineEvents(threadId);
		expect(events).toHaveLength(2);
		expect(events[1]!.payload).toEqual({
			fromPosition: 2,
			toPosition: 2,
			messages: [
				{ id: m3.id, position: 2, role: "assistant", authorName: "Theron", variantId: await selectedVariantOf(m3.id), text: "A new turn arrives." },
			],
		});
		expect(await stores.experienceCopilot.getFrontier(threadId)).toMatchObject({ lastPosition: 2 });

		// No RP change → the next sync produces no events at all.
		await syncBeforeUserMessage(deps, threadId);
		expect(await timelineEvents(threadId)).toHaveLength(2);
	});

	it("two back-to-back syncs racing on one thread → ONE delta total (the second sees the first's committed frontier)", async () => {
		const { threadId, chatId, branchId } = await makeSidechatFixture();
		const m1 = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "The tavern door swings open.",
		});
		const m2 = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "user",
			authorType: "user",
			content: "I step inside.",
		});

		// Both syncs in flight at once: without the one-transaction write both
		// would read the never-synced frontier and each freeze the full branch
		// — the duplicated delta this unit exists to prevent.
		await Promise.all([
			syncBeforeUserMessage(deps, threadId),
			syncBeforeUserMessage(deps, threadId),
		]);

		const events = await timelineEvents(threadId);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: "rp_sync" });
		expect(await stores.experienceCopilot.getFrontier(threadId)).toEqual({
			lastPosition: 1,
			selected: {
				[m1.id]: await selectedVariantOf(m1.id),
				[m2.id]: await selectedVariantOf(m2.id),
			},
		});

		// And the follower after the race still adds nothing.
		await syncBeforeUserMessage(deps, threadId);
		expect(await timelineEvents(threadId)).toHaveLength(1);
	});

	it("another branch's messages never appear in the thread's frozen events", async () => {
		const own = await makeSidechatFixture();
		const foreign = await makeSidechatFixture();
		const foreignMessage = await stores.messages.addMessage({
			chatId: foreign.chatId,
			branchId: foreign.branchId,
			role: "user",
			authorType: "user",
			content: "A message on ANOTHER branch.",
		});
		const ownMessage = await stores.messages.addMessage({
			chatId: own.chatId,
			branchId: own.branchId,
			role: "user",
			authorType: "user",
			content: "A message on the OWN branch.",
		});

		await syncBeforeUserMessage(deps, own.threadId);

		const timeline = await stores.experienceCopilot.listTimeline(own.threadId);
		const serialized = JSON.stringify(timeline);
		expect(serialized).toContain(ownMessage.id);
		expect(serialized).not.toContain(foreignMessage.id);
		expect(serialized).not.toContain("A message on ANOTHER branch.");
		const events = eventsOf(timeline);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: "rp_sync" });
	});

	it("a script-owned thread (and a missing thread id) is refused with the typed error", async () => {
		const scriptThread = await stores.experienceCopilot.startNewSession("script_sc2c", "Editor");

		const refusal = await syncBeforeUserMessage(deps, scriptThread.id).catch((err: unknown) => err);
		expect(refusal).toBeInstanceOf(RpSyncThreadNotChatOwnedError);
		expect((refusal as RpSyncThreadNotChatOwnedError).code).toBe("RP_SYNC_THREAD_NOT_CHAT_OWNED");
		// Refused before any write: the script thread's timeline stays empty.
		expect(await timelineEvents(scriptThread.id)).toHaveLength(0);

		const missing = await syncBeforeUserMessage(deps, brandId<ExperienceCopilotThreadId>("thr_sc2c_missing")).catch(
			(err: unknown) => err,
		);
		expect(missing).toBeInstanceOf(RpSyncThreadNotChatOwnedError);
	});

	it("a frontier claiming a pair no stored event froze → the sync throws and writes NOTHING", async () => {
		const { threadId, chatId, branchId } = await makeSidechatFixture();
		const message = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "first take",
			variants: ["first take", "second take"],
			selectedVariantIndex: 0,
		});
		await syncBeforeUserMessage(deps, threadId);
		expect(await timelineEvents(threadId)).toHaveLength(1);

		// Hand-break the frozen history: the frontier now claims the message
		// was synced at its SECOND variant — a pair no stored event ever froze
		// (that variant has never been selected, so no rp_sync and no
		// selection_changed carries its text).
		const variants = await stores.messages.getVariants(message.id);
		const neverSelected = variants.find((variant) => !variant.isSelected)!;
		const corrupted: AgentThreadRpFrontier = {
			lastPosition: 0,
			selected: { [message.id]: neverSelected.id },
		};
		await stores.experienceCopilot.setFrontier(threadId, corrupted);

		await expect(syncBeforeUserMessage(deps, threadId)).rejects.toThrow(/frozen text missing for message/);

		// No partial write: still exactly the first sync's single event, and
		// the frontier is unmoved (the corruption itself left as-is).
		expect(await timelineEvents(threadId)).toHaveLength(1);
		expect(await stores.experienceCopilot.getFrontier(threadId)).toEqual(corrupted);
	});

	it("swipes after the first sync → selection_changed whose previous text comes from the STORED payloads", async () => {
		const { threadId, chatId, branchId } = await makeSidechatFixture();
		const message = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "first take",
			variants: ["first take", "second take", "third take"],
			selectedVariantIndex: 0,
		});
		const v1 = await selectedVariantOf(message.id);
		await syncBeforeUserMessage(deps, threadId);

		await stores.messages.selectVariant(message.id, 1);
		const v2 = await selectedVariantOf(message.id);
		await syncBeforeUserMessage(deps, threadId);

		let events = await timelineEvents(threadId);
		expect(events).toHaveLength(2);
		// The previous text was frozen by the FIRST sync's rp_sync payload.
		expect(events[1]!.payload).toEqual({
			messageId: message.id,
			position: 0,
			previous: { variantId: v1, text: "first take" },
			current: { variantId: v2, text: "second take" },
		});

		await stores.messages.selectVariant(message.id, 2);
		const v3 = await selectedVariantOf(message.id);
		await syncBeforeUserMessage(deps, threadId);

		events = await timelineEvents(threadId);
		expect(events).toHaveLength(3);
		// The chain: this previous (v2) was frozen ONLY by the first
		// selection_changed's `current` — the stored-payload lookup at work.
		expect(events[2]!.payload).toEqual({
			messageId: message.id,
			position: 0,
			previous: { variantId: v2, text: "second take" },
			current: { variantId: v3, text: "third take" },
		});
		expect(await stores.experienceCopilot.getFrontier(threadId)).toEqual({
			lastPosition: 0,
			selected: { [message.id]: v3 },
		});
	});
});
