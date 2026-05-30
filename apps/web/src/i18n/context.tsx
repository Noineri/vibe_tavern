import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

export type Locale = "en" | "ru";
type TranslationMap = Record<string, string>;

interface LocaleContextValue {
  locale: Locale;
  t: (key: string) => string;
  setLocale: (locale: Locale) => void;
  ready: boolean;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: "en",
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
  const [locale, setLocale] = useState<Locale>(initialLocale ?? "en");
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
      .catch(() => {
        if (!cancelled) {
          setStrings({});
          syncLocaleState(locale, {});
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
