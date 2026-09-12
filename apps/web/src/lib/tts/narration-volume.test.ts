/**
 * Narration volume persistence tests (TPE-18b) — happy-dom provides the
 * real localStorage (same pattern as the dictation-settings tests).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

import {
  DEFAULT_NARRATION_VOLUME,
  clampNarrationVolume,
  persistNarrationVolume,
  readNarrationVolume,
} from "./narration-volume.js";

beforeEach(() => {
  localStorage.clear();
});

describe("readNarrationVolume / persistNarrationVolume", () => {
  test("defaults to full volume when nothing is stored", () => {
    expect(readNarrationVolume()).toBe(DEFAULT_NARRATION_VOLUME);
    expect(readNarrationVolume()).toBe(1);
  });

  test("round-trip through localStorage", () => {
    persistNarrationVolume(0.35);
    expect(readNarrationVolume()).toBe(0.35);
  });

  test("clamps to the 0..1 lane on read and write", () => {
    persistNarrationVolume(2);
    expect(readNarrationVolume()).toBe(1);
    persistNarrationVolume(-0.5);
    expect(readNarrationVolume()).toBe(0);
    expect(clampNarrationVolume(Number.NaN)).toBe(1);
    expect(clampNarrationVolume("loud")).toBe(1);
  });

  test("corrupt entry falls back to full volume rather than muting", () => {
    localStorage.setItem("vt.tts.narration-volume", "not-json{{{");
    expect(readNarrationVolume()).toBe(1);
  });
});
