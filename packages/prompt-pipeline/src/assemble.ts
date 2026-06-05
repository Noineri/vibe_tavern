import type {
  PromptAssemblyContext,
  PromptAssemblyResult,
  PromptLayer,
  PromptLayerPosition,
  RecentMessage,
} from "./types.js";
import type { AssemblyMode } from "./types.js";
import { estimateTokens, findSafeCompactionBoundary } from "./compaction.js";
import { createFullMacroEngine } from "./macro-registry.js";
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
  sourceName?: string;
  position?: PromptLayerPosition;
  priority?: number;
  enabled?: boolean;
  reason?: string;
  role?: string;
  subPosition?: number;
  insertionOrder?: number;
  text: string;
}): PromptLayer {
  return {
    id: input.id,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceName: input.sourceName ?? input.sourceType,
    position: input.position ?? "in_prompt",
    priority: input.priority ?? DEFAULT_PROMPT_LAYER_PRIORITY,
    enabled: input.enabled ?? true,
    reason: input.reason ?? PROMPT_LAYER_REASON.included,
    tokenCount: estimateTokens(input.text),
    text: input.text.trim(),
    ...(input.role ? { role: input.role as "system" | "user" | "assistant" } : {}),
    ...(input.subPosition != null ? { subPosition: input.subPosition } : {}),
    ...(input.insertionOrder != null ? { insertionOrder: input.insertionOrder } : {}),
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
    // Within same position, sort by subPosition (lower = earlier), then by
    // explicit insertionOrder when provided. This is important for ST World
    // Info: entry insertion_order controls final order within the WI marker,
    // independently from lorebook/link ordering.
    if (a.subPosition != null && b.subPosition != null && a.subPosition !== b.subPosition) {
      return a.subPosition - b.subPosition;
    }
    // Layers without subPosition go after those with it
    if (a.subPosition != null && b.subPosition == null) return -1;
    if (a.subPosition == null && b.subPosition != null) return 1;
    if (a.insertionOrder != null && b.insertionOrder != null && a.insertionOrder !== b.insertionOrder) {
      return a.insertionOrder - b.insertionOrder;
    }
    if (a.insertionOrder != null && b.insertionOrder == null) return -1;
    if (a.insertionOrder == null && b.insertionOrder != null) return 1;
    return b.priority - a.priority;
  });
}

const phaseOneMacroEngine = createFullMacroEngine();

function promptOrderEnabled(context: PromptAssemblyContext, identifier: string): boolean {
  const entry = context.preset?.promptOrder?.find((item) => item.identifier === identifier);
  return entry?.enabled ?? true;
}

const DEFAULT_PROMPT_ORDER: Record<string, number> = {
  main: 0,
  worldInfoBefore: 10,
  personaDescription: 20,
  charDescription: 30,
  charPersonality: 40,
  scenario: 50,
  authorsNote: 60,
  enhanceDefinitions: 70,
  nsfw: 75,
  worldInfoAfter: 80,
  dialogueExamples: 90,
  chatHistory: 100,
  jailbreak: 110,
};

function hasPromptOrderLayout(context: PromptAssemblyContext): boolean {
  return (context.preset?.promptOrder ?? []).some((entry) => entry.order != null);
}

function promptOrderRank(context: PromptAssemblyContext, identifier: string, fallback: number | undefined = DEFAULT_PROMPT_ORDER[identifier] ?? 10_000): number {
  const entries = context.preset?.promptOrder ?? [];
  const index = entries.findIndex((entry) => entry.identifier === identifier);
  if (!hasPromptOrderLayout(context) || index < 0) return fallback ?? 10_000;
  return entries[index]!.order ?? index;
}

