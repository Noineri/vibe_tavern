// SS-2 migration 0110 backfill pin: pre-existing scripts keep working — every
// row created before the migration is backfilled to origin='in_app' (trusted)
// by the column DEFAULT, and first_enabled_at starts NULL. Build the database
// at journal state 0109 (the last pre-0110 schema), seed a script row, then let
// createDb apply the full journal — the exact upgrade path a user's DB takes.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";

import { createDb, type AppDb } from "../src/db-connection.js";

const REAL_DRIZZLE_DIR = resolve(import.meta.dir, "..", "drizzle");
const PRE_0110_LAST_TAG = "0109_yielding_spirit";

interface JournalEntry { idx: number; version: string; when: number; tag: string; breakpoints: boolean }

async function buildPreMigrationFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vt-origin-mig-"));
  const folder = join(dir, "drizzle");
  await mkdir(folder);
  const journal = JSON.parse(await readFile(resolve(REAL_DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] };
  const cut = journal.entries.findIndex((e) => e.tag === PRE_0110_LAST_TAG);
  if (cut < 0) throw new Error(`journal does not contain ${PRE_0110_LAST_TAG} — update PRE_0110_LAST_TAG for the new baseline`);
  const kept = journal.entries.slice(0, cut + 1);
  for (const entry of kept) {
    const sql = await readFile(resolve(REAL_DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
    await Bun.write(resolve(folder, `${entry.tag}.sql`), sql);
  }
  await mkdir(resolve(folder, "meta"), { recursive: true });
  await Bun.write(resolve(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  return folder;
}

function columnsOf(db: AppDb, table: string): string[] {
  return (db.all(`PRAGMA table_info(${table})`) as unknown as Array<{ name: string }>).map((c) => c.name);
}

function closeClient(db: AppDb): void {
  (db as unknown as { $client: Database }).$client.close();
}

describe("migration 0110 — script origin backfill (SS-2)", () => {
  test("pre-existing rows become origin='in_app' (trusted) with null first_enabled_at", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vt-origin-db-"));
    const dbPath = join(dir, "test.db");

    // Phase A: schema at 0109 — no origin/first_enabled_at columns yet.
    const preFolder = await buildPreMigrationFolder();
    const preDb = await createDb(dbPath, preFolder);
    expect(columnsOf(preDb, "scripts")).not.toContain("origin");
    expect(columnsOf(preDb, "scripts")).not.toContain("first_enabled_at");

    // Phase B: seed one legacy script row (raw SQL — the store writes the new columns).
    await preDb.run(
      `INSERT INTO scripts (id, name, scope_type, enabled, script_kind, created_at, updated_at) VALUES ('legacy_1', 'Legacy', 'global', 1, 'prompt', '2026-01-01', '2026-01-01')`,
    );
    closeClient(preDb);

    // Phase C: apply the full journal (0110) on the SAME file via createDb.
    const postDb = await createDb(dbPath);
    expect(columnsOf(postDb, "scripts")).toContain("origin");
    expect(columnsOf(postDb, "scripts")).toContain("first_enabled_at");

    const rows = postDb.all("SELECT origin, first_enabled_at FROM scripts WHERE id = 'legacy_1'") as unknown as Array<{ origin: string; first_enabled_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("in_app");
    expect(rows[0].first_enabled_at).toBeNull();
    closeClient(postDb);
  });
});
