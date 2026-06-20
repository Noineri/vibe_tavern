/**
 * Wave B1.1 — per-endpoint response builders: shape contracts.
 *
 * Each builder returns ONLY the fields its mutation family touches (the
 * field-ownership table in CHAT_FRONTEND_REFACTOR_PLAN.md). These tests pin
 * the exact key set of every builder so a future wiring step (B1.2–B1.5)
 * cannot silently drift a field in or out. They also characterization-pin
 * `getSnapshot` (its internals were refactored onto shared fetch primitives;
 * its full 12-key shape must be unchanged).
 *
 * B1.1 is ADDITIVE: nothing is wired to the builders yet, so these are the
 * only exercise of the new code paths.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { ChatId, MessageId } from "@vibe-tavern/domain";

/** Spins up a real SessionRuntime against an isolated temp DB and seeds one chat. */
async function createTestRuntime(): Promise<{
	runtime: SessionRuntime;
	chatId: ChatId;
	cleanup: () => Promise<void>;
}> {
	const tmpDir = resolve(tmpdir(), "vt-b11-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	const created = await runtime.character.createFromScratch({
		name: "TestBot",
		description: "a probe character",
		firstMessage: "Hello there!",
	});
	return {
		runtime,
		chatId: created.activeChatId,
		cleanup: async () => {
			try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
		},
	};
}

const sortedKeys = (o: object): string[] => Object.keys(o).sort();

