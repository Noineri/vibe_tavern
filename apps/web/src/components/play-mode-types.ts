import type { ChatBranch, ChatBranchId } from "@rp-platform/domain";
import type { AppMessage } from "../app-client.js";

export interface MessageBlockProps {
  message: AppMessage;
  characterName: string;
  isEditing: boolean;
  isGenerating?: boolean;
  editingDraft: string;
  isBusy: boolean;
  canBranch: boolean;
  canRegenerate: boolean;
  onBranch: () => void;
  onStartEdit: () => void;
  onEditingDraftChange: (value: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onDelete: () => void;
  onRegenerate: () => void;
  onSelectPreviousVariant: () => void;
  onSelectNextVariant: () => void;
}

export interface MessageListProps {
  characterName: string;
  scenario: string;
  branches: ChatBranch[];
  activeBranchId: ChatBranchId;
  messages: AppMessage[];
  pendingUserMessageContent: string | null;
  editingMessageId: string | null;
  editingDraft: string;
  isSending: boolean;
  messageActionId: string | null;
  onActivateBranch: (branchId: ChatBranchId) => void;
  onFork: () => void;
  onStartEdit: (message: AppMessage) => void;
  onEditingDraftChange: (value: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onSelectVariant: (messageId: string, variantIndex: number) => void;
}

export interface InputAreaProps {
  characterName: string;
  personaName: string;
  draft: string;
  tokenCount: number;
  sendLabel: string;
  isSending: boolean;
  canSend: boolean;
  notice: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
}

export interface PlayModeProps {
  messageList: MessageListProps;
  inputArea: InputAreaProps;
}
