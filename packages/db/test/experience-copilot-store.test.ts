import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db-connection.js";
import { experienceCopilotThreads, characters, chats, chatBranches } from "../src/db-schema.js";
import { ExperienceCopilotStore } from "../src/stores/experience-copilot-store.js";
import { deriveThreadTitleFromFirstMessage } from "../src/stores/experience-copilot-auto-title.js";
import type { CopilotContextMetrics } from "../src/stores/experience-copilot-row-parse.js";
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

  // AP-28: the reasoning pair round-trips through appendMessage/listMessages —
  // values when written, nulls when omitted (rows written before the columns
  // existed read the same nulls: the migration is additive with no backfill).
  test("appendMessage round-trips the reasoning pair (AP-28)", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_ap28", "T");

    const withReasoning = await store.appendMessage(thread.id, {
      role: "assistant",
      content: "answer",
      reasoning: "first burst\n\nsecond burst",
      reasoningDurationMs: 4200,
    });
    expect(withReasoning.reasoning).toBe("first burst\n\nsecond burst");
    expect(withReasoning.reasoningDurationMs).toBe(4200);

    const withoutReasoning = await store.appendMessage(thread.id, {
      role: "assistant",
      content: "plain answer",
    });
    expect(withoutReasoning.reasoning).toBeNull();
    expect(withoutReasoning.reasoningDurationMs).toBeNull();

    // listMessages (the loop's history load) reads the same pair back.
    const listed = await store.listMessages(thread.id);
    expect(listed.map((m) => [m.role, m.reasoning, m.reasoningDurationMs])).toEqual([
      ["assistant", "first burst\n\nsecond burst", 4200],
      ["assistant", null, null],
    ]);
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

  test("startNewSession seeds autoCompact from the kind default param (AP-20): absent keeps the column default (on), false is honored, and the value is frozen at creation", async () => {
    const { store } = await setup();
    // Absent param — the pre-AP-20 call shape: the column default (on).
    const defaulted = await store.startNewSession("script_ap20_default", "T");
    expect(defaulted.autoCompact).toBe(true);
    // Explicit on is byte-identical to the default.
    const explicitOn = await store.startNewSession("script_ap20_on", "T", true);
    expect(explicitOn.autoCompact).toBe(true);
    // The kind's default off seeds the new row's toggle off.
    const off = await store.startNewSession("script_ap20_off", "T", false);
    expect(off.autoCompact).toBe(false);
    expect(await store.getAutoCompact(off.id)).toBe(false);
    // The value is read at CREATION only — a later default change is the
    // adapter's concern; the store never rewrites an existing row on its own.
    const offReloaded = await store.startNewSession("script_ap20_off", "T2", true);
    expect(offReloaded.autoCompact).toBe(true);
    expect((await store.getById(off.id))?.autoCompact).toBe(false);
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

  test("kind-provided segments round-trip (SC-9)", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_metrics_segments", "T");

    const withSegments: CopilotContextMetrics = {
      ...metrics,
      segments: [
        { key: "context", tokens: 1000 },
        { key: "rp_summaries", tokens: 120 },
        { key: "rp_messages", tokens: 480 },
        { key: "digest", tokens: 0 },
        { key: "discussion", tokens: 500 },
      ],
    };
    await store.updateContextMetrics(thread.id, withSegments, "prov_1", "model_x");

    const reloaded = await store.getById(thread.id);
    expect(reloaded?.contextMetrics).toEqual(withSegments);
  });

  test("a present-but-corrupt segments value is dropped, the metrics kept (SC-9)", async () => {
    const { db, store } = await setup();

    // Two corrupt shapes: segments not an array, and an entry missing its
    // number — the whole field must go (a partial array would silently break
    // the meter's segments-sum-to-total invariant), never the metrics object.
    for (const [label, segments] of [
      ["not-an-array", "nope"],
      ["bad entry", [{ key: "context" }]],
    ] as const) {
      const thread = await store.startNewSession(`script_bad_segments_${label}`, "T");
      await db.update(experienceCopilotThreads)
        .set({ contextMetricsJson: JSON.stringify({ ...metrics, segments }) })
        .where(eq(experienceCopilotThreads.id, thread.id))
        .run();

      const reloaded = await store.getById(thread.id);
      expect(reloaded?.contextMetrics).toEqual(metrics);
    }
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
      { targetType: "prompt_preset", targetId: "preset_3" },
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

// ─── TAG-2 (restored PM-7): session-scoped checklist todo ───────────────

describe("ExperienceCopilotStore — step-plan todo (TAG-2, restored PM-7)", () => {
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
      { title: "Assemble visual profile", status: "active" as const },
      { title: "Write fight rules", status: "pending" as const },
      { title: "Set bindings", status: "completed" as const },
    ];
    await store.updateTodo(thread.id, items);
    expect((await store.getById(thread.id))?.todo).toEqual(items);

    // Full replace: a shorter list drops the removed items (rewrite semantics).
    const shorter = [{ title: "One goal", status: "pending" as const }];
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

// ─── AP-19: auto-title from the first user message ──────────────────────────

describe("deriveThreadTitleFromFirstMessage (AP-19 — the ONE derivation)", () => {
  test("first line only — everything after the first newline drops", () => {
    expect(deriveThreadTitleFromFirstMessage("Fix the rules\nsecond line\nthird")).toBe("Fix the rules");
  });

  test("runs of whitespace collapse to single spaces; edges trim", () => {
    expect(deriveThreadTitleFromFirstMessage("  make   it \t darker  ")).toBe("make it darker");
  });

  test("hard cap 120 chars on the collapsed first line", () => {
    expect(deriveThreadTitleFromFirstMessage("x".repeat(200))).toHaveLength(120);
  });
});

describe("ExperienceCopilotStore — auto-title from the first user message (AP-19)", () => {
  test("empty title: the first user message titles the thread (first line, collapsed)", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_ap19_set");

    await store.appendMessage(thread.id, { role: "user", content: "  Polish the  rules\nplease\nand thank you" });

    expect((await store.getById(thread.id))!.title).toBe("Polish the rules");
  });

  test("a >120-char first line titles with exactly its first 120 chars", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_ap19_cap");

    await store.appendMessage(thread.id, { role: "user", content: "y".repeat(300) });

    expect((await store.getById(thread.id))!.title).toBe("y".repeat(120));
  });

  test("rename wins: a thread titled before its first message is never auto-titled", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_ap19_rename", "Owner name");

    await store.appendMessage(thread.id, { role: "user", content: "first message line" });

    expect((await store.getById(thread.id))!.title).toBe("Owner name");
  });

  test("only the FIRST user message titles — a later user row leaves even an empty title empty", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_ap19_later");

    await store.appendMessage(thread.id, { role: "user", content: "original opener" });
    // The user clears the title back to "" (the client numbered-fallback
    // state); the NEXT user message must not re-derive it.
    await store.renameSession(thread.id, "");
    await store.appendMessage(thread.id, { role: "user", content: "second message" });

    expect((await store.getById(thread.id))!.title).toBe("");
  });

  test("non-user rows never title the thread", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_ap19_roles");

    await store.appendMessage(thread.id, { role: "assistant", content: "assistant opener" });
    await store.appendMessage(thread.id, { role: "tool", content: "{}", toolCallId: "tc_ap19" });

    expect((await store.getById(thread.id))!.title).toBe("");
  });
});

