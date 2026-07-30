import { describe, test, expect, beforeEach } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { createDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { MessageStore, type MessageVariantSceneRecord } from "../src/stores/message-store.js";
import { ChatStore } from "../src/stores/chat-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// SCN-3 (SCENE_TRACKER_PLAN): Scene-record storage pinned to immutable variant
// identity. These tests cover the storage layer only — ID-keyed read/write/clear,
// content-edit invalidation, fork preservation (re-keyed), and durable backfill-
// run JSON/status round-trip. They deliberately assert the backfill-run row is
// NOT authoritative for Scene data (the variant row is).

// ─── Test harness ────────────────────────────────────────────────────────────

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

type Db = Awaited<ReturnType<typeof createDb>>;

/** Minimum rows so MessageStore (and ChatStore.forkBranch) can operate:
 *  character → chat → branch. createDb(":memory:") runs the real migrations, so
 *  the SCN-3 scene_tracker_json column + scene_backfill_runs table are present. */
function bootstrap(db: Db) {
  db.insert(schema.characters).values({
    id: "char_1", name: "TestChar", description: "",
    alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.chats).values({
    id: "chat_1", characterId: "char_1", personaId: null,
    activeBranchId: "brnch_1", promptPresetId: null,
    title: "Test chat", summary: "", messageHistoryLimit: 0,
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.chatBranches).values({
    id: "brnch_1", chatId: "chat_1", parentBranchId: null,
    forkedFromMessageId: null, label: "main", createdAt: FIXED_NOW,
  }).run();
}

function makeRecord(variantId: string, over: Partial<MessageVariantSceneRecord> = {}): MessageVariantSceneRecord {
  return {
    variantId,
    schemaHash: "hash_abc",
    configRevision: 1,
    sourceHash: "source_1",
    sceneState: { mood: "tense", location: "tavern" },
    modelId: "model_test_1",
    generatedAt: FIXED_NOW,
    ...over,
  };
}

let db: Db;
let messages: MessageStore;
let chatStore: ChatStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  bootstrap(db);
  clockTick = 0;
  idCounters = new Map();
  messages = new MessageStore(db, { clock: testClock, idGenerator: testIdGen });
  chatStore = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
});

// ─── Guarded edits and candidate variants (MAE-31) ───────────────────────────

describe("MessageStore guarded edits and candidate variants (MAE-31)", () => {
  test("edits the selected variant when its immutable id matches the guard", async () => {
    // Given
    const message = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "first",
      variants: ["first", "selected"], selectedVariantIndex: 1,
    });
    const selectedVariant = (await messages.getVariants(message.id))[1];
    if (!selectedVariant) throw new Error("expected selected test variant");

    // When
    const edited = await messages.editMessage(message.id, "selected edited", selectedVariant.id);

    // Then
    expect(edited.content).toBe("selected edited");
    const variants = await messages.getVariants(message.id);
    expect(variants[0]?.content).toBe("first");
    expect(variants[1]?.content).toBe("selected edited");
    expect(variants[1]?.isSelected).toBeTrue();
  });

  test("rejects a stale selected-variant guard without mutating the message or variants", async () => {
    // Given
    const message = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "first",
      variants: ["first", "second"], selectedVariantIndex: 0,
    });
    const initialVariants = await messages.getVariants(message.id);
    const initialVariant = initialVariants[0];
    const currentVariant = initialVariants[1];
    if (!initialVariant || !currentVariant) throw new Error("expected two test variants");
    await messages.selectVariant(message.id, currentVariant.variantIndex);
    const messageBefore = await db.select().from(schema.messages)
      .where(eq(schema.messages.id, message.id)).get();
    const variantsBefore = await db.select().from(schema.messageVariants)
      .where(eq(schema.messageVariants.messageId, message.id))
      .orderBy(asc(schema.messageVariants.variantIndex)).all();

    // When
    await expect(messages.editMessage(message.id, "must not land", initialVariant.id)).rejects.toMatchObject({
      name: "SelectedVariantMismatchError",
      messageId: message.id,
      expectedVariantId: initialVariant.id,
      actualVariantId: currentVariant.id,
    });

    // Then
    expect(await db.select().from(schema.messages).where(eq(schema.messages.id, message.id)).get())
      .toEqual(messageBefore);
    expect(await db.select().from(schema.messageVariants)
      .where(eq(schema.messageVariants.messageId, message.id))
      .orderBy(asc(schema.messageVariants.variantIndex)).all())
      .toEqual(variantsBefore);
  });

  test("keeps unguarded edits compatible with the existing selected-variant update", async () => {
    // Given
    const message = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "first",
      variants: ["first", "selected"], selectedVariantIndex: 1,
    });

    // When
    const edited = await messages.editMessage(message.id, "unguarded edit");

    // Then
    expect(edited.content).toBe("unguarded edit");
    const variants = await messages.getVariants(message.id);
    expect(variants[0]?.content).toBe("first");
    expect(variants[1]?.content).toBe("unguarded edit");
  });

  test("appends and selects a candidate variant while preserving the prior variant and syncing message content", async () => {
    // Given
    const message = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "original",
    });
    const originalVariant = (await messages.getVariants(message.id))[0];
    if (!originalVariant) throw new Error("expected original test variant");

    // When
    const candidate = await messages.addVariant(message.id, "candidate", "stop", "reasoning", 12, "model_1");

    // Then
    expect(candidate.variantIndex).toBe(1);
    const variants = await messages.getVariants(message.id);
    expect(variants).toHaveLength(2);
    expect(variants[0]?.id).toBe(originalVariant.id);
    expect(variants[0]?.content).toBe("original");
    expect(variants[0]?.isSelected).toBeFalse();
    expect(variants[1]?.id).toBe(candidate.id);
    expect(variants[1]?.isSelected).toBeTrue();
    expect(variants[1]?.finishReason).toBe("stop");
    expect(variants[1]?.modelId).toBe("model_1");
    expect((await messages.getMessageById(message.id))?.content).toBe("candidate");
  });
});

