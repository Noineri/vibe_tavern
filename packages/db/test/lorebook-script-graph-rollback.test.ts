import { describe, test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { createDb, type AppDb } from "../src/db-connection.js";
import { LorebookStore } from "../src/stores/lorebook-store.js";
import { ScriptStore } from "../src/stores/script-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ASYNC_TRANSACTION_AUDIT fix-step 3 (lorebook + script graph replacement):
// pins that the link/entry replacement transactions are truly SYNCHRONOUS
// bun:sqlite callbacks, so a failure on a LATER link/entry insert rolls the
// delete back too — the prior complete graph survives instead of being wiped
// to empty (the drizzle-orm 0.38.4 async-callback hole). Also pins the
// duplicate-(targetType,targetId) dedup added to setLinks: the junction tables
// have a composite PK on those columns, so a duplicate tuple would violate the
// PK on the second insert after the old set was already deleted.

// ─── Test harness ────────────────────────────────────────────────────────────

const FIXED_NOW = "2026-07-21T00:00:00.000Z";

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_arb_${String(n).padStart(4, "0")}`;
  },
};
const testClock: StoreClock = { now: () => FIXED_NOW };

let db: AppDb;
let lore: LorebookStore;
let scripts: ScriptStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  idCounters = new Map();
  // content: null skips syncFile — these tests exercise the DB transaction only.
  lore = new LorebookStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
  scripts = new ScriptStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("lorebook graph replacement rollback + dedup (ASYNC_TRANSACTION_AUDIT step 3)", () => {
  test("setLinks preserves the prior complete graph when a later link insert fails", async () => {
    const lb = await lore.createLorebook({ name: "L", scopeType: "global" });
    await lore.setLinks(lb.id, [
      { targetType: "character", targetId: "char_A" },
      { targetType: "character", targetId: "char_B" },
    ]);

    // Inject failure on a LATER link insert (char_D), after the delete + the
    // char_C insert already landed inside the tx. The delete must roll back too.
    db.run(sql`CREATE TRIGGER fail_link_d BEFORE INSERT ON lorebook_links WHEN NEW.target_id = 'char_D' BEGIN SELECT RAISE(ABORT, 'injected lore setLinks boom'); END`);

    await expect(lore.setLinks(lb.id, [
      { targetType: "character", targetId: "char_C" },
      { targetType: "character", targetId: "char_D" },
    ])).rejects.toThrow("injected lore setLinks boom");

    // Prior complete graph intact — NOT wiped to empty by the delete-then-fail.
    const links = await lore.getLinks(lb.id);
    expect(links.map((l) => l.targetId).sort()).toEqual(["char_A", "char_B"]);
  });

  test("setLinks collapses duplicate (targetType,targetId) tuples so the replace stays whole", async () => {
    const lb = await lore.createLorebook({ name: "L", scopeType: "global" });

    // (character,char_X) appears twice — without dedup the second insert would
    // hit the composite PK AFTER the (empty) old set was deleted, throwing and
    // (with the old async hole) leaving the graph empty.
    await lore.setLinks(lb.id, [
      { targetType: "character", targetId: "char_X" },
      { targetType: "character", targetId: "char_X" },
      { targetType: "persona", targetId: "pers_Y" },
    ]);

    const links = await lore.getLinks(lb.id);
    expect(links.length).toBe(2);
    expect(links.map((l) => `${l.targetType}:${l.targetId}`).sort())
      .toEqual(["character:char_X", "persona:pers_Y"]);
  });

  test("reorderEntries preserves the prior complete order when a mid-reorder update fails", async () => {
    const lb = await lore.createLorebook({ name: "L", scopeType: "global" });
    const e0 = await lore.createEntry(lb.id, { title: "e0" });
    const e1 = await lore.createEntry(lb.id, { title: "e1" });
    const e2 = await lore.createEntry(lb.id, { title: "e2" });
    // Initial sortOrder: e0=0, e1=1, e2=2 (auto-assigned max+1 per create).

    // Inject failure on the LAST reorder update (e2). The two earlier updates
    // already landed inside the tx; they must roll back too.
    db.run(sql`CREATE TRIGGER fail_reorder_e2 BEFORE UPDATE ON lore_entries WHEN NEW.id = '${sql.raw(e2.id)}' BEGIN SELECT RAISE(ABORT, 'injected reorder boom'); END`);

    await expect(lore.reorderEntries(lb.id, [
      { id: e0.id, sortOrder: 2 },
      { id: e1.id, sortOrder: 0 },
      { id: e2.id, sortOrder: 1 },
    ])).rejects.toThrow("injected reorder boom");

    // Prior order intact — no half-applied reorder leaked.
    const entries = await lore.listEntries(lb.id);
    expect(entries.map((e) => e.id)).toEqual([e0.id, e1.id, e2.id]);
  });
});

describe("script graph replacement rollback + dedup (ASYNC_TRANSACTION_AUDIT step 3)", () => {
  test("setLinks preserves the prior complete graph when a later link insert fails", async () => {
    const sc = await scripts.create({ name: "S", scopeType: "global", sortOrder: 0, enabled: true });
    await scripts.setLinks(sc.id, [
      { targetType: "character", targetId: "char_A" },
      { targetType: "character", targetId: "char_B" },
    ]);

    db.run(sql`CREATE TRIGGER fail_script_link_d BEFORE INSERT ON script_links WHEN NEW.target_id = 'char_D' BEGIN SELECT RAISE(ABORT, 'injected script setLinks boom'); END`);

    await expect(scripts.setLinks(sc.id, [
      { targetType: "character", targetId: "char_C" },
      { targetType: "character", targetId: "char_D" },
    ])).rejects.toThrow("injected script setLinks boom");

    const links = await scripts.getLinks(sc.id);
    expect(links.map((l) => l.targetId).sort()).toEqual(["char_A", "char_B"]);
  });

  test("setLinks collapses duplicate (targetType,targetId) tuples so the replace stays whole", async () => {
    const sc = await scripts.create({ name: "S", scopeType: "global", sortOrder: 0, enabled: true });

    await scripts.setLinks(sc.id, [
      { targetType: "character", targetId: "char_X" },
      { targetType: "character", targetId: "char_X" },
      { targetType: "persona", targetId: "pers_Y" },
    ]);

    const links = await scripts.getLinks(sc.id);
    expect(links.length).toBe(2);
    expect(links.map((l) => `${l.targetType}:${l.targetId}`).sort())
      .toEqual(["character:char_X", "persona:pers_Y"]);
  });
});
