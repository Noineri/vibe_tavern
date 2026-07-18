import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { eq } from "drizzle-orm";
import * as schema from "../src/db-schema.js";
import { ChatStore } from "../src/stores/chat-store.js";
import { MessageStore } from "../src/stores/message-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import {
  computeSceneSchemaHash,
  createDefaultSceneTrackerConfig,
  normalizeSceneTrackerConfig,
  type SceneTrackerConfig,
  type SceneTrackerDsl,
} from "@vibe-tavern/domain";

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
  is_default integer NOT NULL DEFAULT 0,
  system_prompt text DEFAULT '' NOT NULL,
  post_history_instructions text DEFAULT '' NOT NULL,
  assistant_prefix text DEFAULT '' NOT NULL,
  authors_note text DEFAULT '' NOT NULL,
  authors_note_depth integer DEFAULT 4 NOT NULL,
  summary_prompt text DEFAULT '' NOT NULL,
  tools_prompt text DEFAULT '' NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
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
  status text DEFAULT 'active' NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE cascade,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE set null,
  FOREIGN KEY (prompt_preset_id) REFERENCES prompt_presets(id)
);
CREATE INDEX idx_chats_character_id ON chats (character_id);
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
    id: "char_1", name: "TestChar", description: "",
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
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();

  db.insert(schema.chatBranches).values({
    id: "brnch_1", chatId: "chat_1", parentBranchId: null,
    forkedFromMessageId: null, label: "main", createdAt: FIXED_NOW,
  }).run();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("MessageStore — variant (swipe) semantics", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: ChatStore;
  let messageStore: MessageStore;

  beforeEach(async () => {
    db = await createTestDb();
    bootstrap(db);
    clockTick = 0;
    idCounters = new Map();
    store = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
    messageStore = new MessageStore(db, { clock: testClock, idGenerator: testIdGen });
  });

  test("addMessage creates first variant as selected and syncs messages.content", async () => {
    const msg = await messageStore.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: "Hello world",
    });

    // Variant should exist and be selected
    const variants = await messageStore.getVariants(msg.id);
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
    const msg = await messageStore.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: "First response",
    });

    // Regenerate → add variant
    const newVariant = await messageStore.addVariant(msg.id, "Second response (regen)");

    // New variant should be selected
    expect(newVariant.isSelected).toBe(true);
    expect(newVariant.variantIndex).toBe(1);
    expect(newVariant.content).toBe("Second response (regen)");

    // Old variant should be deselected
    const variants = await messageStore.getVariants(msg.id);
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
    const selected = await messageStore.getSelectedVariant(msg.id);
    expect(selected!.variantIndex).toBe(1);
  });

  test("multiple addVariant calls — latest always selected, messages.content in sync", async () => {
    const msg = await messageStore.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: "V0",
    });

    await messageStore.addVariant(msg.id, "V1");
    await messageStore.addVariant(msg.id, "V2");
    await messageStore.addVariant(msg.id, "V3");

    const variants = await messageStore.getVariants(msg.id);
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
    const msg = await messageStore.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: "V0",
    });

    await messageStore.addVariant(msg.id, "V1");
    await messageStore.addVariant(msg.id, "V2");

    // V2 is selected (last addVariant). Now switch back to V0.
    await messageStore.selectVariant(msg.id, 0);

    const variants = await messageStore.getVariants(msg.id);
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
    const msg = await messageStore.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: "V0",
    });

    await messageStore.addVariant(msg.id, "V1 (regen)", undefined, undefined, undefined, "anthropic/claude-sonnet-4", "preset_1");

    // Fork from this message
    const forkedBranch = await store.forkBranch("chat_1", msg.id, "fork test");

    // Get messages in the new branch
    const forkedMessages = await messageStore.getMessages(forkedBranch.id);
    expect(forkedMessages.length).toBe(1);

    // Variants should be copied
    const forkedVariants = await messageStore.getVariants(forkedMessages[0].id);
    expect(forkedVariants.length).toBe(2);

    // The selected variant in the fork should be V1 (the regen)
    const selectedInFork = forkedVariants.find((v) => v.isSelected);
    expect(selectedInFork!.content).toBe("V1 (regen)");
    expect(selectedInFork!.variantIndex).toBe(1);

    // Q5: per-variant provenance (model + preset) must survive the fork — was
    // dropped before, causing forked branches to lose the metadata bar's
    // model/preset segments.
    expect(selectedInFork!.modelId).toBe("anthropic/claude-sonnet-4");
    expect(selectedInFork!.presetId).toBe("preset_1");
  });

  test("addVariant does not duplicate content — regression for sentence cloning bug", async () => {
    const originalContent = "His nostrils flare again, a barely perceptible movement.\nThen he steps back.";

    const msg = await messageStore.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: originalContent,
    });

    // Simulate 5 regenerations
    for (let i = 1; i <= 5; i++) {
      await messageStore.addVariant(msg.id, `Regen ${i}: new content here`);
    }

    // Verify no content duplication
    const variants = await messageStore.getVariants(msg.id);
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

  test("deleteVariant compacts indexes before the next swipe is added", async () => {
    const msg = await messageStore.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: "V0",
    });

    for (let i = 1; i <= 5; i++) {
      await messageStore.addVariant(msg.id, `V${i}`);
    }

    await messageStore.deleteVariant(msg.id, 2);

    let variants = await messageStore.getVariants(msg.id);
    expect(variants.map((variant) => variant.variantIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(variants).toHaveLength(5);
    expect(variants.find((variant) => variant.isSelected)?.content).toBe("V5");
    expect(variants.find((variant) => variant.isSelected)?.variantIndex).toBe(4);

    await messageStore.addVariant(msg.id, "V6");

    variants = await messageStore.getVariants(msg.id);
    expect(variants.map((variant) => variant.variantIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(variants).toHaveLength(6);
    expect(variants.find((variant) => variant.isSelected)?.content).toBe("V6");
    expect(variants.find((variant) => variant.isSelected)?.variantIndex).toBe(5);
  });

  test("full scenario: regen → switch to old → re-read is consistent", async () => {
    // 1. Initial assistant message
    const msg = await messageStore.addMessage({
      chatId: "chat_1",
      branchId: "brnch_1",
      role: "assistant",
      authorType: "assistant",
      content: "Original answer",
    });

    // 2. Regenerate
    await messageStore.addVariant(msg.id, "Regenerated answer");

    // 3. Verify regen is active
    let selected = await messageStore.getSelectedVariant(msg.id);
    expect(selected!.content).toBe("Regenerated answer");
    expect(selected!.variantIndex).toBe(1);

    let freshMsg = await db.select().from(schema.messages).where(
      eq(schema.messages.id, msg.id),
    ).get();
    expect(freshMsg!.content).toBe("Regenerated answer");

    // 4. Switch back to original
    await messageStore.selectVariant(msg.id, 0);

    // 5. Verify original is active
    selected = await messageStore.getSelectedVariant(msg.id);
    expect(selected!.content).toBe("Original answer");
    expect(selected!.variantIndex).toBe(0);

    freshMsg = await db.select().from(schema.messages).where(
      eq(schema.messages.id, msg.id),
    ).get();
    expect(freshMsg!.content).toBe("Original answer");

    // 6. Simulate what getSnapshot does: read message + variants
    const messages = await messageStore.getMessages("brnch_1");
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("Original answer");

    const variants = await messageStore.getVariants(messages[0].id);
    const activeVariant = variants.find((v) => v.isSelected);
    expect(activeVariant!.content).toBe("Original answer");
    expect(activeVariant!.variantIndex).toBe(0);
  });

  // ── addMessagesBatch (chat-import fast path) ──
  // Pins the contract of the bulk-insert method that replaced the per-message
  // addMessage + addVariant + selectVariant loop in st-directory-scanner.
  // Properties that MUST hold (a regression in any silently breaks ST import):
  //   - positions are sequential within a branch
  //   - variantIndex is 0-based per message
  //   - isSelected resolves to the flagged variant, else index 0
  //   - messages.content mirrors the selected variant (read-consistency)
  //   - per-variant reasoning is preserved
  //   - empty batch is a no-op
  test("addMessagesBatch inserts multi-variant messages with sequential positions and correct selection", async () => {
    await messageStore.addMessagesBatch([
      {
        chatId: "chat_1", branchId: "brnch_1",
        role: "user", authorType: "user",
        variants: [{ content: "Hi", isSelected: true }],
      },
      {
        chatId: "chat_1", branchId: "brnch_1",
        role: "assistant", authorType: "assistant",
        variants: [
          { content: "Reply A" },
          { content: "Reply B", isSelected: true, reasoning: "thought-B" },
          { content: "Reply C" },
        ],
      },
      {
        chatId: "chat_1", branchId: "brnch_1",
        role: "assistant", authorType: "assistant",
        // No isSelected on any variant → defaults to index 0
        variants: [
          { content: "Default pick", reasoning: "zero-th" },
          { content: "Other" },
        ],
      },
    ]);

    const rows = await db.select().from(schema.messages)
      .where(eq(schema.messages.branchId, "brnch_1"))
      .orderBy(schema.messages.position).all();
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);

    // messages.content mirrors the SELECTED variant (not necessarily index 0)
    expect(rows[0]!.content).toBe("Hi");
    expect(rows[1]!.content).toBe("Reply B"); // 2nd variant selected
    expect(rows[2]!.content).toBe("Default pick"); // defaulted to index 0

    // Message 2: three variants, index 1 selected, per-variant reasoning kept
    const v2 = await messageStore.getVariants(rows[1]!.id);
    expect(v2.length).toBe(3);
    expect(v2.map((v) => v.variantIndex)).toEqual([0, 1, 2]);
    expect(v2.map((v) => v.isSelected)).toEqual([false, true, false]);
    const selected2 = v2.find((v) => v.isSelected);
    expect(selected2!.content).toBe("Reply B");
    expect(selected2!.reasoning).toBe("thought-B");
  });

  test("addMessagesBatch continues position from existing messages (no clobber)", async () => {
    // Seed one message the old way, then batch-append — positions must continue.
    await messageStore.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "user", authorType: "user", content: "seed",
    });
    await messageStore.addMessagesBatch([
      {
        chatId: "chat_1", branchId: "brnch_1",
        role: "assistant", authorType: "assistant",
        variants: [{ content: "batched-1" }, { content: "batched-2", isSelected: true }],
      },
    ]);
    const rows = await db.select().from(schema.messages)
      .where(eq(schema.messages.branchId, "brnch_1"))
      .orderBy(schema.messages.position).all();
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
    expect(rows[1]!.content).toBe("batched-2");
  });

  test("addMessagesBatch with empty array is a no-op", async () => {
    await messageStore.addMessagesBatch([]);
    const rows = await db.select().from(schema.messages)
      .where(eq(schema.messages.branchId, "brnch_1")).all();
    expect(rows.length).toBe(0);
  });
});

