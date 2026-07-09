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
		// Suppress false-positive phantom keys. Two sources, both verified by a
		// real `extract --ci` run this session:
		//  (a) prefix-concat calls like t("pos_" + pos) — the extractor resolves
		//      the static left operand as a literal key, emitting a bare `pos_`
		//      that is never a real key. Anchored patterns match ONLY the bare
		//      prefix, never the real suffixed keys (pos_first, etc.). The five
		//      prefixes are the complete Class-A inventory from the old checker;
		//      only `pos_` currently phantoms, the rest are listed defensively.
		//  (b) comment text — see extractFromComments below.
		preservePatterns: [
			"^pos_$",
			"^match_src_$",
			"^script_template_$",
			"^st_phase_$",
			"^mes_example_mode_tooltip_$",
		],
		// Do NOT extract translation keys from comments. The extractor parses
		// t("...") inside // and /* */ blocks (a feature for declaring keys that
		// can't be found statically), which turns JSDoc examples like
		//   * e.g. `<AddButton>{t("new")}</AddButton>`   (add-button.tsx)
		// into phantom keys. This codebase has no comment-declared keys (dynamic
		// keys are covered by removeUnusedKeys:false + loose registry literals),
		// so disabling matches the old checker's behavior and removes the whole
		// false-positive class.
		extractFromComments: false,
	},
	types: {
		input: ["src/i18n/locales/en.json"],
		output: "src/i18n/i18next.d.ts",
	},
});
