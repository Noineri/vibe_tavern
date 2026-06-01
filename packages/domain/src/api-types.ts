import type {
  ChatBranchId,
  ChatId,
  MessageId,
} from "./ids.js";

export interface PromptLayerDto {
  id: string;
  sourceType: string;
  sourceId: string;
  /** Human-readable label for the trace UI. */
  sourceName: string;
  position: "before_prompt" | "in_prompt" | "in_chat" | "hidden_system";
  priority: number;
  enabled: boolean;
  reason: string;
  tokenCount: number;
  text: string;
  injectionDepth?: number;
  modes?: string[];
}

export interface AssemblePromptResponse {
  layers: PromptLayerDto[];
  tokenAccounting: Record<string, number>;
  activatedLoreEntries: string[];
  scriptInjections: Array<{
    scriptId: string;
    scriptName: string;
    personalityMutation: string;
    scenarioMutation: string;
    error?: string;
  }>;
  retrievedMemories: Array<Record<string, unknown>>;
  finalPayload: Record<string, unknown>;
  prefill?: string | null;
}

export interface PromptTraceRecordDto extends AssemblePromptResponse {
  id: string;
  chatId: ChatId;
  branchId: ChatBranchId;
  messageId: MessageId;
  model: string;
  presetName: string;
  latencyMs: number;
  createdAt: string;
}

export interface PromptPresetDto {
  id: string;
  name: string;
  bindModel: string;
  system: string;
  jailbreak: string;
  prefill: string;
  authorsNote: string;
  authorsNoteDepth: number;
  authorsNotePosition: "in_prompt" | "in_chat" | "after_chat";
  summary: string;
  tools: string;
  customInjections: CustomInjection[];
  promptOrder: PromptOrderEntry[];
  scriptAiSystemPrompt: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Advanced Prompt Order (attached to PromptPreset) ───────────────────────

export interface PromptOrderEntry {
  identifier: string;
  enabled: boolean;
  order?: number;
  kind?: "built_in" | "custom";
}

// ─── Custom Injections (attached to PromptPreset) ───────────────────────────

export interface CustomInjection {
  identifier?: string;
  name: string;
  content: string;
  depth: number;
  role: 'system' | 'user' | 'assistant';
  enabled: boolean;
  /** ST compatibility: 0/relative = prompt-order block, 1/absolute = depth injection. */
  injectionPosition?: 0 | 1 | 'relative' | 'absolute';
  /** ST compatibility: order bucket for absolute/depth injections. */
  injectionOrder?: number;
  /** ST compatibility: original prompt_order index. */
  promptOrderIndex?: number;
  /** Derived ST prompt_order placement relative to chatHistory. */
  promptOrderPlacement?: 'before_chat' | 'after_chat';
}

export interface ProviderProbeResponse {
  success: boolean;
  error?: string;
  modelCount?: number;
}