describe("MessageStore — variant preset_id (Q2)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let messageStore: MessageStore;

  beforeEach(async () => {
    db = await createTestDb();
    bootstrap(db);
    clockTick = 0;
    idCounters = new Map();
    messageStore = new MessageStore(db, { clock: testClock, idGenerator: testIdGen });
  });

  test("addMessage with presetId → recorded on the selected variant (send/continue path)", async () => {
    // Characterization for the message-meta preset bug. addMessage already
    // wrote modelId to the selected variant but NOT presetId (only addVariant
    // did). So ordinary sends / continues recorded the model in per-message
    // meta but never the prompt preset, and the footer
    // (time · tokens · model · preset) showed no preset for non-queue replies
    // — only the queue (addVariant) path recorded it. addMessage must now
    // record presetId on the selected variant just like it records modelId.
    const msg = await messageStore.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "assistant", authorType: "assistant",
      content: "First reply",
      modelId: "gpt-4o",
      presetId: "preset_1",
    });

    const rows = await messageStore.getVariants(msg.id);
    const selected = rows.find((r) => r.variantIndex === 0)!;
    expect(selected.modelId).toBe("gpt-4o");
    expect(selected.presetId).toBe("preset_1");
  });

  test("addVariant without presetId → variant.presetId is null (backward compat)", async () => {
    const msg = await messageStore.addMessage({
      chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", content: "V0",
    });
    const v = await messageStore.addVariant(msg.id, "V1");
    expect(v.presetId).toBeNull();

    // Round-trips through getVariants.
    const rows = await messageStore.getVariants(msg.id);
    expect(rows.find((r) => r.variantIndex === v.variantIndex)?.presetId).toBeNull();
  });

  test("addVariant with presetId → persisted and round-trips", async () => {
    const msg = await messageStore.addMessage({
      chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", content: "V0",
    });
    // preset_1 is bootstrapped into prompt_presets, so the FK resolves.
    const v = await messageStore.addVariant(
      msg.id, "Queued reply", undefined, undefined, undefined, "gpt-4o", "preset_1",
    );
    expect(v.modelId).toBe("gpt-4o");
    expect(v.presetId).toBe("preset_1");

    const rows = await messageStore.getVariants(msg.id);
    const queued = rows.find((r) => r.variantIndex === v.variantIndex)!;
    expect(queued.modelId).toBe("gpt-4o");
    expect(queued.presetId).toBe("preset_1");
  });

  test("mixed variants — only the override-tagged one carries presetId", async () => {
    const msg = await messageStore.addMessage({
      chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", content: "V0",
    });
    await messageStore.addVariant(msg.id, "standalone regen"); // no preset
    const queued = await messageStore.addVariant(
      msg.id, "queued job", undefined, undefined, undefined, "claude", "preset_1",
    );

    const rows = await messageStore.getVariants(msg.id);
    const presets = rows.map((r) => r.presetId);
    // Exactly one variant carries the preset; the others are null.
    expect(presets.filter((p) => p === "preset_1")).toEqual(["preset_1"]);
    expect(rows.find((r) => r.variantIndex === queued.variantIndex)!.presetId).toBe("preset_1");
  });
});

