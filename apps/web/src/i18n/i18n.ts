/**
 * i18next instance + synchronous initialization.
 *
 * This is the runtime core that {@link "./context.tsx"} (useT) and
 * {@link "./locale-helpers.ts"} (getT) wrap, preserving the pre-migration
 * `useT()`/`getT()`/`getLocale()` surface so the ~1300 `t()` call sites are
 * not mass-rewritten.
 *
 * ## Why these options
 *
 * - **`keySeparator: false`** — the locale JSON is FLAT: `coauthor.review.hunk_n`
 *   is a literal key, not a path. Disabling the separator makes i18next do
 *   literal lookups instead of descending a nested object.
 * - **`nsSeparator: false`** — single namespace (`translation`); no `:` splitting.
 * - **`interpolation.prefix/suffix = "{"/"}"`** — the existing 1264 JSON values
 *   use `{var}` (e.g. `"Turn {n}"`). Matching the delimiters preserves every
 *   value verbatim — zero value rewrites.
 * - **`initAsync: false`** — i18next sets `isInitialized` and resolves the init
 *   callback synchronously, so `i18next.t` works the moment {@link initI18n}
 *   returns. This is what lets `getT()` serve early store actions BEFORE React
 *   mounts (the `useEffect`-driven dynamic `import()` of the old layer could
 *   not). NOTE: `initAsync` replaced the removed `initImmediate` option (v24
 *   rename; v26 removed the deprecated alias entirely).
 * - **Bundled `resources`** (static import, not lazy) — no backend, so a locale
 *   switch is an in-memory swap with no loading gap and thus no flash of raw
 *   keys (the old `LocaleProvider` reproduced this by keeping previous strings
 *   on a failed load; here it is inherent because nothing loads async).
 *
 * The default-locale resources are imported statically so they are available
 * synchronously at module-eval time; secondary locales are bundled too (only
 * en/ru today, ~small), which keeps a switch instant and flash-free.
 */

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { LOCALES, DEFAULT_LOCALE, type Locale } from "./registry.js";
import en from "./locales/en.json";
import ru from "./locales/ru.json";

/**
 * Bundled translation resources, keyed by locale → namespace. The namespace is
 * the i18next default `translation`. Kept exported so tests and the CLI config
 * can reference the same source of truth.
 */
export const RESOURCES = {
	en: { translation: en },
	ru: { translation: ru },
} as const;

let initialized = false;

/**
 * Initialize the shared i18next instance synchronously. Idempotent — safe to
 * call from both the module-level boot in `main.tsx` and the `LocaleProvider`
 * mount effect. `lng` seeds the initial language (from the saved tweak or
 * browser detection — see `detectLocale` in `main.tsx`).
 */
export function initI18n(lng: Locale = DEFAULT_LOCALE): void {
	if (initialized) return;
	i18next.use(initReactI18next).init({
		lng,
		fallbackLng: DEFAULT_LOCALE,
		supportedLngs: LOCALES.map((l) => l.id),
		resources: RESOURCES,
		ns: ["translation"],
		defaultNS: "translation",
		// FLAT keys — the `.` in e.g. "coauthor.review.hunk_n" is part of the
		// key name, not a nesting separator.
		keySeparator: false,
		nsSeparator: false,
		// Preserve the existing "{var}" interpolation syntax verbatim.
		interpolation: { prefix: "{", suffix: "}" },
		// Synchronous init — `i18next.t` is usable the instant init returns,
		// which is what `getT()` relies on for pre-React-mount store actions.
		initAsync: false,
		// Plural suffix joins the literal flat key via the default `_` (e.g.
		// `summary_messages_count_one`). Works with keySeparator:false because
		// plural rules append to the whole key, not along a separator path.
		pluralSeparator: "_",
		// Do not log missing keys to stderr in production — the fallback chain
		// (current → en → key-as-value) already mirrors the old `strings[key] ?? key`.
		saveMissing: false,
	});
	initialized = true;
}

export { i18next };
