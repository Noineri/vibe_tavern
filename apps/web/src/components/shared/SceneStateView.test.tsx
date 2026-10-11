/**
 * SceneStateView — schema-aware renderer characterization.
 *
 * Pins the rendering contract shared by the Scene zone (expanded, rich) and the
 * TrackerConfig Preview (rich/compact/json): bounded numbers render an a11y
 * meter with correct fill at endpoints + out-of-range clamp, compact shows the
 * range text instead of a bar, nested objects/arrays recurse (so array-of-object
 * renders the fields — NOT `[object Object]`), missing leaves show an em-dash,
 * and `stale` dims the whole view. Runner: bun:test with scoped happy-dom. Pure component —
 * no stores/i18n to mock.
 */
import { describe, it, expect } from "bun:test";
import { createElement } from "react";

import { useDomEnv } from "../../../test/dom-env.js";
import { SceneStateView } from "./SceneStateView.js";
import type { SceneTrackerDsl } from "@vibe-tavern/domain";
import type { SceneRenderVariant } from "../../stores/scene-render-store.js";

useDomEnv();

const { render } = await import("@testing-library/react");

/** Render helper — `as const` on the schema keeps `$type` literals narrow. */
function r(
  schema: SceneTrackerDsl,
  data: Record<string, unknown>,
  variant: SceneRenderVariant = "rich",
  stale?: boolean,
) {
  return render(createElement(SceneStateView, { schema, data, variant, stale })).container;
}

/** The meter element + its fill bar for a single-field schema, or null. */
function meterOf(container: HTMLElement): { meter: HTMLElement | null; fill: HTMLElement | null } {
  const meter = container.querySelector('[role="meter"]');
  return { meter: meter as HTMLElement | null, fill: meter?.firstElementChild as HTMLElement | null };
}

describe("SceneStateView — bounded number (rich meter)", () => {
  const schema = { hp: { $type: "number", min: 0, max: 100 } } as const satisfies SceneTrackerDsl;

  it("renders a meter with aria value attrs + the numeric value at 75%", () => {
    const c = r(schema, { hp: 75 });
    const { meter, fill } = meterOf(c);
    expect(meter).not.toBeNull();
    expect(meter!.getAttribute("aria-valuenow")).toBe("75");
    expect(meter!.getAttribute("aria-valuemin")).toBe("0");
    expect(meter!.getAttribute("aria-valuemax")).toBe("100");
    expect(fill!.style.width).toBe("75%");
    expect(c.textContent).toContain("75");
  });

  it("renders 0% fill at the minimum", () => {
    expect(meterOf(r(schema, { hp: 0 })).fill!.style.width).toBe("0%");
  });

  it("renders 100% fill at the maximum", () => {
    expect(meterOf(r(schema, { hp: 100 })).fill!.style.width).toBe("100%");
  });

  it("renders 50% fill at the midpoint", () => {
    expect(meterOf(r(schema, { hp: 50 })).fill!.style.width).toBe("50%");
  });

  it("clamps an over-max value to 100%", () => {
    expect(meterOf(r(schema, { hp: 999 })).fill!.style.width).toBe("100%");
  });

  it("clamps an under-min value to 0%", () => {
    expect(meterOf(r(schema, { hp: -50 })).fill!.style.width).toBe("0%");
  });

  it("respects a non-zero min for the fill ratio", () => {
    const s = { level: { $type: "number", min: 1, max: 5 } } as const satisfies SceneTrackerDsl;
    // 3 on a 1–5 scale → (3-1)/(5-1) = 50%
    expect(meterOf(r(s, { level: 3 })).fill!.style.width).toBe("50%");
  });
});

describe("SceneStateView — compact variant", () => {
  it("bounded number shows value + range text, NOT a meter", () => {
    const c = r({ hp: { $type: "number", min: 0, max: 100 } }, { hp: 75 }, "compact");
    expect(c.querySelector('[role="meter"]')).toBeNull();
    expect(c.textContent).toContain("75");
    expect(c.textContent).toContain("0–100");
  });

  it("has no tree border chrome (compact object has no border-l)", () => {
    const schema = { loc: { $type: "object", properties: { room: { $type: "string" } } } } as const satisfies SceneTrackerDsl;
    const c = r(schema, { loc: { room: "tavern" } }, "compact");
    expect(c.textContent).toContain("tavern");
    // The rich variant adds border-l wrappers; compact must not.
    expect(c.querySelectorAll(".border-l").length).toBe(0);
  });
});

