import type {
  PromptAssemblyContext,
  PromptAssemblyResult,
  PromptLayer,
  PromptLayerPosition,
  RecentMessage,
} from "./types.js";
import type { AssemblyMode } from "./types.js";
import { estimateTokens, findSafeCompactionBoundary } from "./compaction.js";
import { createPhaseOneMacroEngine } from "./macro-registry.js";
import { buildPromptVariableContext, type PromptVariableContext } from "./prompt-variable-context.js";
import {
  DEFAULT_PROMPT_LAYER_PRIORITY,
  LAYER_MODES,
  PROMPT_FORMAT,
  PROMPT_LAYER_ID,
  PROMPT_LAYER_POSITION_RANK,
  PROMPT_LAYER_PRIORITY,
  PROMPT_LAYER_REASON,
  PROMPT_LAYER_SOURCE_ID,
  PROMPT_LAYER_SOURCE_TYPE,
  IN_PROMPT_SUB_POSITION,
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

/**
 * Factory for creating a {@link PromptLayer} with sensible defaults.
 *
 * - `position` defaults to `"in_prompt"` when not specified.
 * - `priority` defaults to {@link DEFAULT_PROMPT_LAYER_PRIORITY} (0).
 */
function makeLayer(input: {
  id: string;
  sourceType: string;
  sourceId: string;
  position?: PromptLayerPosition;
  priority?: number;
  enabled?: boolean;
  reason?: string;
  role?: string;
  subPosition?: number;
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
    ...(input.role ? { role: input.role as "system" | "user" | "assistant" } : {}),
    ...(input.subPosition != null ? { subPosition: input.subPosition } : {}),
  };
}

/**
 * Sort layers by position first (`before_prompt` < `in_prompt` < `in_chat` < `hidden_system`),
 * then by priority **descending** within the same position group.
 */
function sortLayers(layers: PromptLayer[]): PromptLayer[] {
  return [...layers].sort((a, b) => {
    const posDiff = PROMPT_LAYER_POSITION_RANK[a.position] - PROMPT_LAYER_POSITION_RANK[b.position];
    if (posDiff !== 0) return posDiff;
    // Within same position, sort by subPosition (lower = earlier), then by priority descending
    if (a.subPosition != null && b.subPosition != null && a.subPosition !== b.subPosition) {
      return a.subPosition - b.subPosition;
    }
    // Layers without subPosition go after those with it
    if (a.subPosition != null && b.subPosition == null) return -1;
    if (a.subPosition == null && b.subPosition != null) return 1;
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
      mesExample: context.character.mesExample ?? null,
      postHistoryInstructions: context.character.postHistoryInstructions ?? null,
    },
    persona: {
      name: context.persona?.name ?? "User",
      description: context.persona?.description ?? "",
    },
    prompt: {
      system: context.preset?.text ?? "",
      jailbreak: context.preset?.jailbreak ?? "",
      summary: context.preset?.summary ?? "",
      tools: context.preset?.tools ?? context.instructions?.toolInstructions ?? "",
      contextBudget: context.config?.contextBudget ?? null,
    },
    chat: {
      messages: context.chat.recentMessages,
      messageIds: context.chat.recentMessages.map((message) => message.id),
    },
    runtime: {
      contextBudget: context.config?.contextBudget ?? null,
      maxPromptTokens: context.config?.contextBudget ?? null,
    },
  });
}

function applyMacros(text: string | null | undefined, variableContext: PromptVariableContext): string {
  return text ? phaseOneMacroEngine.resolve(text, variableContext) : "";
}

