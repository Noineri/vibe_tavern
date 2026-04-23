import { migrations } from "./migrations.js";
import type { SqliteDatabaseAdapter, SqliteRow } from "./sqlite-adapter.js";

type MigrationRow = SqliteRow & {
  version: string;
};

export function applySqliteMigrations(db: SqliteDatabaseAdapter): void {
  db.execute(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`);

  const appliedVersions = new Set(
    db.queryAll<MigrationRow>(`SELECT version FROM schema_migrations`).map((row) => row.version),
  );

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    db.transaction(() => {
      db.execute(migration.sql);
      db.execute(
        `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
        [migration.version, new Date().toISOString()],
      );
    });
  }
}
