// Migration-repair machinery, extracted verbatim from db-connection.ts (TS-1).
//
// db-connection.ts sits exactly at its arch-gate baseline (1 083 lines), so the
// test-db-template hook could not be added without moving code out. This block
// — the shared statement/stamp/quote helpers plus the 0059-class table-rebuild
// pre-repair and gap-repair — is the cohesive unit that moved; nothing here
// changed, it just lives in its own file now.

import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Type-safe `.message` extraction from a caught value. Returns "" for non-Error
 *  so downstream `.includes()` / `.toLowerCase()` checks behave as before
 *  (the historical code used `err?.message ?? ''`). Used by the migration
 *  healing paths, which catch raw sqlite/bun:sqlite rejections. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

/** The full error story: the message plus the `.cause` chain (bounded, cycle-safe).
 *  drizzle's migrator wraps SQLite errors as
 *  `Failed to run the query '…'` with the actual SQLite reason one cause deeper —
 *  logging only the wrapper made the 2026-11-01 macOS smoke migration failure
 *  undiagnosable from CI logs. */
export function errorMessageChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const message = current.message;
    if (message && !parts.includes(message)) parts.push(message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  const chain = parts.join(" ← ");
  return chain || String(err);
}

/** Split migration SQL without treating semicolons inside line comments,
 * quoted literals or a trigger's BEGIN/END body as statement boundaries.
 * CASE/END expressions inside a trigger do not close its body.
 * Bun's sqlite.exec rejects comment-only input, so comments are removed. */
