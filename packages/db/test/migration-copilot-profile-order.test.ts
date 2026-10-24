import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { createDb } from "../src/db-connection.js";
import { CopilotProfileStore } from "../src/stores/copilot-profile-store.js";

/**
 * ML-6 backfill test for 0124_public_lizard (copilot_profiles.sort_order), on
 * the REAL migration path (override folder + pre-existing file — the template
 * path would only prove the migration applies on an empty DB). Follows the
 * migration-coauthor-module-order.test.ts harness (itself the
 * migration-preset-name-bake.test.ts pattern): build a pre-0124 migrations
 * folder, seed legacy profiles of TWO kinds with distinct (and tied)
 * created_at values, then re-open with the full real folder so only 0124
 * runs, and assert the backfill numbered each kind's rows created_at ASC,
 * id ASC — dense per kind (the order lives within one kind's list, so the
 * partition is per agent_kind).
 */

const REAL_DRIZZLE = resolve(import.meta.dir, "..", "drizzle");
const ORDER_TAG = "0124_public_lizard";

/** A migrations folder with the real 0000…0123 but WITHOUT 0124 (pre-column). */
async function buildPreOrderFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vt-cprof-pre-"));
  const folder = join(dir, "drizzle");
  const meta = join(folder, "meta");
  await mkdir(meta, { recursive: true });
  await cp(REAL_DRIZZLE, folder, { recursive: true });
  const journalPath = join(meta, "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  const orderIndex = journal.entries.findIndex((entry) => entry.tag === ORDER_TAG);
  if (orderIndex === -1) throw new Error(`${ORDER_TAG} is missing from the real migration journal`);

  // Exclude 0124 AND every later migration (drizzle skips an older timestamp
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

interface ProfileOrderRow {
  id: string;
  agent_kind: string;
  sort_order: number;
}

function insertLegacyProfile(db: Database, id: string, agentKind: string, createdAt: string): void {
  db.exec(
    `INSERT INTO copilot_profiles (id, name, base_prompt, agent_kind, skill_ids_json, tool_set_json, created_at, updated_at)
     VALUES ('${id}', '${id}', 'prompt', '${agentKind}', '[]', '{}', '${createdAt}', '${createdAt}')`,
  );
}

describe("0124 copilot_profiles sort_order backfill (ML-6)", () => {
  test("numbers each kind's existing rows created_at ASC, id ASC (dense per kind)", async () => {
    const work = await mkdtemp(join(tmpdir(), "vt-cprof-order-"));
    const dbPath = join(work, "test.db");
    const preFolder = await buildPreOrderFolder();

    // 1. Fresh DB at the pre-0124 schema (no sort_order column).
    let db = await createDb(dbPath, preFolder);
    (db as unknown as { $client: Database }).$client.close();

    // 2. Seed legacy profiles: experience rows with three distinct created_at
    //    values inserted OUT of chronological order (insertion order must not
    //    decide) plus a tied pair (same created_at → the id is the tiebreak),
    //    and a script row that is GLOBALLY the oldest — per-kind numbering
    //    must still start it at 0 in the script list, not slot it behind the
    //    experience rows.
    const seed = new Database(dbPath);
    seed.exec("PRAGMA foreign_keys=OFF");
    insertLegacyProfile(seed, "p-exp-newest", "experience", "2026-03-03T00:00:00.000Z");
    insertLegacyProfile(seed, "p-scr-oldest", "script", "2026-01-01T00:00:00.000Z"); // globally oldest
    insertLegacyProfile(seed, "p-exp-oldest", "experience", "2026-01-02T00:00:00.000Z");
    insertLegacyProfile(seed, "p-exp-middle", "experience", "2026-02-02T00:00:00.000Z");
    insertLegacyProfile(seed, "p-exp-tie-b", "experience", "2026-04-01T00:00:00.000Z");
    insertLegacyProfile(seed, "p-exp-tie-a", "experience", "2026-04-01T00:00:00.000Z");
    seed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    seed.close();

    // Sanity: pre-migration there is no sort_order column.
    {
      const r = new Database(dbPath, { readonly: true });
      const cols = r.query("PRAGMA table_info('copilot_profiles')").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "sort_order")).toBe(false);
      r.close();
    }

    // 3. Apply 0124 by re-running createDb with the FULL (real) migrations
    //    folder. Everything before 0124 is already stamped, so drizzle runs
    //    only 0124 (ALTER + the per-kind ROW_NUMBER backfill).
    db = await createDb(dbPath, REAL_DRIZZLE);
    const client = (db as unknown as { $client: Database }).$client;

    // 4. Backfill: each kind numbered 0..n-1 by created_at ASC, id ASC inside
    //    ties; the globally-oldest script row takes the script list's slot 0.
    const rows = client
      .query("SELECT id, agent_kind, sort_order FROM copilot_profiles ORDER BY agent_kind ASC, sort_order ASC")
      .all() as ProfileOrderRow[];
    expect(rows).toEqual([
      { id: "p-exp-oldest", agent_kind: "experience", sort_order: 0 },
      { id: "p-exp-middle", agent_kind: "experience", sort_order: 1 },
      { id: "p-exp-newest", agent_kind: "experience", sort_order: 2 },
      { id: "p-exp-tie-a", agent_kind: "experience", sort_order: 3 },
      { id: "p-exp-tie-b", agent_kind: "experience", sort_order: 4 },
      { id: "p-scr-oldest", agent_kind: "script", sort_order: 0 },
    ]);

    // 5. The store reads the migrated DB in the SAME total order (the chain
    //    backfill → store list ordering, what GET /api/copilot/profiles?kind=
    //    serves after upgrade).
    const store = new CopilotProfileStore(db);
    expect((await store.list("experience")).map((p) => p.id)).toEqual([
      "p-exp-oldest",
      "p-exp-middle",
      "p-exp-newest",
      "p-exp-tie-a",
      "p-exp-tie-b",
    ]);
    expect((await store.list("script")).map((p) => p.id)).toEqual(["p-scr-oldest"]);

    client.close();
  });
});
