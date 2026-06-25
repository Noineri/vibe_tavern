import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { ChatId } from "@vibe-tavern/domain";

/**
 * End-to-end characterization for the message-meta PRESET bug.
 *
 * The prompt preset used to generate a reply was recorded in the per-message
 * meta (the footer: время · токены · модель · пресет) ONLY when the reply came
 * through the generation queue (override.promptPresetId → addVariant). The
 * ordinary send / continue paths went through appendAssistantReply → addMessage,
 * which wrote modelId to the selected variant but never presetId — so those
 * replies showed the model but no preset.
 *
 * The fix carries the fully-resolved preset id (override → chat → global
 * default) out of assembly in the prompt-trace draft, and appendAssistantReply
 * records it on the selected variant. This test drives the SEND path
 * (prepareLiveTurn → appendAssistantReply) and asserts the preset lands on the
 * reply's variant — the exact field the footer reads.
 */

async function createTestRuntime() {
	const tmpDir = resolve(tmpdir(), "vt-preset-meta-" + crypto.randomUUID().slice(0, 8));
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
		chatId: created.activeChatId as ChatId,
		stores,
		cleanup: async () => {
			try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
		},
	};
}

describe("message meta — preset recorded on every reply path", () => {
	let runtime: SessionRuntime;
	let chatId: ChatId;
	let stores: Awaited<ReturnType<typeof createRuntimeStore>>;
	let cleanup: () => Promise<void>;

	afterAll(async () => { await cleanup(); });

	it("send path (prepareLiveTurn → appendAssistantReply) records the resolved preset on the reply variant", async () => {
		const ctx = await createTestRuntime();
		runtime = ctx.runtime;
		chatId = ctx.chatId;
		stores = ctx.stores;
		cleanup = ctx.cleanup;

		const chat = (await stores.chats.getById(chatId))!;
		const expectedPresetId = chat.promptPresetId;
		expect(expectedPresetId).toBeTruthy();

		// Send path: append a user message + assemble (sets the pending draft
		// carrying the resolved preset id), then append the assistant reply.
		await runtime.chatRuntime.prepareLiveTurn(chatId, "Hello!", "test-model");
		const response = await runtime.chatRuntime.appendAssistantReply(chatId, "Hi there!", 42);

		// The reply is the last assistant message.
		const reply = response.messages[response.messages.length - 1];
		expect(reply).toBeTruthy();
		expect(reply.role).toBe("assistant");

		const variants = await stores.messages.getVariants(reply.id);
		const selected = variants.find((v) => v.isSelected === 1 || v.variantIndex === 0)!;
		expect(selected.modelId).toBe("test-model");
		// The fix: presetId is now recorded on the send path (was null before).
		expect(selected.presetId).toBe(expectedPresetId);
	});
});
