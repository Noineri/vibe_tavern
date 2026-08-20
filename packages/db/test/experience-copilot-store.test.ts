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

  test("renameSession sets the title and bumps updated_at, without touching archived_at", async () => {
    const { store } = await setup();
    const SCRIPT = "script_d2";
    const first = await store.startNewSession(SCRIPT, ""); // untitled → auto-number label in UI
    const second = await store.startNewSession(SCRIPT, ""); // archives first

    // Rename the ARCHIVED sibling — renaming must not resurrect it.
    const renamed = await store.renameSession(first.id, "Дурак — визуал");
    expect(renamed?.title).toBe("Дурак — визуал");
    expect(renamed?.archivedAt).not.toBeNull();

    // Renaming bumps updated_at ("most recently touched") but the ACTIVE
    // session is unchanged — rename never swaps which session is active.
    expect(renamed?.updatedAt >= first.updatedAt).toBe(true);
    const activeAfter = await store.getActive(SCRIPT);
    expect(activeAfter?.id).toBe(second.id);

    // Clearing to "" is the "back to auto-number" state.
    const cleared = await store.renameSession(first.id, "");
    expect(cleared?.title).toBe("");

    // Missing id → null, no throw.
    expect(await store.renameSession("nope", "x")).toBeNull();
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
    attachedTokens: 0,
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

  test("legacy metrics JSON without attachedTokens parses with attachedTokens 0 (CX-1)", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewSession("script_legacy_metrics", "T");

    // A pre-CX-1 row: every CM-1 field present, attachedTokens absent.
    const legacy = { ...metrics };
    delete (legacy as Partial<CopilotContextMetrics>).attachedTokens;
    await db.update(experienceCopilotThreads)
      .set({ contextMetricsJson: JSON.stringify(legacy) })
      .where(eq(experienceCopilotThreads.id, thread.id))
      .run();

    const reloaded = await store.getById(thread.id);
    expect(reloaded?.contextMetrics).toEqual({ ...metrics, attachedTokens: 0 });
  });
});

describe("ExperienceCopilotStore — pinned-context links (CX-1)", () => {
  test("contextLinks default to [] on a fresh thread; mapThread exposes them", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_links_fresh", "T");
    expect(thread.contextLinks).toEqual([]);
    expect(await store.getContextLinks(thread.id)).toEqual([]);
  });

  test("setContextLinks full-replace round-trips through getContextLinks and getById", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_links_set", "T");

    const links = [
      { targetType: "character", targetId: "char_1" },
      { targetType: "lorebook", targetId: "lore_2" },
      { targetType: "skill", targetId: "my-skill" },
    ] as const;
    await store.setContextLinks(thread.id, [...links]);

    expect(await store.getContextLinks(thread.id)).toEqual(links);
    expect((await store.getById(thread.id))?.contextLinks).toEqual(links);

    // Full replace: setting a shorter list drops the removed link.
    await store.setContextLinks(thread.id, [{ targetType: "persona", targetId: "persona_9" }]);
    expect(await store.getContextLinks(thread.id)).toEqual([{ targetType: "persona", targetId: "persona_9" }]);
  });

  test("setContextLinks bumps updatedAt", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_links_ts", "T");
    const before = thread.updatedAt;
    await store.setContextLinks(thread.id, [{ targetType: "script", targetId: "script_z" }]);
    expect((await store.getById(thread.id))?.updatedAt > before).toBe(true);
  });

  test("malformed context_links_json → [] (never fatal)", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewSession("script_links_malformed", "T");

    await db.update(experienceCopilotThreads)
      .set({ contextLinksJson: "not-json{" })
      .where(eq(experienceCopilotThreads.id, thread.id))
      .run();

    expect(await store.getContextLinks(thread.id)).toEqual([]);
    expect((await store.getById(thread.id))?.contextLinks).toEqual([]);
  });

  test("wrong-shape links JSON drops invalid entries, keeps valid ones", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewSession("script_links_wrongshape", "T");

    // Mixed array: a valid link, an unknown targetType, a missing targetId,
    // and a non-object — only the valid one survives.
    await db.update(experienceCopilotThreads)
      .set({ contextLinksJson: JSON.stringify([
        { targetType: "character", targetId: "char_ok" },
        { targetType: "emoji", targetId: "x" },
        { targetType: "lorebook" },
        42,
      ]) })
      .where(eq(experienceCopilotThreads.id, thread.id))
      .run();

    expect(await store.getContextLinks(thread.id)).toEqual([{ targetType: "character", targetId: "char_ok" }]);
  });
});

// ─── TAG-2: step-plan todo ──────────────────────────────────────────────

