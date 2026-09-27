import { describe, expect, mock, test } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../test/dom-env.js";

/**
 * Fly Tribunal settings rows (FT-9).
 *
 * L1 checklist:
 * 1. Paths: none.
 * 2. Restores: no globals or registries are changed.
 * 3. Determinism: synchronous row interactions only; no sleeps.
 * 4. Platform: happy-dom only.
 * 5. Shared worker pool: i18n fake spreads the real module.
 * 6. Stable state: rendered row roles and click callbacks are terminal state.
 */

useDomEnv();

const realI18n = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

const { fireEvent, render } = await import("@testing-library/react");
const { TweaksPanelBody } = await import("./TweaksPanel.js");
const { MobileSettings } = await import("./MobileSettings.js");

const settings = {
  theme: "dark",
  fontSize: 18,
  uiFontSize: 17,
  messageWidth: "medium" as const,
  lang: "en",
  showRail: true,
  lavaBlobs: false,
};

describe("Fly Tribunal settings rows", () => {
  test("desktop and mobile render a toggle plus gear that open the same tribunal surface", () => {
    const toggles: boolean[] = [];
    let opened = 0;
    const desktop = render(
      <TweaksPanelBody
        settings={settings}
        setSetting={() => {}}
        onOpenMobileAccess={() => {}}
        flyTribunalEnabled={false}
        onToggleFlyTribunal={(enabled) => toggles.push(enabled)}
        onOpenFlyTribunal={() => { opened += 1; }}
      />,
    );
    expect(desktop.getByTestId("fly-tribunal-desktop-row").textContent).toContain("fly_tribunal_title");
    fireEvent.click(desktop.getByRole("switch", { name: "fly_tribunal_title" }));
    fireEvent.click(desktop.getByLabelText("fly_tribunal_settings"));

    const mobile = render(
      <MobileSettings
        open={true}
        onClose={() => {}}
        settings={settings}
        setSetting={() => {}}
        onOpenMobileAccess={() => {}}
        flyTribunalEnabled={false}
        onToggleFlyTribunal={(enabled) => toggles.push(enabled)}
        onOpenFlyTribunal={() => { opened += 1; }}
      />,
    );
    expect(mobile.getByTestId("fly-tribunal-mobile-row").textContent).toContain("fly_tribunal_title");
    const switches = mobile.getAllByRole("switch", { name: "fly_tribunal_title" });
    fireEvent.click(switches[switches.length - 1]!);
    const gears = mobile.getAllByLabelText("fly_tribunal_settings");
    fireEvent.click(gears[gears.length - 1]!);

    expect(toggles).toEqual([true, true]);
    expect(opened).toBe(2);
  });
});
