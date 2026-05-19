import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { eq } from "drizzle-orm";
import * as schema from "../src/db-schema.js";
import { ChatStore } from "../src/stores/chat-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

const FIXED_NOW = "2025-05-04T12:00:00.000Z";

let clockTick = 0;
const testClock: StoreClock = {
  now() {
    clockTick++;
    return new Date(Date.parse(FIXED_NOW) + clockTick).toISOString();
  },
};

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_test_${String(n).padStart(4, "0")}`;
  },
};

const CREATE_TABLES_SQL = `
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
  avatar_full_asset_id text,
  mes_example_mode text DEFAULT 'always' NOT NULL,
  mes_example_depth integer DEFAULT 4 NOT NULL,
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
  avatar_full_asset_id text,
  default_for_new_chats integer DEFAULT 0 NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE TABLE provider_profiles (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  provider_preset text NOT NULL,
  endpoint text NOT NULL,
  api_key text,
  default_model text,
  context_budget integer,
  max_tokens integer DEFAULT 500 NOT NULL,
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
  FOREIGN KEY (bind_provider_preset_id) REFERENCES provider_profiles(id) ON DELETE set null
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
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE cascade,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE set null,
  FOREIGN KEY (prompt_preset_id) REFERENCES prompt_presets(id)
);
CREATE INDEX idx_chats_character_id ON chats (character_id);
CREATE INDEX idx_chats_last_accessed ON chats (last_accessed_at);
CREATE TABLE chat_branches (
  id text PRIMARY KEY NOT NULL,
  chat_id text NOT NULL,
  parent_branch_id text,
  forked_from_message_id text,
  label text NOT NULL,
  created_at text NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE cascade
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
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE cascade,
  FOREIGN KEY (branch_id) REFERENCES chat_branches(id) ON DELETE cascade
);
CREATE UNIQUE INDEX idx_messages_branch_position ON messages (branch_id, position);
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
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE cascade
);
CREATE UNIQUE INDEX idx_message_variants_unique ON message_variants (message_id, variant_index);
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
  latency_ms integer NOT NULL,
  created_at text NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE cascade,
  FOREIGN KEY (branch_id) REFERENCES chat_branches(id) ON DELETE cascade,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE cascade
);
CREATE TABLE ui_settings (
  id text PRIMARY KEY NOT NULL,
  theme text DEFAULT 'dark' NOT NULL,
  chat_font_size integer DEFAULT 15 NOT NULL,
  ui_font_size integer DEFAULT 14 NOT NULL,
  message_width integer DEFAULT 700 NOT NULL,
  language text DEFAULT 'en' NOT NULL,
  active_prompt_preset_id text,
  updated_at text NOT NULL,
  FOREIGN KEY (active_prompt_preset_id) REFERENCES prompt_presets(id) ON DELETE set null
);
CREATE TABLE cached_models (
  id text PRIMARY KEY NOT NULL,
  provider_profile_id text NOT NULL,
  model_slug text NOT NULL,
  model_name text NOT NULL,
  context_length integer,
  capabilities_json text DEFAULT '{}' NOT NULL,
  fetched_at text NOT NULL,
  FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON DELETE cascade
);
CREATE UNIQUE INDEX idx_cached_models_provider_slug ON cached_models (provider_profile_id, model_slug);
`;

async function createTestDb() {
	return await createDb(":memory:");
}

/**
 * Bootstrap minimum rows so ChatStore can operate:
 * character → provider profile → prompt preset → chat + branch
 */
function bootstrap(db: Awaited<ReturnType<typeof createTestDb>>) {
  db.insert(schema.characters).values({
    id: "char_1", name: "TestChar", isSystem: 0, description: "",
    alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();

  db.insert(schema.providerProfiles).values({
    id: "prov_1", name: "TestProvider", providerPreset: "openai",
    endpoint: "http://localhost", maxTokens: 500,
    temperature: 1.0, topP: 1.0, topK: 0, minP: 0,
    frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1.0,
    reasoningEffort: "auto", streamResponse: 1, isActive: 1,
    createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();

  db.insert(schema.promptPresets).values({
    id: "preset_1", name: "Default", systemPrompt: "",
    postHistoryInstructions: "", assistantPrefix: "", authorsNote: "",
    authorsNoteDepth: 4, summaryPrompt: "", toolsPrompt: "",
    createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();

  db.insert(schema.chats).values({
    id: "chat_1", characterId: "char_1", personaId: null,
    activeBranchId: "brnch_1", promptPresetId: "preset_1",
    title: "Test chat", summary: "", messageHistoryLimit: 0,
    lastAccessedAt: FIXED_NOW,
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();

  db.insert(schema.chatBranches).values({
    id: "brnch_1", chatId: "chat_1", parentBranchId: null,
    forkedFromMessageId: null, label: "main", createdAt: FIXED_NOW,
  }).run();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ChatStore — variant (swipe) semantics", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: ChatStore;

  beforeEach(async () => {
    db = await createTestDb();
    bootstrap(db);
    clockTick = 0;
    idCounters = new Map();
    store = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
  });

  test("addMessage creates first variant as selected and syncs messages.content", async () => {
    const msg = await store.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: "Hello world",
    });

    // Variant should exist and be selected
    const variants = await store.getVariants(msg.id);
    expect(variants.length).toBe(1);
    expect(variants[0].content).toBe("Hello world");
    expect(variants[0].isSelected).toBe(true);
    expect(variants[0].variantIndex).toBe(0);

    // messages.content should match
    const freshMsg = await db.select().from(schema.messages).where(
      eq(schema.messages.id, msg.id),
    ).get();
    expect(freshMsg!.content).toBe("Hello world");
  });

  test("addVariant selects the new variant, deselects old, syncs messages.content", async () => {
    // Create initial message
    const msg = await store.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: "First response",
    });

    // Regenerate → add variant
    const newVariant = await store.addVariant(msg.id, "Second response (regen)");

    // New variant should be selected
    expect(newVariant.isSelected).toBe(true);
    expect(newVariant.variantIndex).toBe(1);
    expect(newVariant.content).toBe("Second response (regen)");

    // Old variant should be deselected
    const variants = await store.getVariants(msg.id);
    expect(variants.length).toBe(2);
    expect(variants[0].variantIndex).toBe(0);
    expect(variants[0].isSelected).toBe(false);
    expect(variants[0].content).toBe("First response");
    expect(variants[1].variantIndex).toBe(1);
    expect(variants[1].isSelected).toBe(true);
    expect(variants[1].content).toBe("Second response (regen)");

    // messages.content should be synced to the selected variant
    const freshMsg = await db.select().from(schema.messages).where(
      eq(schema.messages.id, msg.id),
    ).get();
    expect(freshMsg!.content).toBe("Second response (regen)");

    // getSelectedVariant should resolve to index 1
    const selected = await store.getSelectedVariant(msg.id);
    expect(selected!.variantIndex).toBe(1);
  });

  test("multiple addVariant calls — latest always selected, messages.content in sync", async () => {
    const msg = await store.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: "V0",
    });

    await store.addVariant(msg.id, "V1");
    await store.addVariant(msg.id, "V2");
    await store.addVariant(msg.id, "V3");

    const variants = await store.getVariants(msg.id);
    expect(variants.length).toBe(4);

    // Only the last one should be selected
    for (let i = 0; i < 3; i++) {
      expect(variants[i].isSelected).toBe(false);
    }
    expect(variants[3].isSelected).toBe(true);
    expect(variants[3].content).toBe("V3");

    // messages.content synced
    const freshMsg = await db.select().from(schema.messages).where(
      eq(schema.messages.id, msg.id),
    ).get();
    expect(freshMsg!.content).toBe("V3");
  });

  test("selectVariant switches selection and syncs messages.content", async () => {
    const msg = await store.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: "V0",
    });

    await store.addVariant(msg.id, "V1");
    await store.addVariant(msg.id, "V2");

    // V2 is selected (last addVariant). Now switch back to V0.
    await store.selectVariant(msg.id, 0);

    const variants = await store.getVariants(msg.id);
    expect(variants[0].isSelected).toBe(true);
    expect(variants[1].isSelected).toBe(false);
    expect(variants[2].isSelected).toBe(false);

    // messages.content synced
    const freshMsg = await db.select().from(schema.messages).where(
      eq(schema.messages.id, msg.id),
    ).get();
    expect(freshMsg!.content).toBe("V0");
  });

  test("forkBranch copies messages and variants with correct selection", async () => {
    const msg = await store.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: "V0",
    });

    await store.addVariant(msg.id, "V1 (regen)");

    // Fork from this message
    const forkedBranch = await store.forkBranch("chat_1", msg.id, "fork test");

    // Get messages in the new branch
    const forkedMessages = await store.getMessages(forkedBranch.id);
    expect(forkedMessages.length).toBe(1);

    // Variants should be copied
    const forkedVariants = await store.getVariants(forkedMessages[0].id);
    expect(forkedVariants.length).toBe(2);

    // The selected variant in the fork should be V1 (the regen)
    const selectedInFork = forkedVariants.find((v) => v.isSelected);
    expect(selectedInFork!.content).toBe("V1 (regen)");
    expect(selectedInFork!.variantIndex).toBe(1);
  });

  test("addVariant does not duplicate content — regression for sentence cloning bug", async () => {
    const originalContent = "His nostrils flare again, a barely perceptible movement.\nThen he steps back.";

    const msg = await store.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: originalContent,
    });

    // Simulate 5 regenerations
    for (let i = 1; i <= 5; i++) {
      await store.addVariant(msg.id, `Regen ${i}: new content here`);
    }

    // Verify no content duplication
    const variants = await store.getVariants(msg.id);
    expect(variants.length).toBe(6); // 1 original + 5 regens

    // Each variant should have its own unique content
    expect(variants[0].content).toBe(originalContent);
    for (let i = 1; i <= 5; i++) {
      expect(variants[i].content).toBe(`Regen ${i}: new content here`);
      // No variant should contain repeated sentences
      expect(variants[i].content).not.toContain("His nostrils flare");
    }

    // messages.content should be exactly the last variant's content
    const freshMsg = await db.select().from(schema.messages).where(
      eq(schema.messages.id, msg.id),
    ).get();
    expect(freshMsg!.content).toBe("Regen 5: new content here");
  });

  test("full scenario: regen → switch to old → re-read is consistent", async () => {
    // 1. Initial assistant message
    const msg = await store.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: "Original answer",
    });

    // 2. Regenerate
    await store.addVariant(msg.id, "Regenerated answer");

    // 3. Verify regen is active
    let selected = await store.getSelectedVariant(msg.id);
    expect(selected!.content).toBe("Regenerated answer");
    expect(selected!.variantIndex).toBe(1);

    let freshMsg = await db.select().from(schema.messages).where(
      eq(schema.messages.id, msg.id),
    ).get();
    expect(freshMsg!.content).toBe("Regenerated answer");

    // 4. Switch back to original
    await store.selectVariant(msg.id, 0);

    // 5. Verify original is active
    selected = await store.getSelectedVariant(msg.id);
    expect(selected!.content).toBe("Original answer");
    expect(selected!.variantIndex).toBe(0);

    freshMsg = await db.select().from(schema.messages).where(
      eq(schema.messages.id, msg.id),
    ).get();
    expect(freshMsg!.content).toBe("Original answer");

    // 6. Simulate what getSnapshot does: read message + variants
    const messages = await store.getMessages("brnch_1");
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("Original answer");

    const variants = await store.getVariants(messages[0].id);
    const activeVariant = variants.find((v) => v.isSelected);
    expect(activeVariant!.content).toBe("Original answer");
    expect(activeVariant!.variantIndex).toBe(0);
  });
});
