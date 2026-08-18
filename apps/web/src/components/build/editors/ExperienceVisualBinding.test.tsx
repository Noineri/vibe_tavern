import { describe, it, expect, beforeAll, mock } from "bun:test";
import { render } from "@testing-library/react";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

// Mock the i18n context so `t` returns keys verbatim (stable labels). The
// `...real` spread keeps every other export intact (AGENTS.md mock.module
// gotcha — the mock is process-global in a shared bun test process).
const realI18n = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({ t: (k: string) => k, tDynamic: (k: string) => k, locale: "en", setLocale: () => {}, ready: true }),
}));

// Tooltip passthrough (CustomTooltip needs a TooltipProvider at runtime —
// irrelevant to these class pins). Same pattern as ExperienceEditor.test.tsx.
const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

const { ExperienceVisualBinding } = await import("./ExperienceVisualBinding.js");
import type { ReactNode } from "react";
import type { ExperienceVisualRow } from "../../../api/types.js";
function row(id: string, name: string): ExperienceVisualRow {
  return {
    id,
    name,
    source: "",
    sourceHash: "",
    apiVersion: 1,
    compatibleManifestIds: [],
    scopeType: "global",
    characterId: null,
    personaId: null,
    chatId: null,
    createdAt: "",
    updatedAt: "",
  };
}

// ── 4a phase (e): mobile touch-target class pins ───────────────────────────
// happy-dom computes no layout, so these are CLASS pins: the bound pill (a
// DESTRUCTIVE tap — it unbinds on click) and the dashed "+" trigger grow to
// the project's 36px touch floor on mobile via max-md utilities; desktop
// keeps the original 22px sizes (the max-md:* classes are inert at >=md).
describe("ExperienceVisualBinding — mobile touch targets (4a phase e)", () => {
  it("bound pills carry the mobile 36px height floor", () => {
    const { container } = render(
      <ExperienceVisualBinding
        bound={[row("v1", "Board"), row("v2", "Cards")]}
        available={[row("v1", "Board"), row("v2", "Cards")]}
        onToggle={() => {}}
      />,
    );
    const pills = [...container.querySelectorAll<HTMLElement>("div.rounded-full.border.cursor-pointer")];
    expect(pills.length).toBe(2);
    for (const pill of pills) {
      expect(pill.classList.contains("h-[22px]")).toBe(true); // desktop size kept
      expect(pill.classList.contains("max-md:h-9")).toBe(true); // mobile floor
    }
  });

  it("the dashed '+' trigger is 36x36 on mobile", () => {
    const { getByRole } = render(
      <ExperienceVisualBinding bound={[]} available={[row("v1", "Board")]} onToggle={() => {}} />,
    );
    const trigger = getByRole("button") as HTMLButtonElement;
    expect(trigger.classList.contains("h-[22px]")).toBe(true);
    expect(trigger.classList.contains("w-[22px]")).toBe(true);
    expect(trigger.classList.contains("max-md:h-9")).toBe(true);
    expect(trigger.classList.contains("max-md:w-9")).toBe(true);
  });
});
