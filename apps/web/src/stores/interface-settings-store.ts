import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { DEFAULT_TWEAKS, THEME_STORAGE_KEY, TWEAKS_STORAGE_KEY, type TweaksSettings } from "../lib/local-storage.js";
import { detectBrowserLocale, isLocale } from "../i18n/registry.js";
import { normalizeTheme, type ThemeMode } from "../themes/registry.js";

export const INTERFACE_SETTINGS_STORAGE_KEY = "vibe-tavern.interface-settings";

export interface InterfaceSettings extends TweaksSettings {
  theme: ThemeMode;
}

interface InterfaceSettingsStore {
  settings: InterfaceSettings;
  setSetting: <K extends keyof InterfaceSettings>(key: K, value: InterfaceSettings[K]) => void;
  updateSettings: (patch: Partial<InterfaceSettings>) => void;
}

type SyncStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(raw: string | null): unknown {
  try { return raw ? JSON.parse(raw) : undefined; }
  catch { return undefined; } // A malformed device-local preference is not fatal.
}

function validate(value: unknown, defaults: InterfaceSettings): InterfaceSettings {
  if (!record(value)) return { ...defaults };
  return {
    theme: typeof value.theme === "string" ? normalizeTheme(value.theme) : defaults.theme,
    fontSize: typeof value.fontSize === "number" && Number.isFinite(value.fontSize) && value.fontSize > 0 ? value.fontSize : defaults.fontSize,
    uiFontSize: typeof value.uiFontSize === "number" && Number.isFinite(value.uiFontSize) && value.uiFontSize > 0 ? value.uiFontSize : defaults.uiFontSize,
    messageWidth: value.messageWidth === "narrow" || value.messageWidth === "medium" || value.messageWidth === "wide" ? value.messageWidth : defaults.messageWidth,
    lang: typeof value.lang === "string" && isLocale(value.lang) ? value.lang : defaults.lang,
    showRail: typeof value.showRail === "boolean" ? value.showRail : defaults.showRail,
    lavaBlobs: typeof value.lavaBlobs === "boolean" ? value.lavaBlobs : defaults.lavaBlobs,
  };
}

function browserStorage(): SyncStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; }
  catch { return undefined; } // Private/embedded browsers can deny even the getter.
}

/** Factory is the storage boundary: tests supply local memory, not global mocks. */
export function createInterfaceSettingsStore(
  storage: SyncStorage | undefined = browserStorage(),
  browserLanguage = typeof navigator === "undefined" ? "" : navigator.language ?? "",
) {
  const defaults: InterfaceSettings = { ...DEFAULT_TWEAKS, theme: normalizeTheme(null), lang: detectBrowserLocale(browserLanguage) };
  const read = (key: string): string | null => {
    try { return storage?.getItem(key) ?? null; }
    catch { return null; } // Storage denial falls back independently per key.
  };
  const safeStorage: SyncStorage = {
    getItem: (name) => {
      const saved = readJson(read(name));
      if (record(saved) && record(saved.state) && record(saved.state.settings)) return JSON.stringify(saved);
      const oldTweaks = readJson(read(TWEAKS_STORAGE_KEY));
      const legacy = validate({ ...(record(oldTweaks) ? oldTweaks : {}), theme: read(THEME_STORAGE_KEY) }, defaults);
      // Zustand's version migration also persists this legacy snapshot immediately.
      return JSON.stringify({ state: { settings: legacy }, version: 0 });
    },
    setItem: (name, value) => {
      try { storage?.setItem(name, value); }
      catch { return; } // Preference changes still work in memory when storage is full.
    },
    removeItem: (name) => {
      try { storage?.removeItem(name); }
      catch { return; } // Storage denial must not break the UI.
    },
  };

  return create<InterfaceSettingsStore>()(persist((set) => ({
    settings: defaults,
    setSetting: (key, value) => set((state) => ({ settings: { ...state.settings, [key]: value } })),
    updateSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),
  }), {
    name: INTERFACE_SETTINGS_STORAGE_KEY,
    version: 1,
    storage: createJSONStorage(() => safeStorage),
    partialize: (state) => ({ settings: state.settings }),
    migrate: (saved) => ({ settings: validate(record(saved) ? saved.settings : undefined, defaults) }),
    merge: (saved, current) => ({ ...current, settings: validate(record(saved) ? saved.settings : undefined, defaults) }),
  }));
}

export const useInterfaceSettingsStore = createInterfaceSettingsStore();
