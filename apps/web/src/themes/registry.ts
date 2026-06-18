/**
 * Theme registry — the single source of truth for available UI themes.
 *
 * Adding a new theme is a two-step change:
 *   1. Create `apps/web/src/themes/<name>.css` (selector `:root.<name>`) and
 *      `@import` it in `apps/web/src/styles.css`.
 *   2. Append a {@link ThemeDef} entry to {@link THEMES} below.
 *
 * Everything else — storage validation, `<html>` class application, and the
 * theme segmented control options — derives from this array, so no other file
 * needs editing when a theme is added.
 *
 * ## The default-theme class nuance
 *
 * Themes are applied exclusively as a single CSS class on `<html>`:
 *   - The default theme (`coffee`) uses `className: ""` — it is the bare `:root`
 *     in coffee.css and needs no class.
 *   - Every other theme carries a className (e.g. `"milk-coffee"`, `"mystic-night"`)
 *     matching the `:root.<className>` selector in its CSS file.
 *
 * {@link applyThemeClass} strips ALL theme classes first, then adds only the
 * active one — so switching themes never leaves a stale class on the root
 * (which the old binary `toggle("light")` logic would do once a third theme
 * entered the picture).
 */
import { Ic } from "../components/shared/icons.js";

export interface ThemeDef {
	/** Persistent id — stored in localStorage and used as the segment value. */
	id: string;
	/**
	 * CSS class applied to `<html>`. Empty string for the default (`:root`)
	 * theme; otherwise matches a `:root.<className>` selector in a theme CSS
	 * file.
	 */
	className: string;
	/** Key into the `Ic` icon set, rendered in the theme segment control. */
	icon: keyof typeof Ic;
}

/**
 * Ordered list of available themes. Order = display order in the segment
 * control. Keep the default (`coffee`) here so it is selectable, not just the
 * implicit fallback.
 */
// Icon convention: outlined icons mark LIGHT themes, filled icons mark DARK
// themes (e.g. `coffee` outline vs `coffeeFilled`, `flame` vs `flameFilled`).
export const THEMES: readonly ThemeDef[] = [
	{ id: "milk-coffee",  className: "milk-coffee",  icon: "coffee" },        // light  → outlined cup
	{ id: "coffee",       className: "",             icon: "coffeeFilled" },  // dark (default) → filled cup
	{ id: "mystic-night", className: "mystic-night", icon: "sparklesFilled" }, // dark   → filled sparkles
	{ id: "light-lava",   className: "light-lava",   icon: "flame" },         // light  → outlined flame
	{ id: "dark-lava",    className: "dark-lava",    icon: "flameFilled" },   // dark   → filled flame
];

/** Union of all theme ids. The canonical `ThemeMode` type. */
export type ThemeId = (typeof THEMES)[number]["id"];

/** Back-compat alias — existing code imports `ThemeMode`. */
export type ThemeMode = ThemeId;

const DEFAULT_THEME: ThemeId = "coffee";

/** True if `id` is a registered theme id. */
export function isValidTheme(id: string): id is ThemeId {
	return THEMES.some((t) => t.id === id);
}

/** Resolve a theme id to its `<html>` class ("" for the default theme). */
export function themeClassName(id: string): string {
	return THEMES.find((t) => t.id === id)?.className ?? "";
}

/**
 * Coerce an arbitrary stored value into a valid theme id, falling back to the
 * default theme. Used by the storage reader.
 */
export function normalizeTheme(id: string | null | undefined): ThemeId {
	return id && isValidTheme(id) ? id : DEFAULT_THEME;
}

/**
 * Apply a theme exclusively to the document root: remove every theme class,
 * then add only the active one. Safe to call on any theme (the default theme
 * ends up with no class).
 */
export function applyThemeClass(root: HTMLElement, id: string): void {
	for (const t of THEMES) {
		if (t.className) root.classList.remove(t.className);
	}
	const cls = themeClassName(id);
	if (cls) root.classList.add(cls);
}
