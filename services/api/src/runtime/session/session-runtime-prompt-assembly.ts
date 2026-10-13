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
  // Construct the lore AI-delegation callback (CTX-L2b) from Co-Author's
  // connection settings. A complete lore pair selects that connection; an
  // absent or dangling lore profile falls back to the Co-Author connection,
  // never the RP active profile.
  const loreDelegate = await deps.buildLoreDelegate();
  const trackerDelegate = await deps.buildTrackerDelegate();
  // CE-B1: lore entity lookup lets the edit / re-delegation tools target
  // previously-created (persisted) lore entities across turns, not just ones
  // drafted this turn. Built when a lorebook store is wired (production always
  // wires it); absent in minimal/test contexts — tools then report no lookup.
  const loreEntityLookup = deps.createLoreEntityLookup();
  // CE-D2: context-search session for indexed entity discovery. Lazily projects
  // canonical entities into FTS5 on first search; the next turn rebuilds it.
  const contextSearchSession = deps.buildContextSearchSession(chatId);
  return strategy.assemble({
    promptService: deps.promptService,
    // SP-5: co-author base resolves through the active service-prompt profile
    // when a db handle is reachable; minimal/test contexts fall back to the
    // bundled asset inside coauthor-prompt.
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
    // LS-10: the active profile's stored generation format; assembly resolves
    // profile-over-preset precedence and inlines custom-template selections.
    providerGenerationFormat: profile?.generationFormat ?? null,
  });
}
