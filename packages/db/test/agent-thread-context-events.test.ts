import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { ExperienceCopilotStore } from "../src/stores/experience-copilot-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// SC-1 — frozen context events on agent threads. Mirrors the fixtures of
// experience-copilot-chat-owner.test.ts (advancing clock so orderings stay
// unambiguous): chat-owned threads through startNewChatSession (real FK
// parents: character → chat → branch), script threads through startNewSession
// (no parents needed — script_id is a soft link). createDb(":memory:") runs
// the real migrations, so the SC-1 columns + table are present from migration
// 0119.

const FIXED_NOW = "2026-06-15T00:00:00.000Z";
let clockBase = Date.parse(FIXED_NOW);
let clockStep = 0;
function makeClock(): StoreClock {
  return { now: () => new Date(clockBase + clockStep++ * 1000).toISOString() };
}
let idCounter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_sc1_${++idCounter}` };

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
      id: branchId, chatId, parentBranchId: null,
      forkedFromMessageId: null, label: i === 0 ? "main" : "fork", createdAt: FIXED_NOW,
    }).run();
  }
}

async function setup(chatId = "chat_1", branchIds = ["brnch_1", "brnch_2"]) {
  clockStep = 0;
  idCounter = 0;
  const db = await createDb(":memory:");
  bootstrap(db, chatId, branchIds);
  const store = new ExperienceCopilotStore(db, { clock: makeClock(), idGenerator: idGen });
  return { db, store };
}

describe("ExperienceCopilotStore — frozen context events (SC-1)", () => {
  test("chat-owned thread interleaves messages and events on a gapless seq", async () => {
    const { store } = await setup();
    const thread = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc", "Plot talk");

    const first = await store.appendMessage(thread.id, { role: "user", content: "first" });
    const sync = await store.appendContextEvent(thread.id, "rp_sync", { lastPosition: 3 });
    const second = await store.appendMessage(thread.id, { role: "assistant", content: "second" });
    const selection = await store.appendContextEvent(thread.id, "selection_changed", { messageId: "msg_1", variantId: "var_2" });

    // Messages and events draw from ONE counter: 0, 1, 2, 3 — gapless.
    expect(first.seq).toBe(0);
    expect(sync.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(selection.seq).toBe(3);

    const timeline = await store.listTimeline(thread.id);
    expect(timeline.map((entry) => entry.rowType)).toEqual(["message", "event", "message", "event"]);
    expect(timeline.map((entry) => entry.seq)).toEqual([0, 1, 2, 3]);
    // Payloads round-trip; the merged rows carry their own identity + timestamps.
    expect(timeline[0]).toMatchObject({ rowType: "message", role: "user", content: "first", seq: 0 });
    expect(timeline[1]).toMatchObject({ rowType: "event", kind: "rp_sync", seq: 1, payload: { lastPosition: 3 } });
    expect(timeline[3]).toMatchObject({
      rowType: "event", kind: "selection_changed", seq: 3,
      payload: { messageId: "msg_1", variantId: "var_2" },
    });
  });

  test("two chat-owned threads draw independent seq counters", async () => {
    const { store } = await setup();
    const a = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc", "A");
    const b = await store.startNewChatSession("chat_1", "brnch_2", "sidechat-ooc", "B");

    const aMsg = await store.appendMessage(a.id, { role: "user", content: "a1" });
    const bMsg = await store.appendMessage(b.id, { role: "user", content: "b1" });
    const aEvt = await store.appendContextEvent(a.id, "variants_attached", { messageIds: ["msg_1"] });

    expect(aMsg.seq).toBe(0);
    expect(bMsg.seq).toBe(0); // per-thread counter, not a global one
    expect(aEvt.seq).toBe(1);
    expect((await store.listTimeline(b.id)).map((entry) => entry.seq)).toEqual([0]);
  });

  test("script thread leaves seq NULL everywhere and keeps created_at ordering unchanged", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewSession("script_sc1", "Editor");

    const first = await store.appendMessage(thread.id, { role: "user", content: "first" });
    const event = await store.appendContextEvent(thread.id, "variants_attached", { messageIds: ["msg_1"] });
    const second = await store.appendMessage(thread.id, { role: "assistant", content: "second" });

    // Script threads neither consume nor allocate seq.
    expect(first.seq).toBeNull();
    expect(event.seq).toBeNull();
    expect(second.seq).toBeNull();
    const rawThread = db
      .select({ nextSeq: schema.experienceCopilotThreads.nextSeq })
      .from(schema.experienceCopilotThreads)
      .where(eq(schema.experienceCopilotThreads.id, thread.id))
      .get();
    expect(rawThread?.nextSeq).toBeNull();

    // The merged timeline orders all-NULL-seq rows by createdAt + id — the
    // message subset must match listMessages exactly (the unit's
    // must-stay-true: script ordering is unchanged).
    const timeline = await store.listTimeline(thread.id);
    expect(timeline.map((entry) => entry.rowType)).toEqual(["message", "event", "message"]);
    const timelineMessageIds = timeline
      .filter((entry) => entry.rowType === "message")
      .map((entry) => (entry.rowType === "message" ? entry.id : null));
    const listed = await store.listMessages(thread.id);
    expect(timelineMessageIds).toEqual(listed.map((m) => m.id));
  });

  test("deleting the thread cascades its context events (and messages)", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc");
    await store.appendMessage(thread.id, { role: "user", content: "m" });
    await store.appendContextEvent(thread.id, "branch_forked", { from: "brnch_1", to: "brnch_2" });

    db.delete(schema.experienceCopilotThreads)
      .where(eq(schema.experienceCopilotThreads.id, thread.id))
      .run();

    expect(await db.select().from(schema.agentThreadContextEvents).all()).toEqual([]);
    expect(await db.select().from(schema.experienceCopilotMessages).all()).toEqual([]);
  });

  test("malformed payload_json → event skipped from the timeline, logger.warn fires, never throws", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc");
    const good = await store.appendContextEvent(thread.id, "rp_sync", { lastPosition: 1 });
    await store.appendMessage(thread.id, { role: "user", content: "m" });

    // A corrupted row, written past the store (the defensive-parse contract is
    // about what is ON DISK, not what the store writes).
    db.insert(schema.agentThreadContextEvents).values({
      id: "evt_corrupt_sc1",
      threadId: thread.id,
      seq: 99,
      kind: "rp_sync",
      payloadJson: "{not json",
      createdAt: FIXED_NOW,
    }).run();

    // Patch console.warn to observe the logger (bun:test spyOn does not
    // intercept native console methods — verified empirically); restored on
    // both paths per the test-hygiene restore rule.
    const originalWarn = console.warn;
    const warnCalls: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args.map(String).join(" "));
    };
    let timeline;
    try {
      timeline = await store.listTimeline(thread.id);
    } finally {
      console.warn = originalWarn;
    }

    // The corrupted event (seq 99) is skipped; the good rows survive in seq
    // order — the event was appended first (seq 0), the message second (seq 1).
    expect(timeline?.map((entry) => entry.rowType)).toEqual(["event", "message"]);
    expect(timeline?.[0]).toMatchObject({ rowType: "event", id: good.id, seq: 0 });
    expect(warnCalls.some((msg) => msg.includes("malformed payload_json"))).toBe(true);
  });

  test("frontier round-trip: null until the first setFrontier, wholesale replace afterwards", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc");

    // NULL until the first sync.
    expect(await store.getFrontier(thread.id)).toBeNull();

    const first = { lastPosition: 3, selected: { msg_1: "var_1", msg_2: "var_3" } };
    await store.setFrontier(thread.id, first);
    expect(await store.getFrontier(thread.id)).toEqual(first);

    // Wholesale replace — the second snapshot fully wins.
    const second = { lastPosition: 5, selected: { msg_1: "var_2" } };
    await store.setFrontier(thread.id, second);
    expect(await store.getFrontier(thread.id)).toEqual(second);

    // A nonexistent thread reads null (no row to parse).
    expect(await store.getFrontier("no_such_thread")).toBeNull();

    // Corrupted on-disk JSON → null + warn, never throws (defensive parse).
    db.update(schema.experienceCopilotThreads)
      .set({ rpFrontierJson: "{broken" })
      .where(eq(schema.experienceCopilotThreads.id, thread.id))
      .run();
    const originalWarn = console.warn;
    const warnCalls: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args.map(String).join(" "));
    };
    try {
      expect(await store.getFrontier(thread.id)).toBeNull();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnCalls.some((msg) => msg.includes("rp_frontier_json"))).toBe(true);
  });
});
