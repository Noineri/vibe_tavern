import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { ChatId } from "@vibe-tavern/domain";

/**
 * Characterization for co-author message meta: the model AND the module name
 * are baked on the co-author reply variant at generation time.
 *
 * `model_id` is a plain-text no-FK column (db-schema) — unlike the old
 * `preset_id`, it was NEVER an FK, so it has always been a baked snapshot.
 * This test pins the full co-author boundary that produces it:
 *   prepareLiveTurn (dispatches to `assembleCoauthorPrompt` by chat.mode)
 *     → draft.model + draft.presetName (the resolved module name)
 *     → appendAssistantReply writes them onto the variant.
 *
 * The module NAME is baked into the same `preset_name` field the preset badge
 * uses (a co-author variant has no preset), and `coauthor_module_id` is its own
 * text column — so the model + coauthor-module badges render from the variant
 * alone, with no live lookup and no FK. The RP equivalent lives in
 * message-preset-meta.test.ts.
 */

async function createTestRuntime() {
	const tmpDir = resolve(tmpdir(), "vt-coauthor-meta-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	const created = await runtime.character.createFromScratch({
		name: "CoauthorProbe",
		description: "a probe character",
		firstMessage: "Let's begin.",
	});
	const seedChat = await stores.chats.getById(created.activeChatId);
	const characterId = seedChat!.characterId;
	// A co-author chat: createChatForCharacter(id, "coauthor") seeds the
	// active module's opening turn and sets chat.mode = "coauthor".
	const coChat = await runtime.chatLifecycle.createChatForCharacter(characterId, "coauthor");
	return {
		runtime,
		chatId: coChat.activeChat.id as ChatId,
		stores,
		cleanup: async () => {
			try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
		},
	};
}

describe("message meta — co-author reply bakes model + module name on the variant", () => {
	let env: Awaited<ReturnType<typeof createTestRuntime>>;
	afterAll(async () => {
		if (env) await env.cleanup();
	});

	it("coauthor send path records modelId, presetName (module name) and coauthorModuleId on the reply variant", async () => {
		env = await createTestRuntime();
		const { runtime, chatId, stores } = env;

		// prepareLiveTurn dispatches to the co-author assembler (chat.mode ===
		// "coauthor"), which builds a draft carrying the model + the resolved
		// module name. The chat has no module set → resolves to the default seed
		// module ("Character Workshop", id "default").
		await runtime.chatRuntime.prepareLiveTurn(chatId, "Help me draft a scene.", "coauthor-test-model");
		const appended = await runtime.chatRuntime.appendAssistantReply(chatId, "Here's a draft…", 42);
		const response = appended.response;

		// The reply is the last assistant message.
		const reply = response.messages[response.messages.length - 1];
		expect(reply).toBeTruthy();
		expect(reply.role).toBe("assistant");

		const variants = await stores.messages.getVariants(reply.id);
		const selected = variants.find((v) => v.isSelected === 1 || v.variantIndex === 0)!;
		expect(selected).toBeTruthy();

		// model_id: plain-text no-FK column, baked from draft.model. Never an
		// FK (unlike the old preset_id) — always a snapshot.
		expect(selected.modelId).toBe("coauthor-test-model");
		// preset_name: carries the module NAME for co-author turns (the default
		// seed module is "Character Workshop"), not a preset. Same field the
		// preset badge reads; the coauthor-module badge renders this name.
		expect(selected.presetName).toBe("Character Workshop");
		// coauthor_module_id: its own text column, drives the coauthor-module
		// badge visibility.
		expect(selected.coauthorModuleId).toBe("default");
	});
});
