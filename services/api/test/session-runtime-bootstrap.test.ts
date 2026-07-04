/**
 * F-7 (SF-7) — the bootstrap chat-picking default. `getBootstrapState` must
 * boot into the most-recent NON-coauthor chat so a reload never drops the user
 * into the co-author surface. The pure helper `pickBootstrapChatId` carries
 * that logic; these tests pin it independently of the full SessionRuntime.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { pickBootstrapChatId } from "../src/runtime/session/session-runtime.js";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";

const coauthor = new Set(["co-1", "co-2"]);

describe("pickBootstrapChatId", () => {
	test("empty order → null (first run, no chats)", () => {
		expect(pickBootstrapChatId([], (id) => coauthor.has(id))).toBeNull();
	});

	test("F-7: skips a more-recent coauthor chat and boots into the RP chat", () => {
		// chatOrder.items is recency-desc: coauthor chat is most recent.
		const items = ["co-1", "rp-1"];
		expect(pickBootstrapChatId(items, (id) => coauthor.has(id))).toBe("rp-1");
	});

	test("F-7: picks the most-recent RP chat when several RP chats precede a coauthor one", () => {
		const items = ["co-1", "rp-new", "rp-old"];
		expect(pickBootstrapChatId(items, (id) => coauthor.has(id))).toBe("rp-new");
	});

	test("boots into the first chat when it is already RP", () => {
		const items = ["rp-1", "co-1"];
		expect(pickBootstrapChatId(items, (id) => coauthor.has(id))).toBe("rp-1");
	});

	test("falls back to the overall most-recent chat when only coauthor chats exist", () => {
		const items = ["co-2", "co-1"];
		expect(pickBootstrapChatId(items, (id) => coauthor.has(id))).toBe("co-2");
	});

	test("preserves the id brand (returns the same element type it receives)", () => {
		// Brands survive: a ChatId[] in yields a ChatId | null out.
		const branded = ["co-1", "rp-1"] as const;
		const result = pickBootstrapChatId(branded, (id) => coauthor.has(id));
		expect(result).toBe("rp-1");
	});
});

describe("getBootstrapState wiring (F-7)", () => {
	/** Spins up a real SessionRuntime against an isolated temp DB. */
	async function createRuntime() {
		const tmpDir = resolve(tmpdir(), "vt-f7-" + crypto.randomUUID().slice(0, 8));
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
		const characterId = created.snapshot.activeChat?.characterId
			?? created.snapshot.character?.id;
		if (!characterId) throw new Error("seed character had no characterId");
		return {
			runtime,
			rpChatId: created.activeChatId,
			characterId,
			cleanup: async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} },
		};
	}

	test("a reload boots into the RP chat even when the co-author chat is more recent", async () => {
		const ctx = await createRuntime();
		try {
			// Create a co-author chat for the same character AFTER the RP chat,
			// so it becomes the most-recent entry in chatOrder.items.
			const coauthor = await ctx.runtime.chatLifecycle.createChatForCharacter(ctx.characterId, "coauthor");
			const coauthorChatId = coauthor.activeChat?.id;
			expect(coauthorChatId).toBeTruthy();
			expect(coauthorChatId).not.toBe(ctx.rpChatId);

			const boot = await ctx.runtime.getBootstrapState();
			expect(boot.initialChatId).toBe(ctx.rpChatId);
		} finally {
			await ctx.cleanup();
		}
	});
});
