import { inferSlot, DEFAULT_PROMPT_ORDER } from "@vibe-tavern/domain";
import { estimateTokens } from "./compaction.js";
import {
  IN_PROMPT_SUB_POSITION,
  PROMPT_FORMAT,
  PROMPT_LAYER_REASON,
  PROMPT_LAYER_SOURCE_TYPE,
  createLoreLayerId,
} from "./prompt-layer-constants.js";
import type { PromptAssemblyContext, PromptLayer, PromptLayerPosition } from "./types.js";
import type { PositionResolver } from "./resolvers/position-resolver.js";

export interface LoreLayerBuildResult {
  layers: PromptLayer[];
  droppedLayers: Array<{ id: string; reason: string }>;
}

function joinNonEmpty(parts: Array<string | null | undefined>): string {
  return parts.map((part) => part?.trim() ?? "").filter(Boolean).join("\n");
}

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
      if (!worldInfoIdentifier) return fallbackSubPosition;
      return resolver.rank(worldInfoIdentifier, DEFAULT_PROMPT_ORDER[worldInfoIdentifier] ?? fallbackSubPosition);
  }
}

function resolveLorePosition(position: string | undefined): PromptLayerPosition {
  switch (position) {
    case "before_char":
    case "after_char":
    case "before_examples":
    case "after_examples":
    case "top_an":
    case "bottom_an":
      return "in_prompt";
    case "at_depth":
      return "in_chat";
    case "outlet":
      return "hidden_system";
    case "before_prompt":
      return "before_prompt";
    case "in_prompt":
      return "in_prompt";
    case "in_chat":
      return "in_chat";
    case "hidden_system":
      return "hidden_system";
    default:
      return "in_prompt";
  }
}

function fallbackLoreSubPosition(position: string | undefined): number | undefined {
  switch (position) {
    case "after_char":
      return IN_PROMPT_SUB_POSITION.afterChar;
    case "top_an":
      return IN_PROMPT_SUB_POSITION.beforeAuthorNote;
    case "bottom_an":
      return IN_PROMPT_SUB_POSITION.afterAuthorNote;
    case "before_examples":
      return IN_PROMPT_SUB_POSITION.beforeExamples;
    case "after_examples":
      return IN_PROMPT_SUB_POSITION.afterExamples;
    default:
      return undefined;
  }
}

/** Maps activated lore entries to prompt layers while preserving ST positions. */
export function buildLoreLayers(input: {
  lore: PromptAssemblyContext["lore"];
  resolver: PositionResolver;
}): LoreLayerBuildResult {
  const layers: PromptLayer[] = [];
  const droppedLayers: Array<{ id: string; reason: string }> = [];

  for (const loreEntry of input.lore ?? []) {
    if (!loreEntry.content.trim()) {
      droppedLayers.push({ id: loreEntry.id, reason: PROMPT_LAYER_REASON.emptyLoreContent });
      continue;
    }

    const worldInfoIdentifier = loreEntry.position === "before_char"
      ? "worldInfoBefore"
      : loreEntry.position === "after_char" ? "worldInfoAfter" : null;
    if (worldInfoIdentifier && !input.resolver.enabled(worldInfoIdentifier)) {
      droppedLayers.push({ id: loreEntry.id, reason: `skipped: ${worldInfoIdentifier} disabled by prompt order` });
      continue;
    }

    const text = joinNonEmpty([
      loreEntry.title ? PROMPT_FORMAT.loreHeader(loreEntry.title) : null,
      loreEntry.content,
    ]);
    const subPosition = lorePromptSubPosition(
      input.resolver,
      loreEntry.position,
      worldInfoIdentifier,
      fallbackLoreSubPosition(loreEntry.position),
    );
    const layer: PromptLayer = {
      id: createLoreLayerId(loreEntry.id),
      sourceType: PROMPT_LAYER_SOURCE_TYPE.loreEntry,
      sourceId: loreEntry.id,
      sourceName: loreEntry.title || loreEntry.id,
      position: resolveLorePosition(loreEntry.position),
      priority: loreEntry.priority,
      enabled: true,
      reason: PROMPT_LAYER_REASON.activatedLoreEntry,
      tokenCount: estimateTokens(text),
      text: text.trim(),
      ...(loreEntry.role ? { role: loreEntry.role as "system" | "user" | "assistant" } : {}),
      ...(subPosition != null ? { subPosition } : {}),
      ...(loreEntry.sortOrder != null ? { insertionOrder: loreEntry.sortOrder } : {}),
    };

    if (worldInfoIdentifier) {
      const worldInfoOrderEntry = input.resolver.worldInfoEntry(worldInfoIdentifier);
      if (worldInfoOrderEntry?.zone && layer.position !== "hidden_system") {
        if (worldInfoOrderEntry.zone === "after_chat") {
          layer.position = "in_chat";
          layer.injectionDepth = 0;
        } else if (worldInfoOrderEntry.zone === "in_chat") {
          layer.position = "in_chat";
          layer.injectionDepth = worldInfoOrderEntry.depth ?? 0;
        }
      } else {
        const inferred = inferSlot({ defaultOrder: DEFAULT_PROMPT_ORDER[worldInfoIdentifier] });
        if (inferred.zone === "after_chat" && layer.position !== "hidden_system") {
          layer.position = "in_chat";
          layer.injectionDepth = 0;
        }
      }
    }

    if (loreEntry.position === "at_depth") {
      layer.position = "in_chat";
      layer.injectionDepth = loreEntry.depth ?? 4;
    }

    layers.push(layer);
  }

  return { layers, droppedLayers };
}
