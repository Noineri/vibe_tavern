import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import {
  DEFAULT_SOUND_ALERTS,
  SOUND_ALERTS_STORAGE_KEY,
  useSoundAlertsStore,
} from "./sound-alerts-store.js";

// dom-env: the persist storage rides happy-dom's localStorage (the same
// environment the store rehydrates from in the app).
useDomEnv();

beforeEach(() => {
  window.localStorage.clear();
  useSoundAlertsStore.setState({ settings: { ...DEFAULT_SOUND_ALERTS } });
});

afterAll(() => {
  window.localStorage.clear();
});

describe("sound-alerts-store defaults", () => {
  test("every toggle is off and volume sits at 0.5 (owner ruling 2026-10-06)", () => {
    expect(useSoundAlertsStore.getState().settings).toEqual({
      replyReady: false,
      imageReady: false,
      queueFinished: false,
      generationError: false,
      osNotifications: false,
      volume: 0.5,
    });
  });
});

describe("sound-alerts-store setSetting", () => {
  test("flips a toggle and persists the settings to localStorage", () => {
    useSoundAlertsStore.getState().setSetting("replyReady", true);

    expect(useSoundAlertsStore.getState().settings.replyReady).toBe(true);
    const raw = window.localStorage.getItem(SOUND_ALERTS_STORAGE_KEY);
    expect(raw).toBeString();
    const persisted = JSON.parse(raw!) as { state: { settings: { replyReady: boolean } }; version: number };
    expect(persisted.version).toBe(1);
    expect(persisted.state.settings.replyReady).toBe(true);
  });

  test("clamps an out-of-range volume into 0–1", () => {
    useSoundAlertsStore.getState().setSetting("volume", 1.7);
    expect(useSoundAlertsStore.getState().settings.volume).toBe(1);

    useSoundAlertsStore.getState().setSetting("volume", -0.4);
    expect(useSoundAlertsStore.getState().settings.volume).toBe(0);
  });
});

describe("sound-alerts-store rehydration", () => {
  test("a valid persisted settings object applies, missing keys fall back to defaults", async () => {
    window.localStorage.setItem(
      SOUND_ALERTS_STORAGE_KEY,
      JSON.stringify({ state: { settings: { replyReady: true, volume: 0.9 } }, version: 1 }),
    );

    await useSoundAlertsStore.persist.rehydrate();

    const settings = useSoundAlertsStore.getState().settings;
    expect(settings.replyReady).toBe(true);
    expect(settings.volume).toBe(0.9);
    expect(settings.imageReady).toBe(false);
    expect(settings.osNotifications).toBe(false);
  });

  test("a non-object persisted state degrades to the defaults", async () => {
    window.localStorage.setItem(
      SOUND_ALERTS_STORAGE_KEY,
      JSON.stringify({ state: "garbage", version: 1 }),
    );

    await useSoundAlertsStore.persist.rehydrate();

    expect(useSoundAlertsStore.getState().settings).toEqual(DEFAULT_SOUND_ALERTS);
  });

  test("wrong-typed fields are rejected field by field, valid ones kept", async () => {
    window.localStorage.setItem(
      SOUND_ALERTS_STORAGE_KEY,
      JSON.stringify({
        state: { settings: { replyReady: "yes", imageReady: true, volume: "loud" } },
        version: 1,
      }),
    );

    await useSoundAlertsStore.persist.rehydrate();

    const settings = useSoundAlertsStore.getState().settings;
    expect(settings.replyReady).toBe(false); // string is not a boolean → default
    expect(settings.imageReady).toBe(true); // valid boolean kept
    expect(settings.volume).toBe(0.5); // string is not a finite number → default
  });
});
