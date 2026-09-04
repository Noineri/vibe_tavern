import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  dedupePromptTracePayloads,
  isTraceDedupeApplied,
} from "../src/trace-chunk-migration.js";
import { deflateTraceValue, inflateTraceValue } from "../src/trace-chunking.js";

// ─── Fixture ─────────────────────────────────────────────────────────────────

/**
 * Minimal pre-migration database: prompt_traces in LEGACY shape (inline JSON
 * payloads, no chunks/refs/marker tables). Mirrors what migration 0061 leaves
 * behind on an upgrading user's DB: new tables exist, rows are old-format.
 */
function makeLegacyDb(): Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE prompt_traces (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    model TEXT NOT NULL,
    preset_name TEXT NOT NULL,
    assembled_layers_json TEXT NOT NULL,
    token_accounting_json TEXT NOT NULL,
    final_payload_json TEXT NOT NULL DEFAULT '{}',
    activated_lore_entries_json TEXT NOT NULL DEFAULT '[]',
    retrieved_memories_json TEXT NOT NULL DEFAULT '[]',
    script_injections_json TEXT NOT NULL DEFAULT '[]',
    latency_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    provider_response_json TEXT
  )`);
  sqlite.exec(`CREATE TABLE prompt_trace_chunks (
    id TEXT PRIMARY KEY,
    byte_size INTEGER NOT NULL,
    content TEXT NOT NULL
  )`);
  sqlite.exec(`CREATE TABLE prompt_trace_chunk_refs (
    trace_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    PRIMARY KEY(trace_id, chunk_id)
  )`);
  return sqlite;
}

const bigText = (seed: string, chars: number): string => {
  let out = "";
  while (out.length < chars) out += `${seed} история сообщения `;
  return out.slice(0, chars);
};

interface LegacyTrace {
  id: string;
  layers: unknown;
  final: unknown;
  response: unknown | null;
}

function insertLegacyTrace(sqlite: Database, trace: LegacyTrace): void {
  sqlite
    .prepare(
      `INSERT INTO prompt_traces (id, chat_id, branch_id, message_id, model, preset_name,
        assembled_layers_json, token_accounting_json, final_payload_json,
        activated_lore_entries_json, retrieved_memories_json, script_injections_json,
        latency_ms, created_at, provider_response_json)
       VALUES (?, 'chat_1', 'brnch_1', 'msg_1', 'm', 'p', ?, '{}', ?, '[]', '[]', '[]', 1, '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(trace.id, JSON.stringify(trace.layers), JSON.stringify(trace.final), trace.response === null ? null : JSON.stringify(trace.response));
}

