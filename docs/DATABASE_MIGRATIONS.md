# Database Migration Strategy

## Status: DRAFT (implement when first post-release schema change is needed)

## Context

Vibe Tavern is a local-first desktop application. User data lives in
`%LOCALAPPDATA%\VibeTavern\vibe-tavern.db` (SQLite). The DB is created via
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

### Migration files at runtime

The build process copies `packages/db/drizzle/` into the output directory:

| Build mode | Migrations location |
|------------|-------------------|
| Production bundle | `out/services/api/drizzle/` |
| Standalone exe | `out/standalone/drizzle/` (next to exe) |
| Dev | `packages/db/drizzle/` (source tree) |

`resolveMigrationsFolder()` in `db-connection.ts` resolves the correct path
based on the runtime environment. No SQL files are bundled into the compiled
binary — they are copied alongside it.

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
3. Commit the SQL file
4. Rebuild: `bun scripts/build.ts prod` copies migrations to `out/services/api/drizzle/`
5. `ensureSchema()` handles fresh installs automatically
6. Migrator handles existing installs on update

### Fresh install optimization

On a fresh DB, `ensureSchema()` creates the full schema directly.
Then the migrator marks all known migrations as applied — no need to
run them sequentially against an empty DB.

### Migration log

| File | What it adds |
|------|--------------|
| `0001`–`0016` | Initial schema: chats, characters, personas, providers, presets, lorebooks, scripts, logit bias, etc. |
| `0017_prompt_order.sql` | `prompt_order_json` column on `prompt_presets` for Advanced Prompt Mode ordering. |
| `0018_preset_advanced_mode.sql` | `advanced_mode` integer column on `prompt_presets` (per-preset Advanced Mode flag, defaults to 0). |
| `0018_melted_loa.sql` | Checkpoint: no-op migration with schema snapshot aligning drizzle-kit with all manual migrations. |
| `0019_milky_titania.sql` | `pin_context_budget` boolean column on `provider_profiles` (pin context size when switching models). |

## When to implement

When the first post-release schema change is needed. Until then,
`ensureSchema()` is sufficient for fresh installs.
