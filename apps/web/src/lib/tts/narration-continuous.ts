/**
 * Continuous playlist playback (TPE-18d) — a local device preference in
 * the same class as the narration volume and the TTS narration mode: it
 * shapes the local playback surface only, so it is NOT server state.
 * When ON, a naturally completed playlist row advances to the next row
 * (panel order) until messages run out; a stop breaks the chain.
 * Default OFF — one-shot playback stays the default journey.
 */

/** One-shot default — continuous play is opt-in per row-click. */
export const DEFAULT_CONTINUOUS_PLAY = false;

const STORAGE_KEY = "vt.tts.continuous-play";

/** Only a stored `true` enables the chain; anything else is one-shot. */
export function readContinuousPlay(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_CONTINUOUS_PLAY;
    return JSON.parse(raw) === true;
  } catch {
    // Corrupt entry — fall back to one-shot rather than chaining audio.
    return DEFAULT_CONTINUOUS_PLAY;
  }
}

export function persistContinuousPlay(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value === true));
  } catch {
    // Storage unavailable (private mode) — the toggle just won't survive
    // a reload; in-session playback is unaffected.
  }
}