/**
 * Applies macro resolution to every text field of the assembly context
 * (character fields, persona, preset, lore, memory, chat messages, tool instructions).
 * Called before any layer construction so all downstream text is fully resolved.
 */
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
      mesExample: context.character.mesExample != null ? applyMacros(context.character.mesExample, variableContext) : context.character.mesExample,
      postHistoryInstructions: context.character.postHistoryInstructions != null ? applyMacros(context.character.postHistoryInstructions, variableContext) : context.character.postHistoryInstructions,
    },
    persona: context.persona ? {
      ...context.persona,
      description: applyMacros(context.persona.description, variableContext),
    } : context.persona,
    preset: context.preset ? {
      ...context.preset,
      text: applyMacros(context.preset.text, variableContext),
      jailbreak: context.preset.jailbreak != null ? applyMacros(context.preset.jailbreak, variableContext) : context.preset.jailbreak,
      summary: context.preset.summary != null ? applyMacros(context.preset.summary, variableContext) : context.preset.summary,
      tools: context.preset.tools != null ? applyMacros(context.preset.tools, variableContext) : context.preset.tools,
    } : context.preset,
    lore: context.lore?.map((entry) => ({
      ...entry,
      title: applyMacros(entry.title, variableContext),
      content: applyMacros(entry.content, variableContext),
    })),
    memory: {
      summary: context.memory?.summary?.map((s) => ({
        ...s,
        summary: applyMacros(s.summary, variableContext),
      })),
      retrieval: context.memory?.retrieval?.map((m) => ({
        ...m,
        content: applyMacros(m.content, variableContext),
      })),
    },
    chat: {
      recentMessages: context.chat.recentMessages.map((msg) => ({
        ...msg,
        content: applyMacros(msg.content, variableContext),
      })),
    },
    instructions: context.instructions ? {
      toolInstructions: context.instructions.toolInstructions != null ? applyMacros(context.instructions.toolInstructions, variableContext) : context.instructions.toolInstructions,
    } : context.instructions,
  };
}

/**
 * Core assembly pipeline.
 *
 * Accepts a raw {@link PromptAssemblyContext}, processes it, and returns
 * a {@link PromptAssemblyResult} containing ordered layers and the final
 * `messages` payload.
 *
 * Pipeline order:
 *  1. **Macros** — resolve all `{{…}}` placeholders in context text fields
 *  2. **Layers** — create a {@link PromptLayer} for every non-empty content source
 *  3. **Compaction** — if the total exceeds `contextBudget`, trim older messages
 *     while preserving at least `max(2, ceil(N/2))` recent messages and never
 *     splitting an assistant→tool pair (see {@link findSafeCompactionBoundary})
 *  4. **Mode filtering** — drop layers not active for the current {@link AssemblyMode}
 *  5. **Sorting** — order by position, then priority descending
 *  6. **Assembly** — build the final `messages` array, interleaving depth-aware
 *     `in_chat` layers into the history
 */