function promptOrderPlacement(context: PromptAssemblyContext, identifier: string): "before_chat" | "after_chat" | null {
  if (!hasPromptOrderLayout(context)) return null;
  const entries = context.preset?.promptOrder ?? [];
  const itemIndex = entries.findIndex((entry) => entry.identifier === identifier);
  const chatIndex = entries.findIndex((entry) => entry.identifier === "chatHistory");
  if (itemIndex < 0 || chatIndex < 0) return null;
  const itemOrder = entries[itemIndex]!.order ?? itemIndex;
  const chatOrder = entries[chatIndex]!.order ?? chatIndex;
  return itemOrder > chatOrder ? "after_chat" : "before_chat";
}

function lorePromptSubPosition(
  context: PromptAssemblyContext,
  lorePosition: string | undefined,
  worldInfoIdentifier: string,
  fallbackSubPosition: number | undefined,
): number | undefined {
  switch (lorePosition) {
    case "top_an":
      return promptOrderRank(context, "authorsNote") - 0.1;
    case "bottom_an":
      return promptOrderRank(context, "authorsNote") + 0.1;
    case "before_examples":
      return promptOrderRank(context, "dialogueExamples") - 0.1;
    case "after_examples":
      return promptOrderRank(context, "dialogueExamples") + 0.1;
    default:
      return promptOrderRank(context, worldInfoIdentifier, DEFAULT_PROMPT_ORDER[worldInfoIdentifier] ?? fallbackSubPosition);
  }
}