describe("SceneStateView — leaves", () => {
  it("unbounded number renders as plain text (no meter)", () => {
    const c = r({ count: { $type: "number" } }, { count: 42 });
    expect(c.querySelector('[role="meter"]')).toBeNull();
    expect(c.textContent).toContain("42");
  });

  it("boolean true→✓, false→✗, missing→—", () => {
    expect(r({ a: { $type: "boolean" } }, { a: true }).textContent).toContain("✓");
    expect(r({ a: { $type: "boolean" } }, { a: false }).textContent).toContain("✗");
    expect(r({ a: { $type: "boolean" } }, {}).textContent).toContain("—");
  });

  it("string renders the value text", () => {
    expect(r({ mood: { $type: "string" } }, { mood: "tense" }).textContent).toContain("tense");
  });

  it("missing number renders an em-dash", () => {
    expect(r({ hp: { $type: "number", min: 0, max: 10 } }, {}).textContent).toContain("—");
  });
});

describe("SceneStateView — recursion (objects / arrays)", () => {
  it("nested object renders its fields + the container label", () => {
    const schema = { loc: { $type: "object", properties: { room: { $type: "string" } } } } as const satisfies SceneTrackerDsl;
    const c = r(schema, { loc: { room: "tavern" } });
    expect(c.textContent).toContain("loc");
    expect(c.textContent).toContain("tavern");
  });

  it("array of primitives renders each item; an empty array shows the i18n empty state, never []", () => {
    const schema = { tags: { $type: "array", items: { $type: "string" } } } as const satisfies SceneTrackerDsl;
    expect(r(schema, { tags: ["a", "b"] }).textContent).toContain("a");
    expect(r(schema, { tags: ["a", "b"] }).textContent).toContain("b");
    // Without a LocaleProvider, the context's deterministic test fallback is the key itself.
    const empty = r(schema, { tags: [] }).textContent;
    expect(empty).toContain("scn_state_empty");
    expect(empty).not.toContain("[]");
  });

  it("array of objects renders each object's fields, NOT [object Object]", () => {
    const schema = {
      party: {
        $type: "array",
        items: { $type: "object", properties: { name: { $type: "string" }, hp: { $type: "number", min: 0, max: 50 } } },
      },
    } as const satisfies SceneTrackerDsl;
    const c = r(schema, { party: [{ name: "Aria", hp: 30 }, { name: "Bo", hp: 12 }] });
    expect(c.textContent).toContain("Aria");
    expect(c.textContent).toContain("Bo");
    expect(c.textContent).toContain("30");
    expect(c.textContent).toContain("12");
    expect(c.textContent).not.toContain("[object Object]");
    // Each object item is numbered.
    expect(c.textContent).toContain("#1");
    expect(c.textContent).toContain("#2");
  });
});

describe("SceneStateView — shared-core defect fixes", () => {
  it("a fixed min=max number is a plain value, never a zero-width meter", () => {
    const c = r({ cost: { $type: "number", min: 30, max: 30 } }, { cost: 30 });
    expect(c.querySelector('[role="meter"]')).toBeNull();
    expect(c.textContent).toContain("30");
    expect(c.textContent).not.toContain("30–30");
  });

  it("a huge range is a plain value with a muted maximum, never a sliver meter", () => {
    const c = r({ credits: { $type: "number", min: 0, max: 999999 } }, { credits: 30 });
    expect(c.querySelector('[role="meter"]')).toBeNull();
    expect(c.textContent).toContain("30 / 999999");
    const maximum = Array.from(c.querySelectorAll("span")).find((el) => el.textContent === " / 999999");
    expect(maximum?.className).toContain("text-t4");
  });

  it("rich labels remain verbatim while compact keeps its established dense separator", () => {
    const schema = { day: { $type: "string", label: "Day:" } } as const satisfies SceneTrackerDsl;
    const rich = r(schema, { day: "Monday" });
    const compact = r(schema, { day: "Monday" }, "compact");
    expect(rich.textContent).toContain("Day:Monday");
    expect(rich.textContent).not.toContain("Day::");
    expect(compact.textContent).toContain("Day:Monday");
    expect(compact.textContent).not.toContain("Day::");
  });

  it("array records prefer schema labels over numbered fallback identifiers and raw field keys", () => {
    const schema = {
      party: {
        $type: "array",
        items: {
          $type: "object",
          label: "Companion",
          properties: { name: { $type: "string", label: "Name" }, rank: { $type: "string", label: "Rank" } },
        },
      },
    } as const satisfies SceneTrackerDsl;
    const c = r(schema, { party: [{ name: "Aria", rank: "Captain" }] });
    expect(c.textContent).toContain("Companion");
    expect(c.textContent).toContain("Name");
    expect(c.textContent).toContain("Rank");
    expect(c.textContent).not.toContain("#1");
    expect(c.textContent).not.toContain("name:");
    expect(c.textContent).not.toContain("rank:");
  });
});

