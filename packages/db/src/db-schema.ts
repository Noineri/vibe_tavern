import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

// ─── characters ────────────────────────────────────────────────────────────────

export const characters = sqliteTable('characters', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
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
  avatarCropJson: text('avatar_crop_json'),
  // Folder-resident avatar extension (e.g. "png"). When set, the avatar lives
  // at data/characters/{id}/avatar.{avatarExt} and is served via
  // /api/characters/:id/avatar. Null = legacy avatar pointed at by avatarAssetId
  // (flat asset), or no avatar. See CHARACTER_FOLDER_STORAGE_PLAN.
  avatarExt: text('avatar_ext'),
  // Folder-resident FULL (uncropped) avatar extension. When set, the original
  // lives at data/characters/{id}/avatar-full.{avatarFullExt} and is served via
  // /api/characters/:id/avatar/full (large display slots: top-bar preview,
  // editor). Null = no separate full image; the thumbnail avatar.{avatarExt} is
  // itself uncropped (no crop was made) and serves both sizes. See AVATAR_FULL_PLAN.
  avatarFullExt: text('avatar_full_ext'),
  // When the avatar was set from a gallery image (setAvatarFromGallery), this
  // holds that gallery row's id. It lets the NEXT avatar switch skip salvage —
  // the prior avatar's full bytes already live in the gallery under this id, so
  // salvaging would only create a (cropped) duplicate. Null = avatar came from
  // a direct upload (uploadCharacterAvatar) and is NOT otherwise in the gallery,
  // so the next switch must salvage it or it's lost. See D8 / salvage logic in
  // character-adapter.
  avatarSourceAssetId: text('avatar_source_asset_id'),
  // Media gallery / avatar-appearance prompt injection (MEDIA_GALLERY_BACKEND_PLAN).
  includeGalleryInPrompt: integer('include_gallery_in_prompt', { mode: 'boolean' }).notNull().default(false),
  includeAvatarInPrompt: integer('include_avatar_in_prompt', { mode: 'boolean' }).notNull().default(false),
  avatarDescription: text('avatar_description'),
  mesExampleMode: text('mes_example_mode').notNull().default('always'),
  mesExampleDepth: integer('mes_example_depth').notNull().default(4),
  status: text('status').notNull().default('active'),
  contentHash: text('content_hash'),
  hasFileOnDisk: integer('has_file_on_disk').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── character versions ────────────────────────────────────────────────────────
// VTF Phase 3: branchable folder-snapshot variants. Content lives in FILES
// (data/characters/{id}/versions/{versionId}/); this table is META ONLY (no
// content columns, no definition blob). The active version's content is swapped
// into the character folder root and read via CharacterStore.getById(). The
// single-active invariant (exactly one is_active=1 per character) is enforced
// in VersionStore; a partial unique index is intentionally omitted to keep the
// migration portable.
export const characterVersions = sqliteTable('character_versions', {
  id: text('id').primaryKey(),
  characterId: text('character_id').notNull().references(() => characters.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  characterIdIdx: index('idx_character_versions_character_id').on(table.characterId),
}));

// ─── personas ──────────────────────────────────────────────────────────────────

export const personas = sqliteTable('personas', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  pronouns: text('pronouns'),
  // Structured pronoun declensions (custom case only). JSON of PronounForms.
  // Null for presets — the five forms are derived at resolve time from `pronouns` (preset key).
  pronounFormsJson: text('pronoun_forms_json'),
  avatarAssetId: text('avatar_asset_id'),
  avatarFullAssetId: text('avatar_full_asset_id'),
  avatarCropJson: text('avatar_crop_json'),
  // Folder-resident avatar extension; see characters.avatarExt.
  avatarExt: text('avatar_ext'),
  // Folder-resident FULL (uncropped) avatar extension; see characters.avatarFullExt.
  avatarFullExt: text('avatar_full_ext'),
  // Avatar-appearance prompt injection (MEDIA_GALLERY_BACKEND_PLAN).
  includeAvatarInPrompt: integer('include_avatar_in_prompt', { mode: 'boolean' }).notNull().default(false),
  avatarDescription: text('avatar_description'),
  defaultForNewChats: integer('default_for_new_chats').notNull().default(0),
  contentHash: text('content_hash'),
  hasFileOnDisk: integer('has_file_on_disk').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── character assets (media gallery) ───────────────────────────────────────
// Folder-resident gallery images: data/characters/{characterId}/gallery/{id}.{ext}.
// The row `id` IS the filename leaf; there is no flat assetId. `ext` + `mimeType`
// are stored per row so serve/vision-load read them directly. Cascade-deleted
// with the character (FK) and the folder dies with deleteEntityFolder.
// See MEDIA_GALLERY_BACKEND_PLAN.md.
export const characterAssets = sqliteTable('character_assets', {
  id: text('id').primaryKey(),
  characterId: text('character_id').notNull().references(() => characters.id, { onDelete: 'cascade' }),
  ext: text('ext').notNull(),
  mimeType: text('mime_type').notNull(),
  caption: text('caption').notNull().default(''),
  description: text('description'),
  // D7: per-image prompt inclusion. Default OFF so existing galleries don't
  // suddenly flood prompts — only described rows the user explicitly selects
  // are injected (prompt-assembly-service filters on description && includeInPrompt).
  includeInPrompt: integer('include_in_prompt', { mode: 'boolean' }).notNull().default(false),
  order: integer('order').notNull().default(0),
  createdAt: text('created_at').notNull(),
  // D8: crop geometry (percentages, JSON) carried by a gallery row that was
  // salvaged from a previous character avatar. Null for ordinary gallery
  // images. Enables one-click restore of a prior avatar: "Set as avatar" on
  // such a row pre-fills the crop modal with this geometry, recreating the
  // exact previous crop without re-cropping. The gallery itself always
  // displays the full (uncropped) image — this field is pure metadata and is
  // never applied as a visual crop in the gallery.
  avatarCropJson: text('avatar_crop_json'),
});

// ─── chats ─────────────────────────────────────────────────────────────────────

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  characterId: text('character_id').notNull().references(() => characters.id, { onDelete: 'cascade' }),
  personaId: text('persona_id').references(() => personas.id, { onDelete: 'set null' }),
  activeBranchId: text('active_branch_id').notNull(),
  promptPresetId: text('prompt_preset_id').references(() => promptPresets.id, { onDelete: 'set null' }),
  // Chat mode: determines how the chat is assembled + which strategy drives it.
  // 'rp' = roleplay (the original/default mode). New modes add a value here +
  // a ChatModeStrategy. Default 'rp' so every pre-mode chat stays RP.
  mode: text('mode').notNull().default('rp'),
  title: text('title').notNull(),
  summary: text('summary').notNull().default(''),
  messageHistoryLimit: integer('message_history_limit').notNull().default(0),
  autoSummaryConfigJson: text('auto_summary_config_json').notNull().default('{"enabled":false,"everyN":20,"useChatModel":true,"excludeSummarized":true}'),
  status: text('status').notNull().default('active'),
  selectedGreetingIndex: integer('selected_greeting_index').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  loreActivationStateJson: text('lore_activation_state_json').notNull().default('{}'),
  scriptStateJson: text('script_state_json').notNull().default('{}'),
  // Insights (INSIGHTS_PLAN): per-chat opt-in Objective Tracker + Scene Tracker.
  // Both features OFF by default; zero DOM and zero prompt-layer injection when off.
  // insightsConfigJson holds both features' toggles + per-feature config
  // (injection depth, scene inject-last-N, model pick, prompts).
  insightsConfigJson: text('insights_config_json').notNull().default('{"objectiveEnabled":false,"trackerEnabled":false}'),
  // The objective task tree — frequently updated on completion checks; separate
  // column for update-pattern isolation (like scriptStateJson).
  insightsObjectiveStateJson: text('insights_objective_state_json').notNull().default('{}'),
  // Derived cache of the currently selected variant's Scene state, rebuilt on
  // generate / edit / delete / selection / branch activation / variant deletion
  // / message deletion / schema change (SCENE_TRACKER_PLAN, Wave 3 cache
  // projection). NOT authoritative — the canonical per-variant Scene record
  // lives on message_variants.scene_tracker_json (owned by immutable variant
  // id); this is just the chat-level mirror the prompt assembly injects for the
  // main model, kept current with the active selection. (The obsolete
  // messages.extra.sceneTracker draft this comment used to describe was removed.)
  insightsCurrentSceneJson: text('insights_current_scene_json').notNull().default('{}'),
  // CE-C1: entities the user explicitly pinned to this co-author chat as
  // read-only Level-1 editor context (the right-panel picker) — a typed
  // (character/persona/lorebook/script) + id list. NOT the RP keyword-activation
  // set; the prompt expands each pinned entity's full content into a reference
  // block. Generalizes the CA-13 lorebook-id-only list; the SQL column name is
  // kept (`coauthor_lorebook_ids_json`) so no migration is needed — legacy rows
  // storing a bare `string[]` are lifted to
  // `[{targetType:"lorebook",targetId}]` on read by `parseContextLinks`.
  // New writes persist the typed payload. Folds into coauthor_config_json when
  // CA-16 lands.
  coauthorContextLinksJson: text('coauthor_lorebook_ids_json').notNull().default('[]'),
  coauthorModuleId: text('coauthor_module_id'),
}, (table) => ({
  characterIdIdx: index('idx_chats_character_id').on(table.characterId),
  modeIdx: index('idx_chats_mode').on(table.mode),
}));

