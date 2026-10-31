import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { sql } from "drizzle-orm";
import * as schema from "../src/db-schema.js";
import { PromptTraceStore, type SaveTraceData } from "../src/stores/prompt-trace-store.js";
import { hashTraceChunk } from "../src/trace-chunking.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

/**
 * LONG_CHAT_PERFORMANCE_REPORT step 8 — scoped chunk reclamation.
 *
 * `reclaimChunksForTraces(traceIds)` replaces the per-request GLOBAL
 * anti-join sweep (which froze the event loop on multi-GB DBs): given the
 * ids of the traces that just died (captured BEFORE the delete — the rows
 * are removed by FK cascades inside it), it deletes exactly those traces'
 * refs and reclaims a candidate chunk only when no surviving ref points at
 * it. The global `sweepOrphanedChunks` survives as boot-time maintenance.
 */

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FIXED_NOW = "2025-05-04T12:00:00.000Z";

const testClock: StoreClock = { now: () => FIXED_NOW };
let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_test_${String(n).padStart(4, "0")}`;
  },
};

/** A string long enough to be chunked (TRACE_CHUNK_THRESHOLD = 256). */
const bigText = (seed: string, chars = 600): string => `${seed}-${"x".repeat(chars)}`;

/** One traced send in `branchId`: shared system+history strings, unique reply. */
function makeTraceData(chatId: string, branchId: string, messageId: string, shared: string, reply: string): SaveTraceData {
  return {
    chatId,
    branchId,
    messageId,
    model: "test-model",
    presetName: "Default",
    assembledLayers: [
      { sourceType: "system", text: shared },
      { sourceType: "history", text: shared },
    ],
    tokenAccounting: { total: 42 },
    finalPayload: { messages: [{ role: "user", content: shared }] },
    activatedLoreEntries: [],
    activatedLoreDetail: [],
    retrievedMemories: [],
    scriptInjections: [],
    latencyMs: 100,
    prefill: null,
    compactionSummary: null,
    sentConfig: null,
    providerResponse: {
      mode: "nonstream",
      steps: [{ response: { id: "resp-1", modelId: "test-model", headers: {}, body: { text: reply } }, finishReason: "stop" }],
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("PromptTraceStore — scoped chunk reclamation (step 8)", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let store: PromptTraceStore;

  const chunkExists = (content: string): boolean =>
    (db.select({ n: sql<number>`count(*)` }).from(schema.promptTraceChunks)
      .where(sql`id = ${hashTraceChunk(content)}`).get() as { n: number }).n === 1;
  const refsOf = (traceId: string): string[] =>
    (db.select({ chunkId: schema.promptTraceChunkRefs.chunkId }).from(schema.promptTraceChunkRefs)
      .where(sql`trace_id = ${traceId}`).all()).map((r) => r.chunkId);

  beforeEach(async () => {
    idCounters = new Map();
    db = await createDb(":memory:");
    store = new PromptTraceStore(db, { clock: testClock, idGenerator: testIdGen });

    db.insert(schema.characters).values({
      id: "char_1", name: "TestChar", description: "",
      alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
      status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).run();
    for (const [chatId, branchId] of [["chat_1", "brnch_1"], ["chat_2", "brnch_3"]] as const) {
      db.insert(schema.chats).values({
        id: chatId, characterId: "char_1", personaId: null,
        activeBranchId: branchId, promptPresetId: null,
        title: "T", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
      }).run();
      db.insert(schema.chatBranches).values({
        id: branchId, chatId, parentBranchId: null,
        label: "root", createdAt: FIXED_NOW,
      }).run();
    }
    for (const [msgId, chatId, branchId, position] of [
      ["msg_1", "chat_1", "brnch_1", 0],
      ["msg_2", "chat_1", "brnch_1", 1],
      ["msg_3", "chat_2", "brnch_3", 0],
    ] as const) {
      db.insert(schema.messages).values({
        id: msgId, chatId, branchId, role: "user",
        authorType: "user", position, content: "seed", state: "active",
        createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
      }).run();
    }
  });

  test("a chunk shared with a surviving trace survives; a true orphan dies; the dead traces' refs are gone", async () => {
    const shared = bigText("shared-history");
    const replyOne = bigText("reply-one");
    const replyTwo = bigText("reply-two");
    const t1 = await store.saveTrace(makeTraceData("chat_1", "brnch_1", "msg_1", shared, replyOne));
    const t2 = await store.saveTrace(makeTraceData("chat_1", "brnch_1", "msg_2", shared, replyTwo));

    // The message delete FK-cascades t2's row away — the raw delete mirrors it
    // (same simulation style as the sweep tests in prompt-trace-chunks.test.ts).
    db.run(sql`DELETE FROM prompt_traces WHERE id = ${t2.id}`);
    await store.reclaimChunksForTraces([t2.id]);

    // Shared content stays (t1 still references it), t2's unique reply dies.
    expect(chunkExists(shared)).toBe(true);
    expect(chunkExists(replyOne)).toBe(true);
    expect(chunkExists(replyTwo)).toBe(false);
    // Exactly the dead trace's refs are gone; the survivor's stay.
    expect(refsOf(t2.id)).toEqual([]);
    expect(refsOf(t1.id).sort()).toEqual([hashTraceChunk(shared), hashTraceChunk(replyOne)].sort());
  });

  test("the scoped reclaim leaves OTHER chats' orphans untouched (the boot sweep's job)", async () => {
    const shared = bigText("shared-history");
    const t1 = await store.saveTrace(makeTraceData("chat_1", "brnch_1", "msg_1", shared, bigText("reply-one")));
    const otherHistory = bigText("other-chat-history");
    const otherReply = bigText("other-chat-reply");
    const t3 = await store.saveTrace(makeTraceData("chat_2", "brnch_3", "msg_3", otherHistory, otherReply));

    // chat_2's trace dies WITHOUT a scoped reclaim (a rolled-back request, a
    // crash mid-delete): its chunks are now true orphans — but reclaiming
    // chat_1's dying trace must not touch them.
    db.run(sql`DELETE FROM prompt_traces WHERE id = ${t3.id}`);
    const t2 = await store.saveTrace(makeTraceData("chat_1", "brnch_1", "msg_2", shared, bigText("reply-two")));
    db.run(sql`DELETE FROM prompt_traces WHERE id = ${t2.id}`);
    await store.reclaimChunksForTraces([t2.id]);

    expect(chunkExists(otherHistory)).toBe(true);
    expect(chunkExists(otherReply)).toBe(true);
    expect(refsOf(t3.id).length).toBeGreaterThan(0);

    // The boot-time global sweep is what reclaims cross-chat orphans.
    await store.sweepOrphanedChunks();
    expect(chunkExists(otherHistory)).toBe(false);
    expect(chunkExists(otherReply)).toBe(false);
    expect(refsOf(t3.id)).toEqual([]);
  });

  test("empty input is a no-op", async () => {
    const t1 = await store.saveTrace(makeTraceData("chat_1", "brnch_1", "msg_1", bigText("a"), bigText("b")));
    const before = (db.select({ n: sql<number>`count(*)` }).from(schema.promptTraceChunks).get() as { n: number }).n;
    const refsBefore = (db.select({ n: sql<number>`count(*)` }).from(schema.promptTraceChunkRefs).get() as { n: number }).n;
    await store.reclaimChunksForTraces([]);
    const after = (db.select({ n: sql<number>`count(*)` }).from(schema.promptTraceChunks).get() as { n: number }).n;
    const refsAfter = (db.select({ n: sql<number>`count(*)` }).from(schema.promptTraceChunkRefs).get() as { n: number }).n;
    expect(after).toBe(before);
    expect(refsAfter).toBe(refsBefore);
    expect(refsOf(t1.id).length).toBeGreaterThan(0);
  });

  test("best-effort: an internal failure is logged and never breaks the user-visible delete", async () => {
    const t1 = await store.saveTrace(makeTraceData("chat_1", "brnch_1", "msg_1", bigText("a"), bigText("b")));
    // Break the refs table so the reclaim's SQL fails mid-flight.
    db.run(sql`DROP TABLE prompt_trace_chunk_refs`);
    // Same never-throws contract as the global sweep (the delete response is
    // already committed; reclamation must not turn it into a 500).
    await expect(store.reclaimChunksForTraces([t1.id])).resolves.toBeUndefined();
  });
});
