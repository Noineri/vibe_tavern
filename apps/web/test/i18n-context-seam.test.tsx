/**
 * Self-suite of the shared i18n context seam — pins the three provider-less
 * modes (identity echo, `interpolateKeys`, `custom`) and the two rules that
 * make co-loading safe: DELEGATION to the real context whenever a provider is
 * mounted (so a custom stub never poisons real-i18next suites in a
 * hand-bundled run) and the `...real` spread (the mocked module still exports
 * the real `LocaleProvider`, which the delegation test itself mounts). Also
 * pins the `custom.stable` memoization and the always-stable `t` identity.
 *
 * The suite initializes REAL i18n (`initI18n`) for the delegation test — R13:
 * `afterAll` restores the default language so no sibling file observes RU.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { I18nCustomStubSpec } from "./i18n-context-seam.js";
import { useDomEnv } from "./dom-env.js";

useDomEnv();

const { render, fireEvent, cleanup } = await import("@testing-library/react");
const { useRef, useState } = await import("react");
const { installI18nContextSeam } = await import("./i18n-context-seam.js");
const en = (await import("../src/i18n/locales/en.json")).default;
const ru = (await import("../src/i18n/locales/ru.json")).default;
// The seam mocks this module; bun replaces its export slots IN PLACE, so the
// namespace is kept whole and `useT` is read AT RENDER TIME — a destructured
// `const { useT }` would freeze the pre-mock function reference (the seam
// header's capture rule, applied to the test side).
const i18nContextModule = await import("../src/i18n/context.js");
const { LocaleProvider } = i18nContextModule;
const { initI18n, i18next } = await import("../src/i18n/i18n.js");

const KEY = "topbar_regex_active_one" as const;

/** One custom stub shape used by several tests: `key#param` suffix semantics. */
const HASH_CUSTOM: I18nCustomStubSpec = {
	t: (key, opts) => (opts !== undefined ? `${key}#${String(opts.name)}` : key),
};

/** Renders `useT()`'s provider-less view of one `t`/`tDynamic` call pair. */
function TProbe() {
	const { t, tDynamic, locale, ready } = i18nContextModule.useT();
	return (
		<div
			data-testid="probe"
			data-t={t(KEY, { name: "Rex" })}
			data-td={tDynamic("dyn_key")}
			data-locale={locale}
			data-ready={String(ready)}
		/>
	);
}

/** Compares `useT()`'s value identity across renders (the `custom.stable` pin). */
function StabilityProbe() {
	const value = i18nContextModule.useT();
	const first = useRef(value);
	const [, force] = useState(0);
	return (
		<div>
			<button type="button" data-testid="rerender" onClick={() => force((n) => n + 1)}>r</button>
			<div
				data-testid="identity"
				data-value={String(first.current === value)}
				data-t={String(first.current.t === value.t)}
			/>
		</div>
	);
}

// R13: the delegation test drives the process-global i18next language.
afterAll(async () => {
	cleanup();
	await i18next.changeLanguage("en");
});

describe("i18n context seam — provider-less modes", () => {
	test("no spec: raw-key identity echo with the fixed family fields", () => {
		installI18nContextSeam();
		const { getByTestId } = render(<TProbe />);
		const probe = getByTestId("probe");
		expect(probe.getAttribute("data-t")).toBe(KEY);
		expect(probe.getAttribute("data-td")).toBe("dyn_key");
		expect(probe.getAttribute("data-locale")).toBe("en");
		expect(probe.getAttribute("data-ready")).toBe("true");
	});

	test("interpolateKeys: the listed key reads the bundled EN template (sanity-pinned), others echo", () => {
		expect(en[KEY]).toBe("Regex active: {name}");
		installI18nContextSeam({ interpolateKeys: [KEY] });
		const { getByTestId } = render(<TProbe />);
		expect(getByTestId("probe").getAttribute("data-t")).toBe("Regex active: Rex");
	});

	test("custom: the suite's own t runs verbatim; tDynamic defaults to identity", () => {
		installI18nContextSeam({ custom: HASH_CUSTOM });
		const { getByTestId } = render(<TProbe />);
		const probe = getByTestId("probe");
		expect(probe.getAttribute("data-t")).toBe(`${KEY}#Rex`);
		expect(probe.getAttribute("data-td")).toBe("dyn_key");
		expect(probe.getAttribute("data-locale")).toBe("en");
		expect(probe.getAttribute("data-ready")).toBe("true");
	});

	test("custom.tDynamic override: the suite's own dynamic-key semantics", () => {
		installI18nContextSeam({
			custom: { ...HASH_CUSTOM, tDynamic: (key: string) => `D:${key}` },
		});
		const { getByTestId } = render(<TProbe />);
		expect(getByTestId("probe").getAttribute("data-td")).toBe("D:dyn_key");
	});
});

describe("i18n context seam — delegation and stability", () => {
	test("a mounted LocaleProvider DELEGATES to real i18next even with a custom stub registered", () => {
		installI18nContextSeam({ custom: HASH_CUSTOM });
		// Real i18n (the sent-file-attachment precedent); RU so the result
		// cannot be confused with the EN table or the raw key echo.
		initI18n("ru");
		const { getByTestId } = render(
			<LocaleProvider initialLocale="ru">
				<TProbe />
			</LocaleProvider>,
		);
		const probe = getByTestId("probe");
		expect(probe.getAttribute("data-t")).toBe((ru[KEY] as string).replace("{name}", "Rex"));
		expect(probe.getAttribute("data-t")).not.toContain("#");
		expect(probe.getAttribute("data-locale")).toBe("ru");
	});

	test("custom.stable: useT() returns the SAME value object across renders", () => {
		installI18nContextSeam({ custom: { ...HASH_CUSTOM, stable: true } });
		const { getByTestId } = render(<StabilityProbe />);
		fireEvent.click(getByTestId("rerender"));
		const identity = getByTestId("identity");
		expect(identity.getAttribute("data-value")).toBe("true");
		expect(identity.getAttribute("data-t")).toBe("true");
	});

	test("without stable: per-render value, but t keeps identity (the spec's functions are created once)", () => {
		installI18nContextSeam({ custom: HASH_CUSTOM });
		const { getByTestId } = render(<StabilityProbe />);
		fireEvent.click(getByTestId("rerender"));
		const identity = getByTestId("identity");
		expect(identity.getAttribute("data-value")).toBe("false");
		expect(identity.getAttribute("data-t")).toBe("true");
	});
});
