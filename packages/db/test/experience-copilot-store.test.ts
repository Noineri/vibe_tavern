import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db-connection.js";
import { experienceCopilotThreads } from "../src/db-schema.js";
import { ExperienceCopilotStore, type CopilotContextMetrics } from "../src/stores/experience-copilot-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// Advancing clock so timestamps differ between sessions/messages (the fixed
// clock in script-visual-bindings.test.ts would collapse listSessions ordering
// to ambiguous). Resets per test via setup().
let clockBase = Date.parse("2026-06-15T00:00:00.000Z");
let clockStep = 0;
function makeClock(): StoreClock {
  return { now: () => new Date(clockBase + clockStep++ * 1000).toISOString() };
}
let idCounter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++idCounter}` };

async function setup() {
  clockStep = 0;
  const db = await createDb(":memory:");
  const store = new ExperienceCopilotStore(db, { clock: makeClock(), idGenerator: idGen });
  return { db, store };
}

describe("ExperienceCopilotStore", () => {
  test("startNewSession archives the prior active — only one active remains after two calls", async () => {
    const { store } = await setup();
    const SCRIPT = "script_a";

    const first = await store.startNewSession(SCRIPT, "First");
    expect(first.archivedAt).toBeNull();
    expect(await store.getActive(SCRIPT)).not.toBeNull();
    expect((await store.getActive(SCRIPT))!.id).toBe(first.id);

    const second = await store.startNewSession(SCRIPT, "Second");
    expect(second.archivedAt).toBeNull();

    // The first session must now be archived, and only ONE active remains.
    const sessions = await store.listSessions(SCRIPT);
    expect(sessions).toHaveLength(2);
    const actives = sessions.filter((s) => s.archivedAt === null);
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe(second.id);

    const firstReload = await store.getById(first.id);
    expect(firstReload?.archivedAt).not.toBeNull();
  });

  test("startNewSession on a brand-new script creates the first active (no prior to archive)", async () => {
    const { store } = await setup();
    const only = await store.startNewSession("script_fresh", "Fresh");
    expect(only.archivedAt).toBeNull();
    expect(await store.getActive("script_fresh")).not.toBeNull();
    expect((await store.listSessions("script_fresh"))).toHaveLength(1);
  });

  test("activate flips the active session correctly and leaves no two actives", async () => {
    const { store } = await setup();
    const SCRIPT = "script_b";

    const first = await store.startNewSession(SCRIPT, "First");
    const second = await store.startNewSession(SCRIPT, "Second");
    // second is active; first is archived.
    expect((await store.getActive(SCRIPT))!.id).toBe(second.id);

    // Resume the first archived session → it becomes active, second archived.
    const reactivated = await store.activate(first.id);
    expect(reactivated?.archivedAt).toBeNull();

    const sessions = await store.listSessions(SCRIPT);
    const actives = sessions.filter((s) => s.archivedAt === null);
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe(first.id);

    const secondReload = await store.getById(second.id);
    expect(secondReload?.archivedAt).not.toBeNull();
  });

  test("activate on the already-active session is a no-op (returns it unchanged)", async () => {
    const { store } = await setup();
    const SCRIPT = "script_c";
    const active = await store.startNewSession(SCRIPT, "Active");

    const result = await store.activate(active.id);

    expect(result?.id).toBe(active.id);
    expect(result?.archivedAt).toBeNull();
    const sessions = await store.listSessions(SCRIPT);
    expect(sessions.filter((s) => s.archivedAt === null)).toHaveLength(1);
  });

  test("activate / getById on a missing id returns null", async () => {
    const { store } = await setup();
    expect(await store.getById("nope")).toBeNull();
    expect(await store.activate("nope")).toBeNull();
  });

  test("archive sets archived_at; archiving twice is idempotent", async () => {
    const { store } = await setup();
    const SCRIPT = "script_d";
    const active = await store.startNewSession(SCRIPT, "Active");

    const archived = await store.archive(active.id);
    expect(archived?.archivedAt).not.toBeNull();
    // No active remains.
    expect(await store.getActive(SCRIPT)).toBeNull();

    // Idempotent: archiving again returns the thread unchanged (still archived).
    const archivedAgain = await store.archive(active.id);
    expect(archivedAgain?.archivedAt).not.toBeNull();
  });

  test("appendMessage inserts the message and bumps the thread's updated_at", async () => {
    const { store } = await setup();
    const SCRIPT = "script_e";
    const thread = await store.startNewSession(SCRIPT, "T");
    const before = await store.getById(thread.id);
    expect(before).not.toBeNull();

    const msg = await store.appendMessage(thread.id, {
      role: "user",
      content: "hello",
      toolCallsJson: null,
      toolCallId: null,
    });
    expect(msg.threadId).toBe(thread.id);
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("hello");

    const after = await store.getById(thread.id);
    // updated_at strictly advanced (advancing clock → later ISO timestamp).
    expect(after!.updatedAt >= before!.updatedAt).toBe(true);
  });

  test("appendMessage + listSessions ordering: most recently touched session first", async () => {
    const { store } = await setup();
    const SCRIPT = "script_order";

    const older = await store.startNewSession(SCRIPT, "Older"); // active
    const newer = await store.startNewSession(SCRIPT, "Newer"); // active, older archived

    // Append a message to the OLDER (archived) session → its updated_at advances
    // past `newer`'s, so listSessions must return it first.
    await store.appendMessage(older.id, { role: "assistant", content: "bumped" });

    const sessions = await store.listSessions(SCRIPT);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe(older.id); // most recently touched
    expect(sessions[1].id).toBe(newer.id);

    // Still exactly one active (the appendMessage did not change active state).
    expect(sessions.filter((s) => s.archivedAt === null)).toHaveLength(1);
  });

  test("DB layer: the partial unique index rejects a second active thread for one script_id", async () => {
    const { db, store } = await setup();
    const SCRIPT = "script_guard";
    await store.startNewSession(SCRIPT, "A");

    // A raw insert of a SECOND active (archived_at NULL) for the same script_id
    // must violate the partial unique index — proving the DB-layer invariant
    // holds independently of the app-level transaction guard. drizzle's
    // bun-sqlite driver `.run()` is synchronous (per db-connection.ts), so the
    // UNIQUE-constraint throw is caught by a synchronous .toThrow matcher.
    expect(() => {
      db.insert(experienceCopilotThreads).values({
        id: "raw_dup",
        scriptId: SCRIPT,
        draftSessionId: null,
        title: "dup",
        archivedAt: null,
        createdAt: "2026-06-15T00:00:00.000Z",
        updatedAt: "2026-06-15T00:00:00.000Z",
      }).run();
    }).toThrow();

    // Confirm the app-level view still sees exactly one active.
    expect(await store.getActive(SCRIPT)).not.toBeNull();
    const sessions = await store.listSessions(SCRIPT);
    expect(sessions.filter((s) => s.archivedAt === null)).toHaveLength(1);
  });

  test("DB layer: two threads with NULL script_id (draft) coexist — the partial index is script_id-scoped", async () => {
    const { db, store } = await setup();
    // Two draft threads (script_id NULL) are both exempt from the partial unique
    // index (its WHERE clause requires script_id IS NOT NULL).
    await db.insert(experienceCopilotThreads).values({
      id: "draft_1", scriptId: null, draftSessionId: "s1", title: "d1",
      archivedAt: null, createdAt: "2026-06-15T00:00:00.000Z", updatedAt: "2026-06-15T00:00:00.000Z",
    }).run();
    await db.insert(experienceCopilotThreads).values({
      id: "draft_2", scriptId: null, draftSessionId: "s2", title: "d2",
      archivedAt: null, createdAt: "2026-06-15T00:00:01.000Z", updatedAt: "2026-06-15T00:00:01.000Z",
    }).run();

    // Different script_ids each get their own single active independently.
    const a = await store.startNewSession("script_x", "X");
    const b = await store.startNewSession("script_y", "Y");
    expect((await store.getActive("script_x"))!.id).toBe(a.id);
    expect((await store.getActive("script_y"))!.id).toBe(b.id);
  });

  test("listMessages returns thread messages oldest-first", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_msgs", "Msgs");

    // Append out-of-order roles to verify ordering is by createdAt (not role).
    const first = await store.appendMessage(thread.id, { role: "user", content: "first" });
    const second = await store.appendMessage(thread.id, { role: "assistant", content: "second", toolCallsJson: "[{\"type\":\"tool-call\"}]" });
    const third = await store.appendMessage(thread.id, { role: "tool", content: "{}", toolCallId: "tc_1" });

    const messages = await store.listMessages(thread.id);
    expect(messages.map((m) => m.id)).toEqual([first.id, second.id, third.id]);
    expect(messages.map((m) => m.content)).toEqual(["first", "second", "{}"]);
    expect(messages[1].toolCallsJson).toBe("[{\"type\":\"tool-call\"}]");
    expect(messages[2].toolCallId).toBe("tc_1");
  });
});

// ─── CM-2: context metrics + auto-compact ────────────────────────────────────

describe("ExperienceCopilotStore — context metrics (CM-2)", () => {
  const metrics: CopilotContextMetrics = {
    systemTokens: 1000,
    digestTokens: 0,
    historyTokens: 500,
    totalTokens: 1500,
    budgetTokens: 16000,
    reserveTokens: 1000,
    source: "estimate",
    measuredAt: "2026-06-15T00:00:00.000Z",
  };

  test("updateContextMetrics persists metrics + provider/model; getById round-trips", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_metrics", "T");

    await store.updateContextMetrics(thread.id, metrics, "prov_1", "model_x");

    const reloaded = await store.getById(thread.id);
    expect(reloaded?.contextMetrics).toEqual(metrics);
    expect(reloaded?.lastProviderProfileId).toBe("prov_1");
    expect(reloaded?.lastModel).toBe("model_x");
  });

  test("before the first turn, metrics + provider/model are null", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_metrics_fresh", "T");

    const reloaded = await store.getById(thread.id);
    expect(reloaded?.contextMetrics).toBeNull();
    expect(reloaded?.lastProviderProfileId).toBeNull();
    expect(reloaded?.lastModel).toBeNull();
  });

  test("malformed context_metrics_json → null metrics (never fatal)", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewSession("script_malformed", "T");

    // Corrupt the column directly (simulating a bad write).
    await db.update(experienceCopilotThreads)
      .set({ contextMetricsJson: "not-json{" })
      .where(eq(experienceCopilotThreads.id, thread.id))
      .run();

    const reloaded = await store.getById(thread.id);
    expect(reloaded?.contextMetrics).toBeNull();
  });

  test("wrong-shape metrics JSON → null metrics (defensive type guard)", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewSession("script_wrongshape", "T");

    await db.update(experienceCopilotThreads)
      .set({ contextMetricsJson: JSON.stringify({ totalTokens: "not-a-number" }) })
      .where(eq(experienceCopilotThreads.id, thread.id))
      .run();

    const reloaded = await store.getById(thread.id);
    expect(reloaded?.contextMetrics).toBeNull();
  });

  test("autoCompact defaults on; setAutoCompact/getAutoCompact round-trip", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_autocompact", "T");

    expect(thread.autoCompact).toBe(true);
    expect(await store.getAutoCompact(thread.id)).toBe(true);

    await store.setAutoCompact(thread.id, false);
    expect(await store.getAutoCompact(thread.id)).toBe(false);
    expect((await store.getById(thread.id))?.autoCompact).toBe(false);
  });
});
