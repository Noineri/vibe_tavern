import { afterEach, describe, expect, mock, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import {
  OpenAiCompatTtsConfigError,
  OpenAiCompatTtsError,
  VOICES_GPT4O_MINI_TTS,
  VOICES_TTS1,
  openAiCompatTtsFactory,
} from "../src/domain/tts/backends/openai-tts.js";
import {
  createTtsBackend,
  registerTtsBackend,
} from "../src/domain/tts/tts-registry.js";

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

function audioResponse(mime = "audio/mpeg"): Response {
  return new Response(new Uint8Array([0xff, 0xfb, 0x00, 0x01]), {
    status: 200,
    headers: { "Content-Type": mime },
  });
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

function headersOf(init: RequestInit): Record<string, string> {
  const headers = new Headers(init.headers);
  const record: Record<string, string> = {};
  for (const [key, value] of headers.entries()) record[key] = value;
  return record;
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  const raw = init.body;
  if (typeof raw !== "string") throw new Error("expected a JSON string body");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("OpenAI-compatible TTS generate", () => {
  test("happy path: URL, Bearer, body fields, Buffer + mime", async () => {
    const { captured } = captureFetch(() => audioResponse());
    const backend = openAiCompatTtsFactory({
      endpoint: "http://localhost:8880/v1",
      apiKey: "sk-local",
      model: "kokoro",
      responseFormat: "wav",
    });

    const result = await backend.generate({ text: "Hello world", voiceId: "af_bella", speed: 1.5 });

    const req = captured()!;
    expect(req.url).toBe("http://localhost:8880/v1/audio/speech");
    expect(req.init.method).toBe("POST");
    const headers = headersOf(req.init);
    expect(headers["authorization"]).toBe("Bearer sk-local");
    expect(headers["content-type"]).toBe("application/json");

    const body = bodyOf(req.init);
    expect(body).toEqual({
      model: "kokoro",
      input: "Hello world",
      voice: "af_bella",
      response_format: "wav",
      speed: 1.5,
    });

    expect(Buffer.isBuffer(result.audio)).toBe(true);
    expect(result.mime).toBe("audio/mpeg");
  });

  test("trailing slash in endpoint is normalized away", async () => {
    const { captured } = captureFetch(() => audioResponse());
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8880/v1/" });

    await backend.generate({ text: "hi", voiceId: "af_heart" });

    expect(captured()!.url).toBe("http://localhost:8880/v1/audio/speech");
  });

  test("no apiKey → no Authorization header; speed omitted when undefined", async () => {
    const { captured } = captureFetch(() => audioResponse());
    const backend = openAiCompatTtsFactory({ endpoint: "http://127.0.0.1:8000/v1" });

    await backend.generate({ text: "hi", voiceId: "af_heart" });

    const headers = headersOf(captured()!.init);
    expect(headers["authorization"]).toBeUndefined();
    const body = bodyOf(captured()!.init);
    expect("speed" in body).toBe(false);
  });

  test("instructions included only for gpt-4o-mini-tts models", async () => {
    const { captured } = captureFetch(() => audioResponse());
    const backend = openAiCompatTtsFactory({
      endpoint: "https://api.openai.com/v1",
      apiKey: "sk-x",
      model: "gpt-4o-mini-tts",
    });

    await backend.generate({ text: "hi", voiceId: "coral", instructions: "Speak warmly." });

    expect(bodyOf(captured()!.init).instructions).toBe("Speak warmly.");
  });

  test("instructions NOT included for tts-1 family", async () => {
    const { captured } = captureFetch(() => audioResponse());
    const backend = openAiCompatTtsFactory({
      endpoint: "https://api.openai.com/v1",
      apiKey: "sk-x",
      model: "tts-1",
    });

    await backend.generate({ text: "hi", voiceId: "alloy", instructions: "Speak warmly." });

    expect("instructions" in bodyOf(captured()!.init)).toBe(false);
  });

  test("speed clamps into 0.25–4.0", async () => {
    const first = captureFetch(() => audioResponse());
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8880/v1" });

    await backend.generate({ text: "hi", voiceId: "af_heart", speed: 9 });
    expect(bodyOf(first.captured()!.init).speed).toBe(4);

    const second = captureFetch(() => audioResponse());
    await backend.generate({ text: "hi", voiceId: "af_heart", speed: 0.01 });
    expect(bodyOf(second.captured()!.init).speed).toBe(0.25);
  });

  test("non-2xx → OpenAiCompatTtsError with status", async () => {
    captureFetch(() => jsonResponse(500, { error: "boom" }));
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8880/v1" });

    await expect(backend.generate({ text: "hi", voiceId: "af_heart" })).rejects.toThrow(
      OpenAiCompatTtsError,
    );
    await expect(backend.generate({ text: "hi", voiceId: "af_heart" })).rejects.toThrow("500");
  });

  test("empty voiceId → config error; missing endpoint → factory throws", async () => {
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8880/v1" });
    await expect(backend.generate({ text: "hi", voiceId: "  " })).rejects.toThrow(
      OpenAiCompatTtsConfigError,
    );

    expect(() => openAiCompatTtsFactory({})).toThrow(OpenAiCompatTtsConfigError);
  });
});

describe("OpenAI-compatible TTS listVoices", () => {
  test("kokoro-fastapi /audio/voices shape wins when present", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, { voices: [{ id: "af_bella", name: "Bella" }] }),
    );
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8880/v1" });

    const voices = await backend.listVoices();

    expect(captured()!.url).toBe("http://localhost:8880/v1/audio/voices");
    expect(voices).toEqual([{ id: "af_bella", label: "Bella", lang: "en" }]);
  });

  test("bare-array voices payload tolerated", async () => {
    captureFetch(() => jsonResponse(200, [{ id: "ef_dora" }]));
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8880/v1" });

    const voices = await backend.listVoices();

    expect(voices).toEqual([{ id: "ef_dora", label: "ef_dora", lang: "en" }]);
  });

  test("/audio/voices 404 → null (honest, no fallback to /models or static roster)", async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount += 1;
      return jsonResponse(404, { detail: "not found" });
    });
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8000/v1" });

    const voices = await backend.listVoices();

    expect(voices).toBeNull();
    expect(callCount).toBe(1);
    // Null means no fake roster — assert none of the static ids leak through.
    // (VOICES_GPT4O_MINI_TTS contains alloy, echo, etc.)
  });

  test("network failure → null (honest, no static roster)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const backend = openAiCompatTtsFactory({ endpoint: "https://api.openai.com/v1" });

    const voices = await backend.listVoices();

    expect(voices).toBeNull();
  });

  test("both endpoints unavailable must NOT return the static OpenAI roster", async () => {
    globalThis.fetch = mock(async () => jsonResponse(500, { error: "down" }));
    const backend = openAiCompatTtsFactory({ endpoint: "https://api.openai.com/v1" });

    const voices = await backend.listVoices();

    expect(voices).toBeNull();
    if (voices !== null) {
      expect(voices.map((v) => v.id)).not.toContain("alloy");
      expect(voices.map((v) => v.id)).not.toContain("echo");
    }
  });
});