// ─── ChatStore — mode column (CA-1 / CA-4) ───────────────────────────────────

describe("ChatStore — mode column", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: ChatStore;

  beforeEach(async () => {
    db = await createTestDb();
    bootstrap(db);
    clockTick = 0;
    idCounters = new Map();
    store = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
  });

  test("createChat defaults mode to 'rp' when not specified", async () => {
    const chat = await store.createChat({
      characterId: "char_1",
      title: "New chat",
      promptPresetId: "preset_1",
    });
    expect(chat.mode).toBe("rp");
  });

  test("createChat persists an explicit coauthor mode", async () => {
    const chat = await store.createChat({
      characterId: "char_1",
      title: "Co-Author chat",
      promptPresetId: "preset_1",
      mode: "coauthor",
    });
    expect(chat.mode).toBe("coauthor");
    // Round-trip: getById reads the persisted mode back.
    const reloaded = await store.getById(chat.id);
    expect(reloaded?.mode).toBe("coauthor");
  });

  test("listByCharacterAndMode filters by mode", async () => {
    await store.createChat({ characterId: "char_1", title: "rp-a", promptPresetId: "preset_1" });
    const co1 = await store.createChat({ characterId: "char_1", title: "co-a", promptPresetId: "preset_1", mode: "coauthor" });
    const co2 = await store.createChat({ characterId: "char_1", title: "co-b", promptPresetId: "preset_1", mode: "coauthor" });

    const coauthor = await store.listByCharacterAndMode("char_1", "coauthor");
    const rp = await store.listByCharacterAndMode("char_1", "rp");

    expect(coauthor.map((c) => c.id).sort()).toEqual([co1.id, co2.id].sort());
    expect(coauthor.every((c) => c.mode === "coauthor")).toBe(true);
    // The bootstrap-inserted chat_1 is also rp, so rp count ≥ 1 (chat_1) + 1.
    expect(rp.every((c) => c.mode === "rp")).toBe(true);
    expect(rp.length).toBeGreaterThanOrEqual(2);
  });

  test("listByCharacterAndMode is isolated per character", async () => {
    // Second character + its co-author chat.
    db.insert(schema.characters).values({
      id: "char_2", name: "OtherChar", description: "",
      alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
      status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).run();
    await store.createChat({ characterId: "char_2", title: "co-other", promptPresetId: "preset_1", mode: "coauthor" });

    const forChar1 = await store.listByCharacterAndMode("char_1", "coauthor");
    const forChar2 = await store.listByCharacterAndMode("char_2", "coauthor");
    expect(forChar1.every((c) => c.characterId === "char_1")).toBe(true);
    expect(forChar2.every((c) => c.characterId === "char_2")).toBe(true);
    expect(forChar2).toHaveLength(1);
  });
});

