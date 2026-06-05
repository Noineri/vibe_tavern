import type { PromptLayerPosition } from "./types.js";
import type { AssemblyMode } from "./types.js";

export const DEFAULT_PROMPT_LAYER_PRIORITY = 0;

export const PROMPT_LAYER_POSITION_RANK: Record<PromptLayerPosition, number> = {
  before_prompt: 0,
  in_prompt: 1,
  in_chat: 2,
  hidden_system: 3,
};

/**
 * Sub-positions for fine-grained ordering within the `in_prompt` position.
 * Corresponds to ST WI Anchors — determines where lorebook entries
 * are placed relative to character description, Author's Note, and
 * example messages within the system prompt.
 */
export const IN_PROMPT_SUB_POSITION = {
  /** Character description blocks (character_base, personality, persona) */
  charDesc: 0,
  /** WI entries positioned after character description (ST: after_char) */
  afterChar: 10,
  /** WI entries positioned before Author's Note (ST: top_an) */
  beforeAuthorNote: 15,
  /** Author's Note itself */
  authorNote: 20,
  /** WI entries positioned after Author's Note (ST: bottom_an) */
  afterAuthorNote: 25,
  /** WI entries positioned before example messages (ST: before_examples) */
  beforeExamples: 30,
  /** Example messages */
  exampleMessages: 40,
  /** WI entries positioned after example messages (ST: after_examples) */
  afterExamples: 50,
  /** Post-history instructions (after everything in system prompt) */
  postHistoryInstructions: 60,
} as const;

/**
 * Numeric priority system for prompt layers.
 *
 * Higher values = more important / rendered first within the same position.
 *
 * | Range | Purpose                          |
 * |-------|----------------------------------|
 * | 1000  | System prompt (highest priority) |
 * | 900+  | Character definition blocks      |
 * | 500   | Summary / retrieval memory       |
 * | 300   | Tool instructions                |
 * | 100   | Chat history                     |
 * | <100  | Compaction diagnostics           |
 */
export const PROMPT_LAYER_PRIORITY = {
  promptPresetSystem: 1000,
  promptPresetJailbreak: 990,
  characterSystemPrompt: 950,
  characterBase: 900,
  characterScenario: 895,
  characterPersonality: 890,
  persona: 850,
  presetEnhanceDefinitions: 830,
  presetNsfw: 820,
  summaryMemory: 500,
  retrievalMemory: 400,
  promptPresetSummary: 350,
  toolInstructions: 300,
  promptPresetAuthorsNote: 170,
  postHistoryInstructions: 160,
  mesExample: 150,
  characterDepthPrompt: 155,
  recentHistory: 100,
  preflightCompaction: 50,
  // AI assistant layers
  aiAssistantSystem: 1000,
  aiAssistantContext: 900,
  aiAssistantExisting: 50,
  aiAssistantInstruction: 10,
} as const;

export const PROMPT_LAYER_ID = {
  promptPresetSystem: "prompt_preset_system",
  promptPresetJailbreak: "prompt_preset_jailbreak",
  promptPresetSummary: "prompt_preset_summary",
  promptPresetAuthorsNote: "prompt_preset_authors_note",
  promptPresetNsfw: "prompt_preset_nsfw",
  promptPresetEnhanceDefinitions: "prompt_preset_enhance_definitions",
  characterSystemPrompt: "character_system_prompt",
  characterBase: "character_base",
  characterScenario: "character_scenario",
  characterPersonality: "character_personality",
  persona: "persona",
  toolInstructions: "tool_instructions",
  preflightCompaction: "preflight_compaction",
  recentHistory: "recent_history",
  mesExample: "mes_example",
  characterDepthPrompt: "character_depth_prompt",
  postHistoryInstructions: "post_history_instructions",
  // AI assistant layers
  aiAssistantSystem: "ai_assistant_system",
  aiAssistantContext: "ai_assistant_context",
  aiAssistantExisting: "ai_assistant_existing",
  aiAssistantInstruction: "ai_assistant_instruction",
} as const;

export const PROMPT_LAYER_SOURCE_TYPE = {
  promptPreset: "prompt_preset",
  characterSystemPrompt: "character_system_prompt",
  character: "character",
  persona: "persona",
  loreEntry: "lore_entry",
  summaryMemory: "summary_memory",
  retrievalMemory: "retrieval_memory",
  toolProfile: "tool_profile",
  compaction: "compaction",
  chatHistory: "chat_history",
  aiAssistant: "ai_assistant",
} as const;

