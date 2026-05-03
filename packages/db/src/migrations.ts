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
		version: "0003_schema_hardening",
		sql: `
CREATE TABLE lore_entries_new (
  id TEXT PRIMARY KEY,
  lorebook_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  keys_json TEXT NOT NULL,
  secondary_keys_json TEXT NOT NULL,
  logic TEXT NOT NULL,
  position TEXT NOT NULL,
  depth INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  sticky_window INTEGER NOT NULL DEFAULT 0,
  cooldown_window INTEGER NOT NULL DEFAULT 0,
  delay_window INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(lorebook_id) REFERENCES lorebooks(id) ON DELETE CASCADE
);

INSERT INTO lore_entries_new (
  id, lorebook_id, title, content, keys_json, secondary_keys_json, logic,
  position, depth, priority, sticky_window, cooldown_window, delay_window,
  enabled, metadata_json
)
SELECT
  id, lorebook_id, title, content, keys_json, secondary_keys_json, logic,
  position, depth, priority, sticky_window, cooldown_window, delay_window,
  enabled, COALESCE(metadata_json, '{}')
FROM lore_entries;

DROP TABLE lore_entries;
ALTER TABLE lore_entries_new RENAME TO lore_entries;

CREATE INDEX IF NOT EXISTS idx_lore_entries_lorebook_id
ON lore_entries(lorebook_id);

CREATE TABLE chat_branches_new (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  parent_branch_id TEXT,
  forked_from_message_id TEXT,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY(parent_branch_id) REFERENCES chat_branches(id)
);

INSERT INTO chat_branches_new (
  id, chat_id, parent_branch_id, forked_from_message_id, label, created_at
)
SELECT
  id, chat_id, parent_branch_id, forked_from_message_id, label, created_at
FROM chat_branches;

DROP TABLE chat_branches;
ALTER TABLE chat_branches_new RENAME TO chat_branches;

CREATE INDEX IF NOT EXISTS idx_chat_branches_chat_id
ON chat_branches(chat_id);
`,
	},

	{
		version: "0004_provider_tables",
		sql: `
CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  api_key TEXT,
  default_model TEXT,
  context_budget INTEGER NOT NULL DEFAULT 8192,
  is_active INTEGER NOT NULL DEFAULT 0,
  temperature REAL NOT NULL DEFAULT 0.9,
  top_p REAL NOT NULL DEFAULT 1.0,
  min_p REAL NOT NULL DEFAULT 0.05,
  top_k INTEGER NOT NULL DEFAULT 40,
  typical_p REAL NOT NULL DEFAULT 1.0,
  rep_pen REAL NOT NULL DEFAULT 1.1,
  freq_pen REAL NOT NULL DEFAULT 0.0,
  pres_pen REAL NOT NULL DEFAULT 0.0,
  max_tokens INTEGER NOT NULL DEFAULT 8192,
  stop_seq TEXT NOT NULL DEFAULT '',
  seed TEXT,
  reasoning_effort TEXT NOT NULL DEFAULT 'medium',
  stream_response INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generation_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}'
);
`,
	},
];

export function getLatestMigrationVersion(): string {
	return migrations[migrations.length - 1]?.version ?? "none";
}
