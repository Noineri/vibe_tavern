// Migration-repair machinery, extracted verbatim from db-connection.ts (TS-1).
//
// db-connection.ts sits exactly at its arch-gate baseline (1 083 lines), so the
// test-db-template hook could not be added without moving code out. This block
// — the shared statement/stamp/quote helpers plus the 0059-class table-rebuild
// pre-repair and gap-repair — is the cohesive unit that moved; nothing here
// changed, it just lives in its own file now.

import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

/** Type-safe `.message` extraction from a caught value. Returns "" for non-Error
 *  so downstream `.includes()` / `.toLowerCase()` checks behave as before
 *  (the historical code used `err?.message ?? ''`). Used by the migration
 *  healing paths, which catch raw sqlite/bun:sqlite rejections. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

/** Split migration SQL without treating semicolons inside line comments or
 * quoted literals as statement boundaries. Bun's sqlite.exec rejects
 * comment-only input, so comments are removed while scanning. */
export function splitMigrationStatements(sqlContent: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let inLineComment = false;

  for (let index = 0; index < sqlContent.length; index++) {
    const char = sqlContent[index];
    const next = sqlContent[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        current += char;
      }
      continue;
    }
    if (quote !== null) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          index++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      inLineComment = true;
      index++;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";") {
      const statement = current.trim();
      if (statement.length > 0) statements.push(statement);
      current = "";
      continue;
    }
    current += char;
  }

  const trailing = current.trim();
  if (trailing.length > 0) statements.push(trailing);
  return statements;
}

/**
 * Stamp one journal migration at its CURRENT `when` (drizzle folderMillis).
 *
 * Legacy Vibe Tavern DBs created `__drizzle_migrations` with UNIQUE(hash), while
 * drizzle-orm's own table has no hash uniqueness. A migration re-dated during a
 * branch reconciliation can therefore leave the same hash at an OLD created_at.
 * INSERT OR IGNORE silently does nothing in the legacy shape and leaves
 * drizzle's created_at watermark behind. Move an existing hash to the current
 * watermark; insert only when the hash is genuinely absent. This works for both
 * table shapes (and collapses any non-unique duplicate hashes to one timestamp).
 */
export function stampMigrationAtWhen(sqlite: Database, hash: string, when: number): void {
  const existing = sqlite.prepare('SELECT id FROM __drizzle_migrations WHERE hash = ? LIMIT 1').get(hash) as { id: number } | null;
  if (existing) {
    sqlite.prepare('UPDATE __drizzle_migrations SET created_at = ? WHERE hash = ?').run(when, hash);
    return;
  }
  sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(hash, when);
}

export function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export interface MigrationJournal {
  entries: { tag: string; when: number }[];
}

// ─── Table-rebuild NULL pre-repair + gap-repair ───────────────────────────
//
// The 0059 incident (2026-09-04, owner's live DB): drizzle-kit rebuild
// migrations copy a table into `__new_x` with tightened columns
// (`DEFAULT <v> NOT NULL`), and the INSERT…SELECT dies with
// "NOT NULL constraint failed" whenever the LEGACY table still allows NULLs
// in one of those columns (long-lived DBs whose rows predate the tightening —
// fresh installs are born NOT NULL from the baseline and can never hit it).
// The failure mode is nasty: migrate() rolls back, healPartialMigrations
// correctly refuses rebuilds piecemeal, but any LATER simple migration (0060)
// still gets stamped by the heal — the watermark jumps PAST the skipped
// rebuild and migrate() never retries it. The DB then runs forever on the
// pre-rebuild schema with no error (missing FK cascade, missing LG-4
// tri-state semantics, missing NOT NULL integrity).
//
// Two hooks close both doors:
//  1. preBackfillPendingRebuilds — BEFORE migrate(): for every still-PENDING
//     rebuild migration, backfill legacy NULLs with the target DEFAULT so the
//     rebuild applies in-order, in migrate()'s own transaction. No crash, no
//     scary heal output, nothing to heal.
//  2. repairSkippedRebuilds — AFTER the migration phase: for every UNSTAMPED
//     rebuild whose target table is still in the legacy shape (nullable where
//     the rebuild requires NOT NULL), re-apply the migration transactionally
//     (bun:sqlite .transaction — atomic, so no partial __new_ strays; the
//     June-2026 piecemeal-heal data loss cannot recur) and stamp it. Scoped
//     by SHAPE, not by ledger position, so DBs already past the watermark
//     (the heal-gap) are repaired too, while healthy DBs are untouched.

