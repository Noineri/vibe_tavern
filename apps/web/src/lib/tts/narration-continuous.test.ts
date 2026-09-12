/**
 * Continuous-play persistence tests (TPE-18d) — happy-dom provides the
 * real localStorage (same pattern as the narration-volume tests).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

import {
  DEFAULT_CONTINUOUS_PLAY,
  persistContinuousPlay,
  readContinuousPlay,
} from "./narration-continuous.js";

beforeEach(() => {
  localStorage.clear();
});

describe("readContinuousPlay / persistContinuousPlay", () => {
  test("defaults to one-shot when nothing is stored", () => {
    expect(readContinuousPlay()).toBe(DEFAULT_CONTINUOUS_PLAY);
    expect(readContinuousPlay()).toBe(false);
  });

  test("round-trip through localStorage", () => {
    persistContinuousPlay(true);
    expect(readContinuousPlay()).toBe(true);
    persistContinuousPlay(false);
    expect(readContinuousPlay()).toBe(false);
  });

  test("corrupt entries fall back to one-shot", () => {
    localStorage.setItem("vt.tts.continuous-play", "not-json{{{");
    expect(readContinuousPlay()).toBe(false);
    localStorage.setItem("vt.tts.continuous-play", JSON.stringify("yes"));
    expect(readContinuousPlay()).toBe(false);
  });
});
