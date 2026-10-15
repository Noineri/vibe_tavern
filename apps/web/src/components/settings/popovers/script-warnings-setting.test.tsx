import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { useScriptSafetySettingsStore } from "../../../stores/script-safety-settings-store.js";

useDomEnv();

// The «Script import warnings» row (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT
// step 10, owner ruling 4b) in both settings shells. The settings API is the
// mocked boundary; the real Zustand store and the real hook run.
const realSettingsApi = await import("../../../api/settings-api.js");
const getScriptSafetySettings = mock(async () => ({ suppressImportWarnings: false, updatedAt: "" }));
const updateScriptSafetySettings = mock(async (input: { suppressImportWarnings: boolean }) => ({
  suppressImportWarnings: input.suppressImportWarnings,
  updatedAt: "",
}));
mock.module("../../../api/settings-api.js", () => ({
  ...realSettingsApi,
  getScriptSafetySettings,
  updateScriptSafetySettings,
}));

const realUseMobile = await import("../../../hooks/use-mobile.js");
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realUseMobile,
  useIsMobile: () => false,
}));

const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { TweaksPanelBody } = await import("./TweaksPanel.js");
const { MobileSettings } = await import("./MobileSettings.js");

const baseSettings = {
  theme: "coffee" as const,
  fontSize: 17,
  uiFontSize: 17,
  messageWidth: "medium" as const,
  lang: "en",
  lavaBlobs: true,
};

const SHELLS = [
  {
    name: "desktop TweaksPanel",
    render: () => render(<TweaksPanelBody settings={baseSettings} setSetting={mock()} onOpenMobileAccess={mock()} />),
  },
  {
    name: "MobileSettings",
    render: () =>
      render(
        <MobileSettings
          open
          onClose={mock()}
          settings={{ ...baseSettings, showRail: true }}
          setSetting={mock()}
          onOpenMobileAccess={mock()}
        />,
      ),
  },
] as const;

beforeEach(() => {
  useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
  getScriptSafetySettings.mockClear();
  updateScriptSafetySettings.mockClear();
});

afterEach(() => {
  cleanup();
});

for (const shell of SHELLS) {
  describe(`script import warnings row — ${shell.name}`, () => {
    it("reads «warnings shown» as checked and suppressed as unchecked", () => {
      const shown = shell.render();
      expect(shown.getByRole("switch", { name: "tweaks_script_warnings" }).getAttribute("aria-checked")).toBe("true");
      cleanup();

      useScriptSafetySettingsStore.setState({ suppressImportWarnings: true });
      const suppressed = shell.render();
      expect(suppressed.getByRole("switch", { name: "tweaks_script_warnings" }).getAttribute("aria-checked")).toBe("false");
    });

    it("switching off suppresses the warnings, switching on brings them back", async () => {
      const view = shell.render();
      const toggle = view.getByRole("switch", { name: "tweaks_script_warnings" });

      fireEvent.click(toggle);
      await waitFor(() => {
        expect(updateScriptSafetySettings).toHaveBeenCalledWith({ suppressImportWarnings: true });
      });
      await waitFor(() => {
        expect(toggle.getAttribute("aria-checked")).toBe("false");
      });

      fireEvent.click(toggle);
      await waitFor(() => {
        expect(updateScriptSafetySettings).toHaveBeenLastCalledWith({ suppressImportWarnings: false });
      });
      await waitFor(() => {
        expect(toggle.getAttribute("aria-checked")).toBe("true");
      });
    });

    it("loads the flag on mount when it is not loaded yet", async () => {
      getScriptSafetySettings.mockImplementationOnce(async () => ({ suppressImportWarnings: true, updatedAt: "" }));
      useScriptSafetySettingsStore.setState({ suppressImportWarnings: null });
      const view = shell.render();
      await waitFor(() => {
        expect(view.getByRole("switch", { name: "tweaks_script_warnings" }).getAttribute("aria-checked")).toBe("false");
      });
      expect(getScriptSafetySettings).toHaveBeenCalledTimes(1);
    });
  });
}