// ─── coauthorModules ───────────────────────────────────────────────────────────
// User-created Co-Author modules (CS-24). Seed modules are code-defined in the
// registry (read-only); this table holds only user-authored modules. Merged at
// resolve time: registry concatenates seed defs + rows from here. `basePrompt`
// is inline text (never a file path) so the editor works on one field for both
// built-in and user modules. `openingMessage` is seeded as the chat's first
// assistant turn on chat birth (CS-29).
export const coauthorModules = sqliteTable('coauthor_modules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  basePrompt: text('base_prompt').notNull(),
  openingMessage: text('opening_message').notNull().default(''),
  skillIdsJson: text('skill_ids_json').notNull().default('[]'),
  toolSetJson: text('tool_set_json').notNull().default('{}'),
  maxSteps: integer('max_steps').notNull().default(5),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── lorebooks ────────────────────────────────────────────────────────────────

export const lorebooks = sqliteTable('lorebooks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  scopeType: text('scope_type').notNull(),
  scanDepth: integer('scan_depth').notNull().default(10),
  tokenBudget: integer('token_budget').notNull().default(1000),
  // Null = fixed token-budget mode (use `token_budget`).
  // Non-null (0-100) = percent-of-context mode: cap = round(maxContextTokens * percent/100).
  // Matches SillyTavern's dual Context% / Budget Cap modes. See
  // lorebook-st-parity-audit.md §1.4.
  tokenBudgetPercent: integer('token_budget_percent'),
  recursiveScanning: integer('recursive_scanning').notNull().default(0),
  maxRecursionSteps: integer('max_recursion_steps').notNull().default(5),
  includeNames: integer('include_names').notNull().default(0),
  minActivations: integer('min_activations').notNull().default(0),
  minActivationsDepthMax: integer('min_activations_depth_max').notNull().default(0),
  overflowAlert: integer('overflow_alert').notNull().default(0),
  characterStrategy: integer('character_strategy').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  characterId: text('character_id').references(() => characters.id, { onDelete: 'cascade' }),
  personaId: text('persona_id').references(() => personas.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').references(() => chats.id, { onDelete: 'cascade' }),
  enabled: integer('enabled').notNull().default(1),
  extensionsJson: text('extensions_json').notNull().default('{}'),
  contentHash: text('content_hash'),
  hasFileOnDisk: integer('has_file_on_disk').notNull().default(0),
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
  ignoreBudget: integer('ignore_budget').notNull().default(0),
  role: text('role').notNull().default('system'),
  groupName: text('group_name').notNull().default(''),
  groupWeight: integer('group_weight').notNull().default(100),
  prioritizeInclusion: integer('prioritize_inclusion').notNull().default(0),
  useGroupScoring: integer('use_group_scoring').notNull().default(0),
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
  automationId: text('automation_id').notNull().default(''),
  metadataJson: text('metadata_json').notNull().default('{}'),
  contentHash: text('content_hash'),
  hasFileOnDisk: integer('has_file_on_disk').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  lorebookIdIdx: index('idx_lore_entries_lorebook').on(table.lorebookId),
}));

