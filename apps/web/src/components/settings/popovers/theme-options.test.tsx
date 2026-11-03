
import { describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { useScriptSafetySettingsStore } from "../../../stores/script-safety-settings-store.js";

useDomEnv();

// Both shells now carry the script-warnings row, whose hook loads the
// server flag on mount. A loaded value makes that load a no-op, keeping the
// settings API out of these theme tests (the row has its own file:
// script-warnings-setting.test.tsx).
useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });

const { fireEvent, render, within } = await import("@testing-library/react");

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
  lavaBlobs: true,
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

  // MUI-W5 step 15: the Mobile Access entry was removed from the mobile
  // settings sheet (the feature is desktop-only). The text query is proven to
  // resolve labels in this render by the proxies assertion — both rows share
  // the same button shape, only the label differs.
  it("has no Mobile Access entry in mobile settings", () => {
    const { getByText, queryByText } = render(
      <MobileSettings
        open
        onClose={mock()}
        settings={{ ...baseSettings, showRail: true }}
        setSetting={mock()}
        onOpenMobileAccess={mock()}
      />,
    );

    expect(getByText("proxies")).toBeTruthy();
    expect(queryByText("mobile_access")).toBeNull();
    expect(queryByText("mobile_access_enable")).toBeNull();
  });

  // CNR-8m: the settings list rides the shared thin lane — flex-1 sizing on
  // the ScrollArea root under the fixed header (which stays docked outside
  // the scroller); the overscroll-contain + momentum-scrolling hints live on
  // the native viewport the primitive renders. The lane is the shared
  // [data-scroll-area] root, so the CNR-7g ≤768px media query hides its
  // chrome on phones (pinned in scroll-area.test.tsx).
  it("mobile settings body rides the shared thin lane with the header docked outside", () => {
    const { container, getByText } = render(
      <MobileSettings
        open
        onClose={mock()}
        settings={{ ...baseSettings, showRail: true }}
        setSetting={mock()}
        onOpenMobileAccess={mock()}
      />,
    );

    const lane = container.querySelector<HTMLElement>('[data-scroll-area="thin"]');
    expect(lane, "settings body must ride the shared thin lane").not.toBeNull();
    expect(lane?.className).toContain("flex-1");
    expect(lane?.querySelector("[data-scroll-viewport]")?.className).toContain("overscroll-y-none");
    expect(getByText("tweaks_title").closest("[data-scroll-area]")).toBeNull();
    expect(getByText("tweaks_theme").closest("[data-scroll-area]")).toBe(lane);
  });
});
