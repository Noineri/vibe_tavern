import { afterEach, afterAll, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import type { UserThemeApi } from "../api/user-theme-api.js";

useDomEnv({ failOnNetwork: true });
const { render, cleanup, act, waitFor } = await import("@testing-library/react");
const { createUserThemesStore } = await import("../stores/user-themes-store.js");
const { createInterfaceSettingsStore } = await import("../stores/interface-settings-store.js");
const { useInterfaceTheme } = await import("./use-interface-theme.js");
// L1: real hook/stores/document, local API DI; no module/network mocks, disk or DB.
// Root chrome restored after each test and afterAll; waits observe final DOM/state.
const root = document.documentElement;
const originalClass = root.className;
const originalStyle = root.getAttribute("style");
function restore() {
  root.className = originalClass;
  if (originalStyle === null) root.removeAttribute("style");
  else root.setAttribute("style", originalStyle);
}
afterEach(() => { cleanup(); restore(); });
afterAll(restore);

const theme = { id: "sample", name: "sample.css", css: ":root.user-sample { --bg: #123; }" };
function setup(api: Partial<UserThemeApi> = {}) {
  const themes = createUserThemesStore({ list: async () => [theme], read: async () => theme, upload: async () => theme, remove: async () => {}, ...api });
  const memory = new Map<string, string>();
  const preferences = createInterfaceSettingsStore({ getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: (key) => { memory.delete(key); } }, "en");
  preferences.getState().setSetting("theme", "user:sample");
  function Host() { useInterfaceTheme(themes, preferences); return null; }
  return { themes, preferences, Host };
}
describe("interface theme application", () => {
  test("restores a saved user theme, then removes injected CSS on a built-in switch", async () => {
    const { Host, preferences } = setup();
    render(<Host />);
    await waitFor(() => expect(root.classList.contains("user-sample")).toBe(true));
    expect(document.querySelector("style[data-vt-user-theme]")?.textContent).toBe(theme.css);
    act(() => preferences.getState().setSetting("theme", "milk-coffee"));
    expect(root.classList.contains("milk-coffee")).toBe(true);
    expect(root.classList.contains("user-sample")).toBe(false);
    expect(document.querySelector("style[data-vt-user-theme]")).toBeNull();
  });

  test("falls back after deleting the active theme", async () => {
    const { Host, themes, preferences } = setup();
    render(<Host />);
    await waitFor(() => expect(root.classList.contains("user-sample")).toBe(true));
    await act(async () => { await themes.getState().remove(theme.id); });
    expect(preferences.getState().settings.theme).toBe("coffee");
    expect(document.querySelector("style[data-vt-user-theme]")).toBeNull();
  });

  test("a confirmed missing CSS response falls back and persists the default", async () => {
    const { Host, preferences } = setup({ read: async () => null });
    render(<Host />);
    await waitFor(() => expect(preferences.getState().settings.theme).toBe("coffee"));
    expect(document.querySelector("style[data-vt-user-theme]")).toBeNull();
  });

  test("transient read failures retain the saved choice, and retry applies it", async () => {
    let fail = true;
    const { Host, themes, preferences } = setup({ read: async () => { if (fail) throw new Error("offline"); return theme; } });
    render(<Host />);
    await waitFor(() => expect(themes.getState().error).toBeInstanceOf(Error));
    expect(preferences.getState().settings.theme).toBe("user:sample");
    fail = false;
    await act(async () => { await themes.getState().load(); });
    await waitFor(() => expect(root.classList.contains("user-sample")).toBe(true));
  });

  test("late CSS from an old selection never overrides a newer built-in choice", async () => {
    let complete!: (value: typeof theme) => void;
    const pending = new Promise<typeof theme>((done) => { complete = done; });
    const { Host, preferences } = setup({ read: () => pending });
    render(<Host />);
    act(() => preferences.getState().setSetting("theme", "mystic-night"));
    await act(async () => { complete(theme); await pending; });
    expect(root.classList.contains("mystic-night")).toBe(true);
    expect(document.querySelector("style[data-vt-user-theme]")).toBeNull();
  });
});
