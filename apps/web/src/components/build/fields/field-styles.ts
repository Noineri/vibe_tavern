/**
 * Shared style constants for the Build Mode character field components.
 *
 * Extracted from `CharacterForm.tsx` so the reusable field components under
 * `fields/` (consumed by both the classic `CharacterForm` and the future Vibe
 * MD view) share ONE source of truth for input/label styling. The
 * `field-input-pad` class keeps required padding inseparable from this class
 * while avoiding Tailwind v4 numeric-spacing issues.
 */

/** Standard text-area/input class (sans / font-ui), including required padding.
 *  `overflow-y-auto` (not `overflow-hidden`) is REQUIRED by AutoTextarea's
 *  `maxRows` contract — once the cap stops the growth, the field must scroll
 *  internally; `overflow-hidden` silently clips the tail instead. */
export const inputCls =
  "field-input-pad w-full rounded-md border border-border bg-s2 font-ui text-t1 outline-none focus:border-accent resize-none overflow-y-auto";

/** Monospace variant for prompt-instruction fields (system / post-history / depth). */
export const monoCls = inputCls + " font-mono text-xs";

/** Monospace at the SAME font size as regular inputs — typeface-only
 *  distinction (R-7 in REGEX_V13_FOLLOWUP: regex rule fields must not read as
 *  a lesser 12px class of input). Padding, line height and size stay identical
 *  to `inputCls`; only the family changes. `font-mono` reliably overrides
 *  `font-ui` in the generated stylesheet — same mechanism `monoCls` relies on. */
export const monoUICls = inputCls + " font-mono";

/** Uppercase tracked label used above every field. */
export const lblCls =
  "block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3";
