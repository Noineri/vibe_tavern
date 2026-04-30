import type { AssemblePromptResponse, PromptLayerDto } from "@rp-platform/api-contracts";
import type {
  ChatBranchId,
  ChatId,
  LoreEntry,
  MessageId,
  PromptTrace,
  PromptTraceId,
  RetrievedMemoryHit,
} from "@rp-platform/domain";
import type { ChatSessionStore } from "@rp-platform/db";
import { assemblePrompt } from "@rp-platform/prompt-pipeline";
import { logSendDebug } from "./send-debug-log.js";
import { createFileStore, STORAGE_FOLDERS } from "@rp-platform/db";

export interface PromptAssemblyResolver {
  getCharacter(
    characterId: string,
  ): {
    id: string;
    name: string;
    description: string;
    scenario?: string | null;
    systemPrompt?: string | null;
    personality?: string | null;
    mesExample?: string | null;
    alternateGreetings?: string[];
    postHistoryInstructions?: string | null;
    creatorNotes?: string | null;
    subtitle?: string;
  };
  getPersona(
    personaId: string,
  ):
    | {
        id: string;
        name: string;
        description: string;
      }
    | null;
  getPromptPreset(
    presetId: string,
  ):
    | {
        id: string;
        name: string;
        text: string;
        jailbreak: string;
        summary: string;
        tools: string;
      }
    | null;
  listActiveLoreEntries(input: {
    chatId: ChatId;
    branchId: ChatBranchId;
    recentText: string;
  }): LoreEntry[];
  listRetrievedMemories(input: {
    chatId: ChatId;
    branchId: ChatBranchId;
    recentText: string;
  }): RetrievedMemoryHit[];
  getToolInstructions(toolProfileId: string): string | null;
}

export interface AssemblePromptForChatInput {
  chatId: ChatId;
  branchId?: ChatBranchId;
  model: string;
  recentMessageLimit?: number;
  excludeMessageIds?: MessageId[];
  contextBudget?: number | null;
}

export interface AssemblePromptForChatResult {
  branchId: ChatBranchId;
  prompt: AssemblePromptResponse;
  promptTraceDraft: Omit<PromptTrace, "id" | "messageId" | "createdAt">;
}

export class PromptAssemblyService {
  constructor(
    private readonly store: ChatSessionStore,
    private readonly resolver: PromptAssemblyResolver,
  ) {}