describe("OpenAI-compatible TTS probe", () => {
  test("ok: counts models", async () => {
    captureFetch(() => jsonResponse(200, { data: [{ id: "kokoro" }, { id: "helper" }] }));
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8880/v1" });

    const result = await backend.probe();

    expect(result).toEqual({ ok: true, detail: "2 models" });
  });

  test("non-200 → ok:false with status", async () => {
    captureFetch(() => jsonResponse(403, { error: "forbidden" }));
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8880/v1" });

    const result = await backend.probe();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("403");
  });

  test("network error → ok:false, does not throw", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8880/v1" });

    const result = await backend.probe();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ECONNREFUSED");
  });
});

describe("rosters + registration", () => {
  test("static rosters are the documented OpenAI sets", () => {
    expect(VOICES_GPT4O_MINI_TTS).toHaveLength(13);
    expect(VOICES_TTS1).toHaveLength(9);
    for (const voice of VOICES_TTS1) {
      expect(VOICES_GPT4O_MINI_TTS).toContain(voice);
    }
  });

  test("explicit registration → createTtsBackend resolves the factory", () => {
    registerTtsBackend(TTS_BACKEND.OpenAiCompatible, openAiCompatTtsFactory);
    const backend = createTtsBackend("openai-compatible", { endpoint: "http://localhost:8880/v1" });
    expect(typeof backend.generate).toBe("function");
  });
});

describe("OpenAI-compatible TTS listModels filtering", () => {
  test("modality → request URL contains output_modalities=speech", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, { data: [{ id: "voice-1" }] }),
    );
    const backend = openAiCompatTtsFactory({
      endpoint: "http://localhost:8880/v1",
      modelFilter: "modality",
    });
    await backend.listModels();
    expect(captured()!.url).toBe("http://localhost:8880/v1/models?output_modalities=speech");
  });

  test("heuristic → mixed model list comes back filtered", async () => {
    captureFetch(() =>
      jsonResponse(200, {
        data: [
          { id: "gpt-4o" },
          { id: "tts-1" },
          { id: "canopylabs/orpheus-v1-english" },
          { id: "whisper-1" },
        ],
      }),
    );
    const backend = openAiCompatTtsFactory({
      endpoint: "http://localhost:8880/v1",
      modelFilter: "name-heuristic",
    });
    const models = await backend.listModels();
    expect(models.map((m) => m.id)).toEqual(["tts-1", "canopylabs/orpheus-v1-english"]);
  });

  test("heuristic → zero matches returns the full list unchanged", async () => {
    captureFetch(() =>
      jsonResponse(200, { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
    );
    const backend = openAiCompatTtsFactory({
      endpoint: "http://localhost:8880/v1",
      modelFilter: "name-heuristic",
    });
    const models = await backend.listModels();
    expect(models.map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  test("absent hint → unfiltered, URL has NO query param", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, {
        data: [{ id: "gpt-4o" }, { id: "tts-1" }, { id: "whisper-1" }],
      }),
    );
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8880/v1" });
    const models = await backend.listModels();
    expect(captured()!.url).toBe("http://localhost:8880/v1/models");
    expect(models.map((m) => m.id)).toEqual(["gpt-4o", "tts-1", "whisper-1"]);
  });
});
