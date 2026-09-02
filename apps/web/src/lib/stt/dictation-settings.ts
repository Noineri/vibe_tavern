/**
 * Dictation client preferences (STT_PLAN ST-4b): whether the chat-input mic
 * button is enabled at all, and what happens to each transcript — Append /
 * Replace / Auto-send. Local device preferences (the same class as the TTS
 * narration mode — see `readTtsNarrationMode`), NOT server state: they shape
 * the local input surface only. The ACTIVE PROFILE pointer is server state
 * and lives in `ui_settings.activeDictationProfileId` (ST-1).
 */

export const DICTATION_MODES = ["append", "replace", "auto-send"] as const;
export type DictationMode = (typeof DICTATION_MODES)[number];

/** i18n label keys per mode — a typed literal map (t() keys are strict;
 *  template-string keys cannot typecheck, so the map is the indirection). */
export const DICTATION_MODE_LABEL_KEYS: Record<DictationMode, "dictation_mode_append" | "dictation_mode_replace" | "dictation_mode_auto_send"> = {
  append: "dictation_mode_append",
  replace: "dictation_mode_replace",
  "auto-send": "dictation_mode_auto_send",
};

export interface DictationSettings {
  /** Mic button hidden entirely while false (opt-in gate). */
  enabled: boolean;
  /** What a finished transcript does to the draft. */
  mode: DictationMode;
}

export const DEFAULT_DICTATION_SETTINGS: DictationSettings = { enabled: false, mode: "append" };

const STORAGE_KEY = "vt.stt.dictation";

export function readDictationSettings(): DictationSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_DICTATION_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_DICTATION_SETTINGS;
    const record = parsed as Record<string, unknown>;
    const mode =
      typeof record.mode === "string" && (DICTATION_MODES as readonly string[]).includes(record.mode)
        ? (record.mode as DictationMode)
        : DEFAULT_DICTATION_SETTINGS.mode;
    return { enabled: record.enabled === true, mode };
  } catch {
    // Corrupt entry — fall back to defaults rather than breaking the input.
    return DEFAULT_DICTATION_SETTINGS;
  }
}

export function persistDictationSettings(settings: DictationSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private mode) — the toggle just won't survive a
    // reload; in-session behavior is unaffected.
  }
}
