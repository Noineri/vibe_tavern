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
  lavaBlobs: boolean;
}

export const MESSAGE_WIDTH_MAP: Record<string, string> = { narrow: "680px", medium: "820px", wide: "960px" };
export const DEFAULT_TWEAKS: TweaksSettings = { fontSize: 17, uiFontSize: 17, messageWidth: "medium", lang: DEFAULT_LOCALE, showRail: false, lavaBlobs: true };

// ─── TTS narration text mode (D26, global UI pref) ─────────────────────────

import { isNarrationTextMode, type NarrationTextMode } from "./tts/narration-text.js";

const TTS_NARRATION_MODE_KEY = "vibe-tavern.tts-narration-mode";

export { TTS_NARRATION_MODE_KEY };

/** D26 default: "full" — asterisk spans are mechanically indistinguishable
 *  between stage directions and emphasis, so the safe default speaks every
 *  word (markers stripped). Unknown/corrupt stored values also heal to "full". */
export function readTtsNarrationMode(): NarrationTextMode {
  try {
    const raw = window.localStorage.getItem(TTS_NARRATION_MODE_KEY);
    return isNarrationTextMode(raw) ? raw : "full";
  } catch {
    return "full";
  }
}

export function persistTtsNarrationMode(mode: NarrationTextMode): void {
  try {
    window.localStorage.setItem(TTS_NARRATION_MODE_KEY, mode);
  } catch {
    // Ignore narration-mode persistence failures.
  }
}
