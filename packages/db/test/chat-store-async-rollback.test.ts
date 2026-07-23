import { describe, test, expect, beforeEach } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { createDb, type AppDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { ChatStore } from "../src/stores/chat-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ASYNC_TRANSACTION_AUDIT fix-step 2 (chat-store): pins that the three remaining
// chat-store transactions (createChat, deleteBranch, migrateGreetingVariants) are
// truly SYNCHRONOUS bun:sqlite callbacks, so a failure after the first write
// rolls the whole transaction back instead of leaking a partial commit
// (forkBranch was already closed in step 2 via DICE-B12). Each test injects a
// real DB-level failure via a SQLite BEFORE-trigger raising ABORT on the second
// write and asserts the first write rolled back too — the full ChatStore →
// db.transaction → bun:sqlite boundary, not a narrowed helper.

// ─── Test harness ────────────────────────────────────────────────────────────

const FIXED_NOW = "2026-07-21T00:00:00.000Z";

let clockTick = 0;
const testClock: StoreClock = {
  now() {
    clockTick++;
    return new Date(Date.parse(FIXED_NOW) + clockTick).toISOString();
  },
};

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_arb_${String(n).padStart(4, "0")}`;
  },
};

/** Insert the character FK parent with a first message + alternate greetings
 *  (the migration test needs both; the other tests only need the character). */
function bootstrapCharacter(db: AppDb) {
  db.insert(schema.characters).values({
    id: "char_1", name: "TestChar", description: "",
    firstMessage: "main greeting",
    alternateGreetingsJson: JSON.stringify(["alt1", "alt2"]),
    extensionsJson: "{}", tagsJson: "[]",
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
}

let db: AppDb;
let chatStore: ChatStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  bootstrapCharacter(db);
  clockTick = 0;
  idCounters = new Map();
  chatStore = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ChatStore synchronous-transaction rollback (ASYNC_TRANSACTION_AUDIT step 2)", () => {
  test("createChat rolls back the chat insert when the root-branch insert fails", async () => {
    // createChat inserts the chat first, then its root branch. Inject failure
    // on the SECOND write (branch insert) — the chat insert must roll back too.
    db.run(sql`CREATE TRIGGER fail_branch_insert BEFORE INSERT ON chat_branches BEGIN SELECT RAISE(ABORT, 'injected createChat boom'); END`);

    await expect(chatStore.createChat({
      characterId: "char_1", title: "orphan", promptPresetId: null,
    })).rejects.toThrow("injected createChat boom");

    // No orphan chat row, no branch — the chat insert rolled back with the branch.
    expect((await db.select().from(schema.chats).all()).length).toBe(0);
    expect((await db.select().from(schema.chatBranches).all()).length).toBe(0);

    // Control: same call succeeds once the failure is removed, and links both rows.
    db.run(sql`DROP TRIGGER fail_branch_insert`);
    const chat = await chatStore.createChat({
      characterId: "char_1", title: "good", promptPresetId: null,
    });
    expect(chat.title).toBe("good");
    expect(chat.activeBranchId).toBeDefined();
    expect((await db.select().from(schema.chats).all()).length).toBe(1);
    expect((await db.select().from(schema.chatBranches).all()).length).toBe(1);
  });

  test("deleteBranch rolls back the delete + keeps active-branch pointer when reassignment fails", async () => {
    // A chat whose ACTIVE branch is the root, plus a second non-root branch.
    // Deleting the active root triggers the reassignment path (UPDATE chats).
    db.insert(schema.chats).values({
      id: "chat_1", characterId: "char_1", personaId: null,
      activeBranchId: "brnch_1", promptPresetId: null,
      title: "del", summary: "", messageHistoryLimit: 0,
      status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).run();
    db.insert(schema.chatBranches).values({
      id: "brnch_1", chatId: "chat_1", parentBranchId: null,
      forkedFromMessageId: null, label: "main", createdAt: FIXED_NOW,
    }).run();
    db.insert(schema.chatBranches).values({
      id: "brnch_2", chatId: "chat_1", parentBranchId: "brnch_1",
      forkedFromMessageId: null, label: "fork", createdAt: FIXED_NOW,
    }).run();

    // Inject failure on the reassignment (UPDATE chats) — AFTER the branch
    // delete. The delete must roll back too, so the chat never ends up with an
    // active_branch_id pointing at a branch that was just removed.
    db.run(sql`CREATE TRIGGER fail_chat_update BEFORE UPDATE ON chats BEGIN SELECT RAISE(ABORT, 'injected deleteBranch boom'); END`);

    await expect(chatStore.deleteBranch("brnch_1")).rejects.toThrow("injected deleteBranch boom");

    // Both branches still present, active-branch pointer unchanged.
    const branches = await db.select().from(schema.chatBranches)
      .where(eq(schema.chatBranches.chatId, "chat_1")).all();
    expect(branches.length).toBe(2);
    expect(branches.map((b) => b.id).sort()).toEqual(["brnch_1", "brnch_2"]);
    const chat = await db.select().from(schema.chats).where(eq(schema.chats.id, "chat_1")).get();
    expect(chat?.activeBranchId).toBe("brnch_1");
  });

  test("migrateGreetingVariants rolls back the backfill on a mid-tx failure and retries clean", async () => {
    // Legacy state: a chat whose selected greeting was an alternate (index 1),
    // with a first assistant message that has NO variants yet.
    db.insert(schema.chats).values({
      id: "chat_1", characterId: "char_1", personaId: null,
      activeBranchId: "brnch_1", promptPresetId: null,
      title: "legacy", summary: "", messageHistoryLimit: 0,
      selectedGreetingIndex: 1,
      status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).run();
    db.insert(schema.chatBranches).values({
      id: "brnch_1", chatId: "chat_1", parentBranchId: null,
      forkedFromMessageId: null, label: "main", createdAt: FIXED_NOW,
    }).run();
    db.insert(schema.messages).values({
      id: "msg_1", chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", position: 0,
      content: "main greeting", state: "complete",
      createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).run();
    // Sanity: legacy message starts with zero variants.
    expect((await db.select().from(schema.messageVariants).all()).length).toBe(0);

    // The migration backfills: insert initial variant + the two alternates,
    // then sync selection (UPDATE messages.content). Inject failure on that
    // last UPDATE — all the variant inserts inside the tx must roll back.
    db.run(sql`CREATE TRIGGER fail_message_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'injected migrate boom'); END`);

    await expect(chatStore.migrateGreetingVariants()).rejects.toThrow("injected migrate boom");

    // Nothing leaked: the message is still variant-less, content untouched.
    expect((await db.select().from(schema.messageVariants).all()).length).toBe(0);
    const msgAfterRollback = await db.select().from(schema.messages).where(eq(schema.messages.id, "msg_1")).get();
    expect(msgAfterRollback?.content).toBe("main greeting");
    // The legacy selector was NOT reset (the post-loop reset never ran), so a
    // retry sees the same pre-migration state.
    const chatAfterRollback = await db.select().from(schema.chats).where(eq(schema.chats.id, "chat_1")).get();
    expect(chatAfterRollback?.selectedGreetingIndex).toBe(1);

    // Retry from clean: drop the failure and re-run — it now succeeds and
    // backfills the expected variants. This is the "greeting migration retry"
    // property the rollback guarantees (no partial mix to confuse the retry).
    db.run(sql`DROP TRIGGER fail_message_update`);
    const migrated = await chatStore.migrateGreetingVariants();
    expect(migrated).toBeGreaterThanOrEqual(1);

    const variants = await db.select().from(schema.messageVariants)
      .where(eq(schema.messageVariants.messageId, "msg_1"))
      .orderBy(schema.messageVariants.variantIndex).all();
    expect(variants.length).toBe(3); // initial + 2 alternates
    // The legacy selected alternate (index 1) is now the selected variant.
    expect(variants.find((v) => v.isSelected === 1)?.variantIndex).toBe(1);
  });
});
