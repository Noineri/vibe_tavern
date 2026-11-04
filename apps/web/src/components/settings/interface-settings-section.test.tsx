import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Window as HappyWindow } from "happy-dom";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv({ failOnNetwork: true });

const { render, fireEvent, within, cleanup, act } = await import("@testing-library/react");
const { registerInterfaceSettingsSection } = await import("./interface-settings-section.js");
const { SettingsModal } = await import("../modals/SettingsModal.js");
const { TweaksPanelBody } = await import("./popovers/TweaksPanel.js");
const { MobileSettings } = await import("./popovers/MobileSettings.js");
const { useModalStore } = await import("../../stores/modal-store.js");
const { useInterfaceSettingsStore, INTERFACE_SETTINGS_STORAGE_KEY } = await import("../../stores/interface-settings-store.js");
const { useScriptSafetySettingsStore } = await import("../../stores/script-safety-settings-store.js");
const { getSettingsSections, registerSettingsSection } = await import("../../lib/settings-section-registry.js");

// L1: real registry, stores, shells and modal; no navigation doubles.
// No paths, waits, DBs, i18n initialization or module mocks.
// Registry, viewport, state and the one mutated storage key are restored.
const originalModal = useModalStore.getState();
const originalPreferences = useInterfaceSettingsStore.getState();
const originalWarnings = useScriptSafetySettingsStore.getState();
const originalStored = localStorage.getItem(INTERFACE_SETTINGS_STORAGE_KEY);
const originalSections = getSettingsSections();
const originalWidth = window.innerWidth;
const browser = window as unknown as HappyWindow;
const disposeSection = registerInterfaceSettingsSection();
const temporarySections: Array<() => void> = [];

function restore() {
  useModalStore.setState(originalModal, true);
  useInterfaceSettingsStore.setState(originalPreferences, true);
  useScriptSafetySettingsStore.setState(originalWarnings, true);
  if (originalStored === null) localStorage.removeItem(INTERFACE_SETTINGS_STORAGE_KEY);
  else localStorage.setItem(INTERFACE_SETTINGS_STORAGE_KEY, originalStored);
  browser.happyDOM.setWindowSize({ width: originalWidth });
}

beforeEach(() => {
  restore();
  browser.happyDOM.setWindowSize({ width: 1280 });
  useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
  useInterfaceSettingsStore.getState().updateSettings({ theme: "coffee", fontSize: 17, uiFontSize: 17, messageWidth: "medium", lang: "en" });
  useModalStore.getState().setTweaksOpen(true);
});
afterEach(() => { cleanup(); for (const dispose of temporarySections.splice(0)) dispose(); restore(); });
afterAll(() => {
  disposeSection();
  for (const section of originalSections) registerSettingsSection(section);
  restore();
});

function Host({ mobile = false }: { mobile?: boolean }) {
  const quickOpen = useModalStore((state) => state.tweaksOpen);
  return <>
    {mobile ? <MobileSettings open={quickOpen} onClose={() => useModalStore.getState().setTweaksOpen(false)} /> : quickOpen && <TweaksPanelBody />}
    <SettingsModal />
  </>;
}

describe("interface section entry", () => {
  test("registers only the real Interface body, with no data or future-section placeholders", () => {
    expect(getSettingsSections().map((section) => section.id)).toEqual(["interface"]);
    useModalStore.getState().openSettings("interface");
    const view = render(<SettingsModal />);
    expect(view.getByRole("region", { name: "settings_section_interface" })).toBeTruthy();
    expect(view.getByRole("radiogroup", { name: "tweaks_theme" })).toBeTruthy();
    expect(view.queryByText("settings_section_data")).toBeNull();
    expect(view.queryByText("settings_section_network")).toBeNull();
    const section = view.getByRole("region", { name: "settings_section_interface" });
    expect(section.className).not.toContain("w-[280px]");
    expect(section.className).not.toContain("glass-blur");
  });

  for (const mobile of [false, true]) {
    test(`${mobile ? "mobile" : "desktop"} quick access opens Interface and preserves shared values on return`, () => {
      if (mobile) browser.happyDOM.setWindowSize({ width: 390 });
      const view = render(<Host mobile={mobile} />);
      fireEvent.click(view.getByRole("button", { name: "settings_all" }));
      expect(useModalStore.getState()).toMatchObject({ tweaksOpen: false, isSettingsOpen: true, settingsSection: "interface" });
      const section = view.getByRole("region", { name: "settings_section_interface" });
      const radios = within(within(section).getByRole("radiogroup", { name: "tweaks_theme" })).getAllByRole("radio");
      fireEvent.click(radios[2]!);
      expect(useInterfaceSettingsStore.getState().settings.theme).toBe("mystic-dawn");
      fireEvent.click(view.getByRole("button", { name: "close" }));
      act(() => useModalStore.getState().setTweaksOpen(true));
      const reopened = within(view.getByRole("radiogroup", { name: "tweaks_theme" })).getAllByRole("radio");
      expect(reopened[2]!.getAttribute("aria-checked")).toBe("true");
    });
  }

  for (const entry of ["desktop-proxy", "desktop-mobile-access", "phone-proxy"] as const) {
    test(`${entry} navigates atomically to Network without obsolete opener props`, () => {
      const mobile = entry === "phone-proxy";
      if (mobile) browser.happyDOM.setWindowSize({ width: 390 });
      temporarySections.push(registerSettingsSection({ id: "network", icon: null, labelKey: "settings_section_network", render: () => <div>network body</div> }));
      const view = render(<Host mobile={mobile} />);
      fireEvent.click(view.getByRole("button", { name: mobile ? "proxies" : entry === "desktop-mobile-access" ? "mobile_access" : "manage" }));
      expect(useModalStore.getState()).toMatchObject({ tweaksOpen: false, isSettingsOpen: true, settingsSection: "network" });
      expect(view.getByText("network body")).toBeTruthy();
      expect(view.queryByText("tweaks_title")).toBeNull();
    });
  }
});
