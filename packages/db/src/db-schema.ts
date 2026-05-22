import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ─── characters ────────────────────────────────────────────────────────────────

export const characters = sqliteTable('characters', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  isSystem: integer('is_system').notNull().default(0),
  description: text('description').notNull().default(''),
  personalitySummary: text('personality_summary'),
  defaultScenario: text('default_scenario'),
  firstMessage: text('first_message'),
  mesExample: text('mes_example'),
  alternateGreetingsJson: text('alternate_greetings_json').notNull().default('[]'),
  postHistoryInstructions: text('post_history_instructions'),
  creatorNotes: text('creator_notes'),
  characterBookJson: text('character_book_json'),
  depthPrompt: text('depth_prompt'),
  depthPromptDepth: integer('depth_prompt_depth'),
  depthPromptRole: text('depth_prompt_role'),
  extensionsJson: text('extensions_json').notNull().default('{}'),
  systemPrompt: text('system_prompt'),
  tagsJson: text('tags_json').notNull().default('[]'),
  avatarAssetId: text('avatar_asset_id'),
  avatarFullAssetId: text('avatar_full_asset_id'),
  mesExampleMode: text('mes_example_mode').notNull().default('always'),
  mesExampleDepth: integer('mes_example_depth').notNull().default(4),
  status: text('status').notNull().default('active'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── personas ──────────────────────────────────────────────────────────────────

export const personas = sqliteTable('personas', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  pronouns: text('pronouns'),
  avatarAssetId: text('avatar_asset_id'),
  avatarFullAssetId: text('avatar_full_asset_id'),
  defaultForNewChats: integer('default_for_new_chats').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── chats ─────────────────────────────────────────────────────────────────────

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  characterId: text('character_id').notNull().references(() => characters.id, { onDelete: 'cascade' }),
  personaId: text('persona_id').references(() => personas.id, { onDelete: 'set null' }),
  activeBranchId: text('active_branch_id').notNull(),
  promptPresetId: text('prompt_preset_id').notNull().references(() => promptPresets.id),
  title: text('title').notNull(),
  summary: text('summary').notNull().default(''),
  messageHistoryLimit: integer('message_history_limit').notNull().default(0),
  lastAccessedAt: text('last_accessed_at').notNull().default(''),
  status: text('status').notNull().default('active'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  loreActivationStateJson: text('lore_activation_state_json').notNull().default('{}'),
  scriptStateJson: text('script_state_json').notNull().default('{}'),
}, (table) => ({
  characterIdIdx: index('idx_chats_character_id').on(table.characterId),
  lastAccessedIdx: index('idx_chats_last_accessed').on(table.lastAccessedAt),
}));

// ─── lorebooks ────────────────────────────────────────────────────────────────

export const lorebooks = sqliteTable('lorebooks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  scopeType: text('scope_type').notNull(),
  scanDepth: integer('scan_depth').notNull().default(50),
  tokenBudget: integer('token_budget').notNull().default(1000),
  recursiveScanning: integer('recursive_scanning').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  characterId: text('character_id').references(() => characters.id, { onDelete: 'cascade' }),
  personaId: text('persona_id').references(() => personas.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').references(() => chats.id, { onDelete: 'cascade' }),
  enabled: integer('enabled').notNull().default(1),
  extensionsJson: text('extensions_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  characterIdIdx: index('idx_lorebooks_character').on(table.characterId),
  personaIdIdx: index('idx_lorebooks_persona').on(table.personaId),
  chatIdIdx: index('idx_lorebooks_chat').on(table.chatId),
  scopeTypeIdx: index('idx_lorebooks_scope').on(table.scopeType),
}));

// ─── loreEntries ──────────────────────────────────────────────────────────────

export const loreEntries = sqliteTable('lore_entries', {
  id: text('id').primaryKey(),
  lorebookId: text('lorebook_id').notNull().references(() => lorebooks.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default(''),
  content: text('content').notNull().default(''),
  keysJson: text('keys_json').notNull().default('[]'),
  secondaryKeysJson: text('secondary_keys_json').notNull().default('[]'),
  logic: text('logic').notNull().default('and_any'),
  position: text('position').notNull().default('in_prompt'),
  depth: integer('depth').notNull().default(4),
  priority: integer('priority').notNull().default(100),
  stickyWindow: integer('sticky_window').notNull().default(0),
  cooldownWindow: integer('cooldown_window').notNull().default(0),
  delayWindow: integer('delay_window').notNull().default(0),
  constant: integer('constant').notNull().default(0),
  probability: integer('probability').notNull().default(100),
  role: text('role').notNull().default('system'),
  groupName: text('group_name').notNull().default(''),
  groupWeight: integer('group_weight').notNull().default(100),
  prioritizeInclusion: integer('prioritize_inclusion').notNull().default(0),
  excludeRecursion: integer('exclude_recursion').notNull().default(0),
  preventRecursion: integer('prevent_recursion').notNull().default(0),
  delayUntilRecursion: integer('delay_until_recursion').notNull().default(0),
  recursionLevel: integer('recursion_level').notNull().default(0),
  scanDepthOverride: integer('scan_depth_override'),
  caseSensitive: integer('case_sensitive').notNull().default(0),
  matchWholeWords: integer('match_whole_words').notNull().default(0),
  characterFilterJson: text('character_filter_json').notNull().default('[]'),
  characterFilterExclude: integer('character_filter_exclude').notNull().default(0),
  triggersJson: text('triggers_json').notNull().default('[]'),
  matchSourcesJson: text('match_sources_json').notNull().default('[]'),
  enabled: integer('enabled').notNull().default(1),
  sortOrder: integer('sort_order').notNull().default(0),
  metadataJson: text('metadata_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  lorebookIdIdx: index('idx_lore_entries_lorebook').on(table.lorebookId),
}));

// ─── scripts ──────────────────────────────────────────────────────────────────

export const scripts = sqliteTable('scripts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  code: text('code').notNull().default(''),
  enabled: integer('enabled').notNull().default(1),
  scopeType: text('scope_type').notNull().default('character'),
  sortOrder: integer('sort_order').notNull().default(0),
  characterId: text('character_id').references(() => characters.id, { onDelete: 'cascade' }),
  personaId: text('persona_id').references(() => personas.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').references(() => chats.id, { onDelete: 'cascade' }),
  extensionsJson: text('extensions_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  characterIdIdx: index('idx_scripts_character').on(table.characterId),
  personaIdIdx: index('idx_scripts_persona').on(table.personaId),
  chatIdIdx: index('idx_scripts_chat').on(table.chatId),
  scopeTypeIdx: index('idx_scripts_scope').on(table.scopeType),
}));

// ─── chatBranches ──────────────────────────────────────────────────────────────

export const chatBranches = sqliteTable('chat_branches', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  parentBranchId: text('parent_branch_id'),
  forkedFromMessageId: text('forked_from_message_id'),
  label: text('label').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  chatIdIdx: index('idx_chat_branches_chat_id').on(table.chatId),
}));

// ─── messages ──────────────────────────────────────────────────────────────────

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  branchId: text('branch_id').notNull().references(() => chatBranches.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  authorType: text('author_type').notNull(),
  position: integer('position').notNull(),
  content: text('content').notNull(),
  state: text('state').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  branchPosition: uniqueIndex('idx_messages_branch_position').on(table.branchId, table.position),
}));

