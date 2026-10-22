import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ChatId } from "@vibe-tavern/domain";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";

/**
 * SC-23b characterization: every prompt trace names the swipe it produced.
 *
 * The ordinary send path links the reply's selected variant; the swipe
 * (regenerate) path links the newly added variant; the greeting trace stays
 * null (no model wrote it). All three ride the real session runtime and the
 * real trace store — no store doubles.
 */
async function createTestRuntime() {
	const tmpDir = resolve(tmpdir(), "vt-trace-variant-" + crypto.randomUUID().slice(0, 8));
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
			try {
				await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			} catch (error) {
				if ((error as { code?: unknown }).code !== "EBUSY") throw error;
			}
		},
	};
}

describe("prompt traces link the swipe they produced (SC-23b)", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterAll(async () => { await Promise.all(cleanups.map(cleanup => cleanup())); });

	it("send path links the reply trace to the reply's selected variant", async () => {
		const ctx = await createTestRuntime();
		const { runtime, chatId, stores } = ctx;
		cleanups.push(ctx.cleanup);

		await runtime.chatRuntime.prepareLiveTurn(chatId, "Hello!", "test-model");
		const appended = await runtime.chatRuntime.appendAssistantReply(chatId, "Hi there!", 42);
		const replyId = appended.messageId;

		const selected = await stores.messages.getSelectedVariant(replyId);
		expect(selected).not.toBeNull();
		expect(selected!.modelId).toBe("test-model");

		const traces = await stores.traces.getTracesByChat(chatId, undefined, replyId);
		expect(traces).toHaveLength(1);
		expect(traces[0]!.variantId).toBe(selected!.id);
	});

	it("swipe path links the new trace to the newly added variant", async () => {
		const ctx = await createTestRuntime();
		const { runtime, chatId, stores } = ctx;
		cleanups.push(ctx.cleanup);

		// The greeting message is the swipe target; the regenerate path
		// assembles with the target excluded, which parks the pending trace.
		const snapshot = await runtime.getSnapshot(chatId);
		const greeting = snapshot.messages.find((m) => m.role === "assistant")!;
		expect(greeting).toBeTruthy();

		await runtime.chatRuntime.assemblePromptPreview(chatId, { model: "test-model", excludeMessageId: greeting.id });
		await runtime.chatRuntime.appendMessageVariant(chatId, greeting.id, { content: "Regenerated opening", latencyMs: 7 });

		const variants = await stores.messages.getVariants(greeting.id);
		expect(variants.length).toBe(2);
		const added = variants.find((v) => v.variantIndex === 1)!;
		expect(added.modelId).toBe("test-model");

		const traces = await stores.traces.getTracesByChat(chatId, undefined, greeting.id);
		// Two traces now: the greeting trace (no model — stays null) and the
		// swipe trace (links the variant it just produced).
		expect(traces).toHaveLength(2);
		const swipeTrace = traces.find((t) => t.model === "test-model")!;
		expect(swipeTrace).toBeTruthy();
		expect(swipeTrace.variantId).toBe(added.id);
		const greetingTrace = traces.find((t) => t.model !== "test-model")!;
		expect(greetingTrace.variantId).toBeNull();
	});

	it("greeting trace stays null (no model wrote it)", async () => {
		const ctx = await createTestRuntime();
		const { runtime, chatId, stores } = ctx;
		cleanups.push(ctx.cleanup);

		const snapshot = await runtime.getSnapshot(chatId);
		const greeting = snapshot.messages.find((m) => m.role === "assistant")!;
		const traces = await stores.traces.getTracesByChat(chatId, undefined, greeting.id);
		expect(traces.length).toBeGreaterThanOrEqual(1);
		for (const trace of traces) {
			expect(trace.variantId).toBeNull();
		}
	});
});
