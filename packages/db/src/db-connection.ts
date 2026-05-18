import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import * as schema from './db-schema.js';

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
function getMigrationsFolder(): string {
  // 1. Explicit override (custom deployments)
  const envDir = process.env.RP_PLATFORM_MIGRATIONS_DIR;
  if (envDir) return envDir;

  // 2. In a compiled exe, import.meta.dir is Bun's temp extraction path —
  //    drizzle/ lives next to the actual executable.
  const exeDir = resolve(process.execPath, '..');
  const exeCandidate = resolve(exeDir, 'drizzle');
  if (existsSync(resolve(exeCandidate, 'meta', '_journal.json'))) {
    return exeCandidate;
  }

  // 3. Walk up from this file's directory (works in source + Docker)
  const thisDir = import.meta.dir;
  let dir = thisDir;
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, 'drizzle');
    if (existsSync(resolve(candidate, 'meta', '_journal.json'))) {
      return candidate;
    }
    dir = resolve(dir, '..');
  }

  // 4. Fallback: assume source context (packages/db/src → ../drizzle)
  return resolve(thisDir, '..', 'drizzle');
}

/**
 * Detect a database created by the legacy ensureSchema() approach
 * (before drizzle migrations existed) and stamp all current migrations
 * as already applied so migrate() skips them.
 *
 * Returns true if the DB was baselined.
 */
function baselineLegacyDb(sqlite: Database, migrationsFolder: string): boolean {
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

  // Legacy DB detected: tables exist but no migration tracking.
  // Read the journal and stamp every migration as already applied.
  const journalPath = resolve(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8'));

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

  for (const entry of journal.entries) {
    const sqlPath = resolve(migrationsFolder, `${entry.tag}.sql`);
    const sqlContent = readFileSync(sqlPath, 'utf-8');
    const hash = new Bun.CryptoHasher('sha256').update(sqlContent).digest('hex');
    insert.run(hash, entry.when);
  }

  console.log(`[db] Baselined legacy database — ${journal.entries.length} migration(s) marked as applied.`);
  return true;
}

export function createDb(dbPath: string): AppDb {
  const sqlite = new Database(dbPath);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  const migrationsFolder = getMigrationsFolder();

  console.log(`[db] Migrations folder: ${migrationsFolder}`);
  baselineLegacyDb(sqlite, migrationsFolder);
  migrate(db, { migrationsFolder });

  return db;
}
