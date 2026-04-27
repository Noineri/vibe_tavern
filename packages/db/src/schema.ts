export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  default_scenario TEXT,
  avatar_asset_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS character_versions (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  card_format TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_character_versions_unique_version
ON character_versions(character_id, version_number);

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  pronouns TEXT,
  avatar_asset_id TEXT,
  default_for_new_chats INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lorebooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lore_entries (
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
  metadata_json TEXT NOT NULL,
  FOREIGN KEY(lorebook_id) REFERENCES lorebooks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lore_entries_lorebook_id
ON lore_entries(lorebook_id);

CREATE TABLE IF NOT EXISTS character_lorebooks (
  character_id TEXT NOT NULL,
  lorebook_id TEXT NOT NULL,
  PRIMARY KEY(character_id, lorebook_id),
  FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE,
  FOREIGN KEY(lorebook_id) REFERENCES lorebooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS persona_lorebooks (
  persona_id TEXT NOT NULL,
  lorebook_id TEXT NOT NULL,
  PRIMARY KEY(persona_id, lorebook_id),
  FOREIGN KEY(persona_id) REFERENCES personas(id) ON DELETE CASCADE,
  FOREIGN KEY(lorebook_id) REFERENCES lorebooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_lorebooks (
  chat_id TEXT NOT NULL,
  lorebook_id TEXT NOT NULL,
  PRIMARY KEY(chat_id, lorebook_id),
  FOREIGN KEY(lorebook_id) REFERENCES lorebooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS generation_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  temperature REAL NOT NULL,
  top_p REAL,
  top_k INTEGER,
  presence_penalty REAL,
  frequency_penalty REAL,
  max_output_tokens INTEGER,
  system_style_note TEXT,
  metadata_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  instructions TEXT,
  metadata_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  active_branch_id TEXT NOT NULL,
  generation_preset_id TEXT NOT NULL,
  tool_profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE,
  FOREIGN KEY(persona_id) REFERENCES personas(id) ON DELETE CASCADE,
  FOREIGN KEY(generation_preset_id) REFERENCES generation_presets(id),
  FOREIGN KEY(tool_profile_id) REFERENCES tool_profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_chats_character_id
ON chats(character_id);

CREATE INDEX IF NOT EXISTS idx_chats_persona_id
ON chats(persona_id);

CREATE TABLE IF NOT EXISTS chat_branches (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  parent_branch_id TEXT,
  forked_from_message_id TEXT,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  api_key TEXT,
  default_model TEXT,
  context_budget INTEGER NOT NULL DEFAULT 8192,
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
  seed TEXT DEFAULT NULL,
  reasoning_effort TEXT NOT NULL DEFAULT 'medium',
  stream_response INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_branches_chat_id
ON chat_branches(chat_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  role TEXT NOT NULL,
  author_type TEXT NOT NULL,
  position INTEGER NOT NULL,
  content TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY(branch_id) REFERENCES chat_branches(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_branch_position
ON messages(branch_id, position);

CREATE TABLE IF NOT EXISTS message_variants (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  variant_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  is_selected INTEGER NOT NULL DEFAULT 0,
  finish_reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_variants_unique_index
ON message_variants(message_id, variant_index);

CREATE TABLE IF NOT EXISTS generation_rules (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_generation_rules_scope
ON generation_rules(scope_type, scope_id);

CREATE TABLE IF NOT EXISTS summary_memory_snapshots (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  covers_through_message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY(branch_id) REFERENCES chat_branches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_summary_memory_chat_branch
ON summary_memory_snapshots(chat_id, branch_id, kind);

CREATE TABLE IF NOT EXISTS retrieved_memory_hits (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  score REAL NOT NULL,
  matched_keys_json TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS prompt_traces (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  model TEXT NOT NULL,
  preset_name TEXT NOT NULL,
  assembled_layers_json TEXT NOT NULL,
  token_accounting_json TEXT NOT NULL,
  activated_lore_entries_json TEXT NOT NULL,
  retrieved_memories_json TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY(branch_id) REFERENCES chat_branches(id) ON DELETE CASCADE,
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prompt_traces_chat_branch
ON prompt_traces(chat_id, branch_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  progress_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS chat_capabilities (
  chat_id TEXT NOT NULL,
  capability_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY(chat_id, capability_key),
  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
`;
