import type {
  CharacterId,
  CharacterVersionId,
  ChatBranchId,
  ChatId,
  GenerationPresetId,
  GenerationRuleId,
  LoreEntryId,
  LorebookId,
  MessageId,
  MessageVariantId,
  PersonaId,
  PromptTraceId,
  RetrievedMemoryHitId,
  SummaryMemorySnapshotId,
  ToolProfileId,
} from "./ids.js";

export type Timestamp = string;

export type CardFormat = "st_v2" | "st_v3" | "janitor_md" | "internal_json";
export type LoreScopeType = "global" | "character" | "persona" | "chat";
export type ChatStatus = "active" | "archived";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type AuthorType = "system" | "user" | "assistant" | "tool";
export type MessageState = "pending" | "complete" | "edited" | "deleted";
export type SummaryKind =
  | "scene"
  | "relationship"
  | "world_state"
  | "open_threads"
  | "general";
export type ToolProfileMode =
  | "disabled"
  | "available_on_request"
  | "active"
  | "hidden_system_use_only";
export type LoreLogic = "and_any" | "and_all" | "not_any" | "not_all";
export type PromptLayerPosition =
  | "before_prompt"
  | "in_prompt"
  | "in_chat"
  | "hidden_system";

export interface Character {
  id: CharacterId;
  slug: string;
  name: string;
  description: string;
  defaultScenario: string | null;
  mesExample: string | null;
  alternateGreetings: string[];
  postHistoryInstructions: string | null;
  creatorNotes: string | null;
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
  personaId: PersonaId;
  title: string;
  status: ChatStatus;
  activeBranchId: ChatBranchId;
  generationPresetId: GenerationPresetId;
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

export interface GenerationPreset {
  id: GenerationPresetId;
  name: string;
  temperature: number;
  topP: number | null;
  topK: number | null;
  presencePenalty: number | null;
  frequencyPenalty: number | null;
  maxOutputTokens: number | null;
  systemStyleNote: string | null;
  metadata: Record<string, unknown>;
}

export interface GenerationRule {
  id: GenerationRuleId;
  scopeType: LoreScopeType | "character" | "chat";
  scopeId: string;
  title: string;
  content: string;
  enabled: boolean;
  priority: number;
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
  }>;
  tokenAccounting: Record<string, number>;
  activatedLoreEntries: LoreEntryId[];
  retrievedMemories: Array<Record<string, unknown>>;
  finalPayload: Record<string, unknown>;
  latencyMs: number;
  createdAt: Timestamp;
}

export interface ToolProfile {
  id: ToolProfileId;
  name: string;
  mode: ToolProfileMode;
  instructions: string | null;
  metadata: Record<string, unknown>;
}
