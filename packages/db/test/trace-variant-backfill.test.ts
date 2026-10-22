import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  backfillTraceVariants,
  isTraceVariantBackfillApplied,
} from "../src/trace-variant-backfill.js";

// ─── Fixture ─────────────────────────────────────────────────────────────────

/**
 * Minimal pre-backfill database: prompt_traces carries the SC-23b variant_id
 * column (added by migration 0120) but every legacy row is NULL — mirrors an
 * upgrading user's DB right after migrate().
 */
function makeLegacyDb(): Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE chat_branches (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    parent_branch_id TEXT,
    forked_from_message_id TEXT,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  sqlite.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    role TEXT NOT NULL,
    author_type TEXT NOT NULL,
    position INTEGER NOT NULL,
    content TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  sqlite.exec(`CREATE TABLE message_variants (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    variant_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    is_selected INTEGER NOT NULL DEFAULT 0,
    model_id TEXT,
    preset_name TEXT,
    created_at TEXT NOT NULL
  )`);
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
    provider_response_json TEXT,
    variant_id TEXT
  )`);
  return sqlite;
}

interface VariantSeed {
  id: string;
  index: number;
  createdAt: string;
  model?: string | null;
  preset?: string | null;
}

interface TraceSeed {
  id: string;
  createdAt: string;
  model?: string;
  preset?: string;
}

/** One message with its variants and traces, in one call. */
function seedMessage(
  sqlite: Database,
  messageId: string,
  branchId: string,
  position: number,
  variants: VariantSeed[],
  traces: TraceSeed[],
): void {
  const forkTime = "2026-10-21T12:00:00.000Z";
  sqlite
    .prepare("INSERT INTO messages (id, chat_id, branch_id, role, author_type, position, content, state, created_at, updated_at) VALUES (?, 'chat_1', ?, 'assistant', 'assistant', ?, 'c', 'complete', ?, ?)")
    .run(messageId, branchId, position, forkTime, forkTime);
  for (const v of variants) {
    sqlite
      .prepare("INSERT INTO message_variants (id, message_id, variant_index, content, is_selected, model_id, preset_name, created_at) VALUES (?, ?, ?, 'c', 0, ?, ?, ?)")
      .run(v.id, messageId, v.index, v.model === undefined ? "model-a" : v.model, v.preset === undefined ? "preset-a" : v.preset, v.createdAt);
  }
  for (const t of traces) {
    sqlite
      .prepare(`INSERT INTO prompt_traces (id, chat_id, branch_id, message_id, model, preset_name,
        assembled_layers_json, token_accounting_json, final_payload_json,
        activated_lore_entries_json, retrieved_memories_json, script_injections_json,
        latency_ms, created_at, variant_id)
       VALUES (?, 'chat_1', ?, ?, ?, ?, '[]', '{}', '{}', '[]', '[]', '[]', 1, ?, NULL)`)
      .run(t.id, branchId, messageId, t.model ?? "model-a", t.preset ?? "preset-a", t.createdAt);
  }
}

/** trace id → variant id (null included), for assertions. */
function variantLinks(sqlite: Database): Map<string, string | null> {
  const rows = sqlite.prepare("SELECT id, variant_id FROM prompt_traces").all() as Array<{ id: string; variant_id: string | null }>;
  return new Map(rows.map((r) => [r.id, r.variant_id]));
}

function seedBranch(sqlite: Database, id: string, parent: string | null, forkedFrom: string | null): void {
  sqlite
    .prepare("INSERT INTO chat_branches (id, chat_id, parent_branch_id, forked_from_message_id, label, created_at) VALUES (?, 'chat_1', ?, ?, 'l', '2026-10-21T12:00:00.000Z')")
    .run(id, parent, forkedFrom);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("backfillTraceVariants (boot pass)", () => {
  test("a five-swipe message links all five traces to their own variants", () => {
    const sqlite = makeLegacyDb();
    seedBranch(sqlite, "brnch_1", null, null);
    const t = (i: number) => `2026-10-21T10:00:0${i}.000Z`;
    seedMessage(sqlite, "msg_1", "brnch_1", 0,
      [0, 1, 2, 3, 4].map((i) => ({ id: `var_${i}`, index: i, createdAt: t(i) })),
      [0, 1, 2, 3, 4].map((i) => ({ id: `trace_${i}`, createdAt: t(i) })),
    );

    const stats = backfillTraceVariants(sqlite)!;
    expect(stats.traces).toBe(5);
    expect(stats.linked).toBe(5);
    expect(stats.leftNull).toBe(0);

    const links = variantLinks(sqlite);
    for (const i of [0, 1, 2, 3, 4]) {
      expect(links.get(`trace_${i}`)).toBe(`var_${i}`);
    }
    sqlite.close();
  });

  test("a deleted swipe leaves its trace null without shifting the others", () => {
    const sqlite = makeLegacyDb();
    seedBranch(sqlite, "brnch_1", null, null);
    // Variant 1 (deleted after the fact — its trace 201ms is orphaned).
    seedMessage(sqlite, "msg_1", "brnch_1", 0,
      [
        { id: "var_0", index: 0, createdAt: "2026-10-21T10:00:00.000Z" },
        { id: "var_2", index: 2, createdAt: "2026-10-21T10:00:02.000Z" },
      ],
      [
        { id: "trace_0", createdAt: "2026-10-21T10:00:00.500Z" },
        { id: "trace_1", createdAt: "2026-10-21T10:00:01.500Z" }, // belonged to the deleted variant
        { id: "trace_2", createdAt: "2026-10-21T10:00:02.500Z" },
      ],
    );

    backfillTraceVariants(sqlite)!;
    const links = variantLinks(sqlite);
    expect(links.get("trace_0")).toBe("var_0");
    // trace_1's owner-interval variant is var_0 (last created at-or-before it),
    // but the earliest matching trace in that interval (trace_0) already won
    // var_0 — the orphan stays null instead of shifting onto a neighbor.
    expect(links.get("trace_1")).toBeNull();
    expect(links.get("trace_2")).toBe("var_2");
    sqlite.close();
  });

  test("model or preset mismatch stays null; the (none) preset normalization links", () => {
    const sqlite = makeLegacyDb();
    seedBranch(sqlite, "brnch_1", null, null);
    seedMessage(sqlite, "msg_1", "brnch_1", 0,
      [
        // Writer semantics: variant preset NULL <=> trace preset "(none)".
        { id: "var_none", index: 0, createdAt: "2026-10-21T10:00:00.000Z", preset: null },
        { id: "var_other", index: 1, createdAt: "2026-10-21T10:00:01.000Z", model: "model-b" },
      ],
      [
        { id: "trace_none", createdAt: "2026-10-21T10:00:00.500Z", preset: "(none)" },
        { id: "trace_model_mismatch", createdAt: "2026-10-21T10:00:01.500Z", model: "model-a" }, // var_other is model-b
        { id: "trace_preset_mismatch", createdAt: "2026-10-21T10:00:01.600Z", model: "model-b", preset: "preset-z" },
      ],
    );

    backfillTraceVariants(sqlite)!;
    const links = variantLinks(sqlite);
    expect(links.get("trace_none")).toBe("var_none");
    expect(links.get("trace_model_mismatch")).toBeNull();
    expect(links.get("trace_preset_mismatch")).toBeNull();
    sqlite.close();
  });

  test("a greeting-like variant (no model) never claims a trace", () => {
    const sqlite = makeLegacyDb();
    seedBranch(sqlite, "brnch_1", null, null);
    // Greeting message: variants carry no model (no model wrote them), yet a
    // greeting trace exists with a real model string.
    seedMessage(sqlite, "msg_greet", "brnch_1", 0,
      [{ id: "var_greet", index: 0, createdAt: "2026-10-21T10:00:00.000Z", model: null, preset: null }],
      [{ id: "trace_greet", createdAt: "2026-10-21T10:00:00.500Z" }],
    );

    const stats = backfillTraceVariants(sqlite)!;
    expect(stats.linked).toBe(0);
    expect(stats.leftNull).toBe(1);
    expect(variantLinks(sqlite).get("trace_greet")).toBeNull();
    sqlite.close();
  });

  test("a forked copy links through its source trace; a post-fork swipe on the copied message links by creation order", () => {
    const sqlite = makeLegacyDb();
    seedBranch(sqlite, "brnch_1", null, null);
    seedBranch(sqlite, "brnch_2", "brnch_1", "msg_1");
    seedMessage(sqlite, "msg_1", "brnch_1", 0,
      [{ id: "var_src", index: 0, createdAt: "2026-10-21T10:00:00.000Z" }],
      [{ id: "trace_src", createdAt: "2026-10-21T10:00:00.500Z" }],
    );
    // The fork: copied message (position 0, created at fork time 12:00),
    // copied variant (created at fork time), copied trace (ORIGINAL createdAt),
    // then a post-fork swipe generated in the fork at 13:00.
    seedMessage(sqlite, "msg_1_copy", "brnch_2", 0,
      [
        { id: "var_copy", index: 0, createdAt: "2026-10-21T12:00:00.000Z" },
        { id: "var_new_swipe", index: 1, createdAt: "2026-10-21T13:00:00.000Z" },
      ],
      [
        { id: "trace_copy", createdAt: "2026-10-21T10:00:00.500Z" }, // identical to the source trace
        { id: "trace_new_swipe", createdAt: "2026-10-21T13:00:00.500Z" },
      ],
    );

    backfillTraceVariants(sqlite)!;
    const links = variantLinks(sqlite);
    expect(links.get("trace_src")).toBe("var_src");
    // Rule 2: the copy points at the COPY's variant (same variantIndex as the
    // source's variant), never the parent branch's row.
    expect(links.get("trace_copy")).toBe("var_copy");
    // Rule 1 via fall-through: the post-fork swipe trace finds no parent
    // match (its createdAt postdates every parent trace) and owns the newest
    // variant — it must not claim the copied variant.
    expect(links.get("trace_new_swipe")).toBe("var_new_swipe");
    sqlite.close();
  });

  test("an ambiguous source (two distinct source variants match) stays null", () => {
    const sqlite = makeLegacyDb();
    seedBranch(sqlite, "brnch_1", null, null);
    seedBranch(sqlite, "brnch_2", "brnch_1", "msg_1");
    // Two source traces tie on createdAt+model+preset but resolved to two
    // DIFFERENT variants (same-millisecond swipes in the parent).
    seedMessage(sqlite, "msg_1", "brnch_1", 0,
      [
        { id: "var_src_a", index: 0, createdAt: "2026-10-21T10:00:00.000Z" },
        { id: "var_src_b", index: 1, createdAt: "2026-10-21T10:00:00.000Z" },
      ],
      [
        { id: "trace_src_a", createdAt: "2026-10-21T10:00:00.500Z" },
        { id: "trace_src_b", createdAt: "2026-10-21T10:00:00.500Z" },
      ],
    );
    // Pre-link the two source traces by hand (simulating whatever resolved
    // them — here they split, which makes the copy's source ambiguous).
    sqlite.prepare("UPDATE prompt_traces SET variant_id = 'var_src_a' WHERE id = 'trace_src_a'").run();
    sqlite.prepare("UPDATE prompt_traces SET variant_id = 'var_src_b' WHERE id = 'trace_src_b'").run();
    seedMessage(sqlite, "msg_1_copy", "brnch_2", 0,
      [{ id: "var_copy", index: 0, createdAt: "2026-10-21T12:00:00.000Z" }],
      [{ id: "trace_copy", createdAt: "2026-10-21T10:00:00.500Z" }],
    );

    backfillTraceVariants(sqlite)!;
    expect(variantLinks(sqlite).get("trace_copy")).toBeNull();
    sqlite.close();
  });

  test("idempotent: marker set, a second run changes nothing; a partial prior run only fills the rest", () => {
    const sqlite = makeLegacyDb();
    seedBranch(sqlite, "brnch_1", null, null);
    seedMessage(sqlite, "msg_1", "brnch_1", 0,
      [
        { id: "var_0", index: 0, createdAt: "2026-10-21T10:00:00.000Z" },
        { id: "var_1", index: 1, createdAt: "2026-10-21T10:00:01.000Z" },
      ],
      [
        { id: "trace_0", createdAt: "2026-10-21T10:00:00.500Z" },
        { id: "trace_1", createdAt: "2026-10-21T10:00:01.500Z" },
      ],
    );
    // Simulate a crash after the first batch: trace_0 already linked.
    sqlite.prepare("UPDATE prompt_traces SET variant_id = 'var_0' WHERE id = 'trace_0'").run();

    const stats = backfillTraceVariants(sqlite)!;
    expect(stats.traces).toBe(1); // only the still-null row was examined
    expect(stats.linked).toBe(1);
    expect(variantLinks(sqlite).get("trace_1")).toBe("var_1");

    // Marker present: a second pass is a no-op returning null.
    expect(isTraceVariantBackfillApplied(sqlite)).toBe(true);
    expect(backfillTraceVariants(sqlite)).toBeNull();
    expect(variantLinks(sqlite).get("trace_0")).toBe("var_0");
    sqlite.close();
  });

  test("skips cleanly when the expected shape is absent", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE prompt_traces (id TEXT PRIMARY KEY)");
    expect(backfillTraceVariants(sqlite)).toBeNull();
    sqlite.exec("CREATE TABLE message_variants (id TEXT PRIMARY KEY)");
    sqlite.exec("CREATE TABLE messages (id TEXT PRIMARY KEY)");
    sqlite.exec("CREATE TABLE chat_branches (id TEXT PRIMARY KEY)");
    // Tables exist but the variant_id column does not (pre-0120 legacy DB
    // an earlier boot phase has not healed yet).
    expect(backfillTraceVariants(sqlite)).toBeNull();
    expect(isTraceVariantBackfillApplied(sqlite)).toBe(false);
    sqlite.close();
  });
});
