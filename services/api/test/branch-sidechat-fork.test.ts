import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createStoreContainer,
	type AgentThreadRpFrontier,
	type AgentThreadTimelineEntry,
	type CopilotContextMetrics,
	type StoreContainer,
} from "@vibe-tavern/db";
import { brandId, type ChatBranchId, type ChatId, type ExperienceCopilotThreadId } from "@vibe-tavern/domain";
import { PromptAssemblyService } from "../src/domain/prompt/prompt-assembly-service.js";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import { syncBeforeUserMessage, type RpSyncDeps } from "../src/domain/sidechat/rp-sync.js";
import {
	FORK_TARGET_NOT_CHILD_OF_SOURCE_CODE,
	FORK_TARGET_THREAD_ACTIVE_CODE,
	forkBranchSidechat,
	summarizeBranchSidechat,
	type BranchSidechatForkDeps,
} from "../src/domain/sidechat/branch-sidechat-fork.js";
import { isDomainError } from "../src/shared/errors.js";

/**
 * SC-20 — forkBranchSidechat on REAL rows (in-memory store container, the
 * same fixture family as sidechat-rp-sync-store.test.ts). The unit's six
 * named scenarios:
 *
 * 1. the copy carries messages + events + plan + `branch_forked`;
 * 2. the copy's first sync appends NOTHING for the copied history (the
 *    double-read guard) and later picks up only new target-branch messages;
 * 3. a swipe on a copied message produces a correct `selection_changed`
 *    (the frozen-text lookup resolves inside the copied payloads);
 * 4. a target that is not a child of the source → the typed 400;
 * 5. archived sessions are not copied (only ACTIVE);
 * 6. the source is unchanged (thread row, messages, events, frontier,
 *    plan) — and metrics reset (the copy starts fresh, the source keeps
 *    its numbers).
 */

let stores: StoreContainer;
let forkDeps: BranchSidechatForkDeps;
let syncDeps: RpSyncDeps;
let characterId: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-branch-sidechat-fork-"));
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
	forkDeps = {
		chats: stores.chats,
		messages: stores.messages,
		experienceCopilot: stores.experienceCopilot,
		plans: stores.agentPlans,
	};
	syncDeps = {
		chats: stores.chats,
		messages: stores.messages,
		assembly,
		experienceCopilot: stores.experienceCopilot,
	};
});

/** A fresh chat whose ACTIVE branch is the fork source. */
async function makeChat(): Promise<{ chatId: ChatId; sourceBranchId: ChatBranchId }> {
	const chat = await stores.chats.createChat({
		characterId,
		title: "SC-20 fork fixture chat",
		promptPresetId: null,
	});
	return { chatId: brandId<ChatId>(chat.id), sourceBranchId: brandId<ChatBranchId>(chat.activeBranchId) };
}

/** A chat-owned sidechat thread on the given branch. */
async function makeThread(chatId: ChatId, branchId: ChatBranchId): Promise<ExperienceCopilotThreadId> {
	const thread = await stores.experienceCopilot.startNewChatSession(chatId, branchId, "sidechat-ooc");
	return thread.id;
}

/** The id of the message's currently selected variant. */
async function selectedVariantOf(messageId: string): Promise<string> {
	const variants = await stores.messages.getVariants(messageId);
	const selected = variants.find((variant) => variant.isSelected);
	if (!selected) throw new Error(`fixture: message ${messageId} has no selected variant`);
	return selected.id;
}

type TimelineEvent = Extract<AgentThreadTimelineEntry, { rowType: "event" }>;

async function timelineEvents(threadId: ExperienceCopilotThreadId): Promise<TimelineEvent[]> {
	return (await stores.experienceCopilot.listTimeline(threadId)).filter(
		(entry): entry is TimelineEvent => entry.rowType === "event",
	);
}

