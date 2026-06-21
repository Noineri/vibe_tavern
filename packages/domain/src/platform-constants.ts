/** Prefixes used when generating entity IDs (e.g. "char_…", "chat_…", "msg_…"). */
export const ENTITY_ID_NAMESPACE = {
  character: "char",
  characterVersion: "charver",
  scratchCharacter: "char",
  scratchCharacterVersion: "ver",
  freeCharacter: "free",
  freeCharacterVersion: "fver",
  persona: "persona",
  lorebook: "lorebook",
  loreEntry: "lore_entry",
  loreEntryDeterministic: "loreentry",
  chat: "chat",
  chatBranch: "branch",
  chatSummary: "chat_summary",
  message: "msg",
  messageVariant: "variant",
  summaryMemory: "summary",
  promptTrace: "trace",
  providerProfile: "provider",
  promptPreset: "prompt_preset",
  script: "script",
} as const;

export type EntityIdNamespace = typeof ENTITY_ID_NAMESPACE[keyof typeof ENTITY_ID_NAMESPACE];

/** Well-known IDs for system-managed singleton resources. */
export const SYSTEM_RESOURCE_ID = {
  toolsDisabled: "tools_disabled",
  unresolvedModel: "unresolved_model",
  activeToolProfile: "active_tool_profile",
  preflight: "preflight",
} as const;

export type SystemResourceId = typeof SYSTEM_RESOURCE_ID[keyof typeof SYSTEM_RESOURCE_ID];

/**
 * Supported LLM provider backends.
 *
 * - `openaiCompat` — OpenAI API and all compatible endpoints
 * - `anthropic` — Anthropic Claude API
 * - `google` — Google Gemini API
 * - `ollama` — Ollama (via OpenAI-compatible adapter)
 * - `llamaCpp` — llama.cpp server (via OpenAI-compatible adapter)
 * - `koboldCpp` — KoboldCpp (native adapter, non-OpenAI API)
 * - `unsloth` — Unsloth Studio (OpenAI-compatible /v1 endpoints; requires sk-unsloth- key)
 */
export const PROVIDER_TYPE = {
  openaiCompat: "openai_compat",
  anthropic: "anthropic",
  google: "google",
  ollama: "ollama",
  llamaCpp: "llamacpp",
  koboldCpp: "koboldcpp",
  unsloth: "unsloth",
} as const;

export type ProviderType = typeof PROVIDER_TYPE[keyof typeof PROVIDER_TYPE];

export const PROVIDER_PRESET_GROUP = {
  cloud: "cloud",
  native: "native",
  local: "local",
} as const;

export type ProviderPresetGroup = typeof PROVIDER_PRESET_GROUP[keyof typeof PROVIDER_PRESET_GROUP];

/**
 * Character card serialization formats.
 *
 * - `st_v2` — SillyTavern V2 spec
 * - `st_v3` — SillyTavern V3 spec
 * - `janitor_md` — Janitor-flavored Markdown
 * - `internal_json` — Platform-internal JSON representation
 */
export const CARD_FORMAT = {
  sillyTavernV2: "st_v2",
  sillyTavernV3: "st_v3",
  janitorMarkdown: "janitor_md",
  internalJson: "internal_json",
} as const;

export type CardFormat = typeof CARD_FORMAT[keyof typeof CARD_FORMAT];

export const LORE_SCOPE_TYPE = {
  global: "global",
  character: "character",
  persona: "persona",
  chat: "chat",
} as const;

export type LoreScopeType = typeof LORE_SCOPE_TYPE[keyof typeof LORE_SCOPE_TYPE];

export const CHAT_STATUS = {
  active: "active",
  archived: "archived",
} as const;

export type ChatStatus = typeof CHAT_STATUS[keyof typeof CHAT_STATUS];

export const MESSAGE_ROLE = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
} as const;

export type MessageRole = typeof MESSAGE_ROLE[keyof typeof MESSAGE_ROLE];

export const AUTHOR_TYPE = MESSAGE_ROLE;
export type AuthorType = typeof AUTHOR_TYPE[keyof typeof AUTHOR_TYPE];

/**
 * Lifecycle states of a chat message.
 *
 * - `pending` — currently being generated
 * - `complete` — generation finished
 * - `edited` — user-modified after generation
 * - `deleted` — soft-deleted
 */
export const MESSAGE_STATE = {
  pending: "pending",
  complete: "complete",
  edited: "edited",
  deleted: "deleted",
} as const;

export type MessageState = typeof MESSAGE_STATE[keyof typeof MESSAGE_STATE];

/**
 * Categories of summary memories.
 *
 * - `scene` — current scene description
 * - `relationship` — relationship dynamics between characters
 * - `world_state` — world/setting facts
 * - `open_threads` — unresolved plot threads
 * - `general` — catch-all category
 */
export const SUMMARY_KIND = {
  scene: "scene",
  relationship: "relationship",
  worldState: "world_state",
  openThreads: "open_threads",
  general: "general",
} as const;

export type SummaryKind = typeof SUMMARY_KIND[keyof typeof SUMMARY_KIND];

