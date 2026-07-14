import type {
  PromptAssemblyContext,
  PromptAssemblyResult,
  PromptLayer,
  PromptLayerPosition,
  RecentMessage,
} from "./types.js";
import { estimateTokens, planHistoryCompaction } from "./compaction.js";
import { createFullMacroEngine } from "./macro-registry.js";
import { formatSceneHistory } from "./scene-injection.js";
import { buildPromptVariableContext, type PromptVariableContext } from "./prompt-variable-context.js";
import { DEFAULT_PROMPT_ORDER, tag } from "@vibe-tavern/domain";
import { createResolver, type PositionResolver } from "./resolvers/position-resolver.js";
import { buildLoreLayers } from "./build-lore-layers.js";
import {
  DEFAULT_PROMPT_LAYER_PRIORITY,
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

// Prompt assembly runs on every message send, and the layer dump (one line per
// layer, often 30+) is only useful when debugging prompt composition. Routed
// through the tagged logger so LOG_LEVEL=info (the default) hides it; set
// LOG_LEVEL=debug to bring it back. Replaces raw console.log calls that
// bypassed the level gate and spammed the console on every turn.
const logger = tag("assemble");

const SUMMARY_LAYER_IDS: Set<string> = new Set([
  PROMPT_LAYER_ID.promptPresetSummary,
  PROMPT_LAYER_ID.characterSystemPrompt,
  PROMPT_LAYER_ID.characterBase,
  PROMPT_LAYER_ID.characterScenario,
  PROMPT_LAYER_ID.characterPersonality,
  PROMPT_LAYER_ID.characterAvatar,
  PROMPT_LAYER_ID.characterGallery,
  PROMPT_LAYER_ID.personaAvatar,
  PROMPT_LAYER_ID.persona,
  PROMPT_LAYER_ID.mesExample,
  PROMPT_LAYER_ID.recentHistory,
]);

export function joinNonEmpty(parts: Array<string | null | undefined>, separator = "\n"): string {
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
export function makeLayer(input: {
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

function buildAuthorsNoteLayer(
  preset: NonNullable<PromptAssemblyContext["preset"]>,
  resolver: PositionResolver,
): PromptLayer | null {
  if (!preset.authorsNote?.trim() || !resolver.enabled("authorsNote")) return null;

  const role = preset.authorsNoteRole ?? "system";
  const subPosition = resolver.rank("authorsNote", DEFAULT_PROMPT_ORDER.authorsNote);
  if (preset.advancedMode) {
    return resolver.position(makeLayer({
      id: PROMPT_LAYER_ID.promptPresetAuthorsNote,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
      sourceId: preset.id,
      sourceName: "Author's Note",
      position: "in_prompt",
      priority: PROMPT_LAYER_PRIORITY.promptPresetAuthorsNote,
      role,
      subPosition,
      text: preset.authorsNote,
    }), "authorsNote");
  }

  const position = preset.authorsNotePosition ?? "in_chat";
  const layer = makeLayer({
    id: PROMPT_LAYER_ID.promptPresetAuthorsNote,
    sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
    sourceId: preset.id,
    sourceName: position === "in_chat" ? "Author's Note (depth)" : "Author's Note",
    position: position === "in_prompt" ? "in_prompt" : "in_chat",
    priority: PROMPT_LAYER_PRIORITY.promptPresetAuthorsNote,
    role,
    subPosition,
    text: preset.authorsNote,
  });
  if (position !== "in_prompt") layer.injectionDepth = position === "after_chat" ? 0 : (preset.authorsNoteDepth ?? 4);
  return layer;
}

function buildCustomInjectionLayers(
  preset: PromptAssemblyContext["preset"],
  resolver: PositionResolver,
): PromptLayer[] {
  if (!preset || !resolver.includeCustomInjections) return [];

  const builtInIdentifiers = new Set(["nsfw", "enhanceDefinitions"]);
  return preset.customInjections?.flatMap((injection) => {
    if (!injection.content?.trim()) return [];
    const identifier = injection.identifier ?? injection.name;
    if (builtInIdentifiers.has(identifier)) return [];
    const canvasEntry = preset.promptOrder?.find((entry) => entry.identifier === identifier);
    if (!canvasEntry?.enabled) return [];

    const zone = canvasEntry.zone;
    const layer = makeLayer({
      id: `preset_injection_${identifier}`,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
      sourceId: preset.id,
      sourceName: injection.name,
      position: zone === "before_chat" ? "in_prompt" : "in_chat",
      subPosition: resolver.rank(identifier, canvasEntry.order),
      role: injection.role === "user" || injection.role === "assistant" ? injection.role : "system",
      reason: `included (canvas zone=${zone}, depth=${canvasEntry.depth ?? "-"}, order=${canvasEntry.order})`,
      text: injection.content,
    });
    if (zone === "in_chat") layer.injectionDepth = canvasEntry.depth ?? 0;
    else if (zone === "after_chat") layer.injectionDepth = 0;
    return [layer];
  }) ?? [];
}

function buildMesExample(
  context: PromptAssemblyContext,
  resolver: PositionResolver,
): { layer: PromptLayer | null; droppedReason: string | null } {
  if (!context.character.mesExample?.trim() || !resolver.enabled("dialogueExamples")) {
    return { layer: null, droppedReason: null };
  }

  const mode = context.character.mesExampleMode ?? "always";
  const isFirstTurn = context.chat.recentMessages.length <= 1;
  const shouldInclude = mode === "always" || (mode === "once" && isFirstTurn) || mode === "depth";
  if (!shouldInclude) {
    return {
      layer: null,
      droppedReason: mode === "disabled"
        ? "skipped: mes_example_mode=disabled"
        : `skipped: mes_example_mode=once, not first turn (${context.chat.recentMessages.length} messages)`,
    };
  }

  const isDepthMode = mode === "depth";
  const layer = makeLayer({
    id: PROMPT_LAYER_ID.mesExample,
    sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
    sourceId: context.character.id,
    sourceName: `${context.character.name} — Examples`,
    priority: PROMPT_LAYER_PRIORITY.mesExample,
    reason: isDepthMode ? `included (depth mode, depth=${context.character.mesExampleDepth ?? 4})` : isFirstTurn ? "included" : "included (always mode)",
    text: PROMPT_FORMAT.exampleMessages(context.character.mesExample),
  });
  layer.subPosition = resolver.rank("dialogueExamples", DEFAULT_PROMPT_ORDER.dialogueExamples);
  layer.position = "in_chat";
  layer.injectionDepth = isDepthMode ? (context.character.mesExampleDepth ?? 4) : 0;
  return { layer: resolver.position(layer, "dialogueExamples"), droppedReason: null };
}

/**
 * Sort layers by position first (`before_prompt` < `in_prompt` < `in_chat` < `hidden_system`),
 * then by priority **descending** within the same position group.
 */
export function sortLayers(layers: PromptLayer[]): PromptLayer[] {
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
      pronouns: context.persona?.pronouns ?? null,
      pronounForms: context.persona?.pronounForms ?? null,
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
    aiAssistant: context.aiAssistant ? {
      ...context.aiAssistant,
      systemPrompt: applyMacros(context.aiAssistant.systemPrompt, variableContext),
      instruction: applyMacros(context.aiAssistant.instruction, variableContext),
      existingContent: context.aiAssistant.existingContent != null ? applyMacros(context.aiAssistant.existingContent, variableContext) : context.aiAssistant.existingContent,
    } : context.aiAssistant,
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
 *  4. **Sorting** — order by position, then priority descending
 *  5. **Assembly** — build the final `messages` array, interleaving depth-aware
 *     `in_chat` layers into the history
 */
export function assemblePrompt(rawContext: PromptAssemblyContext): PromptAssemblyResult {
  const context = applyMacrosToContext(rawContext);
  // The resolver encodes the simple/advanced mode decision once and is shared
  // by both assembly stages so the mode never has to be re-derived downstream.
  const resolver = createResolver(context.preset);
  return finalizeAssembly(context, buildLayers(context, resolver), resolver);
}

/** Pure summary-specific entry point. The caller supplies the same complete
 * prepared state as a chat turn; only the final visibility selection differs. */
export function assembleSummaryPrompt(rawContext: PromptAssemblyContext): PromptAssemblyResult {
  const context = applyMacrosToContext({ ...rawContext, config: { ...rawContext.config, summary: true } });
  const resolver = createResolver(context.preset);
  const built = buildLayers(context, resolver);
  return finalizeAssembly(context, {
    ...built,
    layers: built.layers.filter((layer) => SUMMARY_LAYER_IDS.has(layer.id)),
  }, resolver);
}

/**
 * Pure insights-specific entry point (INSIGHTS_PLAN INS-3c). The caller supplies
 * the same prepared state as a chat turn — character / persona / activated lore
 * / script injections / recent window — and this builds the full RP world context
 * the insight model needs to evaluate the conversation, then includes the resolved
 * instruction as a budgeted depth-zero layer and final user message. The insight
 * model sees what the main model sees, under the SAME preset toggles (examples, lore activation,
 * authorsNote all follow the chat's config — no insight-specific policy).
 *
 * The ONE filter: strip the insight self-injection layers (`objectiveTask` /
 * `sceneState`). They are main-model steering layers — including `objectiveTask`
 * here would duplicate the instruction (which already names the active task),
 * and `sceneState` would add scene noise to the very model judging it. The
 * caller also omits those context fields, so this filter is defensive.
 */
export function assembleInsightsPrompt(
  rawContext: PromptAssemblyContext,
  instruction: string,
): PromptAssemblyResult {
  const context = applyMacrosToContext(rawContext);
  const resolver = createResolver(context.preset);
  const trimmedInstruction = instruction.trim();
  const instructionLayer = trimmedInstruction ? makeLayer({
    id: PROMPT_LAYER_ID.insightsInstruction,
    sourceType: PROMPT_LAYER_SOURCE_TYPE.insightsInstruction,
    sourceId: context.identity.chatId,
    sourceName: "Insights Instruction",
    position: "in_chat",
    priority: PROMPT_LAYER_PRIORITY.insightsInstruction,
    role: "user",
    reason: "included as the final budgeted insights instruction",
    text: trimmedInstruction,
  }) : null;
  if (instructionLayer) instructionLayer.injectionDepth = 0;

  // Seed the instruction before buildLayers plans history compaction. This
  // makes its tokens part of the non-history budget rather than appending an
  // unaccounted message after finalization.
  const built = buildLayers(context, resolver, instructionLayer ? [instructionLayer] : []);
  const layers = built.layers.filter(
    (layer) => layer.id !== PROMPT_LAYER_ID.objectiveTask && layer.id !== PROMPT_LAYER_ID.sceneState,
  );
  return finalizeAssembly(context, { ...built, layers }, resolver);
}

/**
 * Stage 2 — create a PromptLayer for every non-empty content source.
 *
 * The single mode-sensitive stage of the pipeline: simple and advanced modes
 * diverge here (see SimpleResolver/AdvancedResolver). Callers may seed endpoint-
 * owned layers that must participate in the budget before ordinary layer creation.
 * Compaction also runs here because it depends on non-history layer tokens and
 * feeds the chatHistory layer. Returns layers + droppedLayers + compactionSummary
 * for finalizeAssembly.
 */
function buildLayers(
  context: PromptAssemblyContext,
  resolver: PositionResolver,
  initialLayers: PromptLayer[] = [],
): {
  layers: PromptLayer[];
  droppedLayers: Array<{ id: string; reason: string }>;
  compactionSummary: string | undefined;
  recentMessagesForHistory: PromptAssemblyContext["chat"]["recentMessages"];
} {
  const layers: PromptLayer[] = [...initialLayers];
  const droppedLayers: Array<{ id: string; reason: string }> = [];

  // System prompt: character override takes priority over preset
  const effectiveSystemPrompt = context.character.systemPrompt?.trim() || context.preset?.text?.trim();
  if (effectiveSystemPrompt && resolver.enabled("main")) {
    const isOverride = !!context.character.systemPrompt?.trim();
    layers.push(
      resolver.position(makeLayer({
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
  if (effectiveJailbreak && resolver.enabled("jailbreak")) {
    const isOverride = !!context.character.postHistoryInstructions?.trim();
    const layer = resolver.position(makeLayer({
      id: PROMPT_LAYER_ID.promptPresetJailbreak,
      sourceType: isOverride ? PROMPT_LAYER_SOURCE_TYPE.character : PROMPT_LAYER_SOURCE_TYPE.promptPreset,
      sourceId: isOverride ? context.character.id : context.preset!.id,
      sourceName: isOverride ? `${context.character.name} (Post-History Override)` : "Post-History Instructions",
      position: "in_chat",
      priority: PROMPT_LAYER_PRIORITY.promptPresetJailbreak,
      text: effectiveJailbreak,
    }), "jailbreak");
    if (layer.position === "in_chat" && layer.injectionDepth == null) layer.injectionDepth = 0;
    layers.push(layer);
  }

  const authorsNoteLayer = context.preset ? buildAuthorsNoteLayer(context.preset, resolver) : null;
  if (authorsNoteLayer) layers.push(authorsNoteLayer);

  // Enhance Definitions — built-in ST prompt block (disabled by default, content-driven)
  if (context.preset?.enhanceDefinitions?.trim() && resolver.enabled("enhanceDefinitions")) {
    const layer = resolver.position(makeLayer({
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
  if (context.preset?.nsfw?.trim() && resolver.enabled("nsfw")) {
    const layer = resolver.position(makeLayer({
      id: PROMPT_LAYER_ID.promptPresetNsfw,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
      sourceId: context.preset.id,
      sourceName: "NSFW",
      priority: PROMPT_LAYER_PRIORITY.presetNsfw,
      text: context.preset.nsfw,
    }), "nsfw");
    layers.push(layer);
  }

  // Custom injections: advanced mode ONLY. In simple mode the preset still
  // STORES them (preset is a 2-in-1 container), but they do not participate in
  // assembly — the user cannot author them in simple mode and they would
  // duplicate the preset's 4 basic fields (main/jailbreak/authorsNote/prefill).
  layers.push(...buildCustomInjectionLayers(context.preset, resolver));

  if (context.preset?.summary?.trim() && context.config?.summary) {
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
  if (characterBase && resolver.enabled("charDescription")) {
    layers.push(
      resolver.position(makeLayer({
        id: PROMPT_LAYER_ID.characterBase,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
        sourceId: context.character.id,
        sourceName: context.character.name,
        priority: PROMPT_LAYER_PRIORITY.characterBase,
        subPosition: resolver.rank("charDescription", IN_PROMPT_SUB_POSITION.charDesc),
        text: characterBase,
      }), "charDescription"),
    );
  }

  if (context.character.scenario?.trim() && resolver.enabled("scenario")) {
    layers.push(
      resolver.position(makeLayer({
        id: PROMPT_LAYER_ID.characterScenario,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
        sourceId: context.character.id,
        sourceName: `${context.character.name} — Scenario`,
        priority: PROMPT_LAYER_PRIORITY.characterScenario,
        subPosition: resolver.rank("scenario", IN_PROMPT_SUB_POSITION.charDesc),
        text: PROMPT_FORMAT.scenarioHeader(context.character.scenario),
      }), "scenario"),
    );
  }

  if (context.character.personality?.trim() && resolver.enabled("charPersonality")) {
    layers.push(
      resolver.position(makeLayer({
        id: PROMPT_LAYER_ID.characterPersonality,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.character,
        sourceId: context.character.id,
        sourceName: context.character.name,
        priority: PROMPT_LAYER_PRIORITY.characterPersonality,
        subPosition: resolver.rank("charPersonality", IN_PROMPT_SUB_POSITION.charDesc),
        text: context.character.personality,
      }), "charPersonality"),
    );
  }

  // ─── Media injection (A7) — character avatar/gallery appearance blocks ───
  // Text-only layers sourced from vision-generated descriptions. Both route
  // through resolver.position() with their DEFAULT_PROMPT_ORDER rank so they
  // land in before_chat and honour advanced-mode canvas toggles/overrides.
  if (context.character.includeAvatarInPrompt && context.character.avatarDescription?.trim() && resolver.enabled("characterAvatar")) {
    layers.push(
      resolver.position(makeLayer({
        id: PROMPT_LAYER_ID.characterAvatar,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.characterAvatar,
        sourceId: context.character.id,
        sourceName: `${context.character.name} — Appearance`,
        priority: PROMPT_LAYER_PRIORITY.characterAvatar,
        subPosition: resolver.rank("characterAvatar", DEFAULT_PROMPT_ORDER.characterAvatar),
        text: `[Character appearance: ${context.character.avatarDescription.trim()}]`,
      }), "characterAvatar"),
    );
  }

  if (context.character.gallery?.length && resolver.enabled("characterGallery")) {
    // Per-image include is the sole gate now (no character-level master
    // switch); the caller already pre-filters to described, opted-in rows.
    const galleryText = context.character.gallery
      .map((g) => `Image "${g.caption}": ${g.description}`)
      .join("\n");
    layers.push(
      resolver.position(makeLayer({
        id: PROMPT_LAYER_ID.characterGallery,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.characterGallery,
        sourceId: context.character.id,
        sourceName: `${context.character.name} — Reference Images`,
        priority: PROMPT_LAYER_PRIORITY.characterGallery,
        subPosition: resolver.rank("characterGallery", DEFAULT_PROMPT_ORDER.characterGallery),
        text: `[Character references:\n${galleryText}]`,
      }), "characterGallery"),
    );
  }

  if (context.persona?.description?.trim() && resolver.enabled("personaDescription")) {
    layers.push(
      resolver.position(makeLayer({
        id: PROMPT_LAYER_ID.persona,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.persona,
        sourceId: context.persona.id,
        sourceName: context.persona.name,
        priority: PROMPT_LAYER_PRIORITY.persona,
        subPosition: resolver.rank("personaDescription", DEFAULT_PROMPT_ORDER.personaDescription),
        text: PROMPT_FORMAT.personaBlock(context.persona.name, context.persona.description, context.persona.pronouns),
      }), "personaDescription"),
    );
  }

  // ─── Media injection (A7) — persona avatar appearance block ───────────
  // Mirrors the character avatar layer. Sits right after the persona block so
  // the persona's appearance reads as part of the user's identity.
  if (context.persona?.includeAvatarInPrompt && context.persona.avatarDescription?.trim() && resolver.enabled("personaAvatar")) {
    layers.push(
      resolver.position(makeLayer({
        id: PROMPT_LAYER_ID.personaAvatar,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.personaAvatar,
        sourceId: context.persona.id,
        sourceName: `${context.persona.name} — Appearance`,
        priority: PROMPT_LAYER_PRIORITY.personaAvatar,
        subPosition: resolver.rank("personaAvatar", DEFAULT_PROMPT_ORDER.personaAvatar),
        text: `[Persona appearance: ${context.persona.avatarDescription.trim()}]`,
      }), "personaAvatar"),
    );
  }

  const loreResult = buildLoreLayers({ lore: context.lore, resolver });
  layers.push(...loreResult.layers);
  droppedLayers.push(...loreResult.droppedLayers);

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

  // Insights — Objective Tracker (INSIGHTS_PLAN): inject the active task as an
  // `in_chat` layer at priority 180, default depth 1 (just before the latest
  // user message) so the model sees the current objective as the thing to do
  // now. Absent entirely when objective is off or there is no active task.
  // Mirrors the authorsNote / custom-injection depth pattern: the layer is built
  // `in_chat`, then injectionDepth is assigned post-hoc on the mutable layer.
  if (context.objectiveTask) {
    const task = context.objectiveTask;
    const objectiveLayer = makeLayer({
      id: PROMPT_LAYER_ID.objectiveTask,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.objectiveTask,
      sourceId: PROMPT_LAYER_ID.objectiveTask,
      sourceName: "Objective Task",
      position: "in_chat",
      priority: PROMPT_LAYER_PRIORITY.objectiveTask,
      text: PROMPT_FORMAT.objectiveTask(task.injectPrompt, task.description),
    });
    objectiveLayer.injectionDepth = Math.max(0, task.injectionDepth ?? 1);
    layers.push(objectiveLayer);
  }

  // Insights — Scene Tracker (SCENE_TRACKER_PLAN SCN-7): inject the last N
  // validated scene states as a single `in_chat` layer at priority 175 (just
  // before the objective layer at 180), at the configured depth. The entries are
  // already oldest→newest and freshness-filtered by the service; this block only
  // serializes (JSON/XML) and wraps them. Absent entirely when the tracker is
  // off or there is no valid scene to inject. Mirrors the objectiveTask depth
  // pattern: built `in_chat`, depth assigned post-hoc on the mutable layer.
  if (context.sceneState) {
    const scene = context.sceneState;
    const body = formatSceneHistory(scene.entries, scene.format);
    const lead = scene.injectPrompt.trim();
    const text = lead ? `${lead}\n${PROMPT_FORMAT.sceneState(body)}` : PROMPT_FORMAT.sceneState(body);
    const sceneLayer = makeLayer({
      id: PROMPT_LAYER_ID.sceneState,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.sceneState,
      sourceId: PROMPT_LAYER_ID.sceneState,
      sourceName: "Scene State",
      position: "in_chat",
      priority: PROMPT_LAYER_PRIORITY.sceneState,
      text,
    });
    sceneLayer.injectionDepth = Math.max(0, scene.injectionDepth ?? 1);
    layers.push(sceneLayer);
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

  const mesExample = buildMesExample(context, resolver);
  if (mesExample.layer) layers.push(mesExample.layer);
  if (mesExample.droppedReason) {
    droppedLayers.push({ id: PROMPT_LAYER_ID.mesExample, reason: mesExample.droppedReason });
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

  // All non-history layers must exist before planning. The planner measures the
  // exact formatted history suffix, including role labels and separators.
  const compactionPlan = planHistoryCompaction({
    messages: context.chat.recentMessages,
    nonHistoryTokens: layers.reduce((sum, layer) => sum + layer.tokenCount, 0),
    contextBudget: context.config?.contextBudget,
    responseReserve: context.config?.responseReserve,
    countHistoryTokens: (messages) => estimateTokens(formatRecentMessages([...messages])),
  });
  if (compactionPlan) {
    recentMessagesForHistory = compactionPlan.messages;
    compactionSummary =
      `Kept ${recentMessagesForHistory.length} of ` +
      `${context.chat.recentMessages.length} recent messages ` +
      `(~${compactionPlan.preservedHistoryTokens} tokens after compaction, ` +
      `${compactionPlan.totalBeforeCompaction} tokens before, ` +
      `budget ${context.config?.contextBudget}, ` +
      `responseReserve ${compactionPlan.responseReserve}).`;
  }

  const historyText = formatRecentMessages(recentMessagesForHistory);
  if (historyText && resolver.enabled("chatHistory")) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.recentHistory,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.chatHistory,
        sourceId: context.identity.chatId,
        sourceName: "Chat History",
        priority: PROMPT_LAYER_PRIORITY.recentHistory,
        subPosition: resolver.rank("chatHistory", DEFAULT_PROMPT_ORDER.chatHistory),
        text: historyText,
      }),
    );
  }

  return { layers, droppedLayers, compactionSummary, recentMessagesForHistory };
}

/**
 * Stages 3–5 — sort and compaction-aware messages assembly.
 *
 * Operates purely on the RP-chat PromptLayer[] from buildLayers; the resolver
 * remains the sole simple/advanced axis.
 */
function finalizeAssembly(
  context: PromptAssemblyContext,
  built: { layers: PromptLayer[]; droppedLayers: Array<{ id: string; reason: string }>; compactionSummary: string | undefined; recentMessagesForHistory: PromptAssemblyContext["chat"]["recentMessages"] },
  resolver: PositionResolver,
): PromptAssemblyResult {
  const { layers, droppedLayers, compactionSummary, recentMessagesForHistory } = built;

  const orderedLayers = sortLayers(layers).filter((layer) => layer.text.length > 0);
  const totalTokenEstimate = orderedLayers.reduce((sum, layer) => sum + layer.tokenCount, 0);

  logger.debug(`${orderedLayers.length} layers, ${totalTokenEstimate} tokens estimated`);
  for (const layer of orderedLayers) {
    logger.debug(`  [layer] ${layer.id} | ${layer.sourceType} | pos=${layer.position} | pri=${layer.priority} | tokens=${layer.tokenCount} | len=${layer.text.length} | text=${layer.text.slice(0, 80).replace(/\n/g, '↵')}...`);
  }
  if (droppedLayers.length > 0) {
    logger.debug(`${droppedLayers.length} dropped layers:`);
    for (const d of droppedLayers) {
      logger.debug(`  [dropped] ${d.id} | reason=${d.reason}`);
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
      // An insight one-shot has one endpoint-owned depth-zero user layer that
      // must remain after every history and steering message. Keep this
      // semantic guarantee explicit rather than relying on incidental numeric
      // priorities shared with ordinary prompt layers.
      const aIsInsightsInstruction = a.id === PROMPT_LAYER_ID.insightsInstruction;
      const bIsInsightsInstruction = b.id === PROMPT_LAYER_ID.insightsInstruction;
      if (aIsInsightsInstruction !== bIsInsightsInstruction) return aIsInsightsInstruction ? 1 : -1;
      // Same depth: resolve in ascending canvas (subPosition) order. The
      // splice index below RECOMPUTES as history grows, so a forward sort
      // yields forward payload order. (A prior DESC tiebreaker assumed a
      // fixed splice index and inverted same-depth injects.)
      const subDiff = (a.subPosition ?? a.priority) - (b.subPosition ?? b.priority);
      if (subDiff !== 0) return subDiff;
      if (a.insertionOrder != null && b.insertionOrder != null && a.insertionOrder !== b.insertionOrder) {
        return a.insertionOrder - b.insertionOrder;
      }
      return a.priority - b.priority;
    }); // deepest first; same-depth ties resolve in ascending canvas order
  // in_chat layers WITHOUT a depth are collected into a single block placed before history.
  const inChatBlock = inChat.filter((l) => typeof l.injectionDepth !== "number");

  // Build history messages
  const historyMessages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    messageId?: string;
    layerId?: string;
    attachments?: RecentMessage["attachments"];
  }> = resolver.enabled("chatHistory")
    ? recentMessagesForHistory.map((message) => ({
        role: message.role as "system" | "user" | "assistant" | "tool",
        content: message.content,
        messageId: message.id,
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
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
    prefill: (context.preset?.prefill && resolver.enabled("assistantPrefill")) ? context.preset.prefill : null,
    compactionSummary: compactionSummary ?? null,
  };
}

/**
 * Simplified assembly path for AI assistant modes.
 *
 * Builds a minimal set of layers: system prompt → context (character/persona/lore) →
 * existing content → user instruction. No chat history, no preset prompt order,
 * no jailbreak/NSFW — just a clean assistant conversation.
 *
 * The `aiAssistant.enabledLayers` field controls which context layers are included.
 * System, existing, and instruction layers are always on.
 */