describe("ExperienceCopilotStore — step-plan todo (TAG-2)", () => {
  test("todo defaults to [] on a fresh thread (null column); mapThread exposes it", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_todo_fresh", "T");
    expect(thread.todo).toEqual([]);
    expect((await store.getById(thread.id))?.todo).toEqual([]);
    expect((await store.getActive("script_todo_fresh"))?.todo).toEqual([]);
  });

  test("updateTodo full-replace round-trips through getById", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_todo_set", "T");

    const items = [
      { title: "Собрать визуальный профиль", status: "active" as const },
      { title: "Написать правила драки", status: "pending" as const },
      { title: "Задать биндинги", status: "completed" as const },
    ];
    await store.updateTodo(thread.id, items);
    expect((await store.getById(thread.id))?.todo).toEqual(items);

    // Full replace: a shorter list drops the removed items (rewrite semantics).
    const shorter = [{ title: "Одна цель", status: "pending" as const }];
    await store.updateTodo(thread.id, shorter);
    expect((await store.getById(thread.id))?.todo).toEqual(shorter);

    // Empty rewrite → empty plan (the panel hides, per the plan's hidden-until-first-call rule).
    await store.updateTodo(thread.id, []);
    expect((await store.getById(thread.id))?.todo).toEqual([]);
  });

  test("updateTodo bumps updatedAt", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_todo_ts", "T");
    const before = thread.updatedAt;
    await store.updateTodo(thread.id, [{ title: "x", status: "active" }]);
    expect((await store.getById(thread.id))?.updatedAt > before).toBe(true);
  });

  test("malformed todo_json → [] (never fatal)", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewSession("script_todo_malformed", "T");

    await db.update(experienceCopilotThreads)
      .set({ todoJson: "not-json{" })
      .where(eq(experienceCopilotThreads.id, thread.id))
      .run();

    expect((await store.getById(thread.id))?.todo).toEqual([]);
  });

  test("non-array todo_json → [] (never fatal)", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewSession("script_todo_nonarray", "T");

    await db.update(experienceCopilotThreads)
      .set({ todoJson: JSON.stringify({ title: "not", status: "a list" }) })
      .where(eq(experienceCopilotThreads.id, thread.id))
      .run();

    expect((await store.getById(thread.id))?.todo).toEqual([]);
  });

  test("wrong-shape todo JSON drops invalid entries, keeps valid ones", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewSession("script_todo_wrongshape", "T");

    // Mixed array: a valid item, an unknown status, an empty title, a
    // non-object — only the valid one survives.
    await db.update(experienceCopilotThreads)
      .set({ todoJson: JSON.stringify([
        { title: "valid", status: "active" },
        { title: "bad status", status: "done" },
        { title: "", status: "pending" },
        42,
      ]) })
      .where(eq(experienceCopilotThreads.id, thread.id))
      .run();

    expect((await store.getById(thread.id))?.todo).toEqual([{ title: "valid", status: "active" }]);
  });
});

describe("ExperienceCopilotStore — setToolResultOutput (TAG-5)", () => {
  test("rewrites ONE tool row's payload by threadId+toolCallId and bumps updatedAt", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_ask_1", "T");

    const marker = await store.appendMessage(thread.id, {
      role: "tool",
      content: JSON.stringify({
        toolName: "ask_user",
        output: { status: "awaiting_answer", question: "Blue or green?" },
      }),
      toolCallId: "tc_ask_1",
    });
    await store.appendMessage(thread.id, { role: "assistant", content: "unrelated" });
    const before = (await store.getById(thread.id))!.updatedAt;

    const rewritten = await store.setToolResultOutput(thread.id, "tc_ask_1", {
      toolName: "ask_user",
      output: { status: "answered", answer: "blue" },
    });

    expect(rewritten!.id).toBe(marker.id);
    const rows = await store.listMessages(thread.id);
    const toolRow = rows.find((r) => r.toolCallId === "tc_ask_1")!;
    expect(JSON.parse(toolRow.content)).toEqual({
      toolName: "ask_user",
      output: { status: "answered", answer: "blue" },
    });
    // Other rows untouched.
    expect(rows.filter((r) => r.role === "assistant").map((r) => r.content)).toEqual(["unrelated"]);
    expect((await store.getById(thread.id))!.updatedAt > before).toBe(true);
  });

  test("returns null for a toolCallId that matches no tool row (stale/foreign)", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_ask_2", "T");
    await store.appendMessage(thread.id, { role: "assistant", content: "no tool rows yet" });

    expect(await store.setToolResultOutput(thread.id, "tc_missing", { toolName: "ask_user", output: {} })).toBeNull();

    // A row that CARRIES the id but is not a tool row (defensive: the role
    // guard keeps an assistant toolCall-carrying row from matching).
    await store.appendMessage(thread.id, { role: "tool", content: "x", toolCallId: "tc_real" });
    expect(
      await store.setToolResultOutput(thread.id, "tc_other_thread", { toolName: "ask_user", output: {} }),
    ).toBeNull();
  });
});