describe("ChatStore — co-author pinned context (CE-C1)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: ChatStore;

  beforeEach(async () => {
    db = await createTestDb();
    bootstrap(db);
    clockTick = 0;
    idCounters = new Map();
    store = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
  });

  test("setCoauthorContextLinks round-trips a typed character/persona/lorebook/script list", async () => {
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1", mode: "coauthor" });
    const links = [
      { targetType: "character", targetId: "char_other" },
      { targetType: "persona", targetId: "persona_1" },
      { targetType: "lorebook", targetId: "lb_1" },
      { targetType: "script", targetId: "sc_1" },
    ] as const;
    await store.setCoauthorContextLinks(chat.id, [...links]);
    const reloaded = await store.getById(chat.id);
    expect(reloaded?.coauthorContextLinks).toEqual([...links]);
  });

  test("legacy CA-13 rows (bare lorebook-id string[]) are lifted to typed links on read", async () => {
    // Simulate a pre-CE-C1 row by writing the old payload shape directly into
    // the reused SQL column. parseContextLinks must lift each string to
    // {targetType:'lorebook', targetId} so existing chats keep their bindings.
    const chat = await store.createChat({ characterId: "char_1", title: "legacy", promptPresetId: "preset_1", mode: "coauthor" });
    db.update(schema.chats).set({ coauthorContextLinksJson: JSON.stringify(["lb_legacy_a", "lb_legacy_b"]) }).where(eq(schema.chats.id, chat.id)).run();
    const reloaded = await store.getById(chat.id);
    expect(reloaded?.coauthorContextLinks).toEqual([
      { targetType: "lorebook", targetId: "lb_legacy_a" },
      { targetType: "lorebook", targetId: "lb_legacy_b" },
    ]);
  });

  test("setCoauthorContextLinks persists the new typed payload (not the legacy string shape)", async () => {
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1", mode: "coauthor" });
    await store.setCoauthorContextLinks(chat.id, [{ targetType: "script", targetId: "sc_1" }]);
    const row = db.select().from(schema.chats).where(eq(schema.chats.id, chat.id)).get();
    // Typed object payload, not a bare string array.
    expect(JSON.parse(row!.coauthorContextLinksJson)).toEqual([{ targetType: "script", targetId: "sc_1" }]);
  });

  test("malformed context-links JSON falls back to [] (never throws)", async () => {
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1", mode: "coauthor" });
    db.update(schema.chats).set({ coauthorContextLinksJson: "not-json" }).where(eq(schema.chats.id, chat.id)).run();
    const reloaded = await store.getById(chat.id);
    expect(reloaded?.coauthorContextLinks).toEqual([]);
  });
});

