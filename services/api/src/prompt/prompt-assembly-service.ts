import { brandId } from "@vibe-tavern/domain";
import type {
  AssemblePromptResponse,
  PromptLayerDto,
} from "@vibe-tavern/domain";
import type {
  ChatBranchId,
  ChatId,
  LoreEntry,
  LoreEntryId,
  MessageId,
  PromptTrace,
  PromptTraceId,
  RetrievedMemoryHit,
} from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import { assemblePrompt, setModelHint } from "@vibe-tavern/prompt-pipeline";
import { logSendDebug } from "../send-debug-log.js";
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
  }>;
  getPersona(
    personaId: string,
  ): Promise<{
      id: string;
      name: string;
      description: string;
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
      customInjections: Array<{
        identifier?: string;
        name: string;
        content: string;
        depth: number;
        role: string;
        enabled: boolean;
        injectionPosition?: 0 | 1 | "relative" | "absolute";
        injectionOrder?: number;
        promptOrderIndex?: number;
        promptOrderPlacement?: "before_chat" | "after_chat";
      }>;
    } | null>;
  listActiveLoreEntries(input: {
    chatId: ChatId;
    branchId: ChatBranchId;
    recentText: string;
  }): Promise<LoreEntry[]>;
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
}

export interface AssemblePromptForChatResult {
  branchId: ChatBranchId;
  prompt: AssemblePromptResponse;
  promptTraceDraft: Omit<PromptTrace, "id" | "messageId" | "createdAt">;
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
    const branchMessages = await this.stores.chats.getMessages(branchId);

    const character = await this.resolver.getCharacter(chat.characterId);
    const allPersonas = await this.stores.personas.listAll();
    const effectivePersonaId = chat.personaId ?? allPersonas.find(p => p.defaultForNewChats)?.id ?? allPersonas[0]?.id ?? "";
    const persona = await this.resolver.getPersona(effectivePersonaId);
    const promptPreset = await this.resolver.getPromptPreset(chat.promptPresetId);

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
      }));

    const recentText = recentMessages.map((message) => message.content).join("\n");
    const activeLoreEntries = await this.resolver.listActiveLoreEntries({
      chatId: chat.id as ChatId,
      branchId,
      recentText,
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
            customInjections: promptPreset.customInjections,
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

    return {
      branchId,
      prompt: {
        layers: result.layers.map(mapPromptLayerDto),
        tokenAccounting: {
          total: result.totalTokenEstimate,
          recentHistory: recentMessages.length,
        },
        activatedLoreEntries: result.activatedLoreEntries,
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
        presetName: promptPreset?.name ?? chat.promptPresetId,
        assembledLayers: result.layers.map((layer) => mapPromptLayerDto(layer)),
        tokenAccounting: {
          total: result.totalTokenEstimate,
        },
        activatedLoreEntries: result.activatedLoreEntries.map((id) => brandId<LoreEntryId>(id)),
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
      },
    };
  }

  async exportTraceToFile(traceId: string): Promise<string> {
    const trace = await this.stores.chats.getTrace(traceId);
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