describe("SceneStateView — clean variant", () => {
  it("renders top-level groups as hairline-headed cards, short scalar triplets, and right-aligned meters without rich rails", () => {
    const schema = {
      citadel: {
        $type: "object",
        label: "Citadel",
        properties: {
          name: { $type: "string", label: "Name" },
          rank: { $type: "string", label: "Rank" },
          active: { $type: "boolean", label: "Active" },
          level: { $type: "number", min: 0, max: 100, label: "Level" },
        },
      },
    } as const satisfies SceneTrackerDsl;
    const c = r(schema, { citadel: { name: "Aster", rank: "UR", active: true, level: 25 } }, "clean");
    expect(c.querySelectorAll(".scene-state-clean-card").length).toBe(1);
    expect(c.querySelector(".scene-state-clean-group-header")?.textContent).toContain("Citadel");
    expect(c.querySelector(".scene-state-clean-triplet")?.textContent).toContain("NameAster·RankUR·Active✓");
    expect(c.querySelectorAll(".scene-state-clean-separator").length).toBe(2);
    expect(c.querySelectorAll(".border-l").length).toBe(0);
    const { meter } = meterOf(c);
    expect(meter?.className).toContain("scene-state-clean-meter");
    expect(meter?.className).toContain("ml-auto");
  });

  it("keeps record labels and shared empty, fixed-value, and huge-range behavior", () => {
    const records = {
      companions: {
        $type: "array",
        label: "Companions",
        items: {
          $type: "object",
          label: "Companion",
          properties: { name: { $type: "string", label: "Name" }, rank: { $type: "string", label: "Rank" } },
        },
      },
      reserve: { $type: "array", label: "Reserve", items: { $type: "string" } },
      fixed: { $type: "number", min: 30, max: 30, label: "Cost" },
      huge: { $type: "number", min: 0, max: 999999, label: "Credits" },
    } as const satisfies SceneTrackerDsl;
    const c = r(records, { companions: [{ name: "Aria", rank: "Captain" }], reserve: [], fixed: 30, huge: 30 }, "clean");
    expect(c.querySelector(".scene-state-clean-record")?.textContent).toContain("CompanionNameAria·RankCaptain");
    expect(c.textContent).not.toContain("#1");
    expect(c.textContent).toContain("scn_state_empty");
    expect(c.textContent).toContain("30 / 999999");
    expect(c.querySelectorAll('[role="meter"]').length).toBe(0);
  });
});

describe("SceneStateView — HUD variant", () => {
  it("renders schema-ordered HUD panels, dot leaders, and bracketed object records without renaming schema labels", () => {
    const schema = {
      status: {
        $type: "object",
        label: "Статус сцены",
        properties: {
          condition: { $type: "string", label: "Состояние" },
          active: { $type: "boolean", label: "Активно" },
        },
      },
      party: {
        $type: "array",
        label: "Группа",
        items: {
          $type: "object",
          label: "Спутник",
          properties: { name: { $type: "string", label: "Имя" } },
        },
      },
    } as const satisfies SceneTrackerDsl;
    const c = r(schema, { status: { condition: "Спокойно", active: true }, party: [{ name: "Арина" }] }, "hud");
    expect(c.firstElementChild?.className).toContain("font-mono");
    expect(c.querySelectorAll(".scene-state-hud-panel").length).toBe(2);
    expect(c.querySelectorAll(".scene-state-hud-dot-leader").length).toBe(3);
    expect(c.querySelectorAll(".scene-state-hud-record").length).toBe(1);
    expect(c.querySelectorAll(".scene-state-hud-corner").length).toBe(2);
    const schemaLabel = Array.from(c.querySelectorAll(".scene-state-hud-label")).find((el) => el.textContent === "Состояние");
    expect(schemaLabel?.textContent).toBe("Состояние");
    expect(schemaLabel?.className).toContain("uppercase");
    // Object group order remains the schema insertion order, not a HUD-guessed order.
    expect(c.textContent!.indexOf("Статус сцены")).toBeLessThan(c.textContent!.indexOf("Группа"));
  });

  it("normalizes 7/100 across twenty segments with a 40%-filled final cell", () => {
    const c = r({ hp: { $type: "number", min: 0, max: 100, label: "HP" } }, { hp: 7 }, "hud");
    const { meter } = meterOf(c);
    const fills = Array.from(c.querySelectorAll(".scene-state-hud-meter-segment > span")) as HTMLElement[];
    expect(meter?.getAttribute("aria-valuenow")).toBe("7");
    expect(fills.length).toBe(20);
    expect(fills[0].style.width).toBe("100%");
    expect(Number.parseFloat(fills[1].style.width)).toBeCloseTo(40, 6);
    expect(fills.slice(2).every((fill) => fill.style.width === "0%")).toBe(true);
  });

  it("normalizes 1/100 to one fifth of a cell, never a full five-percent segment", () => {
    const c = r({ hp: { $type: "number", min: 0, max: 100 } }, { hp: 1 }, "hud");
    const fills = Array.from(c.querySelectorAll(".scene-state-hud-meter-segment > span")) as HTMLElement[];
    expect(fills[0].style.width).toBe("20%");
    expect(fills[0].style.width).not.toBe("100%");
    expect(fills[1].style.width).toBe("0%");
  });

  it("inherits the shared empty, fixed-value, and huge-range gates", () => {
    const schema = {
      reserve: { $type: "array", label: "Резерв", items: { $type: "string" } },
      cost: { $type: "number", min: 30, max: 30, label: "Стоимость" },
      credits: { $type: "number", min: 0, max: 999999, label: "Кредиты" },
    } as const satisfies SceneTrackerDsl;
    const c = r(schema, { reserve: [], cost: 30, credits: 30 }, "hud");
    expect(c.textContent).toContain("scn_state_empty");
    expect(c.textContent).toContain("30 / 999999");
    expect(c.querySelector('[role="meter"]')).toBeNull();
  });
});