interface RebuildMigrationSpec {
  /** Final table name (the `__new_` prefix stripped). */
  targetTable: string;
  /** Columns the rebuilt table tightens to NOT NULL, mapped to their DEFAULT
   *  literal in SQL syntax (e.g. `''` or `0`) — the backfill values. */
  notNullDefaults: Map<string, string>;
}

/** Parse a drizzle-kit table-rebuild migration (CREATE TABLE `__new_x` …) into
 * the target table plus every column the rebuilt table requires NOT NULL
 * WITH a DEFAULT — exactly the columns whose legacy NULL rows make the
 * rebuild's INSERT…SELECT fail. */
function parseRebuildSpec(sqlContent: string): RebuildMigrationSpec | null {
  const create = sqlContent.match(/CREATE\s+TABLE\s+[`"']?__new_(\w+)[`"']?\s*\(/i);
  if (!create || create.index === undefined) return null;
  const targetTable = create[1];
  const bodyStart = create.index + create[0].length;
  const close = sqlContent.indexOf(');', bodyStart);
  if (close < 0) return null;
  const notNullDefaults = new Map<string, string>();
  for (const line of sqlContent.slice(bodyStart, close).split('\n')) {
    // Column lines start with a backticked name; FOREIGN KEY lines never do.
    const column = line.match(/^\s*`(\w+)`\s+\S+(?:\([^)]*\))?\s+(.+?),?\s*$/);
    if (!column) continue;
    const def = column[2].match(/DEFAULT\s+('(?:[^']|'')*'|-?\d+(?:\.\d+)?)\s+NOT\s+NULL/i);
    if (def) notNullDefaults.set(column[1], def[1]);
  }
  return { targetTable, notNullDefaults };
}

/** Column → notnull flag for a table, or null when the table does not exist. */
function tableNotNullFlags(sqlite: Database, table: string): Map<string, number> | null {
  try {
    const rows = sqlite.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`).all() as { name: string; notnull: number }[];
    if (rows.length === 0) return null;
    return new Map(rows.map((row) => [row.name.toLowerCase(), Number(row.notnull)]));
  } catch {
    return null;
  }
}

/** Backfill legacy NULL rows in the columns a rebuild will tighten to
 * NOT NULL, using each column's target DEFAULT. Only touches columns that
 * currently exist AND are still nullable (already-tight columns cannot hold
 * NULLs). Returns how many UPDATEs actually changed rows. */
function backfillRebuildNulls(sqlite: Database, spec: RebuildMigrationSpec): number {
  const flags = tableNotNullFlags(sqlite, spec.targetTable);
  if (!flags) return 0;
  let changed = 0;
  for (const [column, defaultLiteral] of spec.notNullDefaults) {
    const notnull = flags.get(column.toLowerCase());
    if (notnull === undefined || notnull === 1) continue;
    const result = sqlite
      .prepare(
        `UPDATE ${quoteSqlIdentifier(spec.targetTable)} SET ${quoteSqlIdentifier(column)} = ${defaultLiteral} WHERE ${quoteSqlIdentifier(column)} IS NULL`,
      )
      .run();
    if (result.changes > 0) changed++;
  }
  return changed;
}

/** Read the journal, or null when the folder has none. */
async function readMigrationJournal(migrationsFolder: string): Promise<MigrationJournal | null> {
  const journalPath = resolve(migrationsFolder, 'meta', '_journal.json');
  if (!await Bun.file(journalPath).exists()) return null;
  return JSON.parse(await Bun.file(journalPath).text()) as MigrationJournal;
}

/** Door 1 (see the block comment above): backfill NULLs for still-PENDING
 * rebuild migrations so migrate() applies them in-order without the NOT NULL
 * crash. Runs before the first migrate() attempt. */
export async function preBackfillPendingRebuilds(sqlite: Database, migrationsFolder: string): Promise<void> {
  const journal = await readMigrationJournal(migrationsFolder);
  if (!journal) return;
  let watermark = 0;
  try {
    const row = sqlite.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() as { created_at: number } | undefined;
    watermark = row ? Number(row.created_at) : 0;
  } catch {
    return; // no meta table yet — fresh DB, nothing legacy to backfill
  }
  for (const entry of journal.entries) {
    if (entry.when <= watermark) continue; // not pending — migrate() will skip it too
    const sqlContent = await Bun.file(resolve(migrationsFolder, `${entry.tag}.sql`)).text();
    const spec = parseRebuildSpec(sqlContent);
    if (!spec || spec.notNullDefaults.size === 0) continue;
    const changed = backfillRebuildNulls(sqlite, spec);
    if (changed > 0) {
      console.log(`[db] Pre-repair: backfilled legacy NULL rows in ${spec.targetTable} (${changed} column(s)) so rebuild migration ${entry.tag} can apply in-order.`);
    }
  }
}

/** Door 2 (see the block comment above): repair the heal-gap — rebuild
 * migrations left un-applied while the watermark moved past them. Runs after
 * the migration phase, still inside the FK-off scope. */
export async function repairSkippedRebuilds(sqlite: Database, migrationsFolder: string): Promise<void> {
  const journal = await readMigrationJournal(migrationsFolder);
  if (!journal) return;
  let stampedHashes: Set<string>;
  try {
    stampedHashes = new Set(
      (sqlite.prepare('SELECT hash FROM __drizzle_migrations').all() as { hash: string }[]).map((row) => row.hash),
    );
  } catch {
    return; // no meta table — nothing was ever applied, nothing to gap-repair
  }
  for (const entry of journal.entries) {
    const sqlContent = await Bun.file(resolve(migrationsFolder, `${entry.tag}.sql`)).text();
    const spec = parseRebuildSpec(sqlContent);
    if (!spec) continue;
    const hash = new Bun.CryptoHasher('sha256').update(sqlContent).digest('hex');
    if (stampedHashes.has(hash)) continue; // applied — healthy
    const flags = tableNotNullFlags(sqlite, spec.targetTable);
    if (!flags) continue; // target table absent — baseline/migrate() owns it
    let legacyShape = false;
    let incomplete = false;
    for (const column of spec.notNullDefaults.keys()) {
      const notnull = flags.get(column.toLowerCase());
      if (notnull === undefined) { incomplete = true; break; }
      if (notnull === 0) legacyShape = true;
    }
    if (incomplete) continue; // a tightening column is missing entirely — outside this repair's contract
    if (!legacyShape) continue; // already rebuilt (stamp merely lost) — leave the ledger to migrate()
    // A stray `__new_<table>` means someone ran the rebuild statements
    // non-transactionally (manual tampering). Repairing over it risks the
    // June-2026 copy-from-the-wrong-table loss — refuse loudly instead.
    const stray = sqlite
      .prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name = ?")
      .get(`__new_${spec.targetTable}`) as { cnt: number };
    if (stray.cnt > 0) {
      console.warn(`[db] Gap-repair: found a stray __new_${spec.targetTable} table — refusing to re-apply ${entry.tag} automatically. Inspect the DB manually.`);
      continue;
    }
    const backfilledColumns = backfillRebuildNulls(sqlite, spec);
    const statements = splitMigrationStatements(sqlContent);
    // Atomic by construction — a mid-rebuild failure rolls back to the intact
    // legacy table, so no partial `__new_` state can survive. This is the
    // property healPartialMigrations lacks (and correctly refuses rebuilds for).
    sqlite.transaction(() => {
      for (const stmt of statements) {
        sqlite.exec(stmt + ';');
      }
    })();
    stampMigrationAtWhen(sqlite, hash, entry.when);
    stampedHashes.add(hash);
    console.log(`[db] Gap-repair: migration ${entry.tag} was skipped by a failed boot but ${spec.targetTable} is still in its pre-rebuild shape — re-applied transactionally (${backfilledColumns} column(s) backfilled), stamped.`);
  }
}
