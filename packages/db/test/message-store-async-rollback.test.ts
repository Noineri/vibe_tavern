import { describe, test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { createDb, type AppDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { MessageStore } from "../src/stores/message-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ASYNC_TRANSACTION_AUDIT fix-step 1 (message-store): pins that each of the
// message-store write transactions is a truly SYNCHRONOUS bun:sqlite callback,
// so a failure after the first write rolls the whole transaction back instead
// of leaking a partial commit (the drizzle-orm 0.38.4 async-callback hole).
//
// Each test injects a real DB-level failure (a SQLite BEFORE-trigger raising
// ABORT on the second write) and asserts the FIRST write was rolled back too.
// This exercises the full MessageStore → db.transaction → bun:sqlite boundary
// (no narrowing to a pure helper) — the same boundary the audit names.

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

/** Minimum FK parents so MessageStore can operate: character → chat → branch.
 *  createDb(":memory:") runs the real migrations, so the schema is live. */
function bootstrap(db: AppDb) {
  db.insert(schema.characters).values({
    id: "char_1", name: "TestChar", description: "",
    alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.chats).values({
    id: "chat_1", characterId: "char_1", personaId: null,
    activeBranchId: "brnch_1", promptPresetId: null,
    title: "Rollback chat", summary: "", messageHistoryLimit: 0,
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.chatBranches).values({
    id: "brnch_1", chatId: "chat_1", parentBranchId: null,
    forkedFromMessageId: null, label: "main", createdAt: FIXED_NOW,
  }).run();
}

let db: AppDb;
let messages: MessageStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  bootstrap(db);
  clockTick = 0;
  idCounters = new Map();
  messages = new MessageStore(db, { clock: testClock, idGenerator: testIdGen });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("MessageStore synchronous-transaction rollback (ASYNC_TRANSACTION_AUDIT step 1)", () => {
  test("addMessage rolls back the message insert when the variant insert fails", async () => {
    // Inject a DB-level failure on the SECOND write (variant insert). addMessage
    // inserts the message first, then its variants — the trigger fires on the
    // variant insert, after the message row already landed inside the tx.
    db.run(sql`CREATE TRIGGER fail_variant_insert BEFORE INSERT ON message_variants BEGIN SELECT RAISE(ABORT, 'injected addMessage boom'); END`);

    await expect(messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "must not persist",
      variants: ["a", "b"], selectedVariantIndex: 0,
    })).rejects.toThrow("injected addMessage boom");

    // Nothing leaked: the message insert rolled back together with the variant
    // insert (the behavior the async hole used to break).
    expect((await db.select().from(schema.messages).all()).length).toBe(0);
    expect((await db.select().from(schema.messageVariants).all()).length).toBe(0);

    // Control: same call succeeds once the failure is removed.
    db.run(sql`DROP TRIGGER fail_variant_insert`);
    const ok = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "a", variants: ["a", "b"],
    });
    expect(ok.content).toBe("a");
  });

  test("addMessagesBatch rolls back every batched insert when a variant chunk fails", async () => {
    // A prior message exists OUTSIDE the batch tx (already committed) — it must
    // survive the batch's rollback intact.
    await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "user", authorType: "user", content: "prior",
    });
    const priorMsgCount = (await db.select().from(schema.messages).all()).length;
    const priorVarCount = (await db.select().from(schema.messageVariants).all()).length;
    expect(priorMsgCount).toBe(1);
    expect(priorVarCount).toBe(1);

    // addMessagesBatch inserts all messages first, then all variants — the
    // trigger fires on the first variant chunk, after the batch's message
    // rows already landed inside the tx.
    db.run(sql`CREATE TRIGGER fail_variant_insert BEFORE INSERT ON message_variants BEGIN SELECT RAISE(ABORT, 'injected batch boom'); END`);

    await expect(messages.addMessagesBatch([
      { chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", variants: [{ content: "m1" }] },
      { chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", variants: [{ content: "m2" }] },
    ])).rejects.toThrow("injected batch boom");

    // The whole batch rolled back: counts are unchanged from the prior state.
    expect((await db.select().from(schema.messages).all()).length).toBe(priorMsgCount);
    expect((await db.select().from(schema.messageVariants).all()).length).toBe(priorVarCount);
  });

  test("addVariant preserves the prior selection when the new variant insert fails", async () => {
    // One selected variant exists.
    const msg = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "orig",
    });
    const origVariant = (await messages.getVariants(msg.id))[0]!;
    expect(origVariant.isSelected).toBeTrue();

    // addVariant: (1) deselect all existing, (2) insert the new variant,
    // (3) sync messages.content. Inject failure on step 2 — step 1's deselect
    // must roll back, restoring the original selection.
    db.run(sql`CREATE TRIGGER fail_variant_insert BEFORE INSERT ON message_variants BEGIN SELECT RAISE(ABORT, 'injected addVariant boom'); END`);

    await expect(messages.addVariant(msg.id, "challenger")).rejects.toThrow("injected addVariant boom");

    const variantsAfter = await messages.getVariants(msg.id);
    expect(variantsAfter.length).toBe(1);
    expect(variantsAfter[0]!.id).toBe(origVariant.id);
    // The deselected prior variant is selected again — no partial "nothing
    // selected" state leaked by the async hole.
    expect(variantsAfter[0]!.isSelected).toBeTrue();
    expect(variantsAfter[0]!.content).toBe("orig");
    // messages.content (updated in step 3) also rolled back.
    expect((await messages.getMessageById(msg.id))?.content).toBe("orig");
  });

  test("deleteVariant rolls back the delete + re-compaction when an index update fails", async () => {
    // Three variants, index 1 selected.
    const msg = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant", content: "v1",
      variants: ["v0", "v1", "v2"], selectedVariantIndex: 1,
    });
    const before = await messages.getVariants(msg.id);
    expect(before.length).toBe(3);
    const beforeIds = before.map((v) => v.id);
    const beforeSelected = before.find((v) => v.isSelected)!.variantIndex;

    // deleteVariant: (1) DELETE the target, (2) re-compact indexes via UPDATEs,
    // (3) sync messages.content. Inject failure on the FIRST re-compaction
    // UPDATE (step 2) — the DELETE (step 1) must roll back too.
    db.run(sql`CREATE TRIGGER fail_variant_update BEFORE UPDATE ON message_variants BEGIN SELECT RAISE(ABORT, 'injected deleteVariant boom'); END`);

    // Deleting the middle variant triggers re-compaction of the remaining two.
    await expect(messages.deleteVariant(msg.id, 1)).rejects.toThrow("injected deleteVariant boom");

    // The whole transaction rolled back: all three variants survive with their
    // original ids, indexes, and selection. No "6/5" sparse-index leak.
    const after = await messages.getVariants(msg.id);
    expect(after.length).toBe(3);
    expect(after.map((v) => v.id)).toEqual(beforeIds);
    expect(after.map((v) => v.variantIndex)).toEqual([0, 1, 2]);
    expect(after.find((v) => v.isSelected)!.variantIndex).toBe(beforeSelected);
    expect((await messages.getMessageById(msg.id))?.content).toBe("v1");
  });
});
