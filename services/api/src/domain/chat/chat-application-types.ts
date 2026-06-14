/**
 * Server-internal chat application-service command/result types.
 * These are NOT shared across package boundaries — they are consumed
 * only by services/api. Kept local to avoid polluting the domain package
 * with route-transport shapes.
 */
import type {
  ChatBranchId,
  ChatId,
  CharacterId,
  MessageId,
  PersonaId,
  PromptPresetId,
  SummaryKind,
  ToolProfileId,
} from "@vibe-tavern/domain";
import type { Attachment } from "@vibe-tavern/domain";

export interface CreateChatRequest {
  characterId: CharacterId;
  personaId: PersonaId;
  title: string;
  promptPresetId: PromptPresetId;
}

export interface CreateChatResponse {
  id: ChatId;
  activeBranchId: string;
}

export interface SendMessageRequest {
  content: string;
  mode: "reply" | "continue";
  attachments?: Attachment[];
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

export interface DeleteBranchResponse {
  chatId: ChatId;
  activeBranchId: ChatBranchId;
  deletedBranchId: ChatBranchId;
}
