/**
 * Advanced-mode {@link PositionResolver}.
 *
 * The canvas (`preset.promptOrder`) is the single source of truth for
 * ordering, enabled state, and zones. Each built-in identifier is looked up in
 * the canvas entries; when an entry omits `zone`, it is inferred via
 * `inferSlot` (single source of truth for zone inference).
 *
 * The one non-canvas rule is `chatHistory` being un-disablable — it carries
 * container markup for precise inject-depth placement, so a canvas toggle of
 * `enabled: false` is ignored (matches SillyTavern's behavior except ST allows
 * disabling history, which we intentionally reject).
 */

import { DEFAULT_PROMPT_ORDER, inferSlot } from "@vibe-tavern/domain";
import type { PromptZone } from "@vibe-tavern/domain";
import type { PromptLayer } from "../types.js";
import type { PositionResolver, ResolverPromptOrderEntry } from "./position-resolver.js";

/**
 * Apply canvas zone + order to a layer. When the canvas entry is absent or has
 * no `zone`, infer one from the default order; when it has no `order`, use the
 * default. This is the advanced-mode counterpart of `applyDefaultPosition`.
 */
function applyCanvasPosition(
  layer: PromptLayer,
  entry: ResolverPromptOrderEntry | undefined,
  identifier: string,
): PromptLayer {
  const zone: PromptZone | undefined =
    entry?.zone ?? inferSlot({ defaultOrder: DEFAULT_PROMPT_ORDER[identifier] }).zone;
  const order = entry?.order ?? DEFAULT_PROMPT_ORDER[identifier] ?? 10_000;
  const depth = entry?.depth ?? undefined;

  layer.subPosition = order;
  if (zone === "after_chat") {
    layer.position = "in_chat";
    layer.injectionDepth = 0;
  } else if (zone === "in_chat") {
    layer.position = "in_chat";
    layer.injectionDepth = depth ?? 0;
  } else {
    // before_chat
    layer.position = "in_prompt";
    delete layer.injectionDepth;
  }
  return layer;
}

export function createAdvancedResolver(entries: ResolverPromptOrderEntry[]): PositionResolver {
  const entryFor = (identifier: string) => entries.find((e) => e.identifier === identifier);

  return {
    // chatHistory is always enabled (depth markup); every other built-in slot
    // honors its canvas `enabled` flag, defaulting to enabled when absent.
    enabled: (identifier) =>
      identifier === "chatHistory" ? true : (entryFor(identifier)?.enabled ?? true),

    // Canvas order wins; absent canvas order falls back to the provided
    // fallback, then DEFAULT_PROMPT_ORDER, then 10_000 (after chatHistory).
    rank: (identifier, fallback) =>
      entryFor(identifier)?.order ?? fallback ?? DEFAULT_PROMPT_ORDER[identifier] ?? 10_000,

    // Apply the canvas zone/order (inferred when the entry is partial).
    position: (layer, identifier) => applyCanvasPosition(layer, entryFor(identifier), identifier),

    // Custom injections ARE assembled in advanced mode (canvas-driven).
    includeCustomInjections: true,

    // Hand the raw canvas entry to the lore block so it can place the WI layer.
    worldInfoEntry: (identifier) => entryFor(identifier),
  };
}
