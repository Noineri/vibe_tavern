# Database Migration Strategy

## Status: DRAFT (implement when first post-release schema change is needed)

## Context

Vibe Tavern is a local-first desktop application. User data lives in
`%LOCALAPPDATA%\ClawTavern\vibe-tavern.db` (SQLite). The DB is created via
`ensureSchema()` (`CREATE TABLE IF NOT EXISTS`) on first launch.

Pre-release: schema changes → users delete the DB, start fresh.
Post-release: users update the exe and expect their chats to survive.

## Why SQLite (not JSON files)

- **Messages table**: 100k+ rows per chat, positional ordering, branches,
  variants. JSON would require loading/rewriting the entire file.
- **Drizzle ORM**: already invested — 6 stores, 12 tables, 852-line chat-store.
- **Transactions**: branch forking, message insertion with position shifts
  require atomic operations.
- Simple entities (characters, personas, providers, presets, UI settings)
  *could* be JSON, but SQLite keeps the code uniform and queries consistent.
  SillyTavern uses JSON because it has no branches/variants/positioning.

## Migration Mechanism

### Two-path startup

```
App starts → open DB
  │
  ├─ DB is empty (no tables)
  │     → ensureSchema() creates all tables
  │     → mark all migrations as applied in _migrations table
  │
  └─ DB has tables
        → read _migrations table
        → apply pending migrations (ALTER TABLE, etc.)
        → record applied migrations
```

### Embedding migrations in the compiled exe

`bun build --compile` bundles JS/TS but not external `.sql` files.

Solution: `drizzle-kit generate` produces SQL → a build script converts them
to a TypeScript file with embedded SQL strings.

```
packages/db/
  drizzle/
    0000_initial.sql          ← drizzle-kit generate output
    0001_add_foo_column.sql
  src/
    db-migrations.ts           ← auto-generated, imports SQL as strings
    db-migrator.ts             ← runner: reads _migrations, applies pending
```

### _migrations table

```sql
CREATE TABLE IF NOT EXISTS _migrations (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  tag   TEXT NOT NULL UNIQUE,   -- e.g. "0001_add_foo_column"
  applied_at TEXT NOT NULL
);
```

Created by `ensureSchema()` alongside all other tables.

### Workflow for developers

1. Modify schema in `packages/db/src/db-schema.ts`
2. Run `bun run db:generate` → produces `packages/db/drizzle/NNNN_name.sql`
3. Run `bun run db:embed-migrations` → generates `db-migrations.ts`
4. Commit both the SQL and the generated TS
5. `ensureSchema()` handles fresh installs automatically
6. `db-migrator.ts` handles existing installs on update

### Fresh install optimization

On a fresh DB, `ensureSchema()` creates the full schema directly.
Then the migrator marks all known migrations as applied — no need to
run them sequentially against an empty DB.

## Implementation Steps

### Step 1: Add _migrations table
- Add `_migrations` to `ensureSchema()` in `db-connection.ts`
- Add `_migrations` to Drizzle schema in `db-schema.ts`

### Step 2: Create db-migrator.ts
- `getAppliedMigrations(db)` → list of tags from `_migrations`
- `applyMigration(db, tag, sql)` → exec SQL, insert record
- `runPendingMigrations(db, allMigrations)` → diff + apply

### Step 3: Create embed script
- `scripts/embed-migrations.ts` — reads `packages/db/drizzle/*.sql`,
  writes `packages/db/src/db-migrations.ts` with embedded SQL strings
- Add `"db:embed-migrations"` script to root package.json

### Step 4: Wire into startup
- `createDb()` calls `ensureSchema()` then `runPendingMigrations()`
- Both standalone-server and dev-server benefit

### Step 5: Update build-standalone
- `db-migrations.ts` is TypeScript → bundled by `bun build --compile`
  automatically (no external SQL files needed)

## Why not drizzle-kit migrate runtime?

`drizzle-kit migrate` reads SQL files from disk at runtime. In the compiled
exe, there is no disk — everything is bundled. Embedding SQL as TS strings
is the standard approach for single-binary apps.

## When to implement

When the first post-release schema change is needed. Until then,
`ensureSchema()` is sufficient for fresh installs.