export function splitMigrationStatements(sqlContent: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let inLineComment = false;
  let inTriggerBody = false;
  let triggerCaseDepth = 0;

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
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      while (index + 1 < sqlContent.length && /[A-Za-z_0-9]/.test(sqlContent[index + 1])) index++;
      const word = sqlContent.slice(start, index + 1);
      if (inTriggerBody) {
        if (word.toUpperCase() === 'CASE') triggerCaseDepth++;
        else if (word.toUpperCase() === 'END') {
          if (triggerCaseDepth > 0) triggerCaseDepth--;
          else inTriggerBody = false;
        }
      } else if (word.toUpperCase() === 'BEGIN'
        && /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(current.trim())) {
        inTriggerBody = true;
      }
      current += word;
      continue;
    }
    if (char === ";") {
      if (inTriggerBody) {
        current += char;
        continue;
      }
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
    // The EXECUTED statements run through the same rename-safe
    // normalization as the staged migrate() folder (D4d): this path reads
    // the OFFICIAL folder's SQL raw, and a dunder-qualified CHECK
    // (`"__new_x"."col"`) either fails the rename on old SQLite (macOS
    // smoke, CI 2026-11-01) or survives qualified by the FINAL table name.
    // The hash above stays on the RAW file content — stamps and the
    // "applied — healthy" check must remain consistent with the official
    // ledger notion every other path reads.
    const statements = splitMigrationStatements(normalizeDunderCheckReferences(sqlContent));
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

/**
 * Heal partial migration state caused by previous runs where ensureAlterColumns()
 * added columns before migrate() ran, leaving the migration unstamped.
 *
 * Splits each unstamped migration's SQL into individual statements, runs each
 * one tolerating "already exists" / "duplicate column" errors, and stamps the
 * migration hash so the subsequent migrate() call skips it. Extracted verbatim
 * from db-connection.ts (which sits at its arch-gate baseline).
 */
export async function healPartialMigrations(sqlite: Database, migrationsFolder: string): Promise<void> {
  const journalPath = resolve(migrationsFolder, 'meta', '_journal.json');
  if (!await Bun.file(journalPath).exists()) return;
  const journal = JSON.parse(await Bun.file(journalPath).text());

  // Drizzle's migrator resumes from a single high-water mark, NOT by hash
  // membership: SQLiteSyncDialect.migrate reads the ONE row with the greatest
  // created_at and runs every journal entry whose folderMillis (`when`) exceeds
  // it. So "applied" here means `when <= MAX(created_at)` — the same notion.
  // Checking hash membership instead is a trap: when a migration is regenerated
  // with identical SQL (identical hash) but a new `when` — e.g. a branch-merge
  // reconciliation renumbering/re-dating it — existing DBs keep the stamp at the
  // OLD created_at. The hash is "present", so a hash-based heal would skip
  // re-stamping, yet that orphan row's created_at sits below the new
  // folderMillis, so migrate() re-runs the migration and dies on "table already
  // exists". Mirror drizzle's watermark exactly to stay self-consistent with it.
  let watermark = 0;
  try {
    const row = sqlite.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() as { created_at: number } | undefined;
    watermark = row ? Number(row.created_at) : 0;
  } catch {
    return; // No meta table yet — nothing to heal
  }

  let healed = 0;
  for (const entry of journal.entries) {
    if (entry.when <= watermark) continue; // at/below the watermark — migrate() will skip it too

    const sqlPath = resolve(migrationsFolder, `${entry.tag}.sql`);
    const sqlContent = await Bun.file(sqlPath).text();
    const hash = new Bun.CryptoHasher('sha256').update(sqlContent).digest('hex');

    // Rebuild migrations (CREATE TABLE `__new_<x>` ... DROP ... RENAME) must
    // NEVER run through this statement-by-statement path. It is not atomic,
    // and a partial run leaves a stray `__new_<x>` table that, on the next
    // heal attempt, makes the rebuild copy from / drop the wrong table and
    // destroys row data (`lorebooks` was emptied this way in June 2026: the
    // rebuild healed piecemeal, `lore_entries` survived only because a
    // DROP TABLE does not fire FK cascade). Rebuilds are only safe via
    // migrate()'s own (transactional) execution. If that failed, leave this
    // migration unstamped and let the retry migrate() below surface a real
    // error — a loud boot failure is strictly better than silent data loss.
    const isRebuild = /CREATE\s+TABLE\s+[`"']?__new_/i.test(sqlContent);
    if (isRebuild) {
      console.warn(`[db] Heal: migration ${entry.tag} is a table-rebuild — not safely retryable piecemeal, skipping heal (letting migrate() handle it).`);
      // STOP here — never touch any later entry. Later migrations may depend
      // on this rebuild's shape, and stamping a later one would advance the
      // drizzle watermark PAST this unstamped rebuild, so the retry migrate()
      // below would silently skip it forever (CI 2026-11-01, macOS npm smoke:
      // the heal stamped 0031..0135 around the skipped 0030/0131 rebuilds, the
      // retry ran nothing, and startup died on a unique-column guard far away
      // from the real defect). The rebuild is left for the retry, which either
      // applies it in order or fails loudly — never a silently wrong schema.
      break;
    }

    const statements = splitMigrationStatements(sqlContent);

    let allOk = true;
    for (const stmt of statements) {
      try {
        sqlite.exec(stmt + ';');
      } catch (err: unknown) {
        const msg = errorMessage(err).toLowerCase();
        if (msg.includes('already exists') || msg.includes('duplicate column')) {
          // Tolerate — column/table already present from a previous partial run
        } else {
          console.error(`[db] Heal: unexpected error in ${entry.tag}:`, errorMessage(err) || err);
          allOk = false;
        }
      }
    }

    if (allOk) {
      stampMigrationAtWhen(sqlite, hash, entry.when);
      watermark = entry.when; // advance so later entries are evaluated against the new high-water mark
      healed++;
      console.log(`[db] Heal: stamped migration ${entry.tag}`);
    }
  }

  if (healed > 0) {
    console.log(`[db] Heal: repaired ${healed} partial migration(s).`);
  }
}

// ── Rename-safe CHECK normalization (macOS smoke, CI 2026-11-01) ─────────────

/** drizzle-kit emits table-rebuild CHECK constraints with the temporary table
 *  name qualified in: CHECK(("__new_provider_profiles"."proxy_mode" = …)).
 *  SQLite ≥ 3.46 rewrites those references on ALTER TABLE RENAME; older
 *  builds (bun's macOS/arm64 build links one) re-parse the schema at the
 *  rename and fail: "error in table X after rename: no such column:
 *  __new_X.col". Unqualified column references resolve against the table
 *  itself under EITHER name, so stripping the qualification is safe on every
 *  SQLite ≥ 3.25 and changes no semantics (the pattern occurs only inside
 *  CHECK constraints in drizzle-kit output — verified over drizzle/ 0000-0135:
 *  exactly 0030 and 0131, three occurrences). */
export function normalizeDunderCheckReferences(sql: string): string {
  // Match the full qualified reference INCLUDING the column's opening quote
  // ("__new_x"."col") and emit a single opening quote — a bare
  // '"__new_x".' → '"' replacement would double the column's own quote.
  return sql.replace(/"__new_[A-Za-z0-9_]+"\."/g, '"');
}

/** Stage a migrate()-only copy of the migrations folder with rename-safe CHECK
 *  constraints (normalizeDunderCheckReferences applied to every .sql; meta/
 *  copied verbatim — journal `when` values drive drizzle's resume watermark, so
 *  stamps written from the staged files resume identically against the
 *  official folder — the watermark notion, not file hashes, is what every
 *  resume/heal path in this repo reads). Committed migration files are never
 *  edited; the temp copy lives only for this boot's migrate() call. */
export async function stageRenameSafeMigrationsFolder(migrationsFolder: string): Promise<string> {
  const staged = await mkdtemp(join(tmpdir(), 'vt-migrations-renamed-'));
  const files = await readdir(migrationsFolder, { recursive: true });
  for (const entry of files) {
    if (typeof entry !== 'string') continue;
    const source = resolve(migrationsFolder, entry);
    // Recursive readdir lists directory paths too — copy files only.
    if (!await stat(source).then((info) => info.isFile(), () => false)) continue;
    const target = resolve(staged, entry);
    await mkdir(resolve(target, '..'), { recursive: true });
    if (entry.endsWith('.sql')) {
      await Bun.write(target, normalizeDunderCheckReferences(await Bun.file(source).text()));
    } else {
      await Bun.write(target, await Bun.file(source).arrayBuffer());
    }
  }
  return staged;
}

/** True when migrate() has work to do: any journal entry sits above the
 *  database's high-water mark (the same watermark notion healPartialMigrations
 *  mirrors — see its comment). A fresh database counts as pending. */
export function hasPendingMigrations(sqlite: Database, migrationsFolder: string): Promise<boolean> {
  return (async () => {
    const journalPath = resolve(migrationsFolder, 'meta', '_journal.json');
    if (!await Bun.file(journalPath).exists()) return false;
    const journal = JSON.parse(await Bun.file(journalPath).text()) as MigrationJournal;
    const lastWhen = journal.entries.length > 0
      ? journal.entries.reduce((latest, entry) => entry.when > latest ? entry.when : latest, 0)
      : 0;
    let watermark = 0;
    try {
      const row = sqlite.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() as { created_at: number } | undefined;
      watermark = row ? Number(row.created_at) : 0;
    } catch {
      // No meta table yet — every journal entry is pending.
    }
    return lastWhen > watermark;
  })();
}
