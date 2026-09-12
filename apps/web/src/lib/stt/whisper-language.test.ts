/**
 * Whisper language-capability helper (STT_PLAN ST-4a): English-only (.en)
 * roster models refuse an explicit language hint — the editor hides the
 * field for them; multilingual + unknown ids keep it.
 */

import { describe, expect, test } from "bun:test";

import { whisperAcceptsLanguage } from "./whisper-language.js";

describe("whisperAcceptsLanguage", () => {
  test("English-only roster model rejects a language hint", () => {
    expect(whisperAcceptsLanguage("onnx-community/whisper-tiny.en")).toBe(false);
  });

  test("multilingual roster models accept one", () => {
    expect(whisperAcceptsLanguage("onnx-community/whisper-base")).toBe(true);
    expect(whisperAcceptsLanguage("onnx-community/whisper-small")).toBe(true);
  });

  test("unknown (free-typed) ids are not assumed English-only", () => {
    expect(whisperAcceptsLanguage("some/other-model")).toBe(true);
    expect(whisperAcceptsLanguage("")).toBe(true);
  });
});