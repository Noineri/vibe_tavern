import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { DEFAULT_LOCALE, type Locale } from "./registry.js";

// `Locale` originates in registry.ts (the single source of truth) and should be
// imported from there directly at call sites — do NOT re-export it (or any
// runtime value) from this file: context.tsx is a React module and
// re-exporting breaks Fast Refresh boundary isolation.
type TranslationMap = Record<string, string>;

interface LocaleContextValue {
  locale: Locale;
  t: (key: string) => string;
  setLocale: (locale: Locale) => void;
  ready: boolean;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  t: (key) => key,
  setLocale: () => {},
  ready: false,
});

// getT/getLocale live in locale-helpers.ts — import from there directly.
// Do NOT re-export here to keep this file Fast Refresh compatible.
import { syncLocaleState } from "./locale-helpers.js";

// ── Provider ──
export function LocaleProvider({ children, initialLocale }: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocale] = useState<Locale>(initialLocale ?? DEFAULT_LOCALE);
  const [strings, setStrings] = useState<TranslationMap>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    // Keep previous strings until new ones load — avoids flash of raw keys
    import(`./locales/${locale}.json`)
      .then((mod) => {
        if (!cancelled) {
          const map = mod.default as TranslationMap;
          setStrings(map);
          syncLocaleState(locale, map);
          setReady(true);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          // A failed locale load must NOT clear the working strings — that
          // would flash raw keys (strings === {} → t(key) returns the key)
          // and, worse, set ready=true so the failure is invisible. Keep the
          // previously loaded strings so the UI falls back to the last working
          // language instead, and log so the cause is visible in DevTools.
          console.error(`[i18n] Failed to load locale "${locale}":`, error);
          syncLocaleState(locale, strings);
          setReady(true);
        }
      });
    return () => { cancelled = true; };
  }, [locale]);

  const t = useCallback((key: string): string => {
    return strings[key] ?? key;
  }, [strings]);

  return (
    <LocaleContext.Provider value={{ locale, t, setLocale, ready }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useT(): LocaleContextValue {
  return useContext(LocaleContext);
}