describe("Wave B1.1 — per-endpoint response builder shapes", () => {
	let runtime: SessionRuntime;
	let chatId: ChatId;
	let cleanup: () => Promise<void>;

	afterAll(async () => { await cleanup(); });

	it("boots a test runtime and seeds a chat", async () => {
		const ctx = await createTestRuntime();
		runtime = ctx.runtime;
		chatId = ctx.chatId;
		cleanup = ctx.cleanup;
		expect(chatId).toBeTruthy();
		const snap = await runtime.getSnapshot(chatId);
		expect(snap.character?.name).toBe("TestBot");
		expect(snap.messages.length).toBeGreaterThan(0);
	});

	// ─── getSnapshot characterization (internals refactored; shape unchanged) ───

	it("getSnapshot still returns the full 12-key shape", async () => {
		const snap = await runtime.getSnapshot(chatId);
		expect(sortedKeys(snap)).toEqual([
			"activeBranch",
			"activeChat",
			"allCharacters",
			"branches",
			"character",
			"chats",
			"contextPreview",
			"messages",
			"persona",
			"promptTrace",
			"promptTraceHistory",
			"summaries",
		]);
	});

	// ─── Message path ───────────────────────────────────────────────────

	it("buildMessageResponse: edit-shape = {messages, contextPreview, promptTrace}", async () => {
		const r = await runtime.buildMessageResponse(chatId);
		expect(sortedKeys(r)).toEqual(["contextPreview", "messages", "promptTrace"]);
		expect(r.messages.length).toBeGreaterThan(0);
	});

	it("buildMessageResponse: send/delete-shape adds summaries", async () => {
		const r = await runtime.buildMessageResponse(chatId, { summaries: true });
		expect(sortedKeys(r)).toEqual(["contextPreview", "messages", "promptTrace", "summaries"]);
	});

	// ─── Variant path ───────────────────────────────────────────────────

	it("buildVariantResponse: variant-shape = {messages, contextPreview}", async () => {
		const r = await runtime.buildVariantResponse(chatId);
		expect(sortedKeys(r)).toEqual(["contextPreview", "messages"]);
	});

	it("buildVariantResponse: set-greeting-shape adds activeChat", async () => {
		const r = await runtime.buildVariantResponse(chatId, { activeChat: true });
		expect(sortedKeys(r)).toEqual(["activeChat", "contextPreview", "messages"]);
	});

	// ─── Branch path ────────────────────────────────────────────────────

	it("buildBranchResponse: fork/activate/delete-shape", async () => {
		const r = await runtime.buildBranchResponse(chatId);
		expect(sortedKeys(r)).toEqual([
			"activeBranch", "branches", "chats", "contextPreview", "messages", "summaries",
		]);
	});

	it("buildBranchMetaResponse: rename-branch-shape = {branches}", async () => {
		const r = await runtime.buildBranchMetaResponse(chatId);
		expect(sortedKeys(r)).toEqual(["branches"]);
		expect(r.branches.length).toBeGreaterThan(0);
	});

	// ─── Chat list / switch / create ────────────────────────────────────

	it("buildChatListResponse: rename-chat-shape = {chats}", async () => {
		const r = await runtime.buildChatListResponse();
		expect(sortedKeys(r)).toEqual(["chats"]);
		expect(r.chats.length).toBeGreaterThan(0);
	});

	it("buildChatSwitchResponse: clone-shape (no opts)", async () => {
		const r = await runtime.buildChatSwitchResponse(chatId);
		expect(sortedKeys(r)).toEqual([
			"activeBranch", "activeChat", "branches", "character",
			"contextPreview", "messages", "summaries",
		]);
	});

	it("buildChatSwitchResponse: switch-shape adds persona; clone-shape adds chats", async () => {
		const withPersona = await runtime.buildChatSwitchResponse(chatId, { persona: true });
		expect(sortedKeys(withPersona)).toContain("persona");
		const withChats = await runtime.buildChatSwitchResponse(chatId, { chats: true });
		expect(sortedKeys(withChats)).toContain("chats");
	});

	it("buildChatCreateResponse: create/clear-shape (full)", async () => {
		const r = await runtime.buildChatCreateResponse(chatId);
		expect(sortedKeys(r)).toEqual([
			"activeBranch", "activeChat", "branches", "character",
			"chats", "contextPreview", "messages", "summaries",
		]);
	});

	// ─── Config patch + summary ─────────────────────────────────────────

	it("buildConfigPatchResponse: set-preset-shape = {contextPreview}", async () => {
		const r = await runtime.buildConfigPatchResponse(chatId);
		expect(sortedKeys(r)).toEqual(["contextPreview"]);
	});

	it("buildConfigPatchResponse: patches add persona/character/activeChat", async () => {
		const r = await runtime.buildConfigPatchResponse(chatId, {
			persona: true, character: true, activeChat: true,
		});
		expect(sortedKeys(r)).toEqual(["activeChat", "character", "contextPreview", "persona"]);
	});

	it("buildSummaryResponse: summary-CRUD-shape = {summaries}", async () => {
		const r = await runtime.buildSummaryResponse(chatId);
		expect(sortedKeys(r)).toEqual(["summaries"]);
	});

	// ─── contextPreview is computed, not trace-gated (structural decoupling) ───

	it("buildMessageResponse includes contextPreview (decoupled from trace presence)", async () => {
		// assembleContextPreview does not call an LLM (it assembles prompt context
		// from DB), so it returns a non-null preview even without a provider.
		// getSnapshot would null this when a trace exists; the builder must not.
		const r = await runtime.buildMessageResponse(chatId);
		expect(r.contextPreview).not.toBeNull();
		expect(r.contextPreview?.layers).toBeDefined();
	});

	// ─── Wave B1.2 wiring: mutation methods return the narrowed shapes ───
	//
	// Pins that each migrated method returns ONLY its field-ownership row,
	// not the full SessionSnapshot. A regression here means a method silently
	// went back to `getSnapshot()` (re-introducing the monolithic payload).

	it("B1.2: editMessage returns MessageResponse (not SessionSnapshot)", async () => {
		const msg = (await runtime.getSnapshot(chatId)).messages[0];
		const r = await runtime.chatRuntime.editMessage(chatId, msg.id, "edited content");
		expect(sortedKeys(r)).toEqual(["contextPreview", "messages", "promptTrace"]);
	});

	it("B1.2: selectMessageVariant returns VariantResponse (not SessionSnapshot)", async () => {
		const msg = (await runtime.getSnapshot(chatId)).messages[0];
		// index 0 is always safe (the seeded greeting lands as variant 0).
		const r = await runtime.chatRuntime.selectMessageVariant(chatId, msg.id as MessageId, 0);
		expect(sortedKeys(r)).toEqual(["contextPreview", "messages"]);
	});

	it("B1.2: setGreetingIndex returns VariantResponse with activeChat", async () => {
		const r = await runtime.setGreetingIndex(chatId, 0);
		expect(sortedKeys(r)).toEqual(["activeChat", "contextPreview", "messages"]);
	});

	// ─── Wave B1.3 wiring: branch mutation methods return narrowed shapes ───

	it("B1.3: renameBranch returns BranchMetaResponse = {branches} (no contextPreview)", async () => {
		const snap = await runtime.getSnapshot(chatId);
		const branchId = snap.activeBranch!.id;
		const r = await runtime.chatRuntime.renameBranch(chatId, branchId, "renamed");
		expect(sortedKeys(r)).toEqual(["branches"]);
	});

	it("B1.3: forkBranch returns BranchResponse (messages + branches + activeBranch + summaries + contextPreview + chats)", async () => {
		const r = await runtime.chatRuntime.forkBranch(chatId);
		expect(sortedKeys(r)).toEqual([
			"activeBranch", "branches", "chats", "contextPreview", "messages", "summaries",
		]);
		expect(r.branches.length).toBeGreaterThanOrEqual(2);
		// chats (sidebar list) refresh on branch switch because the chat's active
		// branch changed, and ChatListItem.messageCount is the active branch's count.
		expect(r.chats.length).toBeGreaterThanOrEqual(1);
	});

	// ─── Wave B1.4 wiring: navigation methods return narrowed shapes ───

	it("B1.4: switchChat returns ChatSwitchResponse (incl persona; no chats — switch does not move the list)", async () => {
		const r = await runtime.chatLifecycle.switchChat(chatId);
		expect(sortedKeys(r)).toEqual([
			"activeBranch", "activeChat", "branches", "character",
			"contextPreview", "messages", "persona", "summaries",
		]);
		// persona is the switched-to chat's persona (switch loads it with the view).
		expect(r.persona).toBeTruthy();
		// chats is deliberately omitted: the sidebar list lives in the store from
		// bootstrap and switch does no move-to-front.
		expect((r as Record<string, unknown>).chats).toBeUndefined();
		// ── chat→branch hierarchy invariant ──
		// branchId is a CHILD of chatId: every returned branch must belong to the
		// switched-to chat, and the active branch must be one of them. Switching
		// chats must never leak another chat's branches or leave a dangling
		// activeBranch from the previously-viewed chat.
		expect(r.activeBranch.chatId).toBe(chatId);
		expect(r.branches.every((b) => b.chatId === chatId)).toBe(true);
		expect(r.branches.some((b) => b.id === r.activeBranch.id)).toBe(true);
	});

	it("B1.4: renameChat returns ChatListResponse = {chats}", async () => {
		const r = await runtime.chatRuntime.renameChat(chatId, "renamed chat");
		expect(sortedKeys(r)).toEqual(["chats"]);
		// The renamed chat's new title must appear in the refreshed list — this is
		// what the sidebar renders titles from (Sidebar.tsx / Rail.tsx).
		const renamed = r.chats.find((c) => c.id === chatId);
		expect(renamed?.title).toBe("renamed chat");
	});

	it("B1.4: createChatForCharacter returns ChatCreateResponse (8 keys)", async () => {
		const snap = await runtime.getSnapshot(chatId);
		const characterId = snap.character!.id;
		const r = await runtime.chatLifecycle.createChatForCharacter(characterId);
		expect(sortedKeys(r)).toEqual([
			"activeBranch", "activeChat", "branches", "character",
			"chats", "contextPreview", "messages", "summaries",
		]);
		// The new chat is added at the front of the list (chatOrder.unshift);
		// createChatAction (frontend) reads snapshot.chats[0].id as the new chat.
		expect(r.chats[0].id).toBeTruthy();
		expect(r.chats[0].id).not.toBe(chatId);
		expect(r.activeChat.id).toBe(r.chats[0].id);
		// ── chat→branch hierarchy invariant ──
		// A brand-new chat gets a brand-new default branch as its ONLY child.
		// Every returned branch must belong to the new chatId, and the active
		// branch must be that child. The new chat's branch must NOT collide with
		// any branch of the previously-seeded chat.
		const newChatId = r.activeChat.id;
		expect(r.activeBranch.chatId).toBe(newChatId);
		expect(r.branches.every((b) => b.chatId === newChatId)).toBe(true);
		expect(r.branches.length).toBe(1);
		expect(r.activeChat.activeBranchId).toBe(r.activeBranch.id);
	});

	it("B1.4: clearChat returns ChatCreateResponse and the new chat differs from the cleared one", async () => {
		const oldChatId = chatId;
		// Capture the old chat's branch id so we can assert the cleared chat's
		// fresh branch is a different child (clear deletes the old chat AND its
		// branches, then creates a new chat with a new default branch).
		const oldSnap = await runtime.getSnapshot(chatId);
		const oldBranchId = oldSnap.activeBranch!.id;
		const r = await runtime.chatLifecycle.clearChat(chatId);
		expect(sortedKeys(r)).toEqual([
			"activeBranch", "activeChat", "branches", "character",
			"chats", "contextPreview", "messages", "summaries",
		]);
		// clearChat deletes the old chat and creates a fresh one — the new
		// activeChat must NOT be the cleared chatId.
		expect(r.activeChat.id).not.toBe(oldChatId);
		// The old chat is gone from the sidebar list (cascade-deleted).
		expect(r.chats.find((c) => c.id === oldChatId)).toBeUndefined();
		// The new chat is at the front (chatOrder.unshift on create).
		expect(r.chats[0].id).toBe(r.activeChat.id);
		// ── chat→branch hierarchy invariant ──
		// The cascade-delete removed the old chat's branches; the new chat has a
		// fresh default branch. Assert the new branch is a child of the NEW
		// chatId (not the cleared one) and is NOT the old branch id (clear
		// must not resurrect the cleared chat's branch under a new chat).
		const newChatId = r.activeChat.id;
		expect(r.activeBranch.chatId).toBe(newChatId);
		expect(r.activeBranch.id).not.toBe(oldBranchId);
		expect(r.branches.every((b) => b.chatId === newChatId)).toBe(true);
		expect(r.activeChat.activeBranchId).toBe(r.activeBranch.id);
	});
});
