import { brandId, parseStoredAttachments } from "@vibe-tavern/domain";
import type {
  AssemblePromptResponse,
  CustomInjection,
  PromptLayerDto,
  PromptOrderEntry,
} from "@vibe-tavern/domain";
import type {
  ChatBranchId,
  ChatId,
  LoreEntry,
  LoreEntryId,
  MessageId,
  PromptPresetId,
  PromptTrace,
  PromptTraceId,
  RetrievedMemoryHit,
  ActiveLoreEntry,
  ActivatedLoreDetail,
} from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import { assemblePrompt, setModelHint } from "@vibe-tavern/prompt-pipeline";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { type FileStore, STORAGE_FOLDERS } from "@vibe-tavern/db";

export interface PromptAssemblyResolver {
  getCharacter(
    characterId: string,
  ): Promise<{
    id: string;
    name: string;
    description: string;
    scenario?: string | null;
    systemPrompt?: string | null;
    personality?: string | null;
    mesExample?: string | null;
    mesExampleMode?: string | null;
    mesExampleDepth?: number | null;
    alternateGreetings?: string[];
    postHistoryInstructions?: string | null;
    depthPrompt?: string | null;
    depthPromptDepth?: number | null;
    depthPromptRole?: string | null;
    creatorNotes?: string | null;
    subtitle?: string;
    // Media (A7) — avatar/gallery appearance injection.
    avatarDescription?: string | null;
    includeAvatarInPrompt?: boolean;
    includeGalleryInPrompt?: boolean;
  }>;
  getPersona(
    personaId: string,
  ): Promise<{
      id: string;
      name: string;
      description: string;
      // Media (A7) — avatar appearance injection.
      avatarDescription?: string | null;
      includeAvatarInPrompt?: boolean;
    } | null>;
  getPromptPreset(
    presetId: string,
  ): Promise<{
      id: string;
      name: string;
      text: string;
      jailbreak: string;
      summary: string;
      tools: string;
      prefill: string;
      authorsNote: string;
      authorsNoteDepth: number;
      authorsNotePosition: string;
      authorsNoteRole: string;
      nsfw: string;
      enhanceDefinitions: string;
      /** Whether this preset is in advanced (canvas) mode. */
      advancedMode: boolean;
      customInjections: CustomInjection[];
      promptOrder: PromptOrderEntry[];
    } | null>;
  listActiveLoreEntries(input: {
    chatId: ChatId;
    branchId: ChatBranchId;
    recentText: string;
    /** Max context tokens of the active model. Needed for percent-of-context
     * token-budget mode on lorebooks. Optional — when absent, percent-mode
     * lorebooks silently fall back to their fixed `tokenBudget`. */
    maxContextTokens?: number;
  }): Promise<ActiveLoreEntry[]>;
  listRetrievedMemories(input: {
    chatId: ChatId;
    branchId: ChatBranchId;
    recentText: string;
  }): Promise<RetrievedMemoryHit[]>;
  executeScripts(input: {
    chatId: ChatId;
    characterRecord: {
      name: string;
      personality: string | null;
      scenario: string | null;
    };
    messages: Array<{ role: string; content: string }>;
    activeLoreEntries: LoreEntry[];
    mode: string;
  }): Promise<{
    personality: string;
    scenario: string;
    injectedMessages: Array<{ content: string; role: 'system' | 'user' | 'assistant' }>;
    errors: Array<{ scriptId: string; scriptName: string; error: string }>;
  }>;
  getToolInstructions(): string | null;
}

export interface AssemblePromptForChatInput {
  chatId: ChatId;
  branchId?: ChatBranchId;
  model: string;
  recentMessageLimit?: number;
  excludeMessageIds?: MessageId[];
  contextBudget?: number | null;
  /** Tokens reserved for the model's response. Subtracted from contextBudget during compaction. */
  responseReserve?: number;
  mode?: "chat" | "continue" | "regenerate" | "summary" | "tool_call";
  /**
   * Optional per-request prompt preset override (Wave Q1b). When set, the
   * assembled prompt uses this preset instead of the chat's `promptPresetId`,
   * WITHOUT mutating the chat row. Undefined → existing cascade (chat's preset →
   * global default). This is the queue's per-job preset key (frozen at enqueue).
   */
  presetId?: PromptPresetId;
}

