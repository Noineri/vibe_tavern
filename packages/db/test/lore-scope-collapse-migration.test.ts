// L2b verification: the lore scope collapse migration (0062) must lose NO
// data. It is a data-only UPDATE — 'character'/'persona' scope values flip to
// 'entity' on lorebooks AND scripts. Since migration 0107 removed the
// home-owner FK columns (LORE_SCRIPT_OWNERS_AS_LINKS step 1), this test seeds
// its fixtures against a journal truncated at 0106 (the last schema that
// still carries character_id/persona_id), pins 0062's scope flips there, and
// then lets the FULL journal run — 0107 must convert every entity-scoped home
// into a link row, dropping no book, script, or junction binding.
//
// Seeding uses RAW SQL (not the stores) so the test can write the LEGACY
// scope values that the collapsed taxonomy no longer produces — the exact
// rows a pre-collapse database carries. Migration 0062's SQL is read from the
// committed drizzle file and executed verbatim, pinning what actually ships
// to user DBs; 0107 runs through the real createDb path.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";

import { createDb, type AppDb } from "../src/db-connection.js";

const REAL_DRIZZLE_DIR = resolve(import.meta.dir, "..", "drizzle");
const MIGRATION_FILE = "0062_lore_scope_collapse.sql";
const PRE_0107_LAST_TAG = "0106_parallel_lucky_pierre";

interface JournalEntry { idx: number; version: string; when: number; tag: string; breakpoints: boolean }

