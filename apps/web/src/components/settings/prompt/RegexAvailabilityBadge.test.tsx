import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { RegexProfileAvailability, RegexRuleAvailability } from "../../../lib/regex-availability.js";

useDomEnv();
const { render } = await import("@testing-library/react");
const realI18nContext = await import("../../../i18n/context.js");
const { default: en } = await import("../../../i18n/locales/en.json");
const { default: ru } = await import("../../../i18n/locales/ru.json");

let activeLocale: "en" | "ru" | null = null;

function pluralKey(key: string, count: number | undefined): string {
  if (key !== "promptManager.regex.availabilityActiveRules" || count === undefined) return key;
  if (activeLocale === "en") return `${key}_${count === 1 ? "one" : "other"}`;
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${key}_one`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${key}_few`;
  return `${key}_many`;
}

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const resolvedKey = pluralKey(key, typeof opts?.count === "number" ? opts.count : undefined);
      const text = activeLocale === "en"
        ? en[resolvedKey as keyof typeof en]
        : activeLocale === "ru"
          ? ru[resolvedKey as keyof typeof ru]
          : undefined;
      const rendered = text ?? key;
      return opts?.count === undefined ? rendered : rendered.replace("{count}", String(opts.count));
    },
    tDynamic: (key: string) => key,
    locale: activeLocale ?? "en",
    setLocale: () => {},
    ready: true,
  }),
}));

let RegexAvailabilityBadge: typeof import("./RegexAvailabilityBadge.js").RegexAvailabilityBadge;
beforeAll(async () => {
  ({ RegexAvailabilityBadge } = await import("./RegexAvailabilityBadge.js"));
});

afterAll(() => {
  activeLocale = null;
});

const statuses: Array<{ availability: RegexProfileAvailability | RegexRuleAvailability; en: string; ru: string }> = [
  { availability: { kind: "disabled" }, en: "Disabled", ru: "Отключено" },
  { availability: { kind: "unbound" }, en: "Unbound", ru: "Не привязано" },
  { availability: { kind: "noEnabledRules" }, en: "No enabled Rules", ru: "Нет включённых правил" },
  { availability: { kind: "active", enabledRuleCount: 3 }, en: "Active · 3 Rules", ru: "Активно · 3 правила" },
  { availability: { kind: "active", profile: null }, en: "Active", ru: "Активно" },
];

function renderBadge(locale: "en" | "ru", availability: RegexProfileAvailability | RegexRuleAvailability) {
  activeLocale = locale;
  return render(<RegexAvailabilityBadge availability={availability} />);
}

describe("RegexAvailabilityBadge", () => {
  for (const status of statuses) {
    it(`renders ${status.availability.kind} as text and an accessible EN label`, () => {
      const view = renderBadge("en", status.availability);
      const badge = view.getByLabelText(status.en);
      expect(badge.textContent).toBe(status.en);
    });

    it(`renders ${status.availability.kind} as text and an accessible RU label`, () => {
      const view = renderBadge("ru", status.availability);
      const badge = view.getByLabelText(status.ru);
      expect(badge.textContent).toBe(status.ru);
    });
  }

  it("withholds loading until the link count is known", () => {
    const view = renderBadge("en", { kind: "loading" });
    expect(view.container.firstChild).toBeNull();
  });
});
