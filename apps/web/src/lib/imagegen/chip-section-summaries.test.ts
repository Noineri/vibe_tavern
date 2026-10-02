import { describe, expect, it } from "bun:test";

// Real i18next with the committed locale files — the summaries' plural calls
// must resolve through the ACTUAL ru/en plural rules (the i18n.test.ts
// precedent: initI18n configures the global instance a pure test can read
// through getT()).
import { initI18n } from "../../i18n/i18n.js";
import { getT } from "../../i18n/locale-helpers.js";
import {
  adetailerSummary,
  hiresSummary,
  kreaSummary,
  lorasSummary,
  samplersSummary,
} from "./chip-section-summaries.js";

const KREA_OPTIONS = [
  { value: "raw", labelKey: "image_gen_krea_creativity_raw" },
  { value: "low", labelKey: "image_gen_krea_creativity_low" },
  { value: "medium", labelKey: "image_gen_krea_creativity_medium" },
  { value: "high", labelKey: "image_gen_krea_creativity_high" },
] as const;

describe("chip-section-summaries (ICR-2)", () => {
  it("lorasSummary: count > 0 uses the enabled plural, 0 says «не выбраны» (RU)", () => {
    initI18n("ru");
    const t = getT();
    expect(lorasSummary(3, t)).toBe("Включено: 3");
    expect(lorasSummary(0, t)).toBe("не выбраны");
  });

  it("hiresSummary: off = «выкл»; on shows the effective steps/scale incl. RU plurals 1/2/5/21 and display anchors", () => {
    initI18n("ru");
    const t = getT();
    expect(hiresSummary({ enabled: false }, { steps: 0, scale: 2 }, t)).toBe("выкл");

    // Set values render verbatim.
    expect(hiresSummary({ enabled: true, steps: 20, scale: 1.5 }, { steps: 0, scale: 2 }, t)).toBe(
      "×1.5 · шагов: 20",
    );
    // Unset values fall to the DISPLAY ANCHORS (the same values the sliders
    // show — never a bare default).
    expect(hiresSummary({ enabled: true }, { steps: 0, scale: 2 }, t)).toBe("×2 · шагов: 0");

    // The plural ladder: 1 → шаг, 2 → шага, 5/21-24… → шагов.
    expect(hiresSummary({ enabled: true, steps: 1, scale: 1.5 }, { steps: 0, scale: 2 }, t)).toBe(
      "×1.5 · шаг: 1",
    );
    expect(hiresSummary({ enabled: true, steps: 2, scale: 1.5 }, { steps: 0, scale: 2 }, t)).toBe(
      "×1.5 · шага: 2",
    );
    expect(hiresSummary({ enabled: true, steps: 5, scale: 1.5 }, { steps: 0, scale: 2 }, t)).toBe(
      "×1.5 · шагов: 5",
    );
    expect(hiresSummary({ enabled: true, steps: 21, scale: 1.5 }, { steps: 0, scale: 2 }, t)).toBe(
      "×1.5 · шаг: 21",
    );
  });

  it("adetailerSummary: off = «выкл»; on shows the detector model + steps plural", () => {
    initI18n("ru");
    const t = getT();
    expect(adetailerSummary(false, "face_yolov8m.pt", 12, t)).toBe("выкл");
    expect(adetailerSummary(true, "face_yolov8m.pt", 12, t)).toBe("face_yolov8m.pt · шагов: 12");
    expect(adetailerSummary(true, "face_yolov8m.pt", 1, t)).toBe("face_yolov8m.pt · шаг: 1");
  });

  it("samplersSummary: present parts joined with « · », unset rendered controls read «Авто», absent controls are omitted", () => {
    initI18n("ru");
    const t = getT();
    // The mockup's line: euler · simple · шагов: 8 · CFG 1.
    expect(
      samplersSummary({ sampler: "euler", scheduler: "simple", steps: 8, cfgScale: 1 }, t),
    ).toBe("euler · simple · шагов: 8 · CFG 1");

    // Rendered-but-unset → Авто; steps uses the plural ladder.
    expect(samplersSummary({ sampler: undefined, scheduler: undefined, steps: 21 }, t)).toBe(
      "Авто · Авто · шаг: 21",
    );

    // ABSENT keys (control not rendered for this backend) → part omitted.
    expect(samplersSummary({ sampler: "euler_ancestral", cfgScale: 4.5 }, t)).toBe(
      "euler_ancestral · CFG 4.5",
    );
    expect(samplersSummary({}, t)).toBe("");
  });

  it("kreaSummary: the translated creativity label; unknown values fall back to the raw string", () => {
    initI18n("ru");
    const t = getT();
    expect(kreaSummary("high", KREA_OPTIONS, t)).toBe(t("image_gen_krea_creativity_high"));
    expect(kreaSummary("nonsense", KREA_OPTIONS, t)).toBe("nonsense");
  });

  it("EN ladder: one/other plural forms resolve through the en resources", async () => {
    // initI18n is guarded (single init); the language switch goes through
    // the shared instance's changeLanguage — getT reads it at call time.
    const { i18next } = await import("../../i18n/i18n.js");
    await i18next.changeLanguage("en");
    const t = getT();
    expect(hiresSummary({ enabled: true, steps: 20, scale: 1.5 }, { steps: 0, scale: 2 }, t)).toBe(
      "×1.5 · 20 steps",
    );
    expect(hiresSummary({ enabled: true, steps: 1, scale: 1.5 }, { steps: 0, scale: 2 }, t)).toBe(
      "×1.5 · 1 step",
    );
    expect(lorasSummary(0, t)).toBe("none");
    expect(hiresSummary({ enabled: false }, { steps: 0, scale: 2 }, t)).toBe("off");
    expect(samplersSummary({ sampler: "euler", scheduler: "simple", steps: 8, cfgScale: 1 }, t)).toBe(
      "euler · simple · 8 steps · CFG 1",
    );
  });
});
