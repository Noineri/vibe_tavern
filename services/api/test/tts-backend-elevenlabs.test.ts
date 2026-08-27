import { afterEach, describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import { ElevenLabsTtsBackend, ElevenLabsTtsError, elevenLabsTtsFactory } from "../src/domain/tts/backends/elevenlabs-tts.js";
import { createTtsBackend, registerTtsBackend } from "../src/domain/tts/tts-registry.js";

function backend(config: Record<string, unknown> = {}): ElevenLabsTtsBackend {
  return elevenLabsTtsFactory({ apiKey: "key_123", ...config }) as ElevenLabsTtsBackend;
}

// ─── fetch mock helpers ──────────────────────────────────────────────────────

interface RecordedRequest {
  url: string;
  init: RequestInit;
  body: unknown;
  headers: Headers;
}

let recordedRequests: RecordedRequest[] = [];
let nextResponse: Response | (() => Response) = new Response("{}", { status: 200 });

// Snapshot BEFORE any mock is installed (house pattern — see the gemini/openai
// TTS tests): restoring via the bare `fetch` identifier would read the CURRENT
// (mocked) global and no-op, leaking the mock into later files in this process
// (reproduced: updater tests fail when run after this file).
const originalFetch = globalThis.fetch;

function installFetchMock(): void {
  recordedRequests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    recordedRequests.push({ url, init: init ?? {}, body, headers });
    const response = typeof nextResponse === "function" ? nextResponse() : nextResponse;
    // Return a fresh Response per call so multiple calls don't share a consumed body.
    return response.clone();
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  recordedRequests = [];
  nextResponse = new Response("{}", { status: 200 });
});

