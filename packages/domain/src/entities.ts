import type {
  CharacterId,
  CharacterVersionId,
  ChatBranchId,
  ChatId,
  LoreEntryId,
  LorebookId,
  MessageId,
  MessageVariantId,
  PersonaId,
  PromptPresetId,
  PromptTraceId,
  RetrievedMemoryHitId,
  SummaryMemorySnapshotId,
  ToolProfileId,
} from "./ids.js";

import type {
  CardFormat,
  LoreScopeType,
  ChatStatus,
  MessageRole,
  AuthorType,
  MessageState,
  SummaryKind,
  ToolProfileMode,
  LoreLogic,
  PromptLayerPosition,
} from "./platform-constants.js";

export type Timestamp = string;

export {
  CardFormat,
  LoreScopeType,
  ChatStatus,
  MessageRole,
  AuthorType,
  MessageState,
  SummaryKind,
  ToolProfileMode,
  LoreLogic,
  PromptLayerPosition,
};

export interface Character {
  id: CharacterId;
  slug: string;
  name: string;
  description: string;
  personalitySummary: string | null;
  defaultScenario: string | null;
  firstMessage: string | null;
  mesExample: string | null;
  alternateGreetings: string[];
  postHistoryInstructions: string | null;
  creatorNotes: string | null;
  characterBook: Record<string, unknown> | null;
  depthPrompt: string | null;
  depthPromptDepth: number | null;
  depthPromptRole: string | null;
  extensions: Record<string, unknown>;
  systemPrompt: string | null;
  tags: string[];
  avatarAssetId: string | null;
  status: "active" | "draft" | "archived";
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CharacterVersion {
  id: CharacterVersionId;
  characterId: CharacterId;
  versionNumber: number;
  title: string;
  cardFormat: CardFormat;
  definition: Record<string, unknown>;
  isActive: boolean;
  createdAt: Timestamp;
}

export interface Persona {
  id: PersonaId;
  name: string;
  description: string;
  pronouns: string | null;
  avatarAssetId: string | null;
  defaultForNewChats: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Lorebook {
  id: LorebookId;
  name: string;
  scopeType: LoreScopeType;
  description: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface LoreEntry {
  id: LoreEntryId;
  lorebookId: LorebookId;
  title: string;
  content: string;
  keys: string[];
  secondaryKeys: string[];
  logic: LoreLogic;
  position: PromptLayerPosition;
  depth: number;
  priority: number;
  stickyWindow: number;
  cooldownWindow: number;
  delayWindow: number;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

export interface Chat {
  id: ChatId;
  characterId: CharacterId;
  personaId: PersonaId | null;
  title: string;
  status: ChatStatus;
  activeBranchId: ChatBranchId;
  promptPresetId: PromptPresetId;
  toolProfileId: ToolProfileId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ChatBranch {
  id: ChatBranchId;
  chatId: ChatId;
  parentBranchId: ChatBranchId | null;
  forkedFromMessageId: MessageId | null;
  label: string;
  createdAt: Timestamp;
}

export interface Message {
  id: MessageId;
  chatId: ChatId;
  branchId: ChatBranchId;
  role: MessageRole;
  authorType: AuthorType;
  position: number;
  content: string;
  state: MessageState;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface MessageVariant {
  id: MessageVariantId;
  messageId: MessageId;
  variantIndex: number;
  content: string;
  isSelected: boolean;
  finishReason: string | null;
  createdAt: Timestamp;
}

export interface SummaryMemorySnapshot {
  id: SummaryMemorySnapshotId;
  chatId: ChatId;
  branchId: ChatBranchId;
  kind: SummaryKind;
  summary: string;
  coversThroughMessageId: MessageId;
  createdAt: Timestamp;
}

export interface RetrievedMemoryHit {
  id: RetrievedMemoryHitId;
  chatId: ChatId;
  sourceType: "lore_entry" | "character_section" | "message" | "summary";
  sourceId: string;
  score: number;
  matchedKeys: string[];
  content: string;
  createdAt: Timestamp;
}

export interface PromptTrace {
  id: PromptTraceId;
  chatId: ChatId;
  branchId: ChatBranchId;
  messageId: MessageId;
  model: string;
  presetName: string;
  assembledLayers: Array<{
    id: string;
    sourceType: string;
    sourceId: string;
    position: "before_prompt" | "in_prompt" | "in_chat" | "hidden_system";
    priority: number;
    enabled: boolean;
    reason: string;
    tokenCount: number;
    text: string;
    injectionDepth?: number;
    modes?: string[];
  }>;
  tokenAccounting: Record<string, number>;
  activatedLoreEntries: LoreEntryId[];
  retrievedMemories: Array<Record<string, unknown>>;
  finalPayload: Record<string, unknown>;
  latencyMs: number;
  prefill?: string | null;
  createdAt: Timestamp;
}

export interface ToolProfile {
  id: ToolProfileId;
  name: string;
  mode: ToolProfileMode;
  instructions: string | null;
  metadata: Record<string, unknown>;
}

export interface PromptPreset {
  id: PromptPresetId;
  name: string;
  bindModel: string;
  system: string;
  jailbreak: string;
  summary: string;
  tools: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