export function assemblePrompt(rawContext: PromptAssemblyContext): PromptAssemblyResult {
  const context = applyMacrosToContext(rawContext);
  const layers: PromptLayer[] = [];
  const droppedLayers: Array<{ id: string; reason: string }> = [];

  if (context.preset?.text?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.promptPresetSystem,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
        sourceId: context.preset.id,
        priority: PROMPT_LAYER_PRIORITY.promptPresetSystem,
        text: context.preset.text,
      }),
    );
  }

  if (context.preset?.jailbreak?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.promptPresetJailbreak,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
        sourceId: context.preset.id,
        priority: PROMPT_LAYER_PRIORITY.promptPresetJailbreak,
        text: context.preset.jailbreak,
      }),
    );
  }

  if (context.preset?.authorsNote?.trim()) {
    const layer = makeLayer({
      id: PROMPT_LAYER_ID.promptPresetAuthorsNote,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
      sourceId: context.preset.id,
      position: "in_prompt",
      priority: PROMPT_LAYER_PRIORITY.promptPresetAuthorsNote,
      subPosition: IN_PROMPT_SUB_POSITION.authorNote,
      text: context.preset.authorsNote,
    });
    // AuthorsNote depth: if > 0, also inject a copy at the specified depth in chat
    if ((context.preset.authorsNoteDepth ?? 0) > 0) {
      const depthLayer = makeLayer({
        id: PROMPT_LAYER_ID.promptPresetAuthorsNote + "_depth",
        sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
        sourceId: context.preset.id,
        position: "in_chat",
        priority: PROMPT_LAYER_PRIORITY.promptPresetAuthorsNote,
        text: context.preset.authorsNote,
      });
      depthLayer.injectionDepth = context.preset.authorsNoteDepth ?? 4;
      layers.push(depthLayer);
    }
    layers.push(layer);
  }

  // Custom injections (advanced mode)
  for (const injection of (context.preset?.customInjections ?? [])) {
    if (!injection.enabled || !injection.content?.trim()) continue;
    const layer = makeLayer({
      id: `preset_injection_${injection.name}`,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
      sourceId: context.preset?.id ?? "",
      position: "in_chat",
      priority: (PROMPT_LAYER_PRIORITY.promptPresetAuthorsNote ?? 170) - (injection.depth ?? 0),
      text: injection.content,
    });
    layer.injectionDepth = injection.depth ?? 0;
    if (injection.role === "user" || injection.role === "assistant") {
      layer.role = injection.role;
    }
    layers.push(layer);
  }

  if (context.preset?.summary?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.promptPresetSummary,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
        sourceId: context.preset.id,
        priority: PROMPT_LAYER_PRIORITY.promptPresetSummary,
        text: context.preset.summary,
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
        subPosition: IN_PROMPT_SUB_POSITION.charDesc,
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
        subPosition: IN_PROMPT_SUB_POSITION.charDesc,
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
        text: PROMPT_FORMAT.personaBlock(context.persona.name, context.persona.description, context.persona.pronouns),
      }),
    );
  }

  for (const loreEntry of [...(context.lore ?? [])].sort((a, b) => b.priority - a.priority)) {
    if (!loreEntry.content.trim()) {
      droppedLayers.push({ id: loreEntry.id, reason: PROMPT_LAYER_REASON.emptyLoreContent });
      continue;
    }

    // Map legacy lorebook position strings to pipeline positions.
    // If the position is already a pipeline position, pass through unchanged.
    const resolvedPosition = (() => {
      switch (loreEntry.position) {
        case "before_char":    return "before_prompt";
        case "after_char":     return "in_prompt";
        case "before_examples": return "in_prompt";
        case "after_examples":  return "in_prompt";
        case "top_an":         return "in_prompt";
        case "bottom_an":      return "in_prompt";
        case "at_depth":       return "in_chat";
        case "outlet":         return "hidden_system";
        // Pipeline-native positions pass through unchanged
        case "before_prompt":  return "before_prompt";
        case "in_prompt":      return "in_prompt";
        case "in_chat":        return "in_chat";
        case "hidden_system":  return "hidden_system";
        default:                return "in_prompt";
      }
    })();

    // Map ST position to subPosition for fine-grained WI Anchor ordering
    const subPos = (() => {
      switch (loreEntry.position) {
        case "after_char":     return IN_PROMPT_SUB_POSITION.afterChar;
        case "top_an":         return IN_PROMPT_SUB_POSITION.beforeAuthorNote;
        case "bottom_an":      return IN_PROMPT_SUB_POSITION.afterAuthorNote;
        case "before_examples": return IN_PROMPT_SUB_POSITION.beforeExamples;
        case "after_examples":  return IN_PROMPT_SUB_POSITION.afterExamples;
        default:                return undefined;
      }
    })();

    const layer = makeLayer({
      id: createLoreLayerId(loreEntry.id),
      sourceType: PROMPT_LAYER_SOURCE_TYPE.loreEntry,
      sourceId: loreEntry.id,
      position: resolvedPosition,
      priority: loreEntry.priority,
      role: loreEntry.role,
      subPosition: subPos,
      reason: PROMPT_LAYER_REASON.activatedLoreEntry,
      text: joinNonEmpty([loreEntry.title ? PROMPT_FORMAT.loreHeader(loreEntry.title) : null, loreEntry.content]),
    });

    // at_depth injects into chat history at a specific depth
    if (loreEntry.position === "at_depth") {
      layer.injectionDepth = loreEntry.depth ?? 4;
    }

    layers.push(layer);
  }

  for (const memory of context.memory?.summary ?? []) {
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

  for (const memory of [...(context.memory?.retrieval ?? [])].sort((a, b) => b.score - a.score)) {
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

  if (context.instructions?.toolInstructions?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.toolInstructions,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.toolProfile,
        sourceId: PROMPT_LAYER_SOURCE_ID.activeToolProfile,
        priority: PROMPT_LAYER_PRIORITY.toolInstructions,
        text: context.instructions.toolInstructions,
      }),
    );
  }

  let recentMessagesForHistory = context.chat.recentMessages;

  /*
   * --- Compaction ---
   *
   * If contextBudget is set and the estimated token count exceeds it,
   * we trim older messages from the history using a budget-aware strategy:
   *
   * 1. Reserve tokens for the model's response (`responseReserve`).
   * 2. Calculate how many tokens are available for history:
   *      historyBudget = contextBudget - nonHistoryTokens - responseReserve
   * 3. Walk messages from end to start, keeping as many as fit within historyBudget.
   * 4. Always keep at least 2 messages (user+assistant pair).
   * 5. Use findSafeCompactionBoundary() to avoid splitting assistant→tool pairs.
   */
  if (
    typeof context.config?.contextBudget === "number" &&
    context.config.contextBudget > 0 &&
    context.chat.recentMessages.length > 3
  ) {
    const nonHistoryTokens = layers.reduce((sum, layer) => sum + layer.tokenCount, 0);
    const fullHistoryTokens = estimateTokens(formatRecentMessages(context.chat.recentMessages));
    const totalBeforeCompaction = nonHistoryTokens + fullHistoryTokens;

    if (totalBeforeCompaction > context.config.contextBudget) {
      const responseReserve = context.config.responseReserve ?? 0;
      const historyBudget = Math.max(0, context.config.contextBudget - nonHistoryTokens - responseReserve);

      // Walk from end, accumulating tokens until we exceed historyBudget
      let accTokens = 0;
      let keepCount = 0;
      const allMsgs = context.chat.recentMessages;
      for (let i = allMsgs.length - 1; i >= 0; i--) {
        const msgTokens = estimateTokens(formatRecentMessages([allMsgs[i]]));
        if (accTokens + msgTokens > historyBudget && keepCount >= 2) break;
        accTokens += msgTokens;
        keepCount++;
      }
      keepCount = Math.max(keepCount, 2);

      const keepFrom = findSafeCompactionBoundary(
        context.chat.recentMessages as unknown as Parameters<typeof findSafeCompactionBoundary>[0],
        keepCount,
      );
      if (keepFrom > 0) {
        recentMessagesForHistory = context.chat.recentMessages.slice(keepFrom);
        const preservedTokens = estimateTokens(formatRecentMessages(recentMessagesForHistory));
        const droppedCount = context.chat.recentMessages.length - recentMessagesForHistory.length;
        layers.push(
          makeLayer({
            id: PROMPT_LAYER_ID.preflightCompaction,
            sourceType: PROMPT_LAYER_SOURCE_TYPE.compaction,
            sourceId: PROMPT_LAYER_SOURCE_ID.preflight,
            priority: PROMPT_LAYER_PRIORITY.preflightCompaction,
            reason: PROMPT_LAYER_REASON.preflightCompaction(droppedCount),
            text:
              `[Preflight compaction] Kept ${recentMessagesForHistory.length} of ` +
              `${context.chat.recentMessages.length} recent messages ` +
              `(~${preservedTokens} tokens after compaction, ` +
              `${totalBeforeCompaction} tokens before, ` +
              `budget ${context.config.contextBudget}, ` +
              `responseReserve ${responseReserve}).`,
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
        sourceId: context.identity.chatId,
        priority: PROMPT_LAYER_PRIORITY.recentHistory,
        text: historyText,
      }),
    );
  }

  if (context.character.mesExample?.trim()) {
    const mesExampleMode = context.character.mesExampleMode ?? "always";
    const isFirstTurn = context.chat.recentMessages.length <= 1;
    const shouldInclude =
      mesExampleMode === "always" ||
      (mesExampleMode === "once" && isFirstTurn) ||
      mesExampleMode === "depth";

    if (shouldInclude) {
      const isDepthMode = mesExampleMode === "depth";
      const depth = context.character.mesExampleDepth ?? 4;
      layers.push(
        makeLayer({
          id: PROMPT_LAYER_ID.mesExample,
          sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
          sourceId: context.character.id,
          priority: PROMPT_LAYER_PRIORITY.mesExample,
          reason: isDepthMode
            ? `included (depth mode, depth=${depth})`
            : isFirstTurn ? "included" : "included (always mode)",
          text: PROMPT_FORMAT.exampleMessages(context.character.mesExample),
          ...(isDepthMode ? { injectionDepth: depth } : {}),
        }),
      );
    } else {
      droppedLayers.push({
        id: PROMPT_LAYER_ID.mesExample,
        reason: `skipped: mes_example_mode=once, not first turn (${context.chat.recentMessages.length} messages)`,
      });
    }
  }

  if (context.character.postHistoryInstructions?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.postHistoryInstructions,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
        sourceId: context.character.id,
        priority: PROMPT_LAYER_PRIORITY.postHistoryInstructions,
        subPosition: IN_PROMPT_SUB_POSITION.postHistoryInstructions,
        text: context.character.postHistoryInstructions,
      }),
    );
  }

  // --- Script-injected messages (context.chat.injectMessage) ---
  // These become in_chat layers with injectionDepth=0 (right before the last message)
  for (let i = 0; i < (context.chat.scriptInjections?.length ?? 0); i++) {
    const inj = context.chat.scriptInjections![i];
    if (!inj.content?.trim()) continue;
    const layer = makeLayer({
      id: `script_injection_${i}`,
      sourceType: 'script_injection',
      sourceId: '__pipeline',
      position: 'in_chat',
      priority: 200 + i,
      role: inj.role,
      reason: 'injected by script via context.chat.injectMessage()',
      text: inj.content,
    });
    layer.injectionDepth = 0;
    layers.push(layer);
  }

  // --- Assign modes to built-in layers from LAYER_MODES ---
  for (const layer of layers) {
    const layerModes = LAYER_MODES[layer.id];
    if (layerModes) {
      layer.modes = layerModes;
    } else if (
      layer.sourceType === PROMPT_LAYER_SOURCE_TYPE.loreEntry ||
      layer.sourceType === PROMPT_LAYER_SOURCE_TYPE.summaryMemory ||
      layer.sourceType === PROMPT_LAYER_SOURCE_TYPE.retrievalMemory
    ) {
      layer.modes = ["chat", "continue", "regenerate"];
    }
  }

  // --- Mode filtering ---
  const effectiveMode: AssemblyMode = context.mode ?? "chat";
  const modeFilteredLayers = layers.filter((layer) => {
    if (!layer.modes) return true; // no modes = always active (backward compat)
    return layer.modes.includes(effectiveMode);
  });

  const orderedLayers = sortLayers(modeFilteredLayers).filter((layer) => layer.text.length > 0);
  const totalTokenEstimate = orderedLayers.reduce((sum, layer) => sum + layer.tokenCount, 0);

  console.log(`[assemble] ${orderedLayers.length} layers, ${totalTokenEstimate} tokens estimated`);
  for (const layer of orderedLayers) {
    console.log(`  [layer] ${layer.id} | ${layer.sourceType} | pos=${layer.position} | pri=${layer.priority} | tokens=${layer.tokenCount} | len=${layer.text.length} | text=${layer.text.slice(0, 80).replace(/\n/g, '↵')}...`);
  }
  if (droppedLayers.length > 0) {
    console.log(`[assemble] ${droppedLayers.length} dropped layers:`);
    for (const d of droppedLayers) {
      console.log(`  [dropped] ${d.id} | reason=${d.reason}`);
    }
  }

  const nonHiddenLayers = orderedLayers.filter(
    (layer) => layer.position !== "hidden_system" && layer.sourceType !== PROMPT_LAYER_SOURCE_TYPE.chatHistory,
  );

  const beforePrompt = nonHiddenLayers.filter((l) => l.position === "before_prompt");
  const inPrompt = nonHiddenLayers.filter((l) => l.position === "in_prompt");
  const inChat = nonHiddenLayers.filter((l) => l.position === "in_chat");

  // in_chat layers with a numeric injectionDepth are interleaved into the history
  // at the specified offset from the end.  We sort deepest-first so that splicing
  // at a larger depth doesn't shift the insertion index of shallower layers.
  const inChatWithDepth = inChat
    .filter((l) => typeof l.injectionDepth === "number")
    .sort((a, b) => b.injectionDepth! - a.injectionDepth!); // deepest first to preserve indices
  // in_chat layers WITHOUT a depth are collected into a single block placed before history.
  const inChatBlock = inChat.filter((l) => typeof l.injectionDepth !== "number");

  // Build history messages
  const historyMessages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    messageId?: string;
    layerId?: string;
  }> = recentMessagesForHistory.map((message) => ({
    role: message.role as "system" | "user" | "assistant" | "tool",
    content: message.content,
    messageId: message.id,
  }));

  // Interleave in-chat layers with depth (deepest first to preserve indices)
  for (const layer of inChatWithDepth) {
    const insertAt = Math.max(0, historyMessages.length - layer.injectionDepth!);
    historyMessages.splice(insertAt, 0, {
      role: layer.role ?? ("system" as const),
      content: layer.text,
      layerId: layer.id,
    });
  }

  // Build final messages array
  const messages = [
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
    ...inChatBlock.map((layer) => ({
      role: "system" as const,
      content: layer.text,
      layerId: layer.id,
    })),
    ...historyMessages,
  ];

  return {
    layers: orderedLayers,
    totalTokenEstimate,
    activatedLoreEntries: (context.lore ?? []).map((entry) => entry.id),
    usedMemoryBlocks: [
      ...(context.memory?.summary ?? []).map((entry) => entry.id),
      ...(context.memory?.retrieval ?? []).map((entry) => entry.id),
    ],
    droppedLayers,
    finalPayload: { messages },
    prefill: context.preset?.prefill || null,
  };
}
