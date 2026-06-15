import type {
  CharacterId,
  CharacterVersionId,
  ChatBranchId,
  ChatId,
  ChatSummaryId,
  LoreEntryId,
  LorebookId,
  MessageId,
  MessageVariantId,
  PersonaId,
  PromptPresetId,
  PromptTraceId,
  RetrievedMemoryHitId,
  ScriptId,
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
  ChatSummarySource,
  ToolProfileMode,
  LoreLogic,
  LoreEntryRole,
  LoreTriggerType,
  LoreMatchSource,
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
  ChatSummarySource,
  ToolProfileMode,
  LoreLogic,
  LoreEntryRole,
  LoreTriggerType,
  LoreMatchSource,
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
  description: string;
  personalitySummary: string | null;
  defaultScenario: string | null;
  firstMessage: string | null;
  mesExample: string | null;
  mesExampleMode: string;
  mesExampleDepth: number;
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
  avatarCropJson: string | null;
  /** Extension of the folder-resident avatar at data/characters/{id}/avatar.{avatarExt}. Null = legacy flat avatar (avatarAssetId) or none. Backed by the CFS migration (C1+). */
  avatarExt: string | null;
  /** When true, the character's described gallery images are injected as a text prompt layer. */
  includeGalleryInPrompt?: boolean;
  /** When true, the avatar appearance description is injected as a text prompt layer. */
  includeAvatarInPrompt?: boolean;
  /** Vision-generated or user-edited avatar appearance description. Null/undefined = not described. */
  avatarDescription?: string | null;
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
  avatarCropJson: string | null;
  /** Extension of the folder-resident avatar at data/personas/{id}/avatar.{avatarExt}. Null = legacy flat avatar (avatarAssetId) or none. Backed by the CFS migration (C1+). */
  avatarExt: string | null;
  /** When true, the persona avatar appearance description is injected as a text prompt layer. */
  includeAvatarInPrompt?: boolean;
  /** Vision-generated or user-edited avatar appearance description. Null/undefined = not described. */
  avatarDescription?: string | null;
  defaultForNewChats: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Lorebook {
  id: LorebookId;
  name: string;
  description: string;
  scopeType: LoreScopeType;
  scanDepth: number;
  tokenBudget: number;
  recursiveScanning: boolean;
  maxRecursionSteps: number;
  includeNames: boolean;
  minActivations: number;
  minActivationsDepthMax: number;
  overflowAlert: boolean;
  characterStrategy: number;
  sortOrder: number;
  enabled: boolean;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  extensions: Record<string, unknown>;
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
  // Time windows
  stickyWindow: number;
  cooldownWindow: number;
  delayWindow: number;
  // Extended ST fields
  constant: boolean;
  probability: number;
  ignoreBudget: boolean;
  role: LoreEntryRole;
  // Inclusion group
  group: string;
  groupWeight: number;
  prioritizeInclusion: boolean;
  useGroupScoring: boolean;
  // Recursion
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean;
  recursionLevel: number;
  scanDepthOverride: number | null;
  // Matching
  caseSensitive: boolean;
  matchWholeWords: boolean;
  characterFilter: string[];
  characterFilterExclude: boolean;
  triggers: LoreTriggerType[];
  matchSources: LoreMatchSource[];
  // Meta
  enabled: boolean;
  sortOrder: number;
  automationId: string;
  metadata: Record<string, unknown>;
}

export interface Script {
  id: ScriptId;
  name: string;
  description: string;
  code: string;
  enabled: boolean;
  scopeType: LoreScopeType;
  sortOrder: number;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  extensions: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
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
  /** @deprecated Greeting selection is now stored as the selected variant on the first assistant message. */
  selectedGreetingIndex: number;
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
  messageCount?: number;
}

export interface ChatSummary {
  id: ChatSummaryId;
  chatId: ChatId;
  branchId: ChatBranchId;
  label: string;
  summarizedFrom: number;
  summarizedTo: number;
  includeInContext: boolean;
  excludeSummarized: boolean;
  source: ChatSummarySource;
  sortOrder: number;
  contentHash: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ChatAutoSummaryConfig {
  enabled: boolean;
  everyN: number;
  useChatModel: boolean;
  excludeSummarized: boolean;
  providerProfileId?: string;
  model?: string;
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
  modelId?: string | null;
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
    sourceName: string;
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
  scriptInjections: Array<{
    scriptId: string;
    scriptName: string;
    personalityMutation: string;
    scenarioMutation: string;
    error?: string;
  }>;
  retrievedMemories: Array<Record<string, unknown>>;
  finalPayload: Record<string, unknown>;
  latencyMs: number;
  prefill?: string | null;
  compactionSummary?: string | null;
  sentConfig?: {
    systemRole: string | undefined;
    samplerConfig: Record<string, unknown>;
    messageCount: number;
    visionDescriptions?: Array<{
      attachmentId: string;
      name: string;
      type: "image" | "video";
      description: string;
    }>;
  } | null;
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
  scriptAiSystemPrompt: string;
  aiAssistantPrompts: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
