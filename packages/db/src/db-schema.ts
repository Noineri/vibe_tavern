import type {
  CoauthorTransport,
  ProviderProxyMode,
  ProviderQuotaErrorKind,
  ProviderQuotaEvent,
  ProviderQuotaEventKind,
  ProviderQuotaKind,
  ProviderQuotaSnapshot,
  QuotaTransitionState,
} from '@vibe-tavern/domain';
import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey, check } from 'drizzle-orm/sqlite-core';

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
  dynamicPrompt: text('dynamic_prompt').notNull().default(''),
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

// ─── copilotProfiles ──────────────────────────────────────────────────────────
// User-created experience-copilot profiles (EXPERIENCE_COPILOT_PROFILES_PLAN,
// CP-2). The built-in "Experience Authoring" profile is a code-defined read-only
// seed (CP-4), never stored here; this table holds only user-authored profiles.
// Mirrors `coauthor_modules` minus `description` and `openingMessage` (the
// copilot is not a chat-mode and does not greet). `basePrompt` is inline text
// (never a file path) so the editor works on one field for both built-in and
// user profiles. `max_steps` was dropped in TAG-4b (the tool-loop is unbounded —
// see COPILOT_TOOL_LOOP_CEILING).
export const copilotProfiles = sqliteTable('copilot_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  basePrompt: text('base_prompt').notNull(),
  skillIdsJson: text('skill_ids_json').notNull().default('[]'),
  toolSetJson: text('tool_set_json').notNull().default('{}'),
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
  // Default visual paired with this experience (interactive scripts only). Set
  // by the creation wizard so the script↔visual pairing persists across chats;
  // ExperienceAssignment auto-applies it while keeping per-chat overrides.
  // Null for non-interactive scripts and pre-existing rows. DB-only metadata:
  // intentionally absent from the file payload/content hash (changing the
  // default visual is not a source revision). Soft link — a plain stored id
  // with NO database FK: deleting the visual leaves a stale id here, which is
  // harmless because ExperienceAssignment only applies the default when the
  // visual still exists in the loaded list (and an ALTER TABLE FK could not
  // carry ON DELETE SET NULL, which would otherwise have blocked visual
  // deletion).
  defaultVisualId: text('default_visual_id'),
  // Optional copilot profile assigned to this experience (EXPERIENCE_COPILOT_PROFILES_PLAN,
  // CP-2). Soft link — a plain stored id with NO database FK (mirrors
  // `coauthor_module_id` / `default_visual_id`): a deleted profile leaves a
  // stale id here, which the resolver falls back to the built-in seed (CP-6).
  // Null = no profile assigned ⇒ behavior identical to the built-in seed.
  copilotProfileId: text('copilot_profile_id'),
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

// ─── scriptVisuals ───────────────────────────────────────────────────────────
//
// Many-to-many junction: an interactive rules script binds a SET of visuals
// ("skins" — e.g. a VK-style messenger skin + a compact skin), one of which is
// its primary (`scripts.default_visual_id` — the one auto-selected when the
// rules are picked). The per-chat visual dropdown narrows to JUST this bound
// set; it is never a flat pick from all visuals. The primary is always a
// member of the bound set (enforced in `ScriptStore.unbindVisual` and restored
// by the migration backfill). Same link-binding principle as `scriptLinks` and
// the lorebook/persona/character binders: bind by reference to a reusable
// resource, not a copy. The cascade FKs mean deleting a script or visual
// removes its junction rows automatically; `scripts.default_visual_id` is a
// soft link (no FK) and may go stale on visual deletion — tolerated by the
// app-level existence guard in ExperienceAssignment.
export const scriptVisuals = sqliteTable('script_visuals', {
  scriptId: text('script_id').notNull().references(() => scripts.id, { onDelete: 'cascade' }),
  visualId: text('visual_id').notNull().references(() => experienceVisuals.id, { onDelete: 'cascade' }),
}, (table) => ({
  // Composite PK: one binding per (script, visual) pair.
  pk: primaryKey({ columns: [table.scriptId, table.visualId] }),
  scriptIdx: index('idx_script_visuals_script').on(table.scriptId),
  visualIdx: index('idx_script_visuals_visual').on(table.visualId),
}));

// ─── regexPresets / regexLinks ────────────────────────────────────────────────
//
// Named SillyTavern-parity find/replace scripts (ST `RegexScriptData`;
// REGEX_EXTENSION_PLAN, RX-2). Columns map 1:1 onto the `RegexPreset` domain
// interface in packages/domain/src/entities.ts: array fields persist as JSON
// (`trimStringsJson`, `placementJson` — placement codes stay numerically
// ST-parity), ST's ephemerality flags (`markdownOnly`/`promptOnly`) persist as
// their own columns, depth bounds are nullable (null = unlimited).
//
// `regexLinks` is the third instance of the `lorebookLinks`/`scriptLinks`
// junction pattern ({presetId, targetType, targetId}, composite PK, cascade
// FK). Binding targets are characters and prompt presets only — persona is
// excluded by design (a regex preset is content-transforming machinery, not
// persona-scoped knowledge).
export const regexPresets = sqliteTable('regex_presets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  findRegex: text('find_regex').notNull(),
  replaceString: text('replace_string').notNull().default(''),
  trimStringsJson: text('trim_strings_json').notNull().default('[]'),
  substituteRegex: integer('substitute_regex').notNull().default(0),
  disabled: integer('disabled').notNull().default(0),
  markdownOnly: integer('markdown_only').notNull().default(0),
  promptOnly: integer('prompt_only').notNull().default(0),
  runOnEdit: integer('run_on_edit').notNull().default(1),
  minDepth: integer('min_depth'),
  maxDepth: integer('max_depth'),
  // RegexPlacement[] as JSON; default = [AI_OUTPUT] only.
  placementJson: text('placement_json').notNull().default('[2]'),
  isGlobal: integer('is_global').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  // R-13 profile membership: null = standalone rule. FK is ON DELETE SET NULL
  // (profile deletion keeps rules as standalone by default — folder metaphor;
  // the cascade variant is an explicit store-level operation, not the FK).
  profileId: text('profile_id').references(() => regexProfiles.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  globalIdx: index('idx_regex_presets_global').on(table.isGlobal),
  profileIdx: index('idx_regex_presets_profile').on(table.profileId),
}));

