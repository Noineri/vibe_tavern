import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { createDb } from "../src/db-connection.js";
import { CoauthorModuleStore } from "../src/stores/coauthor-module-store.js";

/**
 * ML-5 backfill test for 0123_noisy_blade (coauthor_modules.sort_order), on
 * the REAL migration path (override folder + pre-existing file — the template
 * path would only prove the migration applies on an empty DB). Follows the
 * migration-preset-name-bake.test.ts harness: build a pre-0123 migrations
 * folder, seed legacy modules with distinct (and tied) created_at values, then
 * re-open with the full real folder so only 0123 runs, and assert the backfill
 * numbered the existing rows created_at ASC, id ASC.
 */

const REAL_DRIZZLE = resolve(import.meta.dir, "..", "drizzle");
const ORDER_TAG = "0123_noisy_blade";

/** A migrations folder with the real 0000…0122 but WITHOUT 0123 (pre-column). */
async function buildPreOrderFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vt-cmod-pre-"));
  const folder = join(dir, "drizzle");
  const meta = join(folder, "meta");
  await mkdir(meta, { recursive: true });
  await cp(REAL_DRIZZLE, folder, { recursive: true });
  const journalPath = join(meta, "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  const orderIndex = journal.entries.findIndex((entry) => entry.tag === ORDER_TAG);
  if (orderIndex === -1) throw new Error(`${ORDER_TAG} is missing from the real migration journal`);

  // Exclude 0123 AND every later migration (drizzle skips an older timestamp
  // once a later one is stamped — see migration-preset-name-bake.test.ts).
  const postEntries = journal.entries.slice(orderIndex);
  for (const entry of postEntries) {
    const prefix = entry.tag.slice(0, 4);
    await rm(join(folder, `${entry.tag}.sql`), { force: true });
    await rm(join(meta, `${prefix}_snapshot.json`), { force: true });
  }
  journal.entries = journal.entries.slice(0, orderIndex);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  return folder;
}

interface ModuleOrderRow {
  id: string;
  sort_order: number;
}

function insertLegacyModule(db: Database, id: string, createdAt: string): void {
  db.exec(
    `INSERT INTO coauthor_modules (id, name, description, base_prompt, opening_message, skill_ids_json, tool_set_json, max_steps, created_at, updated_at)
     VALUES ('${id}', '${id}', '', 'prompt', '', '[]', '{}', 5, '${createdAt}', '${createdAt}')`,
  );
}

describe("0123 coauthor_modules sort_order backfill (ML-5)", () => {
  test("numbers existing rows created_at ASC, id ASC", async () => {
    const work = await mkdtemp(join(tmpdir(), "vt-cmod-order-"));
    const dbPath = join(work, "test.db");
    const preFolder = await buildPreOrderFolder();

    // 1. Fresh DB at the pre-0123 schema (no sort_order column).
    let db = await createDb(dbPath, preFolder);
    (db as unknown as { $client: Database }).$client.close();

    // 2. Seed legacy modules: three distinct created_at values inserted OUT of
    //    chronological order (insertion order must not decide), plus a tied
    //    pair (same created_at → the id is the tiebreak).
    const seed = new Database(dbPath);
    seed.exec("PRAGMA foreign_keys=OFF");
    insertLegacyModule(seed, "m-newest", "2026-03-03T00:00:00.000Z");
    insertLegacyModule(seed, "m-oldest", "2026-01-01T00:00:00.000Z");
    insertLegacyModule(seed, "m-middle", "2026-02-02T00:00:00.000Z");
    insertLegacyModule(seed, "m-tie-b", "2026-04-01T00:00:00.000Z");
    insertLegacyModule(seed, "m-tie-a", "2026-04-01T00:00:00.000Z");
    seed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    seed.close();

    // Sanity: pre-migration there is no sort_order column.
    {
      const r = new Database(dbPath, { readonly: true });
      const cols = r.query("PRAGMA table_info('coauthor_modules')").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "sort_order")).toBe(false);
      r.close();
    }

    // 3. Apply 0123 by re-running createDb with the FULL (real) migrations
    //    folder. Everything before 0123 is already stamped, so drizzle runs
    //    only 0123 (ALTER + the ROW_NUMBER backfill).
    db = await createDb(dbPath, REAL_DRIZZLE);
    const client = (db as unknown as { $client: Database }).$client;

    // 4. Backfill: created_at ASC numbering, id ASC inside the tie.
    const rows = client
      .query("SELECT id, sort_order FROM coauthor_modules ORDER BY sort_order ASC")
      .all() as ModuleOrderRow[];
    expect(rows).toEqual([
      { id: "m-oldest", sort_order: 0 },
      { id: "m-middle", sort_order: 1 },
      { id: "m-newest", sort_order: 2 },
      { id: "m-tie-a", sort_order: 3 },
      { id: "m-tie-b", sort_order: 4 },
    ]);

    // 5. The store reads the migrated DB in the SAME total order (the chain
    //    backfill → store list ordering, what GET /api/coauthor/modules serves
    //    after upgrade).
    const store = new CoauthorModuleStore(db);
    expect((await store.list()).map((m) => m.id)).toEqual([
      "m-oldest",
      "m-middle",
      "m-newest",
      "m-tie-a",
      "m-tie-b",
    ]);

    client.close();
  });
});
