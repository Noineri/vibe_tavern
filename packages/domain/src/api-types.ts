import type {
  ChatBranchId,
  ChatId,
  MessageId,
} from "./ids.js";

export interface PromptLayerDto {
  id: string;
  sourceType: string;
  sourceId: string;
  position: "before_prompt" | "in_prompt" | "in_chat" | "hidden_system";
  priority: number;
  enabled: boolean;
  reason: string;
  tokenCount: number;
  text: string;
}

export interface AssemblePromptResponse {
  layers: PromptLayerDto[];
  tokenAccounting: Record<string, number>;
  activatedLoreEntries: string[];
  retrievedMemories: Array<Record<string, unknown>>;
  finalPayload: Record<string, unknown>;
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
  summary: string;
  tools: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProbeResponse {
  success: boolean;
  error?: string;
  modelCount?: number;
}