// ─── lorebookLinks ───────────────────────────────────────────────────────────
//
// Many-to-many junction table: a lorebook can be linked to multiple
// characters and personas.  Chat-scoped lorebooks stay 1:1 via the
// `chatId` FK on `lorebooks` — linking a lorebook to another chat is
// semantically meaningless (different conversation).
//
// The legacy FK columns (`characterId`, `personaId`) on `lorebooks`
// are retained as the "primary owner" used by the scope-based UI tabs
// and by import/duplicate flows.

export const lorebookLinks = sqliteTable('lorebook_links', {
  lorebookId: text('lorebook_id').notNull().references(() => lorebooks.id, { onDelete: 'cascade' }),
  targetType: text('target_type').notNull(),  // 'character' | 'persona'
  targetId: text('target_id').notNull(),
}, (table) => ({
  // Composite PK: one link per (lorebook, target) pair
  pk: primaryKey({ columns: [table.lorebookId, table.targetType, table.targetId] }),
  targetIdx: index('idx_lorebook_links_target').on(table.targetType, table.targetId),
  lorebookIdx: index('idx_lorebook_links_lorebook').on(table.lorebookId),
}));

// ─── scripts ──────────────────────────────────────────────────────────────────────

export const scripts = sqliteTable('scripts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  code: text('code').notNull().default(''),
  enabled: integer('enabled').notNull().default(1),
  // Runtime contract of this script: 'prompt' (default, the original prompt-script
  // VM) or 'dice' (the dedicated Dice-script VM, Wave B2). Every legacy row and
  // import defaults to 'prompt' so existing prompt scripts are unchanged; the
  // two runtimes are isolated by kind at the store-resolver boundary.
  scriptKind: text('script_kind').notNull().default('prompt'),
  // Server-idempotent template/custom creation key (nullable + unique): a create
  // carrying a creationIntentId that already exists returns the existing script
  // instead of duplicating — process-safe against retries/two tabs/restart. NOT
  // canonical content: it is omitted from the file payload and never updatable.
  creationIntentId: text('creation_intent_id').unique(),
  scopeType: text('scope_type').notNull().default('character'),
  sortOrder: integer('sort_order').notNull().default(0),
  characterId: text('character_id').references(() => characters.id, { onDelete: 'cascade' }),
  personaId: text('persona_id').references(() => personas.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').references(() => chats.id, { onDelete: 'cascade' }),
  extensionsJson: text('extensions_json').notNull().default('{}'),
  contentHash: text('content_hash'),
  hasFileOnDisk: integer('has_file_on_disk').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  characterIdIdx: index('idx_scripts_character').on(table.characterId),
  personaIdIdx: index('idx_scripts_persona').on(table.personaId),
  chatIdIdx: index('idx_scripts_chat').on(table.chatId),
  scopeTypeIdx: index('idx_scripts_scope').on(table.scopeType),
  scriptKindIdx: index('idx_scripts_kind').on(table.scriptKind),
}));

