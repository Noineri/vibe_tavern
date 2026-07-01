/**
 * CA-4 — co-author chat API: create + list per character.
 *
 * Tests the SessionRuntime layer (the routes are 3-line passthroughs). Pins:
 *   - createChatForCharacter(id, "coauthor") persists mode='coauthor'
 *   - a regular createChatForCharacter(id) (no mode) persists mode='rp'
 *   - listCoauthorChats(characterId) returns ONLY co-author chats for that character
 *   - co-author chats are invisible to a plain character switch (they live in chats,
 *     mode-scoped, not a separate table) — isolation by mode.
 *
 * Modeled on list-prompt-traces.test.ts' createTestRuntime helper. Sending a
 * message is NOT tested here — the stub strategy throws NOT_IMPLEMENTED until
 * CA-5; that's covered by chat-mode-strategy.test.ts.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { ChatId } from "@vibe-tavern/domain";

async function createTestRuntime(): Promise<{
	runtime: SessionRuntime;
	characterId: string;
	stores: Awaited<ReturnType<typeof createRuntimeStore>>;
	cleanup: () => Promise<void>;
}> {
	const tmpDir = resolve(tmpdir(), "vt-ca4-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	const created = await runtime.character.createFromScratch({
		name: "CoAuthorProbe",
		description: "a probe character",
		firstMessage: "Hi!",
	});
	// createFromScratch seeds the first chat already; pull the characterId
	// from that chat row (the snapshot's character field carries it too).
	const seedChat = await stores.chats.getById(created.activeChatId);
	return {
		runtime,
		characterId: seedChat!.characterId,
		stores,
		cleanup: async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} },
	};
}

describe("Co-Author chat API (CA-4)", () => {
	let env: Awaited<ReturnType<typeof createTestRuntime>>;
	afterAll(async () => { if (env) await env.cleanup(); });

	it("createChatForCharacter persists mode; listCoauthorChats scopes by character+mode", async () => {
		env = await createTestRuntime();

		// createChatForCharacter(id, "coauthor") persists mode='coauthor'.
		const coCreated = await env.runtime.chatLifecycle.createChatForCharacter(env.characterId, "coauthor");
		expect(coCreated.activeChat.mode).toBe("coauthor");
		const coChat = await env.stores.chats.getById(coCreated.activeChat.id as ChatId);
		expect(coChat?.mode).toBe("coauthor");

		// createChatForCharacter(id) (no mode) defaults to 'rp'.
		const rpCreated = await env.runtime.chatLifecycle.createChatForCharacter(env.characterId);
		expect(rpCreated.activeChat.mode).toBe("rp");

		// Two more co-author chats for the same character.
		await env.runtime.chatLifecycle.createChatForCharacter(env.characterId, "coauthor");
		await env.runtime.chatLifecycle.createChatForCharacter(env.characterId, "coauthor");

		const coauthor = await env.runtime.listCoauthorChats(env.characterId as never);
		// 1 (first coCreated) + 2 = 3 co-author chats. The rp chat + the seed
		// chat from createFromScratch are excluded.
		expect(coauthor.length).toBe(3);
		expect(coauthor.every((c) => c.characterId === env.characterId)).toBe(true);

		// Each item carries the ChatListItem shape the UI consumes.
		expect(coauthor[0]).toHaveProperty("lastMessageAt");
		expect(coauthor[0]).toHaveProperty("messageCount");
		expect(coauthor[0]).toHaveProperty("title");
	});
});