export type PromptTraceDraft = Omit<PromptTrace, "id" | "messageId" | "createdAt"> & {
  /** Resolved prompt preset id (override → chat → global default), exported
   *  by assembly so the message-meta path records the preset each reply used. */
  presetId: string | null;
};

export interface AssemblePromptForChatResult {
  branchId: ChatBranchId;
  prompt: AssemblePromptResponse;
  promptTraceDraft: PromptTraceDraft;
}

export class PromptAssemblyService {
  constructor(
    private readonly stores: StoreContainer,
    private readonly resolver: PromptAssemblyResolver,
    private readonly fileStore: FileStore,
  ) {}

  async assembleForChat(input: AssemblePromptForChatInput): Promise<AssemblePromptForChatResult> {
    const chat = await this.stores.chats.getById(input.chatId);
    if (!chat) {
      throw new Error(`Chat '${input.chatId}' was not found.`);
    }

    const branchId = input.branchId ?? (chat.activeBranchId as ChatBranchId);
    const branches = await this.stores.chats.getBranches(chat.id);
    const branch = branches.find((b) => b.id === branchId);
    if (!branch) {
      throw new Error(`Branch '${branchId}' was not found for chat '${chat.id}'.`);
    }
    const branchMessages = await this.stores.messages.getMessages(branchId);

    const character = await this.resolver.getCharacter(chat.characterId);
    const allPersonas = await this.stores.personas.listAll();
    const effectivePersonaId = chat.personaId ?? allPersonas.find(p => p.defaultForNewChats)?.id ?? allPersonas[0]?.id ?? "";
    const persona = await this.resolver.getPersona(effectivePersonaId);
    const promptPresetId = input.presetId ?? chat.promptPresetId
      ?? (await this.stores.presets.listAll()).find(p => !p.bindProviderPresetId)?.id;
    const promptPreset = promptPresetId ? await this.resolver.getPromptPreset(promptPresetId) : null;

    logSendDebug("prompt.assemble.context", {
      chatId: chat.id as ChatId,
      personaId: chat.personaId ?? "(default)",
      personaResolved: persona ? { id: persona.id, name: persona.name, descLength: persona.description.length } : null,
      promptPresetId: chat.promptPresetId,
      promptPresetResolved: promptPreset ? { id: promptPreset.id, name: promptPreset.name, systemLength: promptPreset.text.length } : null,
    });
    const excludedMessageIds = new Set(input.excludeMessageIds ?? []);
    const branchSummaries = input.mode === "summary"
      ? []
      : await this.stores.chatSummaries.listByChatBranch(chat.id, branchId);
    const enabledSummaries = branchSummaries.filter((summary) => summary.includeInContext && summary.content.trim());
    const excludedRanges = branchSummaries
      .filter((summary) => summary.includeInContext && summary.excludeSummarized && summary.summarizedTo >= summary.summarizedFrom)
      .map((summary) => ({ from: summary.summarizedFrom, to: summary.summarizedTo }));
    const isInExcludedSummaryRange = (position: number) => {
      const oneBasedPosition = position + 1;
      return excludedRanges.some((range) => oneBasedPosition >= range.from && oneBasedPosition <= range.to);
    };
    const filteredMessages = branchMessages.filter((message) =>
      !excludedMessageIds.has(message.id as MessageId) && !isInExcludedSummaryRange(message.position),
    );
    // Always keep the last user message (needed for send/regenerate)
    const lastUserMsg = [...branchMessages].reverse().find(m => m.role === 'user');
    const ensureLastUser = lastUserMsg && !filteredMessages.some(m => m.id === lastUserMsg.id)
      ? [...filteredMessages, lastUserMsg]
      : filteredMessages;
    const messageLimit = input.recentMessageLimit ?? (chat.messageHistoryLimit || Infinity);
    const recentMessages = ensureLastUser
      .slice(-(messageLimit === Infinity ? ensureLastUser.length : messageLimit))
      .map((message) => ({
        id: message.id as MessageId,
        role: message.role as 'system' | 'user' | 'assistant' | 'tool',
        content: message.content,
        ...(message.attachmentsJson ? { attachments: parseStoredAttachments(message.attachmentsJson) ?? [] } : {}),
      }));

    const recentText = recentMessages.map((message) => message.content).join("\n");
    const activeLoreEntries = await this.resolver.listActiveLoreEntries({
      chatId: chat.id as ChatId,
      branchId,
      recentText,
      maxContextTokens: input.contextBudget ?? undefined,
    });
    const retrievedMemories = await this.resolver.listRetrievedMemories({
      chatId: chat.id as ChatId,
      branchId,
      recentText,
    });

    // Execute scripts AFTER lore activation, BEFORE prompt assembly.
    // Scripts can read active lore entries and mutate character fields.
    // Token estimation in makeLayer() will reflect post-script text.
    const scriptResult = await this.resolver.executeScripts({
      chatId: chat.id as ChatId,
      characterRecord: {
        name: character.name,
        personality: character.personality ?? null,
        scenario: character.scenario ?? null,
      },
      messages: recentMessages.map(m => ({ role: m.role, content: m.content })),
      activeLoreEntries,
      mode: input.mode ?? 'chat',
    });

    // Apply script mutations to character fields in-place
    const mutatedPersonality = scriptResult.personality;
    const mutatedScenario = scriptResult.scenario;

    // Set model hint so estimateTokens uses the model-specific tokenizer
    setModelHint(input.model);

    // ─── A7: media context — gallery descriptions (one read). Pre-filter to
    // described rows the user explicitly selected for inclusion (D7): per-image
    // includeInPrompt is the sole gate now (the deprecated character-level
    // includeGalleryInPrompt field is no longer read). Undescribed images
    // carry no prompt value, and includeInPrompt defaults OFF so a gallery
    // only injects what the user opts in per-image.
    const gallery = (await this.stores.characterAssets.listByCharacter(character.id))
        .filter((row) => row.description?.trim() && row.includeInPrompt)
        .map((row) => ({ caption: row.caption || `gallery-${row.id}`, description: row.description!.trim() }));

    const result = assemblePrompt({
      identity: {
        chatId: chat.id as ChatId,
      },
      character: {
        id: character.id,
        name: character.name,
        description: character.description,
        scenario: mutatedScenario,
        systemPrompt: character.systemPrompt,
        personality: mutatedPersonality,
        mesExample: character.mesExample,
        mesExampleMode: (character.mesExampleMode as "always" | "once" | "depth") ?? "always",
        mesExampleDepth: character.mesExampleDepth ?? 4,
        postHistoryInstructions: character.postHistoryInstructions,
        depthPrompt: character.depthPrompt,
        depthPromptDepth: character.depthPromptDepth,
        depthPromptRole: (character.depthPromptRole as "system" | "user" | "assistant") ?? "system",
        // Media (A7) — avatar/gallery appearance text injection.
        avatarDescription: character.avatarDescription,
        includeAvatarInPrompt: character.includeAvatarInPrompt,
        gallery,
        includeGalleryInPrompt: character.includeGalleryInPrompt,
      },
      persona,
      preset: promptPreset
        ? {
            id: promptPreset.id,
            name: promptPreset.name,
            text: promptPreset.text,
            jailbreak: promptPreset.jailbreak,
            summary: promptPreset.summary,
            tools: promptPreset.tools,
            prefill: promptPreset.prefill,
            authorsNote: promptPreset.authorsNote,
            authorsNoteDepth: promptPreset.authorsNoteDepth,
            authorsNotePosition: (promptPreset.authorsNotePosition as "in_prompt" | "in_chat" | "after_chat") ?? "in_chat",
            authorsNoteRole: (promptPreset.authorsNoteRole as "system" | "user" | "assistant") ?? "system",
            nsfw: promptPreset.nsfw,
            enhanceDefinitions: promptPreset.enhanceDefinitions,
            advancedMode: promptPreset.advancedMode,
            customInjections: promptPreset.customInjections,
            promptOrder: promptPreset.promptOrder,
          }
        : null,
      mode: input.mode,
      lore: activeLoreEntries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        content: entry.content,
        priority: entry.priority,
        position: entry.position,
        depth: entry.depth,
        role: entry.role,
        sortOrder: entry.sortOrder,
      })),
      memory: {
        summary: enabledSummaries.length > 0
          ? enabledSummaries.map((summary) => ({ id: summary.id, kind: summary.source, summary: summary.content }))
          : (chat.summary?.trim() ? [{ id: `chat_summary_${chat.id}`, kind: "chat", summary: chat.summary }] : []),
        retrieval: retrievedMemories.map((memory) => ({
          id: memory.id,
          sourceType: memory.sourceType,
          content: memory.content,
          score: memory.score,
        })),
      },
      chat: {
        recentMessages,
        scriptInjections: scriptResult.injectedMessages,
      },
      instructions: {
        toolInstructions: [promptPreset?.tools, this.resolver.getToolInstructions()].filter(Boolean).join("\n") || null,
      },
      config: {
        contextBudget: input.contextBudget ?? null,
        responseReserve: input.responseReserve ?? 0,
        model: input.model,
      },
    });

    // Build script injection trace data
    const scriptInjections = scriptResult.errors.length > 0 ||
      scriptResult.personality !== (character.personality ?? '') ||
      scriptResult.scenario !== (character.scenario ?? '') ||
      scriptResult.injectedMessages.length > 0
      ? [{
          scriptId: '__pipeline',
          scriptName: 'Script Pipeline',
          personalityMutation: scriptResult.personality !== (character.personality ?? '') ? scriptResult.personality : '',
          scenarioMutation: scriptResult.scenario !== (character.scenario ?? '') ? scriptResult.scenario : '',
          injectedMessages: scriptResult.injectedMessages,
          error: scriptResult.errors.length > 0 ? scriptResult.errors.map(e => `${e.scriptName}: ${e.error}`).join('; ') : undefined,
        }]
      : [];

    // Per-entry activation reasons for the prompt trace (parallel to
    // activatedLoreEntries; same ids in activation order). Built from the
    // enriched resolver result so the trace UI can show WHY each fired.
    const activatedLoreDetail: ActivatedLoreDetail[] = activeLoreEntries.map((entry) => ({
      id: entry.id as string,
      title: entry.title,
      reason: entry.activationReason,
    }));

    return {
      branchId,
      prompt: {
        layers: result.layers.map(mapPromptLayerDto),
        tokenAccounting: {
          total: result.totalTokenEstimate,
          recentHistory: recentMessages.length,
        },
        activatedLoreEntries: result.activatedLoreEntries,
        activatedLoreDetail,
        scriptInjections,
        retrievedMemories: retrievedMemories.map((memory) => ({
          id: memory.id,
          sourceType: memory.sourceType,
          score: memory.score,
          sourceId: memory.sourceId,
        })),
        finalPayload: result.finalPayload,
        prefill: result.prefill,
      },
      promptTraceDraft: {
        chatId: chat.id as ChatId,
        branchId: branchId as ChatBranchId,
        model: input.model,
        presetName: promptPreset?.name ?? chat.promptPresetId ?? "(none)",
        // The fully-resolved preset id (override → chat → global default; see
        // the cascade above). Carried out of assembly so the message-meta path
        // can record on each reply the preset that was ACTUALLY used — not just
        // presetName for the trace. Read by ChatRuntime.appendAssistantReply /
        // appendMessageVariant to populate messages/variants.presetId.
        presetId: promptPresetId ?? null,
        assembledLayers: result.layers.map((layer) => mapPromptLayerDto(layer)),
        tokenAccounting: {
          total: result.totalTokenEstimate,
        },
        activatedLoreEntries: result.activatedLoreEntries.map((id) => brandId<LoreEntryId>(id)),
        activatedLoreDetail,
        scriptInjections,
        retrievedMemories: retrievedMemories.map((memory) => ({
          id: memory.id,
          sourceType: memory.sourceType,
          sourceId: memory.sourceId,
          score: memory.score,
          matchedKeys: memory.matchedKeys,
        })),
        finalPayload: result.finalPayload,
        latencyMs: 0,
        prefill: result.prefill,
        compactionSummary: result.compactionSummary,
      },
    };
  }

  async exportTraceToFile(traceId: string): Promise<string> {
    const trace = await this.stores.traces.getTrace(traceId);
    if (!trace) {
      throw new Error(`Prompt trace '${traceId}' was not found.`);
    }
    // data/traces/{yyyy-mm-dd}/{promptTraceId}.json
    const date = trace.createdAt.split("T")[0];
    const filePath = this.fileStore.resolvePath(
      STORAGE_FOLDERS.traces,
      `${date}/${traceId}.json`,
    );
    await this.fileStore.writeJson(filePath, trace);
    return filePath;
  }
}

function mapPromptLayerDto(layer: {
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
}): PromptLayerDto {
  return {
    id: layer.id,
    sourceType: layer.sourceType,
    sourceId: layer.sourceId,
    sourceName: layer.sourceName,
    position: layer.position,
    priority: layer.priority,
    enabled: layer.enabled,
    reason: layer.reason,
    tokenCount: layer.tokenCount,
    text: layer.text,
    injectionDepth: layer.injectionDepth,
    modes: layer.modes,
  };
}
