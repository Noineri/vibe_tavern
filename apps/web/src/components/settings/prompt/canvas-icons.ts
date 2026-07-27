/**
 * Slot-category iconography for the prompt-order canvas (APC-3a).
 *
 * Every canvas row belongs to one of five categories. The category drives the
 * header icon (so a glance at the canvas shows what *kind* of context each row
 * injects) and the legend at the top of the canvas (APC-3c). The mapping is
 * purely visual metadata — it does not affect assembly or ordering.
 *
 *   custom    — user-added prompt block (injection)            → plus-in-frame
 *   standard  — built-in editable prompt field                  → terminal
 *   character — a character-card field (description/persona/etc)→ user
 *   anchor    — a lorebook anchor (worldInfo before/after)      → book + anchor
 *   persona   — the user-persona description                     → circle-user
 *
 * The registry is intentionally a separate module from `CanvasCard.tsx`
 * (APC-3b) and `build-fixed-items.tsx` so both can import it without a cycle,
 * and so the legend (APC-3c) can render every category from one source.
 */
import type { ReactNode } from "react";
import { Ic } from "../../shared/icons.js";

export type SlotCategory = "custom" | "standard" | "character" | "anchor" | "persona";

/** Category → icon renderer. Each entry is a zero-arg `Ic` glyph. */
export const SLOT_CATEGORY_ICON: Record<SlotCategory, () => ReactNode> = {
  custom: Ic.plusInFrame,
  standard: Ic.terminal,
  character: Ic.user,
  anchor: Ic.loreAnchor,
  persona: Ic.circleUser,
};

/** Identifiers whose content originates from the character card. */
const CHARACTER_IDS = new Set([
  "charDescription",
  "charPersonality",
  "scenario",
  "dialogueExamples",
  "charSystemPrompt",
  "charPostHistory",
  "charDepthPrompt",
]);

/** Lorebook anchor positions — bound worldInfo injected before/after chat. */
const ANCHOR_IDS = new Set(["worldInfoBefore", "worldInfoAfter"]);

/** The single user-persona description slot. */
const PERSONA_IDS = new Set(["personaDescription"]);

/** Built-in editable prompt fields (the preset's own text blocks). */
const STANDARD_IDS = new Set([
  "main",
  "jailbreak",
  "nsfw",
  "enhanceDefinitions",
  "authorsNote",
  "assistantPrefill",
]);

/**
 * Resolve a canvas row's category from its identifier. Any identifier not in
 * the built-in sets is a custom injection (the `custom` category) — this is the
 * fallback, so newly-added custom blocks need no registry change.
 */
export function slotCategoryFor(identifier: string): SlotCategory {
  if (ANCHOR_IDS.has(identifier)) return "anchor";
  if (PERSONA_IDS.has(identifier)) return "persona";
  if (CHARACTER_IDS.has(identifier)) return "character";
  if (STANDARD_IDS.has(identifier)) return "standard";
  return "custom";
}

/** Convenience: identifier → icon renderer (category lookup + registry). */
export function slotCategoryIcon(identifier: string): () => ReactNode {
  return SLOT_CATEGORY_ICON[slotCategoryFor(identifier)];
}
