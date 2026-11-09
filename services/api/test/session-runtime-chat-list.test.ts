/**
 * LC-2 — sidebar chat list characterization (LONG_CHAT_PERFORMANCE_REPORT
 * D2, fix step 2).
 *
 * Pins EVERY ChatListItem field of the sidebar list against the CURRENT
 * per-chat derivation's ingredients (chats.getById + the resolved active
 * branch's messages + characters.getById — exactly what mapChatToListItem
 * consumed), on the report's fixture set: empty chat, multi-branch chat with
 * the NON-first branch active, since-deleted character, co-author chat —
 * plus the dangling-activeBranchId corruption whose display resolution
 * (root-branch fallback) the aggregate must reproduce.
 *
 * Written BEFORE the aggregate swap and watched green on the loop
 * implementation; the swap must keep it green — any field that moves means
 * the aggregate changed the sidebar's observable contract. The oracle is
 * read AFTER the list call so the two paths agree even where the old loop
 * repaired corrupted rows mid-read (it re-pointed dangling activeBranchId;
 * the aggregate coalesces in SQL instead).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { ChatId, CharacterId } from "@vibe-tavern/domain";
import type { ChatListItem } from "../src/api/contract/session-types.js";

interface Env {
	runtime: SessionRuntime;
	stores: Awaited<ReturnType<typeof createRuntimeStore>>;
	cleanup: () => Promise<void>;
}

/** The raw bun:sqlite handle under the drizzle store container — used only to
 *  manufacture corruption states the app itself cannot produce with FKs on
 *  (since-deleted character row, dangling activeBranchId). Drizzle carries the
 *  client as the typed `$client` property, so the reach-through needs no
 *  erasure. */
function rawClient(stores: Env["stores"]): Database {
	return stores.db.$client;
}

/** Field-by-field oracle = the ingredients the CURRENT mapChatToListItem
 *  consumes: chat row, resolved active branch (own branch → root fallback,
 *  getChatState's precedence), that branch's messages, character row.
 *  `subtitle` is constant "" and a missing character row is "Unknown" — the
 *  resolver's toCharacterRecord / NotFound-catch behavior, pinned. */
async function oracleListItem(stores: Env["stores"], chatId: string): Promise<ChatListItem> {
	const chat = (await stores.chats.getById(chatId))!;
	const branches = await stores.chats.getBranches(chatId);
	const branch = branches.find((b) => b.id === chat.activeBranchId)
		?? branches.find((b) => b.parentBranchId === null)!;
	const branchMessages = await stores.messages.getMessages(branch.id);
	const character = await stores.characters.getById(chat.characterId);
	return {
		id: chat.id as ChatId,
		title: chat.title,
		characterId: chat.characterId as CharacterId,
		characterName: character?.name ?? "Unknown",
		subtitle: "",
		activeBranchLabel: branch.label,
		mode: chat.mode,
		messageCount: branchMessages.length,
		lastMessageAt: branchMessages.reduce<string>(
			(max, m) => (m.createdAt > max ? m.createdAt : max),
			"",
		) || chat.updatedAt,
		updatedAt: chat.updatedAt,
	};
}

let env: Env;
let hostCharacterId: CharacterId;
let multiChatId: ChatId;
let multiRootBranchId: string;
let multiForkNewestCreatedAt: string;
let emptyChatId: ChatId;
let ghostChatId: ChatId;
let coauthorChatId: ChatId;
let driftChatId: ChatId;

beforeAll(async () => {
	const tmpDir = resolve(tmpdir(), `vt-lc2-${crypto.randomUUID().slice(0, 8)}`);
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	env = {
		runtime,
		stores,
		cleanup: async () => {
			try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
		},
	};

	// A — multi-branch chat: greeting + one message on the root branch, fork
	// from that message (the fork auto-activates → NON-first branch active and
	// holds 2 messages), then one more message lands on the ROOT branch only.
	const host = await runtime.character.createFromScratch({
		name: "Host",
		description: "lc2 fixture character",
		firstMessage: "Greeting from Host",
	});
	multiChatId = host.activeChatId;
	hostCharacterId = (await stores.chats.getById(multiChatId))!.characterId as CharacterId;
	const multiChat = await stores.chats.getById(multiChatId);
	multiRootBranchId = multiChat!.activeBranchId;
	const second = await stores.messages.addMessage({
		chatId: multiChatId,
		branchId: multiRootBranchId,
		role: "user",
		authorType: "user",
		content: "lc2 m2",
	});
	multiForkNewestCreatedAt = second.createdAt;
	await runtime.chatRuntime.forkBranch(multiChatId, second.id);
	// forkBranch re-stamps the copied messages with the fork time as createdAt,
	// so the fork's newest-message timestamp is the fork's OWN clock reading —
	// capture it from the branch the list will actually read (the active fork).
	const forkedChat = (await stores.chats.getById(multiChatId))!;
	const forkMessages = await stores.messages.getMessages(forkedChat.activeBranchId);
	multiForkNewestCreatedAt = forkMessages.reduce(
		(max, m) => (m.createdAt > max ? m.createdAt : max),
		"",
	)!;
	await stores.messages.addMessage({
		chatId: multiChatId,
		branchId: multiRootBranchId,
		role: "assistant",
		authorType: "assistant",
		content: "lc2 m3 root only",
	});

	// B — empty chat: a character with no first message seeds no greeting.
	const silent = await runtime.character.createFromScratch({
		name: "Silent",
		description: "lc2 no-greeting fixture",
	});
	emptyChatId = silent.activeChatId;

	// C — since-deleted character: the character runtime's delete cascades
	// chats away via FK, so only a raw row removal leaves the dangling
	// reference the sidebar must tolerate (import/legacy shapes).
	const ghost = await runtime.character.createFromScratch({
		name: "Ghost",
		description: "lc2 doomed fixture",
		firstMessage: "boo",
	});
	ghostChatId = ghost.activeChatId;
	const client = rawClient(stores);
	client.exec("PRAGMA foreign_keys = OFF");
	client.run("DELETE FROM characters WHERE id = ?", [(await stores.chats.getById(ghostChatId))!.characterId]);
	client.exec("PRAGMA foreign_keys = ON");

	// D — co-author chat on the SAME character (pins the mode filter and the
	// co-author entry list carrying the sidebar's field shape).
	const coauthor = await runtime.chatLifecycle.createChatForCharacter(hostCharacterId, "coauthor");
	coauthorChatId = coauthor.activeChat.id as ChatId;

	// E — a normal chat whose activeBranchId is dangled inside its test below.
	const drift = await runtime.character.createFromScratch({
		name: "Drift",
		description: "lc2 dangling-pointer fixture",
		firstMessage: "root greeting",
	});
	driftChatId = drift.activeChatId;
});