// ─── scriptLinks ──────────────────────────────────────────────────────────────
//
// Many-to-many junction table mirroring `lorebookLinks`: a script can be
// linked to multiple characters and personas so the same utility script
// activates across scopes without duplication. Chat-scoped scripts stay 1:1
// via the `chatId` FK on `scripts` — linking a script to another chat is
// semantically meaningless (different conversation), identical to lorebooks.
//
// The legacy FK columns (`characterId`, `personaId`) on `scripts` are
// retained as the "primary owner" / home scope used by the scope-based UI
// tabs and by import/duplicate flows. The resolver unions FK ∪ junction
// (consulting BOTH) so an FK-owned script activates even if it was never
// junction-linked — deliberately more consistent than the lorebook resolver,
// which is junction-only for char/persona and relies on every FK-owned row
// having been junction-linked at baseline-migration time.
export const scriptLinks = sqliteTable('script_links', {
  scriptId: text('script_id').notNull().references(() => scripts.id, { onDelete: 'cascade' }),
  targetType: text('target_type').notNull(),  // 'character' | 'persona'
  targetId: text('target_id').notNull(),
}, (table) => ({
  // Composite PK: one link per (script, target) pair
  pk: primaryKey({ columns: [table.scriptId, table.targetType, table.targetId] }),
  targetIdx: index('idx_script_links_target').on(table.targetType, table.targetId),
  scriptIdx: index('idx_script_links_script').on(table.scriptId),
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
  attachmentsJson: text('attachments_json'),
  toolCallsJson: text('tool_calls_json'),
  toolCallId: text('tool_call_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  branchPosition: uniqueIndex('idx_messages_branch_position').on(table.branchId, table.position),
}));

// ─── chatSummaries ─────────────────────────────────────────────────────────────

export const chatSummaries = sqliteTable('chat_summaries', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  branchId: text('branch_id').notNull().references(() => chatBranches.id, { onDelete: 'cascade' }),
  label: text('label').notNull().default(''),
  summarizedFrom: integer('summarized_from').notNull().default(1),
  summarizedTo: integer('summarized_to').notNull().default(0),
  includeInContext: integer('include_in_context').notNull().default(1),
  excludeSummarized: integer('exclude_summarized').notNull().default(1),
  source: text('source').notNull().default('manual'),
  sortOrder: integer('sort_order').notNull().default(0),
  contentHash: text('content_hash'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  chatBranchIdx: index('idx_chat_summaries_chat_branch').on(table.chatId, table.branchId),
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
  modelId: text('model_id'),
  presetId: text('preset_id').references(() => promptPresets.id, { onDelete: 'set null' }),
  toolCallsJson: text('tool_calls_json'),
  toolCallId: text('tool_call_id'),
  coauthorModuleId: text('coauthor_module_id'),
  coauthorSkillId: text('coauthor_skill_id'),
  // Canonical per-variant Scene Tracker record (SCENE_TRACKER_PLAN, SCN-3).
  // Null = no record yet (variant just created, or cleared when its content
  // changed). This is authoritative for THIS variant's scene state; the
  // chat-level insights_current_scene_json is only a derived cache rebuilt
  // from the currently selected valid variant. Owned by the immutable variant
  // id, never by variantIndex (variantIndex is display order only).
  sceneTrackerJson: text('scene_tracker_json'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  uniqueVariant: uniqueIndex('idx_message_variants_unique').on(table.messageId, table.variantIndex),
}));

// ─── promptPresets ─────────────────────────────────────────────────────────────

export const promptPresets = sqliteTable('prompt_presets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // Manual list order (drag-to-reorder). Backfilled to created_at ASC by the
  // migration that adds this column, so pre-migration order is preserved.
  sortOrder: integer('sort_order').notNull().default(0),
  // Designated-default marker — exactly one row has is_default = 1 (enforced in
  // app logic: seeded by ensureDefault(), backfilled by migration 0001).
  // Replaces the dead `bind_provider_preset_id` model-binding column.
  isDefault: integer('is_default').notNull().default(0),
  systemPrompt: text('system_prompt').notNull().default(''),
  postHistoryInstructions: text('post_history_instructions').notNull().default(''),
  assistantPrefix: text('assistant_prefix').notNull().default(''),
  authorsNote: text('authors_note').notNull().default(''),
  authorsNoteDepth: integer('authors_note_depth').notNull().default(4),
  authorsNotePosition: text('authors_note_position').notNull().default('in_chat'),
  authorsNoteRole: text('authors_note_role').notNull().default('system'),
  summaryPrompt: text('summary_prompt').notNull().default(''),
  toolsPrompt: text('tools_prompt').notNull().default(''),
  nsfwPrompt: text('nsfw_prompt').notNull().default(''),
  enhanceDefinitionsPrompt: text('enhance_definitions_prompt').notNull().default(''),
  scriptAiSystemPrompt: text('script_ai_system_prompt').notNull().default(''),
  aiAssistantPrompts: text('ai_assistant_prompts').notNull().default('{}'),
  customInjectionsJson: text('custom_injections_json').notNull().default('[]'),
  promptOrderJson: text('prompt_order_json').notNull().default('[]'),
  advancedMode: integer('advanced_mode').notNull().default(0),
  contentHash: text('content_hash'),
  hasFileOnDisk: integer('has_file_on_disk').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── providerProfiles ──────────────────────────────────────────────────────────

export const providerProfiles = sqliteTable('provider_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // Manual list order (drag-to-reorder). Backfilled to created_at ASC.
  sortOrder: integer('sort_order').notNull().default(0),
  providerPreset: text('provider_preset').notNull(),
  endpoint: text('endpoint').notNull(),
  apiKey: text('api_key'),
  defaultModel: text('default_model'),
  contextBudget: integer('context_budget'),
  pinContextBudget: integer('pin_context_budget', { mode: 'boolean' }).notNull().default(false),
  /** When true, sampler/context edits in the modal write to a per-model overlay
   *  (providerModelSettings) instead of the profile base. See resolveEffectiveSettings. */
  bindPerModel: integer('bind_per_model', { mode: 'boolean' }).notNull().default(false),
  maxTokens: integer('max_tokens').notNull().default(2000),
  temperature: real('temperature').notNull().default(1.0),
  topP: real('top_p').notNull().default(1.0),
  topK: integer('top_k').notNull().default(0),
  minP: real('min_p').notNull().default(0),
  topA: real('top_a').notNull().default(0),
  typicalP: real('typical_p').notNull().default(1.0),
  tfsZ: real('tfs_z').notNull().default(1.0),
  repeatLastN: integer('repeat_last_n').notNull().default(0),
  mirostat: integer('mirostat').notNull().default(0),
  mirostatTau: real('mirostat_tau').notNull().default(5.0),
  mirostatEta: real('mirostat_eta').notNull().default(0.1),
  dryMultiplier: real('dry_multiplier').notNull().default(0),
  dryBase: real('dry_base').notNull().default(1.75),
  dryAllowedLength: integer('dry_allowed_length').notNull().default(2),
  drySequenceBreakersJson: text('dry_sequence_breakers_json'),
  xtcThreshold: real('xtc_threshold').notNull().default(0.1),
  xtcProbability: real('xtc_probability').notNull().default(0),
  frequencyPenalty: real('frequency_penalty').notNull().default(0),
  presencePenalty: real('presence_penalty').notNull().default(0),
  repetitionPenalty: real('repetition_penalty').notNull().default(1.0),
  stopSequencesJson: text('stop_sequences_json'),
  logitBiasJson: text('logit_bias_json'),
  seed: text('seed'),
  reasoningEffort: text('reasoning_effort').notNull().default('auto'),
  showReasoning: integer('show_reasoning').notNull().default(0),
  streamResponse: integer('stream_response').notNull().default(1),
  customSamplers: integer('custom_samplers').notNull().default(0),
  isActive: integer('is_active').notNull().default(0),
  visionModel: text('vision_model'),
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
  scope: text('scope').notNull().default('rp'),
  label: text('label'),
  contextLength: integer('context_length'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  providerModelUnique: uniqueIndex('idx_provider_model_favorites_unique').on(table.providerProfileId, table.modelId, table.scope),
}));

// ─── providerModelSettings ─────────────────────────────────────────────────────
// Per-model sampler/context overlay. When a profile's bindPerModel is ON, the
// active model's overlay (looked up by modelId === profile.defaultModel at
// generation time) merges over the profile base via resolveEffectiveSettings.
// Rows survive un-starring a model (favorites are bookmarks; overlays are config).
export const providerModelSettings = sqliteTable('provider_model_settings', {
  id: text('id').primaryKey(),
  providerProfileId: text('provider_profile_id').notNull().references(() => providerProfiles.id, { onDelete: 'cascade' }),
  modelId: text('model_id').notNull(),
  /** Stringified ModelSettingsOverlay JSON. Absent fields = inherit the profile base. */
  settingsJson: text('settings_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  providerModelUnique: uniqueIndex('idx_provider_model_settings_unique').on(table.providerProfileId, table.modelId),
}));

// ─── promptTraces ──────────────────────────────────────────────────────────

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
  /** Per-entry activation reasons (JSON ActivatedLoreDetail[]). Nullable for traces saved before this column existed. */
  activatedLoreDetailJson: text('activated_lore_detail_json'),
  retrievedMemoriesJson: text('retrieved_memories_json').notNull().default('[]'),
  scriptInjectionsJson: text('script_injections_json').notNull().default('[]'),
  prefill: text('prefill'),
  compactionSummary: text('compaction_summary'),
  latencyMs: integer('latency_ms').notNull(),
  sentConfigJson: text('sent_config_json'),
  providerResponseJson: text('provider_response_json'),
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
  aiAssistantProviderId: text('ai_assistant_provider_id'),
  aiAssistantModelName: text('ai_assistant_model_name'),
  // Co-Author generation binding — app-wide, independent of RP active profile.
  // Null (or dangling after profile deletion) falls back to the RP active
  // profile/default model at the adapter boundary. No DB-level FK: like
  // aiAssistantProviderId, a deleted profile leaves a dangling id that the
  // adapter resolves (dangling → fallback) rather than blocking the delete.
  coauthorProviderId: text('coauthor_provider_id'),
  coauthorModelName: text('coauthor_model_name'),
  updatedAt: text('updated_at').notNull(),
});

