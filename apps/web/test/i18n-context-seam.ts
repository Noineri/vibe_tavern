/**
 * The ONE shared `i18n/context.js` seam for every apps/web test file that
 * needs a deterministic `t` (the CA attachment suites and any suite whose
 * pins rely on the provider-less identity echo).
 *
 * CO-LOAD CONTRACT (same discipline as test/react-markdown-seam.ts and
 * test/agent-message-markdown-seam.tsx): `mock.module` is process-global and
 * last-write-wins, and a hand-bundled pair run shares the module registry —
 * so an inline per-suite i18n mock replaces `useT` for EVERY later file in
 * the process. The real-i18next suites (AgentTimelineSeparator AP-34 RU
 * plurals, AgentPermissionCard SC-23g, AgentActivityCard SC-13a) mount a real
 * `LocaleProvider` and pin real translations; an inline mock's stub `useT`
 * ignores the provider, so their RU/EN pins see raw keys instead (15 red in
 * the 21-file mixed cluster, 2026-10-27 merge unit). The official runner
 * (`--isolate`, fresh module registry per file) never meets this; a
 * hand-bundled run does.
 *
 * The seam makes `useT` order-independent by deciding per RENDER, not per
 * registration:
 *  - a mounted `LocaleProvider` (`ready: true` in the real context value) →
 *    DELEGATE: return the real context value untouched, so real-i18next
 *    suites keep real RU/EN + plurals no matter whose registration is live;
 *  - no provider (the real default context, `ready: false`) → return the
 *    deterministic stub: raw-key identity echo (the house pattern — copy
 *    edits never break tests) EXCEPT the registering suite's
 *    `interpolateKeys`, which read the bundled EN templates with single-brace
 *    params interpolated. `tDynamic` always echoes the key.
 *
 * Per-suite `interpolateKeys` (a factory argument, the task's preferred
 * shape) keep each suite's pins on its OWN semantics: during a sequential
 * hand-bundle each file's registration is live for its own run, so a suite
 * never inherits another suite's interpolation. EVERY file in the co-loadable
 * family must register — the mocking suites AND the provider-less suites
 * whose pins echo raw keys (AgentContextRing pins the raw
 * `context_usage_percent` while MobileInputArea interpolates it; without its
 * own identity registration it would inherit the interpolating spec in a
 * hand-bundled run).
 *
 * NO plural handling in the stub: a `count` is just another param. Plural
 * pins (SC-23g, AP-34) belong to provider-mounted renders, which delegate to
 * the real i18next.
 *
 * The DELEGATION CAPTURE RULE applies: the real `useT` is captured as a bare
 * function reference BEFORE any registration — bun's `mock.module` replaces
 * the module's export slots IN PLACE, so a namespace captured earlier would
 * alias the mock's slot; the bare reference severs that.
 *
 * Call `installI18nContextSeam(...)` in the test-file body BEFORE importing
 * the component under test (same ordering rule as the other seams).
 */
import { mock } from "bun:test";

const realI18nContext = await import("../src/i18n/context.js");
/** The real `useT`, captured as a bare reference BEFORE any registration — see the header. */
const realUseT = realI18nContext.useT;

/** The bundled EN table — the ONE data source for the stub's interpolation (never the mutable i18next instance: that would re-introduce order dependence). */
const enTable: Record<string, string> = (await import("../src/i18n/locales/en.json")).default;

/** `t`'s key parameter from the REAL module — one derivation, no hand-copied key type. */
type TFuncKey = Parameters<ReturnType<typeof realUseT>["t"]>[0];

export interface I18nContextSeamSpec {
	/**
	 * Keys the registering suite's pins expect INTERPOLATED: the bundled EN
	 * template with single-brace `{param}` placeholders replaced by the call's
	 * options. Every other key echoes the raw key (identity).
	 */
	readonly interpolateKeys?: readonly TFuncKey[];
}

function interpolateParams(template: string, params?: Record<string, unknown>): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match,
	);
}

/** Register the shared i18n context seam (re-registration with a new spec simply owns the process until the next one). */
export function installI18nContextSeam(spec: I18nContextSeamSpec = {}): void {
	const interpolatedKeys = new Set<TFuncKey>(spec.interpolateKeys ?? []);
	mock.module("../src/i18n/context.js", () => ({
		...realI18nContext,
		useT: function i18nContextSeamUseT() {
			// Provider mounted → the REAL context value (real i18next: RU/EN,
			// plurals). Real-i18next suites are immune to any registration.
			const real = realUseT();
			if (real.ready) return real;
			return {
				t: (key: TFuncKey, opts?: Record<string, unknown>) =>
					interpolatedKeys.has(key)
						? interpolateParams(enTable[key] ?? key, opts)
						: key,
				tDynamic: (key: string) => key,
				locale: "en",
				setLocale: () => {},
				ready: true,
			};
		},
	}));
}
