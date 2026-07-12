import type { PromptAssemblyContext, PromptAssemblyResult, PromptLayer } from "../types.js";
import { joinNonEmpty, makeLayer, sortLayers } from "../assemble.js";
import {
  LAYER_MODES,
  PROMPT_FORMAT,
  PROMPT_LAYER_ID,
  PROMPT_LAYER_PRIORITY,
  PROMPT_LAYER_SOURCE_TYPE,
  createLoreLayerId,
} from "../prompt-layer-constants.js";

/** Pure per-mode assembly seam for Build AI assistant requests. */
export interface AiAssistantAssembler {
  assemble(context: PromptAssemblyContext): PromptAssemblyResult;
}

export function assembleAiAssistant(context: PromptAssemblyContext): PromptAssemblyResult {
  const ai = context.aiAssistant!;
  const layers: PromptLayer[] = [];
  const enabled = new Set(ai.enabledLayers);

  // 1. System prompt — always on
  if (ai.systemPrompt?.trim()) {
    layers.push(makeLayer({
      id: PROMPT_LAYER_ID.aiAssistantSystem,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.aiAssistant,
      sourceId: "system",
      sourceName: `AI Assistant (${ai.mode})`,
      priority: PROMPT_LAYER_PRIORITY.aiAssistantSystem,
      text: ai.systemPrompt,
    }));
  }

  // 2. Character context — if enabled
  if (enabled.has(PROMPT_LAYER_ID.characterBase) && context.character?.description?.trim()) {
    layers.push(makeLayer({
      id: PROMPT_LAYER_ID.characterBase,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
      sourceId: context.character.id,
      sourceName: context.character.name,
      priority: PROMPT_LAYER_PRIORITY.aiAssistantContext,
      text: joinNonEmpty([
        PROMPT_FORMAT.characterHeader(context.character.name),
        context.character.description,
        context.character.personality?.trim(),
        context.character.scenario?.trim() ? PROMPT_FORMAT.scenarioHeader(context.character.scenario) : null,
      ]),
    }));
  }

  // 3. Persona context — if enabled
  if (enabled.has(PROMPT_LAYER_ID.persona) && context.persona?.description?.trim()) {
    layers.push(makeLayer({
      id: PROMPT_LAYER_ID.persona,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.persona,
      sourceId: context.persona.id,
      sourceName: context.persona.name,
      priority: PROMPT_LAYER_PRIORITY.aiAssistantContext - 10,
      text: PROMPT_FORMAT.personaBlock(context.persona.name, context.persona.description, context.persona.pronouns),
    }));
  }

  // 4. Lore entries — if enabled
  if (enabled.has("lore")) {
    for (const loreEntry of context.lore ?? []) {
      if (!loreEntry.content.trim()) continue;
      layers.push(makeLayer({
        id: createLoreLayerId(loreEntry.id),
        sourceType: PROMPT_LAYER_SOURCE_TYPE.loreEntry,
        sourceId: loreEntry.id,
        sourceName: loreEntry.title || loreEntry.id,
        priority: PROMPT_LAYER_PRIORITY.aiAssistantContext - 20,
        text: joinNonEmpty([loreEntry.title ? PROMPT_FORMAT.loreHeader(loreEntry.title) : null, loreEntry.content]),
      }));
    }
  }

  // 5. Existing content — always on when present
  if (ai.existingContent?.trim()) {
    layers.push(makeLayer({
      id: PROMPT_LAYER_ID.aiAssistantExisting,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.aiAssistant,
      sourceId: "existing",
      sourceName: "Current Content",
      priority: PROMPT_LAYER_PRIORITY.aiAssistantExisting,
      text: ai.existingContent,
    }));
  }

  // 5b. Chat history — for chat_impersonate mode
  if (ai.mode === "chat_impersonate" && context.chat?.recentMessages?.length) {
    const historyText = context.chat.recentMessages
      .map((msg) => `[${msg.role}]: ${msg.content}`)
      .join("\n\n");
    if (historyText.trim()) {
      layers.push(makeLayer({
        id: PROMPT_LAYER_ID.aiAssistantChatHistory,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.chatHistory,
        sourceId: "chat_history",
        sourceName: "Chat History",
        priority: PROMPT_LAYER_PRIORITY.aiAssistantExisting - 5,
        text: historyText,
      }));
    }
  }

  // 6. User instruction — always on
  if (ai.instruction?.trim()) {
    layers.push(makeLayer({
      id: PROMPT_LAYER_ID.aiAssistantInstruction,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.aiAssistant,
      sourceId: "instruction",
      sourceName: "User Instruction",
      priority: PROMPT_LAYER_PRIORITY.aiAssistantInstruction,
      text: ai.instruction,
    }));
  }

  // Assign modes to all layers
  for (const layer of layers) {
    const layerModes = LAYER_MODES[layer.id];
    if (layerModes) layer.modes = layerModes;
  }

  const orderedLayers = sortLayers(layers).filter((layer) => layer.text.length > 0);
  const totalTokenEstimate = orderedLayers.reduce((sum, layer) => sum + layer.tokenCount, 0);

  // Build final messages: all layers go as system messages except the
  // instruction which becomes the user message.
  const messages = orderedLayers
    .filter((layer) => layer.id !== PROMPT_LAYER_ID.aiAssistantInstruction)
    .map((layer) => ({
      role: (layer.role ?? "system") as "system" | "user" | "assistant",
      content: layer.text,
      layerId: layer.id,
    }));

  // Instruction is the user message (last)
  const instructionLayer = orderedLayers.find((layer) => layer.id === PROMPT_LAYER_ID.aiAssistantInstruction);
  if (instructionLayer) {
    messages.push({
      role: "user" as const,
      content: instructionLayer.text,
      layerId: instructionLayer.id,
    });
  }

  return {
    layers: orderedLayers,
    totalTokenEstimate,
    activatedLoreEntries: (context.lore ?? []).map((entry) => entry.id),
    usedMemoryBlocks: [],
    droppedLayers: [],
    finalPayload: { messages },
    prefill: null,
    compactionSummary: null,
  };
}

export const DefaultAiAssistantAssembler: AiAssistantAssembler = {
  assemble: assembleAiAssistant,
};