/** Read-path emulation: what the store does after the migration. */
function readTrace(sqlite: Database, id: string): { layers: unknown; final: unknown; response: unknown | null } {
  const row = sqlite.prepare("SELECT assembled_layers_json AS l, final_payload_json AS f, provider_response_json AS r FROM prompt_traces WHERE id = ?").get(id) as { l: string; f: string; r: string | null };
  const map = new Map<string, string>();
  for (const chunk of sqlite.prepare("SELECT id, content FROM prompt_trace_chunks").all() as Array<{ id: string; content: string }>) map.set(chunk.id, chunk.content);
  const lookup = (chunkId: string): string | undefined => map.get(chunkId);
  return {
    layers: inflateTraceValue(JSON.parse(row.l), lookup),
    final: inflateTraceValue(JSON.parse(row.f), lookup),
    response: row.r === null ? null : inflateTraceValue(JSON.parse(row.r), lookup),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("dedupePromptTracePayloads (boot pass)", () => {
  test("rewrites legacy rows; read path returns identical values; marker set", () => {
    const sqlite = makeLegacyDb();
    const sharedHistory = bigText("hist", 5000);
    const traces: LegacyTrace[] = [
      { id: "t1", layers: [{ text: sharedHistory }], final: { messages: [{ role: "user", content: sharedHistory }] }, response: { body: { text: bigText("r1", 900) } } },
      { id: "t2", layers: [{ text: sharedHistory }], final: { messages: [{ role: "user", content: sharedHistory }] }, response: { body: { text: bigText("r2", 900) } } },
    ];
    for (const t of traces) insertLegacyTrace(sqlite, t);

    const stats = dedupePromptTracePayloads(sqlite)!;
    expect(stats.traces).toBe(2);
    expect(stats.rewritten).toBe(2);
    expect(stats.vacuumed).toBe(true);

    // Byte-identical through the store read path.
    for (const t of traces) {
      const read = readTrace(sqlite, t.id);
      expect(JSON.stringify(read.layers)).toBe(JSON.stringify(t.layers));
      expect(JSON.stringify(read.final)).toBe(JSON.stringify(t.final));
      expect(JSON.stringify(read.response)).toBe(JSON.stringify(t.response));
    }

    // The 5000-char shared text is stored exactly once across both traces.
    const chunkRows = sqlite.prepare("SELECT COUNT(*) AS n FROM prompt_trace_chunks").get() as { n: number };
    expect(chunkRows.n).toBe(3);
    // Refs are a SET (trace_id, chunk_id) — the same chunk referenced by both
    // payload columns of one trace records one ref (PK + OR IGNORE).
    const refRows = sqlite.prepare("SELECT COUNT(*) AS n FROM prompt_trace_chunk_refs").get() as { n: number };
    expect(refRows.n).toBe(4);

    // Marker: a second pass is a no-op returning null.
    expect(isTraceDedupeApplied(sqlite)).toBe(true);
    expect(dedupePromptTracePayloads(sqlite)).toBeNull();
    sqlite.close();
  });

  test("partial prior run: already-skeleton rows get refs without a rewrite", () => {
    const sqlite = makeLegacyDb();
    // Simulate a crash after the first batch: row A already rewritten by an
    // earlier pass (skeleton + chunks present), row B still legacy.
    const content = bigText("a", 2000);
    const deflated = deflateTraceValue({ text: content });
    const chunk = deflated.chunks[0]!;
    insertLegacyTrace(sqlite, { id: "a", layers: { text: content }, final: {}, response: null });
    sqlite.prepare("UPDATE prompt_traces SET assembled_layers_json = ? WHERE id = 'a'").run(JSON.stringify(deflated.skeleton));
    sqlite.prepare("INSERT INTO prompt_trace_chunks (id, byte_size, content) VALUES (?, ?, ?)").run(chunk.id, content.length, content);
    insertLegacyTrace(sqlite, { id: "b", layers: { text: bigText("b", 2000) }, final: {}, response: null });

    const stats = dedupePromptTracePayloads(sqlite)!;
    expect(stats.rewritten).toBe(1); // only row b
    // Row a must still have refs recorded (they were missing after the crash).
    const refsA = sqlite.prepare("SELECT COUNT(*) AS n FROM prompt_trace_chunk_refs WHERE trace_id = 'a'").get() as { n: number };
    expect(refsA.n).toBe(1);
    // And its value still reads back correctly.
    const read = readTrace(sqlite, "a");
    expect(read.layers).toEqual({ text: content });
    sqlite.close();
  });

  test("empty table: marker set, no VACUUM, no rewrites", () => {
    const sqlite = makeLegacyDb();
    const stats = dedupePromptTracePayloads(sqlite)!;
    expect(stats.traces).toBe(0);
    expect(stats.rewritten).toBe(0);
    expect(stats.vacuumed).toBe(false);
    expect(isTraceDedupeApplied(sqlite)).toBe(true);
    sqlite.close();
  });

  test("skips cleanly when chunk tables are absent (pre-0061 DB)", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE prompt_traces (id TEXT PRIMARY KEY)");
    expect(dedupePromptTracePayloads(sqlite)).toBeNull();
    expect(isTraceDedupeApplied(sqlite)).toBe(false);
    sqlite.close();
  });
});
