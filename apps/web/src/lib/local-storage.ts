import type { ConnectionState, ThemeMode } from "../components/app-shell-types.js";

const THEME_STORAGE_KEY = "rp-platform.theme";
const TWEAKS_STORAGE_KEY = "rp-platform.tweaks";

export { THEME_STORAGE_KEY, TWEAKS_STORAGE_KEY };

export interface TweaksSettings {
  fontSize: number;
  uiFontSize: number;
  messageWidth: "narrow" | "medium" | "wide";
  lang: string;
}

export const MESSAGE_WIDTH_MAP: Record<string, string> = { narrow: "680px", medium: "820px", wide: "960px" };
export const DEFAULT_TWEAKS: TweaksSettings = { fontSize: 17, uiFontSize: 16, messageWidth: "medium", lang: "en" };

export function readSavedTheme(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function persistTheme(theme: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore theme persistence failures in the UI shell.
  }
}

export function readSavedTweaks(): TweaksSettings {
  try {
    const raw = window.localStorage.getItem(TWEAKS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TWEAKS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_TWEAKS, ...parsed };
  } catch {
    return { ...DEFAULT_TWEAKS };
  }
}

export function persistTweaks(settings: TweaksSettings): void {
  try {
    window.localStorage.setItem(TWEAKS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore tweaks persistence failures.
  }
}
