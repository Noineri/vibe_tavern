/**
 * The ONE home of field style tokens for the whole app (owner ruling
 * 2026-09-10: «у нас нет причин держать два разных поля ввода... надо чтобы
 * они выглядели одинавоко во всем приложении + функционировали так же»).
 *
 * Reference shape: the LLM provider form (owner: «не ттс. ЛЛМ.») — fixed
 * height, 6px radius, `px-[13px]`, size from the `ui-fs` ladder, focus
 * transition. Supersedes `build/fields/field-styles.ts` and
 * `settings/provider/form-field-classes.ts` (both retired).
 *
 * Structure: BASES (full standalone classes) + MODIFIERS (partial classes
 * composed onto a base with `cn()`). Never fork a base into a parallel full
 * class — that is how the previous system drifted (`monoCls` grew a
 * `text-xs` that no mono field ever needed).
 *
 * Enforcement lives in the primitives, not in call-site discipline:
 * `TextInput` (single line) and `AutoTextarea` (auto-grow) bake these in as
 * defaults; surfaces compose, they do not hand-roll.
 */

/** Canonical single-line input: the LLM provider form shape, verbatim. */
export const inputCls =
	"w-full h-11 sm:h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent px-[13px]";

/** Canonical auto-grow textarea: same chrome minus the fixed height, plus
 *  the AutoTextarea scroll contract. `field-input-pad` (styles.css) carries
 *  the padding; `overflow-y-auto` (not `overflow-hidden`) is REQUIRED by
 *  AutoTextarea's `maxRows` contract — once the cap stops the growth, the
 *  field must scroll internally instead of silently clipping the tail. */
export const textareaCls =
	"field-input-pad w-full rounded-[6px] border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent resize-none overflow-y-auto";

/** Chat composer (mobile twin shape, byte-identical across chat + coauthor
 *  since inception — promoted to a named canon 2026-09-10). Composers are a
 *  separate family from fields BY DESIGN: borderless (the surrounding bar
 *  carries the chrome), prose font (chat is reading, not UI), own growth
 *  limits. Desktop composers extend locally (padding, row caps). */
export const composerCls =
	"max-h-[40vh] min-h-[44px] flex-1 resize-none border-0 bg-transparent py-2 pr-1 font-body text-[15px] leading-[1.4] text-t1 outline-none placeholder:text-t4 overflow-y-auto";

/** Display canon for command/code quotes in help content (curl examples,
 *  DSL snippets, disabled default texts). Owner 2026-09-10: «давай для них
 *  тоже свой канон сделаем». This is a READ-ONLY display, not a field: mono,
 *  wrapped, breakable. Content-specific ceilings (`max-h-* overflow-auto`)
 *  are local extensions at the call site. */
export const codeQuoteCls =
	"min-w-0 whitespace-pre-wrap break-all rounded-[6px] border border-border bg-s2 p-2 font-mono text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2";

/** Mono modifier for opaque technical content (keys, voice IDs, regex
 *  patterns, template sequences). NEVER carries its own size — the base sets
 *  the size from the `ui-fs` ladder; `text-xs` in mono fields is dead. */
export const monoMod = "font-mono tracking-[0.05em]";

/** Read-only modifier for locked/disabled fields (disabled endpoint showing
 *  a preset value etc.). Replaces the four duplicated local smears. */
export const readonlyMod = "!cursor-not-allowed !opacity-60";

/** Uppercase tracked label above every field. Carries the canon 6px gap
 *  below itself (mb-1.5) so label→control spacing is a property of the
 *  token, not per-callsite discipline. Horizontal row contexts where the
 *  row's own gap provides spacing opt out with a local `!mb-0`. */
export const lblCls =
	"mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3";
