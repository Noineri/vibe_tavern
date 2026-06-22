/**
 * TL-A1 — GET /api/chats/:chatId/traces (lazy-loaded trace history).
 *
 * Tests the runtime + store layer (the route is a 3-line passthrough over
 * query params). Pins:
 *   - listPromptTraces returns the full history with no filter
 *   - branchId filter scopes to one branch (server-side)
 *   - messageId filter scopes to one message (server-side) — the new store param
 *
 * Modeled on session-runtime-builders.test.ts' createTestRuntime helper.
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
	chatId: ChatId;
	branchId: string;
	stores: Awaited<ReturnType<typeof createRuntimeStore>>;
	cleanup: () => Promise<void>;
}> {
	const tmpDir = resolve(tmpdir(), "vt-tl-a1-" + crypto.randomUUID().slice(0, 8));
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
	const chat = await stores.chats.getById(created.activeChatId);
	return {
		runtime,
		chatId: created.activeChatId,
		branchId: chat!.activeBranchId,
		stores,
		cleanup: async () => {
			try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
		},
	};
}

describe("TL-A1 — listPromptTraces (lazy-loaded history)", () => {
	let env: Awaited<ReturnType<typeof createTestRuntime>>;
	afterAll(async () => { await env.cleanup(); });

	it("returns the full history with no filter, newest first", async () => {
		env = await createTestRuntime();
		const { runtime, chatId, branchId, stores } = env;

		const msg0 = await stores.messages.addMessage({
			chatId, branchId, role: "user", authorType: "user", content: "M0",
		});
		const msg1 = await stores.messages.addMessage({
			chatId, branchId, role: "assistant", authorType: "assistant", content: "M1",
		});

		// createFromScratch already seeded one greeting trace; snapshot the
		// pre-existing count so the assertions are robust to that seed.
		const beforeCount = (await runtime.listPromptTraces(chatId)).length;

		await stores.traces.saveTrace(traceSeed(chatId, branchId, msg0.id, "T0a"));
		await stores.traces.saveTrace(traceSeed(chatId, branchId, msg0.id, "T0b"));
		await stores.traces.saveTrace(traceSeed(chatId, branchId, msg1.id, "T1"));

		const all = await runtime.listPromptTraces(chatId);
		expect(all.length).toBe(beforeCount + 3);
		// getTracesByChat orders by createdAt DESC — T1 (added last) is newest.
		expect(all[0].model).toBe("model-T1");
		expect(all.map((t) => t.model)).toContain("model-T0a");
		expect(all.map((t) => t.model)).toContain("model-T0b");
	});

	it("scopes to a branchId server-side", async () => {
		const { runtime, chatId, branchId, stores } = env;

		// Fork to create a second branch; its traces (none yet) should be empty.
		const forked = await stores.chats.forkBranch(chatId, (await stores.messages.getMessages(branchId))[0].id);

		const forkedMsgs = await stores.messages.getMessages(forked.id);
		// Wave 0 copied the 1 message that exists at the fork point, but its
		// traces copy too — so the fork is NOT empty here.
		const forkTraces = await runtime.listPromptTraces(chatId, { branchId: forked.id });
		expect(forkTraces.every((t) => t.branchId === forked.id)).toBe(true);
		expect(forkedMsgs.length).toBeGreaterThan(0);
	});

	it("scopes to a messageId server-side (the new store param)", async () => {
		const { runtime, chatId, branchId, stores } = env;
		const msgs = await stores.messages.getMessages(branchId);
		// msgs[1] is the user message we added two traces for (msgs[0] is the greeting).
		const msg0 = msgs[1];

		const byMessage = await runtime.listPromptTraces(chatId, { messageId: msg0.id });
		// Every returned trace belongs to that message — both of its traces.
		expect(byMessage.every((t) => t.messageId === msg0.id)).toBe(true);
		expect(byMessage).toHaveLength(2);
	});

	it("combines branchId + messageId filters", async () => {
		const { runtime, chatId, branchId, stores } = env;
		const msgs = await stores.messages.getMessages(branchId);
		const msg0 = msgs[1];

		const filtered = await runtime.listPromptTraces(chatId, {
			branchId,
			messageId: msg0.id,
		});
		expect(filtered).toHaveLength(2);
		expect(filtered.every((t) => t.branchId === branchId && t.messageId === msg0.id)).toBe(true);
	});

	it("returns DTO-shaped records (branded ids, parsed layers)", async () => {
		const { runtime, chatId } = env;
		const all = await runtime.listPromptTraces(chatId);
		// Find a trace we authored (the seeded greeting trace has different layers).
		const authored = all.find((t) => t.model.startsWith("model-T"))!;
		expect(authored.layers).toEqual([{ layer: "T1" }]);
		expect(typeof authored.id).toBe("string");
		expect(authored.latencyMs).toBe(100);
		expect(authored.tokenAccounting).toEqual({ total: 1 });
	});
});

function traceSeed(chatId: string, branchId: string, messageId: string, tag: string) {
	return {
		chatId,
		branchId,
		messageId,
		model: `model-${tag}`,
		presetName: `preset-${tag}`,
		assembledLayers: [{ layer: tag }],
		tokenAccounting: { total: 1 },
		activatedLoreEntries: [tag],
		activatedLoreDetail: [],
		retrievedMemories: [],
		scriptInjections: [],
		latencyMs: 100,
		prefill: `prefill-${tag}`,
		compactionSummary: null,
		sentConfig: null,
	};
}
