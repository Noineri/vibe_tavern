import { describe, expect, test } from "bun:test";
import { createInterfaceSettingsStore, INTERFACE_SETTINGS_STORAGE_KEY } from "./interface-settings-store.js";

// L1: no paths, globals, timers, module mocks, platform assumptions or DBs.
// Each test owns its synchronous in-memory storage and real Zustand stores.
function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("interface preferences persistence", () => {
  test("migrates both legacy keys synchronously without changing any preference", () => {
    const legacy = { fontSize: 22, uiFontSize: 20, messageWidth: "wide", lang: "ru", showRail: true, lavaBlobs: false } as const;
    const storage = memoryStorage({ "vibe-tavern.theme": "mystic-dawn", "vibe-tavern.tweaks": JSON.stringify(legacy) });
    const store = createInterfaceSettingsStore(storage, "en-US");
    expect(store.getState().settings).toEqual({ ...legacy, theme: "mystic-dawn" });
    expect(store.persist.hasHydrated()).toBe(true);
    expect(JSON.parse(storage.getItem(INTERFACE_SETTINGS_STORAGE_KEY)!)).toEqual({ state: { settings: { ...legacy, theme: "mystic-dawn" } }, version: 1 });
  });

  test("persists only preferences and restores every setting in a fresh store", () => {
    const storage = memoryStorage();
    const first = createInterfaceSettingsStore(storage, "en");
    first.getState().updateSettings({ theme: "dark-lava", fontSize: 19, uiFontSize: 15, messageWidth: "narrow", lang: "ru", showRail: true, lavaBlobs: false });
    const next = createInterfaceSettingsStore(storage, "en");
    expect(next.getState().settings).toEqual(first.getState().settings);
    expect(Object.keys(JSON.parse(storage.getItem(INTERFACE_SETTINGS_STORAGE_KEY)!).state)).toEqual(["settings"]);
    next.getState().setSetting("fontSize", 18);
    expect(next.getState().settings.fontSize).toBe(18);
    expect(next.getState().settings.theme).toBe("dark-lava");
  });

  test("new preferences win over stale legacy values", () => {
    const storage = memoryStorage({ "vibe-tavern.theme": "light-lava", "vibe-tavern.tweaks": JSON.stringify({ lang: "ru" }) });
    createInterfaceSettingsStore(storage, "ru").getState().updateSettings({ theme: "coffee", lang: "en" });
    const next = createInterfaceSettingsStore(storage, "ru");
    expect(next.getState().settings.theme).toBe("coffee");
    expect(next.getState().settings.lang).toBe("en");
  });

  test("browser locale is used only when no valid saved choice exists", () => {
    expect(createInterfaceSettingsStore(memoryStorage(), "ru-RU").getState().settings.lang).toBe("ru");
    expect(createInterfaceSettingsStore(memoryStorage(), "fr-FR").getState().settings.lang).toBe("en");
    expect(createInterfaceSettingsStore(memoryStorage({ "vibe-tavern.tweaks": '{"lang":"en"}' }), "ru-RU").getState().settings.lang).toBe("en");
  });

  test("corrupt keys are isolated; valid legacy theme survives malformed tweaks", () => {
    const storage = memoryStorage({ [INTERFACE_SETTINGS_STORAGE_KEY]: "{", "vibe-tavern.theme": "mystic-night", "vibe-tavern.tweaks": "{" });
    const settings = createInterfaceSettingsStore(storage, "ru").getState().settings;
    expect(settings).toMatchObject({ theme: "mystic-night", lang: "ru", fontSize: 17, uiFontSize: 17 });
  });

  test("invalid stored fields and action-shaped data cannot replace defaults or actions", () => {
    const storage = memoryStorage({ [INTERFACE_SETTINGS_STORAGE_KEY]: JSON.stringify({ state: { settings: { theme: "gone", fontSize: -1, uiFontSize: "huge", lang: "missing", messageWidth: "invalid", showRail: 1, lavaBlobs: null }, setSetting: "bad" }, version: 1 }) });
    const store = createInterfaceSettingsStore(storage, "en");
    expect(store.getState().settings).toEqual({ theme: "coffee", fontSize: 17, uiFontSize: 17, messageWidth: "medium", lang: "en", showRail: false, lavaBlobs: true });
    store.getState().setSetting("theme", "milk-coffee");
    expect(store.getState().settings.theme).toBe("milk-coffee");
  });

  test("blocked storage does not prevent hydration or in-memory updates", () => {
    const storage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    const store = createInterfaceSettingsStore(storage, "ru");
    expect(store.getState().settings.lang).toBe("ru");
    store.getState().setSetting("theme", "mystic-night");
    expect(store.getState().settings.theme).toBe("mystic-night");
    expect(store.persist.hasHydrated()).toBe(true);
  });
});
