import { DEFAULT_LOCALE, type Locale } from "./registry.js";

type TranslationMap = Record<string, string>;

let _lastStrings: TranslationMap = {};
let _lastLocale: Locale = DEFAULT_LOCALE;

/** Returns the last-known `t` function. Falls back to key-as-value. */
export function getT(): (key: string) => string {
  return (key: string) => _lastStrings[key] ?? key;
}

export function getLocale(): Locale {
  return _lastLocale;
}

/** @internal — called by LocaleProvider to sync module-level state */
export function syncLocaleState(locale: Locale, strings: TranslationMap): void {
  _lastLocale = locale;
  _lastStrings = strings;
}