// ─── updateAssistantContent (AP-30) ──────────────────────────────────────────
//
// The store half of "edit an assistant message": the class method is a thin
// seam over experience-copilot-message-edit.ts (the turn-delete sibling
// pattern). Pins the IN-PLACE contract (id, createdAt, seq, the AP-28
// reasoning pair, every other row, the order — only `content` changes), the
// eligibility refusal statuses, and the digest-anchor fold boundary. The
// HTTP mapping of the same statuses is pinned by the route test in
// services/api/test/experience-copilot-message-edit.test.ts.

describe("updateAssistantContent (AP-30)", () => {
  /** character → chat → branch (real FKs) so the chat-owned thread
   *  allocates SC-1 seqs — the shape that makes "keeps seq" non-vacuous. */
  function bootstrapChatOwned(db: Awaited<ReturnType<typeof createDb>>, chatId: string, branchId: string) {
    db.insert(characters).values({
      id: "char_ap30", name: "AP-30 fixture", description: "",
      alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
      status: "active", createdAt: "2026-06-15T00:00:00.000Z", updatedAt: "2026-06-15T00:00:00.000Z",
    }).run();
    db.insert(chats).values({
      id: chatId, characterId: "char_ap30", personaId: null,
      activeBranchId: branchId, promptPresetId: null,
      title: "AP-30", summary: "", messageHistoryLimit: 0,
      status: "active", createdAt: "2026-06-15T00:00:00.000Z", updatedAt: "2026-06-15T00:00:00.000Z",
    }).run();
    db.insert(chatBranches).values({
      id: branchId, chatId, parentBranchId: null,
      forkedFromMessageId: null, label: "main", createdAt: "2026-06-15T00:00:00.000Z",
    }).run();
  }

  test("chat-owned thread: the edit rewrites `content` only — id, createdAt, seq, and the reasoning pair stay; events and order stay", async () => {
    const { db, store } = await setup();
    bootstrapChatOwned(db, "chat_ap30", "brnch_ap30");
    const thread = await store.startNewChatSession("chat_ap30", "brnch_ap30", "sidechat-ooc");
    const u1 = await store.appendMessage(thread.id, { role: "user", content: "one" });
    const a1 = await store.appendMessage(thread.id, {
      role: "assistant",
      content: "answer one",
      reasoning: "thinking",
      reasoningDurationMs: 2_500,
    });
    const event = await store.appendContextEvent(thread.id, "rp_sync", { note: "frozen" });
    const u2 = await store.appendMessage(thread.id, { role: "user", content: "two" });
    const before = (await store.getById(thread.id))!.updatedAt;

    const result = await store.updateAssistantContent(thread.id, a1.id, "answer one (edited)");

    expect(result.status).toBe("edited");
    if (result.status !== "edited") return;
    expect(result.message).toMatchObject({
      id: a1.id,
      threadId: thread.id,
      role: "assistant",
      content: "answer one (edited)",
      toolCallsJson: null,
      toolCallId: null,
      reasoning: "thinking",
      reasoningDurationMs: 2_500,
      seq: a1.seq,
      createdAt: a1.createdAt,
    });
    // The timeline is byte-identical apart from the one content — same rows,
    // same order, the frozen event untouched between them.
    const rows = await store.listMessages(thread.id);
    expect(rows.map((m) => m.id)).toEqual([u1.id, a1.id, u2.id]);
    expect(rows.find((m) => m.id === u1.id)!.content).toBe("one");
    const timeline = await store.listTimeline(thread.id);
    expect(timeline.filter((e) => e.rowType === "event").map((e) => e.id)).toEqual([event.id]);
    // The thread surfaces as touched (the family's every-write convention).
    expect((await store.getById(thread.id))!.updatedAt > before).toBe(true);
  });

  test("eligibility: only an assistant text row edits — the refusal statuses name the reason", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_ap30_seam", "T");
    const u1 = await store.appendMessage(thread.id, { role: "user", content: "one" });
    const a1 = await store.appendMessage(thread.id, { role: "assistant", content: "answer one" });
    const carrier = await store.appendMessage(thread.id, {
      role: "assistant",
      content: "",
      toolCallsJson: JSON.stringify([{ type: "tool-call", toolCallId: "tc_1", toolName: "todo", input: {} }]),
    });
    const toolRow = await store.appendMessage(thread.id, {
      role: "tool",
      content: JSON.stringify({ toolName: "todo", output: {} }),
      toolCallId: "tc_1",
    });
    const blank = await store.appendMessage(thread.id, { role: "assistant", content: "" });
    const seed = (await store.listMessages(thread.id)).map((m) => m.id);

    expect(await store.updateAssistantContent(thread.id, u1.id, "x")).toEqual({ status: "refused-not-assistant", role: "user" });
    expect(await store.updateAssistantContent(thread.id, toolRow.id, "x")).toEqual({ status: "refused-not-assistant", role: "tool" });
    expect(await store.updateAssistantContent(thread.id, carrier.id, "x")).toEqual({ status: "refused-tool-call-row" });
    expect(await store.updateAssistantContent(thread.id, blank.id, "x")).toEqual({ status: "refused-empty-row" });
    // Empty/blank replacements are refused before any I/O — even for a
    // missing thread.
    expect(await store.updateAssistantContent(thread.id, a1.id, "")).toEqual({ status: "refused-empty-content" });
    expect(await store.updateAssistantContent(thread.id, a1.id, "  ")).toEqual({ status: "refused-empty-content" });
    expect(await store.updateAssistantContent("thr_missing_ap30", a1.id, "")).toEqual({ status: "refused-empty-content" });
    // The missing families.
    expect(await store.updateAssistantContent("thr_missing_ap30", a1.id, "x")).toEqual({ status: "missing-thread" });
    expect(await store.updateAssistantContent(thread.id, "msg_missing_ap30", "x")).toEqual({ status: "missing-message" });
    // A message of another thread is missing-message, never a cross-thread write.
    const other = await store.startNewSession("script_ap30_other", "T");
    expect(await store.updateAssistantContent(other.id, a1.id, "x")).toEqual({ status: "missing-message" });

    // Every refusal wrote nothing.
    expect((await store.listMessages(thread.id)).map((m) => m.id)).toEqual(seed);
    expect((await store.listMessages(thread.id)).find((m) => m.id === a1.id)!.content).toBe("answer one");
  });

  test("fold boundary: the covered prefix is refused, kept rows edit — read from the digest's anchor, not its own position", async () => {
    const { store } = await setup();
    const thread = await store.startNewSession("script_ap30_fold", "T");
    const u1 = await store.appendMessage(thread.id, { role: "user", content: "one" });
    const a1 = await store.appendMessage(thread.id, { role: "assistant", content: "covered answer" });
    const u2 = await store.appendMessage(thread.id, { role: "user", content: "two" });
    const a2 = await store.appendMessage(thread.id, { role: "assistant", content: "kept answer" });
    // The digest as the compaction service persists it: the anchor (first
    // KEPT message, u2) rides in toolCallId; the digest row's own position
    // is AFTER a2 (appended when compaction ran).
    const digest = await store.appendMessage(thread.id, {
      role: "digest",
      content: "Summary of the early turns.",
      toolCallId: u2.id,
    });
    const a3 = await store.appendMessage(thread.id, { role: "assistant", content: "post-digest answer" });

    // a2 sits before the digest row's position but at/after the anchor —
    // editable; a3 (after the digest row) too.
    expect((await store.updateAssistantContent(thread.id, a2.id, "kept answer (edited)")).status).toBe("edited");
    expect((await store.updateAssistantContent(thread.id, a3.id, "post-digest answer (edited)")).status).toBe("edited");
    // The covered prefix is folded.
    expect(await store.updateAssistantContent(thread.id, a1.id, "x")).toEqual({ status: "refused-folded" });
    // The digest row itself fails the role check before the boundary.
    expect(await store.updateAssistantContent(thread.id, digest.id, "x")).toEqual({ status: "refused-not-assistant", role: "digest" });

    const rows = await store.listMessages(thread.id);
    expect(rows.find((m) => m.id === a1.id)!.content).toBe("covered answer");
    expect(rows.find((m) => m.id === digest.id)!.content).toBe("Summary of the early turns.");
  });
});
