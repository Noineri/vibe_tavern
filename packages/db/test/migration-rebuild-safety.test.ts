import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";

import { createDb } from "../src/db-connection.js";
import { LorebookStore } from "../src/stores/lorebook-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

/**
 * Regression test for the June 2026 data-loss bug.
 *
 * Migration 0037 rebuilds the `lorebooks` table (CREATE __new → INSERT…SELECT →
 * DROP → RENAME). The project's custom `healPartialMigrations` path in
 * db-connection.ts used to split such rebuild SQL by `;` and execute each
 * statement separately, tolerating "already exists". For ADD-COLUMN migrations
 * that is harmless; for a table-rebuild it is destructive — a partial run
 * strands a `__new_lorebooks` table that the next heal attempt copies from /
 * drops incorrectly, emptying `lorebooks` (`lore_entries` survived only because
 * a DROP TABLE does not fire FK cascade). The fix: `healPartialMigrations`
 * skips migrations matching the rebuild pattern (`CREATE TABLE __new_…`).
 *
 * This test locks the observable invariant: re-running createDb on a DB whose
 * rebuild migration has become un-stamped (the exact failure state) must NOT
 * destroy existing lorebook data, whether createDb succeeds or throws.
 */

const testClock: StoreClock = { now: () => "2026-06-21T00:00:00.000Z" };
let nextId = 0;
const testIdGen: StoreIdGenerator = { next: (p: string) => `${p}_rebuild_${++nextId}` };

function rebuildMigrationHash(): string {
  // The only committed rebuild migration in the journal today.
  const sqlPath = resolve(import.meta.dir, "..", "drizzle", "0037_cynical_black_bird.sql");
  const sql = readFileSync(sqlPath, "utf8");
  return new Bun.CryptoHasher("sha256").update(sql).digest("hex");
}

function countLorebooks(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) as n FROM lorebooks").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("createDb rebuild-migration safety", () => {
  test("re-running createDb with an un-stamped rebuild migration preserves lorebook data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vt-rebuild-safety-"));
    const dbPath = join(dir, "test.db");

    // 1. Fresh DB: all migrations applied, 0037 stamped.
    const db = await createDb(dbPath);
    const store = new LorebookStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
    const lb = await store.createLorebook({ name: "Sentinel lorebook", scopeType: "global" });
    await store.createEntry(lb.id, { title: "e1", content: "content", keys: ["k1"] });
    await store.createEntry(lb.id, { title: "e2", content: "content", keys: ["k2"] });

    expect(countLorebooks(dbPath)).toBe(1);
    expect((await store.listEntries(lb.id)).length).toBe(2);

    // 2. Simulate the failure state: un-stamp the rebuild migration.
    // This is exactly what happened in production — migrate() never stamped 0037.
    const stamp = rebuildMigrationHash();
    const raw = new Database(dbPath);
    const deleted = raw.prepare("DELETE FROM __drizzle_migrations WHERE hash = ?").run(stamp);
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();
    expect(deleted.changes).toBe(1); // sanity: we actually removed the stamp

    // 3. Re-run createDb (the next server boot). It may succeed or throw
    //    depending on drizzle internals — but it MUST NOT destroy data.
    let threw = false;
    try {
      await createDb(dbPath);
    } catch {
      threw = true;
    }

    // 4. The invariant: lorebook rows survive.
    const surviving = countLorebooks(dbPath);
    expect(surviving).toBe(1);
    // Entries survive too (they survived even in the original bug, but pin it).
    const after = await createDb(dbPath);
    const afterStore = new LorebookStore(after, { clock: testClock, idGenerator: testIdGen, content: null });
    const survivingEntries = await afterStore.listEntries(lb.id);
    expect(survivingEntries.length).toBe(2);

    // Log the path (no assertion on `threw` — both outcomes are acceptable as
    // long as data is intact; fail-stop is preferable to data loss).
    if (threw) console.log("[rebuild-safety] createDb fail-stopped (acceptable); data preserved.");
  });
});
