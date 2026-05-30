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

// ── Standalone getT() for use outside React components (hooks, etc.) ──
let _lastStrings: TranslationMap = {};
let _lastLocale: Locale = "en";

/** Returns the last-known `t` function. Falls back to key-as-value. */
export function getT(): (key: string) => string {
  return (key: string) => _lastStrings[key] ?? key;
}

export function getLocale(): Locale {
  return _lastLocale;
}

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
          _lastStrings = map;
          _lastLocale = locale;
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStrings({});
          _lastStrings = {};
          _lastLocale = locale;
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
