import type {
  PromptAssemblyContext,
  PromptAssemblyResult,
  PromptLayer,
  PromptLayerPosition,
  RecentMessage,
} from "./types.js";
import { findSafeCompactionBoundary } from "./compaction.js";
import { replaceMacros, type MacroContext } from "./macros.js";
import {
  DEFAULT_PROMPT_LAYER_PRIORITY,
  PROMPT_LAYER_POSITION_RANK,
  PROMPT_LAYER_PRIORITY,
} from "./prompt-layer-constants.js";

function estimateTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  return Math.ceil(normalized.length / 4);
}

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
    reason: input.reason ?? "included",
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

function buildMacroContext(context: PromptAssemblyContext): MacroContext {
  return {
    charName: context.character.name,
    userName: context.persona?.name ?? "User",
    personaDescription: context.persona?.description,
  };
}

function applyMacros(text: string | null | undefined, mc: MacroContext): string {
  return text ? replaceMacros(text, mc) : "";
}

function applyMacrosToContext(context: PromptAssemblyContext): PromptAssemblyContext {
  const mc = buildMacroContext(context);
  return {
    ...context,
    character: {
      ...context.character,
      description: applyMacros(context.character.description, mc),
      scenario: context.character.scenario != null ? applyMacros(context.character.scenario, mc) : context.character.scenario,
      systemPrompt: context.character.systemPrompt != null ? applyMacros(context.character.systemPrompt, mc) : context.character.systemPrompt,
      personality: context.character.personality != null ? applyMacros(context.character.personality, mc) : context.character.personality,
    },
    persona: context.persona ? {
      ...context.persona,
      description: applyMacros(context.persona.description, mc),
    } : context.persona,
    promptPreset: context.promptPreset ? {
      ...context.promptPreset,
      text: applyMacros(context.promptPreset.text, mc),
      jailbreak: context.promptPreset.jailbreak != null ? applyMacros(context.promptPreset.jailbreak, mc) : context.promptPreset.jailbreak,
      summary: context.promptPreset.summary != null ? applyMacros(context.promptPreset.summary, mc) : context.promptPreset.summary,
      tools: context.promptPreset.tools != null ? applyMacros(context.promptPreset.tools, mc) : context.promptPreset.tools,
    } : context.promptPreset,
    activeLoreEntries: context.activeLoreEntries?.map((entry) => ({
      ...entry,
      title: applyMacros(entry.title, mc),
      content: applyMacros(entry.content, mc),
    })),
    summaryMemory: context.summaryMemory?.map((s) => ({
      ...s,
      summary: applyMacros(s.summary, mc),
    })),
    retrievalMemory: context.retrievalMemory?.map((m) => ({
      ...m,
      content: applyMacros(m.content, mc),
    })),
    recentMessages: context.recentMessages.map((msg) => ({
      ...msg,
      content: applyMacros(msg.content, mc),
    })),
    mesExample: context.mesExample != null ? applyMacros(context.mesExample, mc) : context.mesExample,
    postHistoryInstructions: context.postHistoryInstructions != null ? applyMacros(context.postHistoryInstructions, mc) : context.postHistoryInstructions,
    toolInstructions: context.toolInstructions != null ? applyMacros(context.toolInstructions, mc) : context.toolInstructions,
  };
}