  assembleForChat(input: AssemblePromptForChatInput): AssemblePromptForChatResult {
    const chat = this.store.getChat(input.chatId);
    if (!chat) {
      throw new Error(`Chat '${input.chatId}' was not found.`);
    }

    const branchId = input.branchId ?? chat.activeBranchId;
    const branchState = this.store.getBranchState(chat.id, branchId);
    if (!branchState) {
      throw new Error(`Branch '${branchId}' was not found for chat '${chat.id}'.`);
    }

    const character = this.resolver.getCharacter(chat.characterId);
    const effectivePersonaId = chat.personaId ?? this.store.listPersonas().find(p => p.defaultForNewChats)?.id ?? this.store.listPersonas()[0]?.id ?? "";
    const persona = this.resolver.getPersona(effectivePersonaId);
    const promptPreset = this.resolver.getPromptPreset(chat.promptPresetId);

    logSendDebug("prompt.assemble.context", {
      chatId: chat.id,
      personaId: chat.personaId ?? "(default)",
      personaResolved: persona ? { id: persona.id, name: persona.name, descLength: persona.description.length } : null,
      promptPresetId: chat.promptPresetId,
      promptPresetResolved: promptPreset ? { id: promptPreset.id, name: promptPreset.name, systemLength: promptPreset.text.length } : null,
    });
    const excludedMessageIds = new Set(input.excludeMessageIds ?? []);
    const recentMessages = branchState.messages
      .filter((message) => !excludedMessageIds.has(message.id))
      .slice(-(input.recentMessageLimit ?? 12))
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
      }));
    const recentText = recentMessages.map((message) => message.content).join("\n");
    const activeLoreEntries = this.resolver.listActiveLoreEntries({
      chatId: chat.id,
      branchId,
      recentText,
    });
    const retrievedMemories = this.resolver.listRetrievedMemories({
      chatId: chat.id,
      branchId,
      recentText,
    });

    const result = assemblePrompt({
      identity: {
        chatId: chat.id,
      },
      character: {
        id: character.id,
        name: character.name,
        description: character.description,
        scenario: character.scenario,
        systemPrompt: character.systemPrompt,
        personality: character.personality,
        mesExample: character.mesExample,
        postHistoryInstructions: character.postHistoryInstructions,
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
          }
        : null,
      lore: activeLoreEntries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        content: entry.content,
        priority: entry.priority,
        position: entry.position,
      })),
      memory: {
        summary: branchState.summaries.map((snapshot) => ({
          id: snapshot.id,
          kind: snapshot.kind,
          summary: snapshot.summary,
        })),
        retrieval: retrievedMemories.map((memory) => ({
          id: memory.id,
          sourceType: memory.sourceType,
          content: memory.content,
          score: memory.score,
        })),
      },
      chat: {
        recentMessages,
      },
      instructions: {
        toolInstructions: [promptPreset?.tools, this.resolver.getToolInstructions(chat.toolProfileId)].filter(Boolean).join("\n") || null,
      },
      config: {
        contextBudget: input.contextBudget ?? null,
      },
    });

    return {
      branchId,
      prompt: {
        layers: result.layers.map(mapPromptLayerDto),
        tokenAccounting: {
          total: result.totalTokenEstimate,
          recentHistory: recentMessages.length,
        },
        activatedLoreEntries: result.activatedLoreEntries,
        retrievedMemories: retrievedMemories.map((memory) => ({
          id: memory.id,
          sourceType: memory.sourceType,
          score: memory.score,
          sourceId: memory.sourceId,
        })),
        finalPayload: result.finalPayload,
      },
      promptTraceDraft: {
        chatId: chat.id,
        branchId,
        model: input.model,
        presetName: promptPreset?.name ?? chat.promptPresetId,
        assembledLayers: result.layers.map((layer) => mapPromptLayerDto(layer)),
        tokenAccounting: {
          total: result.totalTokenEstimate,
        },
        activatedLoreEntries: result.activatedLoreEntries,
        retrievedMemories: retrievedMemories.map((memory) => ({
          id: memory.id,
          sourceType: memory.sourceType,
          sourceId: memory.sourceId,
          score: memory.score,
          matchedKeys: memory.matchedKeys,
        })),
        finalPayload: result.finalPayload,
        latencyMs: 0,
      },
    };
  }

  exportTraceToFile(traceId: string): string {
    const trace = this.store.getPromptTrace(traceId as PromptTraceId);
    if (!trace) {
      throw new Error(`Prompt trace '${traceId}' was not found.`);
    }
    // data/traces/{yyyy-mm-dd}/{promptTraceId}.json
    const date = trace.createdAt.split("T")[0];
    const fileStore = createFileStore();
    const filePath = fileStore.resolvePath(
      STORAGE_FOLDERS.traces,
      `${date}/${traceId}.json`,
    );
    fileStore.writeJson(filePath, trace);
    return filePath;
  }
}

function mapPromptLayerDto(layer: {
  id: string;
  sourceType: string;
  sourceId: string;
  position: "before_prompt" | "in_prompt" | "in_chat" | "hidden_system";
  priority: number;
  enabled: boolean;
  reason: string;
  tokenCount: number;
  text: string;
}): PromptLayerDto {
  return {
    id: layer.id,
    sourceType: layer.sourceType,
    sourceId: layer.sourceId,
    position: layer.position,
    priority: layer.priority,
    enabled: layer.enabled,
    reason: layer.reason,
    tokenCount: layer.tokenCount,
    text: layer.text,
  };
}
