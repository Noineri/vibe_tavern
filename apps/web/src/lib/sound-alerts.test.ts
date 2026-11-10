import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import {
  _resetSoundAlertsForTests,
  installSoundAlertsGesturePrimer,
  playAlert,
  primeSoundAlerts,
} from "./sound-alerts.js";

// dom-env: the gesture primer installs real window listeners; a fake
// AudioContext constructor makes priming observable (constructed + resumed)
// without any real Web Audio. happy-dom ships no AudioContext of its own.

useDomEnv();

class FakeAudioContext {
  static constructed = 0;
  static resumed = 0;
  state: "suspended" | "running" = "suspended";
  constructor() {
    FakeAudioContext.constructed += 1;
  }
  resume = async (): Promise<void> => {
    FakeAudioContext.resumed += 1;
    this.state = "running";
  };
}

/** The audio-constructor surface sound-alerts.ts actually consumes
 *  (audioContextCtor → `new Ctor()` → `.state === "suspended"` → `.resume()`):
 *  the documented test-driver view of `window` for this suite. Declaring the
 *  member optional-with-narrow-type is what makes BOTH installs honest — the
 *  fake constructor AND the deliberate `undefined` (absent-member) install of
 *  the no-op test — without erasing anything. */
type AudioWindow = Window & { AudioContext?: new () => FakeAudioContext };
const audioWindow = window as AudioWindow;
const originalAudioContext = audioWindow.AudioContext;

beforeEach(() => {
  FakeAudioContext.constructed = 0;
  FakeAudioContext.resumed = 0;
  _resetSoundAlertsForTests();
  audioWindow.AudioContext = FakeAudioContext;
});

afterAll(() => {
  if (originalAudioContext) audioWindow.AudioContext = originalAudioContext;
  else delete audioWindow.AudioContext;
  _resetSoundAlertsForTests();
});

describe("installSoundAlertsGesturePrimer", () => {
  test("the first gesture anywhere primes the context — no section visit needed", async () => {
    const dispose = installSoundAlertsGesturePrimer();

    // Reload scenario (defect 2026-11-04): toggles restored from storage, the
    // sound section never opened. A plain click anywhere in the app counts.
    window.dispatchEvent(new window.Event("pointerdown"));
    await Promise.resolve();

    expect(FakeAudioContext.constructed).toBe(1);
    expect(FakeAudioContext.resumed).toBe(1);
    dispose();
  });

  test("the primer removes itself once the context is running", async () => {
    const dispose = installSoundAlertsGesturePrimer();
    window.dispatchEvent(new window.Event("pointerdown"));
    await Promise.resolve();
    expect(FakeAudioContext.constructed).toBe(1);

    // A second gesture must not construct or resume again.
    window.dispatchEvent(new window.Event("pointerdown"));
    await Promise.resolve();
    expect(FakeAudioContext.constructed).toBe(1);
    expect(FakeAudioContext.resumed).toBe(1);
    dispose();
  });

  test("keydown primes too, and the disposer removes the listeners", () => {
    const dispose = installSoundAlertsGesturePrimer();
    dispose();

    window.dispatchEvent(new window.Event("keydown"));
    expect(FakeAudioContext.constructed).toBe(0);
  });
});

describe("playAlert without a primed context", () => {
  test("stays a silent no-op — never throws where Web Audio is absent", () => {
    audioWindow.AudioContext = undefined;
    expect(() => {
      primeSoundAlerts();
      playAlert("success", 0.5);
    }).not.toThrow();
  });
});