/**
 * Regex profiles (R-13): an ordered bundle of regex rules with a single
 * binding + master enable switch (the lorebook analogy). Rows in this table
 * and `regex_presets` participate in ONE flat sort sequence — both tables
 * carry their own `sort_order` and the client (R-13b list) interleaves them
 * by sending explicit sortOrder values; there is deliberately NO combined
 * reorder endpoint (cross-table ordering is orchestrated by the client).
 * `regexProfileLinks` is the fourth instance of the lorebook/script junction
 * pattern; binding targets are characters and prompt presets only.
 */
export const regexProfiles = sqliteTable('regex_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  disabled: integer('disabled').notNull().default(0),
  isGlobal: integer('is_global').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  globalIdx: index('idx_regex_profiles_global').on(table.isGlobal),
}));

export const regexLinks = sqliteTable('regex_links', {
  regexPresetId: text('regex_preset_id').notNull().references(() => regexPresets.id, { onDelete: 'cascade' }),
  targetType: text('target_type').notNull(),  // 'character' | 'preset'
  targetId: text('target_id').notNull(),
}, (table) => ({
  // Composite PK: one link per (preset, target) pair
  pk: primaryKey({ columns: [table.regexPresetId, table.targetType, table.targetId] }),
  targetIdx: index('idx_regex_links_target').on(table.targetType, table.targetId),
  presetIdx: index('idx_regex_links_preset').on(table.regexPresetId),
}));

export const regexProfileLinks = sqliteTable('regex_profile_links', {
  regexProfileId: text('regex_profile_id').notNull().references(() => regexProfiles.id, { onDelete: 'cascade' }),
  targetType: text('target_type').notNull(),  // 'character' | 'preset'
  targetId: text('target_id').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.regexProfileId, table.targetType, table.targetId] }),
  targetIdx: index('idx_regex_profile_links_target').on(table.targetType, table.targetId),
  profileIdx: index('idx_regex_profile_links_profile').on(table.regexProfileId),
}));

// ─── servicePromptProfiles ────────────────────────────────────────────────────
//
// Independent profiles overriding the app's 21 base system prompts
// (SERVICE_PROMPTS_PROFILES_PLAN, SP-2). Overrides persist as JSON
// (partial map field→text, strict-object schema). The seeded row
// id "default" is the live Default profile — self-healed by
// ServicePromptProfileStore.ensureDefault(). No folder/file coupling.
export const servicePromptProfiles = sqliteTable('service_prompt_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  isDefault: integer('is_default').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  overrides: text('overrides').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── ttsProfiles / ttsProfileLinks ──────────────────────────────────────
//
// Named TTS voice profiles (TTS_PLAN TS-1; design TTS_DESIGN). Standalone
// entity — NOT providerProfiles, which is LLM-generation-specific. Columns
// map 1:1 onto the `TtsProfile` domain interface: the backend-specific config
// bag persists as JSON (`configJson`) and is validated per-backend by the
// registry contracts (TS-2+), not by the DB. `isDefault` is the voice map's
// [Default Voice] pointer — at most one row, store-maintained.
//
// `ttsProfileLinks` is the voice-map junction ({profileId, targetType,
// targetId}, composite PK, cascade FK); targets are characters AND personas
// (the user's own voice) — a deliberately different vocabulary from the
// regex/lorebook junctions, which bind characters and prompt presets.
export const ttsProfiles = sqliteTable('tts_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  backend: text('backend').notNull(),  // TTS_BACKEND slug
  configJson: text('config_json').notNull().default('{}'),
  voiceId: text('voice_id').notNull().default(''),
  narratorVoiceId: text('narrator_voice_id'),
  lang: text('lang').notNull().default('en'),
  sortOrder: integer('sort_order').notNull().default(0),
  isDefault: integer('is_default').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  defaultIdx: index('idx_tts_profiles_default').on(table.isDefault),
  backendIdx: index('idx_tts_profiles_backend').on(table.backend),
}));

