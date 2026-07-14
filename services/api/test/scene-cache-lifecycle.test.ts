/**
 * Scene cache lifecycle (SCENE_TRACKER_PLAN SCN-6).
 *
 * Integration test against the REAL in-memory store (createDb(":memory:") runs
 * the real migrations): rebuildCurrentSceneCache must always reflect the active
 * branch's CURRENT selection — the selected variant of the latest assistant
 * message — and never a just-finished nonselected job. The transition matrix
 * walks every mutation that can change the current Scene and asserts the cache
 * (return value + the raw stored column) tracks the immutable variant id.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
	createDb,
	ChatStore,
	MessageStore,
	characters,
	chats,
	type StoreContainer,
	type StoreClock,
	type StoreIdGenerator,
	type MessageVariantSceneRecord,
} from "@vibe-tavern/db";
import { computeSceneSchemaHash } from "@vibe-tavern/domain";
import { rebuildCurrentSceneCache } from "../src/domain/insights/scene-cache.js";

// ─── harness ────────────────────────────────────────────────────────────────

const FIXED_NOW = "2026-07-14T12:00:00.000Z";
let clockTick = 0;
const testClock: StoreClock = { now() { clockTick++; return new Date(Date.parse(FIXED_NOW) + clockTick).toISOString(); } };
let idCounters = new Map<string, number>();
const testIdGen: StoreIdGenerator = {
	next(prefix: string): string {
		const n = (idCounters.get(prefix) ?? 0) + 1;
		idCounters.set(prefix, n);
		return `${prefix}_t${String(n).padStart(3, "0")}`;
	},
};

const SCHEMA_A = { mood: { $type: "string" }, tension: { $type: "number", min: 0, max: 10 } } as const;
const SCHEMA_B = { location: { $type: "string" } } as const;
const HASH_A = computeSceneSchemaHash(SCHEMA_A);
const HASH_B = computeSceneSchemaHash(SCHEMA_B);

type Db = Awaited<ReturnType<typeof createDb>>;
let db: Db;
let chatStore: ChatStore;
let messages: MessageStore;
let stores: StoreContainer;
let chatId: string;
let branchId: string;

function makeRecord(variantId: string, over: Partial<MessageVariantSceneRecord> = {}): MessageVariantSceneRecord {
	return {
		variantId,
		schemaHash: HASH_A,
		configRevision: 0,
		sourceHash: "src",
		sceneState: { mood: "calm", tension: 3 },
		modelId: "model-a",
		generatedAt: FIXED_NOW,
		...over,
	};
}

/** Read the raw cache column to verify the write (the cache is otherwise write-only). */
async function readCache(id: string): Promise<unknown> {
	const rows = await db.select({ value: chats.insightsCurrentSceneJson, id: chats.id }).from(chats).all();
	const row = rows.find((r) => r.id === id);
	return row ? JSON.parse(row.value) : null;
}

/** Set the raw tracker config (schema + revision) directly on the chat. */
async function setConfig(id: string, schema: Record<string, unknown>, revision = 0): Promise<void> {
	await chatStore.updateInsightsConfig(id, { insightsConfig: { trackerEnabled: true, tracker: { schema, revision } } });
}

/** Create an assistant message with N content variants, returning its id + variants. */
async function addAssistant(contentVariants: string[], selectedIndex = 0): Promise<{ messageId: string; variants: { id: string; content: string }[] }> {
	const message = await messages.addMessage({
		chatId, branchId, role: "assistant", authorType: "assistant",
		content: contentVariants[0]!, variants: contentVariants, selectedVariantIndex: selectedIndex,
	});
	const variants = (await messages.getVariants(message.id)).map((v) => ({ id: v.id, content: v.content }));
	return { messageId: message.id, variants };
}

beforeEach(async () => {
	db = await createDb(":memory:");
	clockTick = 0;
	idCounters = new Map();
	chatStore = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
	messages = new MessageStore(db, { clock: testClock, idGenerator: testIdGen });
	stores = { chats: chatStore, messages } as unknown as StoreContainer;
	// character FK required by chats (mirror message-store.test.ts bootstrap).
	db.insert(characters).values({
		id: "char_1", name: "Aria", description: "",
		alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
		status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
	}).run();
	const chat = await chatStore.createChat({ characterId: "char_1", title: "c", promptPresetId: null });
	chatId = chat.id;
	branchId = chat.activeBranchId;
	await setConfig(chatId, SCHEMA_A);
});

