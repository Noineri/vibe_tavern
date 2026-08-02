/**
 * Shared style constants for the Build Mode character field components.
 *
 * Extracted from `CharacterForm.tsx` so the reusable field components under
 * `fields/` (consumed by both the classic `CharacterForm` and the future Vibe
 * MD view) share ONE source of truth for input/label styling. The
 * `field-input-pad` class keeps required padding inseparable from this class
 * while avoiding Tailwind v4 numeric-spacing issues.
 */

/** Standard text-area/input class (sans / font-ui), including required padding. */
export const inputCls =
  "field-input-pad w-full rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent resize-none overflow-hidden";

/** Monospace variant for prompt-instruction fields (system / post-history / depth). */
export const monoCls = inputCls + " font-mono text-xs";

/** Uppercase tracked label used above every field. */
export const lblCls =
  "block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3";