export const ttsProfileLinks = sqliteTable('tts_profile_links', {
  ttsProfileId: text('tts_profile_id').notNull().references(() => ttsProfiles.id, { onDelete: 'cascade' }),
  targetType: text('target_type').notNull(),  // 'character' | 'persona'
  targetId: text('target_id').notNull(),
  // TS-9a-foundation: 'voice' | 'disabled' (design's disable-per-character);
  // additive column, default keeps pre-existing rows as voice bindings.
  mode: text('mode').notNull().default('voice'),
}, (table) => ({
  // Composite PK: one link per (profile, target) pair.
  pk: primaryKey({ columns: [table.ttsProfileId, table.targetType, table.targetId] }),
  targetIdx: index('idx_tts_profile_links_target').on(table.targetType, table.targetId),
  profileIdx: index('idx_tts_profile_links_profile').on(table.ttsProfileId),
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
  // Baked-at-generation-time preset NAME snapshot (no FK). Historically this was
  // a `preset_id` FK to prompt_presets (ON DELETE SET NULL), but that coupled
  // message metadata to the lifetime of a preset row: deleting a preset would
  // either block (stale NO-ACTION FK in old-build DBs — PRESET_COPY_DELETE_
  // CORRUPTION bug 2) or silently null out the historical record (SET NULL).
  // Since the value is purely display metadata ("which preset generated this"),
  // it is baked as an immutable text string — survives preset delete/rename,
  // consistent with model_id (also a plain text column, no FK).
  presetName: text('preset_name'),
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
  mergeConsecutiveRoles: integer('merge_consecutive_roles').notNull().default(0),
  contentHash: text('content_hash'),
  hasFileOnDisk: integer('has_file_on_disk').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── proxyProfiles ────────────────────────────────────────────────────────────
// Named HTTP(S)/SOCKS5 proxy entries for provider outbound traffic
// (LOCAL_API_ORIGIN_AND_PROVIDER_PROXY_REPORT). The `password` column is a
// stored secret — it never crosses the wire boundary (clients receive
// `hasStoredPassword` instead, mirroring providerProfiles.api_key).
export const proxyProfiles = sqliteTable('proxy_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // HTTP(S) or SOCKS5 proxy URL without embedded userinfo. Username/password
  // live as separate columns so the URL can be logged safely.
  url: text('url').notNull(),
  username: text('username'),
  password: text('password'),
  // Manual list order (drag-to-reorder). Backfilled to created_at ASC.
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── proxySettings ────────────────────────────────────────────────────────────
// Singleton row (id = 'default') holding the global default proxy id. Null
// means direct by default (providers in 'inherit' mode connect directly).
export const proxySettings = sqliteTable('proxy_settings', {
  id: text('id').primaryKey(),
  defaultProxyId: text('default_proxy_id').references(() => proxyProfiles.id, { onDelete: 'set null' }),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  singletonIdCheck: check('proxy_settings_singleton_id_check', sql`${table.id} = 'default'`),
}));

// ─── providerProfiles ──────────────────────────────────────────────────────────

export const providerProfiles = sqliteTable('provider_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // Manual list order (drag-to-reorder). Backfilled to created_at ASC.
  sortOrder: integer('sort_order').notNull().default(0),
  providerPreset: text('provider_preset').notNull(),
  coauthorTransport: text('coauthor_transport').$type<CoauthorTransport>().notNull().default('chat_completions'),
  endpoint: text('endpoint').notNull(),
  apiKey: text('api_key'),
  defaultModel: text('default_model'),
  contextBudget: integer('context_budget'),
  pinContextBudget: integer('pin_context_budget', { mode: 'boolean' }).notNull().default(false),
  /** When true, sampler/context edits in the modal write to a per-model overlay
   *  (providerModelSettings) instead of the profile base. See resolveEffectiveSettings. */
  bindPerModel: integer('bind_per_model', { mode: 'boolean' }).notNull().default(false),
  // Model-list display prefs (MODEL_LIST_FILTERS). Pure UI — no backend logic reads these;
  // they round-trip to the selectors via the profile record.
  modelFreeOnly: integer('model_free_only', { mode: 'boolean' }).notNull().default(false),
  modelGroupByOwner: integer('model_group_by_owner', { mode: 'boolean' }).notNull().default(false),
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
  // ── Outbound proxy policy (LOCAL_API_ORIGIN_AND_PROVIDER_PROXY_REPORT, step 2) ──
  // Per-provider proxy selection: 'inherit' (follow global default), 'direct'
  // (bypass), or 'proxy' (use proxyId). ProxyStore.delete updates the mode/id
  // pair before deleting the referenced proxy, preserving the check invariant.
  proxyMode: text('proxy_mode').$type<ProviderProxyMode>().notNull().default('inherit'),
  proxyId: text('proxy_id').references(() => proxyProfiles.id, { onDelete: 'set null' }),
  visionModel: text('vision_model'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  proxyPolicyCheck: check(
    'provider_profiles_proxy_policy_check',
    sql`(${table.proxyMode} = 'proxy' AND ${table.proxyId} IS NOT NULL) OR (${table.proxyMode} IN ('inherit', 'direct') AND ${table.proxyId} IS NULL)`,
  ),
}));

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

// ─── providerQuotaSettings ─────────────────────────────────────────────────────
// The user's three quota toggles, one row per profile. `configKind` mirrors the
// capability kind the toggles were written for: `balance` configs have no
// notification columns (they stay NULL) and `none` configs have nothing at all —
// the nullability IS the type-level "display only" rule, persisted.
export const providerQuotaSettings = sqliteTable('provider_quota_settings', {
  providerProfileId: text('provider_profile_id').primaryKey().references(() => providerProfiles.id, { onDelete: 'cascade' }),
  configKind: text('config_kind').$type<ProviderQuotaKind>().notNull(),
  displayEnabled: integer('display_enabled', { mode: 'boolean' }).notNull().default(false),
  /** windowed only — NULL for balance/none. */
  lowQuotaEnabled: integer('low_quota_enabled', { mode: 'boolean' }),
  /** windowed only — integer 1..100. */
  lowQuotaRemainingPercent: integer('low_quota_remaining_percent'),
  /** windowed only — NULL for balance/none. */
  resetNotifyEnabled: integer('reset_notify_enabled', { mode: 'boolean' }),
  /** windowed + balance — integer 1..5 minutes. NULL for `none` (never polled). */
  pollIntervalMinutes: integer('poll_interval_minutes'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── providerQuotaSnapshots ────────────────────────────────────────────────────
// Latest normalized snapshot per profile plus the transition state machine's
// memory. RAW VENDOR PAYLOADS ARE NEVER STORED — only the normalized model.
export const providerQuotaSnapshots = sqliteTable('provider_quota_snapshots', {
  providerProfileId: text('provider_profile_id').primaryKey().references(() => providerProfiles.id, { onDelete: 'cascade' }),
  /** NULL until the first successful poll — a profile whose very first poll 401s
   *  still needs its `lastError` on record so the route can report it. */
  snapshotJson: text('snapshot_json', { mode: 'json' }).$type<ProviderQuotaSnapshot>(),
  /** NULL for balance/none profiles — they have no windows, so no latches exist. */
  transitionStateJson: text('transition_state_json', { mode: 'json' }).$type<QuotaTransitionState>(),
  /** ProviderQuotaErrorKind of the last failed poll, or NULL when the last poll succeeded. */
  lastError: text('last_error').$type<ProviderQuotaErrorKind>(),
  updatedAt: text('updated_at').notNull(),
});

// ─── providerQuotaEvents ───────────────────────────────────────────────────────
// Emitted-notification ledger. The PK is the deterministic event id built by the
// transition state machine, so replaying the same situation after a restart hits
// a duplicate-key conflict instead of re-notifying the user.
export const providerQuotaEvents = sqliteTable('provider_quota_events', {
  eventId: text('event_id').primaryKey(),
  providerProfileId: text('provider_profile_id').notNull().references(() => providerProfiles.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<ProviderQuotaEventKind>().notNull(),
  /** The exact payload put on the bus. */
  payloadJson: text('payload_json', { mode: 'json' }).$type<ProviderQuotaEvent>().notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  profileIdx: index('idx_provider_quota_events_profile').on(table.providerProfileId),
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
  // Optional Co-Author-only token overrides. Null inherits the selected
  // profile/model effective values so RP configuration remains untouched.
  coauthorMaxTokens: integer('coauthor_max_tokens'),
  coauthorContextBudget: integer('coauthor_context_budget'),
  // ─── GitHub star prompt ───
  // One flag silences both the first-run welcome strip and the periodic modal.
  // userMessageCount is server-owned and monotonic; nextStarPromptAt is the
  // count at which the modal is due; starPromptDeferrals selects the backoff
  // interval and is stored rather than derived, because a suppression guard can
  // let the count run past the due point before the modal ever opens.
  githubStarred: integer('github_starred', { mode: 'boolean' }).notNull().default(false),
  userMessageCount: integer('user_message_count').notNull().default(0),
  nextStarPromptAt: integer('next_star_prompt_at').notNull().default(10),
  starPromptDeferrals: integer('star_prompt_deferrals').notNull().default(0),
  // Experience-copilot generation binding — app-wide, same semantics as the
  // Co-Author binding above (null/dangling → the shell falls back to the first
  // available profile; no DB-level FK).
  copilotProviderId: text('copilot_provider_id'),
  copilotModelName: text('copilot_model_name'),
  // Service prompt profiles — globally active profile id (SP-2). Null/dangling
  // → Default profile (id "default") is used. No DB-level FK — mirrors
  // coauthor/copilot bindings.
  activeServicePromptProfileId: text('active_service_prompt_profile_id'),
  // One-time marker (SP-7): the preset→profile service-prompt migration has
  // completed. False on fresh installs (migration runs, finds nothing, flips
  // to true) and on pre-SP-7 upgrades (migration snapshots preset overrides
  // into named profiles). Written once by the startup hook, never reset.
  servicePromptPresetMigrated: integer('service_prompt_preset_migrated', { mode: 'boolean' }).notNull().default(false),

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

// ═══ Interactive Runtime (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 2 / IR-21) ═══
//
// Durable storage for the Interactive Runtime: visual resources, per-chat
// add-on configuration, branch-scoped sessions, the action/effect/system
// journal, durable model effects, frozen RP-context bundles, prompt overrides,
// and queued/bound RP-result attachments. Every authoritative value crosses a
// strict schema boundary before it reaches these tables (IR-11 wire schemas +
// the IR-12 kernel's jsonBoundsError); the store is the persistence authority
// core, wrapped by the Wave 3 service with validation + actor resolution.
//
// Two cross-cutting conventions, both borrowed from `dice_rolls`:
//  - NO-FK SOURCE SNAPSHOTS. A session/attachment pins the exact rules/visual
//    source (id + label + revision + source + sourceHash) as plain text with NO
//    FK to `scripts`/`experience_visuals`. Editing, disabling, unlinking, or
//    deleting the source row never corrupts an active or historical session —
//    the snapshot-isolation invariant. Source rows may cascade away; snapshots
//    survive.
//  - IDEMPOTENT + COMPARE-AND-SWAP. Mutating requests carry a per-session
//    unique `request_id` (idempotency net against rapid clicks / retries / two
//    tabs / process recovery) and an `expected_revision` (CAS: a stale revision
//    is rejected BEFORE any write). The session `revision` is monotonic and
//    increments on every applied transition.

// ─── experience_visuals ───────────────────────────────────────────────────────
// An editable, user-owned HTML/CSS/JS bundle that runs sandboxed in an iframe
// (Wave 6) and talks to the host only through the versioned `VibeExperience`
// bridge. Scope metadata mirrors `scripts` so a visual can be global or owned
// by a character/persona/chat; the FK CASCADE on those owners matches scripts.
export const experienceVisuals = sqliteTable('experience_visuals', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // The visual source bundle (HTML/CSS/JS). Wave 6 ships five editable starters;
  // the bundle is fully user-owned after copy and never silently rewritten.
  source: text('source').notNull(),
  sourceHash: text('source_hash').notNull(),
  // Bridge API version this visual targets.
  apiVersion: integer('api_version').notNull(),
  // Stable idempotency key for app-owned built-in visuals (nullable + unique):
  // an `ensureVisualByKey` carrying a stableKey that already exists returns the
  // existing visual rather than creating a second copy. NULL for user-owned
  // visuals — SQLite unique constraints treat NULLs as distinct, so many
  // coexist. Mirrors `scripts.creationIntentId`.
  stableKey: text('stable_key').unique(),
  // Manifest ids this visual is compatible with (loose coupling — a rules
  // revision does not inherently change the visual contract).
  compatibleManifestIdsJson: text('compatible_manifest_ids_json').notNull().default('[]'),
  scopeType: text('scope_type').notNull().default('global'),
  characterId: text('character_id').references(() => characters.id, { onDelete: 'cascade' }),
  personaId: text('persona_id').references(() => personas.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').references(() => chats.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  scopeTypeIdx: index('idx_experience_visuals_scope').on(table.scopeType),
  characterIdIdx: index('idx_experience_visuals_character').on(table.characterId),
  personaIdIdx: index('idx_experience_visuals_persona').on(table.personaId),
  chatIdIdx: index('idx_experience_visuals_chat').on(table.chatId),
}));

// ─── experience_chat_configs ─────────────────────────────────────────────────
// The per-chat Interactive Experience Chat Add-on row (InsightsPanel). Exactly
// one row per chat: whether the add-on is enabled, which rules script and visual
// it points at, the user-approved capability grants, the RP-context mode, and
// launcher visibility. Script/visual refs are LIVE pointers (SET NULL on
// source delete) — the add-on survives a source delete but prompts re-selection;
// sessions started from a config pin immutable snapshots separately. Activation
// is ALWAYS per-chat here; global Build surfaces only author resources.
export const experienceChatConfigs = sqliteTable('experience_chat_configs', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  // Live source pointers — SET NULL when the source row is deleted (the config
  // survives; the UI shows "select a script/visual"). NOT snapshot columns.
  scriptId: text('script_id').references(() => scripts.id, { onDelete: 'set null' }),
  visualId: text('visual_id').references(() => experienceVisuals.id, { onDelete: 'set null' }),
  // User-approved capabilities (a subset of the package's declared set).
  capabilityGrantsJson: text('capability_grants_json').notNull().default('[]'),
  contextMode: text('context_mode').notNull().default('none'),
  // User-chosen RP-context source (report item 6): an arbitrary character +
  // optional chat to freeze into the session's context bundle, instead of the
  // ambient host chat. Live pointers — SET NULL when the source is deleted (the
  // config survives; the next capture falls back to ambient). NULL = ambient.
  contextSourceCharacterId: text('context_source_character_id').references(() => characters.id, { onDelete: 'set null' }),
  contextSourceChatId: text('context_source_chat_id').references(() => chats.id, { onDelete: 'set null' }),
  // Wave 3: persona source pointer — the user-identity override for the RP
  // context. Live pointer, SET NULL on persona delete; NULL = ambient host
  // chat persona. Same semantics as the character/chat source pointers above.
  contextSourcePersonaId: text('context_source_persona_id').references(() => personas.id, { onDelete: 'set null' }),
  launcherVisible: integer('launcher_visible', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  // Exactly one config row per chat.
  chatUnique: uniqueIndex('idx_experience_chat_configs_chat').on(table.chatId),
}));

// ─── experience_sessions ─────────────────────────────────────────────────────
// A branch-scoped, persistent experience session. Owns chat/branch linkage,
// the nullable active_slot (unique per branch → at most one active session per
// branch), pinned rules/visual source snapshots (NO FK — snapshot isolation),
// initial/current state, monotonic revision, participants, granted
// capabilities, RP-context mode, report frontier, and the deterministic-random
// seed/cursor. The seed+cursor persist so a reload/restart resumes the exact
// stream; recalculation (rules-revision replay) re-seeds from `random_seed`.
export const experienceSessions = sqliteTable('experience_sessions', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  branchId: text('branch_id').notNull().references(() => chatBranches.id, { onDelete: 'cascade' }),
  // Nullable: a non-null slot marks the branch's active session. The unique
  // index below allows multiple NULL slots (paused/completed sessions) while
  // forbidding two sessions from claiming the same active slot in a branch.
  activeSlot: integer('active_slot'),
  // ── Pinned rules source snapshot (NO FK — survives any source lifecycle change) ──
  rulesId: text('rules_id').notNull(),
  rulesLabel: text('rules_label').notNull(),
  rulesRevision: integer('rules_revision').notNull(),
  rulesSource: text('rules_source').notNull(),
  rulesSourceHash: text('rules_source_hash').notNull(),
  // ── Pinned visual source snapshot (nullable; NO FK) ──
  visualId: text('visual_id'),
  visualLabel: text('visual_label'),
  visualRevision: integer('visual_revision'),
  visualSource: text('visual_source'),
  visualSourceHash: text('visual_source_hash'),
  // ── Discovered definition (frozen at start) ──
  apiVersion: integer('api_version').notNull(),
  manifestId: text('manifest_id').notNull(),
  manifestName: text('manifest_name').notNull(),
  // Initial authoritative settings — a deterministic-rebuild / replay input.
  initialSettingsJson: text('initial_settings_json').notNull(),
  // Current authoritative state (bounded JSON, round-trips through the kernel).
  currentStateJson: text('current_state_json').notNull(),
  status: text('status').notNull().default('active'),
  // Monotonic revision; increments on every applied transition (CAS target).
  revision: integer('revision').notNull().default(0),
  participantsJson: text('participants_json').notNull().default('[]'),
  capabilityGrantsJson: text('capability_grants_json').notNull().default('[]'),
  contextMode: text('context_mode').notNull().default('none'),
  // Highest revision frozen into a queued/bound report (never decreases).
  reportFrontier: integer('report_frontier').notNull().default(0),
  randomSeed: text('random_seed').notNull(),
  randomCursor: integer('random_cursor').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  // At most one active session per (branch, slot). SQLite treats NULLs as
  // distinct in a unique index, so paused/completed (NULL-slot) sessions coexist.
  branchActiveSlotUnique: uniqueIndex('idx_experience_sessions_branch_slot').on(table.branchId, table.activeSlot),
  chatIdx: index('idx_experience_sessions_chat').on(table.chatId),
  branchIdx: index('idx_experience_sessions_branch').on(table.branchId),
}));

// ─── experience_steps ────────────────────────────────────────────────────────
// The strictly ordered action/effect-result/system journal. Each applied
// transition appends one row; replay reads this table to rebuild state or
// recalculate under new rules. `request_id` is unique per session (idempotency:
// a duplicate request returns the prior applied step, never a second apply).
export const experienceSteps = sqliteTable('experience_steps', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => experienceSessions.id, { onDelete: 'cascade' }),
  // Strictly increasing per session; defines journal order.
  sequence: integer('sequence').notNull(),
  // 'action' (a reduce move) | 'effect_result' (a durable effect's outcome
  // re-entering the reducer) | 'system' (host-only: start/interrupt/finish).
  kind: text('kind').notNull(),
  // Idempotency key for action/effect steps; null for system steps.
  requestId: text('request_id'),
  expectedRevision: integer('expected_revision'),
  appliedRevision: integer('applied_revision'),
  // Actor/controller snapshot (survives participant rename/delete).
  actorSnapshotJson: text('actor_snapshot_json'),
  inputJson: text('input_json'),
  emittedEventsJson: text('emitted_events_json').notNull().default('[]'),
  emittedEffectsJson: text('emitted_effects_json').notNull().default('[]'),
  // Hash of the authoritative state AFTER this step (integrity / divergence check).
  stateHash: text('state_hash'),
  message: text('message'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  // Journal order is unique per session.
  sessionSequenceUnique: uniqueIndex('idx_experience_steps_session_sequence').on(table.sessionId, table.sequence),
  // request_id unique per session (idempotency net).
  sessionRequestUnique: uniqueIndex('idx_experience_steps_session_request').on(table.sessionId, table.requestId),
  sessionIdx: index('idx_experience_steps_session').on(table.sessionId),
}));

// ─── experience_effects ──────────────────────────────────────────────────────
// Durable model-effect records. The host persists a request as `pending`
// BEFORE running the capability work, so a process interruption never silently
// repeats an external call whose outcome is unknown. Restart reconciles a
// previously `running` effect to `unknown` (never directly back to `pending`);
// only an explicit user retry creates a new attempt (incrementing
// attempt_count), preserving the original effect id and audit history.
export const experienceEffects = sqliteTable('experience_effects', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => experienceSessions.id, { onDelete: 'cascade' }),
  // V1 capability kind: 'model' (atomic non-streaming generation).
  kind: text('kind').notNull(),
  // 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'.
  status: text('status').notNull().default('pending'),
  // The revision at which the reducer requested this effect.
  originatingRevision: integer('originating_revision').notNull(),
  requestJson: text('request_json').notNull(),
  resultJson: text('result_json'),
  error: text('error'),
  attemptCount: integer('attempt_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  sessionIdx: index('idx_experience_effects_session').on(table.sessionId),
  // Restart scans for in-flight effects to reconcile to 'unknown'.
  statusIdx: index('idx_experience_effects_status').on(table.status),
}));

