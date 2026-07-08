import { defineConfig } from "i18next-cli";

/**
 * i18next-cli configuration — drives extraction, type generation, and linting.
 *
 * Replaces the self-rolled scripts/i18n-check.ts (retired in this migration).
 * The runtime i18next instance is configured separately in
 * `src/i18n/i18n.ts`; the two share the same locale set (fed from registry.ts
 * at runtime) and the same flat-key / `{}`-interpolation conventions, but this
 * file is the STATIC-ANALYSIS config the CLI consumes.
 *
 * Key choices mirror `src/i18n/i18n.ts` so extraction matches runtime behavior:
 *  - keySeparator: false — locale JSON is FLAT; `.` in a key is literal.
 *  - nsSeparator: false  — single namespace, no `:` splitting.
 *  - pluralSeparator: "_" — plural forms are `key_one`/`key_other` (en) etc.
 *  - defaultNS: false — output is one flat JSON per language, no namespace
 *    wrapper (matches the existing `locales/<lang>.json` shape).
 *
 * `useT` and `getT` are in the default `useTranslationNames` list, so the
 * extractor correctly attributes `t("key")` calls made through our wrapper.
 */
export default defineConfig({
	locales: ["en", "ru"],
	extract: {
		input: ["src/**/*.{ts,tsx}"],
		ignore: [
			"src/**/*.test.ts",
			"src/**/*.test.tsx",
			"src/i18n/**",
		],
		output: "src/i18n/locales/{{language}}.json",
		defaultNS: false,
		keySeparator: false,
		nsSeparator: false,
		pluralSeparator: "_",
		// Preserve the existing (non-alphabetical) key order to minimize churn.
		sort: false,
		// Do NOT remove keys absent from source — this codebase uses dynamic
		// keys (t(`prefix_${x}`), registry-driven selectors) that static
		// extraction cannot resolve. With removeUnusedKeys:true (the default)
		// those ~90 legitimately-used dynamic keys would be purged. The old
		// scripts/i18n-check.ts handled this via prefix-aware heuristics; here
		// we simply keep all existing keys and only add newly-detected ones.
		removeUnusedKeys: false,
	},
	types: {
		input: ["src/i18n/locales/en.json"],
		output: "src/i18n/i18next.d.ts",
	},
});
