import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { createDb } from "../src/db-connection.js";

describe("createDb repair migration statement parsing", () => {
  test("applies a stamped missing-table migration whose leading comments contain semicolons", async () => {
    const work = await mkdtemp(join(tmpdir(), "vt-repair-comments-"));
    const migrationsFolder = join(work, "drizzle");
    const metaFolder = join(migrationsFolder, "meta");
    const dbPath = join(work, "test.db");
    const tag = "0000_comment_repair";
    const when = 1_700_000_000_000;
    const sql = `-- Repair comments can contain punctuation; this must never become an empty SQL statement.
-- The statement below is intentionally stamped while its table is absent.
CREATE TABLE \`repair_target\` (\`id\` integer PRIMARY KEY NOT NULL);`;
    const hash = new Bun.CryptoHasher("sha256").update(sql).digest("hex");

    await mkdir(metaFolder, { recursive: true });
    await writeFile(join(migrationsFolder, `${tag}.sql`), sql);
    await writeFile(
      join(metaFolder, "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [{ idx: 0, version: "6", when, tag, breakpoints: true }],
      }),
    );

    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE existing_table (id integer PRIMARY KEY);
      CREATE TABLE __drizzle_migrations (
        id integer PRIMARY KEY AUTOINCREMENT,
        hash text NOT NULL UNIQUE,
        created_at integer NOT NULL
      );
    `);
    raw.prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    ).run(hash, when);
    raw.close();

    const db = await createDb(dbPath, migrationsFolder);
    (db as unknown as { $client: Database }).$client.close();

    const verify = new Database(dbPath, { readonly: true });
    const repaired = verify
      .query("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='repair_target'")
      .get() as { count: number };
    verify.close();
    expect(repaired.count).toBe(1);
  });
});
