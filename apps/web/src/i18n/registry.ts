/**
 * Locale registry — the single source of truth for available UI languages.
 *
 * Adding a new language is a two-step change:
 *   1. Create `apps/web/src/i18n/locales/<id>.json` with the translated keys
 *      (copy `en.json` and translate every value).
 *   2. Append a {@link LocaleDef} entry to {@link LOCALES} below.
 *
 * Everything else — the `Locale` type, storage validation, browser-language
 * auto-detection, and the language selectors in TweaksPanel / MobileSettings —
 * derives from this array, so no other file needs editing when a language is
 * added. `LocaleProvider` loads the matching JSON dynamically
 * (`import(\`./locales/${locale}.json\`)`), so it needs no change either.
 *
 * ## Auto-detection
 *
 * {@link detectBrowserLocale} matches `navigator.language` against each
 * locale's {@link LocaleDef.match} prefixes (case-insensitive). A locale with
 * no `match` is never auto-selected — it is only reachable when the user picks
 * it explicitly. See `detectLocale` in `main.tsx` for the full priority chain
 * (saved choice → browser → default).
 */

export interface LocaleDef {
  /**
   * Persistent id — stored in localStorage and used as the selector value.
   * Must match the `locales/<id>.json` filename (it drives the dynamic import
   * in `LocaleProvider`).
   */
  id: string;
  /** Native-language label shown in the selector (e.g. "Русский"). */
  label: string;
  /**
   * BCP-47 prefixes matched against `navigator.language` for auto-detection
   * (e.g. `["ru"]` matches `ru` and `ru-RU`). Omit for locales that should
   * not be auto-selected from the browser language.
   */
  match?: readonly string[];
}

/**
 * Ordered list of available locales. Order = display order in the selector.
 * The first entry is NOT special — {@link DEFAULT_LOCALE} controls the
 * fallback.
 */
export const LOCALES: readonly LocaleDef[] = [
  { id: "en", label: "English" },
  { id: "ru", label: "Русский", match: ["ru"] },
];

/** Union of all locale ids. The canonical `Locale` type. */
export type Locale = (typeof LOCALES)[number]["id"];

export const DEFAULT_LOCALE: Locale = "en";

/** True if `id` is a registered locale id. */
export function isLocale(id: string): id is Locale {
  return LOCALES.some((l) => l.id === id);
}

/**
 * Coerce an arbitrary stored value into a valid locale id, falling back to the
 * default locale. Used by the language switcher and any storage reader.
 */
export function normalizeLocale(id: string | null | undefined): Locale {
  return id && isLocale(id) ? id : DEFAULT_LOCALE;
}

/**
 * Match `navigator.language` against registered locales' `match` prefixes
 * (case-insensitive). Returns {@link DEFAULT_LOCALE} when nothing matches.
 */
export function detectBrowserLocale(navLang: string): Locale {
  const nav = navLang.toLowerCase();
  for (const l of LOCALES) {
    if (l.match?.some((p) => nav.startsWith(p.toLowerCase()))) return l.id;
  }
  return DEFAULT_LOCALE;
}