// ─── Scene records: immutable-variant identity ───────────────────────────────

describe("MessageStore scene records (SCN-3)", () => {
  test("a freshly created variant carries no scene record", async () => {
    const msg = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "Hello",
    });
    const variants = await messages.getVariants(msg.id);
    expect(variants).toHaveLength(1);
    expect(variants[0]!.sceneTracker).toBeNull();
    expect(await messages.getSceneRecord(variants[0]!.id)).toBeNull();
  });

  test("setSceneRecord stores and getSceneRecord reads back by immutable variant id", async () => {
    const msgA = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "Reply A",
    });
    const msgB = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "Reply B",
    });
    const [vA] = await messages.getVariants(msgA.id);
    const [vB] = await messages.getVariants(msgB.id);

    const recA = makeRecord(vA!.id, { sceneState: { mood: "calm" } });
    const recB = makeRecord(vB!.id, { sceneState: { mood: "tense" }, sourceHash: "src_b" });
    await messages.setSceneRecord(vA!.id, recA);
    await messages.setSceneRecord(vB!.id, recB);

    // Distinct records keyed by variant identity — no cross-contamination.
    expect(await messages.getSceneRecord(vA!.id)).toEqual(recA);
    expect(await messages.getSceneRecord(vB!.id)).toEqual(recB);
    expect((await messages.getSceneRecord(vA!.id))!.sceneState).toEqual({ mood: "calm" });

    // And the same data surfaces through the projected variant.
    expect((await messages.getVariants(msgA.id))[0]!.sceneTracker).toEqual(recA);
  });

  test("setSceneRecord overwrites and clearSceneRecord nulls the record", async () => {
    const msg = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "Hi",
    });
    const [v] = await messages.getVariants(msg.id);
    await messages.setSceneRecord(v!.id, makeRecord(v!.id, { sourceHash: "first" }));
    expect((await messages.getSceneRecord(v!.id))!.sourceHash).toBe("first");

    await messages.setSceneRecord(v!.id, makeRecord(v!.id, { sourceHash: "second" }));
    expect((await messages.getSceneRecord(v!.id))!.sourceHash).toBe("second");

    await messages.clearSceneRecord(v!.id);
    expect(await messages.getSceneRecord(v!.id)).toBeNull();
    expect((await messages.getVariants(msg.id))[0]!.sceneTracker).toBeNull();
  });

  test("getSceneRecord on an unknown variant id returns null", async () => {
    expect(await messages.getSceneRecord("mvar_does_not_exist")).toBeNull();
  });

  test("content edit LEAVES the edited variant's record intact (persisted fact); siblings keep theirs", async () => {
    const msg = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "v0",
      variants: ["v0", "v1"], selectedVariantIndex: 0,
    });
    const variants = await messages.getVariants(msg.id);
    const [v0, v1] = variants;
    await messages.setSceneRecord(v0!.id, makeRecord(v0!.id));
    await messages.setSceneRecord(v1!.id, makeRecord(v1!.id, { sourceHash: "v1_src" }));
    expect(await messages.getSceneRecord(v0!.id)).not.toBeNull();
    expect(await messages.getSceneRecord(v1!.id)).not.toBeNull();

    // Editing a message (e.g. a typo fix) rewrites the SELECTED variant's content
    // (v0) but must NOT wipe its Scene record — it is a persisted fact, not a
    // cache entry of the current content. The user should not have to regenerate
    // after an edit. v1 is untouched either way.
    await messages.editMessage(msg.id, "v0 edited");

    expect(await messages.getSceneRecord(v0!.id)).not.toBeNull();
    expect((await messages.getSceneRecord(v0!.id))!.sourceHash).toBe("source_1");
    expect((await messages.getSceneRecord(v1!.id))!.sourceHash).toBe("v1_src");
  });

  test("a new swipe (addVariant) starts scene-less while the prior variant keeps its record", async () => {
    const msg = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "first",
    });
    const [v0] = await messages.getVariants(msg.id);
    await messages.setSceneRecord(v0!.id, makeRecord(v0!.id, { sourceHash: "orig" }));

    const v1 = await messages.addVariant(msg.id, "regenerated");
    expect(v1.sceneTracker).toBeNull();
    expect(await messages.getSceneRecord(v1.id)).toBeNull();
    // The deselected prior variant retains its own record.
    expect((await messages.getSceneRecord(v0!.id))!.sourceHash).toBe("orig");
  });
});