// ─── experience_context_bundles ──────────────────────────────────────────────
// One frozen RP-context bundle per session (re-captured when the user changes
// the context mode). Independent from `chat_summaries`: capturing a context
// bundle never mutates the normal summary surface, and compact-summary
// generation is an explicit user action (never automatic). The selected-variant
// snapshots preserve alternating user/assistant identity (not flattened prose).
export const experienceContextBundles = sqliteTable('experience_context_bundles', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => experienceSessions.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull(),
  branchFrontierRevision: integer('branch_frontier_revision'),
  messageFrontierPosition: integer('message_frontier_position'),
  variantsJson: text('variants_json'),
  compactSummaryJson: text('compact_summary_json'),
  characterSnapshotJson: text('character_snapshot_json'),
  personaSnapshotJson: text('persona_snapshot_json'),
  sourceHashesJson: text('source_hashes_json'),
  // Provider/model used for a generated compact summary (plain text — survives
  // provider-profile delete/rename, consistent with message_variants.model_id).
  providerProfileId: text('provider_profile_id'),
  modelId: text('model_id'),
  // Provenance of the RP-context SOURCE this bundle was frozen from (report
  // item 6). Plain text, no FK — a bundle is an immutable snapshot and must
  // survive source deletion. NULL = captured from the ambient host chat.
  sourceCharacterId: text('source_character_id'),
  sourceChatId: text('source_chat_id'),
  // Wave 3: persona-source provenance (the frozen user identity). Plain text,
  // no FK — same snapshot-isolation rationale as the character/chat ids above.
  sourcePersonaId: text('source_persona_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  // One current bundle per session (upserted on re-capture).
  sessionUnique: uniqueIndex('idx_experience_context_bundles_session').on(table.sessionId),
}));

