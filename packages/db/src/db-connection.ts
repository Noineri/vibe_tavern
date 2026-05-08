import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import * as schema from './db-schema.js';

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(dbPath: string): AppDb {
  const sqlite = new Database(dbPath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA journal_mode = WAL');

  // Migrate: add prefill column to prompt_traces if missing
  try {
    sqlite.exec('ALTER TABLE prompt_traces ADD COLUMN prefill TEXT');
  } catch {
    // Column already exists — ignore
  }

  return drizzle(sqlite, { schema });
}