// ─── Fork: preserve + re-key ownership ────────────────────────────────────────

describe("forkBranch scene preservation (SCN-3)", () => {
  test("forked variant inherits the scene record re-keyed to its new immutable id", async () => {
    const msg = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "scene-bearing reply",
    });
    const [sourceVariant] = await messages.getVariants(msg.id);
    await messages.setSceneRecord(
      sourceVariant!.id,
      makeRecord(sourceVariant!.id, { sourceHash: "fork_src", sceneState: { mood: "grim" } }),
    );

    const forkedBranch = await chatStore.forkBranch("chat_1", msg.id);
    const forkedVariants = await messages.getVariantsByBranch(forkedBranch.id);
    expect(forkedVariants.size).toBe(1);
    // forkBranch creates new messages (new ids) in the new branch, so read the
    // copied variant by position, not by the original message id.
    const forkedVariant = [...forkedVariants.values()][0]![0];
    expect(forkedVariant).toBeDefined();

    // New immutable id, distinct from the source.
    expect(forkedVariant!.id).not.toBe(sourceVariant!.id);
    // Record preserved (same scene data + sourceHash — fork content is identical)
    // but ownership identity moved to the new variant id.
    expect(forkedVariant!.sceneTracker).not.toBeNull();
    expect(forkedVariant!.sceneTracker!.variantId).toBe(forkedVariant!.id);
    expect(forkedVariant!.sceneTracker!.sourceHash).toBe("fork_src");
    expect(forkedVariant!.sceneTracker!.sceneState).toEqual({ mood: "grim" });

    // Source variant's own record is untouched by the fork.
    expect((await messages.getSceneRecord(sourceVariant!.id))!.variantId).toBe(sourceVariant!.id);
  });

  test("a variant with no scene record forks to a variant with no scene record", async () => {
    const msg = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "no scene here",
    });
    const forkedBranch = await chatStore.forkBranch("chat_1", msg.id);
    const forkedVariants = await messages.getVariantsByBranch(forkedBranch.id);
    const forkedVariant = [...forkedVariants.values()][0]![0];
    expect(forkedVariant!.sceneTracker).toBeNull();
  });
});

// ─── Scene backfill runs: durable job state (NOT scene authority) ─────────────