// ─── sceneBackfillRuns ─────────────────────────────────────────────────────────
// History backfill job state for the Scene Tracker (SCENE_TRACKER_PLAN, SCN-3
// storage / Wave 7 orchestration). One row per backfill run. This row tracks
// the JOB ONLY (ownership / frozen manifest / cursor / status / per-item errors
// / cancel state / partial-success summary) — it is NEVER authoritative for
// Scene data. Scene records are owned by message_variants.scene_tracker_json;
// this row just drives resume/retry/progress and survives reload/restart.
export const sceneBackfillRuns = sqliteTable('scene_backfill_runs', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  // 'fill-missing' (default) | 'rebuild' (regenerate even existing records).
  mode: text('mode').notNull().default('fill-missing'),
  // 'pending' | 'running' | 'completed' | 'cancelled' | 'failed'.
  status: text('status').notNull().default('pending'),
  // Frozen oldest-to-newest manifest of selected immutable variant ids captured
  // at run start, each with its then-current source/schema/config fingerprint so
  // resume/retry can revalidate before persisting. JSON array of manifest items.
  manifestJson: text('manifest_json').notNull().default('[]'),
  // Total manifest length (for progress current/total without re-parsing).
  totalItems: integer('total_items').notNull().default(0),
  // Next manifest index to process (durable cursor for restart-safe resume).
  cursor: integer('cursor').notNull().default(0),
  // Per-item errors accumulated while continue-through-errors is on (JSON array).
  errorsJson: text('errors_json').notNull().default('[]'),
  // Set by an explicit Cancel; the active item never persists on cancel.
  cancelRequested: integer('cancel_requested').notNull().default(0),
  // Partial-success summary written on terminal status (JSON object, nullable).
  summaryJson: text('summary_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  chatIdx: index('idx_scene_backfill_runs_chat').on(table.chatId),
}));

