/**
 * Narration playback volume (TPE-18b) — a local device preference in the
 * same class as the dictation settings and the TTS narration mode: it
 * shapes the local playback surface only, so it is NOT server state.
 * Global to ALL narration playback (playlist panel and message-row button
 * share the player), persisted across reloads.
 */

/** Full volume — the default (nothing is muted unless the user says so). */
export const DEFAULT_NARRATION_VOLUME = 1;

const STORAGE_KEY = "vt.tts.narration-volume";

/** Clamp to the 0..1 lane; non-numbers fall back to full volume. */
export function clampNarrationVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_NARRATION_VOLUME;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function readNarrationVolume(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_NARRATION_VOLUME;
    return clampNarrationVolume(JSON.parse(raw));
  } catch {
    // Corrupt entry — fall back to full volume rather than muting audio.
    return DEFAULT_NARRATION_VOLUME;
  }
}

export function persistNarrationVolume(volume: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clampNarrationVolume(volume)));
  } catch {
    // Storage unavailable (private mode) — the slider just won't survive
    // a reload; in-session playback is unaffected.
  }
}
