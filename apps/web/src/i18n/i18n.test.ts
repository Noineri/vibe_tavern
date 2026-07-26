/**
 * i18n interpolation delimiter hygiene.
 *
 * The project config (`i18n.ts`) sets `interpolation: { prefix: "{", suffix: "}" }`
 * — SINGLE-brace, not the i18next default `{{ }}`. Consequences (verified empirically):
 *
 *   - `{n}`      → interpolated (the value of `n`).
 *   - `{{n}}`    → rendered LITERALLY as `{{n}}` (NOT interpolated — looks broken in the UI).
 *   - `{{user}}` → rendered LITERALLY as `{{user}}` (intentional: these are ST-macro hints
 *                  shown to the user as literal text, e.g. "the {{user}} identity").
 *
 * Bug fixed here (regression guarded): 9 `scn_hist_*` keys used `{{var}}` for interpolation,
 * which rendered the raw braces in the Scene history backfill UI. They now use `{var}`.
 *
 * The literal `{{user}}` / `{{char}}` macros (SillyTavern syntax hints) are intentionally kept
 * double-braced — they must stay literal, which is exactly what the single-brace config does.
 *
 * Runner: bun:test.
 */
import { describe, it, expect } from "bun:test";
import i18next from "i18next";
import en from "./locales/en.json";
import ru from "./locales/ru.json";

/** SillyTavern macro tokens that are meant to be shown as literal text, not interpolated. */
const LITERAL_MACROS = new Set(["user", "char"]);

interface DoubleBrace {
	locale: string;
	key: string;
	inner: string;
}

type LocaleValue = string | number | boolean | null | readonly LocaleValue[] | { readonly [key: string]: LocaleValue };

/** Recursively collect every `{{...}}` occurrence in a locale object's string values. */
function collectDoubleBraces(data: LocaleValue, locale: string, key = "<root>", out: DoubleBrace[] = []): DoubleBrace[] {
	if (typeof data === "string") {
		const re = /\{\{([^}]+)\}\}/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(data)) !== null) out.push({ locale, key, inner: m[1]! });
	} else if (data !== null && typeof data === "object") {
		for (const [k, v] of Object.entries(data)) {
			collectDoubleBraces(v, locale, key === "<root>" ? k : `${key}.${k}`, out);
		}
	}
	return out;
}

describe("i18n interpolation delimiter hygiene", () => {
	it("no key uses {{var}} for interpolation; only {{user}}/{{char}} literals are allowed", () => {
		const offenders = [
			...collectDoubleBraces(en, "en"),
			...collectDoubleBraces(ru, "ru"),
		].filter((m) => !LITERAL_MACROS.has(m.inner));
		expect(offenders, "non-literal {{...}} found (single-brace config renders it verbatim)").toEqual([]);
	});

	it("scn_hist_* keys interpolate via single-brace {var} (regression: they used {{var}})", async () => {
		const inst = i18next.createInstance();
		await inst.init({
			lng: "en",
			resources: { en: { translation: en } },
			interpolation: { prefix: "{", suffix: "}" },
		});
		expect(String(inst.t("scn_hist_count_fill", { n: 5 }))).toBe("Up to 5 assistant messages");
		expect(String(inst.t("scn_hist_estimate", { cost: "0.42" }))).toBe("≈ $0.42 estimated output cost");
		expect(String(inst.t("scn_hist_progress", { processed: 2, total: 5 }))).toBe("2 / 5");
	});

	it("{{user}} / {{char}} stay literal (ST-macro hints, not interpolation)", async () => {
		const inst = i18next.createInstance();
		await inst.init({
			lng: "en",
			resources: { en: { translation: en } },
			interpolation: { prefix: "{", suffix: "}" },
		});
		expect(String(inst.t("dialog_examples_placeholder", { user: "Bob" }))).toBe("{{user}}: Hi!");
	});
});
