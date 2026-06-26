import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, copyFile, readFileSync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { createDb } from "../src/db-connection.js";
import { LorebookStore } from "../src/stores/lorebook-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

/**
 * Regression test for the June 2026 lorebook data-loss bug.
 *
 * Original shape: migration 0037 rebuilt the `lorebooks` table (CREATE __new →
 * INSERT…SELECT → DROP → RENAME). When its stamp was lost (migrate() never
 * recorded it), the project's custom `healPartialMigrations` path used to split
 * such rebuild SQL by `;` and execute each statement separately, tolerating
 * "already exists". For ADD-COLUMN migrations that is harmless; for a table
 * rebuild it is destructive — a partial run strands a `__new_lorebooks` table
 * that the next heal attempt copies from / drops incorrectly, emptying the
 * parent while children survived only because DROP TABLE didn't fire the FK
 * cascade (or, with the cascade path, wiped the children — see the #5782 fix).
 *
 * This test now uses a SYNTHETIC rebuild migration rather than the committed
 * 0037, because the migration history was squashed into a single baseline
 * (0037 no longer exists as a file). The squashed baseline itself contains no
 * rebuilds, so to keep guarding the rebuild-safety invariant we synthesize one:
 * the real baseline as 0000, plus a synthetic lorebooks rebuild as 0001. The
 * observable invariant is unchanged — re-running createDb on a DB whose rebuild
 * migration has become un-stamped (the exact failure state) must NOT destroy
 * existing lorebook data, whether createDb succeeds or throws. Today the
 * invariant holds via the FK-off-around-migrate defense (drizzle-orm #5782):
 * with FK disabled for the migration phase, the rebuild's DROP TABLE does not
 * cascade, INSERT…SELECT carries the rows across, and the data survives.
 */

const testClock: StoreClock = { now: () => "2026-06-21T00:00:00.000Z" };
let nextId = 0;
const testIdGen: StoreIdGenerator = { next: (p: string) => `${p}_rebuild_${++nextId}` };

/** Build a self-contained migrations folder: real squashed baseline (0000) +
 *  a synthetic lorebooks rebuild (0001) that mirrors drizzle-kit's __new_ template. */
