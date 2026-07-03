/**
 * CS-29 — co-author chat opening: birth + clear seeding, title, mode preservation.
 *
 * Pins (all at the SessionRuntime layer, real stores + real seed-module assets):
 *   - createChatForCharacter(id, "coauthor") seeds the active module's
 *     openingMessage as the first assistant message, with {{char}} LITERAL
 *     (co-author edits a template, never resolves macros — CS-26).
 *   - the co-author chat does NOT receive the character's RP greeting.
 *   - co-author chat title is "Co-Author · {name}" (visually distinct from RP).
 *   - createChatForCharacter(id) (RP) still seeds the card greeting + RP title.
 *   - clearChat on a co-author chat preserves mode AND re-seeds the opening
 *     (fixes the latent coauthor→rp bug where mode was dropped).
 *   - clearChat preserves a non-default module across clear (seeded opening
 *     matches that module, not the default).
 *   - clearChat on an RP chat still seeds the greeting.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { ChatId } from "@vibe-tavern/domain";

const DEFAULT_OPENING = "I'm ready to help you build {{char}}";
const PROFILE_OPENING = "I'll focus on {{char}}'s profile";
const RP_GREETING = "Hi! RP greeting here.";

async function createTestRuntime() {
	const tmpDir = resolve(tmpdir(), "vt-cs29-" + crypto.randomUUID().slice(0, 8));
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
		firstMessage: RP_GREETING,
	});
	// createFromScratch seeds the first chat already; pull the characterId from it.
	const seedChat = await stores.chats.getById(created.activeChatId);
	const characterId = seedChat!.characterId;
	return {
		runtime,
		characterId,
		stores,
		cleanup: async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} },
	};
}

type Env = Awaited<ReturnType<typeof createTestRuntime>>;

/** Read the assistant message contents of a chat (first assistant turn = seeded opening). */
async function assistantContents(env: Env, chatId: ChatId): Promise<string[]> {
	const chat = await env.stores.chats.getById(chatId);
	if (!chat) throw new Error(`chat ${chatId} not found`);
	const msgs = await env.stores.messages.getMessages(chat.activeBranchId);
	return msgs.filter((m) => m.role === "assistant").map((m) => m.content);
}

describe("Co-Author chat opening (CS-29)", () => {
	let env: Env;
	afterAll(async () => { if (env) await env.cleanup(); });

	it("a co-author chat seeds the default module's openingMessage with {{char}} literal (not the RP greeting)", async () => {
		env = await createTestRuntime();
		const created = await env.runtime.chatLifecycle.createChatForCharacter(env.characterId, "coauthor");
		const chatId = created.activeChat.id as ChatId;

		const assistantMsgs = await assistantContents(env, chatId);
		expect(assistantMsgs.length).toBe(1);
		expect(assistantMsgs[0].startsWith(DEFAULT_OPENING)).toBe(true);
		// {{char}} stays literal (CS-26): NOT resolved to "CoAuthorProbe".
		expect(assistantMsgs[0]).toContain("{{char}}");
		expect(assistantMsgs[0]).not.toContain("CoAuthorProbe");
		// The RP greeting is NOT seeded in co-author mode.
		expect(assistantMsgs[0]).not.toContain("RP greeting");
	});

	it("a co-author chat title is 'Co-Author · {name}' (visually distinct from RP)", async () => {
		const created = await env.runtime.chatLifecycle.createChatForCharacter(env.characterId, "coauthor");
		const chat = await env.stores.chats.getById(created.activeChat.id as ChatId);
		expect(chat?.title).toBe("Co-Author · CoAuthorProbe");
	});

	it("an RP chat still seeds the card greeting and the '{name} chat' title", async () => {
		const created = await env.runtime.chatLifecycle.createChatForCharacter(env.characterId);
		const chatId = created.activeChat.id as ChatId;
		const chat = await env.stores.chats.getById(chatId);

		expect(chat?.mode).toBe("rp");
		expect(chat?.title).toBe("CoAuthorProbe chat");

		const assistantMsgs = await assistantContents(env, chatId);
		expect(assistantMsgs.length).toBe(1);
		expect(assistantMsgs[0]).toBe(RP_GREETING);
	});

	it("clearChat on a co-author chat preserves mode and re-seeds the opening (was the latent coauthor→rp bug)", async () => {
		const created = await env.runtime.chatLifecycle.createChatForCharacter(env.characterId, "coauthor");
		const originalId = created.activeChat.id as ChatId;

		const cleared = await env.runtime.chatLifecycle.clearChat(originalId);
		const newId = cleared.activeChat.id as ChatId;
		expect(newId).not.toBe(originalId);

		const newChat = await env.stores.chats.getById(newId);
		expect(newChat?.mode).toBe("coauthor"); // mode preserved

		// Opening re-seeded.
		const assistantMsgs = await assistantContents(env, newId);
		expect(assistantMsgs.length).toBe(1);
		expect(assistantMsgs[0].startsWith(DEFAULT_OPENING)).toBe(true);

		// Old chat is gone (cascade deletes messages/summaries/memory).
		expect(await env.stores.chats.getById(originalId)).toBeNull();
	});

	it("clearChat preserves a non-default co-author module and seeds ITS opening", async () => {
		const created = await env.runtime.chatLifecycle.createChatForCharacter(env.characterId, "coauthor");
		const originalId = created.activeChat.id as ChatId;

		// Switch to the profile-editor module, then clear.
		await env.runtime.chatLifecycle.setCoauthorModule(originalId, "profile-editor");

		const cleared = await env.runtime.chatLifecycle.clearChat(originalId);
		const newId = cleared.activeChat.id as ChatId;
		const newChat = await env.stores.chats.getById(newId);

		// Module assignment preserved across clear.
		expect(newChat?.coauthorModuleId).toBe("profile-editor");
		// Opening matches the profile-editor module (not the default).
		const assistantMsgs = await assistantContents(env, newId);
		expect(assistantMsgs.length).toBe(1);
		expect(assistantMsgs[0].startsWith(PROFILE_OPENING)).toBe(true);
	});

	it("clearChat on an RP chat stays RP and re-seeds the greeting", async () => {
		const created = await env.runtime.chatLifecycle.createChatForCharacter(env.characterId);
		const originalId = created.activeChat.id as ChatId;

		const cleared = await env.runtime.chatLifecycle.clearChat(originalId);
		const newId = cleared.activeChat.id as ChatId;
		const newChat = await env.stores.chats.getById(newId);
		expect(newChat?.mode).toBe("rp");

		const assistantMsgs = await assistantContents(env, newId);
		expect(assistantMsgs.length).toBe(1);
		expect(assistantMsgs[0]).toBe(RP_GREETING);
	});
});
