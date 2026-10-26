// TS-1 canary: the migrated-template fast path (src/db-template.ts) must be
// indistinguishable from a real migration, and every real-path entry point
// (override folder, pre-existing file, { realMigrations } opt-out) must keep
// running the actual drizzle journal replay. Numbers and rationale:
// vibe_tavern_plan/reports/TEST_SUITE_SPEED_REPORT.md.
//
// The suite preload enables the switch; calling enableTestDbTemplate() here
// again is idempotent and keeps this file correct in standalone spot runs.

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { createDb, type AppDb } from "../src/db-connection.js";
import { enableTestDbTemplate } from "../src/db-template.js";

enableTestDbTemplate();

/** The raw bun:sqlite handle behind a drizzle AppDb (same access pattern the
 *  migration tests use; drizzle's $client is not part of the public type). */
function rawClient(db: AppDb): Database {
  return (db as unknown as { $client: Database }).$client;
}

function sqliteMasterRows(sqlite: Database): unknown[] {
  return sqlite
    .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name")
    .all();
}

function migrationRows(sqlite: Database): unknown[] {
  return sqlite
    .query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, hash")
    .all();
}

function pragma(sqlite: Database, name: string): string {
  const row = sqlite.query(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return String(row[name]);
}

describe("db-template (TS-1): clones are identical to a real migration", () => {
  test(":memory: clone matches a fresh real migration (schema, journal, pragmas)", async () => {
    const clone = rawClient(await createDb(":memory:"));
    const real = rawClient(await createDb(":memory:", undefined, { realMigrations: true }));
    expect(sqliteMasterRows(clone)).toEqual(sqliteMasterRows(real));
    expect(migrationRows(clone)).toEqual(migrationRows(real));
    expect(pragma(clone, "foreign_keys")).toBe("1");
    expect(pragma(clone, "user_version")).toBe(pragma(real, "user_version"));
    expect(pragma(clone, "integrity_check")).toBe("ok");
  });

  test("file clone matches a fresh real migration and runs in WAL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vt-dbtpl-file-"));
    const clone = rawClient(await createDb(join(dir, "clone.db")));
    const real = rawClient(await createDb(join(dir, "real.db"), undefined, { realMigrations: true }));
    expect(sqliteMasterRows(clone)).toEqual(sqliteMasterRows(real));
    expect(migrationRows(clone)).toEqual(migrationRows(real));
    expect(pragma(clone, "journal_mode")).toBe("wal");
    expect(pragma(clone, "foreign_keys")).toBe("1");
  });

  test("FK enforcement is live on a clone — an orphan insert fails", async () => {
    const clone = rawClient(await createDb(":memory:"));
    expect(() =>
      clone.run(
        "INSERT INTO chats (id, character_id, active_branch_id, title, created_at, updated_at) VALUES ('chat_orphan', 'char_missing', 'branch_missing', 't', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      ),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("db-template (TS-1): real-path entries never clone", () => {
  test("an override-folder call runs the real migrations from that folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "vt-dbtpl-ovr-"));
    const folder = join(root, "drizzle");
    await mkdir(join(folder, "meta"), { recursive: true });
    const sql = "CREATE TABLE `template_canary_marker` (`id` text PRIMARY KEY);";
    await Bun.write(join(folder, "0000_canary.sql"), sql);
    await Bun.write(join(folder, "meta", "_journal.json"), JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: [{ idx: 0, version: "6", when: 1_700_000_000_000, tag: "0000_canary", breakpoints: true }],
    }));

    const db = rawClient(await createDb(":memory:", folder));
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((row) => row.name);
    // The override journal was really applied (marker table + exactly its one
    // ledger row) — a template clone would carry the 122-row real schema.
    expect(names).toContain("template_canary_marker");
    expect(names).not.toContain("characters");
    expect(migrationRows(db)).toHaveLength(1);
  });

  test("a pre-existing file is never overwritten by the template — the real path reopens it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vt-dbtpl-exist-"));
    const folder = join(root, "drizzle");
    await mkdir(join(folder, "meta"), { recursive: true });
    const sql = "CREATE TABLE `template_canary_marker` (`id` text PRIMARY KEY);";
    await Bun.write(join(folder, "0000_canary.sql"), sql);
    await Bun.write(join(folder, "meta", "_journal.json"), JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: [{ idx: 0, version: "6", when: 1_700_000_000_000, tag: "0000_canary", breakpoints: true }],
    }));

    const dbPath = join(root, "existing.db");
    const first = rawClient(await createDb(dbPath, folder));
    expect(
      (first.query("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='template_canary_marker'").get() as { cnt: number }).cnt,
    ).toBe(1);
    first.close();

    // The file now exists, so this call is non-eligible by construction. If it
    // were (wrongly) served from the template, the marker table would be
    // replaced by the pristine template image and vanish.
    const reopened = rawClient(await createDb(dbPath));
    const names = (reopened.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    expect(names).toContain("template_canary_marker");
    expect(names).toContain("characters");
  });

  test("the opt-out and the clone take different paths (console discriminator)", async () => {
    // Warm the template first: whichever call BUILDS the template legitimately
    // runs the real path and prints the folder line, so the no-clone assert
    // below must observe a call that can only be a clone.
    await createDb(":memory:");

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await createDb(":memory:");
      const cloneLines = [...lines];
      await createDb(":memory:", undefined, { realMigrations: true });
      const realLines = [...lines];
      expect(cloneLines.some((line) => line.includes("[db] Migrations folder:"))).toBe(false);
      expect(realLines.some((line) => line.includes("[db] Migrations folder:"))).toBe(true);
    } finally {
      console.log = original;
    }
  });
});
