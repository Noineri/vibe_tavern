import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { DEFAULT_LOCALE, type Locale, normalizeLocale } from "./registry.js";
import { i18next, initI18n } from "./i18n.js";
import type Resources from "./resources.js";
import { type TDynamic } from "./locale-helpers.js";

// `Locale` originates in registry.ts (the single source of truth) and should be
// imported from there directly at call sites — do NOT re-export it (or any
// runtime value) from this file: context.tsx is a React module and
// re-exporting breaks Fast Refresh boundary isolation.

/**
 * Strict-key translation function (same shape as `TFunc` in locale-helpers):
 * `key` is `keyof Resources["en"]`, so a missing/typo'd key is a compile error.
 * Accepts an optional interpolation/`count` options object. For computed keys
 * use the `tDynamic` sibling on `useT()`.
 */
export type TFunc = (key: keyof Resources["en"], opts?: Record<string, unknown>) => string;

interface LocaleContextValue {
  locale: Locale;
  t: TFunc;
  /** Dynamic-key escape hatch (see {@link TDynamic} in locale-helpers). */
  tDynamic: TDynamic;
  setLocale: (locale: Locale) => void;
  ready: boolean;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  t: (key) => key,
  tDynamic: (key) => key,
  setLocale: () => {},
  ready: false,
});

// getT/getLocale live in locale-helpers.ts — import from there directly.
// Do NOT re-export here to keep this file Fast Refresh compatible.

/**
 * React context provider that owns the active-locale state and drives
 * `i18next.changeLanguage`.
 *
 * The `ready` flag is always `true`: i18next initializes synchronously
 * (`initAsync: false`) with bundled resources, so there is never a loading
 * window in which translated strings are unavailable. A locale switch is an
 * in-memory resource swap (no async fetch), so there is no flash of raw keys —
 * the old `LocaleProvider` reproduced this defensively by keeping previous
 * strings on a failed load; here the guarantee is inherent because nothing
 * loads asynchronously.
 */
export function LocaleProvider({ children, initialLocale }: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? DEFAULT_LOCALE);

  // Idempotent boot — `main.tsx` also calls `initI18n` before render so that
  // non-React `getT()` callers have translations from the very first tick; the
  // effect here covers the SSR/test path where `main.tsx` does not run first.
  useEffect(() => {
    initI18n(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    const normalized = normalizeLocale(next);
    setLocaleState(normalized);
    // Synchronous with bundled resources — `i18next.language` and all
    // subsequent `t()` calls reflect the new locale immediately. The state
    // update above triggers the re-render that repaints already-rendered text.
    i18next.changeLanguage(normalized);
  }, []);

  // `t` reads the active locale from the i18next instance at call time. It is
  // keyed on `locale` so its identity changes on a switch, which (together with
  // the new context value object) guarantees every consumer re-renders with the
  // freshly resolved strings.
  //
  // The `as string` narrows i18next v26's `string | TFunctionDetailedResult`
  // union: for a dynamic (non-literal) key the t overloads widen to the union,
  // but `returnDetails` is never set here so the runtime value is always a
  // string. (Step 5's `i18next-cli types` makes keys literal-typed, after which
  // the cast becomes provably unnecessary.)
  const t = useCallback<TFunc>((key, opts) => i18next.t(key, opts) as string, [locale]);

  // `tDynamic` is the loose-key sibling of `t` — same i18next binding, typed to
  // accept a runtime-computed key string. It stays loose when `t` is tightened
  // to `keyof Resources["en"]` (Wave 3 of I18N_TYPES_KEYSAFETY_PLAN), so
  // computed-key sites (`tDynamic("pos_" + x)`, `tDynamic(panel.labelKey)`) keep
  // compiling. Keyed on `locale` for the same re-render reason as `t`.
  const tDynamic = useCallback<TDynamic>((key, opts) => i18next.t(key, opts) as string, [locale]);

  return (
    <LocaleContext.Provider value={{ locale, t, tDynamic, setLocale, ready: true }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useT(): LocaleContextValue {
  return useContext(LocaleContext);
}
