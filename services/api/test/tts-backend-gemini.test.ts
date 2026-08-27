import { afterEach, describe, expect, mock, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import {
  GEMINI_TTS_FREE_TIER_HINT,
  GEMINI_TTS_VOICES,
  GeminiTtsError,
  geminiTtsFactory,
  pcmToWav,
} from "../src/domain/tts/backends/gemini-tts.js";
import {
  createTtsBackend,
  registerTtsBackend,
} from "../src/domain/tts/tts-registry.js";
import type { TtsBackend } from "../src/domain/tts/tts-backend.js";

const INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 4-byte PCM sample (16-bit mono, little-endian). */
function samplePcm(): Buffer {
  return Buffer.from([0x10, 0x00, 0x20, 0x00]);
}

type FetchArgs = Parameters<typeof fetch>;

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function captureFetch(handler: () => Response): { captured: () => CapturedRequest | null } {
  let captured: CapturedRequest | null = null;
  globalThis.fetch = mock(async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    captured = { url: String(input), init: init ?? {} };
    return handler();
  });
  return { captured: () => captured };
}

function interactionsAudioBody(): unknown {
  return {
    output: [
      {
        content: [
          { type: "audio", mime_type: "audio/pcm;rate=24000", data: samplePcm().toString("base64") },
        ],
      },
    ],
  };
}

describe("GeminiTtsFactory config", () => {
  test("requires a non-empty apiKey", () => {
    expect(() => geminiTtsFactory({})).toThrow(GeminiTtsError);
    expect(() => geminiTtsFactory({ apiKey: "" })).toThrow(GeminiTtsError);
  });

  test("constructor smoke: config.apiKey builds a usable backend", async () => {
    const backend = geminiTtsFactory({ apiKey: "k" });
    // The request-shape test above pins body.model === the default model;
    // this only asserts construction succeeds without touching the default.
    expect(typeof backend.generate).toBe("function");
  });

  test("GEMINI_TTS_FREE_TIER_HINT mentions the free tier", () => {
    expect(GEMINI_TTS_FREE_TIER_HINT).toMatch(/Free tier/i);
    expect(GEMINI_TTS_FREE_TIER_HINT).toMatch(/500/);
  });
});

describe("GeminiTtsFactory generate", () => {
  test("builds the Interactions request: URL, x-goog-api-key, audio shape, preamble", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, interactionsAudioBody()));
    const backend = geminiTtsFactory({ apiKey: "k-bright" });

    const result = await backend.generate({
      text: "Hello world",
      voiceId: "Puck",
      instructions: "Say cheerfully",
    });

    const req = captured()!;
    expect(req.url).toBe(INTERACTIONS_URL);
    const headers = req.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("k-bright");
    expect(headers["Authorization"]).toBeUndefined();
    const body = JSON.parse(String(req.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("gemini-2.5-flash-preview-tts");
    expect(body.input).toBe("Say cheerfully\n\nHello world");
    expect(body.response_format).toEqual({ type: "audio" });
    expect(body.generation_config).toEqual({ speech_config: [{ voice: "Puck" }] });

    expect(result.mime).toBe("audio/wav");
    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result.audio.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(result.audio.byteLength).toBe(44 + samplePcm().length);
  });

  test("default voice Kore + raw input when no instructions", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, interactionsAudioBody()));
    const backend = geminiTtsFactory({ apiKey: "k" });

    await backend.generate({ text: "Plain text", voiceId: "" });

    const body = JSON.parse(String(captured()!.init.body)) as Record<string, unknown>;
    expect(body.input).toBe("Plain text");
    expect(body.generation_config).toEqual({ speech_config: [{ voice: "Kore" }] });
  });

  test("extracts audio from the legacy generateContent inlineData shape and honors rate", async () => {
    captureFetch(() =>
      jsonResponse(200, {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "audio/pcm;rate=16000",
                    data: samplePcm().toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const backend = geminiTtsFactory({ apiKey: "k" });

    const result = await backend.generate({ text: "hi", voiceId: "Kore" });

    expect(result.audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result.audio.readUInt32LE(24)).toBe(16000);
    expect(result.audio.byteLength).toBe(44 + samplePcm().length);
  });

  test("extracts audio from the steps/content shape the repo's interactions chat parsing uses", async () => {
    captureFetch(() =>
      jsonResponse(200, {
        steps: [
          {
            type: "model_output",
            content: [
              { type: "text", text: "ok" },
              { type: "audio", mime: "audio/pcm", data: samplePcm().toString("base64") },
            ],
          },
        ],
      }),
    );
    const backend = geminiTtsFactory({ apiKey: "k" });

    const result = await backend.generate({ text: "hi", voiceId: "Kore" });

    expect(result.audio.byteLength).toBe(44 + samplePcm().length);
    expect(result.audio.readUInt32LE(24)).toBe(24000);
  });

  test("no audio part in the response → GeminiTtsError", async () => {
    captureFetch(() =>
      jsonResponse(200, {
        output: [{ content: [{ type: "text", text: "sorry" }] }],
      }),
    );
    const backend = geminiTtsFactory({ apiKey: "k" });

    await expect(backend.generate({ text: "hi", voiceId: "Kore" })).rejects.toThrow(
      GeminiTtsError,
    );
    await expect(backend.generate({ text: "hi", voiceId: "Kore" })).rejects.toThrow(
      /no audio part/,
    );
  });

  test("non-2xx → GeminiTtsError carrying the status", async () => {
    captureFetch(() => jsonResponse(429, { error: { message: "quota" } }));
    const backend = geminiTtsFactory({ apiKey: "k" });

    await expect(backend.generate({ text: "hi", voiceId: "Kore" })).rejects.toMatchObject({
      name: "GeminiTtsError",
      message: expect.stringContaining("429"),
    });
  });

  test("config.model overrides the default model", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, interactionsAudioBody()));
    const backend = geminiTtsFactory({ apiKey: "k", model: "gemini-3.1-flash-tts-preview" });

    await backend.generate({ text: "hi", voiceId: "Kore" });

    const body = JSON.parse(String(captured()!.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("gemini-3.1-flash-tts-preview");
  });
});

