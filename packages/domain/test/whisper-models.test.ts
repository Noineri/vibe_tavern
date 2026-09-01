/**
 * Whisper roster tests (STT_PLAN ST-3): the roster doubles as the server
 * mirror's repository allowlist, so the invariants that keep it safe are
 * pinned here.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_WHISPER_MODEL_ID,
  WHISPER_MODELS,
  findWhisperModel,
  whisperMirrorRepos,
} from "../src/whisper-models.js";

describe("WHISPER_MODELS roster", () => {
  test("every id is a full onnx-community repo path (no traversal, no scheme)", () => {
    for (const model of WHISPER_MODELS) {
      expect(model.id.startsWith("onnx-community/")).toBe(true);
      expect(model.id).not.toContain("..");
      expect(model.id).not.toContain("://");
      // exactly one repo separator segment pair:
      expect(model.id.split("/").length).toBe(2);
    }
  });

  test("ids are unique", () => {
    const ids = WHISPER_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("englishOnly flags agree with the .en suffix", () => {
    for (const model of WHISPER_MODELS) {
      expect(model.englishOnly).toBe(model.id.endsWith(".en"));
    }
  });

  test("the default model is in the roster and multilingual", () => {
    const entry = findWhisperModel(DEFAULT_WHISPER_MODEL_ID);
    expect(entry).not.toBeNull();
    expect(entry?.englishOnly).toBe(false);
  });

  test("findWhisperModel returns null for unknown ids", () => {
    expect(findWhisperModel("not/a-real-repo")).toBeNull();
  });

  test("the mirror allowlist is exactly the roster ids", () => {
    expect([...whisperMirrorRepos()].sort()).toEqual(
      [...WHISPER_MODELS.map((m) => m.id)].sort(),
    );
  });
});
