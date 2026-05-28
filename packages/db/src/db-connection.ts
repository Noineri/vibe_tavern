import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { eq, isNotNull } from 'drizzle-orm';
import * as schema from './db-schema.js';
import { characters } from './db-schema.js';

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

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
async function getMigrationsFolder(): Promise<string> {
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
      .filter(t => !t.startsWith('__drizzle'));

    // Only stamp if ALL tables from this migration already exist
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
      .filter(t => !t.startsWith('__drizzle'));

    // Extract ALTER TABLE ... ADD COLUMN statements
    const alterCols = [...sqlContent.matchAll(/ALTER\s+TABLE\s+[`"']?(\w+)\s+ADD\s+COLUMN\s+[`"']?(\w+)/gmi)]
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
      sqlite.exec(sqlContent);
      // Stamp this migration as applied so migrate() skips it next time
      const hash = new Bun.CryptoHasher('sha256').update(sqlContent).digest('hex');
      sqlite.prepare('INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(hash, entry.when);
      repaired++;
      // Update existing set
      for (const t of createdTables) existing.add(t.toLowerCase());
    } catch (err) {
      console.error(`[db] Repair: failed to apply ${entry.tag}:`, err);
    }
  }

  if (repaired > 0) {
    console.log(`[db] Repair: applied ${repaired} missing migration(s) (tables + columns).`);
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
    const alterCols = [...sqlContent.matchAll(/ALTER\s+TABLE\s+[`"']?(\w+)\s+ADD\s+COLUMN\s+[`"']?(\w+)/gmi)]
      .map(m => ({ table: m[1], column: m[2] }));

    for (const { table, column } of alterCols) {
      if (hasColumn(table, column)) continue;
      const stmt = `ALTER TABLE "${table}" ADD COLUMN "${column}"`;
      // Derive column type from the SQL
      const typeMatch = sqlContent.match(new RegExp(`ALTER\\s+TABLE\\s+[\`"']?${table}[\`"']?\\s+ADD\\s+COLUMN\\s+[\`"']?${column}[\`"']?\\s+(\\S+)`, 'i'));
      const colType = typeMatch?.[1] ?? 'text';
      try {
        sqlite.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${colType}`);
        console.log(`[db] Pre-flight: added ${table}.${column} (${colType})`);
        fixed++;
        // Invalidate column cache for this table
        columnCache.delete(table.toLowerCase());
      } catch (err: any) {
        console.error(`[db] Pre-flight: failed to add ${table}.${column}:`, err.message);
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

    // Split SQL into individual statements, stripping comments
    const statements = sqlContent
      .split(';')
      .map((s: string) => s.replace(/--[^\n]*/g, '').trim())
      .filter((s: string) => s.length > 0);

    let allOk = true;
    for (const stmt of statements) {
      try {
        sqlite.exec(stmt + ';');
      } catch (err: any) {
        const msg = (err?.message ?? '').toLowerCase();
        if (msg.includes('already exists') || msg.includes('duplicate column')) {
          // Tolerate — column/table already present from a previous partial run
        } else {
          console.error(`[db] Heal: unexpected error in ${entry.tag}:`, err?.message);
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

export async function createDb(dbPath: string): Promise<AppDb> {
  await mkdir(resolve(dbPath, '..'), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  const migrationsFolder = await getMigrationsFolder();

  console.log(`[db] Migrations folder: ${migrationsFolder}`);

  await baselineLegacyDb(sqlite, migrationsFolder);

  // Try normal migration first
  try {
    migrate(db, { migrationsFolder });
  } catch (migrateErr: any) {
    // migrate() can fail when a previous ensureAlterColumns() pre-flight
    // already added columns but didn't stamp the migration, leaving partial state.
    // Heal by splitting unstamped migrations into individual statements
    // and tolerating "already exists" / "duplicate column" errors.
    console.warn(`[db] migrate() failed (${migrateErr?.message ?? migrateErr}), healing partial state...`);
    await healPartialMigrations(sqlite, migrationsFolder);
    migrate(db, { migrationsFolder });
  }

  // Post-migration integrity checks
  await repairMissingTables(sqlite, migrationsFolder);
  await ensureAlterColumns(sqlite, migrationsFolder);

  return db;
}

/**
 * One-time migration: parse characterBookJson blobs into normalized lorebook + entry rows.
 * Call during server startup after stores are initialized:
 *   await migrateCharacterBooks(db, stores.lorebooks);
 */
export async function migrateCharacterBooks(db: AppDb, lorebookStore: import('./stores/lorebook-store.js').LorebookStore): Promise<number> {
  const rows = await db.select({ id: characters.id, characterBookJson: characters.characterBookJson })
    .from(characters)
    .where(isNotNull(characters.characterBookJson))
    .all();

  let migrated = 0;
  for (const row of rows) {
    if (!row.characterBookJson) continue;
    try {
      const lorebookId = await lorebookStore.migrateCharacterBookJson(row.id, row.characterBookJson);
      if (lorebookId) {
        await db.update(characters)
          .set({ characterBookJson: null })
          .where(eq(characters.id, row.id))
          .run();
        migrated++;
      }
    } catch (err) {
      console.error(`[charbook-migration] Failed for character ${row.id}:`, err);
    }
  }
  if (migrated > 0) {
    console.log(`[charbook-migration] Migrated ${migrated} character book(s) to normalized lorebooks.`);
  }
  return migrated;
}
