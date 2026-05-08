import type { PromptLayerPosition } from "./types.js";
import type { AssemblyMode } from "./types.js";

export const DEFAULT_PROMPT_LAYER_PRIORITY = 0;

export const PROMPT_LAYER_POSITION_RANK: Record<PromptLayerPosition, number> = {
  before_prompt: 0,
  in_prompt: 1,
  in_chat: 2,
  hidden_system: 3,
};

export const PROMPT_LAYER_PRIORITY = {
  promptPresetSystem: 1000,
  promptPresetJailbreak: 990,
  characterSystemPrompt: 950,
  characterBase: 900,
  characterPersonality: 890,
  persona: 850,
  summaryMemory: 500,
  retrievalMemory: 400,
  promptPresetSummary: 350,
  toolInstructions: 300,
  promptPresetAuthorsNote: 170,
  postHistoryInstructions: 160,
  mesExample: 150,
  recentHistory: 100,
  preflightCompaction: 50,
} as const;

export const PROMPT_LAYER_ID = {
  promptPresetSystem: "prompt_preset_system",
  promptPresetJailbreak: "prompt_preset_jailbreak",
  promptPresetSummary: "prompt_preset_summary",
  promptPresetAuthorsNote: "prompt_preset_authors_note",
  characterSystemPrompt: "character_system_prompt",
  characterBase: "character_base",
  characterPersonality: "character_personality",
  persona: "persona",
  toolInstructions: "tool_instructions",
  preflightCompaction: "preflight_compaction",
  recentHistory: "recent_history",
  mesExample: "mes_example",
  postHistoryInstructions: "post_history_instructions",
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
} as const;

export const PROMPT_LAYER_SOURCE_ID = {
  activeToolProfile: "active_tool_profile",
  preflight: "preflight",
} as const;

export function createLoreLayerId(id: string): string {
  return `lore_${id}`;
}

export function createSummaryMemoryLayerId(id: string): string {
  return `summary_${id}`;
}

export function createRetrievalMemoryLayerId(id: string): string {
  return `retrieval_${id}`;
}

export const PROMPT_FORMAT = {
  characterHeader: (name: string) => `Character: ${name}`,
  scenarioHeader: (text: string) => `Scenario: ${text}`,
  personaBlock: (name: string, desc: string) => `User persona (${name}): ${desc}`,
  loreHeader: (title: string) => `Lore: ${title}`,
  summaryMemory: (kind: string, text: string) => `[${kind}] ${text}`,
  retrievalMemory: (sourceType: string, content: string) => `[Retrieved ${sourceType}] ${content}`,
  exampleMessages: (text: string) => `[Example messages]\n${text}`,
} as const;

export const PROMPT_LAYER_REASON = {
  included: "included",
  emptyLoreContent: "empty lore content",
  activatedLoreEntry: "activated lore entry",
  emptySummaryMemory: "empty summary memory",
  emptyRetrievalMemory: "empty retrieval memory",
  preflightCompaction: (droppedCount: number) => `preflight_compaction_dropped_${droppedCount}`,
} as const;

/** Which assembly modes each built-in layer is active in. Undefined = all modes (backward compat). */
export const LAYER_MODES: Record<string, AssemblyMode[]> = {
  prompt_preset_system:        ["chat", "continue", "regenerate"],
  prompt_preset_jailbreak:     ["chat", "continue", "regenerate"],
  prompt_preset_summary:       ["summary"],
  prompt_preset_authors_note:  ["chat", "continue", "regenerate"],
  character_system_prompt:     ["chat", "continue", "regenerate"],
  character_base:              ["chat", "continue", "regenerate", "summary"],
  character_personality:       ["chat", "continue", "regenerate"],
  persona:                     ["chat", "continue", "regenerate", "summary"],
  tool_instructions:           ["chat", "continue", "regenerate", "tool_call"],
  post_history_instructions:   ["chat", "continue", "regenerate"],
  mes_example:                 ["chat", "continue", "regenerate"],
  preflight_compaction:        ["chat", "continue", "regenerate"],
  // Lore and memory layers default to chat modes
  // (lore entries inherit from their source; these are fallbacks)
};
