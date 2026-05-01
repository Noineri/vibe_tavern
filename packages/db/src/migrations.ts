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
];

export function getLatestMigrationVersion(): string {
  return migrations[migrations.length - 1]?.version ?? "none";
}
