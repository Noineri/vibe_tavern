import { describe, test, expect, beforeEach } from "bun:test";
import { createDb, type AppDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { sql } from "drizzle-orm";
import { ChatStore } from "../src/stores/chat-store.js";
import { MessageStore } from "../src/stores/message-store.js";
import { DiceRollStore } from "../src/stores/dice-roll-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// DICE-B12 (Wave B4 unit 3): the branch-fork → bound-Dice lifecycle boundary.
// These tests pin ChatStore.forkBranch sharing ONE synchronous bun:sqlite
// transaction with DiceRollStore.forkCopyRollsInTx so the dice copy is atomic
// with the message/variant/trace copy and rolls back together with it. The
// forkBranch callback being SYNCHRONOUS (not async) is load-bearing — see the
// "Synchronous transaction callbacks" constraint + ASYNC_TRANSACTION_AUDIT
// fix-step 2 (closed here). Only bound rolls (user messages) are cloned;
// pending rolls never move on a fork, and a fork with no dice is a no-op.

// ─── Test helpers ───────────────────────────────────────────────────────────

const FIXED_NOW = "2026-07-21T00:00:00.000Z";

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
		return `${prefix}_b12_${String(n).padStart(4, "0")}`;
	},
};

function rollInput(overrides: Record<string, unknown> = {}) {
	return {
		requestId: "req_default",
		actorType: "persona",
		actorId: "persona_1",
		actorLabel: "Player",
		scriptId: "script_1",
		scriptLabel: "Fate Die",
		scriptRevision: 1,
		checkId: "fate_check",
		checkLabel: "Fate Roll",
		notation: "4dF",
		faceShape: "dF",
		resolution: "narrative",
		mode: "normal",
		attemptsJson: JSON.stringify([
			{ attemptId: "a1", faces: [1, 0, -1, 1], modifier: 0, subtotal: 1, total: 1 },
		]),
		finalJson: null,
		...overrides,
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ChatStore.forkBranch — bound Dice clone (DICE-B12)", () => {
	let db: AppDb;
	let chatStore: ChatStore;
	let messageStore: MessageStore;
	let diceStore: DiceRollStore;

	beforeEach(async () => {
		clockTick = 0;
		idCounters = new Map();
		db = await createDb(":memory:");

		chatStore = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
		messageStore = new MessageStore(db, { clock: testClock, idGenerator: testIdGen });
		diceStore = new DiceRollStore(db, { clock: testClock, idGenerator: testIdGen });

		// Bootstrap FK parents: character → chat + root branch.
		db.insert(schema.characters).values({
			id: "char_1", name: "TestChar", description: "",
			alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
			status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
		}).run();
		db.insert(schema.personas).values({
			id: "persona_1", name: "Player", description: "",
			defaultForNewChats: 0, hasFileOnDisk: 0,
			createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
		}).run();
		db.insert(schema.chats).values({
			id: "chat_1", characterId: "char_1", personaId: "persona_1",
			activeBranchId: "brnch_1", promptPresetId: null,
			title: "Dice fork chat", summary: "", messageHistoryLimit: 0,
			status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
		}).run();
		db.insert(schema.chatBranches).values({
			id: "brnch_1", chatId: "chat_1", parentBranchId: null,
			forkedFromMessageId: null, label: "main", createdAt: FIXED_NOW,
		}).run();
	});

	/** Create a user message, roll a normal lane, and bind the lane to it. */
	async function userMessageWithBoundRolls(
		content: string,
		rollOverrides: Record<string, unknown>[],
	): Promise<string> {
		const msg = await messageStore.addMessage({
			chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content,
		});
		for (const [i, ov] of rollOverrides.entries()) {
			await diceStore.createRoll({
				chatId: "chat_1", branchId: "brnch_1", mode: "normal",
				...rollInput({ requestId: `req_${msg.id}_${i}`, ...ov }),
			});
		}
		await diceStore.bindActiveAndReset("chat_1", "brnch_1", "normal", rollOverrides.length, msg.id);
		return msg.id;
	}

	test("fork clones bound rolls onto the new branch's user messages", async () => {
		const userId = await userMessageWithBoundRolls("roll please", [
			{ checkId: "check_a", checkLabel: "A" },
			{ checkId: "check_b", checkLabel: "B", notation: "1d20", faceShape: "d20" },
		]);
		// An assistant reply after the user message is also copied but carries no rolls.
		const assistant = await messageStore.addMessage({
			chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", content: "reply",
		});

		const forked = await chatStore.forkBranch(
			"chat_1",
			assistant.id,
			"dice fork",
			(tx, msgIdMap) => diceStore.forkCopyRollsInTx(tx, msgIdMap),
		);

		// The forked branch has 2 messages (user + assistant).
		const forkedMessages = await messageStore.getMessages(forked.id);
		expect(forkedMessages.length).toBe(2);
		const forkedUser = forkedMessages.find((m) => m.role === "user")!;
		expect(forkedUser).toBeDefined();

		// Exactly 2 rolls, bound to the FORKED user message (new id), not the source.
		const forkedRolls = await diceStore.getRollsForMessage(forkedUser.id);
		expect(forkedRolls.length).toBe(2);
		expect(forkedUser.id).not.toBe(userId);
		// Copied rolls carry FRESH request ids (new idempotency keys), never the source's.
		const sourceRolls = await diceStore.getRollsForMessage(userId);
		const sourceReqIds = new Set(sourceRolls.map((r) => r.requestId));
		for (const r of forkedRolls) {
			expect(r.boundMessageId).toBe(forkedUser.id);
			expect(sourceReqIds.has(r.requestId)).toBe(false);
		}

		// Snapshot preserved: both checks present with their labels.
		const labels = forkedRolls.map((r) => r.checkLabel).sort();
		expect(labels).toEqual(["A", "B"]);
		const d20 = forkedRolls.find((r) => r.notation === "1d20")!;
		expect(d20.faceShape).toBe("d20");
	});

	test("source rolls are untouched by the fork", async () => {
		const userId = await userMessageWithBoundRolls("orig", [
			{ checkId: "check_keep", checkLabel: "Keep" },
		]);
		const before = await diceStore.getRollsForMessage(userId);

		await chatStore.forkBranch(
			"chat_1",
			userId,
			"source untouched",
			(tx, msgIdMap) => diceStore.forkCopyRollsInTx(tx, msgIdMap),
		);

		const after = await diceStore.getRollsForMessage(userId);
		expect(after.length).toBe(before.length);
		expect(after[0]!.id).toBe(before[0]!.id);
		expect(after[0]!.boundMessageId).toBe(userId);
	});

	test("fork with no bound dice is a no-op (closure called, copies nothing)", async () => {
		// A user message with NO rolls + an assistant message.
		const msg = await messageStore.addMessage({
			chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "no dice",
		});
		await messageStore.addMessage({
			chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", content: "ok",
		});

		const forked = await chatStore.forkBranch(
			"chat_1",
			msg.id,
			"no dice fork",
			(tx, msgIdMap) => diceStore.forkCopyRollsInTx(tx, msgIdMap),
		);

		// No rolls exist anywhere for the forked branch's messages.
		const forkedMessages = await messageStore.getMessages(forked.id);
		for (const m of forkedMessages) {
			expect((await diceStore.getRollsForMessage(m.id)).length).toBe(0);
		}
	});

	test("dice fork closure is optional — a fork without it still works (back-compat)", async () => {
		const userId = await userMessageWithBoundRolls("will not clone", [
			{ checkId: "check_x", checkLabel: "X" },
		]);

		// No closure passed — the fork copies messages/variants/traces but NOT dice.
		const forked = await chatStore.forkBranch("chat_1", userId, "no closure");
		const forkedUser = (await messageStore.getMessages(forked.id)).find((m) => m.role === "user")!;
		expect(forkedUser).toBeDefined();
		expect((await diceStore.getRollsForMessage(forkedUser.id)).length).toBe(0);
		// Source still intact.
		expect((await diceStore.getRollsForMessage(userId)).length).toBe(1);
	});

	test("the dice copy rolls back with the fork transaction on failure", async () => {
		const userId = await userMessageWithBoundRolls("rollback src", [
			{ checkId: "check_rb", checkLabel: "RB" },
		]);

		// A closure that copies then throws — the dice copy must roll back with
		// the synchronous fork transaction (the atomicity this unit guarantees).
		await expect(
			chatStore.forkBranch(
				"chat_1",
				userId,
				"rollback fork",
				(tx, msgIdMap) => {
					diceStore.forkCopyRollsInTx(tx, msgIdMap);
					throw new Error("dice fork boom");
				},
			),
		).rejects.toThrow("dice fork boom");

		// No fork branch created (the whole tx rolled back)…
		const branches = await db.select().from(schema.chatBranches)
			.where(sql`chat_id = 'chat_1'`).all();
		expect(branches.length).toBe(1); // only the root branch

		// …and no orphaned dice rows on any new message.
		const allRolls = await db.select().from(schema.diceRolls).all();
		expect(allRolls.length).toBe(1); // only the source roll
		expect(allRolls[0]!.boundMessageId).toBe(userId);
	});
});
