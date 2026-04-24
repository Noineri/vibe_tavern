import type { AssemblePromptResponse, PromptLayerDto } from "@rp-platform/api-contracts";
import type {
  ChatBranchId,
  ChatId,
  GenerationRule,
  LoreEntry,
  MessageId,
  PromptTrace,
  RetrievedMemoryHit,
} from "@rp-platform/domain";
import type { ChatSessionStore } from "@rp-platform/db";
import { assemblePrompt } from "@rp-platform/prompt-pipeline";

export interface PromptAssemblyResolver {
  getCharacter(
    characterId: string,
  ): {
    id: string;
    name: string;
    description: string;
    scenario?: string | null;
    systemPrompt?: string | null;
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
  getGenerationPreset(
    presetId: string,
  ):
    | {
        id: string;
        text: string;
      }
    | null;
  listGenerationRules(chatId: ChatId): GenerationRule[];
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
  outputConstraints?: string | null;
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
    const persona = this.resolver.getPersona(chat.personaId);
    const systemPreset = this.resolver.getGenerationPreset(chat.generationPresetId);
    const generationRules = this.resolver.listGenerationRules(chat.id);
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
      chatId: chat.id,
      character,
      persona,
      systemPreset,
      activeLoreEntries: activeLoreEntries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        content: entry.content,
        priority: entry.priority,
        position: entry.position,
      })),
      generationRules: generationRules.map((rule) => ({
        id: rule.id,
        title: rule.title,
        content: rule.content,
        priority: rule.priority,
      })),
      summaryMemory: branchState.summaries.map((snapshot) => ({
        id: snapshot.id,
        kind: snapshot.kind,
        summary: snapshot.summary,
      })),
      retrievalMemory: retrievedMemories.map((memory) => ({
        id: memory.id,
        sourceType: memory.sourceType,
        content: memory.content,
        score: memory.score,
      })),
      recentMessages,
      toolInstructions: this.resolver.getToolInstructions(chat.toolProfileId),
      outputConstraints: input.outputConstraints ?? null,
      contextBudget: input.contextBudget ?? null,
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
        presetName: systemPreset?.id ?? chat.generationPresetId,
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
