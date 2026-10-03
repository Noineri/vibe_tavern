import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { createDb } from "../src/db-connection.js";

/**
 * CG-1 seed-migration tests (0104): the migration that creates
 * `coauthor_connection_settings` also seeds the row of the currently bound
 * Co-Author connection from the legacy `ui_settings` global overrides
 * (coauthor_model_name / coauthor_max_tokens / coauthor_context_budget).
 *
 * The pre-state is built the migration-proxy-policy.test.ts way: copy the real
 * drizzle folder, slice the journal right before the migration that creates
 * the new table, migrate a throwaway DB to that state, insert legacy rows via
 * raw SQL, then re-open with the REAL folder so the new migration (+ seed)
 * applies. The migration is located by its CREATE TABLE — not by tag — so
 * later migrations stacking on top do not break this test.
 */

const REAL_DRIZZLE = resolve(import.meta.dir, "..", "drizzle");

interface JournalShape {
  entries: Array<{ tag: string }>;
}

interface SeededRow {
  provider_profile_id: string;
  model_name: string | null;
  settings_json: string;
}

async function buildPreSeedFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vt-coauthor-seed-pre-"));
  const folder = join(dir, "drizzle");
  const meta = join(folder, "meta");
  await mkdir(meta, { recursive: true });
  await cp(REAL_DRIZZLE, folder, { recursive: true });

  const journalPath = join(meta, "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as JournalShape;

  let cutIndex = -1;
  for (let i = 0; i < journal.entries.length; i++) {
    const sql = Bun.file(join(folder, `${journal.entries[i].tag}.sql`));
    if (!(await sql.exists())) continue;
    if ((await sql.text()).includes("CREATE TABLE `coauthor_connection_settings`")) {
      cutIndex = i;
      break;
    }
  }
  if (cutIndex === -1) {
    throw new Error("coauthor_connection_settings migration missing from the real journal");
  }

  for (const entry of journal.entries.slice(cutIndex)) {
    const prefix = entry.tag.slice(0, 4);
    await rm(join(folder, `${entry.tag}.sql`), { force: true });
    await rm(join(meta, `${prefix}_snapshot.json`), { force: true });
  }
  journal.entries = journal.entries.slice(0, cutIndex);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  return folder;
}

function rawClient(db: Awaited<ReturnType<typeof createDb>>): Database {
  return (db as unknown as { $client: Database }).$client;
}

function insertProvider(client: Database, id: string): void {
  client.exec(`
    INSERT INTO provider_profiles (
      id, name, provider_preset, endpoint, api_key, created_at, updated_at
    ) VALUES (
      '${id}', '${id}', 'openai', 'https://example.test/v1', 'secret',
      '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z'
    )
  `);
}

function insertUiSettings(
  client: Database,
  coauthorProviderId: string | null,
  coauthorModelName: string | null,
  coauthorMaxTokens: number | null,
  coauthorContextBudget: number | null,
): void {
  client.run(
    `INSERT INTO ui_settings (id, coauthor_provider_id, coauthor_model_name, coauthor_max_tokens, coauthor_context_budget, updated_at)
     VALUES ('default', ?, ?, ?, ?, '2026-10-03T00:00:00.000Z')`,
    [coauthorProviderId, coauthorModelName, coauthorMaxTokens, coauthorContextBudget],
  );
}

function readSeededRows(client: Database): SeededRow[] {
  return client
    .query("SELECT provider_profile_id, model_name, settings_json FROM coauthor_connection_settings")
    .all() as SeededRow[];
}

describe("0104 coauthor_connection_settings seed migration", () => {
  test("bound connection gets its row from the legacy global overrides; others get none", async () => {
    const preFolder = await buildPreSeedFolder();
    const work = await mkdtemp(join(tmpdir(), "vt-coauthor-seed-bound-"));
    const dbPath = join(work, "test.db");

    let db = await createDb(dbPath, preFolder);
    const client = rawClient(db);
    insertProvider(client, "provider-bound");
    insertProvider(client, "provider-unbound");
    // The owner's live shape at plan time: model + both token overrides set.
    insertUiSettings(client, "provider-bound", "kimi-k2.5", 15_000, 1_048_576);
    client.close();

    db = await createDb(dbPath, REAL_DRIZZLE);
    const rows = readSeededRows(rawClient(db));

    expect(rows).toHaveLength(1);
    expect(rows[0].provider_profile_id).toBe("provider-bound");
    expect(rows[0].model_name).toBe("kimi-k2.5");
    // Seed stores ONLY the explicit legacy values; the domain resolver
    // completes the rest (no defaults frozen into the migration).
    expect(JSON.parse(rows[0].settings_json)).toEqual({
      maxTokens: 15_000,
      contextBudget: 1_048_576,
    });
  });

  test("a dangling coauthor_provider_id seeds nothing", async () => {
    const preFolder = await buildPreSeedFolder();
    const work = await mkdtemp(join(tmpdir(), "vt-coauthor-seed-dangling-"));
    const dbPath = join(work, "test.db");

    let db = await createDb(dbPath, preFolder);
    const client = rawClient(db);
    insertProvider(client, "provider-alive");
    insertUiSettings(client, "provider-gone", "kimi-k2.5", 15_000, 1_048_576);
    client.close();

    db = await createDb(dbPath, REAL_DRIZZLE);
    expect(readSeededRows(rawClient(db))).toEqual([]);
  });

  test("a bound connection with only some legacy overrides keeps the seed row partial", async () => {
    const preFolder = await buildPreSeedFolder();
    const work = await mkdtemp(join(tmpdir(), "vt-coauthor-seed-partial-"));
    const dbPath = join(work, "test.db");

    let db = await createDb(dbPath, preFolder);
    const client = rawClient(db);
    insertProvider(client, "provider-bound");
    // Only the model + max tokens carry values; the budget was never set.
    insertUiSettings(client, "provider-bound", "glm-4.7", 4_096, null);
    client.close();

    db = await createDb(dbPath, REAL_DRIZZLE);
    const rows = readSeededRows(rawClient(db));

    expect(rows).toHaveLength(1);
    expect(rows[0].model_name).toBe("glm-4.7");
    expect(JSON.parse(rows[0].settings_json)).toEqual({ maxTokens: 4_096 });
  });

  test("a bound connection with no legacy values still gets a row (empty set, no model)", async () => {
    const preFolder = await buildPreSeedFolder();
    const work = await mkdtemp(join(tmpdir(), "vt-coauthor-seed-empty-"));
    const dbPath = join(work, "test.db");

    let db = await createDb(dbPath, preFolder);
    const client = rawClient(db);
    insertProvider(client, "provider-bound");
    insertUiSettings(client, "provider-bound", null, null, null);
    client.close();

    db = await createDb(dbPath, REAL_DRIZZLE);
    const rows = readSeededRows(rawClient(db));

    // The binding itself is preserved: the connection keeps a row whose set
    // resolves entirely to the Co-Author defaults and whose model is unset.
    expect(rows).toHaveLength(1);
    expect(rows[0].model_name).toBeNull();
    expect(JSON.parse(rows[0].settings_json)).toEqual({});
  });

  test("no ui_settings row at all → nothing seeded (fresh-install path)", async () => {
    const preFolder = await buildPreSeedFolder();
    const work = await mkdtemp(join(tmpdir(), "vt-coauthor-seed-fresh-"));
    const dbPath = join(work, "test.db");

    const db = await createDb(dbPath, REAL_DRIZZLE);
    expect(readSeededRows(rawClient(db))).toEqual([]);
  });
});
