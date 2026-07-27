import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { createDb } from "../src/db-connection.js";

/**
 * Regression + heal test for 0026_message_variant_preset_name (the root-cause
 * fix for PRESET_COPY_DELETE_CORRUPTION bug 2).
 *
 * Bug: message_variants.preset_id was a foreign key to prompt_presets. In a
 * reporter's DB (older build) that FK was NO ACTION, so deleting a preset that
 * any message variant referenced raised SQLITE_CONSTRAINT_FOREIGNKEY. Even on a
 * current-build DB (SET NULL) deleting a preset silently erased the historical
 * "which preset generated this" metadata.
 *
 * Fix: drop the FK; store the resolved preset NAME as plain text (baked at
 * generation time, survives preset delete/rename). This migration is the
 * auto-heal — it rebuilds the table (so the stale NO-ACTION FK vanishes with
 * the old table) and backfills preset_name from the live preset rows.
 *
 * This test exercises the full transformation on real data: it creates a DB at
 * the PRE-0026 schema (preset_id present), seeds variants — one referencing a
 * live preset, one referencing an already-orphaned preset_id — then applies 0026
 * and asserts (a) the name is backfilled (null for the orphan), (b) the
 * preset_id FK is gone, (c) deleting the preset no longer throws AND the baked
 * name survives, (d) other variant data + the unique index survive the rebuild.
 */

const REAL_DRIZZLE = resolve(import.meta.dir, "..", "drizzle");

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
}

/** A migrations folder with the real 0000…0025 but WITHOUT 0026 (pre-bake). */
async function buildPreBakeFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vt-presetname-pre-"));
  const folder = join(dir, "drizzle");
  const meta = join(folder, "meta");
  await mkdir(meta, { recursive: true });
  await cp(REAL_DRIZZLE, folder, { recursive: true });
  await rm(join(folder, "0026_message_variant_preset_name.sql"), { force: true });
  await rm(join(meta, "0026_snapshot.json"), { force: true });
  const journalPath = join(meta, "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.filter((e) => e.tag !== "0026_message_variant_preset_name");
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  return folder;
}

function foreignKeysOn(db: Database, table: string): ForeignKeyRow[] {
  return db.query(`PRAGMA foreign_key_list('${table}')`).all() as ForeignKeyRow[];
}

describe("0026 message_variant_preset_name bake migration", () => {
  test("backfills preset_name, drops the preset_id FK, and unblocks preset delete (auto-heal)", async () => {
    const work = await mkdtemp(join(tmpdir(), "vt-presetname-bake-"));
    const dbPath = join(work, "test.db");
    const preFolder = await buildPreBakeFolder();

    // 1. Fresh DB at the pre-bake schema (message_variants.preset_id present).
    let db = await createDb(dbPath, preFolder);
    (db as unknown as { $client: Database }).$client.close();

    // 2. Seed via a raw FK-off connection: a live preset, a message chain, and
    //    two variants — one referencing the live preset, one an orphaned id.
    const seed = new Database(dbPath);
    seed.exec("PRAGMA foreign_keys=OFF");
    seed.exec("INSERT INTO prompt_presets (id, name, created_at, updated_at) VALUES ('preset-1', 'My Preset', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    seed.exec("INSERT INTO chats (id, character_id, active_branch_id, title, created_at, updated_at) VALUES ('chat-1', 'char-1', 'branch-1', 't', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    seed.exec("INSERT INTO chat_branches (id, chat_id, label, created_at) VALUES ('branch-1', 'chat-1', 'main', '2026-01-01T00:00:00.000Z')");
    seed.exec("INSERT INTO messages (id, chat_id, branch_id, role, author_type, position, content, state, created_at, updated_at) VALUES ('msg-1', 'chat-1', 'branch-1', 'assistant', 'assistant', 0, 'hello', 'complete', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    seed.exec("INSERT INTO message_variants (id, message_id, variant_index, content, is_selected, model_id, preset_id, created_at) VALUES ('var-live', 'msg-1', 0, 'hello', 1, 'model-x', 'preset-1', '2026-01-01T00:00:00.000Z')");
    seed.exec("INSERT INTO message_variants (id, message_id, variant_index, content, is_selected, model_id, preset_id, created_at) VALUES ('var-orphan', 'msg-1', 1, 'world', 0, 'model-x', 'preset-gone', '2026-01-01T00:00:00.000Z')");
    seed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    seed.close();

    // Sanity: pre-migration, preset_id FK exists and targets prompt_presets.
    {
      const r = new Database(dbPath, { readonly: true });
      const presetFks = foreignKeysOn(r, "message_variants").filter((f) => f.from === "preset_id");
      expect(presetFks).toHaveLength(1);
      expect(presetFks[0].table).toBe("prompt_presets");
      r.close();
    }

    // 3. Apply 0026 by re-running createDb with the FULL (real) migrations
    //    folder. 0000…0025 are already stamped, so drizzle runs only 0026.
    db = await createDb(dbPath, REAL_DRIZZLE);
    const client = (db as unknown as { $client: Database }).$client;

    // 4a. Backfill: the live-preset variant got the preset's NAME; the orphan
    //     (whose preset_id matched nothing) got NULL — its history is gone,
    //     which is honest. Other columns survived the rebuild copy.
    const vLive = client.query("SELECT preset_name, model_id, content FROM message_variants WHERE id = 'var-live'").get() as { preset_name: string | null; model_id: string | null; content: string };
    expect(vLive.preset_name).toBe("My Preset");
    expect(vLive.model_id).toBe("model-x");
    expect(vLive.content).toBe("hello");
    const vOrphan = client.query("SELECT preset_name FROM message_variants WHERE id = 'var-orphan'").get() as { preset_name: string | null };
    expect(vOrphan.preset_name).toBeNull();

    // 4b. The preset_id FK is gone (only the message_id cascade FK remains).
    const fksAfter = foreignKeysOn(client, "message_variants");
    expect(fksAfter.filter((f) => f.from === "preset_id")).toHaveLength(0);

    // 4c. THE REPORTED BUG: deleting the preset a variant was generated with no
    //     longer raises SQLITE_CONSTRAINT_FOREIGNKEY, and the baked name on the
    //     variant survives the preset's deletion.
    expect(() => client.exec("DELETE FROM prompt_presets WHERE id = 'preset-1'")).not.toThrow();
    const vLiveAfter = client.query("SELECT preset_name FROM message_variants WHERE id = 'var-live'").get() as { preset_name: string | null };
    expect(vLiveAfter.preset_name).toBe("My Preset");

    // 4d. The unique (message_id, variant_index) index was recreated by the
    //     rebuild (DROP TABLE had dropped it).
    const idx = client.query("PRAGMA index_list('message_variants')").all() as Array<{ name: string; unique: number }>;
    expect(idx.some((i) => i.name === "idx_message_variants_unique" && i.unique === 1)).toBe(true);

    client.close();
  });
});