export const PROMPT_LAYER_SOURCE_ID = {
  activeToolProfile: "active_tool_profile",
  preflight: "preflight",
} as const;

/** Generate a prefixed layer ID for a dynamically loaded lore entry. */
export function createLoreLayerId(id: string): string {
  return `lore_${id}`;
}

/** Generate a prefixed layer ID for a summary-memory block. */
export function createSummaryMemoryLayerId(id: string): string {
  return `summary_${id}`;
}

/** Generate a prefixed layer ID for a retrieval-memory block. */
export function createRetrievalMemoryLayerId(id: string): string {
  return `retrieval_${id}`;
}

/**
 * Formatting helpers that wrap raw text into prompt-ready blocks.
 *
 * - `characterHeader(name)`          — `"Character: {name}"`
 * - `scenarioHeader(text)`           — `"Scenario: {text}"`
 * - `personaBlock(name,desc,pronouns)` — `"User persona ({name}[, {pronouns}]): {desc}"`
 * - `loreHeader(title)`              — `"Lore: {title}"`
 * - `summaryMemory(kind, text)`      — `"[{kind}] {text}"`
 * - `retrievalMemory(src, content)`  — `"[Retrieved {src}] {content}"`
 * - `exampleMessages(text)`          — `"[Example messages]\n{text}"`
 */
export const PROMPT_FORMAT = {
  characterHeader: (name: string) => `Character: ${name}`,
  scenarioHeader: (text: string) => `Scenario: ${text}`,
  personaBlock: (name: string, desc: string, pronouns?: string | null) => {
    const tag = pronouns ? `${name}, ${pronouns}` : name;
    return `User persona (${tag}): ${desc}`;
  },
  loreHeader: (title: string) => `Lore: ${title}`,
  summaryMemory: (kind: string, text: string) => `[${kind}] ${text}`,
  retrievalMemory: (sourceType: string, content: string) => `[Retrieved ${sourceType}] ${content}`,
  exampleMessages: (text: string) => `[Example messages]\n${text}`,
} as const;

/**
 * Reason strings attached to layers to explain why they were included or dropped.
 *
 * - `included`               — standard layer, always present
 * - `emptyLoreContent`        — lore entry had no content after trimming
 * - `activatedLoreEntry`      — lore entry matched and was activated
 * - `emptySummaryMemory`      — summary memory block was empty
 * - `emptyRetrievalMemory`    — retrieval memory block was empty
 * - `preflightCompaction(N)`  — preflight compaction dropped N messages
 */
export const PROMPT_LAYER_REASON = {
  included: "included",
  emptyLoreContent: "empty lore content",
  activatedLoreEntry: "activated lore entry",
  emptySummaryMemory: "empty summary memory",
  emptyRetrievalMemory: "empty retrieval memory",
  preflightCompaction: (droppedCount: number) => `preflight_compaction_dropped_${droppedCount}`,
} as const;

/**
 * Maps built-in layer IDs to the list of {@link AssemblyMode}s they are active in.
 *
 * Lore and memory layers are not listed here; they default to
 * `["chat", "continue", "regenerate"]` via runtime logic.
 */
export const LAYER_MODES: Record<string, AssemblyMode[]> = {
  prompt_preset_system:        ["chat", "continue", "regenerate"],
  prompt_preset_jailbreak:     ["chat", "continue", "regenerate"],
  prompt_preset_summary:       ["summary"],
  prompt_preset_authors_note:  ["chat", "continue", "regenerate"],
  prompt_preset_nsfw:          ["chat", "continue", "regenerate"],
  prompt_preset_enhance_definitions: ["chat", "continue", "regenerate"],
  character_system_prompt:     ["chat", "continue", "regenerate", "summary"],
  character_base:              ["chat", "continue", "regenerate", "summary"],
  character_scenario:          ["chat", "continue", "regenerate", "summary"],
  character_personality:       ["chat", "continue", "regenerate", "summary"],
  persona:                     ["chat", "continue", "regenerate", "summary"],
  tool_instructions:           ["chat", "continue", "regenerate", "tool_call"],
  post_history_instructions:   ["chat", "continue", "regenerate"],
  mes_example:                 ["chat", "continue", "regenerate", "summary"],
  preflight_compaction:        ["chat", "continue", "regenerate"],
  // Lore and memory layers default to chat modes
  // (lore entries inherit from their source; these are fallbacks)
  // AI assistant layers
  ai_assistant_system:      ["ai_assistant"],
  ai_assistant_context:     ["ai_assistant"],
  ai_assistant_existing:    ["ai_assistant"],
  ai_assistant_instruction: ["ai_assistant"],
};