// ─── messageVariants ───────────────────────────────────────────────────────────

export const messageVariants = sqliteTable('message_variants', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  variantIndex: integer('variant_index').notNull(),
  content: text('content').notNull(),
  isSelected: integer('is_selected').notNull().default(0),
  finishReason: text('finish_reason'),
  reasoning: text('reasoning'),
  reasoningDurationMs: integer('reasoning_duration_ms'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  uniqueVariant: uniqueIndex('idx_message_variants_unique').on(table.messageId, table.variantIndex),
}));

// ─── promptPresets ─────────────────────────────────────────────────────────────

export const promptPresets = sqliteTable('prompt_presets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  bindProviderPresetId: text('bind_provider_preset_id').references(() => providerProfiles.id, { onDelete: 'set null' }),
  systemPrompt: text('system_prompt').notNull().default(''),
  postHistoryInstructions: text('post_history_instructions').notNull().default(''),
  assistantPrefix: text('assistant_prefix').notNull().default(''),
  authorsNote: text('authors_note').notNull().default(''),
  authorsNoteDepth: integer('authors_note_depth').notNull().default(4),
  summaryPrompt: text('summary_prompt').notNull().default(''),
  toolsPrompt: text('tools_prompt').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── providerProfiles ──────────────────────────────────────────────────────────

export const providerProfiles = sqliteTable('provider_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  providerPreset: text('provider_preset').notNull(),
  endpoint: text('endpoint').notNull(),
  apiKey: text('api_key'),
  defaultModel: text('default_model'),
  contextBudget: integer('context_budget'),
  maxTokens: integer('max_tokens').notNull().default(2000),
  temperature: real('temperature').notNull().default(1.0),
  topP: real('top_p').notNull().default(1.0),
  topK: integer('top_k').notNull().default(0),
  minP: real('min_p').notNull().default(0),
  topA: real('top_a').notNull().default(0),
  frequencyPenalty: real('frequency_penalty').notNull().default(0),
  presencePenalty: real('presence_penalty').notNull().default(0),
  repetitionPenalty: real('repetition_penalty').notNull().default(1.0),
  stopSequencesJson: text('stop_sequences_json'),
  seed: text('seed'),
  reasoningEffort: text('reasoning_effort').notNull().default('auto'),
  showReasoning: integer('show_reasoning').notNull().default(0),
  streamResponse: integer('stream_response').notNull().default(1),
  customSamplers: integer('custom_samplers').notNull().default(0),
  isActive: integer('is_active').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── cachedModels ──────────────────────────────────────────────────────────────

export const cachedModels = sqliteTable('cached_models', {
  id: text('id').primaryKey(),
  providerProfileId: text('provider_profile_id').notNull().references(() => providerProfiles.id, { onDelete: 'cascade' }),
  modelSlug: text('model_slug').notNull(),
  modelName: text('model_name').notNull(),
  contextLength: integer('context_length'),
  capabilitiesJson: text('capabilities_json').notNull().default('{}'),
  fetchedAt: text('fetched_at').notNull(),
}, (table) => ({
  providerSlugUnique: uniqueIndex('idx_cached_models_provider_slug').on(table.providerProfileId, table.modelSlug),
}));

// ─── providerModelFavorites ───────────────────────────────────────────────────

export const providerModelFavorites = sqliteTable('provider_model_favorites', {
  id: text('id').primaryKey(),
  providerProfileId: text('provider_profile_id').notNull().references(() => providerProfiles.id, { onDelete: 'cascade' }),
  modelId: text('model_id').notNull(),
  label: text('label'),
  contextLength: integer('context_length'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  providerModelUnique: uniqueIndex('idx_provider_model_favorites_unique').on(table.providerProfileId, table.modelId),
}));

// ─── promptTraces ──────────────────────────────────────────────────────────────

export const promptTraces = sqliteTable('prompt_traces', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  branchId: text('branch_id').notNull().references(() => chatBranches.id, { onDelete: 'cascade' }),
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  presetName: text('preset_name').notNull(),
  assembledLayersJson: text('assembled_layers_json').notNull(),
  tokenAccountingJson: text('token_accounting_json').notNull(),
  finalPayloadJson: text('final_payload_json').notNull().default('{}'),
  activatedLoreEntriesJson: text('activated_lore_entries_json').notNull().default('[]'),
  retrievedMemoriesJson: text('retrieved_memories_json').notNull().default('[]'),
  scriptInjectionsJson: text('script_injections_json').notNull().default('[]'),
  prefill: text('prefill'),
  latencyMs: integer('latency_ms').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  chatBranchIdx: index('idx_prompt_traces_chat_branch').on(table.chatId, table.branchId, table.createdAt),
}));

// ─── uiSettings ────────────────────────────────────────────────────────────────

export const uiSettings = sqliteTable('ui_settings', {
  id: text('id').primaryKey(),
  theme: text('theme').notNull().default('dark'),
  chatFontSize: integer('chat_font_size').notNull().default(15),
  uiFontSize: integer('ui_font_size').notNull().default(14),
  messageWidth: integer('message_width').notNull().default(700),
  language: text('language').notNull().default('en'),
  activePromptPresetId: text('active_prompt_preset_id').references(() => promptPresets.id, { onDelete: 'set null' }),
  updatedAt: text('updated_at').notNull(),
});
