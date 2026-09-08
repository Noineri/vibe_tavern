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

/** Uppercase tracked label used above every field. Carries the canon 6px
 *  gap below itself (mb-1.5) so label→control spacing is a property of the
 *  constant, not per-callsite discipline. Horizontal row contexts where the
 *  row's own gap provides spacing opt out with a local `!mb-0`. */
export const lblCls =
  "mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3";
