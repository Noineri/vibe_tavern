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
 *  - no provider (the real default context, `ready: false`) → the
 *    deterministic stub. THREE provider-less modes, chosen by the spec:
 *      · identity (no spec keys) — raw-key echo (the house pattern — copy
 *        edits never break tests), `tDynamic` echoes the key;
 *      · `interpolateKeys` — the listed keys read the bundled EN templates
 *        with single-brace params interpolated, every other key echoes;
 *      · `custom` — the registering suite's OWN mock semantics: a verbatim
 *        port of the file's old inline `t` (and optional `tDynamic`) runs
 *        exactly as the inline mock did, so the file's pins keep their
 *        checked facts with ZERO assertion changes (the OTHER-43 tail of the
 *        i18n migration). A provider mounted still DELEGATES — custom stubs
 *        poison nobody. `custom.stable` memoizes the stub context value so
 *        `useT()` returns the SAME object every render (files whose effects
 *        depend on `t` identity); without it the value is per-render, but
 *        `t`/`tDynamic` keep identity either way (the spec's functions are
 *        created once, at install time).
 *
 * Per-suite specs (factory arguments) keep each suite's pins on its OWN
 * semantics: during a sequential hand-bundle each file's registration is live
 * for its own run, so a suite never inherits another suite's semantics. EVERY
 * file in the co-loadable family must register — the mocking suites AND the
 * provider-less suites whose pins echo raw keys (AgentContextRing pins the raw
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
import type { TDynamic } from "../src/i18n/locale-helpers.js";

const realI18nContext = await import("../src/i18n/context.js");
/** The real `useT`, captured as a bare reference BEFORE any registration — see the header. */
const realUseT = realI18nContext.useT;
/** The real `t` signature — the `custom.t` contract (ported stubs keep the exact call shape). */
type TFunc = ReturnType<typeof realUseT>["t"];

/** The bundled EN table — the ONE data source for the stub's interpolation (never the mutable i18next instance: that would re-introduce order dependence). */
const enTable: Record<string, string> = (await import("../src/i18n/locales/en.json")).default;

/** `t`'s key parameter from the REAL module — one derivation, no hand-copied key type. */
type TFuncKey = Parameters<TFunc>[0];

/** A suite's own provider-less stub semantics (the verbatim port of its old inline mock). */
export interface I18nCustomStubSpec {
	/**
	 * The suite's own `t`. Ported arrows usually DROP their parameter
	 * annotations and take `key: keyof Resources["en"]` /
	 * `opts?: Record<string, unknown>` contextually from this type — runtime
	 * behavior is the old mock's, unchanged.
	 */
	readonly t: TFunc;
	/** Optional custom `tDynamic`; defaults to the raw-key identity echo. */
	readonly tDynamic?: TDynamic;
	/**
	 * Memoize the provider-less context value: `useT()` returns the SAME
	 * object on every render (for files whose effects depend on value
	 * identity). `t`/`tDynamic` identity holds with or without the flag.
	 */
	readonly stable?: boolean;
}

/** Identity / interpolation spec, or a custom stub — never both. */
export type I18nContextSeamSpec =
	| { readonly interpolateKeys?: readonly TFuncKey[]; readonly custom?: undefined }
	| { readonly custom: I18nCustomStubSpec; readonly interpolateKeys?: undefined };

function interpolateParams(template: string, params?: Record<string, unknown>): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match,
	);
}

/** The custom-branch stub context: the suite's functions passed through by reference (identity-stable), the fixed non-`t` fields of the identity family. */
function makeCustomStub(custom: I18nCustomStubSpec) {
	return {
		t: custom.t,
		tDynamic: custom.tDynamic ?? ((key: string) => key),
		locale: "en",
		setLocale: () => {},
		ready: true,
	};
}

/** Register the shared i18n context seam (re-registration with a new spec simply owns the process until the next one). */
export function installI18nContextSeam(spec: I18nContextSeamSpec = {}): void {
	const custom = spec.custom;
	const interpolatedKeys = new Set<TFuncKey>(custom ? [] : spec.interpolateKeys ?? []);
	let stableStub: ReturnType<typeof makeCustomStub> | null = null;
	mock.module("../src/i18n/context.js", () => ({
		...realI18nContext,
		useT: function i18nContextSeamUseT() {
			// Provider mounted → the REAL context value (real i18next: RU/EN,
			// plurals). Real-i18next suites are immune to any registration —
			// custom stubs included.
			const real = realUseT();
			if (real.ready) return real;
			if (custom) {
				if (custom.stable) {
					stableStub ??= makeCustomStub(custom);
					return stableStub;
				}
				return makeCustomStub(custom);
			}
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
