/**
 * Simple-mode {@link PositionResolver}.
 *
 * No canvas: built-in slots are always enabled, ordered purely by
 * `DEFAULT_PROMPT_ORDER`. Custom injections are not assembled (the preset
 * retains them for switching back to advanced mode). Zone is inferred from the
 * default order relative to `chatHistory` (100): above it = before_chat, below
 * it = after_chat (= in_chat at depth 0). The author's note is NOT routed
 * through this resolver — it has its own flat position fields
 * (`authorsNotePosition`/`Depth`/`Role`) that apply in both modes.
 */

import { DEFAULT_PROMPT_ORDER } from "@vibe-tavern/domain";
import type { PromptLayer } from "../types.js";
import type { PositionResolver } from "./position-resolver.js";

/**
 * Position a layer using ONLY `DEFAULT_PROMPT_ORDER`.
 *   order > 100 (chatHistory) → after_chat ≡ in_chat depth 0
 *   order < 100               → before_chat (in_prompt)
 * Mirrors `inferSlot`'s defaultOrder branch without re-deriving through legacy
 * SillyTavern args.
 */
function applyDefaultPosition(layer: PromptLayer, defaultOrder: number): PromptLayer {
  layer.subPosition = defaultOrder;
  if (defaultOrder > DEFAULT_PROMPT_ORDER.chatHistory) {
    layer.position = "in_chat";
    layer.injectionDepth = 0;
  } else {
    layer.position = "in_prompt";
    delete layer.injectionDepth;
  }
  return layer;
}

export function createSimpleResolver(): PositionResolver {
  return {
    // No canvas toggles for built-in slots in simple mode; presence of non-empty
    // content is checked at the call site. (chatHistory is always-enabled in
    // both modes, handled identically by the advanced resolver too.)
    enabled: () => true,

    // Ignore canvas ordering — fall straight through to the default/fallback.
    rank: (identifier, fallback) => fallback ?? DEFAULT_PROMPT_ORDER[identifier] ?? 10_000,

    // No canvas zone — derive zone from the default order.
    position: (layer, identifier) =>
      applyDefaultPosition(layer, DEFAULT_PROMPT_ORDER[identifier] ?? 10_000),

    // Custom injections are stored but never assembled in simple mode.
    includeCustomInjections: false,

    // Canvas is not authoritative; the lore block falls through to default
    // world-info inference (worldInfoBefore/After default position).
    worldInfoEntry: () => undefined,
  };
}