// ─── Dice pending lanes (DICE_SYSTEM_BACKEND_PLAN, Wave B3 / DICE-B7) ────────
//
// Durable branch+mode lane rows. A lane owns a monotonic revision even when
// empty; every pending mutation increments it. The unique constraint on
// {chat_id, branch_id, mode} ensures exactly one lane per combination.
// Both lanes are reset (revision++) when a user message commits; the active
// lane's included/finalized rolls bind to that message, the inactive lane's
// rolls are discarded.
export const dicePendingLanes = sqliteTable('dice_pending_lanes', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  branchId: text('branch_id').notNull().references(() => chatBranches.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull(),
  revision: integer('revision').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  chatBranchModeUnique: uniqueIndex('idx_dice_lanes_chat_branch_mode').on(table.chatId, table.branchId, table.mode),
}));

// ─── Dice rolls (DICE_SYSTEM_BACKEND_PLAN, Wave B3 / DICE-B7) ───────────────
//
// Immutable, message-bindable Dice result snapshots. DB-unique request_id is
// the idempotency net (rapid clicks / retries / two tabs / process recovery
// cannot produce duplicates). Lane FK tracks the pending lane this roll
// belongs to; bound_message_id is set when the roll binds to a committed
// user message. All snapshot columns (actor/script/check labels, revision,
// notation, resolution, etc.) are self-contained — script rename/edit/
// disable/unlink/delete never invalidates historical rolls (no FK to scripts).
//
// No-cascade rule: script_id is plain text with NO FK — the roll carries the
// full snapshot (labels + revision) so it survives any script lifecycle change.
export const diceRolls = sqliteTable('dice_rolls', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull().unique(),
  laneId: text('lane_id').notNull().references(() => dicePendingLanes.id, { onDelete: 'cascade' }),
  // Nullable — set when the roll binds to a committed user message.
  // onDelete set null so rollback can release bindings without deleting rolls.
  boundMessageId: text('bound_message_id').references(() => messages.id, { onDelete: 'set null' }),
  // Actor snapshot (frozen at roll time — survives rename/delete).
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  actorLabel: text('actor_label').notNull(),
  // Script snapshot — NO FK (no-cascade rule). The roll owns its own labels + revision.
  scriptId: text('script_id').notNull(),
  scriptLabel: text('script_label').notNull(),
  scriptRevision: integer('script_revision').notNull(),
  // Check snapshot.
  checkId: text('check_id').notNull(),
  checkLabel: text('check_label').notNull(),
  // Dice notation + face shape.
  notation: text('notation').notNull(),
  faceShape: text('face_shape').notNull(),
  // Adjudication + mode.
  resolution: text('resolution').notNull(),
  mode: text('mode').notNull(),
  // Immersive include/exclude-from-binding (with undo via included=true).
  included: integer('included', { mode: 'boolean' }).notNull().default(true),
  // The attempt id chosen as the final result, or null while unchosen.
  finalAttemptId: text('final_attempt_id'),
  // Attempts array (JSON). Always non-empty; Normal has exactly 1.
  attemptsJson: text('attempts_json').notNull(),
  // Final envelope (JSON, nullable). Present on strict checks; absent on narrative.
  finalJson: text('final_json'),
  // Script-provided retry reason (Immersive grants).
  retryReason: text('retry_reason'),
  // Finalization policy (Immersive).
  policy: text('policy'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  laneIdx: index('idx_dice_rolls_lane').on(table.laneId),
  messageIdx: index('idx_dice_rolls_message').on(table.boundMessageId),
}));