describe("GeminiTtsFactory voices + probe", () => {
  test("listVoices returns the 30 prebuilt voices incl. Kore", async () => {
    const backend = geminiTtsFactory({ apiKey: "k" });
    const voices = await backend.listVoices();
    expect(voices).toHaveLength(30);
    expect(voices.find((v) => v.id === "Kore")).toEqual({
      id: "Kore",
      label: "Kore (Firm)",
      lang: "multi",
    });
    expect(GEMINI_TTS_VOICES).toHaveLength(30);
  });

  test("probe ok: counts -tts models (real /v1beta/models shape)", async () => {
    captureFetch(() =>
      jsonResponse(200, {
        models: [
          { name: "models/gemini-2.5-flash-preview-tts" },
          { name: "models/gemini-2.5-flash" },
        ],
      }),
    );
    const backend = geminiTtsFactory({ apiKey: "k" });

    const result = await backend.probe();

    expect(result.ok).toBe(true);
    expect(result.detail).toBe("1 TTS models");
  });

  test("probe non-200 → ok:false with status", async () => {
    captureFetch(() => jsonResponse(401, { error: { message: "bad key" } }));
    const backend = geminiTtsFactory({ apiKey: "k" });

    const result = await backend.probe();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");
  });

  test("probe hits the models URL with the api key header", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, { models: [] }));
    const backend = geminiTtsFactory({ apiKey: "k" });

    await backend.probe();

    const req = captured()!;
    expect(req.url).toBe(MODELS_URL);
    const headers = req.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("k");
  });

  test("dispose is a harmless no-op", async () => {
    const backend: TtsBackend = geminiTtsFactory({ apiKey: "k" });
    await expect(backend.dispose()).resolves.toBeUndefined();
  });
});

describe("registration through the registry", () => {
  test("registers the factory under the gemini slug", async () => {
    registerTtsBackend(TTS_BACKEND.Gemini, geminiTtsFactory);
    const backend = createTtsBackend("gemini", { apiKey: "k" });
    captureFetch(() => jsonResponse(200, interactionsAudioBody()));

    const result = await backend.generate({ text: "hi", voiceId: "Kore" });

    expect(result.mime).toBe("audio/wav");
  });
});

describe("pcmToWav header layout", () => {
  test("44-byte RIFF/WAVE header with PCM mono 16-bit fields", () => {
    const pcm = samplePcm();
    const wav = pcmToWav(pcm, 24000);

    expect(wav.byteLength).toBe(44 + pcm.length);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(28)).toBe(48000); // byte rate
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);
  });
});