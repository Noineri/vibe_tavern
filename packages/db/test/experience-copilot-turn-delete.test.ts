import { describe, expect, test } from "bun:test";
import { createDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { ExperienceCopilotStore } from "../src/stores/experience-copilot-store.js";
import { deleteCopilotTurn } from "../src/stores/experience-copilot-turn-delete.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// AP-8 (AGENT_SHELL_POLISH Wave 3) — the store half of "delete a turn": the
// sibling `deleteCopilotTurn` (experience-copilot-turn-delete.ts — the
// fork-copy sibling pattern) resolves the ENCLOSING turn around `messageId`
// (a turn = the rows after a user row up to the next user row; continuation
// rows after an ask/permission answer belong to the same turn, since the
// answer rewrites the wait-tool row instead of appending a user row) and
// deletes its message rows, optionally with the user row. Pins: the
// resolution rule from ANY row of the turn, the user-row semantics
// (includeUserMessage), the digest floor refusal (covered rows, the anchor
// row, the digest row itself), and the chat-owned guard (context events and
// the frontier are NEVER touched; surviving events keep their seq and future
// appends continue the counter). Mirrors the fixtures of
// experience-copilot-fork-thread.test.ts (character → chat → branch bootstrap
// with real FKs for the chat-owned case; advancing clock so orderings stay
// unambiguous).

const FIXED_NOW = "2026-06-15T00:00:00.000Z";
let clockBase = Date.parse(FIXED_NOW);
let clockStep = 0;
function makeClock(): StoreClock {
  return { now: () => new Date(clockBase + clockStep++ * 1000).toISOString() };
}
let idCounter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_turndel_${++idCounter}` };

/** character → chat → branches. createDb(":memory:") runs the real
 *  migrations, so the SC-0a/SC-1 columns are present. */
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

async function setup(chatId = "chat_1", branchIds = ["brnch_1"]) {
  clockStep = 0;
  const db = await createDb(":memory:");
  bootstrap(db, chatId, branchIds);
  const store = new ExperienceCopilotStore(db, { clock: makeClock(), idGenerator: idGen });
  return { db, store };
}

/** Seed a script-owned thread with two plain turns (user + assistant text). */
async function seedTwoTurns(store: ExperienceCopilotStore) {
  const thread = await store.startNewSession("script_ap8_store", "T");
  const u1 = await store.appendMessage(thread.id, { role: "user", content: "one" });
  const a1 = await store.appendMessage(thread.id, { role: "assistant", content: "answer one" });
  const u2 = await store.appendMessage(thread.id, { role: "user", content: "two" });
  const a2 = await store.appendMessage(thread.id, { role: "assistant", content: "answer two" });
  return { thread, u1, a1, u2, a2 };
}

describe("deleteCopilotTurn (AP-8)", () => {
  test("assistant turn: messageId on an assistant row deletes that turn only — the user rows and neighbors stay", async () => {
    const { db, store } = await setup();
    const { thread, u1, a1, u2, a2 } = await seedTwoTurns(store);
    const before = (await store.getById(thread.id))!.updatedAt;

    const result = await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, a2.id, false);

    expect(result).toEqual({
      status: "deleted",
      deletedMessageIds: [a2.id],
      deletedUserMessageId: null,
    });
    const left = await store.listMessages(thread.id);
    expect(left.map((m) => m.id)).toEqual([u1.id, a1.id, u2.id]);
    // The thread row survives and surfaces as touched.
    expect((await store.getById(thread.id))!.updatedAt > before).toBe(true);

    // Missing thread / missing message are distinct statuses.
    expect(await deleteCopilotTurn({ db, clock: makeClock() }, "thr_missing_ap8", a1.id, false))
      .toEqual({ status: "missing-thread" });
    expect(await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, "msg_missing_ap8", false))
      .toEqual({ status: "missing-message" });
  });

  test("exchange: includeUserMessage=true deletes the user row with its turn; false on a user row is refused", async () => {
    const { db, store } = await setup();
    const { thread, u1, a1, u2, a2 } = await seedTwoTurns(store);

    // The user's own delete on their message row: refused without the flag
    // (nothing written — the refusal leaves the thread untouched).
    expect(await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, u2.id, false))
      .toEqual({ status: "refused-user-row" });
    expect((await store.listMessages(thread.id)).map((m) => m.id)).toEqual([u1.id, a1.id, u2.id, a2.id]);

    // With the flag: the user row + its whole turn go, in timeline order.
    const result = await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, u2.id, true);
    expect(result).toEqual({
      status: "deleted",
      deletedMessageIds: [u2.id, a2.id],
      deletedUserMessageId: u2.id,
    });
    expect((await store.listMessages(thread.id)).map((m) => m.id)).toEqual([u1.id, a1.id]);

    // An unanswered user row (no assistant rows yet) deletes alone.
    const u3 = await store.appendMessage(thread.id, { role: "user", content: "three" });
    const alone = await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, u3.id, true);
    expect(alone).toEqual({
      status: "deleted",
      deletedMessageIds: [u3.id],
      deletedUserMessageId: u3.id,
    });
    expect((await store.listMessages(thread.id)).map((m) => m.id)).toEqual([u1.id, a1.id]);
  });

  test("continuation turn after an ask answer: carrier + tool row + continuation text are ONE turn (deleted together, pairing never split)", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewSession("script_ap8_ask", "T");
    const u1 = await store.appendMessage(thread.id, { role: "user", content: "draft a rule" });
    // The stopped turn's rows: a tool-call carrier, the ask_user result row
    // (already rewritten to its answer — setToolResultOutput, TAG-5 style B),
    // and the continuation's final assistant text. No user row between them.
    const carrier = await store.appendMessage(thread.id, {
      role: "assistant",
      content: "",
      toolCallsJson: JSON.stringify([
        { type: "tool-call", toolCallId: "tc_ask_ap8", toolName: "ask_user", input: { question: "Blue or green?" } },
      ]),
    });
    const marker = await store.appendMessage(thread.id, {
      role: "tool",
      content: JSON.stringify({ toolName: "ask_user", output: { status: "awaiting_answer", question: "Blue or green?" } }),
      toolCallId: "tc_ask_ap8",
    });
    await store.setToolResultOutput(thread.id, "tc_ask_ap8", {
      toolName: "ask_user",
      output: { status: "answered", answer: "blue" },
    });
    const cont = await store.appendMessage(thread.id, { role: "assistant", content: "continuation after the answer" });
    // The next turn.
    const u2 = await store.appendMessage(thread.id, { role: "user", content: "next" });
    const a2 = await store.appendMessage(thread.id, { role: "assistant", content: "answer next" });

    // messageId on the CONTINUATION text resolves the whole turn (the answer
    // never created a user row, so the turn spans back to u1's boundary).
    const result = await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, cont.id, false);
    expect(result).toEqual({
      status: "deleted",
      deletedMessageIds: [carrier.id, marker.id, cont.id],
      deletedUserMessageId: null,
    });
    const left = await store.listMessages(thread.id);
    expect(left.map((m) => m.id)).toEqual([u1.id, u2.id, a2.id]);
    // The pair left together: no tool row without its carrier remains, and a
    // stale answer for the deleted row finds nothing to rewrite.
    expect(await store.setToolResultOutput(thread.id, "tc_ask_ap8", {
      toolName: "ask_user",
      output: { status: "answered", answer: "red" },
    })).toBeNull();
  });

  test("a turn with a permission call: messageId on the permission tool row resolves the same enclosing turn", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewSession("script_ap8_perm", "T");
    const u1 = await store.appendMessage(thread.id, { role: "user", content: "read the prompt" });
    const carrier = await store.appendMessage(thread.id, {
      role: "assistant",
      content: "",
      toolCallsJson: JSON.stringify([
        { type: "tool-call", toolCallId: "tc_perm_ap8", toolName: "read_message_prompt", input: { position: 3 } },
      ]),
    });
    const permissionRow = await store.appendMessage(thread.id, {
      role: "tool",
      content: JSON.stringify({ toolName: "read_message_prompt", output: { status: "awaiting_permission", position: 3 } }),
      toolCallId: "tc_perm_ap8",
    });
    const u2 = await store.appendMessage(thread.id, { role: "user", content: "next" });
    const a2 = await store.appendMessage(thread.id, { role: "assistant", content: "answer next" });

    // messageId on the TOOL row: same enclosing turn — carrier and permission
    // row leave together, the user row stays (includeUserMessage=false).
    const result = await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, permissionRow.id, false);
    expect(result).toEqual({
      status: "deleted",
      deletedMessageIds: [carrier.id, permissionRow.id],
      deletedUserMessageId: null,
    });
    expect((await store.listMessages(thread.id)).map((m) => m.id)).toEqual([u1.id, u2.id, a2.id]);
  });

  test("digest floor: covered turns, the anchor turn, and the digest row itself are refused; post-digest turns delete fine", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewSession("script_ap8_digest", "T");
    const u1 = await store.appendMessage(thread.id, { role: "user", content: "one" });
    const a1 = await store.appendMessage(thread.id, { role: "assistant", content: "answer one" });
    const u2 = await store.appendMessage(thread.id, { role: "user", content: "two" });
    const a2 = await store.appendMessage(thread.id, { role: "assistant", content: "answer two" });
    // A compaction digest exactly as the compaction service persists it
    // (CM-5): role "digest", toolCallId overloaded with the FIRST KEPT
    // message's id — here u2.
    const digest = await store.appendMessage(thread.id, {
      role: "digest",
      content: "Summary of the early turns.",
      toolCallId: u2.id,
    });
    // A turn born after the compaction.
    const u3 = await store.appendMessage(thread.id, { role: "user", content: "three" });
    const a3 = await store.appendMessage(thread.id, { role: "assistant", content: "answer three" });
    const seed = [u1.id, a1.id, u2.id, a2.id, digest.id, u3.id, a3.id];

    // The covered turn (strictly before the anchor u2) is refused.
    expect(await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, a1.id, false))
      .toEqual({ status: "refused-digest" });
    // So is deleting its user row with the flag.
    expect(await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, u1.id, true))
      .toEqual({ status: "refused-digest" });
    // The turn that STARTS at the anchor row is refused — deleting the anchor
    // would dangle the digest (the floor row must survive).
    expect(await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, u2.id, true))
      .toEqual({ status: "refused-digest" });
    expect(await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, a2.id, false))
      .toEqual({ status: "refused-digest" });
    // The digest row itself is not a deletable turn (its enclosing span is
    // the anchor turn — refused with the same floor error).
    expect(await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, digest.id, false))
      .toEqual({ status: "refused-digest" });
    // Every refusal left the thread untouched.
    expect((await store.listMessages(thread.id)).map((m) => m.id)).toEqual(seed);

    // The post-digest turn deletes fine — the digest row and its floor stay.
    const result = await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, u3.id, true);
    expect(result).toEqual({
      status: "deleted",
      deletedMessageIds: [u3.id, a3.id],
      deletedUserMessageId: u3.id,
    });
    expect((await store.listMessages(thread.id)).map((m) => m.id))
      .toEqual([u1.id, a1.id, u2.id, a2.id, digest.id]);
  });

  test("chat-owned exchange: only message rows go — the rp_sync event keeps its seq, the frontier stays, appends continue the counter", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc");
    const u1 = await store.appendMessage(thread.id, { role: "user", content: "discuss the plot" });
    const evt = await store.appendContextEvent(thread.id, "rp_sync", {
      fromPosition: 0,
      toPosition: 1,
      messages: [{ id: "m1", position: 0, role: "user", authorName: null, variantId: null, model: null, preset: null, text: "RP line" }],
    });
    const a1 = await store.appendMessage(thread.id, { role: "assistant", content: "sure" });
    await store.setFrontier(thread.id, { lastPosition: 1, selected: { m1: "v1" } });

    // Delete the whole exchange (user row + turn): the EVENT survives in
    // place with its original seq — frozen RP the frontier has passed must
    // never leave with a turn (the next sync starts from the advanced
    // frontier; a deleted rp_sync would drop that RP from context for good).
    const result = await deleteCopilotTurn({ db, clock: makeClock() }, thread.id, a1.id, true);
    expect(result).toEqual({
      status: "deleted",
      deletedMessageIds: [u1.id, a1.id],
      deletedUserMessageId: u1.id,
    });

    const timeline = await store.listTimeline(thread.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.rowType).toBe("event");
    expect(timeline[0]!.id).toBe(evt.id);
    expect(timeline[0]!.seq).toBe(1);
    // The frontier is untouched by a message-row delete.
    expect(await store.getFrontier(thread.id)).toEqual({ lastPosition: 1, selected: { m1: "v1" } });

    // The seq counter is a thread-row counter (never max(seq)): the next
    // append continues past every allocated seq — no reuse, no collision.
    const next = await store.appendMessage(thread.id, { role: "user", content: "fresh" });
    expect(next.seq).toBe(3);
    expect((await store.listTimeline(thread.id)).map((e) => e.seq)).toEqual([1, 3]);
  });
});
