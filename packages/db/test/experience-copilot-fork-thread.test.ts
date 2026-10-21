import { describe, expect, test } from "bun:test";
import { createDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { ExperienceCopilotStore } from "../src/stores/experience-copilot-store.js";
import type { CopilotContextMetrics } from "../src/stores/experience-copilot-row-parse.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// SC-20 — the store half of the branch-sidechat fork
// (`ExperienceCopilotStore.forkChatThreadToBranch` + the
// `listActiveChatThreadsForBranch` read). Mirrors the fixtures of
// experience-copilot-chat-owner.test.ts (character → chat → branches
// bootstrap with real FKs; advancing clock so orderings stay unambiguous).
// Pins the row copy's mechanical facts the domain tests observe only
// end-to-end: the identity remap copies payloads byte-for-byte, the trailing
// event takes the NEXT seq (so post-copy appends continue the sequence),
// metrics reset, links/todo copy verbatim, the target's same-kind active
// sibling archives (never deletes), a missing source is null, a script-owned
// source is refused, and the source thread is untouched. The id-REMAP itself
// (payload re-keying, frontier derivation) is services/api's domain and is
// pinned in services/api/test/branch-sidechat-fork.test.ts.

const FIXED_NOW = "2026-06-15T00:00:00.000Z";
let clockBase = Date.parse(FIXED_NOW);
let clockStep = 0;
function makeClock(): StoreClock {
  return { now: () => new Date(clockBase + clockStep++ * 1000).toISOString() };
}
let idCounter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_forkcopy_${++idCounter}` };

/** character → chat → branches (source + target). createDb(":memory:") runs
 *  the real migrations, so the SC-0a/SC-1 columns are present. */
function bootstrap(db: Awaited<ReturnType<typeof createDb>>, chatId: string, branchIds: string[]) {
  db.insert(schema.characters).values({
    id: "char_1", name: "TestChar", description: "",
    alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.chats).values({
    id: chatId, characterId: "char_1", personaId: null,
    activeBranchId: branchIds[0]!, promptPresetId: null,
    title: "Test chat", summary: "", messageHistoryLimit: 0,
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  for (const [i, branchId] of branchIds.entries()) {
    db.insert(schema.chatBranches).values({
      id: branchId, chatId, parentBranchId: i === 0 ? null : branchIds[0]!,
      forkedFromMessageId: null, label: i === 0 ? "main" : "fork", createdAt: FIXED_NOW,
    }).run();
  }
}

async function setup(chatId = "chat_1", branchIds = ["brnch_1", "brnch_2"]) {
  clockStep = 0;
  const db = await createDb(":memory:");
  bootstrap(db, chatId, branchIds);
  const store = new ExperienceCopilotStore(db, { clock: makeClock(), idGenerator: idGen });
  return { db, store };
}

const METRICS: CopilotContextMetrics = {
  systemTokens: 1,
  attachedTokens: 0,
  digestTokens: 0,
  historyTokens: 2,
  totalTokens: 3,
  budgetTokens: 9,
  reserveTokens: 1,
  source: "estimate",
  measuredAt: FIXED_NOW,
};

/** The identity remap: every payload copies as-is, one trailing event. */
function identityRemap(trailingPayload: unknown) {
  return {
    eventPayload: (_kind: string, payloadJson: string | null) => ({ payloadJson }),
    frontierJson: (sourceFrontierJson: string | null) => sourceFrontierJson,
    trailingEvent: { kind: "branch_forked" as const, payload: trailingPayload },
  };
}

describe("ExperienceCopilotStore.listActiveChatThreadsForBranch (SC-20)", () => {
  test("active chat-owned threads across kinds, oldest first; archived and script rows excluded", async () => {
    const { store } = await setup();
    const first = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc");

    expect((await store.listActiveChatThreadsForBranch("chat_1", "brnch_1")).map((t) => t.id)).toEqual([first.id]);
    expect(await store.listActiveChatThreadsForBranch("chat_1", "brnch_2")).toEqual([]);

    // Archiving the only session empties the listing (the row stays in
    // listSessionsForChat, archived).
    await store.archive(first.id);
    expect(await store.listActiveChatThreadsForBranch("chat_1", "brnch_1")).toEqual([]);
    expect(await store.listSessionsForChat("chat_1", "brnch_1", "sidechat-ooc")).toHaveLength(1);

    // A script-owned thread never appears (chat_id IS NULL on it).
    const scriptThread = await store.startNewSession("script_sc20_store");
    expect((await store.listActiveChatThreadsForBranch("chat_1", "brnch_1")).map((t) => t.id)).not.toContain(
     	scriptThread.id,
    );
  });
});

describe("ExperienceCopilotStore.forkChatThreadToBranch (SC-20)", () => {
  test("copies messages + events (identity remap), appends the trailing event on the NEXT seq, metrics reset, source untouched", async () => {
    const { store } = await setup();
    const thread = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc");
    await store.appendMessage(thread.id, { role: "user", content: "one" });
    await store.appendContextEvent(thread.id, "rp_sync", { fromPosition: 0, toPosition: 0, messages: [] });
    await store.appendMessage(thread.id, { role: "assistant", content: "two" });
    await store.setContextLinks(thread.id, [{ targetType: "persona", targetId: "p1" }]);
    await store.updateTodo(thread.id, [{ title: "A task", status: "pending" }]);
    await store.setAutoCompact(thread.id, false);
    await store.updateContextMetrics(thread.id, METRICS, "prof_fixture", "model-fixture");
    await store.setFrontier(thread.id, { lastPosition: 0, selected: { m: "v" } });
    const sourceMessages = await store.listMessages(thread.id);

    const copied = await store.forkChatThreadToBranch(thread.id, "brnch_2", identityRemap({ at: 0 }));
    expect(copied).not.toBeNull();
    expect(copied!.id).not.toBe(thread.id);
    expect(copied!.branchId).toBe("brnch_2");
    expect(copied!.chatId).toBe("chat_1");
    expect(copied!.agentKind).toBe("sidechat-ooc");
    expect(copied!.archivedAt).toBeNull();
    // Metrics reset; the other carried state copies.
    expect(copied!.contextMetrics).toBeNull();
    expect(copied!.contextLinks).toEqual([{ targetType: "persona", targetId: "p1" }]);
    expect(copied!.todo).toEqual([{ title: "A task", status: "pending" }]);
    expect(copied!.autoCompact).toBe(false);
    expect(copied!.lastProviderProfileId).toBe("prof_fixture");
    expect(copied!.lastModel).toBe("model-fixture");

    // Messages and events copy with fresh ids; the frontier passes through
    // the identity hook; the trailing event rides the NEXT seq.
    const copiedMessages = await store.listMessages(copied!.id);
    expect(copiedMessages.map((message) => message.seq)).toEqual(sourceMessages.map((message) => message.seq));
    expect(copiedMessages.map((message) => message.id)).not.toEqual(sourceMessages.map((message) => message.id));

    const copiedTimeline = await store.listTimeline(copied!.id);
    expect(copiedTimeline.map((entry) => entry.rowType)).toEqual(["message", "event", "message", "event"]);
    const trailing = copiedTimeline[3]!;
    if (trailing.rowType !== "event") throw new Error("fixture: expected the trailing event");
    expect(trailing.kind).toBe("branch_forked");
    expect(trailing.payload).toEqual({ at: 0 });
    expect(trailing.seq).toBe(3); // the copied next_seq, then allocated
    expect(await store.getFrontier(copied!.id)).toEqual({ lastPosition: 0, selected: { m: "v" } });

    // A post-copy append CONTINUES the seq sequence (no collision with the
    // copied rows or the trailing event).
    const appended = await store.appendMessage(copied!.id, { role: "user", content: "after" });
    expect(appended.seq).toBe(4);

    // The drop decision leaves the row out entirely.
    const dropped = await store.forkChatThreadToBranch(thread.id, "brnch_2", {
      ...identityRemap({ at: 0 }),
      eventPayload: (kind) => (kind === "rp_sync" ? { drop: true } : { payloadJson: null }),
    });
    const droppedTimeline = await store.listTimeline(dropped!.id);
    expect(droppedTimeline.filter((entry) => entry.rowType === "event" && entry.kind === "rp_sync")).toEqual([]);

    // The SOURCE is untouched — metrics, messages, and timeline stay as they
    // were (the two forks above landed on other rows).
    expect(await store.getById(thread.id)).toMatchObject({ archivedAt: null, branchId: "brnch_1" });
    expect((await store.getById(thread.id))!.contextMetrics).toEqual(METRICS);
    expect(await store.listMessages(thread.id)).toEqual(sourceMessages);
   	expect((await store.listTimeline(thread.id)).length).toBe(3);
  });

  test("the target's same-kind active sibling archives (at-most-one-active), others untouched", async () => {
    const { store } = await setup();
    const source = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc");
    const existing = await store.startNewChatSession("chat_1", "brnch_2", "sidechat-ooc");
    await store.appendMessage(existing.id, { role: "user", content: "old" });

    const copied = await store.forkChatThreadToBranch(source.id, "brnch_2", identityRemap({ at: 0 }));

    const sessions = await store.listSessionsForChat("chat_1", "brnch_2", "sidechat-ooc");
    const active = sessions.filter((session) => session.archivedAt === null);
    expect(active.map((session) => session.id)).toEqual([copied!.id]);
    const archivedSibling = sessions.find((session) => session.id === existing.id);
    expect(archivedSibling!.archivedAt).not.toBeNull(); // archived, not deleted
  });

  test("a missing source → null; a script-owned source → refused", async () => {
    const { store } = await setup();
    expect(await store.forkChatThreadToBranch("thr_missing_sc20", "brnch_2", identityRemap({ at: 0 }))).toBeNull();

    const scriptThread = await store.startNewSession("script_sc20_refused");
    await expect(
      store.forkChatThreadToBranch(scriptThread.id, "brnch_2", identityRemap({ at: 0 })),
    ).rejects.toThrow(/chat-owned source thread/);
  });
});