function applyPromptOrderPosition(context: PromptAssemblyContext, layer: PromptLayer, identifier: string): PromptLayer {
  const placement = promptOrderPlacement(context, identifier);
  layer.subPosition = promptOrderRank(context, identifier);
  if (placement === "after_chat") {
    layer.position = "in_chat";
    layer.injectionDepth = 0;
  } else if (placement === "before_chat" && layer.position === "in_chat" && layer.injectionDepth === 0) {
    layer.position = "in_prompt";
    delete layer.injectionDepth;
  }
  return layer;
}

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
  // Reset variable state for this assembly pass so setvar/getvar start clean.
  phaseOneMacroEngine.resetVariables();

  // First resolve character/persona fields from the raw context. Then build a
  // second variable context from those resolved fields so ST macros such as
  // {{description}}, {{personality}}, {{scenario}}, and {{persona}} expand to
  // the final field text inside preset-owned prompt-order/custom injection
  // blocks, lore, memory, and chat messages.
  const baseVariableContext = buildAssemblyVariableContext(context);
  const resolvedCharacter = {
    ...context.character,
    description: applyMacros(context.character.description, baseVariableContext),
    scenario: context.character.scenario != null ? applyMacros(context.character.scenario, baseVariableContext) : context.character.scenario,
    systemPrompt: context.character.systemPrompt != null ? applyMacros(context.character.systemPrompt, baseVariableContext) : context.character.systemPrompt,
    personality: context.character.personality != null ? applyMacros(context.character.personality, baseVariableContext) : context.character.personality,
    mesExample: context.character.mesExample != null ? applyMacros(context.character.mesExample, baseVariableContext) : context.character.mesExample,
    postHistoryInstructions: context.character.postHistoryInstructions != null ? applyMacros(context.character.postHistoryInstructions, baseVariableContext) : context.character.postHistoryInstructions,
    depthPrompt: context.character.depthPrompt != null ? applyMacros(context.character.depthPrompt, baseVariableContext) : context.character.depthPrompt,
  };
  const resolvedPersona = context.persona ? {
    ...context.persona,
    description: applyMacros(context.persona.description, baseVariableContext),
  } : context.persona;
  const variableContext = buildAssemblyVariableContext({
    ...context,
    character: resolvedCharacter,
    persona: resolvedPersona,
  });

  return {
    ...context,
    character: resolvedCharacter,
    persona: resolvedPersona,
    preset: context.preset ? {
      ...context.preset,
      text: applyMacros(context.preset.text, variableContext),
      jailbreak: context.preset.jailbreak != null ? applyMacros(context.preset.jailbreak, variableContext) : context.preset.jailbreak,
      prefill: context.preset.prefill != null ? applyMacros(context.preset.prefill, variableContext) : context.preset.prefill,
      authorsNote: context.preset.authorsNote != null ? applyMacros(context.preset.authorsNote, variableContext) : context.preset.authorsNote,
      summary: context.preset.summary != null ? applyMacros(context.preset.summary, variableContext) : context.preset.summary,
      tools: context.preset.tools != null ? applyMacros(context.preset.tools, variableContext) : context.preset.tools,
      customInjections: context.preset.customInjections?.map((injection) => ({
        ...injection,
        name: applyMacros(injection.name, variableContext),
        content: applyMacros(injection.content, variableContext),
      })),
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
      ...context.chat,
      recentMessages: context.chat.recentMessages.map((msg) => ({
        ...msg,
        content: applyMacros(msg.content, variableContext),
      })),
      scriptInjections: context.chat.scriptInjections?.map((msg) => ({
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

  // System prompt: character override takes priority over preset
  const effectiveSystemPrompt = context.character.systemPrompt?.trim() || context.preset?.text?.trim();
  if (effectiveSystemPrompt && promptOrderEnabled(context, "main")) {
    const isOverride = !!context.character.systemPrompt?.trim();
    layers.push(
      applyPromptOrderPosition(context, makeLayer({
        id: isOverride ? PROMPT_LAYER_ID.characterSystemPrompt : PROMPT_LAYER_ID.promptPresetSystem,
        sourceType: isOverride ? PROMPT_LAYER_SOURCE_TYPE.characterSystemPrompt : PROMPT_LAYER_SOURCE_TYPE.promptPreset,
        sourceId: isOverride ? context.character.id : context.preset!.id,
        sourceName: isOverride ? `${context.character.name} (System Override)` : (context.preset?.name ?? "System Prompt"),
        priority: PROMPT_LAYER_PRIORITY.promptPresetSystem,
        text: effectiveSystemPrompt,
      }), "main"),
    );
  }

  // Jailbreak / Post-History Instructions: placed after chat history (depth=0)
  // Character postHistoryInstructions overrides preset jailbreak
  const effectiveJailbreak = context.character.postHistoryInstructions?.trim() || context.preset?.jailbreak?.trim();
  if (effectiveJailbreak && promptOrderEnabled(context, "jailbreak")) {
    const isOverride = !!context.character.postHistoryInstructions?.trim();
    const layer = applyPromptOrderPosition(context, makeLayer({
      id: PROMPT_LAYER_ID.promptPresetJailbreak,
      sourceType: isOverride ? PROMPT_LAYER_SOURCE_TYPE.character : PROMPT_LAYER_SOURCE_TYPE.promptPreset,
      sourceId: isOverride ? context.character.id : context.preset!.id,
      sourceName: isOverride ? `${context.character.name} (Post-History Override)` : (context.preset?.name ?? "Post-History Instructions"),
      position: "in_chat",
      priority: PROMPT_LAYER_PRIORITY.promptPresetJailbreak,
      text: effectiveJailbreak,
    }), "jailbreak");
    if (layer.position === "in_chat" && layer.injectionDepth == null) layer.injectionDepth = 0;
    layers.push(layer);
  }

  if (context.preset?.authorsNote?.trim() && promptOrderEnabled(context, "authorsNote")) {
    const position = context.preset.authorsNotePosition ?? "in_chat";
    const depth = context.preset.authorsNoteDepth ?? 4;

    if (position === "in_prompt") {
      // Inside system prompt block
      const layer = applyPromptOrderPosition(context, makeLayer({
        id: PROMPT_LAYER_ID.promptPresetAuthorsNote,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
        sourceId: context.preset.id,
        sourceName: "Author's Note",
        position: "in_prompt",
        priority: PROMPT_LAYER_PRIORITY.promptPresetAuthorsNote,
        subPosition: promptOrderRank(context, "authorsNote", IN_PROMPT_SUB_POSITION.authorNote),
        text: context.preset.authorsNote,
      }), "authorsNote");
      layers.push(layer);
    } else if (position === "after_chat") {
      // After chat history, before jailbreak (depth=0)
      const layer = applyPromptOrderPosition(context, makeLayer({
        id: PROMPT_LAYER_ID.promptPresetAuthorsNote,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
        sourceId: context.preset.id,
        sourceName: "Author's Note",
        position: "in_chat",
        priority: PROMPT_LAYER_PRIORITY.promptPresetAuthorsNote,
        text: context.preset.authorsNote,
      }), "authorsNote");
      if (layer.position === "in_chat" && layer.injectionDepth == null) layer.injectionDepth = 0;
      layers.push(layer);
    } else {
      // in_chat at specified depth (default)
      const depthLayer = makeLayer({
        id: PROMPT_LAYER_ID.promptPresetAuthorsNote,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
        sourceId: context.preset.id,
        sourceName: "Author's Note (depth)",
        position: "in_chat",
        priority: PROMPT_LAYER_PRIORITY.promptPresetAuthorsNote,
        subPosition: promptOrderRank(context, "authorsNote", DEFAULT_PROMPT_ORDER.authorsNote),
        text: context.preset.authorsNote,
      });
      depthLayer.injectionDepth = depth;
      layers.push(depthLayer);
    }
  }

  // Enhance Definitions — built-in ST prompt block (disabled by default, content-driven)
  if (context.preset?.enhanceDefinitions?.trim() && promptOrderEnabled(context, "enhanceDefinitions")) {
    const layer = applyPromptOrderPosition(context, makeLayer({
      id: PROMPT_LAYER_ID.promptPresetEnhanceDefinitions,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
      sourceId: context.preset.id,
      sourceName: "Enhance Definitions",
      priority: PROMPT_LAYER_PRIORITY.presetEnhanceDefinitions,
      text: context.preset.enhanceDefinitions,
    }), "enhanceDefinitions");
    layers.push(layer);
  }

  // NSFW — built-in ST prompt block (placed after worldInfoAfter, before chatHistory)
  if (context.preset?.nsfw?.trim() && promptOrderEnabled(context, "nsfw")) {
    const layer = applyPromptOrderPosition(context, makeLayer({
      id: PROMPT_LAYER_ID.promptPresetNsfw,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
      sourceId: context.preset.id,
      sourceName: "NSFW",
      priority: PROMPT_LAYER_PRIORITY.presetNsfw,
      text: context.preset.nsfw,
    }), "nsfw");
    layers.push(layer);
  }

  // Custom injections (advanced/ST mode)
  // For custom injections, `customInjections[i].enabled` is the authoritative enabled flag.
  // `promptOrder` is used for ordering/placement only (not enabled) — kept authoritative for built-in slots elsewhere.
  // Skip built-in identifiers that are handled as dedicated fields (nsfw, enhanceDefinitions).
  const BUILTIN_FIELD_IDENTIFIERS = new Set(["nsfw", "enhanceDefinitions"]);
  for (const injection of (context.preset?.customInjections ?? [])) {
    if (!injection.enabled || !injection.content?.trim()) continue;
    if (BUILTIN_FIELD_IDENTIFIERS.has(injection.identifier ?? injection.name)) continue;

    const isAbsolute = injection.injectionPosition === 1 || injection.injectionPosition === "absolute" || injection.injectionPosition == null;
    const role = injection.role === "user" || injection.role === "assistant" ? injection.role : "system";
    const identifier = injection.identifier ?? injection.name;
    const orderIndex = promptOrderRank(context, identifier, injection.promptOrderIndex ?? 10_000);
    const placement = promptOrderPlacement(context, identifier) ?? injection.promptOrderPlacement ?? "before_chat";

    const layer = makeLayer({
      id: `preset_injection_${identifier}`,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
      sourceId: context.preset?.id ?? "",
      sourceName: injection.name,
      position: isAbsolute
        ? "in_chat"
        : placement === "after_chat" ? "in_chat" : "in_prompt",
      priority: isAbsolute
        ? (injection.injectionOrder ?? 100)
        : Math.max(1, 800 - orderIndex / 1000),
      subPosition: orderIndex,
      role,
      reason: isAbsolute
        ? `included (ST absolute depth=${injection.depth ?? 0}, order=${injection.injectionOrder ?? 100})`
        : `included (ST relative ${placement}, orderIndex=${orderIndex})`,
      text: injection.content,
    });

    if (isAbsolute || placement === "after_chat") {
      layer.injectionDepth = isAbsolute ? (injection.depth ?? 0) : 0;
    }
    layers.push(layer);
  }

  if (context.preset?.summary?.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.promptPresetSummary,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
        sourceId: context.preset.id,
        sourceName: "Summary Prompt",
        priority: PROMPT_LAYER_PRIORITY.promptPresetSummary,
        text: context.preset.summary,
      }),
    );
  }

  const characterBase = joinNonEmpty([
    PROMPT_FORMAT.characterHeader(context.character.name),
    context.character.description,
  ]);
  if (characterBase && promptOrderEnabled(context, "charDescription")) {
    layers.push(
      applyPromptOrderPosition(context, makeLayer({
        id: PROMPT_LAYER_ID.characterBase,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
        sourceId: context.character.id,
        sourceName: context.character.name,
        priority: PROMPT_LAYER_PRIORITY.characterBase,
        subPosition: promptOrderRank(context, "charDescription", IN_PROMPT_SUB_POSITION.charDesc),
        text: characterBase,
      }), "charDescription"),
    );
  }

  if (context.character.scenario?.trim() && promptOrderEnabled(context, "scenario")) {
    layers.push(
      applyPromptOrderPosition(context, makeLayer({
        id: PROMPT_LAYER_ID.characterScenario,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
        sourceId: context.character.id,
        sourceName: `${context.character.name} — Scenario`,
        priority: PROMPT_LAYER_PRIORITY.characterScenario,
        subPosition: promptOrderRank(context, "scenario", IN_PROMPT_SUB_POSITION.charDesc),
        text: PROMPT_FORMAT.scenarioHeader(context.character.scenario),
      }), "scenario"),
    );
  }

  if (context.character.personality?.trim() && promptOrderEnabled(context, "charPersonality")) {
    layers.push(
      applyPromptOrderPosition(context, makeLayer({
        id: PROMPT_LAYER_ID.characterPersonality,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
        sourceId: context.character.id,
        sourceName: context.character.name,
        priority: PROMPT_LAYER_PRIORITY.characterPersonality,
        subPosition: promptOrderRank(context, "charPersonality", IN_PROMPT_SUB_POSITION.charDesc),
        text: context.character.personality,
      }), "charPersonality"),
    );
  }

  if (context.persona?.description?.trim() && promptOrderEnabled(context, "personaDescription")) {
    layers.push(
      applyPromptOrderPosition(context, makeLayer({
        id: PROMPT_LAYER_ID.persona,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.persona,
        sourceId: context.persona.id,
        sourceName: context.persona.name,
        priority: PROMPT_LAYER_PRIORITY.persona,
        subPosition: promptOrderRank(context, "personaDescription", DEFAULT_PROMPT_ORDER.personaDescription),
        text: PROMPT_FORMAT.personaBlock(context.persona.name, context.persona.description, context.persona.pronouns),
      }), "personaDescription"),
    );
  }

  for (const loreEntry of context.lore ?? []) {
    if (!loreEntry.content.trim()) {
      droppedLayers.push({ id: loreEntry.id, reason: PROMPT_LAYER_REASON.emptyLoreContent });
      continue;
    }

    // Map legacy lorebook position strings to pipeline positions.
    // If the position is already a pipeline position, pass through unchanged.
    const resolvedPosition = (() => {
      switch (loreEntry.position) {
        case "before_char":    return "in_prompt";
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

    const worldInfoIdentifier = loreEntry.position === "before_char" ? "worldInfoBefore" : "worldInfoAfter";
    if (!promptOrderEnabled(context, worldInfoIdentifier)) {
      droppedLayers.push({ id: loreEntry.id, reason: `skipped: ${worldInfoIdentifier} disabled by prompt order` });
      continue;
    }

    const layer = makeLayer({
      id: createLoreLayerId(loreEntry.id),
      sourceType: PROMPT_LAYER_SOURCE_TYPE.loreEntry,
      sourceId: loreEntry.id,
      sourceName: loreEntry.title || loreEntry.id,
      position: resolvedPosition,
      priority: loreEntry.priority,
      role: loreEntry.role,
      subPosition: lorePromptSubPosition(context, loreEntry.position, worldInfoIdentifier, subPos),
      insertionOrder: loreEntry.sortOrder,
      reason: PROMPT_LAYER_REASON.activatedLoreEntry,
      text: joinNonEmpty([loreEntry.title ? PROMPT_FORMAT.loreHeader(loreEntry.title) : null, loreEntry.content]),
    });

    const placement = promptOrderPlacement(context, worldInfoIdentifier);
    if (placement === "after_chat" && layer.position !== "hidden_system") {
      layer.position = "in_chat";
      layer.injectionDepth = 0;
    }

    // at_depth injects into chat history at a specific depth
    if (loreEntry.position === "at_depth") {
      layer.position = "in_chat";
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
        sourceName: memory.kind || "Summary",
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
        sourceName: memory.sourceType || "Retrieval",
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
        sourceName: "Tool Instructions",
        priority: PROMPT_LAYER_PRIORITY.toolInstructions,
        text: context.instructions.toolInstructions,
      }),
    );
  }

  let recentMessagesForHistory = context.chat.recentMessages;
  let compactionSummary: string | undefined;

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
        compactionSummary =
          `Kept ${recentMessagesForHistory.length} of ` +
          `${context.chat.recentMessages.length} recent messages ` +
          `(~${preservedTokens} tokens after compaction, ` +
          `${totalBeforeCompaction} tokens before, ` +
          `budget ${context.config.contextBudget}, ` +
          `responseReserve ${responseReserve}).`;
      }
    }
  }

  const historyText = formatRecentMessages(recentMessagesForHistory);
  if (historyText && promptOrderEnabled(context, "chatHistory")) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.recentHistory,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.chatHistory,
        sourceId: context.identity.chatId,
        sourceName: "Chat History",
        priority: PROMPT_LAYER_PRIORITY.recentHistory,
        subPosition: promptOrderRank(context, "chatHistory", DEFAULT_PROMPT_ORDER.chatHistory),
        text: historyText,
      }),
    );
  }

  if (context.character.mesExample?.trim() && promptOrderEnabled(context, "dialogueExamples")) {
    const mesExampleMode = context.character.mesExampleMode ?? "always";
    const isFirstTurn = context.chat.recentMessages.length <= 1;
    const shouldInclude =
      mesExampleMode === "always" ||
      (mesExampleMode === "once" && isFirstTurn) ||
      mesExampleMode === "depth";

    if (shouldInclude) {
      const isDepthMode = mesExampleMode === "depth";
      const depth = context.character.mesExampleDepth ?? 4;
      const layer = makeLayer({
        id: PROMPT_LAYER_ID.mesExample,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
        sourceId: context.character.id,
        sourceName: context.character.name + " — Examples",
        priority: PROMPT_LAYER_PRIORITY.mesExample,
        reason: isDepthMode
          ? `included (depth mode, depth=${depth})`
          : isFirstTurn ? "included" : "included (always mode)",
        text: PROMPT_FORMAT.exampleMessages(context.character.mesExample),
      });

      layer.subPosition = promptOrderRank(context, "dialogueExamples", DEFAULT_PROMPT_ORDER.dialogueExamples);
      if (isDepthMode) {
        layer.position = "in_chat";
        layer.injectionDepth = depth;
      } else {
        // always/once: place after chat history (before jailbreak)
        // Higher priority than jailbreak (990) so examples come first
        layer.position = "in_chat";
        layer.injectionDepth = 0;
      }
      layers.push(applyPromptOrderPosition(context, layer, "dialogueExamples"));
    } else {
      droppedLayers.push({
        id: PROMPT_LAYER_ID.mesExample,
        reason: mesExampleMode === "disabled"
          ? "skipped: mes_example_mode=disabled"
          : `skipped: mes_example_mode=once, not first turn (${context.chat.recentMessages.length} messages)`,
      });
    }
  }


  // Note: character postHistoryInstructions is handled above as jailbreak override
  // (character.postHistoryInstructions replaces preset.jailbreak when present)

  // --- Character Depth Prompt ---
  // Character-level depth injection (equivalent to ST depth_prompt)
  if (context.character.depthPrompt?.trim()) {
    const depth = context.character.depthPromptDepth ?? 4;
    const role = context.character.depthPromptRole ?? "system";
    const layer = makeLayer({
      id: PROMPT_LAYER_ID.characterDepthPrompt,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
      sourceId: context.character.id,
      sourceName: `${context.character.name} (Depth)`,
      position: "in_chat",
      priority: PROMPT_LAYER_PRIORITY.characterDepthPrompt,
      role: role as "system" | "user" | "assistant",
      text: context.character.depthPrompt,
    });
    layer.injectionDepth = depth;
    layers.push(layer);
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
      sourceName: "Script Injection",
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
    (layer) =>
      layer.position !== "hidden_system" &&
      layer.sourceType !== PROMPT_LAYER_SOURCE_TYPE.chatHistory,
  );

  const beforePrompt = nonHiddenLayers.filter((l) => l.position === "before_prompt");
  const inPrompt = nonHiddenLayers.filter((l) => l.position === "in_prompt");
  const inChat = nonHiddenLayers.filter((l) => l.position === "in_chat");

  // in_chat layers with a numeric injectionDepth are interleaved into the history
  // at the specified offset from the end.  We sort deepest-first so that splicing
  // at a larger depth doesn't shift the insertion index of shallower layers.
  const inChatWithDepth = inChat
    .filter((l) => typeof l.injectionDepth === "number")
    .sort((a, b) => {
      const depthDiff = b.injectionDepth! - a.injectionDepth!;
      if (depthDiff !== 0) return depthDiff;
      const subDiff = (b.subPosition ?? b.priority) - (a.subPosition ?? a.priority);
      if (subDiff !== 0) return subDiff;
      if (a.insertionOrder != null && b.insertionOrder != null && a.insertionOrder !== b.insertionOrder) {
        return b.insertionOrder - a.insertionOrder;
      }
      return a.priority - b.priority;
    }); // deepest first; same-depth reverse order because splice inserts at a fixed index
  // in_chat layers WITHOUT a depth are collected into a single block placed before history.
  const inChatBlock = inChat.filter((l) => typeof l.injectionDepth !== "number");

  // Build history messages
  const historyMessages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    messageId?: string;
    layerId?: string;
  }> = promptOrderEnabled(context, "chatHistory")
    ? recentMessagesForHistory.map((message) => ({
        role: message.role as "system" | "user" | "assistant" | "tool",
        content: message.content,
        messageId: message.id,
      }))
    : [];

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
      role: layer.role ?? ("system" as const),
      content: layer.text,
      layerId: layer.id,
    })),
    ...inPrompt.map((layer) => ({
      role: layer.role ?? ("system" as const),
      content: layer.text,
      layerId: layer.id,
    })),
    ...inChatBlock.map((layer) => ({
      role: layer.role ?? ("system" as const),
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
    prefill: (context.preset?.prefill && promptOrderEnabled(context, "assistantPrefill")) ? context.preset.prefill : null,
    compactionSummary: compactionSummary ?? null,
  };
}
