/**
 * Server-internal chat application-service command/result types.
 * These are NOT shared across package boundaries — they are consumed
 * only by services/api. Kept local to avoid polluting the domain package
 * with route-transport shapes.
 */
import type {
  ChatBranchId,
  ChatId,
  ChatMode,
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
  /** Chat mode. Omit/undefined → DB default 'rp'. */
  mode?: ChatMode;
}

export interface CreateChatResponse {
  id: ChatId;
  activeBranchId: string;
}

export interface SendMessageRequest {
  content: string;
  mode: "reply" | "continue";
  attachments?: Attachment[];
  /**
   * DICE-B10: optional Dice commit intent. When present, the user-message
   * insert and the Dice pending-lane bind run in ONE atomic transaction — the
   * active-mode lane's server-included/finalized rolls bind to the new message,
   * the inactive-mode lane is discarded, and both lanes reset. Omitted/undefined
   * ⇒ no-Dice send behavior (byte-for-byte current path).
   *
   * `pendingRevision` is the client's last-seen active-lane revision; a stale
   * value fails the whole commit before the message row persists. `mode` selects
   * which lane is active. Never carries raw rolls or client-selected keys.
   */
  diceCommit?: {
    mode: "normal" | "immersive";
    pendingRevision: number;
  };
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
