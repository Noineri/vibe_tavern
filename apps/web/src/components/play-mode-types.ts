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
  canResend: boolean;
  canSwitchVariant: boolean;
  greetingOptions?: string[];
  greetingIndex: number;
  onGreetingIndexChange: (index: number) => void;
  onBranch: () => void;
  onStartEdit: () => void;
  onEditingDraftChange: (value: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onDelete: () => void;
  onRegenerate: () => void;
  onResend: () => void;
  onSelectPreviousVariant: () => void;
  onSelectNextVariant: () => void;
  characterAvatarAssetId: string | null;
  personaAvatarAssetId: string | null;
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
  alternateGreetings?: string[];
  onActivateBranch: (branchId: ChatBranchId) => void;
  onFork: () => void;
  onStartEdit: (message: AppMessage) => void;
  onEditingDraftChange: (value: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onResend: () => void;
  onSelectVariant: (messageId: string, variantIndex: number) => void;
  characterAvatarAssetId: string | null;
  personaAvatarAssetId: string | null;
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
  personas: Array<{ id: string; name: string; description: string }>;
  activePersonaId: string | null;
  onSetPersona: (personaId: string) => void;
  tokenAccounting: Record<string, number>;
  contextSize: number;
  maxTokens: number;
  onCancel: () => void;
  onDraftChange: (value: string) => void;
  onSend: () => void;
}

export interface PlayModeProps {
  messageList: MessageListProps;
  inputArea: InputAreaProps;
  avatarPanel?: {
    src: string;
    open: boolean;
    onClose: () => void;
  };
}
