import type {
  PromptAssemblyContext,
  PromptAssemblyResult,
  PromptLayer,
  PromptLayerPosition,
  RecentMessage,
} from "./types.js";
import { findSafeCompactionBoundary } from "./compaction.js";
import { replaceMacros, type MacroContext } from "./macros.js";

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
    priority: input.priority ?? 0,
    enabled: input.enabled ?? true,
    reason: input.reason ?? "included",
    tokenCount: estimateTokens(input.text),
    text: input.text.trim(),
  };
}

const POSITION_RANK: Record<PromptLayerPosition, number> = {
  before_prompt: 0,
  in_prompt: 1,
  in_chat: 2,
  hidden_system: 3,
};

function sortLayers(layers: PromptLayer[]): PromptLayer[] {
  return [...layers].sort((a, b) => {
    const posDiff = POSITION_RANK[a.position] - POSITION_RANK[b.position];
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
    systemPreset: context.systemPreset ? {
      ...context.systemPreset,
      text: applyMacros(context.systemPreset.text, mc),
    } : context.systemPreset,
    activeLoreEntries: context.activeLoreEntries?.map((entry) => ({
      ...entry,
      title: applyMacros(entry.title, mc),
      content: applyMacros(entry.content, mc),
    })),
    generationRules: context.generationRules?.map((rule) => ({
      ...rule,
      title: applyMacros(rule.title, mc),
      content: applyMacros(rule.content, mc),
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
    outputConstraints: context.outputConstraints != null ? applyMacros(context.outputConstraints, mc) : context.outputConstraints,
  };
}

export function assemblePrompt(rawContext: PromptAssemblyContext): PromptAssemblyResult {
  const context = applyMacrosToContext(rawContext);
  const layers: PromptLayer[] = [];
  const droppedLayers: Array<{ id: string; reason: string }> = [];

  if (context.systemPreset?.text?.trim()) {
    layers.push(
      makeLayer({
        id: "system_preset",
        sourceType: "system_preset",
        sourceId: context.systemPreset.id,
        priority: 1000,
        text: context.systemPreset.text,
      }),
    );
  }

  if (context.character.systemPrompt?.trim()) {
    layers.push(
      makeLayer({
        id: "character_system_prompt",
        sourceType: "character_system_prompt",
        sourceId: context.character.id,
        priority: 950,
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
        priority: 900,
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
        priority: 890,
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
        priority: 850,
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

  for (const rule of [...(context.generationRules ?? [])].sort((a, b) => b.priority - a.priority)) {
    if (!rule.content.trim()) {
      droppedLayers.push({ id: rule.id, reason: "empty generation rule" });
      continue;
    }
    layers.push(
      makeLayer({
        id: `rule_${rule.id}`,
        sourceType: "generation_rule",
        sourceId: rule.id,
        priority: 700 + rule.priority,
        text: joinNonEmpty([rule.title ? `Rule: ${rule.title}` : null, rule.content]),
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
        priority: 500,
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
        priority: 400,
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
        priority: 300,
        text: context.toolInstructions,
      }),
    );
  }

  if (context.outputConstraints?.trim()) {
    layers.push(
      makeLayer({
        id: "output_constraints",
        sourceType: "output_constraints",
        sourceId: "output_constraints",
        priority: 200,
        text: context.outputConstraints,
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
            priority: 50,
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
        priority: 100,
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
        priority: 150,
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
        priority: 160,
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