// ─── transition matrix ──────────────────────────────────────────────────────

describe("rebuildCurrentSceneCache — transition matrix (SCN-6)", () => {
	test("an empty branch yields an empty cache", async () => {
		expect(await rebuildCurrentSceneCache(stores, chatId as never)).toBeNull();
		expect(await readCache(chatId)).toEqual({});
	});

	test("the latest assistant's fresh selected record becomes the cache", async () => {
		const { variants } = await addAssistant(["Reply A"]);
		await messages.setSceneRecord(variants[0]!.id, makeRecord(variants[0]!.id, { sceneState: { mood: "tense", tension: 7 } }));
		const cache = await rebuildCurrentSceneCache(stores, chatId as never);
		expect(cache?.variantId).toBe(variants[0]!.id);
		expect(cache?.sceneState).toEqual({ mood: "tense", tension: 7 });
		expect(await readCache(chatId)).toMatchObject({ variantId: variants[0]!.id });
	});

	test("a missing record (latest assistant not yet tracked) yields an empty cache", async () => {
		await addAssistant(["Reply A"]); // no record set
		expect(await rebuildCurrentSceneCache(stores, chatId as never)).toBeNull();
		expect(await readCache(chatId)).toEqual({});
	});

	test("a stale-schema record is excluded (cache empty)", async () => {
		const { variants } = await addAssistant(["Reply A"]);
		await messages.setSceneRecord(variants[0]!.id, makeRecord(variants[0]!.id, { schemaHash: "wrong-hash" }));
		expect(await rebuildCurrentSceneCache(stores, chatId as never)).toBeNull();
	});

	test("a stale-revision record is excluded (cache empty)", async () => {
		const { variants } = await addAssistant(["Reply A"]);
		await messages.setSceneRecord(variants[0]!.id, makeRecord(variants[0]!.id, { configRevision: 99 }));
		expect(await rebuildCurrentSceneCache(stores, chatId as never)).toBeNull();
	});

	test("a nonselected variant's record is NEVER substituted for the selected one", async () => {
		// Two variants: A selected (no record), B nonselected (just-finished record).
		const { variants } = await addAssistant(["Reply A", "Reply B"], 0);
		await messages.setSceneRecord(variants[1]!.id, makeRecord(variants[1]!.id, { sceneState: { mood: "from-B" } }));
		expect(await rebuildCurrentSceneCache(stores, chatId as never)).toBeNull(); // A has no record → empty, B ignored
		expect(await readCache(chatId)).toEqual({});
	});

	test("when both variants have records, the cache mirrors the SELECTED one", async () => {
		const { variants } = await addAssistant(["Reply A", "Reply B"], 0);
		await messages.setSceneRecord(variants[0]!.id, makeRecord(variants[0]!.id, { sceneState: { mood: "from-A" } }));
		await messages.setSceneRecord(variants[1]!.id, makeRecord(variants[1]!.id, { sceneState: { mood: "from-B" } }));
		const cache = await rebuildCurrentSceneCache(stores, chatId as never);
		expect(cache?.variantId).toBe(variants[0]!.id); // selected A, not B
		expect((cache?.sceneState as { mood: string }).mood).toBe("from-A");
	});

	test("selecting a different variant follows the new selection", async () => {
		const { messageId, variants } = await addAssistant(["Reply A", "Reply B"], 0);
		await messages.setSceneRecord(variants[0]!.id, makeRecord(variants[0]!.id, { sceneState: { mood: "A" } }));
		await messages.setSceneRecord(variants[1]!.id, makeRecord(variants[1]!.id, { sceneState: { mood: "B" } }));
		expect((await rebuildCurrentSceneCache(stores, chatId as never))?.variantId).toBe(variants[0]!.id);
		await messages.selectVariant(messageId, 1); // switch selection to B
		const cache = await rebuildCurrentSceneCache(stores, chatId as never);
		expect(cache?.variantId).toBe(variants[1]!.id);
		expect((cache?.sceneState as { mood: string }).mood).toBe("B");
	});

	test("variant deletion compacts indexes but the selected record survives by immutable id", async () => {
		// Three variants: index 0 (selected, id vA), 1 (vB), 2 (vC). Put a record on vA.
		const { messageId, variants } = await addAssistant(["A", "B", "C"], 0);
		const [vA, vB] = variants;
		await messages.setSceneRecord(vA!.id, makeRecord(vA!.id, { sceneState: { mood: "A-survives" } }));
		await messages.deleteVariant(messageId, 1); // delete vB (middle) → indexes compact
		// vA is still selected (selection is by id internally) and its record survived.
		const cache = await rebuildCurrentSceneCache(stores, chatId as never);
		expect(cache?.variantId).toBe(vA!.id);
		expect((cache?.sceneState as { mood: string }).mood).toBe("A-survives");
		// vB's record is gone with the variant; vA's is intact.
		expect(await messages.getSceneRecord(vB!.id)).toBeNull();
		expect(await messages.getSceneRecord(vA!.id)).not.toBeNull();
	});

	test("deleting the latest assistant rebuilds the cache from the new latest", async () => {
		const first = await addAssistant(["First reply"]);
		await messages.setSceneRecord(first.variants[0]!.id, makeRecord(first.variants[0]!.id, { sceneState: { mood: "first" } }));
		const second = await addAssistant(["Second reply"]);
		await messages.setSceneRecord(second.variants[0]!.id, makeRecord(second.variants[0]!.id, { sceneState: { mood: "second" } }));
		expect((await rebuildCurrentSceneCache(stores, chatId as never))?.variantId).toBe(second.variants[0]!.id);
		await messages.deleteMessage(second.messageId);
		const cache = await rebuildCurrentSceneCache(stores, chatId as never);
		expect(cache?.variantId).toBe(first.variants[0]!.id); // fell back to the now-latest assistant
		expect((cache?.sceneState as { mood: string }).mood).toBe("first");
	});

	test("editing the selected variant's content clears its record → cache empty", async () => {
		const { messageId, variants } = await addAssistant(["Reply A"]);
		await messages.setSceneRecord(variants[0]!.id, makeRecord(variants[0]!.id));
		await rebuildCurrentSceneCache(stores, chatId as never);
		await messages.editMessage(messageId, "Edited content"); // SCN-3: clears the selected variant's record
		expect(await rebuildCurrentSceneCache(stores, chatId as never)).toBeNull();
		expect(await readCache(chatId)).toEqual({});
	});

	test("editing a NON-selected variant leaves the selected record (and cache) intact", async () => {
		const { messageId, variants } = await addAssistant(["A", "B"], 0);
		await messages.setSceneRecord(variants[0]!.id, makeRecord(variants[0]!.id, { sceneState: { mood: "A" } }));
		await rebuildCurrentSceneCache(stores, chatId as never);
		// Switch to B, edit B (clearing B's record), switch back to A — A's record survives.
		await messages.selectVariant(messageId, 1);
		await messages.editMessage(messageId, "B edited");
		await messages.selectVariant(messageId, 0);
		const cache = await rebuildCurrentSceneCache(stores, chatId as never);
		expect(cache?.variantId).toBe(variants[0]!.id);
		expect((cache?.sceneState as { mood: string }).mood).toBe("A");
	});

	test("a schema change excludes records generated under the old schema", async () => {
		const { variants } = await addAssistant(["Reply A"]);
		await messages.setSceneRecord(variants[0]!.id, makeRecord(variants[0]!.id)); // fresh under SCHEMA_A / HASH_A
		expect((await rebuildCurrentSceneCache(stores, chatId as never))?.variantId).toBe(variants[0]!.id);
		await setConfig(chatId, SCHEMA_B); // schema change → HASH_B; record stamped HASH_A is now stale
		expect(await rebuildCurrentSceneCache(stores, chatId as never)).toBeNull();
	});

	test("a forked branch's re-keyed record is picked up once the branch activates", async () => {
		const { messageId, variants } = await addAssistant(["Reply A"]);
		await messages.setSceneRecord(variants[0]!.id, makeRecord(variants[0]!.id, { sceneState: { mood: "original" } }));
		expect((await rebuildCurrentSceneCache(stores, chatId as never))?.variantId).toBe(variants[0]!.id);
		// Fork from this message → copies the variant with a NEW id and a re-keyed record.
		const fork = await chatStore.forkBranch(chatId, messageId);
		await chatStore.activateBranch(chatId, fork.id);
		const cache = await rebuildCurrentSceneCache(stores, chatId as never);
		expect(cache).not.toBeNull();
		expect(cache?.variantId).not.toBe(variants[0]!.id); // the fork's re-keyed variant id, not the source's
		expect((cache?.sceneState as { mood: string }).mood).toBe("original"); // scene content preserved across the fork
	});
});
