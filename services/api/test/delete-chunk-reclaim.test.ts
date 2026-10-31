import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { scheduleBootChunkSweep } from "../src/server/server-runtime.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ChatBranchId, ChatId } from "@vibe-tavern/domain";

/**
 * LONG_CHAT_PERFORMANCE_REPORT step 8 — the three delete call sites
 * (`deleteMessage` / `deleteBranch` / `deleteChat`) must stop awaiting the
 * GLOBAL orphan-chunk sweep (a whole-DB anti-join that froze the event loop
 * on the owner's 1.09 GB live DB) and instead run the scoped reclamation on
 * exactly the traces that died. Delete responses stay byte-identical.
 */

/** Spins up a real SessionRuntime against an isolated temp DB and seeds one chat
 *  (mirror of session-runtime-builders.test.ts's createTestRuntime). */
async function createTestRuntime(): Promise<{
	runtime: SessionRuntime;
	chatId: ChatId;
	stores: StoreContainer;
	cleanup: () => Promise<void>;
}> {
	const tmpDir = resolve(tmpdir(), "vt-lcpr8-" + crypto.randomUUID().slice(0, 8));
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
		stores,
		cleanup: async () => {
			try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
		},
	};
}

/** Minimal traced send bound to one message (small payloads — the trace ROWS
 *  are what the scoped reclamation keys on, not their chunks). */
function traceSeed(chatId: string, branchId: string, messageId: string, tag: string) {
	return {
		chatId,
		branchId,
		messageId,
		model: `model-${tag}`,
		presetName: "Default",
		assembledLayers: [{ layer: tag }],
		tokenAccounting: { total: 1 },
		activatedLoreEntries: [tag],
		activatedLoreDetail: [],
		retrievedMemories: [],
		scriptInjections: [],
		latencyMs: 100,
		prefill: null,
		compactionSummary: null,
		sentConfig: null,
		providerResponse: null,
	};
}

interface DeleteScenarioLog {
	sweepCalls: number;
	reclaimCalls: string[][];
	deletedMessageResponse: unknown;
	deletedBranchResponse: unknown;
	deletedChatResponse: unknown;
	/** The deleted message's own trace ids — what deleteMessage must pass. */
	expectedMessageTraceIds: string[];
	/** The fork branch's copied trace ids — what deleteBranch must pass. */
	expectedForkTraceIds: string[];
	/** The root branch's surviving trace ids — what deleteChat must pass. */
	expectedRootTraceIds: string[];
}

/** Seeds a two-branch chat with traced messages, runs the three deletes, and
 *  records what the trace store was asked to do. Instance-local method
 *  patches on the test-scoped store container — no process-global state. */
async function runDeleteScenario(): Promise<DeleteScenarioLog> {
	const ctx = await createTestRuntime();
	const { runtime, chatId, stores } = ctx;
	try {
		const snap = await runtime.getSnapshot(chatId);
		const rootBranchId = snap.activeBranch!.id as ChatBranchId;
		const greetingId = snap.messages[0]!.id;
		const m1 = await stores.messages.addMessage({
			chatId, branchId: rootBranchId, role: "user", authorType: "user", content: "lcpr8 m1",
		});
		await stores.traces.saveTrace(traceSeed(chatId, rootBranchId, greetingId, "greeting"));
		await stores.traces.saveTrace(traceSeed(chatId, rootBranchId, m1.id, "m1"));

		// Fork from the latest message: the fork copies both traces onto its own
		// message copies (chat-store-fork-trace-copy.ts) and activates itself.
		await runtime.chatRuntime.forkBranch(chatId);
		const forkedBranchId = (await runtime.getSnapshot(chatId)).activeBranch!.id as ChatBranchId;
		const m2 = await stores.messages.addMessage({
			chatId, branchId: forkedBranchId, role: "user", authorType: "user", content: "lcpr8 m2",
		});
		const m2Trace = await stores.traces.saveTrace(traceSeed(chatId, forkedBranchId, m2.id, "m2"));
		const forkTraceIds = (await stores.traces.getTracesByChat(chatId, forkedBranchId))
			.map((t) => t.id).filter((id) => id !== m2Trace.id).sort();
		const remainingRootTraceIds = (await stores.traces.getTracesByChat(chatId, rootBranchId))
			.map((t) => t.id).sort();

		const log: DeleteScenarioLog = {
			sweepCalls: 0,
			reclaimCalls: [],
			deletedMessageResponse: null,
			deletedBranchResponse: null,
			deletedChatResponse: null,
		};
		const sweep = stores.traces.sweepOrphanedChunks.bind(stores.traces);
		const reclaim = stores.traces.reclaimChunksForTraces.bind(stores.traces);
		stores.traces.sweepOrphanedChunks = async () => { log.sweepCalls++; };
		stores.traces.reclaimChunksForTraces = async (traceIds: readonly string[]) => {
			log.reclaimCalls.push([...traceIds]);
			return await reclaim(traceIds);
		};

		log.deletedMessageResponse = await runtime.chatRuntime.deleteMessage(chatId, m2.id);
		log.deletedBranchResponse = await runtime.chatRuntime.deleteBranch(chatId, forkedBranchId);
		log.deletedChatResponse = await runtime.chatRuntime.deleteChat(chatId);

		log.expectedMessageTraceIds = [m2Trace.id];
		log.expectedForkTraceIds = forkTraceIds;
		log.expectedRootTraceIds = remainingRootTraceIds;
		return log;
	} finally {
		await ctx.cleanup();
	}
}

