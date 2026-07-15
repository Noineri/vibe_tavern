/**
 * SceneStateView — schema-aware renderer characterization.
 *
 * Pins the rendering contract shared by the Scene zone (expanded, rich) and the
 * TrackerConfig Preview (rich/compact/json): bounded numbers render an a11y
 * meter with correct fill at endpoints + out-of-range clamp, compact shows the
 * range text instead of a bar, nested objects/arrays recurse (so array-of-object
 * renders the fields — NOT `[object Object]`), missing leaves show an em-dash,
 * and `stale` dims the whole view. Runner: vitest (apps/web). Pure component —
 * no stores/i18n to mock.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { render, cleanup } from "@testing-library/react";
import { SceneStateView } from "./SceneStateView.js";
import type { SceneTrackerDsl } from "@vibe-tavern/domain";

afterEach(cleanup);

/** Render helper — `as const` on the schema keeps `$type` literals narrow. */
function r(
  schema: SceneTrackerDsl,
  data: Record<string, unknown>,
  variant: "rich" | "compact" = "rich",
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

  it("array of primitives renders each item; empty shows []", () => {
    const schema = { tags: { $type: "array", items: { $type: "string" } } } as const satisfies SceneTrackerDsl;
    expect(r(schema, { tags: ["a", "b"] }).textContent).toContain("a");
    expect(r(schema, { tags: ["a", "b"] }).textContent).toContain("b");
    expect(r(schema, { tags: [] }).textContent).toContain("[]");
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
