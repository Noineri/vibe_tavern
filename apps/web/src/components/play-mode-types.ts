export interface MessageBlockProps {
  /** Message ID — component reads data from store via useDisplayMessage(id) */
  messageId: string;
  characterName: string;
  isEditing: boolean;
  isGenerating?: boolean;
  editingDraft: string;
  isBusy: boolean;
  canBranch: boolean;
  canRegenerate: boolean;
  canResend: boolean;
  canSwitchVariant: boolean;
  isGreeting?: boolean;
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
