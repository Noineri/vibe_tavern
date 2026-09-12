// L2b verification: the lore scope collapse migration (0062) must lose NO
// data. It is a data-only UPDATE — 'character'/'persona' scope values flip to
// 'entity' on lorebooks AND scripts; the typed owner FK columns
// (character_id / persona_id / chat_id) and the M:N junction tables
// (lorebook_links / script_links) are untouched, so every binding survives.
//
// Seeding uses RAW SQL (not the stores) so the test can write the LEGACY
// scope values that the collapsed taxonomy no longer produces — the exact
// rows a pre-collapse database carries. The migration SQL is then read from
// the committed drizzle file and executed verbatim, pinning what actually
// ships to user DBs.
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { createDb } from "../src/db-connection.js";

const MIGRATION_FILE = "0062_lore_scope_collapse.sql";

async function setupWithLegacyRows() {
  const dir = await mkdtemp(join(tmpdir(), "vt-scope-collapse-"));
  const db = await createDb(join(dir, "test.db"));

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

async function runCommittedMigration(db: Awaited<ReturnType<typeof createDb>>) {
  const raw = await readFile(resolve(import.meta.dir, "..", "drizzle", MIGRATION_FILE), "utf8");
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

const q = (db: Awaited<ReturnType<typeof createDb>>, sql: string) =>
  db.all(sql) as unknown as Array<Record<string, unknown>>;

describe("migration 0062 — lore scope collapse 4 → 3 (data-only)", () => {
  test("flips character/persona to entity on lorebooks AND scripts, losing no row, FK, or junction binding", async () => {
    const db = await setupWithLegacyRows();

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

    const statements = await runCommittedMigration(db);
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
    // Every entity row still carries exactly one typed owner FK.
    expect(q(db, "SELECT COUNT(*) n FROM lorebooks WHERE scope_type='entity' AND ((character_id IS NULL) = (persona_id IS NULL))")[0].n).toBe(0);
    expect(q(db, "SELECT COUNT(*) n FROM scripts WHERE scope_type='entity' AND ((character_id IS NULL) = (persona_id IS NULL))")[0].n).toBe(0);

  });

  test("is idempotent (re-running the UPDATEs changes nothing)", async () => {
    const db = await setupWithLegacyRows();
    await runCommittedMigration(db);
    const snapshot = q(db, "SELECT id, scope_type FROM lorebooks ORDER BY id");
    const links = q(db, "SELECT COUNT(*) n FROM lorebook_links")[0].n;
    await runCommittedMigration(db);
    expect(q(db, "SELECT id, scope_type FROM lorebooks ORDER BY id")).toEqual(snapshot);
    expect(q(db, "SELECT COUNT(*) n FROM lorebook_links")[0].n).toBe(links);
  });
});
