import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { eq } from "drizzle-orm";
import * as schema from "../src/db-schema.js";
import { ChatStore } from "../src/stores/chat-store.js";
import { MessageStore } from "../src/stores/message-store.js";
import { PromptTraceStore, type SaveTraceData } from "../src/stores/prompt-trace-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

const FIXED_NOW = "2025-05-04T12:00:00.000Z";

let clockTick = 0;
const testClock: StoreClock = {
	now() {
		clockTick++;
		return new Date(Date.parse(FIXED_NOW) + clockTick).toISOString();
	},
};

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
	next(prefix: string): string {
		const n = (idCounters.get(prefix) ?? 0) + 1;
		idCounters.set(prefix, n);
		return `${prefix}_test_${String(n).padStart(4, "0")}`;
	},
};

// Minimal valid SaveTraceData seed; JSON columns are intentionally simple —
// the fork copy must preserve them verbatim, so we assert exact equality later.
function makeTraceData(
	chatId: string,
	branchId: string,
	messageId: string,
	tag: string,
): SaveTraceData {
	return {
		chatId,
		branchId,
		messageId,
		model: `model-${tag}`,
		presetName: `preset-${tag}`,
		assembledLayers: [{ layer: tag }],
		tokenAccounting: { total: 1 },
		finalPayload: { payloadTag: tag },
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ChatStore.forkBranch — trace inheritance (Defect C)", () => {
	let db: Awaited<ReturnType<typeof createDb>>;
	let store: ChatStore;
	let messageStore: MessageStore;
	let traceStore: PromptTraceStore;

	beforeEach(async () => {
		clockTick = 0;
		idCounters = new Map();
		db = await createDb(":memory:");

		store = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
		messageStore = new MessageStore(db, { clock: testClock, idGenerator: testIdGen });
		traceStore = new PromptTraceStore(db, { clock: testClock, idGenerator: testIdGen });

		// Bootstrap minimum rows: character → provider → preset → chat + root branch
		db.insert(schema.characters).values({
			id: "char_1", name: "TestChar", description: "",
			alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
			status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
		}).run();
		db.insert(schema.providerProfiles).values({
			id: "prov_1", name: "TestProvider", providerPreset: "openai",
			endpoint: "http://localhost", maxTokens: 500,
			temperature: 1.0, topP: 1.0, topK: 0, minP: 0,
			frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1.0,
			reasoningEffort: "auto", streamResponse: 1, isActive: 1,
			createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
		}).run();
		db.insert(schema.promptPresets).values({
			id: "preset_1", name: "Default", systemPrompt: "",
			postHistoryInstructions: "", assistantPrefix: "", authorsNote: "",
			authorsNoteDepth: 4, summaryPrompt: "", toolsPrompt: "",
			createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
		}).run();
		db.insert(schema.chats).values({
			id: "chat_1", characterId: "char_1", personaId: null,
			activeBranchId: "brnch_1", promptPresetId: "preset_1",
			title: "Test chat", summary: "", messageHistoryLimit: 0,
			lastAccessedAt: FIXED_NOW,
			status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
		}).run();
		db.insert(schema.chatBranches).values({
			id: "brnch_1", chatId: "chat_1", parentBranchId: null,
			forkedFromMessageId: null, label: "main", createdAt: FIXED_NOW,
		}).run();
	});

	test("fork copies prompt_traces for the forked message range only", async () => {
		// Seed 3 messages (positions 0,1,2) with one trace each.
		const msg0 = await messageStore.addMessage({
			chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "M0",
		});
		const msg1 = await messageStore.addMessage({
			chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", content: "M1",
		});
		const msg2 = await messageStore.addMessage({
			chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", content: "M2",
		});

		await traceStore.saveTrace(makeTraceData("chat_1", "brnch_1", msg0.id, "T0"));
		await traceStore.saveTrace(makeTraceData("chat_1", "brnch_1", msg1.id, "T1"));
		await traceStore.saveTrace(makeTraceData("chat_1", "brnch_1", msg2.id, "T2"));

		// Fork from msg1 (position 1): messages 0 and 1 are copied, message 2 is not.
		const forkedBranch = await store.forkBranch("chat_1", msg1.id, "fork test");

		// Fork branch is a different branch row.
		expect(forkedBranch.id).not.toBe("brnch_1");
		expect(forkedBranch.parentBranchId).toBe("brnch_1");

		// Fork has exactly 2 traces (for the 2 copied messages), not 3.
		const forkTraces = await traceStore.getTracesByChat("chat_1", forkedBranch.id);
		expect(forkTraces).toHaveLength(2);

		// Every forked trace belongs to the new branch and references a fork message.
		const forkMessageIds = new Set((await messageStore.getMessages(forkedBranch.id)).map((m) => m.id));
		for (const t of forkTraces) {
			expect(t.branchId).toBe(forkedBranch.id);
			expect(forkMessageIds.has(t.messageId)).toBe(true);
			// No forked trace references a source-branch messageId.
			expect(t.messageId).not.toBe(msg0.id);
			expect(t.messageId).not.toBe(msg1.id);
			expect(t.messageId).not.toBe(msg2.id);
			// New independent trace ids (not the source ids).
			expect(t.id).not.toContain("brnch_1");
		}

		// Trace content preserved verbatim (both tags T0 and T1, not T2).
		const forkTags = forkTraces.map((t) => t.model).sort();
		expect(forkTags).toEqual(["model-T0", "model-T1"]);
		const t0Copy = forkTraces.find((t) => t.model === "model-T0")!;
		expect(t0Copy.presetName).toBe("preset-T0");
		expect(t0Copy.prefill).toBe("prefill-T0");
		expect(t0Copy.assembledLayers).toEqual([{ layer: "T0" }]);
		expect(t0Copy.activatedLoreEntries).toEqual(["T0"]);
		expect(t0Copy.latencyMs).toBe(100);

		// Source branch is unchanged: still 3 traces, still on brnch_1.
		const sourceTraces = await traceStore.getTracesByChat("chat_1", "brnch_1");
		expect(sourceTraces).toHaveLength(3);
		for (const t of sourceTraces) {
			expect(t.branchId).toBe("brnch_1");
		}
	});

	test("fork carries no traces when the source branch has none", async () => {
		const msg0 = await messageStore.addMessage({
			chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "M0",
		});

		// No traces seeded.
		const forkedBranch = await store.forkBranch("chat_1", msg0.id, "empty fork");

		const forkTraces = await traceStore.getTracesByChat("chat_1", forkedBranch.id);
		expect(forkTraces).toEqual([]);
	});

	test("fork preserves trace createdAt ordering relative to the parent", async () => {
		const msg0 = await messageStore.addMessage({
			chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "M0",
		});
		const msg1 = await messageStore.addMessage({
			chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", content: "M1",
		});

		const tr0 = await traceStore.saveTrace(makeTraceData("chat_1", "brnch_1", msg0.id, "T0"));
		const tr1 = await traceStore.saveTrace(makeTraceData("chat_1", "brnch_1", msg1.id, "T1"));

		const forkedBranch = await store.forkBranch("chat_1", msg1.id, "ordering fork");

		const forkTraces = await traceStore.getTracesByChat("chat_1", forkedBranch.id);
		expect(forkTraces).toHaveLength(2);

		// getTracesByChat orders by createdAt DESC; find the copy of each by model tag.
		const f0 = forkTraces.find((t) => t.model === "model-T0")!;
		const f1 = forkTraces.find((t) => t.model === "model-T1")!;
		// createdAt is preserved verbatim, so relative order matches the source.
		expect(f0.createdAt).toBe(tr0.createdAt);
		expect(f1.createdAt).toBe(tr1.createdAt);
		// T1 was saved after T0, so it sorts first (DESC).
		expect(forkTraces[0].model).toBe("model-T1");
		expect(forkTraces[1].model).toBe("model-T0");
	});

	test("fork with multiple traces on one message copies all of them", async () => {
		// One message carries two traces (e.g. multiple generations for the same variant).
		const msg0 = await messageStore.addMessage({
			chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", content: "M0",
		});
		const msg1 = await messageStore.addMessage({
			chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", content: "M1",
		});

		await traceStore.saveTrace(makeTraceData("chat_1", "brnch_1", msg0.id, "T0a"));
		await traceStore.saveTrace(makeTraceData("chat_1", "brnch_1", msg0.id, "T0b"));
		await traceStore.saveTrace(makeTraceData("chat_1", "brnch_1", msg1.id, "T1"));

		// Fork from msg1: both msg0 traces + the msg1 trace are in range.
		const forkedBranch = await store.forkBranch("chat_1", msg1.id, "multi fork");

		const forkTraces = await traceStore.getTracesByChat("chat_1", forkedBranch.id);
		expect(forkTraces).toHaveLength(3);
		expect(forkTraces.map((t) => t.model).sort()).toEqual(
			["model-T0a", "model-T0b", "model-T1"],
		);
	});
});
