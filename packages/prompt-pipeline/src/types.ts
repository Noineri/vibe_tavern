export type PromptLayerPosition =
  | "before_prompt"
  | "in_prompt"
  | "in_chat"
  | "hidden_system";

export interface PromptLayer {
  id: string;
  sourceType: string;
  sourceId: string;
  position: PromptLayerPosition;
  priority: number;
  enabled: boolean;
  reason: string;
  tokenCount: number;
  text: string;
}

export interface RecentMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface PromptAssemblyContext {
  chatId: string;
  character: {
    id: string;
    name: string;
    description: string;
    scenario?: string | null;
    systemPrompt?: string | null;
    personality?: string | null;
  };
  persona?: {
    id: string;
    name: string;
    description: string;
  } | null;
  systemPreset?: {
    id: string;
    text: string;
  } | null;
  activeLoreEntries?: Array<{
    id: string;
    title: string;
    content: string;
    priority: number;
    position?: PromptLayerPosition;
  }>;
  generationRules?: Array<{
    id: string;
    title: string;
    content: string;
    priority: number;
  }>;
  summaryMemory?: Array<{
    id: string;
    kind: string;
    summary: string;
  }>;
  retrievalMemory?: Array<{
    id: string;
    sourceType: string;
    content: string;
    score: number;
  }>;
  recentMessages: RecentMessage[];
  mesExample?: string | null;
  postHistoryInstructions?: string | null;
  toolInstructions?: string | null;
  outputConstraints?: string | null;
  contextBudget?: number | null;
}

export interface PromptAssemblyResult {
  layers: PromptLayer[];
  totalTokenEstimate: number;
  activatedLoreEntries: string[];
  usedMemoryBlocks: string[];
  droppedLayers: Array<{
    id: string;
    reason: string;
  }>;
  finalPayload: Record<string, unknown>;
}
