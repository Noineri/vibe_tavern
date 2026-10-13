import type { CoauthorEditorState } from "@vibe-tavern/api-contracts";
import type { ChatBranchId, ChatId, MessageId, PromptPresetId, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import { SYSTEM_RESOURCE_ID } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ChatModeAssembleLoaders, ChatModeAssembleResult, ChatModeStrategy } from "../../domain/chat/chat-mode-strategy.js";
import type { LoreEntityLookup } from "../../domain/chat/coauthor-tools.js";
import type { ContextSearchSession } from "../../domain/context/context-search-service.js";
import type { LoreDelegate } from "../../domain/coauthor/lore/lore-delegate.js";
import type { TrackerDelegate } from "../../domain/coauthor/tracker/tracker-delegate.js";
import type { PromptAssemblyService } from "../../domain/prompt/prompt-assembly-service.js";

export interface SessionPromptAssemblyOptions {
  excludeMessageIds?: MessageId[];
  model?: string;
  recentMessageLimit?: number;
  summary?: boolean;
  dryRun?: boolean;
  contextBudget?: number | null;
  responseReserve?: number;
  presetId?: PromptPresetId;
  priorSummaries?: Array<{ id: string; label?: string; content: string }>;
  coauthorEditorState?: CoauthorEditorState;
}

export interface SessionPromptAssemblyDeps {
  stores?: StoreContainer;
  promptService: PromptAssemblyService;
  resolveChatModeStrategy: (chatId: ChatId) => Promise<ChatModeStrategy>;
  getActiveProviderProfile: () => Promise<StoredProviderProfileRecord | null>;
  buildChatModeLoaders: () => ChatModeAssembleLoaders;
  buildLoreDelegate: () => Promise<LoreDelegate | undefined>;
  buildTrackerDelegate: () => Promise<TrackerDelegate | undefined>;
  createLoreEntityLookup: () => LoreEntityLookup | undefined;
  buildContextSearchSession: (chatId: ChatId) => ContextSearchSession | undefined;
}

/** Runtime-owned wiring from a live turn into its selected mode strategy. */
export async function assembleSessionPrompt(
  deps: SessionPromptAssemblyDeps,
  chatId: ChatId,
  branchId?: ChatBranchId,
  options?: SessionPromptAssemblyOptions,
): Promise<ChatModeAssembleResult> {
  const strategy = await deps.resolveChatModeStrategy(chatId);
  const profile = strategy.mode === "rp" ? await deps.getActiveProviderProfile() : null;
  const model = options?.model ?? SYSTEM_RESOURCE_ID.unresolvedModel;
  const loreDelegate = await deps.buildLoreDelegate();
  const trackerDelegate = await deps.buildTrackerDelegate();
  const loreEntityLookup = deps.createLoreEntityLookup();
  const contextSearchSession = deps.buildContextSearchSession(chatId);
  return strategy.assemble({
    promptService: deps.promptService,
    db: deps.stores?.db,
    loaders: deps.buildChatModeLoaders(),
    loreDelegate,
    trackerDelegate,
    loreEntityLookup,
    contextSearchSession,
    chatId,
    branchId,
    model,
    excludeMessageIds: options?.excludeMessageIds,
    recentMessageLimit: options?.recentMessageLimit,
    summary: options?.summary,
    dryRun: options?.dryRun,
    contextBudget: options?.contextBudget ?? null,
    responseReserve: options?.responseReserve,
    presetId: options?.presetId,
    priorSummaries: options?.priorSummaries,
    coauthorEditorState: options?.coauthorEditorState,
    providerGenerationFormat: profile?.generationFormat ?? null,
  });
}
