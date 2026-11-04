/**
 * SM-8 sound alerts — the audio / OS-notification engine (plan
 * VT_SETTINGS_MODAL_PLAN Wave 5 step 2).
 *
 * Two short tones are synthesized with the Web Audio API (no binary assets, no
 * licensing, local-first): an ascending pair for success events, a descending
 * pair for errors. One shared AudioContext serves every alert; browsers and the
 * Android WebView block audio until a user gesture, so the context is created /
 * resumed by {@link primeSoundAlerts} on the first gesture inside the sound
 * section — every toggle there and the «test sound» button call it. A user who
 * never opened the section has every toggle off, so an un-primed context never
 * misses a wanted alert.
 *
 * Every entry point is tolerant of a missing API (older WebView, blocked
 * storage): absent constructors degrade to silent no-ops, never throws.
 */

export type SoundAlertKind = "success" | "error";

/** Each tone: oscillator frequency (Hz), offset from now (s), length (s). */
interface ToneSpec {
  freq: number;
  start: number;
  duration: number;
}

/** Ascending E5→A5 for success, descending E4→B3 for errors (distinct contours). */
const TONES: Record<SoundAlertKind, readonly ToneSpec[]> = {
  success: [
    { freq: 659.25, start: 0, duration: 0.1 },
    { freq: 880, start: 0.12, duration: 0.14 },
  ],
  error: [
    { freq: 329.63, start: 0, duration: 0.12 },
    { freq: 246.94, start: 0.14, duration: 0.18 },
  ],
};

let sharedContext: AudioContext | null = null;

function audioContextCtor(): (typeof AudioContext) | null {
  if (typeof window === "undefined") return null;
  // Legacy Safari / some Android WebViews only expose the prefixed constructor.
  const withLegacy = window as Window & { webkitAudioContext?: typeof AudioContext };
  return window.AudioContext ?? withLegacy.webkitAudioContext ?? null;
}

/**
 * Create / resume the shared AudioContext from inside a user gesture (a toggle
 * click or the test button in the sound section). Idempotent.
 */
export function primeSoundAlerts(): void {
  const Ctor = audioContextCtor();
  if (!Ctor) return;
  try {
    if (!sharedContext) sharedContext = new Ctor();
    // Autoplay permission is sticky: a context resumed by gesture may be
    // resumed again later from outside a gesture (long-idle suspension).
    if (sharedContext.state === "suspended") void sharedContext.resume().catch(() => {
      // Suspended stays silent this once; the next gesture re-tries.
    });
  } catch (error) {
    console.warn("Failed to prime the sound-alerts AudioContext", error);
  }
}

function clampVolume(volume: number): number {
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.5;
}

/**
 * Play one of the two built-in alerts at `volume` (0–1). Silent when the
 * context was never primed or the browser provides no Web Audio — the caller
 * (sound-alerts-subscriber) already gated on the user's toggles.
 */
export function playAlert(kind: SoundAlertKind, volume: number): void {
  if (!sharedContext) return;
  if (sharedContext.state === "suspended") void sharedContext.resume().catch(() => {
    // Tones are still scheduled; they play if/when the resume lands.
  });
  try {
    const gain = sharedContext.createGain();
    gain.gain.value = clampVolume(volume);
    gain.connect(sharedContext.destination);
    const base = sharedContext.currentTime + 0.01;
    for (const tone of TONES[kind]) {
      const osc = sharedContext.createOscillator();
      osc.type = "sine";
      osc.frequency.value = tone.freq;
      // Short exponential attack/decay envelope — a hard start/stop clicks.
      const envelope = sharedContext.createGain();
      envelope.gain.setValueAtTime(0.0001, base + tone.start);
      envelope.gain.exponentialRampToValueAtTime(1, base + tone.start + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.0001, base + tone.start + tone.duration);
      osc.connect(envelope);
      envelope.connect(gain);
      osc.start(base + tone.start);
      osc.stop(base + tone.start + tone.duration + 0.02);
    }
  } catch (error) {
    console.warn("Failed to play a sound alert", error);
  }
}

/**
 * The «test sound» button: primes the context (it IS the gesture) and plays
 * both tones regardless of focus, separated enough to hear each contour.
 * Unlike the subscriber path this bypasses the background-only rule — the user
 * is looking at the section by definition.
 */
export function playSoundTest(volume: number): void {
  primeSoundAlerts();
  playAlert("success", volume);
  window.setTimeout(() => playAlert("error", volume), 450);
}

/** VT is in the background when the tab is hidden OR the window unfocused. */
export function isBackground(): boolean {
  return document.hidden || !document.hasFocus();
}

export function osNotificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * Ask the browser for notification permission. Returns null where the API is
 * absent (the section hides the whole block then) — callers never need to
 * distinguish absent from denied.
 */
export async function requestOsPermission(): Promise<NotificationPermission | null> {
  if (!osNotificationsSupported()) return null;
  try {
    return await window.Notification.requestPermission();
  } catch (error) {
    console.warn("Notification.requestPermission failed", error);
    return null;
  }
}

/**
 * Show an OS notification when already permitted; anything else (absent API,
 * not granted, a constructor that throws on some Android WebViews despite
 * permission) degrades to silence — the sound already played.
 */
export function notifyOs(title: string, body: string): void {
  if (!osNotificationsSupported()) return;
  if (window.Notification.permission !== "granted") return;
  try {
    const notification = new window.Notification(title, { body });
    // Clicking the toast should surface the app, not just dismiss it.
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch (error) {
    console.warn("Failed to show an OS notification", error);
  }
}
