/**
 * Non-React entry points into the i18next-backed translation layer.
 *
 * `getT()` is the escape hatch for code that runs outside React render (stores,
 * api-actions, utils) and therefore cannot call the `useT()` hook. It returns a
 * function bound to the shared {@link "./i18n.js"} instance, which — because
 * {@link initI18n} runs with `initAsync: false` and bundled resources — yields
 * correct translations synchronously from the moment boot calls `initI18n`
 * (before React mounts), eliminating the ready-gap the old `_lastStrings` mirror
 * existed to paper over.
 *
 * The returned `t` now accepts an optional interpolation/`count` options
 * object (`t("key", { n: 5 })`, `t("key", { count: 5 })`) so call sites can
 * migrate off `.replace("{n}", …)`. Single-arg `t("key")` calls are unchanged.
 */

import { i18next } from "./i18n.js";
import { DEFAULT_LOCALE, type Locale } from "./registry.js";

/** Translation function signature (mirrors the `useT()` `t`). */
export type TFunc = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Returns a `t` bound to the shared i18next instance. Reads the current
 * language at call time (not capture time), so it always reflects the latest
 * `setLocale` / `i18next.changeLanguage`.
 */
export function getT(): TFunc {
	// `as string` narrows i18next v26's `string | TFunctionDetailedResult` union:
	// `returnDetails` is never set, so the runtime value is always a string.
	return (key: string, opts?: Record<string, unknown>) => i18next.t(key, opts) as string;
}

/** The currently active locale, falling back to the default if unset. */
export function getLocale(): Locale {
	return (i18next.language ?? DEFAULT_LOCALE) as Locale;
}
