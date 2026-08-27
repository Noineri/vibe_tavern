/**
 * Variant-mapping pins for the F5 editor restructure: the "Local server"
 * dropdown entry is a UI variant of the OpenAI-compatible backend, marked by
 * the config-bag flag `localServer` (no enum/DB change), and only that
 * variant owns the local helpers. These pure functions are the boundary the
 * dropdown's variant flip and the panel gating ride on (the dropdown itself
 * can't be DOM-driven in happy-dom — Radix Popover anchors on 0x0 boxes; see
 * DropdownSelect.test.tsx's status note).
 */

import { describe, expect, it } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import { TTS_LOCAL_SERVER_FLAG, backendForVariant, ttsUiSpecFor, ttsUiVariantOf } from "./tts-backend-ui.js";

describe("ttsUiVariantOf", () => {
  it("openai-compatible + localServer flag → the local variant", () => {
    expect(ttsUiVariantOf(TTS_BACKEND.OpenAiCompatible, { [TTS_LOCAL_SERVER_FLAG]: true })).toBe("local");
    expect(ttsUiVariantOf(TTS_BACKEND.OpenAiCompatible, { localServer: true, endpoint: "http://127.0.0.1:8880/v1" })).toBe("local");
  });

  it("openai-compatible without the flag → the cloud variant (D8: local helpers OFF)", () => {
    expect(ttsUiVariantOf(TTS_BACKEND.OpenAiCompatible, {})).toBe("openai");
    expect(ttsUiVariantOf(TTS_BACKEND.OpenAiCompatible, { endpoint: "https://api.example.com/v1" })).toBe("openai");
  });

  it("a non-true flag value never yields the local variant (forward-compat data)", () => {
    expect(ttsUiVariantOf(TTS_BACKEND.OpenAiCompatible, { localServer: "yes" })).toBe("openai");
    expect(ttsUiVariantOf(TTS_BACKEND.OpenAiCompatible, { localServer: 1 })).toBe("openai");
  });

  it("native backends map to themselves", () => {
    expect(ttsUiVariantOf(TTS_BACKEND.Kokoro, {})).toBe("kokoro");
    expect(ttsUiVariantOf(TTS_BACKEND.Gemini, {})).toBe("gemini");
    expect(ttsUiVariantOf(TTS_BACKEND.ElevenLabs, {})).toBe("elevenlabs");
  });
});

describe("backendForVariant", () => {
  it("the local variant rides the OpenAI-compatible backend (enum unchanged)", () => {
    expect(backendForVariant("local")).toBe(TTS_BACKEND.OpenAiCompatible);
    expect(backendForVariant("openai")).toBe(TTS_BACKEND.OpenAiCompatible);
    expect(backendForVariant("kokoro")).toBe(TTS_BACKEND.Kokoro);
    expect(backendForVariant("gemini")).toBe(TTS_BACKEND.Gemini);
    expect(backendForVariant("elevenlabs")).toBe(TTS_BACKEND.ElevenLabs);
  });
});

describe("ttsUiSpecFor (field configuration)", () => {
  it("only the local variant owns local helpers (D8)", () => {
    expect(ttsUiSpecFor("local").localHelpers).toBe(true);
    expect(ttsUiSpecFor("openai").localHelpers).toBe(false);
    expect(ttsUiSpecFor("gemini").localHelpers).toBe(false);
    expect(ttsUiSpecFor("elevenlabs").localHelpers).toBe(false);
    expect(ttsUiSpecFor("kokoro").localHelpers).toBe(false);
  });

  it("kokoro has no connection card fields (browser-local, no credentials)", () => {
    const spec = ttsUiSpecFor("kokoro");
    expect(spec.connection.endpoint).toBeUndefined();
    expect(spec.connection.apiKey).toBeUndefined();
    expect(spec.connection.model).toBeUndefined();
  });

  it("model modes: fetched lists for local/openai/gemini, plain input for elevenlabs", () => {
    expect(ttsUiSpecFor("local").connection.model?.mode).toBe("fetch");
    expect(ttsUiSpecFor("openai").connection.model?.mode).toBe("fetch");
    expect(ttsUiSpecFor("gemini").connection.model?.mode).toBe("fetch");
    expect(ttsUiSpecFor("elevenlabs").connection.model?.mode).toBe("input");
    expect(ttsUiSpecFor("elevenlabs").connection.model?.key).toBe("modelId");
  });

  it("both openai-compatible variants share the same tuning fields", () => {
    expect(ttsUiSpecFor("local").tuning).toEqual(ttsUiSpecFor("openai").tuning);
  });
});
