import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { createDb } from "../src/db-connection.js";

/**
 * Regression test for recovery-vs-drizzle watermark mismatch.
 *
 * Drizzle's SQLiteSyncDialect.migrate resumes from a SINGLE high-water mark —
 * the greatest created_at in __drizzle_migrations — and runs every journal
 * entry whose folderMillis (`when`) exceeds it (it does NOT dedupe by hash).
 * The project's recovery stampers used to decide "applied" by hash
 * *membership* instead. That diverges from drizzle precisely when a migration is regenerated with
 * identical SQL (identical hash) but a NEW `when` — which is exactly what a
 * branch-merge reconciliation does when it renumbers/re-dates a migration.
 * Existing DBs keep the stamp at the OLD created_at; the hash is "present" so
 * the heal skipped re-stamping, yet that orphan row's created_at sits below the
 * new folderMillis, so migrate() re-ran the migration and died on
 * "table already exists". This happened in production when the IR-90P dev-merge
 * re-dated the experience migration to 0033_volatile_mantis. Legacy Vibe Tavern
 * DBs also have UNIQUE(hash), so the first watermark fix's INSERT OR IGNORE was
 * silently discarded for the same hash and falsely logged as "stamped".
 *
 * The fix makes rebase/heal use the same created_at watermark and MOVE an
 * existing same-hash stamp to the new `when` rather than attempting an ignored
 * duplicate insert. This test reproduces the real legacy-table shape and
 * asserts the next boot self-heals before migrate() can crash.
 */

const BASELINE_WHEN = 1_700_000_000_000;

// 0001 content is intentionally CONSTANT across both folder builds so its hash
// is identical — that is what makes the re-date produce an orphan rather than a
// brand-new migration.
const PROBE_SQL = [
  "CREATE TABLE `heal_watermark_probe` (`id` text PRIMARY KEY NOT NULL, `val` text NOT NULL);",
  "CREATE INDEX `idx_heal_watermark_probe_val` ON `heal_watermark_probe` (`val`);",
].join("\n--> statement-breakpoint\n");

async function buildFolder(probeWhen: number): Promise<{ folder: string; probeHash: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vt-heal-wm-"));
  const folder = join(dir, "drizzle");
  const meta = join(folder, "meta");
  await mkdir(meta, { recursive: true });

  // 0000 = the real squashed baseline (full current schema).
  const baselineSrc = resolve(import.meta.dir, "..", "drizzle", "0000_baseline.sql");
  await copyFile(baselineSrc, join(folder, "0000_baseline.sql"));

  await Bun.write(join(folder, "0001_probe.sql"), PROBE_SQL);
  const probeHash = new Bun.CryptoHasher("sha256").update(PROBE_SQL).digest("hex");

  const journal = {
    version: "7",
    dialect: "sqlite",
    entries: [
      { idx: 0, version: "6", when: BASELINE_WHEN, tag: "0000_baseline", breakpoints: true },
      { idx: 1, version: "6", when: probeWhen, tag: "0001_probe", breakpoints: true },
    ],
  };
  await Bun.write(join(meta, "_journal.json"), JSON.stringify(journal));

  return { folder, probeHash };
}

function probeExists(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    return !!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='heal_watermark_probe'").get();
  } finally {
    db.close();
  }
}

function maxCreatedAt(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get() as { created_at: number } | undefined;
    return row ? Number(row.created_at) : 0;
  } finally {
    db.close();
  }
}

describe("createDb migration watermark (orphan-hash recovery)", () => {
  test("a re-dated migration with an orphan stamp self-heals instead of crashing on 'table already exists'", async () => {
    const work = await mkdtemp(join(tmpdir(), "vt-heal-wm-work-"));
    const dbPath = join(work, "test.db");

    // 1. Apply with the ORIGINAL when — probe table created, stamp recorded.
    const originalWhen = 1_700_000_001_000;
    const first = await buildFolder(originalWhen);
    let db = await createDb(dbPath, first.folder);
    expect(probeExists(dbPath)).toBe(true);
    expect(maxCreatedAt(dbPath)).toBe(originalWhen);
    (db as unknown as { $client: Database }).$client.close();

    // 2. Simulate the reconciliation: regenerate the journal with a NEW, higher
    //    `when` for the SAME migration content (identical hash). The DB still
    //    carries the OLD stamp — an orphan below the new folderMillis.
    const newWhen = 1_700_000_002_000;
    const reborn = await buildFolder(newWhen);

    // Sanity: the DB has the probe hash stamped at the ORIGINAL (orphan) when.
    const raw = new Database(dbPath);
    // baselineLegacyDb() creates the legacy tracking shape with UNIQUE(hash).
    // A plain fresh Drizzle DB lacks that constraint, so add it explicitly to
    // reproduce the user's real database rather than testing only the easier
    // duplicate-row form.
    raw.exec("CREATE UNIQUE INDEX idx_heal_probe_migration_hash ON __drizzle_migrations(hash)");
    const stamped = raw.query("SELECT hash, created_at FROM __drizzle_migrations").all() as { hash: string; created_at: number }[];
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();
    expect(stamped.some((r) => r.hash === first.probeHash && Number(r.created_at) === originalWhen)).toBe(true);

    // 3. Re-boot. WITHOUT the watermark fix, migrate() sees watermark=
    //    originalWhen < newWhen, re-runs 0001, and throws "table already
    //    exists". WITH the fix, the conservative rebase sees the full schema,
    //    moves the stamp to newWhen, and migrate() skips it. The heal path uses
    //    the same helper for partial-state retries.
    let threw = false;
    try {
      db = await createDb(dbPath, reborn.folder);
      (db as unknown as { $client: Database }).$client.close();
    } catch (e) {
      threw = true;
      console.error("[heal-wm] unexpected throw:", e);
    }
    expect(threw).toBe(false);

    // 4. The probe table survived, the watermark advanced to the new when, and
    //    UNIQUE(hash) still leaves exactly one stamp (moved, not duplicated).
    expect(probeExists(dbPath)).toBe(true);
    expect(maxCreatedAt(dbPath)).toBe(newWhen);
    const after = new Database(dbPath, { readonly: true });
    const probeStamps = after.query("SELECT created_at FROM __drizzle_migrations WHERE hash=?").all(first.probeHash) as { created_at: number }[];
    after.close();
    expect(probeStamps.map((row) => Number(row.created_at))).toEqual([newWhen]);
  });
});
