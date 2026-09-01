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
    expect(ttsUiVariantOf(TTS_BACKEND.Cartesia, {})).toBe("cartesia");
    expect(ttsUiVariantOf(TTS_BACKEND.Inworld, {})).toBe("inworld");
    expect(ttsUiVariantOf(TTS_BACKEND.Lmnt, {})).toBe("lmnt");
    expect(ttsUiVariantOf(TTS_BACKEND.MiniMax, {})).toBe("minimax");
    expect(ttsUiVariantOf(TTS_BACKEND.Volcengine, {})).toBe("volcengine");
    expect(ttsUiVariantOf(TTS_BACKEND.Deepgram, {})).toBe("deepgram");
    expect(ttsUiVariantOf(TTS_BACKEND.Azure, {})).toBe("azure");
    expect(ttsUiVariantOf(TTS_BACKEND.Polly, {})).toBe("polly");
  });
});

describe("backendForVariant", () => {
  it("the local variant rides the OpenAI-compatible backend (enum unchanged)", () => {
    expect(backendForVariant("local")).toBe(TTS_BACKEND.OpenAiCompatible);
    expect(backendForVariant("openai")).toBe(TTS_BACKEND.OpenAiCompatible);
    expect(backendForVariant("kokoro")).toBe(TTS_BACKEND.Kokoro);
    expect(backendForVariant("gemini")).toBe(TTS_BACKEND.Gemini);
    expect(backendForVariant("elevenlabs")).toBe(TTS_BACKEND.ElevenLabs);
    expect(backendForVariant("cartesia")).toBe(TTS_BACKEND.Cartesia);
    expect(backendForVariant("inworld")).toBe(TTS_BACKEND.Inworld);
    expect(backendForVariant("lmnt")).toBe(TTS_BACKEND.Lmnt);
    expect(backendForVariant("minimax")).toBe(TTS_BACKEND.MiniMax);
    expect(backendForVariant("volcengine")).toBe(TTS_BACKEND.Volcengine);
    expect(backendForVariant("deepgram")).toBe(TTS_BACKEND.Deepgram);
    expect(backendForVariant("azure")).toBe(TTS_BACKEND.Azure);
    expect(backendForVariant("polly")).toBe(TTS_BACKEND.Polly);
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

  it("cartesia: manual model input + docs link (TPE-9a) + speed/emotion tuning", () => {
    const spec = ttsUiSpecFor("cartesia");
    expect(spec.connection.model?.mode).toBe("input");
    expect(spec.connection.model?.key).toBe("modelId");
    expect(spec.connection.model?.docsUrl).toBe("https://docs.cartesia.ai/build-with-cartesia/tts-models");
    expect(spec.connection.apiKey?.placeholder).toBe("sk_car_...");
    expect(spec.localHelpers).toBe(false);
    const speed = spec.tuning.find((f) => f.kind === "number" && f.key === "speed");
    expect(speed).toBeDefined();
    // generation_config bounds — sonic-3+ only (the backend gates per model).
    if (speed?.kind === "number") {
      expect(speed.min).toBe(0.6);
      expect(speed.max).toBe(1.5);
    }
    const emotion = spec.tuning.find((f) => f.kind === "select" && f.key === "emotion");
    expect(emotion).toBeDefined();
    if (emotion?.kind === "select") {
      expect(emotion.fallback).toBe("neutral");
      expect(emotion.options.map((o) => o.id)).toContain("flirtatious");
    }
  });

  it("inworld: live-fetched model list (/llm/v1alpha/models) + speed/deliveryMode tuning", () => {
    const spec = ttsUiSpecFor("inworld");
    expect(spec.connection.model?.mode).toBe("fetch");
    expect(spec.connection.model?.key).toBe("modelId");
    expect(spec.localHelpers).toBe(false);
    const speed = spec.tuning.find((f) => f.kind === "number" && f.key === "speed");
    expect(speed).toBeDefined();
    // audioConfig.speakingRate bounds.
    if (speed?.kind === "number") {
      expect(speed.min).toBe(0.5);
      expect(speed.max).toBe(1.5);
    }
    const delivery = spec.tuning.find((f) => f.kind === "select" && f.key === "deliveryMode");
    expect(delivery).toBeDefined();
    // Documented enum — the llms.txt "EXPRESSIVE" rewrite is stale.
    if (delivery?.kind === "select") {
      expect(delivery.options.map((o) => o.id)).toEqual(["STABLE", "BALANCED", "CREATIVE"]);
      expect(delivery.fallback).toBe("BALANCED");
    }
  });

  it("lmnt: manual model input + docs link (TPE-9a) + topP/temperature tuning, NO speed field", () => {
    const spec = ttsUiSpecFor("lmnt");
    expect(spec.connection.model?.mode).toBe("input");
    expect(spec.connection.model?.key).toBe("modelId");
    expect(spec.connection.model?.docsUrl).toBe("https://docs.lmnt.com/models/overview");
    expect(spec.localHelpers).toBe(false);
    // LMNT has no speed parameter — its tuning surface is top_p + temperature.
    expect(spec.tuning.find((f) => f.key === "speed")).toBeUndefined();
    const topP = spec.tuning.find((f) => f.kind === "number" && f.key === "topP");
    expect(topP).toBeDefined();
    if (topP?.kind === "number") {
      expect(topP.min).toBe(0);
      expect(topP.max).toBe(1);
      expect(topP.fallback).toBe(0.8);
    }
    const temperature = spec.tuning.find((f) => f.kind === "number" && f.key === "temperature");
    expect(temperature).toBeDefined();
    if (temperature?.kind === "number") {
      expect(temperature.min).toBe(0);
      expect(temperature.fallback).toBe(1);
    }
  });

  it("minimax: fetched model list (live /v1/models) + speed tuning", () => {
    const spec = ttsUiSpecFor("minimax");
    expect(spec.connection.model?.mode).toBe("fetch");
    expect(spec.connection.model?.key).toBe("modelId");
    expect(spec.localHelpers).toBe(false);
    const speed = spec.tuning.find((f) => f.kind === "number" && f.key === "speed");
    expect(speed).toBeDefined();
    if (speed?.kind === "number") {
      expect(speed.min).toBe(0.5);
      expect(speed.max).toBe(2);
      expect(speed.fallback).toBe(1);
    }
  });

  it("volcengine: appId + access key + MANUAL model input with docs link (TPE-9a owner rule) + speech/pitch/emotion tuning", () => {
    const spec = ttsUiSpecFor("volcengine");
    expect(spec.connection.appId).toBeDefined();
    expect(spec.connection.apiKey?.placeholder).toContain("Access Key");
    expect(spec.connection.model?.mode).toBe("input");
    expect(spec.connection.model?.key).toBe("modelId");
    expect(spec.connection.model?.docsUrl).toBe("https://www.volcengine.com/docs/6561/1598757");
    expect(spec.localHelpers).toBe(false);

    const speechRate = spec.tuning.find((f) => f.kind === "number" && f.key === "speechRate");
    if (speechRate?.kind === "number") {
      expect(speechRate.min).toBe(-50);
      expect(speechRate.max).toBe(100);
      expect(speechRate.fallback).toBe(0);
    }
    const pitch = spec.tuning.find((f) => f.kind === "number" && f.key === "pitch");
    if (pitch?.kind === "number") {
      expect(pitch.min).toBe(-12);
      expect(pitch.max).toBe(12);
      expect(pitch.fallback).toBe(0);
    }
    // Emotion is a PER-VOICE enum living in the provider's voice-roster
    // page — free text, never a select (a select would be a hardcoded
    // catalog; owner rule 2026-09-01).
    const emotion = spec.tuning.find((f) => f.kind === "text" && f.key === "emotion");
    expect(emotion).toBeDefined();
    const emotionScale = spec.tuning.find((f) => f.kind === "number" && f.key === "emotionScale");
    if (emotionScale?.kind === "number") {
      expect(emotionScale.min).toBe(1);
      expect(emotionScale.max).toBe(5);
      expect(emotionScale.fallback).toBe(4);
    }
  });

  it("deepgram: key-only connection, NO model field (model==voice — the live voice picker is the single selector) + speed tuning", () => {
    const spec = ttsUiSpecFor("deepgram");
    expect(spec.connection.apiKey).toBeDefined();
    // First native backend without a model field: the aura model id IS
    // the voice id, so exposing both would duplicate the selector.
    expect(spec.connection.model).toBeUndefined();
    expect(spec.localHelpers).toBe(false);

    const speed = spec.tuning.find((f) => f.kind === "number" && f.key === "speed");
    expect(speed).toBeDefined();
    if (speed?.kind === "number") {
      expect(speed.min).toBe(0.7);
      expect(speed.max).toBe(1.5);
      expect(speed.fallback).toBe(1);
    }
  });

  it("azure: REQUIRED region field (with docs link) + key + prosody trio tuning, NO model field", () => {
    const spec = ttsUiSpecFor("azure");
    expect(spec.connection.apiKey).toBeDefined();
    // Region is the acceptance-relevant connection field: non-secret,
    // rendered above the key, with the docs' region table as the
    // discovery link under the input.
    expect(spec.connection.region).toEqual({
      placeholder: "westus",
      docsUrl: "https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech",
    });
    expect(spec.connection.model).toBeUndefined();
    expect(spec.localHelpers).toBe(false);

    const rate = spec.tuning.find((f) => f.kind === "number" && f.key === "ratePercent");
    if (rate?.kind === "number") {
      expect(rate.min).toBe(-50);
      expect(rate.max).toBe(100);
      expect(rate.fallback).toBe(0);
    } else expect.unreachable();
    const pitch = spec.tuning.find((f) => f.kind === "number" && f.key === "pitchSt");
    if (pitch?.kind === "number") {
      expect(pitch.min).toBe(-12);
      expect(pitch.max).toBe(12);
    } else expect.unreachable();
    const volume = spec.tuning.find((f) => f.kind === "number" && f.key === "volumePercent");
    if (volume?.kind === "number") {
      expect(volume.min).toBe(-100);
      expect(volume.max).toBe(100);
    } else expect.unreachable();
  });

  it("polly: accessKeyId + REQUIRED region (docs link) + key; engine select + rate/volume tuning, NO model field", () => {
    const spec = ttsUiSpecFor("polly");
    expect(spec.connection.apiKey).toBeDefined();
    // AWS AccessKeyId — non-secret console id above the key (the SECRET
    // half is the masked key field).
    expect(spec.connection.accessKeyId).toEqual({ placeholder: "AKIA..." });
    // Region carries the AWS endpoints table as the discovery link.
    expect(spec.connection.region).toEqual({
      placeholder: "us-east-1",
      docsUrl: "https://docs.aws.amazon.com/general/latest/gr/pol.html",
    });
    // The voice id IS the VoiceId — no model field; the engine select is
    // the documented 4-value enum, not a model.
    expect(spec.connection.model).toBeUndefined();
    expect(spec.localHelpers).toBe(false);

    const engine = spec.tuning.find((f) => f.kind === "select" && f.key === "engine");
    if (engine?.kind === "select") {
      expect(engine.options.map((o) => o.id)).toEqual(["standard", "neural", "long-form", "generative"]);
      expect(engine.fallback).toBe("standard");
    } else expect.unreachable();
    const rate = spec.tuning.find((f) => f.kind === "number" && f.key === "ratePercent");
    if (rate?.kind === "number") {
      // ABSOLUTE percent, documented range 20–200, 100 = no change.
      expect(rate.min).toBe(20);
      expect(rate.max).toBe(200);
      expect(rate.fallback).toBe(100);
    } else expect.unreachable();
    const volume = spec.tuning.find((f) => f.kind === "number" && f.key === "volumeDb");
    if (volume?.kind === "number") {
      // Relative ±ndB, 0 = no change.
      expect(volume.min).toBe(-12);
      expect(volume.max).toBe(12);
      expect(volume.fallback).toBe(0);
    } else expect.unreachable();
    // pitch is NOT offered: neural/long-form/generative reject it.
    expect(spec.tuning.some((f) => f.key === "pitchSt" || f.key === "pitch")).toBe(false);
  });

  it("both openai-compatible variants share the same tuning fields", () => {
    expect(ttsUiSpecFor("local").tuning).toEqual(ttsUiSpecFor("openai").tuning);
  });
});

describe("ttsUiSpecFor — no example-id placeholder stubs (D20)", () => {
  it("no variant carries a voicePlaceholder (fake example id) field", () => {
    for (const variant of ["kokoro", "local", "openai", "gemini", "elevenlabs", "cartesia", "inworld", "lmnt", "minimax", "volcengine", "deepgram", "azure", "polly"] as const) {
      const spec = ttsUiSpecFor(variant);
      expect(Object.hasOwn(spec, "voicePlaceholder")).toBe(false);
      expect(JSON.stringify(spec)).not.toContain("alloy");
    }
  });
});