describe("ChatStore — insights config (INS-1b)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: ChatStore;

  beforeEach(async () => {
    db = await createTestDb();
    bootstrap(db);
    clockTick = 0;
    idCounters = new Map();
    store = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
  });

  test("a new chat defaults to both insights toggles off", async () => {
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1" });
    expect(chat.insightsConfig).toEqual({ objectiveEnabled: false, trackerEnabled: false });
  });

  test("updateInsightsConfig round-trips and persists across getById", async () => {
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1" });
    const updated = await store.updateInsightsConfig(chat.id, { insightsConfig: { objectiveEnabled: true } });
    expect(updated.insightsConfig.objectiveEnabled).toBe(true);
    // Reload from the DB — persistence, not just the in-memory return value.
    const reloaded = await store.getById(chat.id);
    expect(reloaded?.insightsConfig.objectiveEnabled).toBe(true);
  });

  test("updateInsightsConfig writes the given config (replace at the store layer; merge is the adapter's job)", async () => {
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1" });
    await store.updateInsightsConfig(chat.id, { insightsConfig: { objectiveEnabled: true, trackerEnabled: true } });
    // The store writes EXACTLY what it is given — it does not merge with prior
    // values. Partial-merge (preserve unmentioned keys) is the adapter's job
    // (it spreads ...chat.insightsConfig before ...body), mirroring
    // updateMemorySettings. So a store-level write replaces wholesale:
    await store.updateInsightsConfig(chat.id, { insightsConfig: { objectiveEnabled: false } });
    const reloaded = await store.getById(chat.id);
    expect(reloaded?.insightsConfig).toEqual({ objectiveEnabled: false });
  });
});

