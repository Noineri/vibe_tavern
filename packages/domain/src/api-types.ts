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
  scriptAiSystemPrompt: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Custom Injections (attached to PromptPreset) ───────────────────────────

export interface CustomInjection {
  name: string;
  content: string;
  depth: number;
  role: 'system' | 'user' | 'assistant';
  enabled: boolean;
}

export interface ProviderProbeResponse {
  success: boolean;
  error?: string;
  modelCount?: number;
}
