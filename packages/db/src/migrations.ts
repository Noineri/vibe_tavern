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
    version: "0002_prompt_trace_payload",
    sql: `
ALTER TABLE prompt_traces
ADD COLUMN final_payload_json TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    version: "0003_provider_profiles",
    sql: `
CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  api_key TEXT,
  default_model TEXT,
  context_budget INTEGER NOT NULL DEFAULT 8192,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: "0004_character_v3_fields",
    sql: `
ALTER TABLE characters ADD COLUMN mes_example TEXT;
ALTER TABLE characters ADD COLUMN alternate_greetings_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE characters ADD COLUMN post_history_instructions TEXT;
ALTER TABLE characters ADD COLUMN creator_notes TEXT;
`,
  },
  {
    version: "0005_provider_profile_is_active",
    sql: `
ALTER TABLE provider_profiles ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_profiles_active
  ON provider_profiles(is_active)
  WHERE is_active = 1;
UPDATE provider_profiles SET is_active = 1
  WHERE id = (
    SELECT id FROM provider_profiles
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
);
`,
  },
  {
    version: "0006_prompt_presets",
    sql: `
CREATE TABLE IF NOT EXISTS prompt_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bind_model TEXT NOT NULL DEFAULT '',
  system TEXT NOT NULL DEFAULT '',
  jailbreak TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: "0007_provider_samplers",
    sql: `
ALTER TABLE provider_profiles ADD COLUMN temperature REAL NOT NULL DEFAULT 0.9;
ALTER TABLE provider_profiles ADD COLUMN top_p REAL NOT NULL DEFAULT 1.0;
ALTER TABLE provider_profiles ADD COLUMN min_p REAL NOT NULL DEFAULT 0.05;
ALTER TABLE provider_profiles ADD COLUMN top_k INTEGER NOT NULL DEFAULT 40;
ALTER TABLE provider_profiles ADD COLUMN typical_p REAL NOT NULL DEFAULT 1.0;
ALTER TABLE provider_profiles ADD COLUMN rep_pen REAL NOT NULL DEFAULT 1.1;
ALTER TABLE provider_profiles ADD COLUMN freq_pen REAL NOT NULL DEFAULT 0.0;
ALTER TABLE provider_profiles ADD COLUMN pres_pen REAL NOT NULL DEFAULT 0.0;
ALTER TABLE provider_profiles ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 8192;
ALTER TABLE provider_profiles ADD COLUMN stop_seq TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_profiles ADD COLUMN seed TEXT DEFAULT NULL;
ALTER TABLE provider_profiles ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE provider_profiles ADD COLUMN stream_response INTEGER NOT NULL DEFAULT 1;
`,
  },
  {
    version: "0008_character_first_message",
    sql: `
ALTER TABLE characters ADD COLUMN first_message TEXT;
`,
  },
  {
    version: "0009_character_personality_summary",
    sql: `
ALTER TABLE characters ADD COLUMN personality_summary TEXT;
`,
  },
];

export function getLatestMigrationVersion(): string {
  return migrations[migrations.length - 1]?.version ?? "none";
}
