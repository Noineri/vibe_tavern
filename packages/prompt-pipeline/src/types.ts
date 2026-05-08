import type { PromptLayerPosition } from "@rp-platform/domain";

export type { PromptLayerPosition };

/** Which generation scenario this prompt assembly is for. */
export type AssemblyMode = "chat" | "continue" | "regenerate" | "summary" | "tool_call";

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
  /** For in_chat layers: insert at this many messages from end of history. Undefined = treat as block before history. */
  injectionDepth?: number;
  /** Which assembly modes this layer is active in. Undefined = all modes (backward compat). */
  modes?: AssemblyMode[];
}

export interface RecentMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface PromptAssemblyContext {
  identity: {
    chatId: string;
  };
  character: {
    id: string;
    name: string;
    description: string;
    scenario?: string | null;
    systemPrompt?: string | null;
    personality?: string | null;
    mesExample?: string | null;
    postHistoryInstructions?: string | null;
  };
  persona?: {
    id: string;
    name: string;
    description: string;
  } | null;
  preset?: {
    id: string;
    name?: string;
    text: string;
    jailbreak?: string | null;
    summary?: string | null;
    tools?: string | null;
    prefill?: string | null;
    authorsNote?: string | null;
    authorsNoteDepth?: number | null;
  } | null;
  /** Assembly mode. Defaults to "chat". */
  mode?: AssemblyMode;
  lore?: Array<{
    id: string;
    title: string;
    content: string;
    priority: number;
    position?: PromptLayerPosition;
  }>;
  memory?: {
    summary?: Array<{
      id: string;
      kind: string;
      summary: string;
    }>;
    retrieval?: Array<{
      id: string;
      sourceType: string;
      content: string;
      score: number;
    }>;
  };
  chat: {
    recentMessages: RecentMessage[];
  };
  instructions?: {
    toolInstructions?: string | null;
  };
  config?: {
    contextBudget?: number | null;
  };
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
  /** Assistant prefill text, passed through from preset for executor use. */
  prefill?: string | null;
}
