import type {
  PromptAssemblyContext,
  PromptAssemblyResult,
  PromptLayer,
  PromptLayerPosition,
  RecentMessage,
} from "./types.js";

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

function sortLayers(layers: PromptLayer[]): PromptLayer[] {
  return [...layers].sort((a, b) => {
    if (a.position !== b.position) {
      return a.position.localeCompare(b.position);
    }
    return b.priority - a.priority;
  });
}

export function assemblePrompt(context: PromptAssemblyContext): PromptAssemblyResult {
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

  const historyText = formatRecentMessages(context.recentMessages);
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

  const orderedLayers = sortLayers(layers).filter((layer) => layer.text.length > 0);
  const totalTokenEstimate = orderedLayers.reduce((sum, layer) => sum + layer.tokenCount, 0);

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
        ...orderedLayers
          .filter((layer) => layer.sourceType !== "chat_history")
          .map((layer) => ({
            role: "system",
            content: layer.text,
            layerId: layer.id,
          })),
        ...context.recentMessages.map((message) => ({
          role: message.role,
          content: message.content,
          messageId: message.id,
        })),
      ],
    },
  };
}
