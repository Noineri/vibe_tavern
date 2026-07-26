import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const realUseMobile = await import("../../../hooks/use-mobile.js");
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realUseMobile,
  useIsMobile: () => false,
}));

const { MobileSettings } = await import("./MobileSettings.js");
const { TweaksPanelBody } = await import("./TweaksPanel.js");

const baseSettings = {
  theme: "coffee" as const,
  fontSize: 17,
  uiFontSize: 16,
  messageWidth: "medium" as const,
  lang: "en",
};

function themeRadios(container: HTMLElement): HTMLElement[] {
  const firstGroup = container.querySelector<HTMLElement>('[role="radiogroup"]');
  expect(firstGroup).not.toBeNull();
  return within(firstGroup!).getAllByRole("radio");
}

describe("theme settings", () => {
  it("offers Mystic Dawn with the outlined sparkle in desktop Tweaks", () => {
		const setSetting = mock();
    const { container } = render(
      <TweaksPanelBody
        settings={baseSettings}
        setSetting={setSetting}
			onOpenMobileAccess={mock()}
      />,
    );

    const radios = themeRadios(container);
    expect(radios).toHaveLength(6);
    expect(radios[2].querySelector("svg")?.getAttribute("fill")).toBe("none");

    fireEvent.click(radios[2]);
    expect(setSetting).toHaveBeenCalledWith("theme", "mystic-dawn");
  });

  it("offers Mystic Dawn in mobile settings", () => {
		const setSetting = mock();
    const { container } = render(
      <MobileSettings
        open
			onClose={mock()}
        settings={{ ...baseSettings, showRail: true }}
        setSetting={setSetting}
			onOpenMobileAccess={mock()}
      />,
    );

    const radios = themeRadios(container);
    expect(radios).toHaveLength(6);
    expect(radios[2].querySelector("svg")?.getAttribute("fill")).toBe("none");

    fireEvent.click(radios[2]);
    expect(setSetting).toHaveBeenCalledWith("theme", "mystic-dawn");
  });
});
