import type { CustomInjection, PromptSlot, PromptZone } from "./api-types.js";

/**
 * Migrate a CustomInjection that lacks `slot` into the new unified position model.
 * Returns the same reference if `slot` is already present.
 */
export function migrateInjection(inj: CustomInjection): CustomInjection & { slot: PromptSlot } {
  if (inj.slot) return inj as CustomInjection & { slot: PromptSlot };

  const isAbsolute =
    inj.injectionPosition === 1 ||
    inj.injectionPosition === "absolute" ||
    inj.injectionPosition == null;

  const rawDepth = inj.depth ?? 0;
  const placement = inj.promptOrderPlacement ?? "before_chat";

  let zone: PromptZone;
  let depth: number | null;

  if (isAbsolute && rawDepth > 0) {
    // Absolute injection with depth > 0 → inside chat history
    zone = "in_chat";
    depth = rawDepth;
  } else if (placement === "after_chat" || (isAbsolute && rawDepth === 0)) {
    // depth=0 or explicitly after_chat → after chat zone
    zone = "after_chat";
    depth = null;
  } else {
    // Relative position, before chatHistory marker
    zone = "before_chat";
    depth = null;
  }

  return {
    ...inj,
    slot: {
      zone,
      depth,
      // Relative blocks (pos=0): promptOrderIndex is the real ordering from the
      // ST prompt_order array. Absolute blocks (pos=1): injectionOrder matters.
      // ST presets often set injectionOrder=100 for all relative blocks, so we
      // must prefer promptOrderIndex when available for relative-position blocks.
      order: isAbsolute
        ? (inj.injectionOrder ?? inj.promptOrderIndex ?? 0)
        : (inj.promptOrderIndex ?? inj.injectionOrder ?? 0),
    },
  };
}

/**
 * Reverse-map a PromptSlot back to SillyTavern-compatible fields for export.
 */
export function slotToStFields(slot: PromptSlot): {
  injection_position: 0 | 1;
  injection_depth: number;
  injection_order: number;
} {
  if (slot.zone === "in_chat") {
    return {
      injection_position: 1,
      injection_depth: slot.depth ?? 0,
      injection_order: slot.order,
    };
  }
  // before_chat and after_chat both map to ST position 0
  return {
    injection_position: 0,
    injection_depth: 0,
    injection_order: slot.order,
  };
}
