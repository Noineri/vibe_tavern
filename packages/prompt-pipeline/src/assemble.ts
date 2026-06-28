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
import { inferSlot, DEFAULT_PROMPT_ORDER } from "@vibe-tavern/domain";
import { createResolver, type PositionResolver } from "./resolvers/position-resolver.js";
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

/**
 * Compute a lore entry's subPosition relative to a built-in anchor slot
 * (authorsNote / dialogueExamples) or its world-info slot, via the resolver's
 * rank. Mode-blind: simple uses DEFAULT_PROMPT_ORDER, advanced uses the canvas.
 */
function lorePromptSubPosition(
  resolver: PositionResolver,
  lorePosition: string | undefined,
  worldInfoIdentifier: string | null,
  fallbackSubPosition: number | undefined,
): number | undefined {
  switch (lorePosition) {
    case "top_an":
      return resolver.rank("authorsNote") - 0.1;
    case "bottom_an":
      return resolver.rank("authorsNote") + 0.1;
    case "before_examples":
      return resolver.rank("dialogueExamples") - 0.1;
    case "after_examples":
      return resolver.rank("dialogueExamples") + 0.1;
    default:
      // Only before_char/after_char carry a worldInfoIdentifier. For
      // pipeline-native positions (in_prompt/in_chat/etc.) or anything else
      // without a marker, fall back to the resolved subPosition.
      if (!worldInfoIdentifier) return fallbackSubPosition;
      return resolver.rank(worldInfoIdentifier, DEFAULT_PROMPT_ORDER[worldInfoIdentifier] ?? fallbackSubPosition);
  }
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
 *  4. **Mode filtering** — drop layers not active for the current {@link AssemblyMode}
 *  5. **Sorting** — order by position, then priority descending
 *  6. **Assembly** — build the final `messages` array, interleaving depth-aware
 *     `in_chat` layers into the history
 */
export function assemblePrompt(rawContext: PromptAssemblyContext): PromptAssemblyResult {
  const context = applyMacrosToContext(rawContext);
  const effectiveMode: AssemblyMode = context.mode ?? "chat";

  // AI assistant mode has its own simplified assembly path
  if (effectiveMode === "ai_assistant") {
    return assembleAiAssistant(context);
  }

  // The resolver encodes the simple/advanced mode decision once and is shared
  // by both assembly stages so the mode never has to be re-derived downstream.
  const resolver = createResolver(context.preset);
  return finalizeAssembly(context, buildLayers(context, resolver), resolver);
}

/**
 * Stage 2 — create a PromptLayer for every non-empty content source.
 *
 * The single mode-sensitive stage of the pipeline: simple and advanced modes
 * diverge here (see SimpleResolver/AdvancedResolver). Compaction also runs here
 * because it depends on non-history layer tokens and feeds the chatHistory layer.
 * Returns layers + droppedLayers + compactionSummary for finalizeAssembly.
 */
function buildLayers(context: PromptAssemblyContext, resolver: PositionResolver): {
  layers: PromptLayer[];
  droppedLayers: Array<{ id: string; reason: string }>;
  compactionSummary: string | undefined;
  recentMessagesForHistory: PromptAssemblyContext["chat"]["recentMessages"];
} {
  const layers: PromptLayer[] = [];
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

  if (context.preset?.authorsNote?.trim() && resolver.enabled("authorsNote")) {
    const role = context.preset.authorsNoteRole ?? "system";
    const noteSubPosition = resolver.rank("authorsNote", DEFAULT_PROMPT_ORDER.authorsNote);

    if (context.preset.advancedMode) {
      // Advanced (canvas) mode: the canvas entry for "authorsNote" is the single
      // source of truth for zone/depth/order — exactly like every other built-in
      // slot, the note is routed through resolver.position(). The flat
      // authorsNotePosition/Depth fields are NOT consulted for placement here;
      // they stay persisted on the preset so switching back to simple mode
      // restores the user's dropdown choice. (Bug fix: previously the flat
      // fields were authoritative in BOTH modes, so dragging the note on the
      // canvas had no effect on its actual placement.)
      const layer = makeLayer({
        id: PROMPT_LAYER_ID.promptPresetAuthorsNote,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
        sourceId: context.preset.id,
        sourceName: "Author's Note",
        position: "in_prompt", // overwritten by resolver.position() per canvas zone
        priority: PROMPT_LAYER_PRIORITY.promptPresetAuthorsNote,
        role,
        subPosition: noteSubPosition,
        text: context.preset.authorsNote,
      });
      layers.push(resolver.position(layer, "authorsNote"));
    } else {
      // Simple mode: the flat position fields (authorsNotePosition/Depth) are
      // authoritative — they are what the simple-mode dropdown drives. The
      // resolver's position() would infer zone from DEFAULT_PROMPT_ORDER alone
      // (authorsNote=60 < chatHistory=100 → before_chat), silently dropping an
      // after_chat placement, so the note is NOT routed through the resolver
      // here. subPosition still comes from resolver.rank() for sort stability.
      const position = context.preset.authorsNotePosition ?? "in_chat";
      const depth = context.preset.authorsNoteDepth ?? 4;

      if (position === "in_prompt") {
        // Inside the system prompt block.
        layers.push(makeLayer({
          id: PROMPT_LAYER_ID.promptPresetAuthorsNote,
          sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
          sourceId: context.preset.id,
          sourceName: "Author's Note",
          position: "in_prompt",
          priority: PROMPT_LAYER_PRIORITY.promptPresetAuthorsNote,
          role,
          subPosition: noteSubPosition,
          text: context.preset.authorsNote,
        }));
      } else {
        // after_chat (depth=0) and in_chat (at `depth`) both land in the chat at a
        // numeric injectionDepth; the only difference is the depth value.
        const layer = makeLayer({
          id: PROMPT_LAYER_ID.promptPresetAuthorsNote,
          sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
          sourceId: context.preset.id,
          sourceName: position === "after_chat" ? "Author's Note" : "Author's Note (depth)",
          position: "in_chat",
          priority: PROMPT_LAYER_PRIORITY.promptPresetAuthorsNote,
          role,
          subPosition: noteSubPosition,
          text: context.preset.authorsNote,
        });
        layer.injectionDepth = position === "after_chat" ? 0 : depth;
        layers.push(layer);
      }
    }
  }

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
  if (resolver.includeCustomInjections) {
    // CANVAS_SINGLE_SOURCE_PLAN Wave 5: `customInjections` is content-only
    // ({identifier, name, content, role}). Positional + enabled state live on
    // the matching `PromptOrderEntry` in `promptOrder` — the canvas is the
    // single source of truth for assembly, mirroring the UI's single-read path.
    // `role` is content metadata (the assembled layer's message role), taken
    // from the injection — NOT the canvas (I12). D1: in_chat items carry
    // depth ≥ 1 so they never collide with after_chat (pinned at depth 0).
  // Skip built-in identifiers that are handled as dedicated fields (nsfw, enhanceDefinitions).
  const BUILTIN_FIELD_IDENTIFIERS = new Set(["nsfw", "enhanceDefinitions"]);
  for (const injection of (context.preset?.customInjections ?? [])) {
    if (!injection.content?.trim()) continue;
    if (BUILTIN_FIELD_IDENTIFIERS.has(injection.identifier ?? injection.name)) continue;

    const role = injection.role === "user" || injection.role === "assistant" ? injection.role : "system";
    const identifier = injection.identifier ?? injection.name;

    // Single canvas-lookup read path: enabled/zone/depth/order come ONLY from
    // the matching canvas entry. No canvas entry = skip (defensive —
    // normalizePresetCanvas in Wave 2 guarantees one per custom injection on
    // hydrate, so this only guards against hand-crafted/legacy input).
    const canvasEntry = context.preset?.promptOrder?.find(e => e.identifier === identifier);
    if (!canvasEntry?.enabled) continue;

    const zone = canvasEntry.zone;
    const depth = canvasEntry.depth ?? null;
    const order = canvasEntry.order;

    const layer = makeLayer({
      id: `preset_injection_${identifier}`,
      sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
      sourceId: context.preset?.id ?? "",
      sourceName: injection.name,
      position: zone === "before_chat" ? "in_prompt" : "in_chat",
      // priority omitted — custom injections always carry a subPosition, which
      // sortLayers/inChatWithDepth consult before priority (synthetic priority
      // would be dead weight). makeLayer defaults to 0.
      subPosition: resolver.rank(identifier, order),
      role,
      reason: `included (canvas zone=${zone}, depth=${depth ?? "-"}, order=${order})`,
      text: injection.content,
    });

    if (zone === "in_chat") {
      layer.injectionDepth = depth ?? 0;
    } else if (zone === "after_chat") {
      layer.injectionDepth = 0;
    }
    layers.push(layer);
  }
  } // end advanced-only custom injections

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

    // Only `before_char` and `after_char` map onto the worldInfoBefore /
    // worldInfoAfter prompt-order markers (matching ST: only position 0 →
    // WIBeforeEntries, only position 1 → WIAfterEntries). Other ST positions
    // (top_an, bottom_an, at_depth, before/after_examples, outlet) route to
    // their own slots and must NOT be dropped when a WI marker is disabled.
    // See lorebook-st-parity-audit.md §2.1.
    const worldInfoIdentifier = loreEntry.position === "before_char"
      ? "worldInfoBefore"
      : loreEntry.position === "after_char" ? "worldInfoAfter" : null;
    if (worldInfoIdentifier && !resolver.enabled(worldInfoIdentifier)) {
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
      subPosition: lorePromptSubPosition(resolver, loreEntry.position, worldInfoIdentifier, subPos),
      insertionOrder: loreEntry.sortOrder,
      reason: PROMPT_LAYER_REASON.activatedLoreEntry,
      text: joinNonEmpty([loreEntry.title ? PROMPT_FORMAT.loreHeader(loreEntry.title) : null, loreEntry.content]),
    });

    // Determine lore placement from the worldInfo slot's canvas zone.
    // The canvas stores { zone, order, depth } on each promptOrder entry.
    // Zone is the authoritative source of truth for where lore entries land —
    // but ONLY in advanced mode, and ONLY for before_char/after_char entries
    // (the two positions that map onto a WI marker). Other positions already
    // resolved to the right slot above and must not be overridden by the
    // marker's zone. Simple mode ignores the canvas entirely.
    if (worldInfoIdentifier) {
      const worldInfoOrderEntry = resolver.worldInfoEntry(worldInfoIdentifier);
      if (worldInfoOrderEntry?.zone && layer.position !== "hidden_system") {
        if (worldInfoOrderEntry.zone === "after_chat") {
          layer.position = "in_chat";
          layer.injectionDepth = 0;
        } else if (worldInfoOrderEntry.zone === "in_chat") {
          layer.position = "in_chat";
          layer.injectionDepth = worldInfoOrderEntry.depth ?? 0;
        }
        // "before_chat" stays in_prompt (default from resolvedPosition)
      } else {
        // Legacy/simple fallback: no canvas zone — infer from defaults
        const inferred = inferSlot({ defaultOrder: DEFAULT_PROMPT_ORDER[worldInfoIdentifier] });
        if (inferred.zone === "after_chat" && layer.position !== "hidden_system") {
          layer.position = "in_chat";
          layer.injectionDepth = 0;
        }
      }
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
        context.chat.recentMessages,
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

  if (context.character.mesExample?.trim() && resolver.enabled("dialogueExamples")) {
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

      layer.subPosition = resolver.rank("dialogueExamples", DEFAULT_PROMPT_ORDER.dialogueExamples);
      if (isDepthMode) {
        layer.position = "in_chat";
        layer.injectionDepth = depth;
      } else {
        // always/once: place after chat history (before jailbreak)
        // Higher priority than jailbreak (990) so examples come first
        layer.position = "in_chat";
        layer.injectionDepth = 0;
      }
      layers.push(resolver.position(layer, "dialogueExamples"));
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

  return { layers, droppedLayers, compactionSummary, recentMessagesForHistory };
}

/**
 * Stages 3–6 — mode filtering, sort, compaction-aware messages assembly.
 *
 * Mode-agnostic: operates purely on the PromptLayer[] from buildLayers.
 * `effectiveMode` here is the AssemblyMode axis (chat/continue/regenerate/...),
 * orthogonal to the preset simple/advanced axis resolved in buildLayers.
 */
function finalizeAssembly(
  context: PromptAssemblyContext,
  built: { layers: PromptLayer[]; droppedLayers: Array<{ id: string; reason: string }>; compactionSummary: string | undefined; recentMessagesForHistory: PromptAssemblyContext["chat"]["recentMessages"] },
  resolver: PositionResolver,
): PromptAssemblyResult {
  const { layers, droppedLayers, compactionSummary, recentMessagesForHistory } = built;
  const effectiveMode: AssemblyMode = context.mode ?? "chat";

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
function assembleAiAssistant(context: PromptAssemblyContext): PromptAssemblyResult {
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