export function assemblePrompt(rawContext: PromptAssemblyContext): PromptAssemblyResult {
  const context = applyMacrosToContext(rawContext);
  const layers: PromptLayer[] = [];
  const droppedLayers: Array<{ id: string; reason: string }> = [];

  if (context.promptPreset?.text?.trim()) {
    layers.push(
      makeLayer({
        id: "prompt_preset_system",
        sourceType: "prompt_preset",
        sourceId: context.promptPreset.id,
        priority: PROMPT_LAYER_PRIORITY.promptPresetSystem,
        text: context.promptPreset.text,
      }),
    );
  }

  if (context.promptPreset?.jailbreak?.trim()) {
    layers.push(
      makeLayer({
        id: "prompt_preset_jailbreak",
        sourceType: "prompt_preset",
        sourceId: context.promptPreset.id,
        priority: PROMPT_LAYER_PRIORITY.promptPresetJailbreak,
        text: context.promptPreset.jailbreak,
      }),
    );
  }

  if (context.promptPreset?.summary?.trim()) {
    layers.push(
      makeLayer({
        id: "prompt_preset_summary",
        sourceType: "prompt_preset",
        sourceId: context.promptPreset.id,
        priority: PROMPT_LAYER_PRIORITY.promptPresetSummary,
        text: context.promptPreset.summary,
      }),
    );
  }

  if (context.character.systemPrompt?.trim()) {
    layers.push(
      makeLayer({
        id: "character_system_prompt",
        sourceType: "character_system_prompt",
        sourceId: context.character.id,
        priority: PROMPT_LAYER_PRIORITY.characterSystemPrompt,
        text: context.character.systemPrompt,
      }),
    );
  }

  const characterBase = joinNonEmpty([
    `Character: ${context.character.name}`,
    context.character.description,
    context.character.scenario ? `Scenario: ${context.character.scenario}` : null,
  ]);
  if (characterBase) {
    layers.push(
      makeLayer({
        id: "character_base",
        sourceType: "character",
        sourceId: context.character.id,
        priority: PROMPT_LAYER_PRIORITY.characterBase,
        text: characterBase,
      }),
    );
  }

  if (context.character.personality?.trim()) {
    layers.push(
      makeLayer({
        id: "character_personality",
        sourceType: "character",
        sourceId: context.character.id,
        priority: PROMPT_LAYER_PRIORITY.characterPersonality,
        text: context.character.personality,
      }),
    );
  }

  if (context.persona?.description?.trim()) {
    layers.push(
      makeLayer({
        id: "persona",
        sourceType: "persona",
        sourceId: context.persona.id,
        priority: PROMPT_LAYER_PRIORITY.persona,
        text: `User persona (${context.persona.name}): ${context.persona.description}`,
      }),
    );
  }

  for (const loreEntry of [...(context.activeLoreEntries ?? [])].sort((a, b) => b.priority - a.priority)) {
    if (!loreEntry.content.trim()) {
      droppedLayers.push({ id: loreEntry.id, reason: "empty lore content" });
      continue;
    }
    layers.push(
      makeLayer({
        id: `lore_${loreEntry.id}`,
        sourceType: "lore_entry",
        sourceId: loreEntry.id,
        position: loreEntry.position ?? "in_prompt",
        priority: loreEntry.priority,
        reason: "activated lore entry",
        text: joinNonEmpty([loreEntry.title ? `Lore: ${loreEntry.title}` : null, loreEntry.content]),
      }),
    );
  }

  for (const memory of context.summaryMemory ?? []) {
    if (!memory.summary.trim()) {
      droppedLayers.push({ id: memory.id, reason: "empty summary memory" });
      continue;
    }
    layers.push(
      makeLayer({
        id: `summary_${memory.id}`,
        sourceType: "summary_memory",
        sourceId: memory.id,
        priority: PROMPT_LAYER_PRIORITY.summaryMemory,
        text: `[${memory.kind}] ${memory.summary}`,
      }),
    );
  }

  for (const memory of [...(context.retrievalMemory ?? [])].sort((a, b) => b.score - a.score)) {
    if (!memory.content.trim()) {
      droppedLayers.push({ id: memory.id, reason: "empty retrieval memory" });
      continue;
    }
    layers.push(
      makeLayer({
        id: `retrieval_${memory.id}`,
        sourceType: "retrieval_memory",
        sourceId: memory.id,
        priority: PROMPT_LAYER_PRIORITY.retrievalMemory,
        text: `[Retrieved ${memory.sourceType}] ${memory.content}`,
      }),
    );
  }

  if (context.toolInstructions?.trim()) {
    layers.push(
      makeLayer({
        id: "tool_instructions",
        sourceType: "tool_profile",
        sourceId: "active_tool_profile",
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
            id: "preflight_compaction",
            sourceType: "compaction",
            sourceId: "preflight",
            priority: PROMPT_LAYER_PRIORITY.preflightCompaction,
            reason: `preflight_compaction_dropped_${droppedCount}`,
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
        id: "recent_history",
        sourceType: "chat_history",
        sourceId: context.chatId,
        priority: PROMPT_LAYER_PRIORITY.recentHistory,
        text: historyText,
      }),
    );
  }

  if (context.mesExample?.trim()) {
    layers.push(
      makeLayer({
        id: "mes_example",
        sourceType: "character",
        sourceId: context.character.id,
        priority: PROMPT_LAYER_PRIORITY.mesExample,
        text: `[Example messages]\n${context.mesExample}`,
      }),
    );
  }

  if (context.postHistoryInstructions?.trim()) {
    layers.push(
      makeLayer({
        id: "post_history_instructions",
        sourceType: "character",
        sourceId: context.character.id,
        priority: PROMPT_LAYER_PRIORITY.postHistoryInstructions,
        text: context.postHistoryInstructions,
      }),
    );
  }

  const orderedLayers = sortLayers(layers).filter((layer) => layer.text.length > 0);
  const totalTokenEstimate = orderedLayers.reduce((sum, layer) => sum + layer.tokenCount, 0);

  const nonHiddenLayers = orderedLayers.filter(
    (layer) => layer.position !== "hidden_system" && layer.sourceType !== "chat_history",
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
