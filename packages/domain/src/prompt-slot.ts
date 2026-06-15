import type { CustomInjection, PromptSlot, PromptZone } from "./api-types.js";

// ─── Default prompt order (used only when no promptOrder data exists) ──────

export const DEFAULT_PROMPT_ORDER: Record<string, number> = {
  main: 0,
  worldInfoBefore: 10,
  personaDescription: 20,
  charDescription: 30,
  charPersonality: 40,
  scenario: 50,
  // Media injection (A7) — before chatHistory, after the character block.
  // All < 100 → before_chat zone. Auto-registers as canvas built-ins via
  // Object.keys(DEFAULT_PROMPT_ORDER) in prompt-canvas.ts.
  characterAvatar: 52,
  characterGallery: 54,
  personaAvatar: 56,
  authorsNote: 60,
  enhanceDefinitions: 70,
  nsfw: 75,
  worldInfoAfter: 80,
  dialogueExamples: 90,
  chatHistory: 100,
  jailbreak: 110,
};

/**
 * Infer a PromptSlot from legacy SillyTavern fields when no explicit zone is available.
 *
 * This is the single source of truth for zone inference. Used by:
 * - ST preset parser (st-preset-parser.ts)
 * - Canvas fallback (InjectionTable.getCanvasItemSlot)
 * - Backend fallback (assemble.ts AdvancedResolver, world-info zone inference)
 */
export function inferSlot(args: {
  /** SillyTavern injection_position: 0 = relative, 1 = absolute. `undefined`/`null` = no ST data — falls through to `placement`/`defaultOrder` inference (NOT treated as absolute). */
  injectionPosition?: number;
  /** Injection depth (messages from bottom of chat). */
  depth?: number;
  /** Derived from ST prompt_order: position relative to chatHistory marker. */
  placement?: "before_chat" | "after_chat";
  /** Flat order index from prompt_order array. */
  order?: number;
  /** Default order from DEFAULT_PROMPT_ORDER (for built-in identifiers). */
  defaultOrder?: number;
}): PromptSlot {
  // `injectionPosition == null` means "no SillyTavern data" — it does NOT mean
  // absolute. Only an explicit `1` selects the absolute/depth-based branch.
  // Callers without ST data (canvas fallback, built-in slots) must reach the
  // defaultOrder-relative branch below.
  const isAbsolute = args.injectionPosition === 1;
  const rawDepth = args.depth ?? 0;

  let zone: PromptZone;
  let depth: number | null;

  if (isAbsolute && rawDepth > 0) {
    zone = "in_chat";
    depth = rawDepth;
  } else if (args.placement === "after_chat" || (isAbsolute && rawDepth === 0)) {
    zone = "after_chat";
    depth = null;
  } else if (args.placement === "before_chat") {
    zone = "before_chat";
    depth = null;
  } else {
    // No placement info — infer from defaultOrder relative to chatHistory (100)
    const order = args.defaultOrder ?? 10_000;
    zone = order > DEFAULT_PROMPT_ORDER.chatHistory ? "after_chat" : "before_chat";
    depth = null;
  }

  return { zone, depth, order: args.order ?? 0 };
}

// ─── CustomInjection migration ────────────────────────────────────────────
// NOTE: `migrateInjection` was removed in CANVAS_SINGLE_SOURCE_PLAN Wave 1.
// `CustomInjection` is now content-only (no positional/ST-compat fields), so
// there is nothing on an injection to "migrate". Positional state lives on the
// matching `PromptOrderEntry` in `promptOrder`. Importers (Wave 3) build canvas
// entries directly via `inferSlot`; the UI (Wave 4) reads/writes them directly.

/**
 * Reverse-map a PromptSlot back to SillyTavern-compatible fields for export.
 *
 * Consumes a slot *derived from a canvas `PromptOrderEntry`* (by `inferSlot`
 * at import or by direct canvas reads at export), NOT a stored injection field —
 * `CustomInjection` no longer carries positional state.
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
