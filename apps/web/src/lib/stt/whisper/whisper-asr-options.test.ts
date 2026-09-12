/**
 * Pure ASR-option building tests (STT_PLAN ST-3): the .en language rule and
 * the always-on long-audio chunking — the two decisions the worker makes per
 * transcription, kept testable without the ML stack.
 */

import { describe, expect, test } from "bun:test";

import { buildWhisperAsrOptions, isEnglishOnlyWhisperModel } from "./whisper-asr-options.js";

describe("isEnglishOnlyWhisperModel", () => {
  test(".en suffix is English-only", () => {
    expect(isEnglishOnlyWhisperModel("onnx-community/whisper-tiny.en")).toBe(true);
  });

  test("multilingual repos are not", () => {
    expect(isEnglishOnlyWhisperModel("onnx-community/whisper-base")).toBe(false);
    expect(isEnglishOnlyWhisperModel("onnx-community/whisper-small")).toBe(false);
  });
});

describe("buildWhisperAsrOptions", () => {
  test("task transcribe + always-on 30s chunking (long dictation clips must not truncate)", () => {
    const options = buildWhisperAsrOptions("onnx-community/whisper-base", undefined);
    expect(options.task).toBe("transcribe");
    expect(options.chunk_length_s).toBe(30);
    expect(options.stride_length_s).toBe(5);
    expect("language" in options).toBe(false);
  });

  test("language passes through for multilingual models", () => {
    const options = buildWhisperAsrOptions("onnx-community/whisper-base", "ru");
    expect(options.language).toBe("ru");
  });

  test("language is DROPPED for English-only models (tokenizer errors on it)", () => {
    const options = buildWhisperAsrOptions("onnx-community/whisper-tiny.en", "ru");
    expect("language" in options).toBe(false);
  });

  test("empty-string language is dropped like undefined", () => {
    const options = buildWhisperAsrOptions("onnx-community/whisper-base", "");
    expect("language" in options).toBe(false);
  });
});
