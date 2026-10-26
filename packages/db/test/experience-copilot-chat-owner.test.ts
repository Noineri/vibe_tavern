import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { ExperienceCopilotStore } from "../src/stores/experience-copilot-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// SC-0a — chat-owned agent threads. Same store, same table, new owner: a
// (chat, branch, agent kind) triple instead of a script id. Mirrors the
// fixtures of experience-copilot-store.test.ts (advancing clock so list
// orderings stay unambiguous) plus the character → chat → branch bootstrap
// message-store.test.ts uses — chat-owned rows carry real FKs, so the parent
// rows must exist and cascade deletes are testable.

const FIXED_NOW = "2026-06-15T00:00:00.000Z";
let clockBase = Date.parse(FIXED_NOW);
let clockStep = 0;
function makeClock(): StoreClock {
  return { now: () => new Date(clockBase + clockStep++ * 1000).toISOString() };
}
let idCounter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_chatown_${++idCounter}` };

/** character → chat → branches. createDb(":memory:") runs the real migrations,
 *  so the SC-0a columns + partial unique index are present from migration 0115. */
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
  const db = await createDb(":memory:");
  bootstrap(db, chatId, branchIds);
  const store = new ExperienceCopilotStore(db, { clock: makeClock(), idGenerator: idGen });
  return { db, store };
}

describe("ExperienceCopilotStore — chat-owned threads (SC-0a)", () => {
  test("startNewChatSession creates the first active thread for a (chat, branch, kind) triple", async () => {
    const { store } = await setup();
    const thread = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc", "Plot talk");

    expect(thread.archivedAt).toBeNull();
    expect(thread.chatId).toBe("chat_1");
    expect(thread.branchId).toBe("brnch_1");
    expect(thread.agentKind).toBe("sidechat-ooc");
    // A chat-owned thread is owned by the chat alone — no script/draft owner.
    expect(thread.scriptId).toBeNull();
    expect(thread.draftSessionId).toBeNull();

    const active = await store.getActiveForChat("chat_1", "brnch_1", "sidechat-ooc");
    expect(active?.id).toBe(thread.id);
  });

  test("startNewChatSession archives the prior active sibling — one active per (chat, branch, kind)", async () => {
    const { store } = await setup();
    const first = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc", "First");
    const second = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc", "Second");

    expect(second.archivedAt).toBeNull();
    expect((await store.getById(first.id))?.archivedAt).not.toBeNull();

    const sessions = await store.listSessionsForChat("chat_1", "brnch_1", "sidechat-ooc");
    expect(sessions).toHaveLength(2);
    const actives = sessions.filter((s) => s.archivedAt === null);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.id).toBe(second.id);
  });

  test("two agent kinds on one branch coexist — the unique triple includes the kind", async () => {
    const { store } = await setup();
    const ooc = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc");
    const other = await store.startNewChatSession("chat_1", "brnch_1", "other-kind");

    // Both stay active at once: the at-most-one-active invariant is per
    // (chat, branch, kind), not per branch.
    expect(ooc.archivedAt).toBeNull();
    expect(other.archivedAt).toBeNull();
    expect((await store.getActiveForChat("chat_1", "brnch_1", "sidechat-ooc"))?.id).toBe(ooc.id);
    expect((await store.getActiveForChat("chat_1", "brnch_1", "other-kind"))?.id).toBe(other.id);

    // Same kind on another branch is a different triple too.
    const forked = await store.startNewChatSession("chat_1", "brnch_2", "sidechat-ooc");
    expect(forked.archivedAt).toBeNull();
    expect((await store.getActiveForChat("chat_1", "brnch_1", "sidechat-ooc"))?.id).toBe(ooc.id);
  });

  test("startNewChatSession rejects an empty kind (agent_kind required when chat_id is set)", async () => {
    const { store } = await setup();
    await expect(store.startNewChatSession("chat_1", "brnch_1", "")).rejects.toThrow();
  });

  test("listSessionsForChat is scoped to the exact triple — other kinds, branches, and scripts never appear", async () => {
    const { store } = await setup();
    await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc", "target");
    await store.startNewChatSession("chat_1", "brnch_1", "other-kind", "other kind");
    await store.startNewChatSession("chat_1", "brnch_2", "sidechat-ooc", "other branch");
    const scriptThread = await store.startNewSession("script_shared", "script session");

    const listed = await store.listSessionsForChat("chat_1", "brnch_1", "sidechat-ooc");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.title).toBe("target");

    // And the chat thread never appears in the script listing (vice versa pin).
    const scriptListed = await store.listSessions("script_shared");
    expect(scriptListed).toHaveLength(1);
    expect(scriptListed[0]!.id).toBe(scriptThread.id);
    expect(scriptListed[0]!.chatId).toBeNull();
    expect(scriptListed[0]!.branchId).toBeNull();
    expect(scriptListed[0]!.agentKind).toBeNull();
  });

  test("activate on a chat thread archives its chat siblings only; archive and rename serve chat owners", async () => {
    const { store } = await setup();
    const first = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc", "First");
    const second = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc", "Second");
    // Sibling of a DIFFERENT kind on the same branch must survive activation.
    const otherKindActive = await store.startNewChatSession("chat_1", "brnch_1", "other-kind", "Other");
    // A script-owned active thread must survive too (different owner entirely).
    const scriptActive = await store.startNewSession("script_neighbor", "Script session");

    const reactivated = await store.activate(first.id);
    expect(reactivated?.archivedAt).toBeNull();
    expect((await store.getById(second.id))?.archivedAt).not.toBeNull();
    expect((await store.getById(otherKindActive.id))?.archivedAt).toBeNull();
    expect((await store.getById(scriptActive.id))?.archivedAt).toBeNull();
    expect(
      (await store.listSessionsForChat("chat_1", "brnch_1", "sidechat-ooc"))
        .filter((s) => s.archivedAt === null),
    ).toHaveLength(1);

    // Archive: chat thread leaves the active slot.
    const archived = await store.archive(first.id);
    expect(archived?.archivedAt).not.toBeNull();
    expect(await store.getActiveForChat("chat_1", "brnch_1", "sidechat-ooc")).toBeNull();

    // Rename: works on chat threads, does not touch archived_at.
    const renamed = await store.renameSession(first.id, "Renamed plot talk");
    expect(renamed?.title).toBe("Renamed plot talk");
    expect(renamed?.archivedAt).not.toBeNull();
  });

  test("DB layer: the partial unique index rejects a second active for the same (chat, branch, kind)", async () => {
    const { db, store } = await setup();
    await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc");

    // Raw insert of a second active for the SAME triple violates the partial
    // unique index — the DB-layer half of the invariant, independent of the
    // store's transaction guard. Synchronous .run() → synchronous throw.
    expect(() => {
      db.insert(schema.experienceCopilotThreads).values({
        id: "raw_chat_dup", scriptId: null, draftSessionId: null,
        chatId: "chat_1", branchId: "brnch_1", agentKind: "sidechat-ooc",
        title: "dup", archivedAt: null,
        createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
      }).run();
    }).toThrow();

    // Same kind + branch but ARCHIVED is fine (the index is active-scoped)…
    db.insert(schema.experienceCopilotThreads).values({
      id: "raw_chat_archived", scriptId: null, draftSessionId: null,
      chatId: "chat_1", branchId: "brnch_1", agentKind: "sidechat-ooc",
      title: "archived dup", archivedAt: FIXED_NOW,
      createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).run();
    // …and another active with a different kind does not collide.
    db.insert(schema.experienceCopilotThreads).values({
      id: "raw_chat_other_kind", scriptId: null, draftSessionId: null,
      chatId: "chat_1", branchId: "brnch_1", agentKind: "other-kind",
      title: "other kind", archivedAt: null,
      createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).run();

    const actives = (await store.listSessionsForChat("chat_1", "brnch_1", "sidechat-ooc"))
      .filter((s) => s.archivedAt === null);
    expect(actives).toHaveLength(1);
  });

  test("deleting the chat cascades its agent threads and their messages", async () => {
    const { db, store } = await setup();
    const thread = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc");
    await store.appendMessage(thread.id, { role: "user", content: "discuss the plot" });
    await store.appendMessage(thread.id, { role: "assistant", content: "sure" });
    // A script-owned thread survives an unrelated chat delete.
    const scriptThread = await store.startNewSession("script_survivor", "T");

    db.delete(schema.chats).where(eq(schema.chats.id, "chat_1")).run();

    expect((await db.select().from(schema.experienceCopilotThreads).all()).map((r) => r.id))
      .toEqual([scriptThread.id]);
    expect(await db.select().from(schema.experienceCopilotMessages).all()).toEqual([]);
  });

  test("deleting the branch cascades only that branch's threads and messages", async () => {
    const { db, store } = await setup();
    const doomed = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc", "on branch 1");
    await store.appendMessage(doomed.id, { role: "user", content: "on the doomed branch" });
    const survivor = await store.startNewChatSession("chat_1", "brnch_2", "sidechat-ooc", "on branch 2");
    await store.appendMessage(survivor.id, { role: "user", content: "on the surviving branch" });

    db.delete(schema.chatBranches).where(eq(schema.chatBranches.id, "brnch_1")).run();

    const threadsLeft = await db.select().from(schema.experienceCopilotThreads).all();
    expect(threadsLeft.map((r) => r.id)).toEqual([survivor.id]);
    const messagesLeft = await db.select().from(schema.experienceCopilotMessages).all();
    expect(messagesLeft.map((r) => r.threadId)).toEqual([survivor.id]);
    // The chat row itself survives a branch delete.
    expect(await db.select().from(schema.chats).where(eq(schema.chats.id, "chat_1")).all()).toHaveLength(1);
    expect((await store.getActiveForChat("chat_1", "brnch_2", "sidechat-ooc"))?.id).toBe(survivor.id);
  });

  test("script paths unchanged: startNewSession keeps chat owner columns NULL and script actives intact", async () => {
    const { store } = await setup();
    const scriptThread = await store.startNewSession("script_classic", "Classic");

    // The script owner path never populates the chat-owner columns.
    const reloaded = await store.getById(scriptThread.id);
    expect(reloaded?.chatId).toBeNull();
    expect(reloaded?.branchId).toBeNull();
    expect(reloaded?.agentKind).toBeNull();

    // getActiveForChat never sees script threads, getActive never sees chat ones.
    await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc");
    expect(await store.getActive("script_classic")).not.toBeNull();
    expect((await store.listSessions("script_classic")).filter((s) => s.chatId !== null)).toHaveLength(0);
  });

  test("startNewChatSession seeds autoCompact from the kind default param (AP-20): absent keeps the column default (on), false is honored, and each row freezes its creation value", async () => {
    const { store } = await setup();
    // Absent param — the pre-AP-20 call shape: the column default (on).
    const defaulted = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc", "Defaulted");
    expect(defaulted.autoCompact).toBe(true);
    // The kind's default off seeds the new row's toggle off (fresh triple so
    // the archive-then-insert never interferes).
    const off = await store.startNewChatSession("chat_1", "brnch_2", "sidechat-ooc", "Off", false);
    expect(off.autoCompact).toBe(false);
    expect(await store.getAutoCompact(off.id)).toBe(false);
    // A later session born with a different default never rewrites the
    // existing row — each thread freezes the value it was created with (the
    // archive of the `defaulted` sibling touches archived_at only).
    const second = await store.startNewChatSession("chat_1", "brnch_1", "sidechat-ooc", "Second", false);
    expect(second.autoCompact).toBe(false);
    expect((await store.getById(defaulted.id))?.autoCompact).toBe(true);
    expect((await store.getById(off.id))?.autoCompact).toBe(false);
  });
});