afterAll(async () => {
	await env.cleanup();
});

describe("LC-2 — sidebar chat list (characterization, pre/post aggregate)", () => {
	it("getSnapshot().chats equals the per-chat oracle field-by-field, in chatOrder order", async () => {
		// chatOrder = one prepend per created chat (DB was empty at seed) →
		// exact reverse creation order: drift, coauthor, ghost, empty, multi.
		const expectedIds = [driftChatId, coauthorChatId, ghostChatId, emptyChatId, multiChatId];
		const snap = await env.runtime.getSnapshot(multiChatId);
		expect(snap.chats.map((c) => c.id)).toEqual(expectedIds);
		const oracle = await Promise.all(expectedIds.map((id) => oracleListItem(env.stores, id)));
		expect(snap.chats).toEqual(oracle);
	});

	it("golden pins — the report's precedence rules", async () => {
		const { chats } = await env.runtime.buildChatListResponse();
		const byId = new Map(chats.map((c) => [c.id as string, c]));

		// Empty chat: count 0 and lastMessageAt falls back to chat.updatedAt.
		const empty = byId.get(emptyChatId)!;
		expect(empty.messageCount).toBe(0);
		expect(empty.lastMessageAt).toBe((await env.stores.chats.getById(emptyChatId))!.updatedAt);

		// Multi-branch, non-first (fork) branch active: the FORK's count, label
		// and newest message — not the root branch's (root holds 3 messages).
		const multi = byId.get(multiChatId)!;
		expect(multi.messageCount).toBe(2);
		expect(multi.activeBranchLabel).toBe("branch 2");
		expect(multi.lastMessageAt).toBe(multiForkNewestCreatedAt);

		// Since-deleted character: placeholder name, empty subtitle.
		const ghost = byId.get(ghostChatId)!;
		expect(ghost.characterName).toBe("Unknown");
		expect(ghost.subtitle).toBe("");

		// Co-author chat rides the same list with its mode.
		const co = byId.get(coauthorChatId)!;
		expect(co.mode).toBe("coauthor");
		expect(co.messageCount).toBe(1);

		// subtitle is constant "" on every item (toCharacterRecord never
		// derives tags[0] on this path).
		for (const item of chats) expect(item.subtitle).toBe("");
	});

	it("listCoauthorChats returns only the character's co-author chats, identical fields", async () => {
		const list = await env.runtime.listCoauthorChats(hostCharacterId);
		expect(list.map((c) => c.id)).toEqual([coauthorChatId]);
		expect(list[0]).toEqual(await oracleListItem(env.stores, coauthorChatId));
	});

	it("dangling activeBranchId displays the root branch's values (getChatState's fallback)", async () => {
		const client = rawClient(env.stores);
		client.run("UPDATE chats SET active_branch_id = ? WHERE id = ?", ["brnch_lc2_missing", driftChatId]);
		// The PRE-read row is what the list must display for updatedAt: the old
		// loop read the chat row before its mid-read repair re-pointed (and
		// bumped) it; the aggregate never repairs, so the row is unchanged and
		// the same expectation holds on both sides of the swap.
		const preRead = (await env.stores.chats.getById(driftChatId))!;
		const { chats } = await env.runtime.buildChatListResponse();
		const item = chats.find((c) => c.id === driftChatId)!;
		// Display = the ROOT branch's label/count/newest (the old loop resolved
		// via getChatState's root fallback; the aggregate coalesces in SQL).
		const root = (await env.stores.chats.getBranches(driftChatId)).find((b) => b.parentBranchId === null)!;
		const rootMessages = await env.stores.messages.getMessages(root.id);
		expect(item.activeBranchLabel).toBe(root.label);
		expect(item.messageCount).toBe(rootMessages.length);
		expect(item.lastMessageAt).toBe(
			rootMessages.reduce<string>((max, m) => (m.createdAt > max ? m.createdAt : max), "") || preRead.updatedAt,
		);
		expect(item.updatedAt).toBe(preRead.updatedAt);
	});
});
