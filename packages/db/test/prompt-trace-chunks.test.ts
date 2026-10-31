import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { sql } from "drizzle-orm";
import * as schema from "../src/db-schema.js";
import { PromptTraceStore, type SaveTraceData } from "../src/stores/prompt-trace-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import { deflateTraceValue } from "../src/trace-chunking.js";
import { decodeTraceText, isCompressedTraceText } from "../src/trace-storage-codec.js";

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

const bigText = (seed: string, chars: number): string => {
  let out = "";
  while (out.length < chars) out += `${seed}-история сообщения `;
  return out.slice(0, chars);
};

/** Two consecutive traces in one chat: they share the whole prior history. */
function makeTraceData(chatId: string, messageId: string, historyMsgs: number, replySeed: string): SaveTraceData {
  return {
    chatId,
    branchId: "brnch_1",
    messageId,
    model: "test-model",
    presetName: "Default",
    assembledLayers: [
      { sourceType: "system", text: bigText("system-prompt", 9000), tokenCount: 2200 },
      { sourceType: "history", text: historyMsgs > 0 ? bigText("history", 1200 * historyMsgs) : "", tokenCount: 100 * historyMsgs },
    ],
    tokenAccounting: { total: 42 },
    finalPayload: {
      messages: Array.from({ length: historyMsgs }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: bigText(`hist-${i}`, 800) })),
    },
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
      steps: [{ response: { id: `resp-${replySeed}`, modelId: "test-model", headers: {}, body: { text: bigText(replySeed, 2500) } }, finishReason: "stop" }],
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("PromptTraceStore — chunked payloads", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let store: PromptTraceStore;

  beforeEach(async () => {
    idCounters = new Map();
    db = await createDb(":memory:");
    store = new PromptTraceStore(db, { clock: testClock, idGenerator: testIdGen });

    db.insert(schema.characters).values({
      id: "char_1", name: "TestChar", description: "",
      alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
      status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).run();
    db.insert(schema.chats).values({
      id: "chat_1", characterId: "char_1", personaId: null,
      activeBranchId: "brnch_1", promptPresetId: null,
      title: "T", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).run();
    db.insert(schema.chatBranches).values({
      id: "brnch_1", chatId: "chat_1", parentBranchId: null,
      label: "root", createdAt: FIXED_NOW,
    }).run();
    db.insert(schema.messages).values({
      id: "msg_1", chatId: "chat_1", branchId: "brnch_1", role: "user",
      authorType: "user", position: 0, content: "seed", state: "active",
      createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).run();
    db.insert(schema.messages).values({
      id: "msg_2", chatId: "chat_1", branchId: "brnch_1", role: "assistant",
      authorType: "character", position: 1, content: "seed-2", state: "active",
      createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).run();
  });

  test("save → get roundtrip returns the exact payload (big strings hydrated)", async () => {
    const data = makeTraceData("chat_1", "msg_1", 20, "reply-one");
    const saved = await store.saveTrace(data);

    expect(saved.assembledLayers).toEqual(data.assembledLayers);
    expect(saved.finalPayload).toEqual(data.finalPayload);
    expect(saved.providerResponse).toEqual(data.providerResponse);

    const fetched = await store.getTrace(saved.id);
    expect(fetched!.assembledLayers).toEqual(data.assembledLayers);
    expect(fetched!.finalPayload).toEqual(data.finalPayload);
    expect(fetched!.providerResponse).toEqual(data.providerResponse);
    expect(JSON.stringify(fetched!.finalPayload)).toBe(JSON.stringify(data.finalPayload));
  });

  test("seeded legacy TEXT skeletons and chunks serve identical JSON through every read path", async () => {
    const data = makeTraceData("chat_1", "msg_1", 60, "legacy");
    const saved = await store.saveTrace(data);
    const values = [data.assembledLayers, data.finalPayload, data.providerResponse].map((value) => deflateTraceValue(value, 1));
    db.transaction(() => {
      db.$client.query('DELETE FROM prompt_trace_chunk_refs WHERE trace_id = ?').run(saved.id);
      for (const value of values) {
        for (const chunk of value.chunks) {
          db.$client.query('INSERT OR REPLACE INTO prompt_trace_chunks(id, byte_size, content) VALUES (?, ?, ?)').run(chunk.id, chunk.content.length, chunk.content);
          db.$client.query('INSERT OR IGNORE INTO prompt_trace_chunk_refs(trace_id, chunk_id) VALUES (?, ?)').run(saved.id, chunk.id);
        }
      }
      db.$client.query('UPDATE prompt_traces SET assembled_layers_json = ?, final_payload_json = ?, provider_response_json = ? WHERE id = ?')
        .run(...values.map((value) => JSON.stringify(value.skeleton)), saved.id);
    });
    for (const trace of [
      await store.getTrace(saved.id),
      await store.getLatestTraceByChat("chat_1", "brnch_1"),
      ...(await store.getTracesByChat("chat_1", "brnch_1", "msg_1", 1)),
    ]) {
      expect(JSON.stringify(trace!.assembledLayers)).toBe(JSON.stringify(data.assembledLayers));
      expect(JSON.stringify(trace!.finalPayload)).toBe(JSON.stringify(data.finalPayload));
      expect(JSON.stringify(trace!.providerResponse)).toBe(JSON.stringify(data.providerResponse));
    }
  });

  test("getTracesByChat hydrates every row", async () => {
    const d1 = makeTraceData("chat_1", "msg_1", 5, "r1");
    const d2 = makeTraceData("chat_1", "msg_2", 6, "r2");
    const s1 = await store.saveTrace(d1);
    const s2 = await store.saveTrace(d2);

    const list = await store.getTracesByChat("chat_1");
    expect(list).toHaveLength(2);
    const byId = new Map(list.map((t) => [t.id, t]));
    expect(byId.get(s1.id)!.finalPayload).toEqual(d1.finalPayload);
    expect(byId.get(s2.id)!.finalPayload).toEqual(d2.finalPayload);
  });

  test("v2 commits compressed BLOBs with plaintext-hashed blocks and compressed byte sizes", async () => {
    const data = makeTraceData("chat_1", "msg_1", 60, "v2");
    const saved = await store.saveTrace(data);
    const row = db.$client.query<{ layers: Uint8Array; final: Uint8Array; response: Uint8Array }, [string]>(
      'SELECT assembled_layers_json AS layers, final_payload_json AS final, provider_response_json AS response FROM prompt_traces WHERE id = ?',
    ).get(saved.id)!;
    for (const column of [row.layers, row.final, row.response]) {
      expect(isCompressedTraceText(column)).toBe(true);
      expect(decodeTraceText(column)).toContain('"$vtlist"');
    }
    for (const chunk of db.$client.query<{ content: Uint8Array; size: number }, []>('SELECT content, byte_size AS size FROM prompt_trace_chunks').all()) {
      expect(isCompressedTraceText(chunk.content)).toBe(true);
      expect(chunk.size).toBe(chunk.content.byteLength);
    }
    expect(JSON.stringify((await store.getLatestTraceByChat("chat_1", "brnch_1"))!.assembledLayers)).toBe(JSON.stringify(data.assembledLayers));
  });

  test("shared history between consecutive traces is stored once", async () => {
    await store.saveTrace(makeTraceData("chat_1", "msg_1", 10, "r1"));
    await store.saveTrace(makeTraceData("chat_1", "msg_2", 10, "r2"));
    // reply seed differs (unique response), everything else identical payloads.
    const chunkCount = db.select({ n: sql<number>`count(*)` }).from(schema.promptTraceChunks).get() as { n: number };
    // 2 layers + 10 history messages + 2 provider bodies = 14 unique chunks
    // (the identical history/system texts must have deduplicated).
    expect(chunkCount.n).toBe(14);
  });

  test("sweepOrphanedChunks reclaims chunks only after their traces are gone", async () => {
    const s1 = await store.saveTrace(makeTraceData("chat_1", "msg_1", 10, "r1"));
    db.run(sql`DELETE FROM prompt_traces WHERE id = ${s1.id}`);
    await store.sweepOrphanedChunks();
    const chunks = db.select({ n: sql<number>`count(*)` }).from(schema.promptTraceChunks).get() as { n: number };
    const refs = db.select({ n: sql<number>`count(*)` }).from(schema.promptTraceChunkRefs).get() as { n: number };
    expect(chunks.n).toBe(0);
    expect(refs.n).toBe(0);
  });

  test("sweep keeps chunks still referenced by surviving traces", async () => {
    await store.saveTrace(makeTraceData("chat_1", "msg_1", 10, "same"));
    const s2 = await store.saveTrace(makeTraceData("chat_1", "msg_2", 10, "same"));
    db.run(sql`DELETE FROM prompt_traces WHERE id = ${s2.id}`);
    await store.sweepOrphanedChunks();
    const chunks = db.select({ n: sql<number>`count(*)` }).from(schema.promptTraceChunks).get() as { n: number };
    expect(chunks.n).toBeGreaterThan(0);
  });
});
