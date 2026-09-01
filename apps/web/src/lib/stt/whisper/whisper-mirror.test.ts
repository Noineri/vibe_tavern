/**
 * Web-side whisper URL rewriter tests (STT_PLAN ST-3): roster repos map onto
 * the mirror route, everything else passes through untouched.
 */

import { describe, expect, test } from "bun:test";

import { rewriteWhisperHfUrl, WHISPER_MIRROR_PATH } from "./whisper-mirror.js";

describe("rewriteWhisperHfUrl", () => {
  test("roster repo files map onto the mirror route, query preserved", () => {
    expect(
      rewriteWhisperHfUrl(
        "https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/model_quantized.onnx",
      ),
    ).toBe(
      `${WHISPER_MIRROR_PATH}onnx-community/whisper-base/onnx/model_quantized.onnx`,
    );
    expect(
      rewriteWhisperHfUrl(
        "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/config.json?download=true",
      ),
    ).toBe(`${WHISPER_MIRROR_PATH}onnx-community/whisper-tiny.en/config.json?download=true`);
  });

  test("non-roster HF repos pass through untouched (null)", () => {
    expect(
      rewriteWhisperHfUrl("https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/model.onnx"),
    ).toBeNull();
    expect(rewriteWhisperHfUrl("https://huggingface.co/whatever/resolve/main/x.bin")).toBeNull();
  });

  test("non-HF urls pass through untouched (null)", () => {
    expect(rewriteWhisperHfUrl("https://example.com/onnx-community/whisper-base/resolve/main/config.json")).toBeNull();
    expect(rewriteWhisperHfUrl("/api/anything")).toBeNull();
  });

  test("bare repo root (no file suffix) is not rewritten", () => {
    expect(rewriteWhisperHfUrl("https://huggingface.co/onnx-community/whisper-base/resolve/main/")).toBeNull();
  });
});
