/**
 * Maximum items a scrollable toolbar/list popover shows before scrolling.
 *
 * Product rule: "show ~6, then scroll". Encode the rule ONCE here, not as
 * magic `max-h-[Npx]` scattered across components — those drifted (single-line
 * rows hit ~6 at ~200px, two-line rows only fit ~5 at the same budget, so the
 * VibeMdView co-author list silently regressed from 6 to 5). px is a lossy
 * encoding of an item-count intent.
 *
 * Sites derive their pixel max-height from this count × their row's height via
 * {@link popoverMaxHeight}. Row heights are fixed (the design system pins
 * font-size + vertical padding), so no JS measurement (useLayoutEffect /
 * ResizeObserver) is needed — see {@link ROW_HEIGHT} for the known row shapes
 * and how each was derived.
 *
 * Inline `style={{ maxHeight }}` is used (not a Tailwind arbitrary class)
 * because the value is runtime-computed from the constant; Tailwind's scanner
 * can't see dynamically constructed class strings, so `max-h-[${n}px]` would
 * silently produce no style. (TopBar's preset dropdown uses a static
 * `calc(6*...)` arbitrary class — same count rule, but with `6` hardcoded in
 * the class string; it is an adjacent site that could adopt this constant by
 * switching to inline style too.)
 *
 * Mobile bottom sheets (`ToolbarSelect` mobile half, `MobileInputArea`
 * pickers) intentionally use `max-h-[50vh]` instead — a viewport-relative cap
 * is more appropriate for a sheet that competes with the on-screen keyboard
 * and safe-area insets than a fixed item count, so they do NOT use this rule.
 */
export const MAX_VISIBLE_ITEMS = 6;

/** Pixel heights of the known toolbar/list row shapes. Deterministic — the
 *  design system fixes font-size + vertical padding — so these are constants,
 *  not runtime measurements. Each entry documents its derivation. */
export const ROW_HEIGHT = {
	/** Desktop ToolbarSelect item: `py-1.5` (12px) + a single `text-[13px]`
	 *  line (~18px incl. line-height) ≈ 30px, rounded UP to 33. 6 × 33 = 198,
	 *  matching the prior `max-h-[200px]` budget so this migration changes no
	 *  visible row count (covers co-author module/favorites, RP favorites, RP
	 *  persona — all single-line rows). */
	singleLine: 33,
	/** VibeMdView co-author chat row: `py-2` (16px) + title `text-[0.85rem]`
	 *  (~20px) + subtitle `text-[11px]` (~16px) + `gap-0.5` (2px) ≈ 54px,
	 *  rounded UP to 56 (6 × 56 = 336). Fixes the silent regression where the
	 *  old `max-h-[280px]` only fit ~5 two-line rows. */
	twoLine: 56,
} as const;

/** Pixel max-height for a popover showing {@link MAX_VISIBLE_ITEMS} rows of
 *  the given shape. Use in inline style:
 *  `style={{ maxHeight: popoverMaxHeight("singleLine") }}`. */
export function popoverMaxHeight(shape: keyof typeof ROW_HEIGHT): number {
	return MAX_VISIBLE_ITEMS * ROW_HEIGHT[shape];
}
