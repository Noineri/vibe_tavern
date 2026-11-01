import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { sql } from "drizzle-orm";
import * as schema from "../src/db-schema.js";
import { PromptTraceStore, type SaveTraceData } from "../src/stores/prompt-trace-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const T1 = "2025-05-04T12:00:00.000Z";
const T2 = "2025-05-04T12:00:01.000Z";

/** Mutable clock — tests move `now` between saves to control createdAt. */
let currentNow = T1;
const testClock: StoreClock = { now: () => currentNow };

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_test_${String(n).padStart(4, "0")}`;
  },
};

/** ≥ TRACE_CHUNK_THRESHOLD (256) so every payload column stores as chunks. */
const bigText = (tag: string): string => `${tag}-` + "x".repeat(512);

function makeTraceData(messageId: string, tag: string, text: string): SaveTraceData {
  return {
    chatId: "chat_1",
    branchId: "brnch_1",
    messageId,
    model: `model-${tag}`,
    presetName: "Default",
    assembledLayers: [{ sourceType: "system", text, tokenCount: 10 }],
    tokenAccounting: { total: 1 },
    finalPayload: { messages: [{ role: "user", content: text }] },
    activatedLoreEntries: [],
    activatedLoreDetail: [],
    retrievedMemories: [],
    scriptInjections: [],
    latencyMs: 5,
    prefill: null,
    compactionSummary: null,
    sentConfig: null,
    providerResponse: {
      mode: "nonstream",
      steps: [{ response: { id: `resp-${tag}`, modelId: `model-${tag}`, headers: {}, body: { text } }, finishReason: "stop" }],
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("PromptTraceStore — getLatestTraceByChat (LC-1: one row in SQL)", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let store: PromptTraceStore;

  beforeEach(async () => {
    currentNow = T1;
    idCounters = new Map();
    db = await createDb(":memory:");
    store = new PromptTraceStore(db, { clock: testClock, idGenerator: testIdGen });

    db.insert(schema.characters).values({
      id: "char_1", name: "TestChar", description: "",
      alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
      status: "active", createdAt: T1, updatedAt: T1,
    }).run();
    db.insert(schema.chats).values({
      id: "chat_1", characterId: "char_1", personaId: null,
      activeBranchId: "brnch_1", promptPresetId: null,
      title: "T", createdAt: T1, updatedAt: T1,
    }).run();
    db.insert(schema.chatBranches).values({
      id: "brnch_1", chatId: "chat_1", parentBranchId: null,
      label: "root", createdAt: T1,
    }).run();
    // Exists but never gets a trace — the "empty branch" case.
    db.insert(schema.chatBranches).values({
      id: "brnch_2", chatId: "chat_1", parentBranchId: null,
      label: "empty", createdAt: T1,
    }).run();
    db.insert(schema.messages).values({
      id: "msg_1", chatId: "chat_1", branchId: "brnch_1", role: "user",
      authorType: "user", position: 0, content: "seed", state: "active",
      createdAt: T1, updatedAt: T1,
    }).run();
  });

  test("newest createdAt wins even when its id is LOWER (order = getTracesByChat's)", async () => {
    // Save the NEWEST row FIRST (lower id) — proves createdAt sorts before id,
    // not just "last insert wins".
    currentNow = T2;
    await store.saveTrace(makeTraceData("msg_1", "newer", bigText("newer")));
    currentNow = T1;
    await store.saveTrace(makeTraceData("msg_1", "older", bigText("older")));

    const latest = await store.getLatestTraceByChat("chat_1", "brnch_1");
    expect(latest!.model).toBe("model-newer");
    // The invariant, pinned directly: the single-row read is the full list's [0].
    expect(latest).toEqual((await store.getTracesByChat("chat_1", "brnch_1"))[0]);
  });

  test("createdAt tie → id tie-break picks the most recently inserted", async () => {
    // Both saves share createdAt T1 (fixed clock) — the same tie the flaky
    // `list-prompt-traces` case guarded: the higher (later) id must surface.
    await store.saveTrace(makeTraceData("msg_1", "first", bigText("first")));
    await store.saveTrace(makeTraceData("msg_1", "second", bigText("second")));

    const latest = await store.getLatestTraceByChat("chat_1", "brnch_1");
    expect(latest!.model).toBe("model-second");
    expect(latest).toEqual((await store.getTracesByChat("chat_1", "brnch_1"))[0]);
  });

  test("chunked payloads come back inflated for the returned row", async () => {
    const data = makeTraceData("msg_1", "chunked", bigText("chunked"));
    await store.saveTrace(data);
    // Guard that the fixture actually chunked (else this would test inline
    // columns, not the hydration path).
    const chunkCount = db.select({ n: sql<number>`count(*)` }).from(schema.promptTraceChunks).get() as { n: number };
    expect(chunkCount.n).toBeGreaterThan(0);

    const latest = await store.getLatestTraceByChat("chat_1", "brnch_1");
    expect(latest!.assembledLayers).toEqual(data.assembledLayers);
    expect(latest!.finalPayload).toEqual(data.finalPayload);
    expect(latest!.providerResponse).toEqual(data.providerResponse);
  });

  test("a branch with no traces returns null", async () => {
    await store.saveTrace(makeTraceData("msg_1", "only", bigText("only")));
    expect(await store.getLatestTraceByChat("chat_1", "brnch_2")).toBeNull();
  });

  test("getTracesByChat pushes the limit into SQL (same rows as the old slice)", async () => {
    const T3 = "2025-05-04T12:00:02.000Z";
    currentNow = T1;
    await store.saveTrace(makeTraceData("msg_1", "old", bigText("old")));
    currentNow = T2;
    await store.saveTrace(makeTraceData("msg_1", "mid", bigText("mid")));
    currentNow = T3;
    await store.saveTrace(makeTraceData("msg_1", "new", bigText("new")));

    // slice(0, n) over the unlimited list ≡ the limited query — the exact
    // swap getPromptTraceHistory made (LC-1); limits stay optional for the
    // lazy history route (no limit → full list).
    const unlimited = await store.getTracesByChat("chat_1", "brnch_1");
    const limited = await store.getTracesByChat("chat_1", "brnch_1", undefined, 2);
    expect(limited).toEqual(unlimited.slice(0, 2));
    expect(limited.map((t) => t.model)).toEqual(["model-new", "model-mid"]);
  });
});