describe("LONG_CHAT_PERFORMANCE_REPORT step 8 — scoped chunk reclamation", () => {
	afterAll(() => {});

	it("message/branch/chat deletes no longer call the GLOBAL sweep (red on HEAD)", async () => {
		const log = await runDeleteScenario();
		expect(log.sweepCalls).toBe(0);
	});

	it("each delete passes exactly its dying traces to the scoped reclamation", async () => {
		const log = await runDeleteScenario();
		expect(log.reclaimCalls).toHaveLength(3);
		// deleteMessage: only the deleted message's traces die (FK cascade on
		// prompt_traces.message_id) — the fork copies live on other messages.
		expect(log.reclaimCalls[0]).toEqual(log.expectedMessageTraceIds);
		// deleteBranch: the branch's own traces (the fork's copies), captured
		// before the delete — their ids are gone afterwards.
		expect(log.reclaimCalls[1]).toEqual(log.expectedForkTraceIds);
		// deleteChat: whatever traces of the chat were still alive (the root
		// branch's two; the fork died with its branch one step earlier).
		expect(log.reclaimCalls[2]).toEqual(log.expectedRootTraceIds);
	});

	it("delete responses stay byte-identical to the same builders' fresh output", async () => {
		const ctx = await createTestRuntime();
		const { runtime, chatId, stores } = ctx;
		try {
			const snap = await runtime.getSnapshot(chatId);
			const rootBranchId = snap.activeBranch!.id as ChatBranchId;
			const m1 = await stores.messages.addMessage({
				chatId, branchId: rootBranchId, role: "user", authorType: "user", content: "lcpr8 m1",
			});
			await runtime.chatRuntime.forkBranch(chatId);
			const forkedBranchId = (await runtime.getSnapshot(chatId)).activeBranch!.id as ChatBranchId;

			const deletedMessage = await runtime.chatRuntime.deleteMessage(chatId, m1.id);
			expect(JSON.stringify(deletedMessage))
				.toBe(JSON.stringify(await runtime.buildMessageResponse(chatId, { summaries: true })));

			const deletedBranch = await runtime.chatRuntime.deleteBranch(chatId, forkedBranchId);
			expect(JSON.stringify(deletedBranch))
				.toBe(JSON.stringify(await runtime.buildBranchResponse(chatId)));

			const deletedChat = await runtime.chatRuntime.deleteChat(chatId);
			expect(JSON.stringify(deletedChat))
				.toBe(JSON.stringify(await runtime.buildChatListResponse()));
		} finally {
			await ctx.cleanup();
		}
	});

	it("scheduleBootChunkSweep never awaits the sweep and survives its failure (startup wiring contract)", async () => {
		// The avatar/token-backfill wiring contract: a boot pass must never
		// delay readiness and never throw into startup.
		const neverResolves = { traces: { sweepOrphanedChunks: () => new Promise<void>(() => {}) } };
		expect(scheduleBootChunkSweep(neverResolves)).toBeUndefined();

		const errors: unknown[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => { errors.push(args); };
		try {
			const rejecting = { traces: { sweepOrphanedChunks: () => Promise.reject(new Error("boom")) } };
			expect(scheduleBootChunkSweep(rejecting)).toBeUndefined();
			// The rejection is caught and logged by the wrapper, not unhandled.
			await new Promise((resolve) => setImmediate(resolve));
			expect(errors.length).toBe(1);
		} finally {
			console.error = originalError;
		}
	});
});
