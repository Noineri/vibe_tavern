import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import * as schema from './db-schema.js';

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

/** Type-safe `.message` extraction from a caught value. Returns "" for non-Error
 *  so downstream `.includes()` / `.toLowerCase()` checks behave as before
 *  (the historical code used `err?.message ?? ''`). Used by the migration
 *  healing paths below, which catch raw sqlite/bun:sqlite rejections. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

/** Split migration SQL without treating semicolons inside line comments or
 * quoted literals as statement boundaries. Bun's sqlite.exec rejects
 * comment-only input, so comments are removed while scanning. */
function splitMigrationStatements(sqlContent: string): string[] {
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

interface DrizzleSnapshotColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: string | number | boolean;
}

interface DrizzleSnapshotForeignKey {
  tableTo: string;
  columnsFrom: string[];
  columnsTo: string[];
  onDelete?: string;
  onUpdate?: string;
}

interface DrizzleSnapshotTable {
  name: string;
  columns: Record<string, DrizzleSnapshotColumn>;
  indexes: Record<string, { columns: string[]; isUnique: boolean }>;
  foreignKeys: Record<string, DrizzleSnapshotForeignKey>;
  uniqueConstraints: Record<string, { columns: string[] }>;
}

interface DrizzleSnapshot {
  tables: Record<string, DrizzleSnapshotTable>;
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Resolve the drizzle migrations folder.
 *
 * Works in three contexts:
 *  1. Source/dev     — this file at packages/db/src/ → drizzle at packages/db/drizzle/
 *  2. Docker         — source tree intact, or compiled dist under packages/db/dist/
 *  3. Standalone exe — import.meta.dir = exe directory, drizzle/ copied next to it
 *
 * Strategy: walk up from this file's directory looking for drizzle/meta/_journal.json.
 * Falls back to explicit RP_PLATFORM_MIGRATIONS_DIR env var.
 */
export async function resolveMigrationsFolder(): Promise<string> {
  const envDir = process.env.RP_PLATFORM_MIGRATIONS_DIR;
  if (envDir) return envDir;

  const exeDir = resolve(process.execPath, '..');
  const exeCandidate = resolve(exeDir, 'drizzle');
  if (await Bun.file(resolve(exeCandidate, 'meta', '_journal.json')).exists()) {
    return exeCandidate;
  }

  const thisDir = import.meta.dir;
  let dir = thisDir;
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, 'drizzle');
    if (await Bun.file(resolve(candidate, 'meta', '_journal.json')).exists()) {
      return candidate;
    }
    dir = resolve(dir, '..');
  }

  return resolve(thisDir, '..', 'drizzle');
}

/**
 * Rebase an existing DB onto a squashed migration baseline.
 *
 * When the migration history is squashed to a single baseline (see the squash
 * that collapsed the 43-migration history into one `0000_baseline`), upgrading
 * users still carry the OLD migration hashes in `__drizzle_migrations`. The
 * squashed baseline has a different hash, so drizzle's `migrate()` would see it
 * as pending and try to run its `CREATE TABLE` statements — which fail loudly on
 * the already-present tables.
 *
 * migrate() decides what to apply purely by timestamp (`created_at` of the last
 * stamped migration vs the journal entry's `when`), so stamping the baseline as
 * applied here makes migrate() skip it. The safety gate: we ONLY stamp when every
 * table the baseline creates ALREADY exists in the DB (a subset check, so extra
 * columns like the deprecated `characters.is_system` zombie don't trip it). If the
 * tables are not all present, we leave the migration unstamped and let migrate()
 * run it for real — a fresh DB needs the schema, and a partial/ancient DB that's
 * missing tables should surface a loud boot error rather than be silently skipped.
 */
