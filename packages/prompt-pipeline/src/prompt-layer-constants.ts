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
