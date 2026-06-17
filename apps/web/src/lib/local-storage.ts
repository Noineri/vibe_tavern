import type { ConnectionState } from "../components/layout/app-shell-types.js";
import { normalizeTheme, type ThemeMode } from "../themes/registry.js";
import { DEFAULT_LOCALE } from "../i18n/registry.js";

const THEME_STORAGE_KEY = "vibe-tavern.theme";
const TWEAKS_STORAGE_KEY = "vibe-tavern.tweaks";

export { THEME_STORAGE_KEY, TWEAKS_STORAGE_KEY };

export interface TweaksSettings {
  fontSize: number;
  uiFontSize: number;
  messageWidth: "narrow" | "medium" | "wide";
  lang: string;
  showRail: boolean;
}

export const MESSAGE_WIDTH_MAP: Record<string, string> = { narrow: "680px", medium: "820px", wide: "960px" };
export const DEFAULT_TWEAKS: TweaksSettings = { fontSize: 17, uiFontSize: 17, messageWidth: "medium", lang: DEFAULT_LOCALE, showRail: false };

export function readSavedTheme(): ThemeMode {
  try {
    // Any registered theme id survives; unknown/missing values fall back to
    // the default via normalizeTheme. This is what makes new themes load
    // correctly after a reload once they are added to the registry.
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return normalizeTheme(null);
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

// ─── Summary modal settings (per-chat) ────────────────────────────────────────

const SUMMARY_SETTINGS_PREFIX = "vibe-tavern.summary-settings.";

export interface SummarySettings {
  providerId: string;
  model: string;
}

export interface SavedSummaryRecord {
  id: string;
  label: string;
  text: string;
  msgCount: number;
  timestamp: number;
  /** Whether this summary should be included in the prompt context. */
  includeInContext: boolean;
}

export function readSummarySettings(chatId: string): SummarySettings | null {
  try {
    const raw = window.localStorage.getItem(SUMMARY_SETTINGS_PREFIX + chatId);
    if (!raw) return null;
    return JSON.parse(raw) as SummarySettings;
  } catch {
    return null;
  }
}

export function persistSummarySettings(chatId: string, settings: SummarySettings): void {
  try {
    window.localStorage.setItem(SUMMARY_SETTINGS_PREFIX + chatId, JSON.stringify(settings));
  } catch {
    // Ignore persistence failures.
  }
}

// ─── Saved summaries (per-chat) ──────────────────────────────────────────────

const SAVED_SUMMARIES_PREFIX = "vibe-tavern.saved-summaries.";

export function readSavedSummaries(chatId: string): SavedSummaryRecord[] {
  try {
    const raw = window.localStorage.getItem(SAVED_SUMMARIES_PREFIX + chatId);
    if (!raw) return [];
    return JSON.parse(raw) as SavedSummaryRecord[];
  } catch {
    return [];
  }
}

export function persistSavedSummaries(chatId: string, summaries: SavedSummaryRecord[]): void {
  try {
    window.localStorage.setItem(SAVED_SUMMARIES_PREFIX + chatId, JSON.stringify(summaries));
  } catch {
    // Ignore persistence failures.
  }
}
