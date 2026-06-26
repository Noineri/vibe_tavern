# Database Migration Strategy

## Status: ACTIVE — squashed baseline

The migration history was **squashed**: the 43 historical migration files were consolidated into a single `0000_baseline.sql` (the full current schema). New schema changes generate incremental migrations on top of that baseline via `bun run db:generate`.

The migration runtime lives in [`packages/db/src/db-connection.ts`](../packages/db/src/db-connection.ts) — `createDb()` is the single entry point. It uses drizzle-orm's `migrate()`, wrapped in a startup sequence that handles fresh installs, legacy pre-migration DBs, and upgrading users — plus a foreign-key defense against an upstream drizzle bug.

## Context

Vibe Tavern is a local-first desktop application. User data lives in
`%LOCALAPPDATA%\VibeTavern\vibe-tavern.db` (SQLite). Pre-release, schema
changes meant deleting the DB. Post-release, users update the exe and expect
their chats to survive — so migrations must apply on startup without data loss.

## Why SQLite (not JSON files)

- **Messages table**: 100k+ rows per chat, positional ordering, branches,
  variants. JSON would require loading/rewriting the entire file.
- **Drizzle ORM**: already invested — store modules, 17+ tables, and a large chat-store with branch/message/variant logic.
- **Transactions**: branch forking, message insertion with position shifts
  require atomic operations.
- Simple entities (characters, personas, providers, presets, UI settings)
  *could* be JSON, but SQLite keeps the code uniform and queries consistent.
  SillyTavern uses JSON because it has no branches/variants/positioning.

---

## Migration mechanism

### Startup flow (`createDb()`)

```
createDb(dbPath)
  │
  ├─ open SQLite, PRAGMA journal_mode=WAL, foreign_keys=ON
  ├─ PRAGMA foreign_keys = OFF          ← #5782 defense (see below)
  │
  ├─ baselineLegacyDb()                 ← legacy ensureSchema() DB? stamp existing tables
  ├─ rebaseToBaseline()                 ← upgrading user? re-stamp squashed baseline
  ├─ migrate(db, { migrationsFolder })  ← drizzle-orm migrator runs pending SQL
  │     └─ on partial-state failure: healPartialMigrations() then retry
  ├─ repairMissingTables() + ensureAlterColumns()   ← post-migration integrity pass
  │
  └─ PRAGMA foreign_keys = ON           ← restored for normal app queries
```

### The `__drizzle_migrations` table

Drizzle's standard bookkeeping table (not a custom one):

```sql
CREATE TABLE IF NOT EXISTS __drizzle_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hash       TEXT NOT NULL,             -- sha256 of the migration SQL content
  created_at NUMERIC
);
```

A migration is "applied" when its hash is present in this table. `migrate()` skips any migration whose hash is already recorded.

### Migration files at runtime

`packages/db/drizzle/` contains `0000_baseline.sql` (the squashed full schema) + `meta/` (`_journal.json` listing migrations in order, plus snapshot files). The build copies this folder into the output directory:

| Build mode | Migrations location |
|------------|-------------------|
| Production bundle | `out/services/api/drizzle/` |
| Standalone exe | `out/standalone/drizzle/` (next to exe) |
| Dev | `packages/db/drizzle/` (source tree) |

`resolveMigrationsFolder()` in `db-connection.ts` resolves the correct path for the runtime environment. No SQL files are bundled into the compiled binary — they are copied alongside it.

### Three upgrade paths

| DB state on startup | Detection | Handling |
|---------------------|-----------|----------|
| **Brand-new** (no user tables) | zero non-`__drizzle` tables | `migrate()` runs `0000_baseline.sql` end-to-end, creating the full schema |
| **Legacy pre-migration** (created by the old `ensureSchema()` approach — has user tables but no `__drizzle_migrations`) | `baselineLegacyDb()` | stamps the baseline's migrations **only for tables that already exist**; migrations creating NEW tables (e.g. lorebooks added later) are left unstamped so `migrate()` runs them for real |
| **Upgrading user** (has `__drizzle_migrations` with old pre-squash hashes) | `rebaseToBaseline()` | the squashed `0000_baseline.sql` is re-hashed and re-stamped as applied **only when every table it creates already exists** — so the squashed baseline is marked done without re-running SQL that would fail on existing tables. Migrations for missing tables stay unstamped. |

Both stampers are conservative: they only pre-stamp a migration when *all* the tables it `CREATE`s are already present. A partial or ancient DB missing tables is left unstamped so the missing schema surfaces as a loud boot error (or gets created by `migrate()`), rather than being silently skipped.

### Post-migration integrity

After `migrate()`, two passes run:
- **`repairMissingTables()`** — recreates any table that should exist but doesn't.
- **`ensureAlterColumns()`** — a pre-flight that adds columns the schema expects but a migration didn't stamp cleanly. If this itself left partial state, the `migrate()` retry path calls `healPartialMigrations()`, which splits unstamped migrations into individual statements and tolerates "already exists" / "duplicate column" errors.

---

## The #5782 foreign-key defense

drizzle-kit emits `PRAGMA foreign_keys=OFF;` at the top of every table-rebuild migration (`CREATE __new_x → INSERT…SELECT → DROP x → RENAME`) to disarm `ON DELETE CASCADE` during the rebuild. But drizzle-orm's migrator wraps each migration in `BEGIN…COMMIT`, and **SQLite ignores `PRAGMA foreign_keys` inside a transaction**. Result: the protective pragma is neutralized, FK stays ON, `DROP TABLE parent` becomes an implicit `DELETE FROM parent` which CASCADES — silently wiping every child table.

This is exactly how `lore_entries` was emptied when migration 0037 rebuilt `lorebooks`. The workaround (upstream-recommended) is in `createDb()`: flip `PRAGMA foreign_keys = OFF` on the raw handle **before** `migrate()` opens its `BEGIN`, then restore `ON` in a `finally` block for normal app queries. The `OFF` window is scoped to the migration phase only.

A characterization test pins this behavior so a drizzle-orm upgrade that changes the wrapping can't silently reintroduce the data loss.

---

## Workflow for developers

1. Modify schema in [`packages/db/src/db-schema.ts`](../packages/db/src/db-schema.ts).
2. Run `bun run db:generate` → produces `packages/db/drizzle/NNNN_name.sql` + updates `meta/_journal.json` and the snapshot.
3. Commit the SQL file + journal + snapshot.
4. Rebuild: the build script copies migrations to `out/services/api/drizzle/`.
5. On the next startup, `createDb()` applies the new migration via `migrate()` (fresh installs get everything from the baseline + the new migration; existing installs get just the new migration).

### Current rule

For all future schema changes: modify `db-schema.ts`, run `bun run db:generate`, commit the generated SQL + snapshot + journal update. **Do not edit committed migration files** — add new ones only. The squashed `0000_baseline.sql` is itself a committed migration; treat it the same way (don't hand-edit it; if the baseline ever needs regenerating, that's a deliberate squash operation, not a casual edit).

---

## Squash history

The `0000_baseline.sql` file consolidates the 43 pre-squash migrations (`0000_past_juggernaut.sql` … `0042_*`) into one full-schema snapshot. Their individual effects (lorebook enabled flag, chat summaries, prompt-order JSON, logit-bias, author's-note position, model_id on messages, etc.) are all present in the baseline's `CREATE TABLE` statements. The historical per-migration log is retained in git history; the baseline supersedes it at runtime.

Upgrading users who applied those 43 migrations carry the old hashes in `__drizzle_migrations`; `rebaseToBaseline()` re-stamps the squashed baseline against their existing tables so `migrate()` treats it as already applied.
