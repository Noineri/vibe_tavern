import type {
  PromptAssemblyContext,
  PromptAssemblyResult,
  PromptLayer,
  PromptLayerPosition,
  RecentMessage,
} from "./types.js";
import { estimateTokens, findSafeCompactionBoundary } from "./compaction.js";
import { createPhaseOneMacroEngine } from "./macro-registry.js";
import { buildPromptVariableContext, type PromptVariableContext } from "./prompt-variable-context.js";
import {
  DEFAULT_PROMPT_LAYER_PRIORITY,
  PROMPT_FORMAT,
  PROMPT_LAYER_ID,
  PROMPT_LAYER_POSITION_RANK,
  PROMPT_LAYER_PRIORITY,
  PROMPT_LAYER_REASON,
  PROMPT_LAYER_SOURCE_ID,
  PROMPT_LAYER_SOURCE_TYPE,
  createLoreLayerId,
  createRetrievalMemoryLayerId,
  createSummaryMemoryLayerId,
} from "./prompt-layer-constants.js";

function joinNonEmpty(parts: Array<string | null | undefined>, separator = "\n"): string {
  return parts.map((part) => part?.trim() ?? "").filter(Boolean).join(separator);
}

function formatRecentMessages(messages: RecentMessage[]): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content.trim()}`)
    .join("\n\n");
}

function makeLayer(input: {
  id: string;
  sourceType: string;
  sourceId: string;
  position?: PromptLayerPosition;
  priority?: number;
  enabled?: boolean;
  reason?: string;
  text: string;
}): PromptLayer {
  return {
    id: input.id,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    position: input.position ?? "in_prompt",
    priority: input.priority ?? DEFAULT_PROMPT_LAYER_PRIORITY,
    enabled: input.enabled ?? true,
    reason: input.reason ?? PROMPT_LAYER_REASON.included,
    tokenCount: estimateTokens(input.text),
    text: input.text.trim(),
  };
}

function sortLayers(layers: PromptLayer[]): PromptLayer[] {
  return [...layers].sort((a, b) => {
    const posDiff = PROMPT_LAYER_POSITION_RANK[a.position] - PROMPT_LAYER_POSITION_RANK[b.position];
    if (posDiff !== 0) return posDiff;
    return b.priority - a.priority;
  });
}

const phaseOneMacroEngine = createPhaseOneMacroEngine();

function buildAssemblyVariableContext(context: PromptAssemblyContext): PromptVariableContext {
  return buildPromptVariableContext({
    character: {
      name: context.character.name,
      description: context.character.description,
      personality: context.character.personality ?? null,
      scenario: context.character.scenario ?? null,
      systemPrompt: context.character.systemPrompt ?? null,
      mesExample: context.mesExample ?? null,
      postHistoryInstructions: context.postHistoryInstructions ?? null,
    },
    persona: {
      name: context.persona?.name ?? "User",
      description: context.persona?.description ?? "",
    },
    prompt: {
      system: context.promptPreset?.text ?? "",
      jailbreak: context.promptPreset?.jailbreak ?? "",
      summary: context.promptPreset?.summary ?? "",
      tools: context.promptPreset?.tools ?? context.toolInstructions ?? "",
      contextBudget: context.contextBudget ?? null,
    },
    chat: {
      messages: context.recentMessages,
      messageIds: context.recentMessages.map((message) => message.id),
    },
    runtime: {
      contextBudget: context.contextBudget ?? null,
      maxPromptTokens: context.contextBudget ?? null,
    },
  });
}

function applyMacros(text: string | null | undefined, variableContext: PromptVariableContext): string {
  return text ? phaseOneMacroEngine.resolve(text, variableContext) : "";
}

function applyMacrosToContext(context: PromptAssemblyContext): PromptAssemblyContext {
  const variableContext = buildAssemblyVariableContext(context);
  return {
    ...context,
    character: {
      ...context.character,
      description: applyMacros(context.character.description, variableContext),
      scenario: context.character.scenario != null ? applyMacros(context.character.scenario, variableContext) : context.character.scenario,
      systemPrompt: context.character.systemPrompt != null ? applyMacros(context.character.systemPrompt, variableContext) : context.character.systemPrompt,
      personality: context.character.personality != null ? applyMacros(context.character.personality, variableContext) : context.character.personality,
    },
    persona: context.persona ? {
      ...context.persona,
      description: applyMacros(context.persona.description, variableContext),
    } : context.persona,
    promptPreset: context.promptPreset ? {
      ...context.promptPreset,
      text: applyMacros(context.promptPreset.text, variableContext),
      jailbreak: context.promptPreset.jailbreak != null ? applyMacros(context.promptPreset.jailbreak, variableContext) : context.promptPreset.jailbreak,
      summary: context.promptPreset.summary != null ? applyMacros(context.promptPreset.summary, variableContext) : context.promptPreset.summary,
      tools: context.promptPreset.tools != null ? applyMacros(context.promptPreset.tools, variableContext) : context.promptPreset.tools,
    } : context.promptPreset,
    activeLoreEntries: context.activeLoreEntries?.map((entry) => ({
      ...entry,
      title: applyMacros(entry.title, variableContext),
      content: applyMacros(entry.content, variableContext),
    })),
    summaryMemory: context.summaryMemory?.map((s) => ({
      ...s,
      summary: applyMacros(s.summary, variableContext),
    })),
    retrievalMemory: context.retrievalMemory?.map((m) => ({
      ...m,
      content: applyMacros(m.content, variableContext),
    })),
    recentMessages: context.recentMessages.map((msg) => ({
      ...msg,
      content: applyMacros(msg.content, variableContext),
    })),
    mesExample: context.mesExample != null ? applyMacros(context.mesExample, variableContext) : context.mesExample,
    postHistoryInstructions: context.postHistoryInstructions != null ? applyMacros(context.postHistoryInstructions, variableContext) : context.postHistoryInstructions,
    toolInstructions: context.toolInstructions != null ? applyMacros(context.toolInstructions, variableContext) : context.toolInstructions,
  };
}

export function assemblePrompt(rawContext: PromptAssemblyContext): PromptAssemblyResult {
  const context = applyMacrosToContext(rawContext);
  const layers: PromptLayer[] = [];
  const droppedLayers: Array<{ id: string; reason: string }> = [];

  if (context.promptPreset?.text?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.promptPresetSystem,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
        sourceId: context.promptPreset.id,
        priority: PROMPT_LAYER_PRIORITY.promptPresetSystem,
        text: context.promptPreset.text,
      }),
    );
  }

  if (context.promptPreset?.jailbreak?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.promptPresetJailbreak,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
        sourceId: context.promptPreset.id,
        priority: PROMPT_LAYER_PRIORITY.promptPresetJailbreak,
        text: context.promptPreset.jailbreak,
      }),
    );
  }

  if (context.promptPreset?.summary?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.promptPresetSummary,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
        sourceId: context.promptPreset.id,
        priority: PROMPT_LAYER_PRIORITY.promptPresetSummary,
        text: context.promptPreset.summary,
      }),
    );
  }

  if (context.character.systemPrompt?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.characterSystemPrompt,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.characterSystemPrompt,
        sourceId: context.character.id,
        priority: PROMPT_LAYER_PRIORITY.characterSystemPrompt,
        text: context.character.systemPrompt,
      }),
    );
  }

  const characterBase = joinNonEmpty([
    PROMPT_FORMAT.characterHeader(context.character.name),
    context.character.description,
    context.character.scenario ? PROMPT_FORMAT.scenarioHeader(context.character.scenario) : null,
  ]);
  if (characterBase) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.characterBase,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
        sourceId: context.character.id,
        priority: PROMPT_LAYER_PRIORITY.characterBase,
        text: characterBase,
      }),
    );
  }

  if (context.character.personality?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.characterPersonality,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
        sourceId: context.character.id,
        priority: PROMPT_LAYER_PRIORITY.characterPersonality,
        text: context.character.personality,
      }),
    );
  }

  if (context.persona?.description?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.persona,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.persona,
        sourceId: context.persona.id,
        priority: PROMPT_LAYER_PRIORITY.persona,
        text: PROMPT_FORMAT.personaBlock(context.persona.name, context.persona.description),
      }),
    );
  }

  for (const loreEntry of [...(context.activeLoreEntries ?? [])].sort((a, b) => b.priority - a.priority)) {
    if (!loreEntry.content.trim()) {
      droppedLayers.push({ id: loreEntry.id, reason: PROMPT_LAYER_REASON.emptyLoreContent });
      continue;
    }
    layers.push(
      makeLayer({
        id: createLoreLayerId(loreEntry.id),
        sourceType: PROMPT_LAYER_SOURCE_TYPE.loreEntry,
        sourceId: loreEntry.id,
        position: loreEntry.position ?? "in_prompt",
        priority: loreEntry.priority,
        reason: PROMPT_LAYER_REASON.activatedLoreEntry,
        text: joinNonEmpty([loreEntry.title ? PROMPT_FORMAT.loreHeader(loreEntry.title) : null, loreEntry.content]),
      }),
    );
  }

  for (const memory of context.summaryMemory ?? []) {
    if (!memory.summary.trim()) {
      droppedLayers.push({ id: memory.id, reason: PROMPT_LAYER_REASON.emptySummaryMemory });
      continue;
    }
    layers.push(
      makeLayer({
        id: createSummaryMemoryLayerId(memory.id),
        sourceType: PROMPT_LAYER_SOURCE_TYPE.summaryMemory,
        sourceId: memory.id,
        priority: PROMPT_LAYER_PRIORITY.summaryMemory,
        text: PROMPT_FORMAT.summaryMemory(memory.kind, memory.summary),
      }),
    );
  }

  for (const memory of [...(context.retrievalMemory ?? [])].sort((a, b) => b.score - a.score)) {
    if (!memory.content.trim()) {
      droppedLayers.push({ id: memory.id, reason: PROMPT_LAYER_REASON.emptyRetrievalMemory });
      continue;
    }
    layers.push(
      makeLayer({
        id: createRetrievalMemoryLayerId(memory.id),
        sourceType: PROMPT_LAYER_SOURCE_TYPE.retrievalMemory,
        sourceId: memory.id,
        priority: PROMPT_LAYER_PRIORITY.retrievalMemory,
        text: PROMPT_FORMAT.retrievalMemory(memory.sourceType, memory.content),
      }),
    );
  }

  if (context.toolInstructions?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.toolInstructions,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.toolProfile,
        sourceId: PROMPT_LAYER_SOURCE_ID.activeToolProfile,
        priority: PROMPT_LAYER_PRIORITY.toolInstructions,
        text: context.toolInstructions,
      }),
    );
  }

  let recentMessagesForHistory = context.recentMessages;

  if (
    typeof context.contextBudget === "number" &&
    context.contextBudget > 0 &&
    context.recentMessages.length > 3
  ) {
    const nonHistoryTokens = layers.reduce((sum, layer) => sum + layer.tokenCount, 0);
    const fullHistoryTokens = estimateTokens(formatRecentMessages(context.recentMessages));
    const totalBeforeCompaction = nonHistoryTokens + fullHistoryTokens;

    if (totalBeforeCompaction > context.contextBudget) {
      const preserveCount = Math.max(2, Math.ceil(context.recentMessages.length / 2));
      const keepFrom = findSafeCompactionBoundary(
        context.recentMessages as unknown as Parameters<typeof findSafeCompactionBoundary>[0],
        preserveCount,
      );
      if (keepFrom > 0) {
        recentMessagesForHistory = context.recentMessages.slice(keepFrom);
        const preservedTokens = estimateTokens(formatRecentMessages(recentMessagesForHistory));
        const droppedCount = context.recentMessages.length - recentMessagesForHistory.length;
        layers.push(
          makeLayer({
            id: PROMPT_LAYER_ID.preflightCompaction,
            sourceType: PROMPT_LAYER_SOURCE_TYPE.compaction,
            sourceId: PROMPT_LAYER_SOURCE_ID.preflight,
            priority: PROMPT_LAYER_PRIORITY.preflightCompaction,
            reason: PROMPT_LAYER_REASON.preflightCompaction(droppedCount),
            text:
              `[Preflight compaction] Kept ${recentMessagesForHistory.length} of ` +
              `${context.recentMessages.length} recent messages ` +
              `(~${preservedTokens} tokens after compaction, ` +
              `${totalBeforeCompaction} tokens before, budget ${context.contextBudget}).`,
          }),
        );
      }
    }
  }

  const historyText = formatRecentMessages(recentMessagesForHistory);
  if (historyText) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.recentHistory,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.chatHistory,
        sourceId: context.chatId,
        priority: PROMPT_LAYER_PRIORITY.recentHistory,
        text: historyText,
      }),
    );
  }

  if (context.mesExample?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.mesExample,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
        sourceId: context.character.id,
        priority: PROMPT_LAYER_PRIORITY.mesExample,
        text: PROMPT_FORMAT.exampleMessages(context.mesExample),
      }),
    );
  }

  if (context.postHistoryInstructions?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.postHistoryInstructions,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
        sourceId: context.character.id,
        priority: PROMPT_LAYER_PRIORITY.postHistoryInstructions,
        text: context.postHistoryInstructions,
      }),
    );
  }

  const orderedLayers = sortLayers(layers).filter((layer) => layer.text.length > 0);
  const totalTokenEstimate = orderedLayers.reduce((sum, layer) => sum + layer.tokenCount, 0);

  const nonHiddenLayers = orderedLayers.filter(
    (layer) => layer.position !== "hidden_system" && layer.sourceType !== PROMPT_LAYER_SOURCE_TYPE.chatHistory,
  );
  const beforePrompt = nonHiddenLayers.filter((l) => l.position === "before_prompt");
  const inPrompt = nonHiddenLayers.filter((l) => l.position === "in_prompt");
  const inChat = nonHiddenLayers.filter((l) => l.position === "in_chat");

  return {
    layers: orderedLayers,
    totalTokenEstimate,
    activatedLoreEntries: (context.activeLoreEntries ?? []).map((entry) => entry.id),
    usedMemoryBlocks: [
      ...(context.summaryMemory ?? []).map((entry) => entry.id),
      ...(context.retrievalMemory ?? []).map((entry) => entry.id),
    ],
    droppedLayers,
    finalPayload: {
      messages: [
        ...beforePrompt.map((layer) => ({
          role: "system" as const,
          content: layer.text,
          layerId: layer.id,
        })),
        ...inPrompt.map((layer) => ({
          role: "system" as const,
          content: layer.text,
          layerId: layer.id,
        })),
        ...inChat.map((layer) => ({
          role: "system" as const,
          content: layer.text,
          layerId: layer.id,
        })),
        ...recentMessagesForHistory.map((message) => ({
          role: message.role,
          content: message.content,
          messageId: message.id,
        })),
      ],
    },
  };
}