// ─── experience_prompt_overrides ─────────────────────────────────────────────
// Two layers of user-authored prompt override: one GLOBAL row (scope_type =
// 'global', character_id NULL) and zero-or-one per character (scope_type =
// 'character'). Package prompts and per-session participant prompts are SEPARATE
// immutable layers (not here); editing an override affects new effects only,
// not already-persisted requests. See the fixed model prompt order in the plan.
export const experiencePromptOverrides = sqliteTable('experience_prompt_overrides', {
  id: text('id').primaryKey(),
  scopeType: text('scope_type').notNull(),
  characterId: text('character_id').references(() => characters.id, { onDelete: 'cascade' }),
  content: text('content').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  // One global + at most one per character. NULL character_id is distinct in
  // SQLite, so the single global row (scope 'global', character_id NULL) is
  // unique, and each (scope 'character', character_id) is unique.
  scopeCharacterUnique: uniqueIndex('idx_experience_prompt_overrides_scope_character').on(table.scopeType, table.characterId),
}));

// ─── experience_attachments ──────────────────────────────────────────────────
// Immutable queued/bound RP-result reports and alternating transcripts. Frozen
// at one revision; later events require an explicit add-to-report action (a
// queued snapshot never expands silently). Bound to a user message atomically
// (Wave 5); the hidden state checkpoint is retained as message metadata so a
// future branch from that message restores the EXACT hidden game state.
//
// session_id is plain text with NO FK: a bound attachment is historical RP
// metadata that must survive the session's own lifecycle (completion/reduction),
// mirroring the dice no-FK-snapshot rule. bound_message_id CASCADES: deleting
// the message deletes its bound attachment (explicit cleanup, IR-53).
export const experienceAttachments = sqliteTable('experience_attachments', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  branchId: text('branch_id').notNull().references(() => chatBranches.id, { onDelete: 'cascade' }),
  // NO FK — historical reference; survives the session lifecycle.
  sessionId: text('session_id').notNull(),
  sessionRevision: integer('session_revision').notNull(),
  // Monotonic queue revision (orders successive freezes within a session).
  queueRevision: integer('queue_revision').notNull(),
  // 'report' (public events) | 'transcript' (alternating Messenger dialogue).
  kind: text('kind').notNull(),
  publicEventsJson: text('public_events_json').notNull(),
  // Compact authoritative state checkpoint (hidden; restores on branch fork).
  hiddenStateCheckpointJson: text('hidden_state_checkpoint_json').notNull(),
  // Pinned source hashes (survive rules/visual delete).
  rulesSourceHash: text('rules_source_hash').notNull(),
  visualSourceHash: text('visual_source_hash'),
  // NULL while queued; set when bound to a committed user message.
  boundMessageId: text('bound_message_id').references(() => messages.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  sessionIdx: index('idx_experience_attachments_session').on(table.sessionId),
  messageIdx: index('idx_experience_attachments_message').on(table.boundMessageId),
  chatBranchIdx: index('idx_experience_attachments_chat_branch').on(table.chatId, table.branchId),
}));