describe("SceneStateView — stale + shared coverage", () => {
  it("stale=true adds opacity-50 to the root", () => {
    const c = r({ a: { $type: "string" } }, { a: "x" }, "rich", true);
    expect(c.firstElementChild?.className).toContain("opacity-50");
  });

  it("stale omitted does NOT dim", () => {
    const c = r({ a: { $type: "string" } }, { a: "x" }, "rich");
    expect(c.firstElementChild?.className).not.toContain("opacity-50");
  });

  it("rich and compact surface the same keys and values for a mixed schema", () => {
    const schema = { mood: { $type: "string" }, hp: { $type: "number", min: 0, max: 100 } } as const satisfies SceneTrackerDsl;
    const data = { mood: "calm", hp: 80 };
    const rich = r(schema, data, "rich").textContent;
    const compact = r(schema, data, "compact").textContent;
    for (const needle of ["mood", "calm", "hp", "80"]) {
      expect(rich).toContain(needle);
      expect(compact).toContain(needle);
    }
  });
});

describe("SceneStateView — string values wrap (E1, MOBILE_DEFECTS_ROUND_2)", () => {
  it("the string leaf wraps long values — no truncate/nowrap, anywhere-break", () => {
    const long = "supercalifragilistic-unbroken-token-".repeat(4);
    const c = r({ mood: { $type: "string" } }, { mood: long });
    const span = Array.from(c.querySelectorAll("span")).find((el) => el.textContent === long);
    expect(span).toBeDefined();
    // `truncate` (nowrap+ellipsis) clipped on desktop and inflated min-content
    // width on mobile (horizontal scroll) — the leaf must wrap instead.
    expect(span!.className).toContain("[overflow-wrap:anywhere]");
    expect(span!.className).not.toContain("truncate");
    expect(span!.className).not.toContain("whitespace-nowrap");
  });
});

describe("SceneStateView — per-node `label` (label || key)", () => {
  it("shows the `label` instead of the raw key when present", () => {
    const schema = {
      mood: { $type: "string", label: "Настроение" },
      hp: { $type: "number", min: 0, max: 100, label: "Здоровье" },
    } as const satisfies SceneTrackerDsl;
    const c = r(schema, { mood: "tense", hp: 80 });
    expect(c.textContent).toContain("Настроение");
    expect(c.textContent).toContain("Здоровье");
    // The raw machine keys do NOT render (they stay data/serialization identity).
    expect(c.textContent).not.toContain("mood:");
    expect(c.textContent).not.toContain("hp:");
  });

  it("falls back to the raw key when no `label` is set", () => {
    const schema = { mood: { $type: "string" } } as const satisfies SceneTrackerDsl;
    expect(r(schema, { mood: "calm" }).textContent).toContain("mood");
  });

  it("uses the `label` on nested object fields and array items too", () => {
    const schema = {
      npc: {
        $type: "object",
        label: "Персонаж",
        properties: { trust: { $type: "number", min: 0, max: 10, label: "Доверие" } },
      },
      party: {
        $type: "array",
        label: "Группа",
        items: { $type: "object", properties: { name: { $type: "string", label: "Имя" } } },
      },
    } as const satisfies SceneTrackerDsl;
    const c = r(schema, { npc: { trust: 7 }, party: [{ name: "Aria" }] });
    expect(c.textContent).toContain("Персонаж");
    expect(c.textContent).toContain("Доверие");
    expect(c.textContent).toContain("Группа");
    expect(c.textContent).toContain("Имя");
    expect(c.textContent).toContain("Aria");
  });
});
