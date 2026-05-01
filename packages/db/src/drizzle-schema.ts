import { sqliteTable, text, integer, real, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// TODO FW-DRIZ2: add CHECK constraints (none in initial schema)

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: text("version").primaryKey(),
  appliedAt: text("applied_at").notNull(),
});

export const characters = sqliteTable("characters", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  personalitySummary: text("personality_summary"),
  defaultScenario: text("default_scenario"),
  firstMessage: text("first_message"),
  mesExample: text("mes_example"),
  alternateGreetingsJson: text("alternate_greetings_json").notNull().default("[]"),
  postHistoryInstructions: text("post_history_instructions"),
  creatorNotes: text("creator_notes"),
  characterBookJson: text("character_book_json"),
  depthPrompt: text("depth_prompt"),
  depthPromptDepth: integer("depth_prompt_depth"),
  depthPromptRole: text("depth_prompt_role"),
  extensionsJson: text("extensions_json").notNull().default("{}"),
  systemPrompt: text("system_prompt"),
  tagsJson: text("tags_json").notNull().default("[]"),
  avatarAssetId: text("avatar_asset_id"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  filePath: text("file_path"),
  fileHash: text("file_hash"),
  fileMtime: text("file_mtime"),
  syncStatus: text("sync_status"),
  syncError: text("sync_error"),
  deletedAt: text("deleted_at"),
  lastSyncedAt: text("last_synced_at"),
});

export const characterVersions = sqliteTable("character_versions", {
  id: text("id").primaryKey(),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  title: text("title").notNull(),
  cardFormat: text("card_format").notNull(),
  definitionJson: text("definition_json").notNull(),
  isActive: integer("is_active").notNull().default(0),
  createdAt: text("created_at").notNull(),
  filePath: text("file_path"),
  fileHash: text("file_hash"),
  fileMtime: text("file_mtime"),
  syncStatus: text("sync_status"),
  syncError: text("sync_error"),
  deletedAt: text("deleted_at"),
  lastSyncedAt: text("last_synced_at"),
}, (table) => ({
  uniqueVersion: uniqueIndex("idx_character_versions_unique_version").on(table.characterId, table.versionNumber),
}));

export const personas = sqliteTable("personas", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  pronouns: text("pronouns"),
  avatarAssetId: text("avatar_asset_id"),
  defaultForNewChats: integer("default_for_new_chats").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  filePath: text("file_path"),
  fileHash: text("file_hash"),
  fileMtime: text("file_mtime"),
  syncStatus: text("sync_status"),
  syncError: text("sync_error"),
  deletedAt: text("deleted_at"),
  lastSyncedAt: text("last_synced_at"),
});

export const lorebooks = sqliteTable("lorebooks", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  scopeType: text("scope_type").notNull(),
  description: text("description").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  filePath: text("file_path"),
  fileHash: text("file_hash"),
  fileMtime: text("file_mtime"),
  syncStatus: text("sync_status"),
  syncError: text("sync_error"),
  deletedAt: text("deleted_at"),
  lastSyncedAt: text("last_synced_at"),
});

export const loreEntries = sqliteTable("lore_entries", {
  id: text("id").primaryKey(),
  lorebookId: text("lorebook_id").notNull().references(() => lorebooks.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  keysJson: text("keys_json").notNull(),
  secondaryKeysJson: text("secondary_keys_json").notNull(),
  logic: text("logic").notNull(),
  position: text("position").notNull(),
  depth: integer("depth").notNull(),
  priority: integer("priority").notNull(),
  stickyWindow: integer("sticky_window").notNull().default(0),
  cooldownWindow: integer("cooldown_window").notNull().default(0),
  delayWindow: integer("delay_window").notNull().default(0),
  enabled: integer("enabled").notNull().default(1),
  metadataJson: text("metadata_json").notNull().default("{}"),
}, (table) => ({
  lorebookIdIdx: index("idx_lore_entries_lorebook_id").on(table.lorebookId),
}));

export const characterLorebooks = sqliteTable("character_lorebooks", {
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  lorebookId: text("lorebook_id").notNull().references(() => lorebooks.id, { onDelete: "cascade" }),
}, (table) => ({
  pk: primaryKey({ columns: [table.characterId, table.lorebookId] }),
}));

export const personaLorebooks = sqliteTable("persona_lorebooks", {
  personaId: text("persona_id").notNull().references(() => personas.id, { onDelete: "cascade" }),
  lorebookId: text("lorebook_id").notNull().references(() => lorebooks.id, { onDelete: "cascade" }),
}, (table) => ({
  pk: primaryKey({ columns: [table.personaId, table.lorebookId] }),
}));

export const chatLorebooks = sqliteTable("chat_lorebooks", {
  chatId: text("chat_id").notNull(),
  lorebookId: text("lorebook_id").notNull().references(() => lorebooks.id, { onDelete: "cascade" }),
}, (table) => ({
  pk: primaryKey({ columns: [table.chatId, table.lorebookId] }),
}));

export const toolProfiles = sqliteTable("tool_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  mode: text("mode").notNull(),
  instructions: text("instructions"),
  metadataJson: text("metadata_json").notNull(),
});

