import { INITIAL_SCHEMA_SQL } from "./schema.js";

export interface Migration {
  version: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: "0001_initial_schema",
    sql: INITIAL_SCHEMA_SQL,
  },
  {
    version: "0002_file_metadata_columns",
    sql: `
ALTER TABLE characters ADD COLUMN file_path TEXT;
ALTER TABLE characters ADD COLUMN file_hash TEXT;
ALTER TABLE characters ADD COLUMN file_mtime TEXT;
ALTER TABLE characters ADD COLUMN sync_status TEXT;
ALTER TABLE characters ADD COLUMN sync_error TEXT;
ALTER TABLE characters ADD COLUMN deleted_at TEXT;
ALTER TABLE characters ADD COLUMN last_synced_at TEXT;

ALTER TABLE character_versions ADD COLUMN file_path TEXT;
ALTER TABLE character_versions ADD COLUMN file_hash TEXT;
ALTER TABLE character_versions ADD COLUMN file_mtime TEXT;
ALTER TABLE character_versions ADD COLUMN sync_status TEXT;
ALTER TABLE character_versions ADD COLUMN sync_error TEXT;
ALTER TABLE character_versions ADD COLUMN deleted_at TEXT;
ALTER TABLE character_versions ADD COLUMN last_synced_at TEXT;

ALTER TABLE personas ADD COLUMN file_path TEXT;
ALTER TABLE personas ADD COLUMN file_hash TEXT;
ALTER TABLE personas ADD COLUMN file_mtime TEXT;
ALTER TABLE personas ADD COLUMN sync_status TEXT;
ALTER TABLE personas ADD COLUMN sync_error TEXT;
ALTER TABLE personas ADD COLUMN deleted_at TEXT;
ALTER TABLE personas ADD COLUMN last_synced_at TEXT;

ALTER TABLE prompt_presets ADD COLUMN file_path TEXT;
ALTER TABLE prompt_presets ADD COLUMN file_hash TEXT;
ALTER TABLE prompt_presets ADD COLUMN file_mtime TEXT;
ALTER TABLE prompt_presets ADD COLUMN sync_status TEXT;
ALTER TABLE prompt_presets ADD COLUMN sync_error TEXT;
ALTER TABLE prompt_presets ADD COLUMN deleted_at TEXT;
ALTER TABLE prompt_presets ADD COLUMN last_synced_at TEXT;

ALTER TABLE lorebooks ADD COLUMN file_path TEXT;
ALTER TABLE lorebooks ADD COLUMN file_hash TEXT;
ALTER TABLE lorebooks ADD COLUMN file_mtime TEXT;
ALTER TABLE lorebooks ADD COLUMN sync_status TEXT;
ALTER TABLE lorebooks ADD COLUMN sync_error TEXT;
ALTER TABLE lorebooks ADD COLUMN deleted_at TEXT;
ALTER TABLE lorebooks ADD COLUMN last_synced_at TEXT;
`,
  },
];

export function getLatestMigrationVersion(): string {
  return migrations[migrations.length - 1]?.version ?? "none";
}
