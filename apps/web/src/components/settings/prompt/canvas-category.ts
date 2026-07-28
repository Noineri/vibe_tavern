/**
 * Visual category metadata for the prompt-order canvas.
 *
 * Categories use the existing theme semantic background tokens rather than
 * fixed hues: character/persona → accent, lore anchors → success, chat-owned
 * context → info, custom injections → warning, and preset fields → surface.
 * No category icons or legend are rendered; labels remain the textual source
 * of truth while the pale fill provides fast visual grouping.
 */
export type SlotCategory = "custom" | "standard" | "character" | "anchor" | "persona" | "chatDynamic" | "summary";

/** Category → existing theme-aware background utility. */
export const SLOT_CATEGORY_BACKGROUND: Record<SlotCategory, string> = {
  custom: "bg-warning-dim",
  standard: "bg-surface",
  character: "bg-accent-dim",
  anchor: "bg-success-dim",
  persona: "bg-accent-dim",
  chatDynamic: "bg-info-dim",
  summary: "bg-info-dim",
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

/** Per-chat dynamic prompt (Wave 6) — content lives on the Chat row, not the preset. */
const CHAT_DYNAMIC_IDS = new Set(["chatDynamicPrompt"]);

/** Summary memory anchor (Wave 6) — read-only blocks from chat-summaries. */
const SUMMARY_IDS = new Set(["chatSummary"]);

/**
 * Resolve a canvas row's category from its identifier. Any identifier not in
 * the built-in sets is a custom injection (the `custom` category) — this is the
 * fallback, so newly-added custom blocks need no registry change.
 */
export function slotCategoryFor(identifier: string): SlotCategory {
  if (ANCHOR_IDS.has(identifier)) return "anchor";
  if (PERSONA_IDS.has(identifier)) return "persona";
  if (CHARACTER_IDS.has(identifier)) return "character";
  if (CHAT_DYNAMIC_IDS.has(identifier)) return "chatDynamic";
  if (SUMMARY_IDS.has(identifier)) return "summary";
  if (STANDARD_IDS.has(identifier)) return "standard";
  return "custom";
}
