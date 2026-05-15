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

/**
 * Core character entity.
 *
 * `characterBook` is a `Record` because its internal structure depends on the
 * card format (ST v2, ST v3, etc.).
 * `status` tracks the lifecycle: `active`, `draft`, or `archived`.
 */
export interface Character {
  id: CharacterId;
  slug: string;
  name: string;
  isSystem: boolean;
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
  avatarFullAssetId: string | null;
  status: "active" | "draft" | "archived";
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * A snapshot of a character card at a point in time (future multi-version support).
 *
 * `definition` holds the raw card data whose schema is determined by `cardFormat`.
 */
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
  avatarFullAssetId: string | null;
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

/**
 * A single lorebook entry.
 *
 * `keys` are activation triggers; `secondaryKeys` provide additional conditions
 * combined via `logic`.
 * `stickyWindow`, `cooldownWindow`, and `delayWindow` control time-based
 * activation behaviour (Phase 2).
 */
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

/**
 * A chat session bound to a character, persona, and prompt preset.
 *
 * `activeBranchId` points to the currently selected conversation branch.
 */
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

/**
 * An alternative response ("swipe") for a message.
 *
 * `isSelected` marks which variant is currently displayed.
 * `reasoning` and `reasoningDurationMs` capture chain-of-thought output
 * from thinking/reasoning models.
 */
export interface MessageVariant {
  id: MessageVariantId;
  messageId: MessageId;
  variantIndex: number;
  content: string;
  isSelected: boolean;
  finishReason: string | null;
  reasoning?: string;
  reasoningDurationMs?: number;
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

/**
 * A single hit from a RAG retrieval pass (Phase 3).
 *
 * `score` indicates relevance; `matchedKeys` lists the keys that triggered
 * the match.
 */
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

/**
 * Full audit record of an assembled prompt, used for debugging only — never
 * consumed at runtime.
 *
 * `assembledLayers` lists every layer that was included.
 * `finalPayload` is the exact JSON sent to the provider.
 */
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
