import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDb } from "../src/db-connection.js";

/**
 * Characterization for the drizzle-orm #5782 defense in createDb.
 *
 * The bug: drizzle-kit emits `PRAGMA foreign_keys=OFF;` at the top of every
 * table-rebuild migration to disarm ON DELETE CASCADE. drizzle-orm's migrator
 * wraps each migration in BEGIN..COMMIT, and SQLite IGNORES PRAGMA foreign_keys
 * inside a transaction — so the protective pragma is neutralized. `DROP TABLE
 * parent` then becomes an implicit `DELETE FROM parent`, CASCADE wipes every
 * child table, the migration commits cleanly, no error. This is exactly how
 * lore_entries was emptied when migration 0037 rebuilt lorebooks (the user data
 * loss reported 2026-06-25). See upstream issue drizzle-orm#5782.
 *
 * The fix in createDb: flip FK OFF on the raw handle BEFORE migrate() opens its
 * BEGIN (so it actually takes effect), restore ON in finally. These tests prove
 * (1) the bug is real on our installed drizzle version, and (2) createDb's fix
 * defeats it end-to-end through the same migrate() path that runs at startup.
 *
 * Synthetic migrations mirror drizzle-kit's emitted rebuild pattern exactly:
 * 0000 creates parent + a CASCADE child; 0001 rebuilds parent (the trigger).
 */

const INIT_SQL = `CREATE TABLE "parent" ("id" integer PRIMARY KEY, "mode" text NOT NULL DEFAULT 'a');--> statement-breakpoint
CREATE TABLE "child" ("id" integer PRIMARY KEY, "parent_id" integer NOT NULL REFERENCES "parent"("id") ON DELETE CASCADE, "payload" text NOT NULL);`;

// drizzle-kit's rebuild template, verbatim in shape: protective pragma (neutralized
// inside the migrator's transaction), copy aside, INSERT...SELECT, DROP, RENAME.
const REBUILD_SQL = `PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE "__new_parent" ("id" integer PRIMARY KEY, "mode" text NOT NULL DEFAULT 'b');--> statement-breakpoint
INSERT INTO "__new_parent"("id","mode") SELECT "id","mode" FROM "parent";--> statement-breakpoint
DROP TABLE "parent";--> statement-breakpoint
ALTER TABLE "__new_parent" RENAME TO "parent";`;

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

async function writeJournal(folder: string, entries: JournalEntry[]): Promise<void> {
  const meta = resolve(folder, "meta");
  await mkdir(meta, { recursive: true });
  await writeFile(
    resolve(meta, "_journal.json"),
    JSON.stringify({ version: "7", dialect: "sqlite", entries }),
  );
}

async function writeMigrationsFolder(folder: string, withRebuild: boolean): Promise<void> {
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const entries: JournalEntry[] = [
    { idx: 0, version: "6", when: 1700000000000, tag: "0000_init", breakpoints: true },
  ];
  await writeFile(resolve(folder, "0000_init.sql"), INIT_SQL);
  if (withRebuild) {
    entries.push({ idx: 1, version: "6", when: 1700000001000, tag: "0001_rebuild", breakpoints: true });
    await writeFile(resolve(folder, "0001_rebuild.sql"), REBUILD_SQL);
  }
  await writeJournal(folder, entries);
}

function childCount(dbPath: string): number {
  const conn = new Database(dbPath);
  const row = conn.query("SELECT COUNT(*) AS c FROM child").get() as { c: number };
  conn.close();
  return row.c;
}

function seed(dbPath: string): void {
  const conn = new Database(dbPath);
  conn.exec("PRAGMA foreign_keys = ON");
  conn.exec(`INSERT INTO parent (id, mode) VALUES (1, 'a');`);
  conn.exec(`INSERT INTO child (id, parent_id, payload) VALUES (1, 1, 'x'), (2, 1, 'y');`);
  conn.close();
}

describe("drizzle-orm #5782 defense — FK-off-around-migrate", () => {
  test("WITHOUT the fix (upgrade path): a pending rebuild migration CASCADE-wipes the seeded child table", async () => {
    // The realistic upgrade: user already has the DB (0000 applied, data present),
    // a new binary brings a rebuild migration (0001). Naive migrate() with FK ON
    // (the createDb default before the fix) wipes the child.
    const dir = await mkdtemp(join(tmpdir(), "vt-5782-upgrade-bug-"));
    const folder = join(dir, "drizzle");
    const dbPath = join(dir, "test.db");

    // Phase A: only 0000 present → tables created + 0000 stamped.
    await writeMigrationsFolder(folder, false);
    const setupClient = new Database(dbPath);
    setupClient.exec("PRAGMA journal_mode = WAL");
    setupClient.exec("PRAGMA foreign_keys = ON");
    const setupDb = drizzle(setupClient);
    migrate(setupDb, { migrationsFolder: folder });
    setupClient.close();

    // Seed parent + child (the user's data).
    seed(dbPath);
    expect(childCount(dbPath)).toBe(2);

    // Phase B: ship the rebuild migration. Naive migrate with FK left ON (the
    // pre-fix createDb behavior).
    await writeMigrationsFolder(folder, true);
    const bugClient = new Database(dbPath);
    bugClient.exec("PRAGMA foreign_keys = ON"); // ← what createDb used to do, then migrate()
    const bugDb = drizzle(bugClient);
    migrate(bugDb, { migrationsFolder: folder }); // runs 0001 rebuild; PRAGMA foreign_keys=OFF in the .sql is IGNORED inside the tx
    bugClient.close();

    // THE BUG: child wiped by ON DELETE CASCADE during DROP TABLE parent.
    expect(childCount(dbPath)).toBe(0);
  });

  test("WITH the createDb fix: the same upgrade rebuild preserves the child table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vt-5782-upgrade-fix-"));
    const folder = join(dir, "drizzle");
    const dbPath = join(dir, "test.db");

    // Phase A: only 0000.
    await writeMigrationsFolder(folder, false);
    const setupClient = new Database(dbPath);
    setupClient.exec("PRAGMA journal_mode = WAL");
    setupClient.exec("PRAGMA foreign_keys = ON");
    const setupDb = drizzle(setupClient);
    migrate(setupDb, { migrationsFolder: folder });
    setupClient.close();

    seed(dbPath);
    expect(childCount(dbPath)).toBe(2);

    // Phase B: ship the rebuild. Run via createDb — which now flips FK OFF on
    // the raw handle before migrate() (outside any transaction, so it sticks),
    // and restores ON in finally.
    await writeMigrationsFolder(folder, true);
    const db = await createDb(dbPath, folder);
    (db as unknown as { $client: Database }).$client.close();

    // THE FIX: child rows survived the rebuild.
    expect(childCount(dbPath)).toBe(2);
  });
});