// ═══ Experience copilot (EXPERIENCE_EDITOR_REFACTOR_PLAN, ER-3) ═══════════════
//
// Per-experience copilot conversation persistence. An "experience" is an
// interactive rules script; the copilot is the LLM pair-editor that helps
// author/refine it. Each experience owns MULTIPLE copilot sessions, ONE ACTIVE
// at a time: "New session" archives the current and opens a clean one, and
// archived sessions stay resumable (activate flips one back to active). This
// mirrors the owner's B-b1 decision in the plan's Sessions bullet.
//
// At-most-one-active invariant (two layers, mirroring how
// experience_sessions + VersionStore handle the single-active pattern):
//  - DB layer: a PARTIAL unique index on script_id WHERE archived_at IS NULL —
//    expressible in drizzle-orm 0.38.4's sqlite DSL via IndexBuilder.where().
//  - App layer: ExperienceCopilotStore archives same-script_id siblings inside
//    a synchronous transaction (startNewSession/activate) so two actives can
//    never coexist even momentarily.
//
// script_id is a soft link with NO FK: set once the draft experience is first
// saved (persisted as a real scripts row); until then draft_session_id
// identifies the in-progress work. Deleting a script never cascade-deletes
// copilot history (the snapshot/no-FK-source convention used throughout this
// runtime), and a thread can predate the script row it will eventually point at.
export const experienceCopilotThreads = sqliteTable('experience_copilot_threads', {
  id: text('id').primaryKey(),
  // Soft link to the experience (scripts row). Nullable + set-on-first-save.
  // No FK — see the section comment above.
  scriptId: text('script_id'),
  // Identifies an unsaved draft session before the experience has a script_id.
  // Null once script_id is set.
  draftSessionId: text('draft_session_id'),
  title: text('title').notNull().default(''),
  // NULL = the active session for this script_id; non-null ISO timestamp =
  // archived (resumable). The partial unique index below guarantees at most one
  // NULL-archived_at row per script_id.
  archivedAt: text('archived_at'),
  // Segmented context-usage metrics from the LAST turn (CM-2). JSON of the
  // `experienceCopilotContextMetricsSchema` shape (system/digest/history/total/
  // budget/reserve tokens + source + measuredAt). Nullable: null until the first
  // turn reports usage. Malformed JSON on read → null (logged), never fatal.
  contextMetricsJson: text('context_metrics_json'),
  // Pinned-context links (CX-1): JSON array of {targetType, targetId}. Always
  // written via JSON.stringify of validated links; read via a defensive parse
  // (malformed → [], logged, never fatal). Resolved by id at ASSEMBLY time —
  // never a stored content copy, so a pinned entity can never go stale.
  contextLinksJson: text('context_links_json').notNull().default('[]'),
  // The model's step-plan for this thread (copilot todo/ask plan, TAG-2): JSON
  // array of {title, status: pending|active|completed|abandoned}. The model
  // owns it (read-only for the user); every `todo` tool call is a full-list
  // rewrite. Nullable: null until the first todo call. Malformed JSON on read
  // → [] (logged, never fatal) — same defensive-parse contract as
  // context_links_json above.
  todoJson: text('todo_json'),
  // The provider/model the thread LAST used (persisted from the stream finish
  // path) — the compaction service (CM-5) reuses this pair when the manual
  // compact endpoint omits one. Nullable: null before the first turn.
  lastProviderProfileId: text('last_provider_profile_id'),
  lastModel: text('last_model'),
  // Auto-compact toggle (CM-6): 1 = on (default), 0 = off. Stored as int 0/1
  // (SQLite has no native boolean) and exposed as a boolean on the store row.
  autoCompact: integer('auto_compact').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  scriptIdIdx: index('idx_experience_copilot_threads_script').on(table.scriptId),
  // At-most-one-active invariant (DB layer): at most one row per script_id with
  // archived_at IS NULL. The `sql` template is used instead of `and(isNull(...),
  // isNotNull(...))` because `and()` returns `SQL | undefined`, which the
  // IndexBuilder.where(condition: SQL) signature rejects. script_id IS NOT NULL
  // is belt-and-suspenders (the index is already ON script_id, so NULL rows are
  // distinct anyway); kept to match the spec's WHERE clause verbatim.
  activeScriptUnique: uniqueIndex('idx_experience_copilot_threads_active_script')
    .on(table.scriptId)
    .where(sql`${table.archivedAt} IS NULL AND ${table.scriptId} IS NOT NULL`),
}));

