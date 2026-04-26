import type {
  ChatBranchId,
  ChatId,
  CharacterId,
  GenerationPresetId,
  MessageId,
  PersonaId,
  SummaryKind,
  ToolProfileId,
} from "@rp-platform/domain";

export interface ApiError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

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

export interface CreateChatRequest {
  characterId: CharacterId;
  personaId: PersonaId;
  title: string;
  generationPresetId: GenerationPresetId;
  toolProfileId: ToolProfileId;
}

export interface CreateChatResponse {
  id: ChatId;
  activeBranchId: string;
}

export interface SendMessageRequest {
  content: string;
  mode: "reply" | "continue";
}

export interface SendMessageResponse {
  streamUrl: string;
  userMessageId: MessageId;
  pendingAssistantMessageId: MessageId;
}

export interface CreateBranchRequest {
  sourceBranchId: ChatBranchId;
  forkedFromMessageId?: MessageId | null;
  label: string;
  activateFork?: boolean;
}

export interface CreateBranchResponse {
  branchId: ChatBranchId;
  copiedMessageCount: number;
}

export interface SleepBranchRequest {
  branchId: ChatBranchId;
  kind: SummaryKind;
  summary: string;
  coversThroughMessageId: MessageId;
}

export interface SleepBranchResponse {
  snapshotId: string;
  branchId: ChatBranchId;
  kind: SummaryKind;
}

export interface AssemblePromptResponse {
  layers: PromptLayerDto[];
  tokenAccounting: Record<string, number>;
  activatedLoreEntries: string[];
  retrievedMemories: Array<Record<string, unknown>>;
  finalPayload: Record<string, unknown>;
}

export interface ProviderProbeResponse {
  success: boolean;
  error?: string;
  modelCount?: number;
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

export interface ArchiveCharacterResponse {
  characterId: string;
  status: "archived";
}

export interface UnarchiveCharacterResponse {
  characterId: string;
  status: "active";
}

export interface RenameChatRequest {
  title: string;
}

export interface RenameChatResponse {
  chatId: string;
  title: string;
}

export interface CreatePersonaRequest {
  name: string;
  description: string;
  pronouns?: string | null;
  defaultForNewChats?: boolean;
}

export interface PersonalLorebookStatus {
  enabled: boolean;
  lorebookId: string | null;
}

export interface SetPersonalLorebookRequest {
  enabled: boolean;
}

export interface PromptPresetDto {
  id: string;
  name: string;
  bindModel: string;
  system: string;
  jailbreak: string;
  summary: string;
  tools: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePromptPresetRequest {
  name: string;
  bindModel?: string;
  system?: string;
  jailbreak?: string;
  summary?: string;
  tools?: string;
}

export interface UpdatePromptPresetRequest {
  name?: string;
  bindModel?: string;
  system?: string;
  jailbreak?: string;
  summary?: string;
  tools?: string;
}

export interface CreateCharacterChatRequest {
  characterId: CharacterId;
  title?: string;
}

export interface CloneChatResponse {
  chatId: ChatId;
  snapshot: unknown;
}

export type ExportCharacterResponse = Record<string, unknown>;

export interface MergeBranchRequest {
  sourceBranchId: ChatBranchId;
  targetBranchId: ChatBranchId;
}

export interface MergeBranchResponse {
  chatId: ChatId;
  activeBranchId: ChatBranchId;
  appendedMessageCount: number;
}

export interface DeleteBranchResponse {
  chatId: ChatId;
  activeBranchId: ChatBranchId;
  deletedBranchId: ChatBranchId;
}