export const CHAT_SUMMARY_SOURCE = {
  manual: "manual",
  auto: "auto",
} as const;

export type ChatSummarySource = typeof CHAT_SUMMARY_SOURCE[keyof typeof CHAT_SUMMARY_SOURCE];

/**
 * Activation modes for a tool profile.
 *
 * - `disabled` — tools are off
 * - `available_on_request` — user can invoke tools manually
 * - `active` — tools are always enabled
 * - `hidden_system_use_only` — internal system tools, not exposed to user
 */
export const TOOL_PROFILE_MODE = {
  disabled: "disabled",
  availableOnRequest: "available_on_request",
  active: "active",
  hiddenSystemUseOnly: "hidden_system_use_only",
} as const;

export type ToolProfileMode = typeof TOOL_PROFILE_MODE[keyof typeof TOOL_PROFILE_MODE];

/**
 * Logic operators that combine primary keys with secondary keys in a {@link LoreEntry}.
 *
 * - `and_any` — at least one secondary key must match
 * - `and_all` — all secondary keys must match
 * - `not_any` — none of the secondary keys may match
 * - `not_all` — not all secondary keys match (at least one missing)
 */
export const LORE_LOGIC = {
  andAny: "and_any",
  andAll: "and_all",
  notAny: "not_any",
  notAll: "not_all",
} as const;

export type LoreLogic = typeof LORE_LOGIC[keyof typeof LORE_LOGIC];

/**
 * Where a prompt layer is injected into the assembled prompt.
 *
 * - `before_prompt` — prepended before everything else
 * - `in_prompt` — main prompt block (system / jailbreak)
 * - `in_chat` — inserted into the chat history (may use `injectionDepth`)
 * - `hidden_system` — system-level instruction not shown in prompt traces
 */
export const PROMPT_LAYER_POSITION = {
  beforePrompt: "before_prompt",
  inPrompt: "in_prompt",
  inChat: "in_chat",
  hiddenSystem: "hidden_system",
} as const;

export type PromptLayerPosition = typeof PROMPT_LAYER_POSITION[keyof typeof PROMPT_LAYER_POSITION];

/**
 * Lorebook entry position — the prompt slot where an activated entry's text
 * is inserted. Wider than `PromptLayerPosition` because SillyTavern World
 * Info defines 8 fine-grained positions that map onto the prompt-order
 * canvas (before/after char, before/after example messages, before/after
 * Author's Note, at-depth, outlet). VT preserves all 8 ST positions so
 * imports do not lose the user's carefully-placed before/after split.
 *
 * The 4 pipeline-native positions (`before_prompt | in_prompt | in_chat |
 * hidden_system`) cover VT-native lorebooks that don't map to ST's taxonomy.
 *
 * `assemble.ts` switches on these literals to route each entry to the right
 * `worldInfoBefore` / `worldInfoAfter` marker and subPosition.
 */
export const LORE_ENTRY_POSITION = {
  // SillyTavern World Info positions (8)
  beforeChar: "before_char",
  afterChar: "after_char",
  beforeExamples: "before_examples",
  afterExamples: "after_examples",
  topAn: "top_an",
  bottomAn: "bottom_an",
  atDepth: "at_depth",
  outlet: "outlet",
  // Pipeline-native positions (4)
  beforePrompt: "before_prompt",
  inPrompt: "in_prompt",
  inChat: "in_chat",
  hiddenSystem: "hidden_system",
} as const;

export type LoreEntryPosition = typeof LORE_ENTRY_POSITION[keyof typeof LORE_ENTRY_POSITION];

export const RETRIEVED_MEMORY_SOURCE_TYPE = {
  loreEntry: "lore_entry",
  characterSection: "character_section",
  message: "message",
  summary: "summary",
} as const;

export type RetrievedMemorySourceType = typeof RETRIEVED_MEMORY_SOURCE_TYPE[keyof typeof RETRIEVED_MEMORY_SOURCE_TYPE];

export const LORE_ENTRY_ROLE = {
  system: "system",
  user: "user",
  assistant: "assistant",
} as const;

export type LoreEntryRole = typeof LORE_ENTRY_ROLE[keyof typeof LORE_ENTRY_ROLE];

// `LORE_TRIGGER_TYPE` / `LoreTriggerType` and mode-based lore-entry
// activation were removed: the UI chips had already been deleted, and the
// engine filter was unreachable because `mode` was hardcoded to "normal" on
// every call site. The DB column `lore_entries.triggers_json` remains as an
// orphan in existing user databases (removing it would require a
// table-rebuild migration for no functional gain) but no code reads it. See
// vibe_tavern_plan/reports/lorebook-st-parity-audit.md §3.5.


export const LORE_MATCH_SOURCE = {
  chatMessages: "chat_messages",
  characterDesc: "character_desc",
  characterPersonality: "character_personality",
  characterNote: "character_note",
  personaDesc: "persona_desc",
  scenario: "scenario",
  creatorNotes: "creator_notes",
} as const;

export type LoreMatchSource = typeof LORE_MATCH_SOURCE[keyof typeof LORE_MATCH_SOURCE];
