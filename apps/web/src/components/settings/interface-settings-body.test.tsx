import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv({ failOnNetwork: true });

const { render, within, fireEvent, cleanup, act } = await import("@testing-library/react");
const { InterfaceSettingsBody } = await import("./interface-settings-body.js");
const { useInterfaceSettingsStore, INTERFACE_SETTINGS_STORAGE_KEY } = await import("../../stores/interface-settings-store.js");
const { useScriptSafetySettingsStore } = await import("../../stores/script-safety-settings-store.js");

// L1: real controls/stores, no mocks, paths, sleeps, platform assumptions or DB.
// State + storage restored per test and after the file; no real i18n mutation.
const originalPreferences = useInterfaceSettingsStore.getState();
const originalWarnings = useScriptSafetySettingsStore.getState();
const originalStored = localStorage.getItem(INTERFACE_SETTINGS_STORAGE_KEY);

function restore() {
  useInterfaceSettingsStore.setState(originalPreferences, true);
  useScriptSafetySettingsStore.setState(originalWarnings, true);
  if (originalStored === null) localStorage.removeItem(INTERFACE_SETTINGS_STORAGE_KEY);
  else localStorage.setItem(INTERFACE_SETTINGS_STORAGE_KEY, originalStored);
}

beforeEach(() => {
  restore();
  useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
  useInterfaceSettingsStore.getState().updateSettings({ theme: "coffee", fontSize: 17, uiFontSize: 17, messageWidth: "medium", lang: "en", showRail: false, lavaBlobs: true });
});
afterEach(() => { cleanup(); restore(); });
afterAll(restore);

describe("shared interface settings body", () => {
  test("theme changes on either surface are immediately reflected on both", () => {
    const view = render(<><section aria-label="compact"><InterfaceSettingsBody /></section><section aria-label="mobile"><InterfaceSettingsBody mobile /></section></>);
    const compact = within(view.getByRole("region", { name: "compact" }));
    const mobile = within(view.getByRole("region", { name: "mobile" }));
    const compactThemes = within(compact.getByRole("radiogroup", { name: "tweaks_theme" })).getAllByRole("radio");
    const mobileThemes = within(mobile.getByRole("radiogroup", { name: "tweaks_theme" })).getAllByRole("radio");
    expect(compactThemes.length).toBe(6);
    expect(mobileThemes.length).toBe(6);
    fireEvent.click(compactThemes[2]!);
    expect(useInterfaceSettingsStore.getState().settings.theme).toBe("mystic-dawn");
    expect(mobileThemes[2]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(mobileThemes[3]!);
    expect(useInterfaceSettingsStore.getState().settings.theme).toBe("mystic-night");
    expect(compactThemes[3]!.getAttribute("aria-checked")).toBe("true");
  });

  test("compact font choices and mobile sliders share the same value, including mobile-only sizes", () => {
    const view = render(<><section aria-label="compact"><InterfaceSettingsBody /></section><section aria-label="mobile"><InterfaceSettingsBody mobile /></section></>);
    const compact = within(view.getByRole("region", { name: "compact" }));
    const mobile = within(view.getByRole("region", { name: "mobile" }));
    const choices = within(compact.getByRole("radiogroup", { name: "tweaks_font_size" })).getAllByRole("radio");
    fireEvent.click(choices[1]!);
    expect((mobile.getByLabelText("tweaks_font_size") as HTMLInputElement).value).toBe("18");
    fireEvent.change(mobile.getByLabelText("tweaks_font_size"), { target: { value: "22" } });
    expect(useInterfaceSettingsStore.getState().settings.fontSize).toBe(22);
    expect(choices.every((radio) => radio.getAttribute("aria-checked") === "false")).toBe(true);
  });

  test("keeps viewport-specific fields and the shared server-backed warnings row", () => {
    const view = render(<><section aria-label="compact"><InterfaceSettingsBody /></section><section aria-label="mobile"><InterfaceSettingsBody mobile /></section></>);
    const compact = within(view.getByRole("region", { name: "compact" }));
    const mobile = within(view.getByRole("region", { name: "mobile" }));
    expect(compact.getByRole("radiogroup", { name: "tweaks_message_width" })).toBeTruthy();
    expect(mobile.queryByRole("radiogroup", { name: "tweaks_message_width" })).toBeNull();
    fireEvent.click(mobile.getByRole("switch", { name: "show_rail" }));
    expect(useInterfaceSettingsStore.getState().settings.showRail).toBe(true);
    expect(compact.queryByRole("switch", { name: "hide_rail" })).toBeNull();
    expect(compact.getByRole("switch", { name: "tweaks_script_warnings" })).toBeTruthy();
    expect(mobile.getByRole("switch", { name: "tweaks_script_warnings" })).toBeTruthy();
    act(() => useInterfaceSettingsStore.getState().setSetting("theme", "dark-lava"));
    expect(compact.getByRole("switch", { name: "tweaks_lava_blobs" })).toBeTruthy();
    expect(mobile.queryByRole("switch", { name: "tweaks_lava_blobs" })).toBeNull();
  });
});