/** A drizzle folder copy whose journal stops at the pre-0107 schema (home-owner columns present). */
async function buildPreMigrationFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vt-scope-collapse-"));
  const folder = join(dir, "drizzle");
  await mkdir(folder);
  const journal = JSON.parse(await readFile(resolve(REAL_DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] };
  const cut = journal.entries.findIndex((e) => e.tag === PRE_0107_LAST_TAG);
  if (cut < 0) throw new Error(`journal does not contain ${PRE_0107_LAST_TAG} — update PRE_0107_LAST_TAG for the new baseline`);
  const kept = journal.entries.slice(0, cut + 1);
  for (const entry of kept) {
    const sql = await readFile(resolve(REAL_DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
    await Bun.write(resolve(folder, `${entry.tag}.sql`), sql);
  }
  await mkdir(resolve(folder, "meta"), { recursive: true });
  await Bun.write(resolve(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  return folder;
}

async function setupWithLegacyRows(dbPath: string): Promise<AppDb> {
  const db = await createDb(dbPath, await buildPreMigrationFolder());

  // FK parents.
  await db.run(`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_L', 'C', '2026-01-01', '2026-01-01')`);
  await db.run(`INSERT INTO personas (id, name, description, default_for_new_chats, has_file_on_disk, created_at, updated_at) VALUES ('persona_L', 'P', '', 0, 0, '2026-01-01', '2026-01-01')`);
  await db.run(`INSERT INTO chats (id, character_id, active_branch_id, title, created_at, updated_at) VALUES ('chat_L', 'char_L', 'branch_L', 'T', '2026-01-01', '2026-01-01')`);

  // Legacy-scope rows (the pre-collapse taxonomy) + a global and a chat row
  // that must pass through untouched.
  await db.run(`INSERT INTO lorebooks (id, name, scope_type, character_id, persona_id, chat_id, created_at, updated_at) VALUES
    ('lb_char', 'Char home', 'character', 'char_L', NULL, NULL, '2026-01-01', '2026-01-01'),
    ('lb_persona', 'Persona home', 'persona', NULL, 'persona_L', NULL, '2026-01-01', '2026-01-01'),
    ('lb_global', 'Global', 'global', NULL, NULL, NULL, '2026-01-01', '2026-01-01'),
    ('lb_chat', 'Chat', 'chat', NULL, NULL, 'chat_L', '2026-01-01', '2026-01-01')`);
  await db.run(`INSERT INTO scripts (id, name, scope_type, character_id, persona_id, chat_id, created_at, updated_at) VALUES
    ('sc_char', 'Char home', 'character', 'char_L', NULL, NULL, '2026-01-01', '2026-01-01'),
    ('sc_persona', 'Persona home', 'persona', NULL, 'persona_L', NULL, '2026-01-01', '2026-01-01'),
    ('sc_global', 'Global', 'global', NULL, NULL, NULL, '2026-01-01', '2026-01-01'),
    ('sc_chat', 'Chat', 'chat', NULL, NULL, 'chat_L', '2026-01-01', '2026-01-01')`);

  // M:N junction bindings across BOTH target types — must survive verbatim.
  await db.run(`INSERT INTO lorebook_links (lorebook_id, target_type, target_id) VALUES
    ('lb_global', 'character', 'char_L'),
    ('lb_global', 'persona', 'persona_L')`);
  await db.run(`INSERT INTO script_links (script_id, target_type, target_id) VALUES
    ('sc_global', 'persona', 'persona_L')`);

  return db;
}

async function runCommittedMigration(db: AppDb, migrationFile: string): Promise<number> {
  const raw = await readFile(resolve(REAL_DRIZZLE_DIR, migrationFile), "utf8");
  // Split on drizzle's breakpoint marker FIRST, then strip comment lines per
  // statement (the marker itself starts with '--').
  const statements = raw
    .split("--> statement-breakpoint")
    .map((stmt) => stmt
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) await db.run(stmt);
  return statements.length;
}

const q = (db: AppDb, sql: string) =>
  db.all(sql) as unknown as Array<Record<string, unknown>>;

describe("migration 0062 — lore scope collapse 4 → 3 (data-only)", () => {
  test("flips character/persona to entity on lorebooks AND scripts, losing no row, FK, or junction binding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vt-scope-collapse-run-"));
    const dbPath = join(dir, "test.db");
    const db = await setupWithLegacyRows(dbPath);

    const before = {
      lbScopes: q(db, "SELECT scope_type, COUNT(*) n FROM lorebooks GROUP BY scope_type ORDER BY scope_type"),
      scScopes: q(db, "SELECT scope_type, COUNT(*) n FROM scripts GROUP BY scope_type ORDER BY scope_type"),
      lbLinks: q(db, "SELECT COUNT(*) n FROM lorebook_links")[0].n as number,
      scLinks: q(db, "SELECT COUNT(*) n FROM script_links")[0].n as number,
    };
    expect(before.lbScopes).toEqual([
      { scope_type: "character", n: 1 },
      { scope_type: "chat", n: 1 },
      { scope_type: "global", n: 1 },
      { scope_type: "persona", n: 1 },
    ]);
    expect(before.lbLinks).toBe(2);
    expect(before.scLinks).toBe(1);

    const statements = await runCommittedMigration(db, MIGRATION_FILE);
    expect(statements).toBe(2); // exactly the two UPDATEs — data-only

    const afterLb = q(db, "SELECT id, scope_type, character_id, persona_id, chat_id FROM lorebooks ORDER BY id");
    const afterSc = q(db, "SELECT id, scope_type, character_id, persona_id, chat_id FROM scripts ORDER BY id");

    // Every legacy row flipped to entity; global/chat rows untouched.
    expect(afterLb.find((r) => r.id === "lb_char")).toEqual({ id: "lb_char", scope_type: "entity", character_id: "char_L", persona_id: null, chat_id: null });
    expect(afterLb.find((r) => r.id === "lb_persona")).toEqual({ id: "lb_persona", scope_type: "entity", character_id: null, persona_id: "persona_L", chat_id: null });
    expect(afterLb.find((r) => r.id === "lb_global")?.scope_type).toBe("global");
    expect(afterLb.find((r) => r.id === "lb_chat")?.scope_type).toBe("chat");
    expect(afterSc.find((r) => r.id === "sc_char")).toEqual({ id: "sc_char", scope_type: "entity", character_id: "char_L", persona_id: null, chat_id: null });
    expect(afterSc.find((r) => r.id === "sc_persona")).toEqual({ id: "sc_persona", scope_type: "entity", character_id: null, persona_id: "persona_L", chat_id: null });
    expect(afterSc.find((r) => r.id === "sc_global")?.scope_type).toBe("global");
    expect(afterSc.find((r) => r.id === "sc_chat")?.scope_type).toBe("chat");

    // No rows lost; no binding lost.
    expect(q(db, "SELECT COUNT(*) n FROM lorebooks")[0].n).toBe(4);
    expect(q(db, "SELECT COUNT(*) n FROM scripts")[0].n).toBe(4);
    expect(q(db, "SELECT COUNT(*) n FROM lorebook_links")[0].n).toBe(before.lbLinks);
    expect(q(db, "SELECT COUNT(*) n FROM script_links")[0].n).toBe(before.scLinks);
    // Junction target types are NOT rewritten (they name entity TARGETS, not scopes).
    expect(q(db, "SELECT DISTINCT target_type FROM lorebook_links ORDER BY target_type")).toEqual([
      { target_type: "character" },
      { target_type: "persona" },
    ]);

    // No legacy value remains anywhere.
    expect(q(db, "SELECT COUNT(*) n FROM lorebooks WHERE scope_type IN ('character','persona')")[0].n).toBe(0);
    expect(q(db, "SELECT COUNT(*) n FROM scripts WHERE scope_type IN ('character','persona')")[0].n).toBe(0);

    (db as unknown as { $client: Database }).$client.close();

    // And the FULL journal still applies on top of this state: 0107 turns the
    // entity homes into links and drops the home-owner columns without losing
    // a single book, script, or junction row.
    const migrated = await createDb(dbPath);
    const lbCols = q(migrated, "PRAGMA table_info(lorebooks)").map((c) => c.name);
    const scCols = q(migrated, "PRAGMA table_info(scripts)").map((c) => c.name);
    expect(lbCols).not.toContain("character_id");
    expect(lbCols).not.toContain("persona_id");
    expect(scCols).not.toContain("character_id");
    expect(scCols).not.toContain("persona_id");
    expect(q(migrated, "SELECT COUNT(*) n FROM lorebooks")[0].n).toBe(4);
    expect(q(migrated, "SELECT COUNT(*) n FROM scripts")[0].n).toBe(4);
    // Homes became links (lb_char → char_L, lb_persona → persona_L, and the
    // script twins) ON TOP of the pre-existing junction rows — deduplicated.
    const lbLinks = q(migrated, "SELECT lorebook_id, target_type, target_id FROM lorebook_links ORDER BY lorebook_id").map((r) => `${r.lorebook_id}:${r.target_type}:${r.target_id}`);
    expect(lbLinks).toEqual(["lb_char:character:char_L", "lb_global:character:char_L", "lb_global:persona:persona_L", "lb_persona:persona:persona_L"]);
    const scLinks = q(migrated, "SELECT script_id, target_type, target_id FROM script_links ORDER BY script_id").map((r) => `${r.script_id}:${r.target_type}:${r.target_id}`);
    expect(scLinks).toEqual(["sc_char:character:char_L", "sc_global:persona:persona_L", "sc_persona:persona:persona_L"]);
  });

  test("is idempotent (re-running the UPDATEs changes nothing)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vt-scope-collapse-idem-"));
    const dbPath = join(dir, "test.db");
    const db = await setupWithLegacyRows(dbPath);
    await runCommittedMigration(db, MIGRATION_FILE);
    const snapshot = q(db, "SELECT id, scope_type FROM lorebooks ORDER BY id");
    const links = q(db, "SELECT COUNT(*) n FROM lorebook_links")[0].n;
    await runCommittedMigration(db, MIGRATION_FILE);
    expect(q(db, "SELECT id, scope_type FROM lorebooks ORDER BY id")).toEqual(snapshot);
    expect(q(db, "SELECT COUNT(*) n FROM lorebook_links")[0].n).toBe(links);
  });
});
