import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv({ failOnNetwork: true });
const { render, act, within, fireEvent, cleanup } = await import("@testing-library/react");
const { useLavaBackgroundActive } = await import("./LavaBackground.js");
const { InterfaceSettingsBody } = await import("../settings/interface-settings-body.js");
const { useInterfaceSettingsStore, INTERFACE_SETTINGS_STORAGE_KEY } = await import("../../stores/interface-settings-store.js");
const { useUserThemesStore } = await import("../../stores/user-themes-store.js");
const { useScriptSafetySettingsStore } = await import("../../stores/script-safety-settings-store.js");
// L1: real gate hook, local browser-environment DI (media/hardware boundary).
// No global patches, disk, DB, module mocks, timers or platform assumptions.
// The shared-body test restores the exact stores/storage key it mutates.
const originalPreferences = useInterfaceSettingsStore.getState();
const originalThemes = useUserThemesStore.getState();
const originalWarnings = useScriptSafetySettingsStore.getState();
const originalStored = localStorage.getItem(INTERFACE_SETTINGS_STORAGE_KEY);
function restore() {
  useInterfaceSettingsStore.setState(originalPreferences, true);
  useUserThemesStore.setState(originalThemes, true);
  useScriptSafetySettingsStore.setState(originalWarnings, true);
  if (originalStored === null) localStorage.removeItem(INTERFACE_SETTINGS_STORAGE_KEY);
  else localStorage.setItem(INTERFACE_SETTINGS_STORAGE_KEY, originalStored);
}
afterEach(() => { cleanup(); restore(); });
afterAll(restore);
function media(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  return {
    get matches() { return matches; },
    addEventListener: (_type: "change", fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_type: "change", fn: () => void) => { listeners.delete(fn); },
    change: (value: boolean) => { matches = value; for (const fn of listeners) fn(); },
  };
}
function setup(webgl = true) {
  const width = media(true);
  const motion = media(false);
  const environment = { webglAvailable: () => webgl, matchMedia: (query: string) => query.includes("min-width") ? width : motion };
  function Host({ theme = "user:sample", enabled = true, custom = true }: { theme?: string; enabled?: boolean; custom?: boolean }) {
    const active = useLavaBackgroundActive(theme, enabled, custom, environment);
    return <output>{String(active)}</output>;
  }
  return { width, motion, Host };
}
describe("lava progressive-enhancement gate", () => {
  test("applied custom lava keeps the compact toggle and the existing mobile control set", () => {
    useInterfaceSettingsStore.getState().updateSettings({ theme: "user:sample", lavaBlobs: true });
    useUserThemesStore.setState({ appliedThemeId: "user:sample", appliedLava: true });
    useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
    const view = render(<><section aria-label="compact"><InterfaceSettingsBody /></section><section aria-label="phone"><InterfaceSettingsBody mobile /></section></>);
    const compact = within(view.getByRole("region", { name: "compact" }));
    expect(compact.getByRole("switch", { name: "tweaks_lava_blobs" })).toBeTruthy();
    expect(within(view.getByRole("region", { name: "phone" })).queryByRole("switch", { name: "tweaks_lava_blobs" })).toBeNull();
    fireEvent.click(compact.getByRole("switch", { name: "tweaks_lava_blobs" }));
    expect(useInterfaceSettingsStore.getState().settings.lavaBlobs).toBe(false);
  });
  test("uploaded lava obeys width, reduced-motion and user-toggle gates", () => {
    const { Host, width, motion } = setup();
    const view = render(<Host />);
    expect(view.getByRole("status").textContent).toBe("true");
    act(() => width.change(false));
    expect(view.getByRole("status").textContent).toBe("false");
    act(() => width.change(true));
    expect(view.getByRole("status").textContent).toBe("true");
    act(() => motion.change(true));
    expect(view.getByRole("status").textContent).toBe("false");
    act(() => motion.change(false));
    view.rerender(<Host enabled={false} />);
    expect(view.getByRole("status").textContent).toBe("false");
  });
  test("ordinary custom CSS stays off, built-in lava stays on and missing WebGL stays off", () => {
    const { Host } = setup();
    const view = render(<Host custom={false} />);
    expect(view.getByRole("status").textContent).toBe("false");
    view.rerender(<Host theme="dark-lava" custom={false} />);
    expect(view.getByRole("status").textContent).toBe("true");
    view.unmount();
    const unavailable = setup(false);
    const noWebgl = render(<unavailable.Host />);
    expect(noWebgl.getByRole("status").textContent).toBe("false");
  });
});