describe("ChatStore — scene tracker config (SCN-2)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: ChatStore;

  beforeEach(async () => {
    db = await createTestDb();
    bootstrap(db);
    clockTick = 0;
    idCounters = new Map();
    store = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
  });

  test("a PATCH on an old chat (no tracker) normalizes to fixed defaults, bumps revision, and persists", async () => {
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1" });
    // Old chat: insightsConfig is exactly the two toggles, no `tracker`.
    expect(chat.insightsConfig.tracker).toBeUndefined();

    const updated = await store.updateSceneTrackerConfig(chat.id, { contextWindow: 12 });
    const tracker = normalizeSceneTrackerConfig(updated.insightsConfig.tracker);
    // Defaults filled for every unmentioned field.
    expect(tracker.autoMode).toBe("assistant");
    expect(tracker.promptFormat).toBe("json");
    expect(tracker.useChatModel).toBe(true);
    expect(tracker.schema).toEqual({});
    // The PATCHed field overrides.
    expect(tracker.contextWindow).toBe(12);
    // revision bumps 0 -> 1; schemaHash matches the (empty) schema.
    expect(tracker.revision).toBe(1);
    expect(tracker.schemaHash).toBe(computeSceneSchemaHash({}));

    // Persists across reload.
    const reloaded = await store.getById(chat.id);
    const reloadedTracker = normalizeSceneTrackerConfig(reloaded?.insightsConfig.tracker);
    expect(reloadedTracker.contextWindow).toBe(12);
    expect(reloadedTracker.revision).toBe(1);
  });

  test("a PATCH deep-merges field-by-field: unmentioned tracker fields are preserved", async () => {
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1" });
    await store.updateSceneTrackerConfig(chat.id, { contextWindow: 12, continuityLastN: 5, autoMode: "manual" });
    // Now PATCH only autoMode back — contextWindow + continuityLastN must survive.
    const updated = await store.updateSceneTrackerConfig(chat.id, { autoMode: "assistant" });
    const tracker = normalizeSceneTrackerConfig(updated.insightsConfig.tracker);
    expect(tracker.autoMode).toBe("assistant");
    expect(tracker.contextWindow).toBe(12);
    expect(tracker.continuityLastN).toBe(5);
    // Two PATCHes -> revision 2.
    expect(tracker.revision).toBe(2);
  });

  test("a PATCH preserves Objective toggles and never touches the Objective state column", async () => {
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1" });
    // Turn both toggles on and write some Objective state.
    await store.updateInsightsConfig(chat.id, { insightsConfig: { objectiveEnabled: true, trackerEnabled: true } });
    await store.updateInsightsObjectiveState(chat.id, { insightsObjectiveState: { objectiveDescription: "goal", tasks: [] } });

    await store.updateSceneTrackerConfig(chat.id, { contextWindow: 9 });

    const reloaded = await store.getById(chat.id);
    expect(reloaded?.insightsConfig.objectiveEnabled).toBe(true);
    expect(reloaded?.insightsConfig.trackerEnabled).toBe(true);
    // Objective state column is untouched by the tracker PATCH.
    expect(reloaded?.insightsObjectiveState).toEqual({ objectiveDescription: "goal", tasks: [] });
    // And the tracker itself was written.
    expect(normalizeSceneTrackerConfig(reloaded?.insightsConfig.tracker).contextWindow).toBe(9);
  });

  test("a schema PATCH replaces the whole DSL and recomputes schemaHash atomically with the revision bump", async () => {
    const dsl: SceneTrackerDsl = { tension: { $type: "number", min: 0, max: 10 } };
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1" });
    const updated = await store.updateSceneTrackerConfig(chat.id, { schema: dsl });
    const tracker = normalizeSceneTrackerConfig(updated.insightsConfig.tracker);
    expect(tracker.schema).toEqual(dsl);
    expect(tracker.schemaHash).toBe(computeSceneSchemaHash(dsl));
    expect(tracker.schemaHash).not.toBe(computeSceneSchemaHash({}));
    expect(tracker.revision).toBe(1);
  });

  test("normalization recovers defaults from a corrupt/partial stored tracker before merging", async () => {
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1" });
    // Inject a malformed tracker (bogus scalar, unknown enum, missing fields) directly.
    await store.updateInsightsConfig(chat.id, {
      insightsConfig: { objectiveEnabled: true, trackerEnabled: true, tracker: { contextWindow: "oops", autoMode: "weird" } },
    });
    // The store normalizes the existing value first, then applies the PATCH.
    const updated = await store.updateSceneTrackerConfig(chat.id, { injectLastN: 4 });
    const tracker = normalizeSceneTrackerConfig(updated.insightsConfig.tracker);
    expect(tracker.contextWindow).toBe(createDefaultSceneTrackerConfig().contextWindow); // bogus -> default
    expect(tracker.autoMode).toBe("assistant"); // unknown enum -> default
    expect(tracker.injectLastN).toBe(4); // PATCH applied
    expect(tracker.revision).toBe(1);
    // Toggles injected alongside the corrupt tracker survive the PATCH.
    expect(updated.insightsConfig.objectiveEnabled).toBe(true);
    expect(updated.insightsConfig.trackerEnabled).toBe(true);
  });
});