async function buildSyntheticMigrations(): Promise<{ folder: string; rebuildHash: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vt-rebuild-mig-"));
  const folder = join(dir, "drizzle");
  const meta = join(folder, "meta");
  await mkdir(meta, { recursive: true });

  // 0000 = the real squashed baseline (full current schema, CREATE TABLE only).
  const baselineSrc = resolve(import.meta.dir, "..", "drizzle", "0000_baseline.sql");
  await copyFile(baselineSrc, join(folder, "0000_baseline.sql"));
  const baselineWhen = 1_700_000_000_000;

  // 0001 = synthetic lorebooks rebuild, mirroring drizzle-kit's emitted template:
  // PRAGMA foreign_keys=OFF; CREATE __new → INSERT…SELECT → DROP → RENAME.
  // Rebuild of lorebooks in particular is the historically dangerous one because
  // lore_entries has ON DELETE CASCADE on lorebooks.id.
  const rebuildSql = [
    "PRAGMA foreign_keys=OFF;",
    'CREATE TABLE `__new_lorebooks` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `description` text NOT NULL DEFAULT \'\', `scope_type` text NOT NULL, `scan_depth` integer NOT NULL DEFAULT 10, `token_budget` integer NOT NULL DEFAULT 1000, `token_budget_percent` integer, `recursive_scanning` integer NOT NULL DEFAULT 0, `max_recursion_steps` integer NOT NULL DEFAULT 5, `include_names` integer NOT NULL DEFAULT 0, `min_activations` integer NOT NULL DEFAULT 0, `min_activations_depth_max` integer NOT NULL DEFAULT 0, `overflow_alert` integer NOT NULL DEFAULT 0, `character_strategy` integer NOT NULL DEFAULT 0, `sort_order` integer NOT NULL DEFAULT 0, `character_id` text, `persona_id` text, `chat_id` text, `enabled` integer NOT NULL DEFAULT 1, `extensions_json` text NOT NULL DEFAULT \'{}\', `content_hash` text, `has_file_on_disk` integer NOT NULL DEFAULT 0, `created_at` text NOT NULL, `updated_at` text NOT NULL, FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade, FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade, FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade);',
    'INSERT INTO `__new_lorebooks`(`id`,`name`,`description`,`scope_type`,`scan_depth`,`token_budget`,`token_budget_percent`,`recursive_scanning`,`max_recursion_steps`,`include_names`,`min_activations`,`min_activations_depth_max`,`overflow_alert`,`character_strategy`,`sort_order`,`character_id`,`persona_id`,`chat_id`,`enabled`,`extensions_json`,`content_hash`,`has_file_on_disk`,`created_at`,`updated_at`) SELECT `id`,`name`,`description`,`scope_type`,`scan_depth`,`token_budget`,`token_budget_percent`,`recursive_scanning`,`max_recursion_steps`,`include_names`,`min_activations`,`min_activations_depth_max`,`overflow_alert`,`character_strategy`,`sort_order`,`character_id`,`persona_id`,`chat_id`,`enabled`,`extensions_json`,`content_hash`,`has_file_on_disk`,`created_at`,`updated_at` FROM `lorebooks`;',
    "DROP TABLE `lorebooks`;",
    "ALTER TABLE `__new_lorebooks` RENAME TO `lorebooks`;",
    'CREATE INDEX `idx_lorebooks_character` ON `lorebooks` (`character_id`);',
    'CREATE INDEX `idx_lorebooks_persona` ON `lorebooks` (`persona_id`);',
    'CREATE INDEX `idx_lorebooks_chat` ON `lorebooks` (`chat_id`);',
    'CREATE INDEX `idx_lorebooks_scope` ON `lorebooks` (`scope_type`);',
  ].join("\n--> statement-breakpoint\n");
  await writeFile(join(folder, "0001_rebuild_lorebooks.sql"), rebuildSql);
  const rebuildHash = new Bun.CryptoHasher("sha256").update(rebuildSql).digest("hex");
  const rebuildWhen = baselineWhen + 1_000;

  const journal = {
    version: "7",
    dialect: "sqlite",
    entries: [
      { idx: 0, version: "6", when: baselineWhen, tag: "0000_baseline", breakpoints: true },
      { idx: 1, version: "6", when: rebuildWhen, tag: "0001_rebuild_lorebooks", breakpoints: true },
    ],
  };
  await writeFile(join(meta, "_journal.json"), JSON.stringify(journal));

  return { folder, rebuildHash };
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
    const work = await mkdtemp(join(tmpdir(), "vt-rebuild-safety-"));
    const dbPath = join(work, "test.db");
    const { folder, rebuildHash } = await buildSyntheticMigrations();

    // 1. Fresh DB: baseline + rebuild both applied.
    let db = await createDb(dbPath, folder);
    const store = new LorebookStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
    const lb = await store.createLorebook({ name: "Sentinel lorebook", scopeType: "global" });
    await store.createEntry(lb.id, { title: "e1", content: "content", keys: ["k1"] });
    await store.createEntry(lb.id, { title: "e2", content: "content", keys: ["k2"] });

    expect(countLorebooks(dbPath)).toBe(1);
    expect((await store.listEntries(lb.id)).length).toBe(2);
    (db as unknown as { $client: Database }).$client.close();

    // 2. Simulate the failure state: un-stamp the rebuild migration.
    // This is exactly what happened in production — migrate() never stamped it.
    const raw = new Database(dbPath);
    const deleted = raw.prepare("DELETE FROM __drizzle_migrations WHERE hash = ?").run(rebuildHash);
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();
    expect(deleted.changes).toBe(1); // sanity: we actually removed the stamp

    // 3. Re-run createDb (the next server boot). It may succeed or throw
    //    depending on internals — but it MUST NOT destroy data.
    let threw = false;
    try {
      await createDb(dbPath, folder);
    } catch {
      threw = true;
    }

    // 4. The invariant: lorebook rows survive.
    expect(countLorebooks(dbPath)).toBe(1);

    // Entries survive too. With the #5782 defense (FK off during migrate), the
    // rebuild's DROP TABLE does not cascade, so children are preserved.
    db = await createDb(dbPath, folder);
    const afterStore = new LorebookStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
    const survivingEntries = await afterStore.listEntries(lb.id);
    (db as unknown as { $client: Database }).$client.close();
    expect(survivingEntries.length).toBe(2);

    if (threw) console.log("[rebuild-safety] createDb fail-stopped (acceptable); data preserved.");
  });
});
