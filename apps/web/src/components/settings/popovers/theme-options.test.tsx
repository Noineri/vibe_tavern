import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileSettings } from "./MobileSettings.js";
import { TweaksPanelBody } from "./TweaksPanel.js";

vi.mock("../../../hooks/use-mobile.js", () => ({
  useIsMobile: () => false,
}));

const baseSettings = {
  theme: "coffee" as const,
  fontSize: 17,
  uiFontSize: 16,
  messageWidth: "medium" as const,
  lang: "en",
  lavaBlobs: true,
};

function themeRadios(container: HTMLElement): HTMLElement[] {
  const firstGroup = container.querySelector<HTMLElement>('[role="radiogroup"]');
  expect(firstGroup).not.toBeNull();
  return within(firstGroup!).getAllByRole("radio");
}

describe("theme settings", () => {
  it("offers Mystic Dawn with the outlined sparkle in desktop Tweaks", () => {
    const setSetting = vi.fn();
    const { container } = render(
      <TweaksPanelBody
        settings={baseSettings}
        setSetting={setSetting}
        onOpenMobileAccess={vi.fn()}
      />,
    );

    const radios = themeRadios(container);
    expect(radios).toHaveLength(6);
    expect(radios[2].querySelector("svg")?.getAttribute("fill")).toBe("none");

    fireEvent.click(radios[2]);
    expect(setSetting).toHaveBeenCalledWith("theme", "mystic-dawn");
  });

  it("offers Mystic Dawn in mobile settings", () => {
    const setSetting = vi.fn();
    const { container } = render(
      <MobileSettings
        open
        onClose={vi.fn()}
        settings={{ ...baseSettings, showRail: true }}
        setSetting={setSetting}
        onOpenMobileAccess={vi.fn()}
      />,
    );

    const radios = themeRadios(container);
    expect(radios).toHaveLength(6);
    expect(radios[2].querySelector("svg")?.getAttribute("fill")).toBe("none");

    fireEvent.click(radios[2]);
    expect(setSetting).toHaveBeenCalledWith("theme", "mystic-dawn");
  });
});
