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
];

export function getLatestMigrationVersion(): string {
  return migrations[migrations.length - 1]?.version ?? "none";
}