export const promptPresets = sqliteTable("prompt_presets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  bindModel: text("bind_model").notNull().default(""),
  system: text("system").notNull().default(""),
  jailbreak: text("jailbreak").notNull().default(""),
  summary: text("summary").notNull().default(""),
  tools: text("tools").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  filePath: text("file_path"),
  fileHash: text("file_hash"),
  fileMtime: text("file_mtime"),
  syncStatus: text("sync_status"),
  syncError: text("sync_error"),
  deletedAt: text("deleted_at"),
  lastSyncedAt: text("last_synced_at"),
});

export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  personaId: text("persona_id").references(() => personas.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  status: text("status").notNull(),
  activeBranchId: text("active_branch_id").notNull(),
  promptPresetId: text("prompt_preset_id").notNull().references(() => promptPresets.id),
  toolProfileId: text("tool_profile_id").notNull().references(() => toolProfiles.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  characterIdIdx: index("idx_chats_character_id").on(table.characterId),
  personaIdIdx: index("idx_chats_persona_id").on(table.personaId),
}));

export const chatBranches = sqliteTable("chat_branches", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  // TODO FW-DRIZ2: self-referencing FK parent_branch_id → chat_branches(id) omitted to avoid circular type inference.
  // The FK is enforced by the existing DDL migration.
  parentBranchId: text("parent_branch_id"),
  forkedFromMessageId: text("forked_from_message_id"),
  label: text("label").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  chatIdIdx: index("idx_chat_branches_chat_id").on(table.chatId),
}));

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  branchId: text("branch_id").notNull().references(() => chatBranches.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  authorType: text("author_type").notNull(),
  position: integer("position").notNull(),
  content: text("content").notNull(),
  state: text("state").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  branchPosition: uniqueIndex("idx_messages_branch_position").on(table.branchId, table.position),
}));

export const messageVariants = sqliteTable("message_variants", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  variantIndex: integer("variant_index").notNull(),
  content: text("content").notNull(),
  isSelected: integer("is_selected").notNull().default(0),
  finishReason: text("finish_reason"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueIndex: uniqueIndex("idx_message_variants_unique_index").on(table.messageId, table.variantIndex),
}));

export const summaryMemorySnapshots = sqliteTable("summary_memory_snapshots", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  branchId: text("branch_id").notNull().references(() => chatBranches.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  coversThroughMessageId: text("covers_through_message_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  chatBranchKindIdx: index("idx_summary_memory_chat_branch").on(table.chatId, table.branchId, table.kind),
}));

export const retrievedMemoryHits = sqliteTable("retrieved_memory_hits", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  score: real("score").notNull(),
  matchedKeysJson: text("matched_keys_json").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
});

export const promptTraces = sqliteTable("prompt_traces", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  branchId: text("branch_id").notNull().references(() => chatBranches.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  presetName: text("preset_name").notNull(),
  assembledLayersJson: text("assembled_layers_json").notNull(),
  tokenAccountingJson: text("token_accounting_json").notNull(),
  activatedLoreEntriesJson: text("activated_lore_entries_json").notNull(),
  retrievedMemoriesJson: text("retrieved_memories_json").notNull(),
  finalPayloadJson: text("final_payload_json").notNull().default("{}"),
  latencyMs: integer("latency_ms").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  chatBranchIdx: index("idx_prompt_traces_chat_branch").on(table.chatId, table.branchId, table.createdAt),
}));

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  payloadJson: text("payload_json").notNull(),
  progressJson: text("progress_json").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  lastError: text("last_error"),
});

export const chatCapabilities = sqliteTable("chat_capabilities", {
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  capabilityKey: text("capability_key").notNull(),
  enabled: integer("enabled").notNull().default(0),
  metadataJson: text("metadata_json").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.chatId, table.capabilityKey] }),
}));