/** The single ACTIVE sidechat-ooc thread on the branch (throws when ≠1). */
async function activeThreadOn(chatId: ChatId, branchId: ChatBranchId): Promise<ExperienceCopilotThreadId> {
	const sessions = await stores.experienceCopilot.listSessionsForChat(chatId, branchId, "sidechat-ooc");
	const active = sessions.filter((session) => session.archivedAt === null);
	if (active.length !== 1) throw new Error(`fixture: expected 1 active sidechat on the branch, got ${active.length}`);
	return active[0]!.id;
}

const METRICS: CopilotContextMetrics = {
	systemTokens: 10,
	attachedTokens: 0,
	digestTokens: 0,
	historyTokens: 20,
	totalTokens: 30,
	budgetTokens: 100,
	reserveTokens: 25,
	source: "estimate",
	measuredAt: "2026-10-22T00:00:00.000Z",
};

describe("forkBranchSidechat (SC-20)", () => {
	it("the copy carries messages + events + plan + branch_forked (ids re-keyed to the target branch)", async () => {
		const { chatId, sourceBranchId } = await makeChat();
		const threadId = await makeThread(chatId, sourceBranchId);
		const m1 = await stores.messages.addMessage({
			chatId,
			branchId: sourceBranchId,
			role: "assistant",
			authorType: "assistant",
			content: "The tavern door swings open.",
			variants: ["The tavern door swings open.", "The tavern door creaks open."],
			selectedVariantIndex: 0,
		});
		const m2 = await stores.messages.addMessage({
			chatId,
			branchId: sourceBranchId,
			role: "user",
			authorType: "user",
			content: "I step inside.",
		});
		await stores.experienceCopilot.appendMessage(threadId, { role: "user", content: "status?" });
		await syncBeforeUserMessage(syncDeps, threadId);
		await stores.experienceCopilot.appendMessage(threadId, { role: "assistant", content: "all quiet" });
		await stores.experienceCopilot.setContextLinks(threadId, [
			{ targetType: "character", targetId: "char_fixture" },
		]);
		await stores.experienceCopilot.updateTodo(threadId, [{ title: "Watch the door", status: "active" }]);
		await stores.agentPlans.save(
			{ kind: "chatBranch", chatId, branchId: sourceBranchId },
			{ goal: "Guard the tavern", constraints: ["No violence"], tasks: [] },
		);

		// The target branch: a fork of the source at m2 (position 1).
		const target = await stores.chats.forkBranch(chatId, m2.id);

		const copied = await forkBranchSidechat(forkDeps, chatId, sourceBranchId, target.id);
		expect(copied).toHaveLength(1);
		expect(copied[0]!.agentKind).toBe("sidechat-ooc");

		const copyId = await activeThreadOn(chatId, brandId<ChatBranchId>(target.id));
		expect(copyId).toBe(copied[0]!.threadId);

		// Messages copy with fresh ids, order and content preserved.
		const sourceMessages = await stores.experienceCopilot.listMessages(threadId);
		const copiedMessages = await stores.experienceCopilot.listMessages(copyId);
		expect(copiedMessages.map((message) => ({ role: message.role, content: message.content }))).toEqual(
			sourceMessages.map((message) => ({ role: message.role, content: message.content })),
		);
		expect(copiedMessages.map((message) => message.id)).not.toEqual(sourceMessages.map((message) => message.id));

		// Events: the copied rp_sync (re-keyed onto the TARGET branch's ids)
		// followed by the branch_forked separator — nothing else.
		const events = await timelineEvents(copyId);
		expect(events.map((event) => event.kind)).toEqual(["rp_sync", "branch_forked"]);
		const targetM1 = (await stores.messages.getMessages(target.id)).find((message) => message.position === 0)!;
		const targetM2 = (await stores.messages.getMessages(target.id)).find((message) => message.position === 1)!;
		expect(events[0]!.payload).toEqual({
			fromPosition: 0,
			toPosition: 1,
			messages: [
				{
					id: targetM1.id,
					position: 0,
					role: "assistant",
					authorName: "Theron",
					variantId: await selectedVariantOf(targetM1.id),
					text: "The tavern door swings open.",
				},
				{
					id: targetM2.id,
					position: 1,
					role: "user",
					authorName: "Sable",
					variantId: await selectedVariantOf(targetM2.id),
					text: "I step inside.",
				},
			],
		});
		expect(events[1]!.payload).toEqual({ at: 1 });

		// No source-branch id leaked anywhere into the copied thread.
		const serialized = JSON.stringify(await stores.experienceCopilot.listTimeline(copyId));
		expect(serialized).not.toContain(m1.id);
		expect(serialized).not.toContain(m2.id);
		expect(serialized).not.toContain(threadId);

		// Frontier re-keyed: keys are the target's message ids, values the
		// target's variant twins; lastPosition = min(source, fork point).
		const frontier: AgentThreadRpFrontier = (await stores.experienceCopilot.getFrontier(copyId))!;
		expect(frontier).toEqual({
			lastPosition: 1,
			selected: {
				[targetM1.id]: await selectedVariantOf(targetM1.id),
				[targetM2.id]: await selectedVariantOf(targetM2.id),
			},
		});

		// Links and todo copy; the branch plan copies to the target branch.
		const copyRow = await stores.experienceCopilot.getById(copyId);
		expect(copyRow!.contextLinks).toEqual([{ targetType: "character", targetId: "char_fixture" }]);
		expect(copyRow!.todo).toEqual([{ title: "Watch the door", status: "active" }]);
		expect(await stores.agentPlans.get({ kind: "chatBranch", chatId, branchId: target.id })).toEqual({
			goal: "Guard the tavern",
			constraints: ["No violence"],
			tasks: [],
		});
	});

	it("the copy's first sync appends NOTHING for the copied history; a later target message is the only pickup", async () => {
		const { chatId, sourceBranchId } = await makeChat();
		const threadId = await makeThread(chatId, sourceBranchId);
		await stores.messages.addMessage({
			chatId,
			branchId: sourceBranchId,
			role: "assistant",
			authorType: "assistant",
			content: "The tavern door swings open.",
		});
		const m2 = await stores.messages.addMessage({
			chatId,
			branchId: sourceBranchId,
			role: "user",
			authorType: "user",
			content: "I step inside.",
		});
		await syncBeforeUserMessage(syncDeps, threadId);
		const target = await stores.chats.forkBranch(chatId, m2.id);
		await forkBranchSidechat(forkDeps, chatId, sourceBranchId, target.id);
		const copyId = await activeThreadOn(chatId, brandId<ChatBranchId>(target.id));

		// THE double-read guard: the first sync in the target branch finds
		// every frontier id already selected and appends NOTHING — the whole
		// copied history is not re-frozen as a second rp_sync.
		await syncBeforeUserMessage(syncDeps, copyId);
		let events = await timelineEvents(copyId);
		expect(events.map((event) => event.kind)).toEqual(["rp_sync", "branch_forked"]);
		expect((events[0]!.payload as { messages: unknown[] }).messages).toHaveLength(2);

		// A message that only exists on the target branch is the only pickup.
		const m3 = await stores.messages.addMessage({
			chatId,
			branchId: brandId<ChatBranchId>(target.id),
			role: "assistant",
			authorType: "assistant",
			content: "A new turn on the fork.",
		});
		await syncBeforeUserMessage(syncDeps, copyId);
		events = await timelineEvents(copyId);
		expect(events.map((event) => event.kind)).toEqual(["rp_sync", "branch_forked", "rp_sync"]);
		expect(events[2]!.payload).toEqual({
			fromPosition: 2,
			toPosition: 2,
			messages: [
				{
					id: m3.id,
					position: 2,
					role: "assistant",
					authorName: "Theron",
					variantId: await selectedVariantOf(m3.id),
					text: "A new turn on the fork.",
				},
			],
		});

		// And a quiet follow-up sync adds nothing.
		await syncBeforeUserMessage(syncDeps, copyId);
		expect(await timelineEvents(copyId)).toHaveLength(3);
	});

	it("a swipe on a copied message produces a correct selection_changed (previous resolves in the copied payloads)", async () => {
		const { chatId, sourceBranchId } = await makeChat();
		const threadId = await makeThread(chatId, sourceBranchId);
		const m1 = await stores.messages.addMessage({
			chatId,
			branchId: sourceBranchId,
			role: "assistant",
			authorType: "assistant",
			content: "first take",
			variants: ["first take", "second take"],
			selectedVariantIndex: 0,
		});
		await syncBeforeUserMessage(syncDeps, threadId);
		const target = await stores.chats.forkBranch(chatId, m1.id);
		await forkBranchSidechat(forkDeps, chatId, sourceBranchId, target.id);
		const copyId = await activeThreadOn(chatId, brandId<ChatBranchId>(target.id));

		// The swipe happens ON the target branch, on the COPIED message.
		const targetM1 = (await stores.messages.getMessages(target.id)).find((message) => message.position === 0)!;
		const before = await selectedVariantOf(targetM1.id);
		await stores.messages.selectVariant(targetM1.id, 1);
		const after = await selectedVariantOf(targetM1.id);
		expect(after).not.toBe(before);

		await syncBeforeUserMessage(syncDeps, copyId);
		const events = await timelineEvents(copyId);
		expect(events.map((event) => event.kind)).toEqual(["rp_sync", "branch_forked", "selection_changed"]);
		// The previous pair resolves INSIDE the copied rp_sync payload — the
		// frozen-text lookup the remap must keep consistent.
		expect(events[2]!.payload).toEqual({
			messageId: targetM1.id,
			position: 0,
			previous: { variantId: before, text: "first take" },
			current: { variantId: after, text: "second take" },
		});
		expect(await stores.experienceCopilot.getFrontier(copyId)).toEqual({
			lastPosition: 0,
			selected: { [targetM1.id]: after },
		});
	});

	it("a target that is not a child of the source → the typed 400; foreign/missing branches → 404", async () => {
		const { chatId, sourceBranchId } = await makeChat();
		const m1 = await stores.messages.addMessage({
			chatId,
			branchId: sourceBranchId,
			role: "user",
			authorType: "user",
			content: "seed",
		});
		const child = await stores.chats.forkBranch(chatId, m1.id);
		// forkBranch takes the fork point's MESSAGE: forking from a message ON
		// the child branch creates a grandchild whose parent is the child — a
		// branch that is NOT a child of the source.
		const childFirstMessage = (await stores.messages.getMessages(child.id))[0]!;
		const notChild = await stores.chats.forkBranch(chatId, childFirstMessage.id);
		expect(notChild.parentBranchId).toBe(child.id);

		const refusal = await forkBranchSidechat(forkDeps, chatId, sourceBranchId, notChild.id).catch(
			(err: unknown) => err,
		);
		expect(isDomainError(refusal)).toBe(true);
		expect((refusal as { kind?: string }).kind).toBe("Validation");
		expect((refusal as { details?: Record<string, unknown> }).details).toMatchObject({
			code: FORK_TARGET_NOT_CHILD_OF_SOURCE_CODE,
		});

		// The source itself is never its own child.
		const self = await forkBranchSidechat(forkDeps, chatId, sourceBranchId, sourceBranchId).catch(
			(err: unknown) => err,
		);
		expect(isDomainError(self)).toBe(true);
		expect((self as { details?: Record<string, unknown> }).details).toMatchObject({
			code: FORK_TARGET_NOT_CHILD_OF_SOURCE_CODE,
		});

		// A missing target branch → 404; a chat that does not exist → 404.
		const missing = await forkBranchSidechat(forkDeps, chatId, sourceBranchId, "brnch_missing_sc20").catch(
			(err: unknown) => err,
		);
		expect(isDomainError(missing)).toBe(true);
		expect((missing as { kind?: string }).kind).toBe("NotFound");
		const foreignChat = await forkBranchSidechat(
			forkDeps,
			brandId<ChatId>("chat_other_sc20"),
			sourceBranchId,
			child.id,
		).catch((err: unknown) => err);
		expect(isDomainError(foreignChat)).toBe(true);
		expect((foreignChat as { kind?: string }).kind).toBe("NotFound");
	});

	it("a target that already has an active sidechat thread → the typed 400, nothing copied, the target's conversation untouched", async () => {
		const { chatId, sourceBranchId } = await makeChat();
		const m1 = await stores.messages.addMessage({
			chatId,
			branchId: sourceBranchId,
			role: "user",
			authorType: "user",
			content: "seed",
		});
		const child = await stores.chats.forkBranch(chatId, m1.id);

		// The impossible-in-the-UI scenario (owner 2026-10-21: the fork target
		// is always the freshly created branch) — reached only by route misuse.
		// The refusal is typed and LOUD; a copy never replaces a conversation.
		const occupied = await stores.experienceCopilot.startNewChatSession(chatId, child.id, "sidechat-ooc");
		await stores.experienceCopilot.appendMessage(occupied.id, { role: "user", content: "stay" });

		const refusal = await forkBranchSidechat(forkDeps, chatId, sourceBranchId, child.id).catch(
			(err: unknown) => err,
		);
		expect(isDomainError(refusal)).toBe(true);
		expect((refusal as { kind?: string }).kind).toBe("Validation");
		expect((refusal as { details?: Record<string, unknown> }).details).toMatchObject({
			code: FORK_TARGET_THREAD_ACTIVE_CODE,
		});

		// Nothing was copied and the occupied target kept its conversation.
		const targetSessions = await stores.experienceCopilot.listSessionsForChat(chatId, child.id, "sidechat-ooc");
		expect(targetSessions.filter((session) => session.archivedAt === null).map((session) => session.id)).toEqual([
			occupied.id,
		]);
		expect(await stores.experienceCopilot.listMessages(occupied.id)).toHaveLength(1);
	});

	it("archived sessions are not copied; only the ACTIVE thread lands on the target", async () => {
		const { chatId, sourceBranchId } = await makeChat();
		const threadId = await makeThread(chatId, sourceBranchId);
		const m1 = await stores.messages.addMessage({
			chatId,
			branchId: sourceBranchId,
			role: "assistant",
			authorType: "assistant",
			content: "The tavern door swings open.",
		});
		await syncBeforeUserMessage(syncDeps, threadId);
		const target = await stores.chats.forkBranch(chatId, m1.id);

		// The only session is archived → the fork copies nothing.
		await stores.experienceCopilot.archive(threadId);
		expect(await forkBranchSidechat(forkDeps, chatId, sourceBranchId, target.id)).toEqual([]);
		expect(await stores.experienceCopilot.listSessionsForChat(chatId, target.id, "sidechat-ooc")).toHaveLength(0);
		expect(await summarizeBranchSidechat(forkDeps, chatId, target.id)).toEqual({ hasSessions: false, count: 0 });

		// A fresh ACTIVE session (no history yet) IS copied — empty history,
		// never-synced frontier, just the separator.
		const fresh = await stores.experienceCopilot.startNewChatSession(chatId, sourceBranchId, "sidechat-ooc");
		const second = await stores.chats.forkBranch(chatId, m1.id);
		const copied = await forkBranchSidechat(forkDeps, chatId, sourceBranchId, second.id);
		expect(copied).toHaveLength(1);
		expect(copied[0]!.threadId).not.toBe(fresh.id);
		const copyEvents = await timelineEvents(brandId<ExperienceCopilotThreadId>(copied[0]!.threadId));
		expect(copyEvents.map((event) => event.kind)).toEqual(["branch_forked"]);
		expect(await stores.experienceCopilot.getFrontier(brandId<ExperienceCopilotThreadId>(copied[0]!.threadId))).toBeNull();
		expect(await summarizeBranchSidechat(forkDeps, chatId, second.id)).toEqual({ hasSessions: true, count: 1 });
	});

	it("the source is unchanged; metrics reset on the copy while the source keeps its numbers", async () => {
		const { chatId, sourceBranchId } = await makeChat();
		const threadId = await makeThread(chatId, sourceBranchId);
		const m1 = await stores.messages.addMessage({
			chatId,
			branchId: sourceBranchId,
			role: "assistant",
			authorType: "assistant",
			content: "The tavern door swings open.",
		});
		const m2 = await stores.messages.addMessage({
			chatId,
			branchId: sourceBranchId,
			role: "user",
			authorType: "user",
			content: "I step inside.",
		});
		await syncBeforeUserMessage(syncDeps, threadId);
		await stores.experienceCopilot.updateContextMetrics(threadId, METRICS, "prof_fixture", "model-fixture");
		await stores.agentPlans.save(
			{ kind: "chatBranch", chatId, branchId: sourceBranchId },
			{ goal: "Guard the tavern", constraints: [], tasks: [] },
		);

		// The source ADVANCES past the fork point and syncs again: the copy
		// must exclude everything past the fork point.
		await stores.messages.addMessage({
			chatId,
			branchId: sourceBranchId,
			role: "assistant",
			authorType: "assistant",
			content: "Post-fork turn on the source.",
		});
		await syncBeforeUserMessage(syncDeps, threadId);

		const target = await stores.chats.forkBranch(chatId, m2.id);

		// Snapshot everything the source owns.
		const sourceRowBefore = await stores.experienceCopilot.getById(threadId);
		const sourceMessagesBefore = await stores.experienceCopilot.listMessages(threadId);
		const sourceTimelineBefore = await stores.experienceCopilot.listTimeline(threadId);
		const sourceFrontierBefore = await stores.experienceCopilot.getFrontier(threadId);
		const sourcePlanBefore = await stores.agentPlans.get({ kind: "chatBranch", chatId, branchId: sourceBranchId });

		const copied = await forkBranchSidechat(forkDeps, chatId, sourceBranchId, target.id);
		expect(copied).toHaveLength(1);
		const copyId = brandId<ExperienceCopilotThreadId>(copied[0]!.threadId);

		// The copy clips at the fork point: only the pre-fork rp_sync + the
		// separator — no post-fork content, no source ids.
		const copyEvents = await timelineEvents(copyId);
		expect(copyEvents.map((event) => event.kind)).toEqual(["rp_sync", "branch_forked"]);
		expect((copyEvents[0]!.payload as { toPosition: number }).toPosition).toBe(1);
		const sourceIds = [
			m1.id,
			m2.id,
			...Object.keys(sourceFrontierBefore?.selected ?? {}),
		];
		const serializedCopy = JSON.stringify(await stores.experienceCopilot.listTimeline(copyId));
		for (const id of sourceIds) expect(serializedCopy).not.toContain(id);
		const copyFrontier = await stores.experienceCopilot.getFrontier(copyId);
		expect(copyFrontier!.lastPosition).toBe(1); // min(source's 2, fork point 1)

		// Metrics reset: the copy starts fresh, the source keeps its numbers.
		expect((await stores.experienceCopilot.getById(copyId))!.contextMetrics).toBeNull();
		expect((await stores.experienceCopilot.getById(threadId))!.contextMetrics).toEqual(METRICS);

		// The source is byte-for-byte unchanged (row, messages, timeline,
		// frontier, plan).
		expect(await stores.experienceCopilot.getById(threadId)).toEqual(sourceRowBefore);
		expect(await stores.experienceCopilot.listMessages(threadId)).toEqual(sourceMessagesBefore);
		expect(await stores.experienceCopilot.listTimeline(threadId)).toEqual(sourceTimelineBefore);
		expect(await stores.experienceCopilot.getFrontier(threadId)).toEqual(sourceFrontierBefore);
		expect(await stores.agentPlans.get({ kind: "chatBranch", chatId, branchId: sourceBranchId })).toEqual(
			sourcePlanBefore,
		);
	});
});