function lastRequest(): RecordedRequest {
  expect(recordedRequests.length).toBeGreaterThan(0);
  return recordedRequests[recordedRequests.length - 1]!;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ElevenLabsTtsBackend.generate", () => {
  test("posts to the encoded voice_id URL with xi-api-key and the output_format query", async () => {
    installFetchMock();
    nextResponse = new Response("fake mp3 bytes", { status: 200, headers: { "Content-Type": "audio/mpeg" } });

    const result = await backend().generate({ text: "Hello", voiceId: "pNInz6obpgDQGcFmaJgB" });

    const req = lastRequest();
    expect(req.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/pNInz6obpgDQGcFmaJgB?output_format=mp3_44100_128");
    expect(req.headers.get("xi-api-key")).toBe("key_123");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    expect(req.body).toEqual({ text: "Hello", model_id: "eleven_multilingual_v2" });
    expect(result).toEqual({ audio: Buffer.from("fake mp3 bytes"), mime: "audio/mpeg" });
  });

  test("sends voice_settings in snake_case with only the configured keys", async () => {
    installFetchMock();
    nextResponse = new Response("ok", { status: 200 });

    await backend({
      modelId: "eleven_v3",
      stability: 0.5,
      similarityBoost: 0.8,
      style: 0.3,
      useSpeakerBoost: true,
      speed: 1.0,
    }).generate({ text: "Hi", voiceId: "v1" });

    expect(lastRequest().body).toEqual({
      text: "Hi",
      model_id: "eleven_v3",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.3,
        use_speaker_boost: true,
        speed: 1.0,
      },
    });
  });

  test("omits voice_settings entirely when nothing is configured", async () => {
    installFetchMock();
    nextResponse = new Response("ok", { status: 200 });

    await backend().generate({ text: "Hi", voiceId: "v1" });

    const body = lastRequest().body as Record<string, unknown>;
    expect("voice_settings" in body).toBe(false);
  });

  test("clamps out-of-range slider and speed values", async () => {
    installFetchMock();
    nextResponse = new Response("ok", { status: 200 });

    await backend({ stability: 1.5, speed: 2 }).generate({ text: "Hi", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).voice_settings).toEqual({
      stability: 1,
      speed: 1.2,
    });

    await backend({ stability: -0.5, speed: 0.5 }).generate({ text: "Hi", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).voice_settings).toEqual({
      stability: 0,
      speed: 0.7,
    });
  });

  test("non-2xx response throws ElevenLabsTtsError containing the status", async () => {
    installFetchMock();
    nextResponse = new Response("invalid api key", { status: 401 });

    try {
      await backend().generate({ text: "Hello", voiceId: "v1" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ElevenLabsTtsError);
      expect((error as Error).message).toContain("401");
      expect((error as Error).message).toContain("invalid api key");
    }
  });

  test("empty voiceId throws a typed error", async () => {
    installFetchMock();
    try {
      await backend().generate({ text: "Hello", voiceId: "" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ElevenLabsTtsError);
      expect((error as Error).message).toContain("voiceId");
    }
  });

  test("missing apiKey throws a typed error without any fetch", async () => {
    installFetchMock();
    try {
      await elevenLabsTtsFactory({ modelId: "eleven_v3" }).generate({ text: "Hello", voiceId: "v1" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ElevenLabsTtsError);
      expect((error as Error).message).toContain("apiKey");
    }
    expect(recordedRequests).toHaveLength(0);
  });
});

describe("ElevenLabsTtsBackend.listVoices", () => {
  test("maps voice_id/name/labels into TtsVoiceInfo with a ' · labels' label", async () => {
    installFetchMock();
    nextResponse = new Response(
      JSON.stringify({
        voices: [
          { voice_id: "v1", name: "Rachel", labels: { accent: "american", gender: "female" } },
          { voice_id: "v2", name: "Drew", labels: {} },
          { voice_id: "v3" },
        ],
      }),
      { status: 200 },
    );

    const voices = await backend().listVoices();

    expect(voices).toEqual([
      { id: "v1", label: "Rachel · american · female", lang: "multi" },
      { id: "v2", label: "Drew", lang: "multi" },
      { id: "v3", label: "v3", lang: "multi" },
    ]);
    expect(lastRequest().url).toBe("https://api.elevenlabs.io/v1/voices");
    expect(lastRequest().headers.get("xi-api-key")).toBe("key_123");
  });

  test("skips malformed entries and throws on a missing voices array", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ voices: [{ voice_id: "ok" }, { no_id: true }, "junk", null] }), {
      status: 200,
    });

    const voices = await backend().listVoices();
    expect(voices).toEqual([{ id: "ok", label: "ok", lang: "multi" }]);

    nextResponse = new Response(JSON.stringify({ notVoices: [] }), { status: 200 });
    try {
      await backend().listVoices();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ElevenLabsTtsError);
    }
  });

  test("throws on non-200 responses", async () => {
    installFetchMock();
    nextResponse = new Response("forbidden", { status: 403 });
    try {
      await backend().listVoices();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ElevenLabsTtsError);
      expect((error as Error).message).toContain("403");
    }
  });
});

describe("ElevenLabsTtsBackend.probe / dispose", () => {
  test("probe ok reports the voice count", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ voices: [{ voice_id: "a" }, { voice_id: "b" }] }), { status: 200 });

    const result = await backend().probe();
    expect(result).toEqual({ ok: true, detail: "2 voices" });
  });

  test("probe fail reports status + body excerpt on non-2xx", async () => {
    installFetchMock();
    nextResponse = new Response("bad key", { status: 401 });

    const result = await backend().probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");
    expect(result.detail).toContain("bad key");
  });

  test("probe without apiKey fails fast with a legible detail", async () => {
    const result = await elevenLabsTtsFactory({}).probe();
    expect(result).toEqual({ ok: false, detail: "apiKey is required for ElevenLabs." });
  });

  test("probe surfaces network errors", async () => {
    installFetchMock();
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const result = await backend().probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ECONNREFUSED");
  });

  test("dispose resolves without error", async () => {
    await expect(backend().dispose()).resolves.toBeUndefined();
  });
});

describe("registry wiring", () => {
  test("the elevenlabs slug resolves to this adapter after registration", async () => {
    installFetchMock();
    nextResponse = new Response("ok", { status: 200 });

    registerTtsBackend(TTS_BACKEND.ElevenLabs, elevenLabsTtsFactory);
    const backend = createTtsBackend("elevenlabs", { apiKey: "key_123" });

    expect(typeof backend.generate).toBe("function");
    await backend.generate({ text: "Hi", voiceId: "v1" });
    expect(lastRequest().url).toContain("/v1/text-to-speech/v1");
  });
});