describe("scene backfill runs (SCN-3)", () => {
  test("create/get round-trips the durable JSON + status defaults", async () => {
    const manifest = JSON.stringify([{ variantId: "mvar_test_0001", sourceHash: "s1" }]);
    const run = await messages.createSceneBackfillRun({
      chatId: "chat_1", manifestJson: manifest, totalItems: 1,
    });
    expect(run.chatId).toBe("chat_1");
    expect(run.mode).toBe("fill-missing");
    expect(run.status).toBe("pending");
    expect(run.manifestJson).toBe(manifest);
    expect(run.totalItems).toBe(1);
    expect(run.cursor).toBe(0);
    expect(run.errorsJson).toBe("[]");
    expect(run.cancelRequested).toBe(false);
    expect(run.summaryJson).toBeNull();

    const reloaded = await messages.getSceneBackfillRun(run.id);
    expect(reloaded).toEqual(run);
    expect(await messages.getSceneBackfillRun("sbr_missing")).toBeNull();
  });

  test("update round-trips status, cursor, errors, cancel, and summary", async () => {
    const run = await messages.createSceneBackfillRun({
      chatId: "chat_1", manifestJson: "[]", totalItems: 3,
    });
    await messages.updateSceneBackfillRun(run.id, {
      status: "running",
      cursor: 1,
      errorsJson: JSON.stringify([{ variantId: "mvar_test_0001", error: "rate limited" }]),
      cancelRequested: true,
    });
    let reloaded = await messages.getSceneBackfillRun(run.id);
    expect(reloaded!.status).toBe("running");
    expect(reloaded!.cursor).toBe(1);
    expect(reloaded!.cancelRequested).toBe(true);
    expect(JSON.parse(reloaded!.errorsJson)).toHaveLength(1);

    await messages.updateSceneBackfillRun(run.id, {
      status: "completed",
      cursor: 3,
      summaryJson: JSON.stringify({ processed: 3, succeeded: 2, failed: 1 }),
    });
    reloaded = await messages.getSceneBackfillRun(run.id);
    expect(reloaded!.status).toBe("completed");
    expect(reloaded!.cursor).toBe(3);
    expect(reloaded!.summaryJson).not.toBeNull();
    expect(JSON.parse(reloaded!.summaryJson!).succeeded).toBe(2);
  });

  test("the run row is NOT authoritative for scene data — it never touches variant records", async () => {
    // A variant carries the canonical scene record…
    const msg = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "x",
    });
    const [v] = await messages.getVariants(msg.id);
    const record = makeRecord(v!.id, { sceneState: { mood: "canonical" } });
    await messages.setSceneRecord(v!.id, record);

    // …creating and mutating a backfill run for the same chat does not alter it.
    const run = await messages.createSceneBackfillRun({
      chatId: "chat_1", manifestJson: JSON.stringify([{ variantId: v!.id }]), totalItems: 1,
    });
    await messages.updateSceneBackfillRun(run.id, {
      status: "running", cursor: 1,
      errorsJson: JSON.stringify([{ variantId: v!.id, error: "boom" }]),
    });

    expect(await messages.getSceneRecord(v!.id)).toEqual(record);
    expect((await messages.getVariants(msg.id))[0]!.sceneTracker).toEqual(record);
  });

  test("getActiveSceneBackfillRun returns the pending/running run and null once terminal (SCN-14)", async () => {
    // No runs yet → null.
    expect(await messages.getActiveSceneBackfillRun("chat_1")).toBeNull();

    // A pending run is active.
    const run = await messages.createSceneBackfillRun({
      chatId: "chat_1", manifestJson: "[]", totalItems: 2,
    });
    expect(await messages.getActiveSceneBackfillRun("chat_1")).toEqual(run);

    // A running run is still active.
    await messages.updateSceneBackfillRun(run.id, { status: "running", cursor: 1 });
    const active = await messages.getActiveSceneBackfillRun("chat_1");
    expect(active!.id).toBe(run.id);
    expect(active!.status).toBe("running");

    // Once terminal (completed/cancelled/failed) it is no longer active.
    await messages.updateSceneBackfillRun(run.id, { status: "completed", summaryJson: "{}" });
    expect(await messages.getActiveSceneBackfillRun("chat_1")).toBeNull();
  });
});