describe("ChatStore — objective state (INS-3)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: ChatStore;

  beforeEach(async () => {
    db = await createTestDb();
    bootstrap(db);
    clockTick = 0;
    idCounters = new Map();
    store = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
  });

  test("a new chat defaults to an empty objective state", async () => {
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1" });
    expect(chat.insightsObjectiveState).toEqual({});
  });

  test("updateInsightsObjectiveState round-trips and persists across getById", async () => {
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1" });
    const state = {
      objectiveDescription: "Defeat the warlord",
      tasks: [{ id: "t1", description: "Reach the city", status: "pending" }],
      autoCheckFrequency: 0,
      autoCheckEventCount: 2,
      injectionDepth: 1,
      generatePrompt: "",
      checkPrompt: "",
      injectPrompt: "",
    };
    const updated = await store.updateInsightsObjectiveState(chat.id, { insightsObjectiveState: state });
    expect(updated.insightsObjectiveState).toEqual(state);
    const reloaded = await store.getById(chat.id);
    expect(reloaded?.insightsObjectiveState).toEqual(state);
  });

  test("updateInsightsObjectiveState replaces wholesale (the service computes the full next state)", async () => {
    const chat = await store.createChat({ characterId: "char_1", title: "c", promptPresetId: "preset_1" });
    await store.updateInsightsObjectiveState(chat.id, { insightsObjectiveState: { objectiveDescription: "A", tasks: [], autoCheckFrequency: 0, autoCheckEventCount: 4, injectionDepth: 1, generatePrompt: "", checkPrompt: "", injectPrompt: "" } });
    // A second write REPLACES (the service always writes the computed full
    // state) — old keys do not linger.
    await store.updateInsightsObjectiveState(chat.id, { insightsObjectiveState: { objectiveDescription: "B", tasks: [], autoCheckFrequency: 5, autoCheckEventCount: 1, injectionDepth: 2, generatePrompt: "g", checkPrompt: "c", injectPrompt: "i" } });
    const reloaded = await store.getById(chat.id);
    expect(reloaded?.insightsObjectiveState).toEqual({ objectiveDescription: "B", tasks: [], autoCheckFrequency: 5, autoCheckEventCount: 1, injectionDepth: 2, generatePrompt: "g", checkPrompt: "c", injectPrompt: "i" });
  });
});
