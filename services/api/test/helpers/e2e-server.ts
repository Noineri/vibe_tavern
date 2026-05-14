/**
 * E2E test helper — boots a full Hono app with a temp DB, exposes
 * app.request() for API calls, and cleans up after all tests finish.
 *
 * Usage:
 *   const { api, cleanup } = await createTestServer();
 *   const res = await api("/api/bootstrap");
 *   // ... tests ...
 *   await cleanup();
 */
import { resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { setTokenCountFn } from "@rp-platform/prompt-pipeline";
import { createRuntimeStore } from "../../src/session-runtime-store.js";
import { warmupTokenizers, countTokensDefault } from "../../src/ai/tokenizer-service.js";
import { SessionRuntime } from "../../src/session-runtime.js";
import { createProviderProfileService } from "../../src/provider-profile-service.js";
import { PromptPresetService } from "../../src/prompt-preset-service.js";
import { ProviderOrchestrator } from "../../src/provider-orchestrator.js";
import { LiveChatOrchestrator } from "../../src/live-chat-orchestrator.js";
import { ChatSummaryService } from "../../src/chat-summary-service.js";
import { AssetService } from "../../src/asset-service.js";
import { RuntimeApiAdapter } from "../../src/runtime-api-adapter.js";
import { createApp } from "../../src/app-factory.js";
import type { Hono } from "hono";

// ── Full DDL (extracted from drizzle schema) ──────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE provider_profiles (
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
CREATE TABLE characters (
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
CREATE TABLE personas (
	id text PRIMARY KEY NOT NULL,
	name text NOT NULL,
	description text DEFAULT '' NOT NULL,
	pronouns text,
	avatar_asset_id text,
	default_for_new_chats integer DEFAULT 0 NOT NULL,
	created_at text NOT NULL,
	updated_at text NOT NULL
);
CREATE TABLE chats (
	id text PRIMARY KEY NOT NULL,
	character_id text NOT NULL,
	persona_id text,
	active_branch_id text NOT NULL,
	prompt_preset_id text NOT NULL,
	title text NOT NULL,
	summary text DEFAULT '' NOT NULL,
	message_history_limit integer DEFAULT 0 NOT NULL,
	last_accessed_at text NOT NULL,
	status text DEFAULT 'active' NOT NULL,
	created_at text NOT NULL,
	updated_at text NOT NULL,
	FOREIGN KEY (character_id) REFERENCES characters(id) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (persona_id) REFERENCES personas(id) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (prompt_preset_id) REFERENCES prompt_presets(id) ON UPDATE no action ON DELETE no action
);
CREATE UNIQUE INDEX idx_chats_character_id ON chats (character_id);
CREATE TABLE chat_branches (
	id text PRIMARY KEY NOT NULL,
	chat_id text NOT NULL,
	parent_branch_id text,
	forked_from_message_id text,
	label text NOT NULL,
	created_at text NOT NULL,
	FOREIGN KEY (chat_id) REFERENCES chats(id) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX idx_chat_branches_chat_id ON chat_branches (chat_id);
CREATE TABLE messages (
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
CREATE UNIQUE INDEX idx_messages_branch_position ON messages (branch_id,position);
CREATE TABLE message_variants (
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
CREATE UNIQUE INDEX idx_message_variants_unique ON message_variants (message_id,variant_index);
CREATE TABLE prompt_presets (
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
CREATE TABLE prompt_traces (
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
CREATE INDEX idx_prompt_traces_chat_branch ON prompt_traces (chat_id,branch_id,created_at);
CREATE TABLE ui_settings (
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
CREATE TABLE cached_models (
	id text PRIMARY KEY NOT NULL,
	provider_profile_id text NOT NULL,
	model_slug text NOT NULL,
	model_name text NOT NULL,
	context_length integer,
	capabilities_json text DEFAULT '{}' NOT NULL,
	fetched_at text NOT NULL,
	FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX idx_cached_models_provider_slug ON cached_models (provider_profile_id,model_slug);
CREATE TABLE provider_model_favorites (
	id text PRIMARY KEY NOT NULL,
	provider_profile_id text NOT NULL,
	model_id text NOT NULL,
	label text,
	context_length integer,
	created_at text NOT NULL,
	FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX idx_provider_model_favorites_unique ON provider_model_favorites (provider_profile_id,model_id);
`;

// ── Server interface ───────────────────────────────────────────────────────

export interface TestServer {
  /** Make an API request. Wraps app.fetch() with baseURL. */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  /** Raw Hono app instance */
  app: Hono;
  /** Temp DB directory (for cleanup) */
  tmpDir: string;
  /** Cleanup temp files. Call after all tests in a file. */
  cleanup: () => Promise<void>;
}

/**
 * Creates a fully-wired test server with a temp SQLite DB.
 * Creates schema from DDL, seeds defaults, warms tokenizers.
 */
export async function createTestServer(): Promise<TestServer> {
  // ── Temp directory ─────────────────────────────────────────────────────
  const tmpDir = resolve(
    import.meta.dir,
    "..",
    "..",
    "tmp-test-" + crypto.randomUUID().slice(0, 8),
  );
  const dbPath = resolve(tmpDir, "data", "test.db");
  mkdirSync(resolve(tmpDir, "data", "assets"), { recursive: true });

  // ── Create DB with schema ──────────────────────────────────────────────
  const sqlite = new Database(dbPath);
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec(SCHEMA_SQL);
  sqlite.close();

  // ── Set env for createRuntimeStore() ───────────────────────────────────
  process.env.RP_PLATFORM_ROOT_DIR = tmpDir;
  process.env.RP_PLATFORM_DB_PATH = "data/test.db";

  // ── DI wiring (mirrors dev-server.ts) ───────────────────────────────────
  const stores = createRuntimeStore();

  await Promise.all([
    stores.characters.getSystemCharacter(),
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);

  await warmupTokenizers();
  setTokenCountFn(countTokensDefault);

  const providerProfileService = createProviderProfileService(stores.providers);
  const promptPresetService = new PromptPresetService(stores.presets);
  const sessionRuntime = new SessionRuntime(stores, {
    getActiveProviderProfile: () => providerProfileService.resolveActiveProviderProfile(),
  });
  const providerOrchestrator = new ProviderOrchestrator(providerProfileService);
  const liveChatOrchestrator = new LiveChatOrchestrator(sessionRuntime.chatRuntime, providerOrchestrator);
  const chatSummaryService = new ChatSummaryService(sessionRuntime, providerProfileService);
  const assetService = new AssetService(resolve(tmpDir, "data", "assets"));

  const runtime = new RuntimeApiAdapter(
    stores,
    providerProfileService,
    liveChatOrchestrator,
    chatSummaryService,
    sessionRuntime,
    promptPresetService,
    assetService,
  );

  const app = createApp({ runtime });

  // ── API helper ─────────────────────────────────────────────────────────
  const BASE = "http://localhost";
  const api = (path: string, init?: RequestInit) => app.request(path, init, BASE);

  const cleanup = async () => {
    try {
      stores.db.$client.close?.();
    } catch {}
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    delete process.env.RP_PLATFORM_ROOT_DIR;
    delete process.env.RP_PLATFORM_DB_PATH;
  };

  return { api, app, tmpDir, cleanup };
}

// ── JSON response helper ──────────────────────────────────────────────────
export async function json<T = unknown>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}