async function rebaseToBaseline(sqlite: Database, migrationsFolder: string): Promise<void> {
  // Only relevant once the migration meta table exists (an upgrading user).
  // Fresh DBs (no meta) are handled by baselineLegacyDb returning false + migrate().
  const hasMeta = sqlite
    .prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
    .get() as { cnt: number } | null;
  if (!hasMeta || hasMeta.cnt === 0) return;

  const journalPath = resolve(migrationsFolder, 'meta', '_journal.json');
  if (!await Bun.file(journalPath).exists()) return;
  const journal = JSON.parse(await Bun.file(journalPath).text());

  const stamped = new Set<string>(
    (sqlite.prepare('SELECT hash FROM __drizzle_migrations').all() as { hash: string }[])
      .map((r) => r.hash),
  );

  const existingTables = new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '__drizzle%'")
      .all() as { name: string }[])
      .map((r) => r.name.toLowerCase()),
  );

  const insert = sqlite.prepare(
    'INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
  );

  let stampedCount = 0;
  for (const entry of journal.entries) {
    const sqlPath = resolve(migrationsFolder, `${entry.tag}.sql`);
    const sqlContent = await Bun.file(sqlPath).text();
    const hash = new Bun.CryptoHasher('sha256').update(sqlContent).digest('hex');
    if (stamped.has(hash)) continue; // already applied

    const createdTables = [...sqlContent.matchAll(/CREATE\s+(?:TABLE|VIRTUAL TABLE)\s+(?:IF NOT EXISTS\s+)?[`"']?(\w+)/gmi)]
      .map((m) => m[1])
      .filter((t) => !t.startsWith('__drizzle') && !t.startsWith('__new'));

    if (createdTables.length > 0 && createdTables.every((t) => existingTables.has(t.toLowerCase()))) {
      insert.run(hash, entry.when);
      stamped.add(hash);
      stampedCount++;
      console.log(`[db] Rebase: migration ${entry.tag} schema already present — stamped as applied (SQL skipped).`);
    }
    // else: tables missing — leave unstamped so migrate() runs it (fresh/partial DB).
  }
  if (stampedCount > 0) {
    console.log(`[db] Rebased onto squashed baseline — ${stampedCount} migration(s) pre-stamped.`);
  }
}

/**
 * Detect a database created by the legacy ensureSchema() approach
 * (before drizzle migrations existed) and stamp only the migrations
 * whose tables already exist in the DB.
 *
 * This prevents stamping migrations that create NEW tables not yet
 * present in an older DB (e.g. lorebooks/scripts added after initial release).
 *
 * Returns true if the DB was baselined.
 */
async function baselineLegacyDb(sqlite: Database, migrationsFolder: string): Promise<boolean> {
  // If drizzle's meta table already exists, nothing to baseline
  const hasMeta = sqlite
    .prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
    .get() as { cnt: number } | null;
  if (hasMeta && hasMeta.cnt > 0) return false;

  // If there are zero user tables, this is a brand-new DB — let migrate() handle it
  const userTables = sqlite
    .prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE '__drizzle%'")
    .get() as { cnt: number } | null;
  if (!userTables || userTables.cnt === 0) return false;

  // Get all existing table names
  const existingRows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '__drizzle%'")
    .all() as { name: string }[];
  const existingTables = new Set(existingRows.map(r => r.name));

  // Legacy DB detected: tables exist but no migration tracking.
  // Read the journal and only stamp migrations whose tables are all present.
  const journalPath = resolve(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(await Bun.file(journalPath).text());

  // Create the meta table (same structure drizzle expects)
  sqlite.exec(`
    CREATE TABLE __drizzle_migrations (
      id integer PRIMARY KEY AUTOINCREMENT,
      hash text NOT NULL UNIQUE,
      created_at integer NOT NULL
    );
  `);

  const insert = sqlite.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)'
  );

  let stamped = 0;
  for (const entry of journal.entries) {
    const sqlPath = resolve(migrationsFolder, `${entry.tag}.sql`);
    const sqlContent = await Bun.file(sqlPath).text();

    // Extract table names created by this migration
    const createdTables = [...sqlContent.matchAll(/CREATE\s+TABLE\s+[`"']?(\w+)/gmi)]
      .map(m => m[1])
      .filter(t => !t.startsWith('__drizzle') && !t.startsWith('__new'));
    const allExist = createdTables.length > 0 && createdTables.every(t => existingTables.has(t));

    if (allExist) {
      const hash = new Bun.CryptoHasher('sha256').update(sqlContent).digest('hex');
      insert.run(hash, entry.when);
      stamped++;
    } else {
      console.log(`[db] Migration ${entry.tag} has new tables (${createdTables.filter(t => !existingTables.has(t)).join(', ')}), will apply via migrate().`);
    }
  }

  console.log(`[db] Baselined legacy database — ${stamped}/${journal.entries.length} migration(s) marked as applied.`);
  return true;
}

/**
 * Post-migration repair: if older builds incorrectly stamped migrations
 * as applied (baselineLegacyDb bug), new tables/columns won't exist. This function
 * reads each migration's SQL, checks if its tables AND columns exist, and applies the
 * SQL directly if any are missing.
 */
async function repairMissingTables(sqlite: Database, migrationsFolder: string): Promise<void> {
  const existingRows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  const existing = new Set(existingRows.map(r => r.name.toLowerCase()));

  // Cache column info per table on-demand
  const columnCache = new Map<string, Set<string>>();
  function hasColumn(table: string, column: string): boolean {
    const tbl = table.toLowerCase();
    if (!columnCache.has(tbl)) {
      try {
        const cols = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
        columnCache.set(tbl, new Set(cols.map(c => c.name.toLowerCase())));
      } catch {
        columnCache.set(tbl, new Set());
      }
    }
    return columnCache.get(tbl)!.has(column.toLowerCase());
  }

  const journalPath = resolve(migrationsFolder, 'meta', '_journal.json');
  if (!await Bun.file(journalPath).exists()) return;
  const journal = JSON.parse(await Bun.file(journalPath).text());

  let repaired = 0;
  for (const entry of journal.entries) {
    const sqlPath = resolve(migrationsFolder, `${entry.tag}.sql`);
    const sqlContent = await Bun.file(sqlPath).text();

    // Extract table names from this migration
    const createdTables = [...sqlContent.matchAll(/CREATE\s+TABLE\s+[`"']?(\w+)/gmi)]
      .map(m => m[1])
      .filter(t => !t.startsWith('__drizzle') && !t.startsWith('__new'));

    // Extract ALTER TABLE ... ADD COLUMN statements
    const alterCols = [...sqlContent.matchAll(/ALTER\s+TABLE\s+[`"']?(\w+)[`"']?\s+ADD\s+(?:COLUMN\s+)?[`"']?(\w+)/gmi)]
      .map(m => ({ table: m[1], column: m[2] }));

    // Check if any table from this migration is missing
    const missingTables = createdTables.filter(t => !existing.has(t.toLowerCase()));
    // Check if any ALTER TABLE column is missing
    const missingCols = alterCols.filter(({ table, column }) => existing.has(table.toLowerCase()) && !hasColumn(table, column));

    if (missingTables.length === 0 && missingCols.length === 0) continue;

    const reasons: string[] = [];
    if (missingTables.length > 0) reasons.push(`tables (${missingTables.join(', ')})`);
    if (missingCols.length > 0) reasons.push(`columns (${missingCols.map(c => `${c.table}.${c.column}`).join(', ')})`);
    console.log(`[db] Repair: migration ${entry.tag} missing ${reasons.join(' and ')}, applying...`);
    try {
      // Apply statements individually to tolerate partial state
      // (e.g. ALTER TABLE column already exists but CREATE TABLE is missing)
      const statements = splitMigrationStatements(sqlContent);
      for (const stmt of statements) {
        try {
          sqlite.exec(stmt);
        } catch (stmtErr: unknown) {
          // Ignore "duplicate column" and "already exists" errors
          if (errorMessage(stmtErr).includes('duplicate column') || errorMessage(stmtErr).includes('already exists')) {
            continue;
          }
          throw stmtErr;
        }
      }
      // Stamp this migration as applied so migrate() skips it next time
      const hash = new Bun.CryptoHasher('sha256').update(sqlContent).digest('hex');
      sqlite.prepare('INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(hash, entry.when);
      repaired++;
      // Update existing set
      for (const t of createdTables) existing.add(t.toLowerCase());
      // Update column cache
      for (const { table, column } of alterCols) {
        const tbl = table.toLowerCase();
        columnCache.get(tbl)?.add(column.toLowerCase());
      }
    } catch (err) {
      console.error(`[db] Repair: failed to apply ${entry.tag}:`, err);
    }
  }

  if (repaired > 0) {
    console.log(`[db] Repair: applied ${repaired} missing migration(s) (tables + columns).`);
  }
}

/**
 * Reconcile columns against the latest Drizzle snapshot, which represents the
 * final schema after every migration. Reading the final snapshot (rather than
 * CREATE TABLE statements from the baseline) is essential: baseline columns
 * may be intentionally removed by later rebuild migrations and must never be
 * resurrected.
 *
 * Only additive ALTER TABLE operations are allowed here. Any missing primary or
 * unique column fails startup rather than attempting a destructive table rebuild.
 */
async function ensureFinalSchemaColumns(sqlite: Database, migrationsFolder: string): Promise<void> {
  const metaFolder = resolve(migrationsFolder, 'meta');
  const journalPath = resolve(metaFolder, '_journal.json');
  if (!await Bun.file(journalPath).exists()) return;
  const journal = JSON.parse(await Bun.file(journalPath).text()) as {
    entries?: { idx: number }[];
  };
  const entries = journal.entries ?? [];
  if (entries.length === 0) return;
  const latestEntry = entries.reduce(
    (latest, entry) => entry.idx > latest.idx ? entry : latest,
  );

  const snapshotPath = resolve(
    metaFolder,
    `${String(latestEntry.idx).padStart(4, '0')}_snapshot.json`,
  );
  if (!await Bun.file(snapshotPath).exists()) return;
  const snapshot = JSON.parse(await Bun.file(snapshotPath).text()) as DrizzleSnapshot;
  const tableRows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  const existingTables = new Set(tableRows.map(row => row.name.toLowerCase()));
  const columnCache = new Map<string, Set<string>>();

  function columnsFor(table: string): Set<string> {
    const key = table.toLowerCase();
    let columns = columnCache.get(key);
    if (!columns) {
      const rows = sqlite
        .prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`)
        .all() as { name: string }[];
      columns = new Set(rows.map(row => row.name.toLowerCase()));
      columnCache.set(key, columns);
    }
    return columns;
  }

  let fixed = 0;
  for (const table of Object.values(snapshot.tables)) {
    if (!existingTables.has(table.name.toLowerCase())) continue;
    for (const column of Object.values(table.columns)) {
      if (columnsFor(table.name).has(column.name.toLowerCase())) continue;
      const isUnique = Object.values(table.indexes).some(
        index => index.isUnique && index.columns.includes(column.name),
      ) || Object.values(table.uniqueConstraints).some(
        constraint => constraint.columns.includes(column.name),
      );
      if (column.primaryKey || isUnique) {
        throw new Error(
          `[db] Cannot safely restore constrained column ${table.name}.${column.name} with ALTER TABLE`,
        );
      }

      const definition = [column.type];
      if (column.default !== undefined) {
        const defaultSql = typeof column.default === 'boolean'
          ? (column.default ? '1' : '0')
          : String(column.default);
        definition.push(`DEFAULT ${defaultSql}`);
      }
      if (column.notNull) definition.push('NOT NULL');
      const foreignKey = Object.values(table.foreignKeys).find(
        key => key.columnsFrom.length === 1 && key.columnsFrom[0] === column.name,
      );
      if (foreignKey?.columnsTo[0]) {
        definition.push(
          `REFERENCES ${quoteSqlIdentifier(foreignKey.tableTo)}(${quoteSqlIdentifier(foreignKey.columnsTo[0])})`,
        );
        if (foreignKey.onUpdate) definition.push(`ON UPDATE ${foreignKey.onUpdate}`);
        if (foreignKey.onDelete) definition.push(`ON DELETE ${foreignKey.onDelete}`);
      }

      sqlite.exec(
        `ALTER TABLE ${quoteSqlIdentifier(table.name)} ADD COLUMN ${quoteSqlIdentifier(column.name)} ${definition.join(' ')}`,
      );
      columnsFor(table.name).add(column.name.toLowerCase());
      fixed++;
      console.log(`[db] Pre-flight: restored final-schema column ${table.name}.${column.name}`);
    }
  }

  if (fixed > 0) {
    console.log(`[db] Pre-flight: restored ${fixed} column(s) omitted by legacy baselining.`);
  }
}

/**
 * Pre-flight: ensure ALTER TABLE ADD COLUMN statements from all migrations
 * have been applied. Unlike repairMissingTables (which only looks at unstamped
 * migrations), this checks EVERY migration's ALTER TABLE statements against
 * the actual DB columns, regardless of stamp status.
 *
 * This is needed because baselineLegacyDb or older migrate() versions may have
 * stamped column-only migrations as applied without actually running the SQL.
 */
async function ensureAlterColumns(sqlite: Database, migrationsFolder: string): Promise<void> {
  const journalPath = resolve(migrationsFolder, 'meta', '_journal.json');
  if (!await Bun.file(journalPath).exists()) return;
  const journal = JSON.parse(await Bun.file(journalPath).text());

  // Cache column info per table
  const columnCache = new Map<string, Set<string>>();
  function hasColumn(table: string, column: string): boolean {
    const tbl = table.toLowerCase();
    if (!columnCache.has(tbl)) {
      try {
        const cols = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
        columnCache.set(tbl, new Set(cols.map(c => c.name.toLowerCase())));
      } catch {
        columnCache.set(tbl, new Set());
      }
    }
    return columnCache.get(tbl)!.has(column.toLowerCase());
  }

  let fixed = 0;
  for (const entry of journal.entries) {
    const sqlPath = resolve(migrationsFolder, `${entry.tag}.sql`);
    const sqlContent = await Bun.file(sqlPath).text();

    // Only check ALTER TABLE ... ADD COLUMN (CREATE TABLE is handled by migrate)
    const alterCols = [...sqlContent.matchAll(/ALTER\s+TABLE\s+[`"']?(\w+)[`"']?\s+ADD\s+(?:COLUMN\s+)?[`"']?(\w+)/gmi)]
      .map(m => ({ table: m[1], column: m[2] }));

    for (const { table, column } of alterCols) {
      if (hasColumn(table, column)) continue;
      // Derive column type + optional default/not-null from the SQL
      const typeMatch = sqlContent.match(new RegExp(`ALTER\\s+TABLE\\s+[\`"']?${table}[\`"']?\\s+ADD\\s+(?:COLUMN\\s+)?[\`"']?${column}[\`"']?\\s+([^;\n]+)`, 'i'));
      const colDef = typeMatch?.[1]?.trim() ?? 'text';
      try {
        sqlite.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${colDef}`);
        console.log(`[db] Pre-flight: added ${table}.${column} (${colDef})`);
        fixed++;
        // Invalidate column cache for this table
        columnCache.delete(table.toLowerCase());
      } catch (err: unknown) {
        console.error(`[db] Pre-flight: failed to add ${table}.${column}:`, errorMessage(err) || err);
      }
    }
  }

  if (fixed > 0) {
    console.log(`[db] Pre-flight: fixed ${fixed} missing column(s).`);
  }
}

/**
 * Heal partial migration state caused by previous runs where ensureAlterColumns()
 * added columns before migrate() ran, leaving the migration unstamped.
 *
 * Splits each unstamped migration's SQL into individual statements, runs each
 * one tolerating "already exists" / "duplicate column" errors, and stamps the
 * migration hash so the subsequent migrate() call skips it.
 */
async function healPartialMigrations(sqlite: Database, migrationsFolder: string): Promise<void> {
  const journalPath = resolve(migrationsFolder, 'meta', '_journal.json');
  if (!await Bun.file(journalPath).exists()) return;
  const journal = JSON.parse(await Bun.file(journalPath).text());

  // Collect already-stamped hashes
  const stamped = new Set<string>();
  try {
    const rows = sqlite.prepare('SELECT hash FROM __drizzle_migrations').all() as { hash: string }[];
    for (const r of rows) stamped.add(r.hash);
  } catch {
    return; // No meta table yet — nothing to heal
  }

  let healed = 0;
  for (const entry of journal.entries) {
    const sqlPath = resolve(migrationsFolder, `${entry.tag}.sql`);
    const sqlContent = await Bun.file(sqlPath).text();
    const hash = new Bun.CryptoHasher('sha256').update(sqlContent).digest('hex');

    if (stamped.has(hash)) continue; // Already applied

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
      continue;
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
      sqlite.prepare('INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(hash, entry.when);
      healed++;
      console.log(`[db] Heal: stamped migration ${entry.tag}`);
    }
  }

  if (healed > 0) {
    console.log(`[db] Heal: repaired ${healed} partial migration(s).`);
  }
}

export async function createDb(dbPath: string, migrationsFolderOverride?: string): Promise<AppDb> {
  await mkdir(resolve(dbPath, '..'), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  const migrationsFolder = migrationsFolderOverride ?? await resolveMigrationsFolder();

  console.log(`[db] Migrations folder: ${migrationsFolder}`);

  // ─── drizzle-orm #5782 defense ────────────────────────────────────────────
  // drizzle-kit emits `PRAGMA foreign_keys=OFF;` at the top of every table-
  // rebuild migration (CREATE __new_x → INSERT…SELECT → DROP x → RENAME) to
  // disarm ON DELETE CASCADE during the rebuild. drizzle-orm's migrator then
  // wraps each migration in BEGIN…COMMIT, and SQLite IGNORES PRAGMA foreign_keys
  // inside a transaction. Result: the protective pragma is neutralized, FK stays
  // ON, `DROP TABLE parent` becomes an implicit `DELETE FROM parent` which
  // CASCADES — silently wiping every child table. This is exactly how
  // lore_entries was emptied when 0037 rebuilt lorebooks (Olesya's loss).
  // Workaround (upstream-recommended): flip FK OFF on the raw handle BEFORE
  // migrate() opens its BEGIN, then restore ON for normal app queries.
  sqlite.exec('PRAGMA foreign_keys = OFF');
  try {
    await baselineLegacyDb(sqlite, migrationsFolder);
    await rebaseToBaseline(sqlite, migrationsFolder);

    // Try normal migration first
    try {
      migrate(db, { migrationsFolder });
    } catch (migrateErr: unknown) {
      // migrate() can fail when a previous ensureAlterColumns() pre-flight
      // already added columns but didn't stamp the migration, leaving partial state.
      // Heal by splitting unstamped migrations into individual statements
      // and tolerating "already exists" / "duplicate column" errors.
      console.warn(`[db] migrate() failed (${errorMessage(migrateErr) || String(migrateErr)}), healing partial state...`);
      await healPartialMigrations(sqlite, migrationsFolder);
      migrate(db, { migrationsFolder });
    }

    // Post-migration integrity checks
    await repairMissingTables(sqlite, migrationsFolder);
    await ensureFinalSchemaColumns(sqlite, migrationsFolder);
    await ensureAlterColumns(sqlite, migrationsFolder);
  } finally {
    // Restore FK enforcement for normal app queries (the OFF above was scoped
    // to the migration phase only). See the #5782 note above for why this is
    // the correct place to flip it back on.
    sqlite.exec('PRAGMA foreign_keys = ON');
  }

  return db;
}

