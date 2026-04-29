import type { PromptLayerPosition } from "./types.js";

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
  toolInstructions: 300,
  postHistoryInstructions: 160,
  mesExample: 150,
  recentHistory: 100,
  preflightCompaction: 50,
  promptPresetSummary: 350,
} as const;

export const PROMPT_LAYER_ID = {
  promptPresetSystem: "prompt_preset_system",
  promptPresetJailbreak: "prompt_preset_jailbreak",
  promptPresetSummary: "prompt_preset_summary",
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
