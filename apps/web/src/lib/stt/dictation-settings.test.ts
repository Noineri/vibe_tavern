/**
 * Dictation local-preference persistence tests (STT_PLAN ST-4b) — happy-dom
 * provides the real localStorage.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

// localStorage comes from happy-dom (Bun's bare test process has none —
// this file runs isolated under scripts/test-web.ts).
useDomEnv();

import {
  DEFAULT_DICTATION_SETTINGS,
  persistDictationSettings,
  readDictationSettings,
} from "./dictation-settings.js";

beforeEach(() => {
  localStorage.clear();
});

describe("readDictationSettings / persistDictationSettings", () => {
  test("defaults when nothing is stored (opt-in gate starts OFF)", () => {
    expect(readDictationSettings()).toEqual(DEFAULT_DICTATION_SETTINGS);
    expect(readDictationSettings().enabled).toBe(false);
  });

  test("round-trip", () => {
    persistDictationSettings({ enabled: true, mode: "auto-send" });
    expect(readDictationSettings()).toEqual({ enabled: true, mode: "auto-send" });
  });

  test("corrupt entries fall back to defaults instead of throwing", () => {
    localStorage.setItem("vt.stt.dictation", "{not json");
    expect(readDictationSettings()).toEqual(DEFAULT_DICTATION_SETTINGS);
    localStorage.setItem("vt.stt.dictation", JSON.stringify({ enabled: "yes" }));
    expect(readDictationSettings().enabled).toBe(false);
  });

  test("an unknown stored mode is ignored (falls back to append)", () => {
    localStorage.setItem("vt.stt.dictation", JSON.stringify({ enabled: true, mode: "telepathy" }));
    expect(readDictationSettings()).toEqual({ enabled: true, mode: "append" });
  });
});