// ─── experienceCopilotMessages ────────────────────────────────────────────────
// The message history of a copilot thread — same conceptual shape as `messages`
// (role/content/tool_calls_json/tool_call_id) so a future turn-store adapts
// ~1:1. Append-only on the copilot turn loop; deleting a thread cascades its
// messages (ON DELETE CASCADE on the FK below).
export const experienceCopilotMessages = sqliteTable('experience_copilot_messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull().references(() => experienceCopilotThreads.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull().default(''),
  toolCallsJson: text('tool_calls_json'),
  toolCallId: text('tool_call_id'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  threadIdx: index('idx_experience_copilot_messages_thread').on(table.threadId),
}));

// ─── builtinExperienceDismissals ─────────────────────────────────────────────
// Tombstone marker for a built-in experience the user explicitly deleted or
// unlinked. `seedBuiltinExperiences` (BE-3) is create-or-return WITHOUT memory
// of deletion: an absent built-in visual looks "not seeded yet", so a restart
// would re-create and re-bind it (resurrecting what the user removed). Writing
// a row here at delete/unbind time lets the seed skip ensure + re-bind for that
// built-in id. `visualStableKey` is kept for reference / a future restore; the
// authoritative dismissal key is `builtin_id` (the catalog id).
export const builtinExperienceDismissals = sqliteTable('builtin_experience_dismissals', {
  builtinId: text('builtin_id').primaryKey(),
  visualStableKey: text('visual_stable_key').notNull(),
  dismissedAt: text('dismissed_at').notNull(),
});
