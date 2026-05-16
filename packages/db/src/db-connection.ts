import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import * as schema from './db-schema.js';

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Auto-create all tables if they don't exist.
 * Order matters: tables referenced by FKs must come first.
 * Uses CREATE TABLE IF NOT EXISTS so this is idempotent.
 */
function ensureSchema(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = OFF'); // defer FK checks during schema creation

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS provider_profiles (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      provider_preset text NOT NULL,
      endpoint text NOT NULL,
      api_key text,
      default_model text,
      context_budget integer,
      max_tokens integer DEFAULT 2000 NOT NULL,
      temperature real DEFAULT 1 NOT NULL,
      top_p real DEFAULT 1 NOT NULL,
      top_k integer DEFAULT 0 NOT NULL,
      min_p real DEFAULT 0 NOT NULL,
      top_a real DEFAULT 0 NOT NULL,
      frequency_penalty real DEFAULT 0 NOT NULL,
      presence_penalty real DEFAULT 0 NOT NULL,
      repetition_penalty real DEFAULT 1 NOT NULL,
      stop_sequences_json text,
      seed text,
      reasoning_effort text DEFAULT 'auto' NOT NULL,
      show_reasoning integer DEFAULT 0 NOT NULL,
      stream_response integer DEFAULT 1 NOT NULL,
      custom_samplers integer DEFAULT 0 NOT NULL,
      is_active integer DEFAULT 0 NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      is_system integer DEFAULT 0 NOT NULL,
      description text DEFAULT '' NOT NULL,
      personality_summary text,
      default_scenario text,
      first_message text,
      mes_example text,
      alternate_greetings_json text DEFAULT '[]' NOT NULL,
      post_history_instructions text,
      creator_notes text,
      character_book_json text,
      depth_prompt text,
      depth_prompt_depth integer,
      depth_prompt_role text,
      extensions_json text DEFAULT '{}' NOT NULL,
      system_prompt text,
      tags_json text DEFAULT '[]' NOT NULL,
      avatar_asset_id text,
      status text DEFAULT 'active' NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS personas (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      description text DEFAULT '' NOT NULL,
      pronouns text,
      avatar_asset_id text,
      default_for_new_chats integer DEFAULT 0 NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS prompt_presets (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      bind_provider_preset_id text,
      system_prompt text DEFAULT '' NOT NULL,
      post_history_instructions text DEFAULT '' NOT NULL,
      assistant_prefix text DEFAULT '' NOT NULL,
      authors_note text DEFAULT '' NOT NULL,
      authors_note_depth integer DEFAULT 4 NOT NULL,
      summary_prompt text DEFAULT '' NOT NULL,
      tools_prompt text DEFAULT '' NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (bind_provider_preset_id) REFERENCES provider_profiles(id) ON UPDATE no action ON DELETE set null
    );
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id text PRIMARY KEY NOT NULL,
      character_id text NOT NULL,
      persona_id text,
      active_branch_id text NOT NULL,
      prompt_preset_id text NOT NULL,
      title text NOT NULL,
      summary text DEFAULT '' NOT NULL,
      message_history_limit integer DEFAULT 0 NOT NULL,
      last_accessed_at text DEFAULT '' NOT NULL,
      status text DEFAULT 'active' NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (persona_id) REFERENCES personas(id) ON UPDATE no action ON DELETE set null,
      FOREIGN KEY (prompt_preset_id) REFERENCES prompt_presets(id) ON UPDATE no action ON DELETE no action
    );
    CREATE INDEX IF NOT EXISTS idx_chats_character_id ON chats (character_id);
    CREATE INDEX IF NOT EXISTS idx_chats_last_accessed ON chats (last_accessed_at);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chat_branches (
      id text PRIMARY KEY NOT NULL,
      chat_id text NOT NULL,
      parent_branch_id text,
      forked_from_message_id text,
      label text NOT NULL,
      created_at text NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON UPDATE no action ON DELETE cascade
    );
    CREATE INDEX IF NOT EXISTS idx_chat_branches_chat_id ON chat_branches (chat_id);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id text PRIMARY KEY NOT NULL,
      chat_id text NOT NULL,
      branch_id text NOT NULL,
      role text NOT NULL,
      author_type text NOT NULL,
      position integer NOT NULL,
      content text NOT NULL,
      state text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (branch_id) REFERENCES chat_branches(id) ON UPDATE no action ON DELETE cascade
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_branch_position ON messages (branch_id, position);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS message_variants (
      id text PRIMARY KEY NOT NULL,
      message_id text NOT NULL,
      variant_index integer NOT NULL,
      content text NOT NULL,
      is_selected integer DEFAULT 0 NOT NULL,
      finish_reason text,
      reasoning text,
      reasoning_duration_ms integer,
      created_at text NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON UPDATE no action ON DELETE cascade
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_message_variants_unique ON message_variants (message_id, variant_index);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS cached_models (
      id text PRIMARY KEY NOT NULL,
      provider_profile_id text NOT NULL,
      model_slug text NOT NULL,
      model_name text NOT NULL,
      context_length integer,
      capabilities_json text DEFAULT '{}' NOT NULL,
      fetched_at text NOT NULL,
      FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON UPDATE no action ON DELETE cascade
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cached_models_provider_slug ON cached_models (provider_profile_id, model_slug);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS provider_model_favorites (
      id text PRIMARY KEY NOT NULL,
      provider_profile_id text NOT NULL,
      model_id text NOT NULL,
      label text,
      context_length integer,
      created_at text NOT NULL,
      FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON UPDATE no action ON DELETE cascade
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_model_favorites_unique ON provider_model_favorites (provider_profile_id, model_id);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS prompt_traces (
      id text PRIMARY KEY NOT NULL,
      chat_id text NOT NULL,
      branch_id text NOT NULL,
      message_id text NOT NULL,
      model text NOT NULL,
      preset_name text NOT NULL,
      assembled_layers_json text NOT NULL,
      token_accounting_json text NOT NULL,
      final_payload_json text DEFAULT '{}' NOT NULL,
      prefill text,
      latency_ms integer NOT NULL,
      created_at text NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (branch_id) REFERENCES chat_branches(id) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON UPDATE no action ON DELETE cascade
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_traces_chat_branch ON prompt_traces (chat_id, branch_id, created_at);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ui_settings (
      id text PRIMARY KEY NOT NULL,
      theme text DEFAULT 'dark' NOT NULL,
      chat_font_size integer DEFAULT 15 NOT NULL,
      ui_font_size integer DEFAULT 14 NOT NULL,
      message_width integer DEFAULT 700 NOT NULL,
      language text DEFAULT 'en' NOT NULL,
      active_prompt_preset_id text,
      updated_at text NOT NULL,
      FOREIGN KEY (active_prompt_preset_id) REFERENCES prompt_presets(id) ON UPDATE no action ON DELETE set null
    );
  `);

  sqlite.exec('PRAGMA foreign_keys = ON');
}

/**
 * Incremental schema migrations — add columns that may not exist in older databases.
 * Each statement is wrapped in a try/catch so it's safe to run on already-migrated DBs.
 */
function runMigrations(sqlite: Database): void {
  const migrations: string[] = [
    'ALTER TABLE characters ADD COLUMN avatar_full_asset_id text',
    'ALTER TABLE personas ADD COLUMN avatar_full_asset_id text',
  ];
  for (const sql of migrations) {
    try {
      sqlite.exec(sql);
    } catch {
      // Column already exists — ignore
    }
  }
}

export function createDb(dbPath: string): AppDb {
  const sqlite = new Database(dbPath);
  sqlite.exec('PRAGMA journal_mode = WAL');
  ensureSchema(sqlite);
  runMigrations(sqlite);

  return drizzle(sqlite, { schema });
}
