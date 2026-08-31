import { afterEach, describe, expect, mock, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import {
  OpenAiCompatTtsConfigError,
  OpenAiCompatTtsError,
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

  // ── D22: aggregators have no /audio/voices — the roster is per-model
  // catalog data, resolved by the selected model.
  test("openrouter: listVoices resolves the roster from the modality catalog by model", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, {
        data: [
          { id: "flux-tts", supported_voices: ["flux-alexis-en", "flux-bella-en"] },
          { id: "fish-audio/speech", supported_voices: null },
        ],
      }),
    );
    const backend = openAiCompatTtsFactory({ endpoint: "https://openrouter.ai/api/v1", model: "flux-tts" });
    const voices = await backend.listVoices();
    expect(captured()!.url).toBe("https://openrouter.ai/api/v1/models?output_modalities=speech");
    expect(voices).toEqual([
      { id: "flux-alexis-en", label: "flux-alexis-en", lang: "en" },
      { id: "flux-bella-en", label: "flux-bella-en", lang: "en" },
    ]);
  });

  test("openrouter: null supported_voices (fish/minimax-style) → null roster (manual input)", async () => {
    captureFetch(() => jsonResponse(200, { data: [{ id: "fish-audio/speech", supported_voices: null }] }));
    const backend = openAiCompatTtsFactory({ endpoint: "https://openrouter.ai/api/v1", model: "fish-audio/speech" });
    expect(await backend.listVoices()).toBeNull();
  });

  test("nanogpt: listVoices resolves supported_parameters.voices by model", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, {
        data: [
          { id: "xai-tts", capabilities: { text_to_speech: true }, supported_parameters: { voices: ["Eve", "Ara", "Leo", "Rex", "Sal"] } },
        ],
      }),
    );
    const backend = openAiCompatTtsFactory({ endpoint: "https://nano-gpt.com/api/v1", model: "xai-tts" });
    const voices = await backend.listVoices();
    expect(captured()!.url).toBe("https://nano-gpt.com/api/v1/audio-models?type=tts&detailed=true");
    expect(voices).toEqual([
      { id: "Eve", label: "Eve", lang: "en" },
      { id: "Ara", label: "Ara", lang: "en" },
      { id: "Leo", label: "Leo", lang: "en" },
      { id: "Rex", label: "Rex", lang: "en" },
      { id: "Sal", label: "Sal", lang: "en" },
    ]);
  });

  test("aggregator: no model chosen or model not in catalog → null", async () => {
    captureFetch(() => jsonResponse(200, { data: [{ id: "flux-tts", supported_voices: ["flux-alexis-en"] }] }));
    const noModel = openAiCompatTtsFactory({ endpoint: "https://openrouter.ai/api/v1" });
    expect(await noModel.listVoices()).toBeNull();
    captureFetch(() => jsonResponse(200, { data: [{ id: "flux-tts", supported_voices: ["flux-alexis-en"] }] }));
    const missing = openAiCompatTtsFactory({ endpoint: "https://openrouter.ai/api/v1", model: "gone-model" });
    expect(await missing.listVoices()).toBeNull();
  });

  test("bare-array voices payload tolerated", async () => {
    captureFetch(() => jsonResponse(200, [{ id: "ef_dora" }]));
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8880/v1" });

    const voices = await backend.listVoices();

    expect(voices).toEqual([{ id: "ef_dora", label: "ef_dora", lang: "en" }]);
  });

  test("both /audio/voices and /voices 404 → null (manual input floor)", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(404, { detail: "not found" });
    });
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8000/v1" });

    const voices = await backend.listVoices();

    expect(voices).toBeNull();
    expect(calls).toEqual(["http://localhost:8000/v1/audio/voices", "http://localhost:8000/v1/voices"]);
    // Null means no fake roster — the static id tables were removed (D20);
    // nothing can leak through.
  });

  // ── Full-support rule: chatterbox-tts-api (setup card) serves its voice
  // library at /voices — live-verified 2026-08-31 on the owner's server:
  // /v1/audio/voices 404, /v1/voices 200 { voices: [{ name, language, ... }] }.
  test("chatterbox: /audio/voices 404 → falls back to the /voices library", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/audio/voices")) return jsonResponse(404, { detail: "not found" });
      return jsonResponse(200, {
        voices: [
          { name: "my-clone", path: "/x/my-clone.wav", language: "ru", aliases: [], exists: true },
          { name: "narrator", path: "/x/narrator.wav", language: "en", aliases: [], exists: true },
        ],
        count: 2,
      });
    });
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:4123/v1" });

    const voices = await backend.listVoices();

    expect(voices).toEqual([
      { id: "my-clone", label: "my-clone", lang: "ru" },
      { id: "narrator", label: "narrator", lang: "en" },
    ]);
    expect(calls).toEqual(["http://localhost:4123/v1/audio/voices", "http://localhost:4123/v1/voices"]);
  });

  test("chatterbox: empty voice library → null (no invented voices)", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/audio/voices")) return jsonResponse(404, { detail: "not found" });
      return jsonResponse(200, { voices: [], count: 0 });
    });
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:4123/v1" });

    const voices = await backend.listVoices();

    expect(voices).toBeNull();
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

  test("legacy name-heuristic stamp + custom server → plain URL, list unfiltered (F8: the heuristic is REMOVED; stamps on unknown hosts are inert)", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, { data: [{ id: "gpt-4o" }, { id: "tts-1" }, { id: "whisper-1" }] }),
    );
    const backend = openAiCompatTtsFactory({
      endpoint: "http://localhost:8880/v1",
      modelFilter: "name-heuristic",
    });
    const models = await backend.listModels();
    expect(captured()!.url).toBe("http://localhost:8880/v1/models");
    expect(models.map((m) => m.id)).toEqual(["gpt-4o", "tts-1", "whisper-1"]);
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

  test("{ models: [...] } body shape (openai-edge-tts) parses like data", async () => {
    // Live-verified 2026-08-29: openai-edge-tts /v1/models returns
    // {"models":[{"id":"tts-1"},{"id":"tts-1-hd"},{"id":"gpt-4o-mini-tts"}]}
    // — the `data` key is absent entirely.
    captureFetch(() =>
      jsonResponse(200, { models: [{ id: "tts-1" }, { id: "tts-1-hd" }, { id: "gpt-4o-mini-tts" }] }),
    );
    const backend = openAiCompatTtsFactory({ endpoint: "http://127.0.0.1:5050/v1" });
    const models = await backend.listModels();
    expect(models.map((m) => m.id)).toEqual(["tts-1", "tts-1-hd", "gpt-4o-mini-tts"]);
  });

  test("aggregator enrichment: name/description/pricing/context parsed into the entry", async () => {
    captureFetch(() =>
      jsonResponse(200, {
        data: [
          {
            id: "deepgram/flux-tts:free",
            name: "Flux TTS (free)",
            description: "Fast TTS model by Deepgram",
            context_length: 4096,
            pricing: { prompt: "0", completion: "0" },
          },
          { id: "paid/tts", name: "Paid TTS", pricing: { prompt: "3", completion: "0" } },
          { id: "bare/tts" },
        ],
      }),
    );
    const backend = openAiCompatTtsFactory({ endpoint: "https://openrouter.ai/api/v1", modelFilter: "modality" });
    const models = await backend.listModels();
    expect(models[0]).toEqual({
      id: "deepgram/flux-tts:free",
      label: "Flux TTS (free)",
      description: "Fast TTS model by Deepgram",
      contextLength: 4096,
      isFree: true,
    });
    expect(models[1]).toEqual({ id: "paid/tts", label: "Paid TTS", isFree: false });
    expect(models[2]).toEqual({ id: "bare/tts", label: "bare/tts" });
  });

  test("no filter + openrouter host → modality param applied anyway (D15: heals pre-stamp profiles)", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, { data: [{ id: "deepgram/flux-tts:free" }] }),
    );
    const backend = openAiCompatTtsFactory({ endpoint: "https://openrouter.ai/api/v1" });
    const models = await backend.listModels();
    expect(captured()!.url).toBe("https://openrouter.ai/api/v1/models?output_modalities=speech");
    expect(models.map((m) => m.id)).toEqual(["deepgram/flux-tts:free"]);
  });

  test("no filter + openrouter host written without scheme → modality param still applies", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, { data: [] }));
    const backend = openAiCompatTtsFactory({ endpoint: "openrouter.ai/api/v1" });
    await backend.listModels();
    expect(captured()!.url).toBe("openrouter.ai/api/v1/models?output_modalities=speech");
  });

  // ── D23: NanoGPT serves TTS discovery from /audio-models (docs:
  // /api-reference/endpoint/audio-models; verified live 2026-08-29).
  test("audio-models stamp → /audio-models?type=tts&detailed=true, music entries dropped by capability", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, {
        object: "list",
        data: [
          {
            id: "xai-tts",
            name: "xAI TTS",
            description: "Speech model",
            pricing: { currency: "USD", per_thousand_chars: 10 },
            capabilities: { text_to_speech: true, speech_to_text: false },
          },
          {
            id: "free-tts",
            name: "Free TTS",
            pricing: { currency: "USD", per_thousand_chars: 0 },
            capabilities: { text_to_speech: true },
          },
          // type=tts still returns music models (live-verified: ACE-Step) —
          // only capabilities.text_to_speech === true synthesizes speech.
          { id: "ace-step-v1", name: "ACE Step", capabilities: { text_to_speech: false }, pricing: { per_thousand_chars: 2 } },
          { id: "no-capability-flag", name: "Bare" },
        ],
      }),
    );
    const backend = openAiCompatTtsFactory({ endpoint: "https://nano-gpt.com/api/v1", modelFilter: "audio-models" });
    const models = await backend.listModels();
    expect(captured()!.url).toBe("https://nano-gpt.com/api/v1/audio-models?type=tts&detailed=true");
    expect(models.map((m) => m.id)).toEqual(["xai-tts", "free-tts"]);
    expect(models[0]).toEqual({ id: "xai-tts", label: "xAI TTS", description: "Speech model", isFree: false });
    expect(models[1]).toEqual({ id: "free-tts", label: "Free TTS", isFree: true });
  });

  test("D22: catalog entries carry the per-model voice roster (supported_voices / supported_parameters.voices)", async () => {
    captureFetch(() =>
      jsonResponse(200, {
        data: [
          { id: "flux-tts", supported_voices: ["flux-alexis-en"] },
          { id: "fish-audio/speech", supported_voices: null },
        ],
      }),
    );
    const or = openAiCompatTtsFactory({ endpoint: "https://openrouter.ai/api/v1", modelFilter: "modality" });
    const orModels = await or.listModels();
    expect(orModels[0].voices).toEqual(["flux-alexis-en"]);
    expect(orModels[1].voices).toBeUndefined();

    captureFetch(() =>
      jsonResponse(200, {
        data: [
          { id: "xai-tts", capabilities: { text_to_speech: true }, supported_parameters: { voices: ["Eve", "Ara"] } },
        ],
      }),
    );
    const nano = openAiCompatTtsFactory({ endpoint: "https://nano-gpt.com/api/v1", modelFilter: "audio-models" });
    const nanoModels = await nano.listModels();
    expect(nanoModels[0].voices).toEqual(["Eve", "Ara"]);
  });

  test("no filter + nano-gpt host → audio-models anyway (D23: heals pre-stamp name-heuristic profiles)", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, { data: [] }));
    const backend = openAiCompatTtsFactory({ endpoint: "https://nano-gpt.com/api/v1" });
    await backend.listModels();
    expect(captured()!.url).toBe("https://nano-gpt.com/api/v1/audio-models?type=tts&detailed=true");
  });

  test("legacy name-heuristic stamp + nano-gpt host → audio-models wins (field fix: pre-F6 presets stamped it)", async () => {
    // The owner's live profile: saved while the preset stamped
    // "name-heuristic" — an explicit-looking value that is preset glue, not
    // a user choice. The host must heal it, or the chat-only /models
    // catalog leaks LLM ids into the TTS picker.
    const { captured } = captureFetch(() =>
      jsonResponse(200, { data: [{ id: "xai-tts", capabilities: { text_to_speech: true } }] }),
    );
    const backend = openAiCompatTtsFactory({ endpoint: "https://nano-gpt.com/api/v1", modelFilter: "name-heuristic" });
    const models = await backend.listModels();
    expect(captured()!.url).toBe("https://nano-gpt.com/api/v1/audio-models?type=tts&detailed=true");
    expect(models.map((m) => m.id)).toEqual(["xai-tts"]);
  });

  test("legacy stamp + nano-gpt host → listVoices also resolves from the audio-models catalog by model", async () => {
    captureFetch(() =>
      jsonResponse(200, {
        data: [{ id: "xai-tts", capabilities: { text_to_speech: true }, supported_parameters: { voices: ["Eve", "Ara"] } }],
      }),
    );
    const backend = openAiCompatTtsFactory({ endpoint: "https://nano-gpt.com/api/v1", modelFilter: "name-heuristic", model: "xai-tts" });
    const voices = await backend.listVoices();
    expect(voices).toEqual([
      { id: "Eve", label: "Eve", lang: "en" },
      { id: "Ara", label: "Ara", lang: "en" },
    ]);
  });

  test("legacy name-heuristic stamp + groq host → documented table wins, NO fetch (F8 host-heal)", async () => {
    // Pre-F8 presets stamped groq profiles with `name-heuristic` (preset
    // glue, not a user choice) — the host must heal it to the documented
    // static catalog; the mixed chat /models must never be requested.
    const { captured } = captureFetch(() => jsonResponse(200, { data: [{ id: "gpt-4o" }] }));
    const backend = openAiCompatTtsFactory({
      endpoint: "https://api.groq.com/openai/v1",
      modelFilter: "name-heuristic",
    });
    const models = await backend.listModels();
    expect(captured()).toBeNull();
    expect(models.map((m) => m.id)).toEqual([
      "canopylabs/orpheus-v1-english",
      "canopylabs/orpheus-arabic-saudi",
    ]);
  });
});

describe("openai-compat TTS documented + audio-type discovery (F8)", () => {
  test("openai host → documented table: 3 models, no network", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, { data: [{ id: "gpt-4o" }] }));
    const backend = openAiCompatTtsFactory({ endpoint: "https://api.openai.com/v1" });
    const models = await backend.listModels();
    expect(captured()).toBeNull();
    expect(models.map((m) => m.id)).toEqual(["gpt-4o-mini-tts", "tts-1", "tts-1-hd"]);
  });

  test("openai roster pins: mini-tts 13 voices incl. marin+cedar, tts-1 family 9", async () => {
    captureFetch(() => jsonResponse(200, { data: [] }));
    const backend = openAiCompatTtsFactory({ endpoint: "https://api.openai.com/v1", model: "tts-1" });
    const mini = openAiCompatTtsFactory({ endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini-tts" });
    expect((await mini.listVoices())!.map((v) => v.id)).toEqual([
      "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova",
      "sage", "shimmer", "verse", "marin", "cedar",
    ]);
    expect((await backend.listVoices())!.map((v) => v.id)).toEqual([
      "alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer",
    ]);
    // Roster also rides the models list (model-scoped pickers).
    const models = await mini.listModels();
    expect(models.find((m) => m.id === "gpt-4o-mini-tts")!.voices).toHaveLength(13);
    expect(models.find((m) => m.id === "gpt-4o-mini-tts")!.voices).toContain("marin");
    expect(models.find((m) => m.id === "tts-1-hd")!.voices).toHaveLength(9);
  });

  test("documented listVoices: unknown model → null (manual), no model → null, per-model lang rides the answer", async () => {
    captureFetch(() => jsonResponse(200, { data: [] }));
    const unknown = openAiCompatTtsFactory({ endpoint: "https://api.openai.com/v1", model: "not-a-model" });
    expect(await unknown.listVoices()).toBeNull();
    const unset = openAiCompatTtsFactory({ endpoint: "https://api.openai.com/v1" });
    expect(await unset.listVoices()).toBeNull();
    const groqAr = openAiCompatTtsFactory({
      endpoint: "https://api.groq.com/openai/v1",
      model: "canopylabs/orpheus-arabic-saudi",
    });
    const voices = await groqAr.listVoices();
    expect(voices!.map((v) => v.id)).toEqual(["abdullah", "fahad", "sultan", "lulwa", "noura", "aisha"]);
    expect(voices!.every((v) => v.lang === "ar")).toBe(true);
  });

  test("electronhub documented: 10 models; openai-trio 11-voice roster, others → manual floor", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, { data: [] }));
    const backend = openAiCompatTtsFactory({ endpoint: "https://api.electronhub.ai/v1" });
    const models = await backend.listModels();
    expect(captured()).toBeNull();
    expect(models).toHaveLength(10);
    expect(models.find((m) => m.id === "tts-1")!.voices).toEqual([
      "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse",
    ]);
    expect(models.find((m) => m.id === "gpt-4o-mini-tts")!.voices).not.toContain("marin");
    expect(models.find((m) => m.id === "elevenlabs")!.voices).toBeUndefined();
    const eleven = openAiCompatTtsFactory({ endpoint: "https://api.electronhub.ai/v1", model: "elevenlabs" });
    expect(await eleven.listVoices()).toBeNull();
  });

  test("siliconflow host → audio-type URL, host beats legacy name-heuristic stamp", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, { data: [{ id: "FunAudioLLM/CosyVoice2-0.5B" }] }));
    const stamped = openAiCompatTtsFactory({
      endpoint: "https://api.siliconflow.cn/v1",
      modelFilter: "name-heuristic",
    });
    const models = await stamped.listModels();
    expect(captured()!.url).toBe("https://api.siliconflow.cn/v1/models?type=audio");
    expect(models.map((m) => m.id)).toEqual(["FunAudioLLM/CosyVoice2-0.5B"]);
  });

  test("siliconflow listVoices: 8 static system voices (model:voice wire) + custom list from /audio/voice/list", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/audio/voice/list")) {
        return jsonResponse(200, {
          voices: [
            { uri: "speech:my-voice:cm04:mjt", name: "my-voice" },
            { name: "unnamed" }, // no uri/id → dropped
          ],
        });
      }
      return jsonResponse(404, { detail: "nope" });
    });
    const backend = openAiCompatTtsFactory({
      endpoint: "https://api.siliconflow.cn/v1",
      model: "FunAudioLLM/CosyVoice2-0.5B",
    });
    const voices = await backend.listVoices();
    expect(voices).not.toBeNull();
    expect(voices!.map((v) => v.id)).toEqual([
      "FunAudioLLM/CosyVoice2-0.5B:alex",
      "FunAudioLLM/CosyVoice2-0.5B:benjamin",
      "FunAudioLLM/CosyVoice2-0.5B:charles",
      "FunAudioLLM/CosyVoice2-0.5B:david",
      "FunAudioLLM/CosyVoice2-0.5B:anna",
      "FunAudioLLM/CosyVoice2-0.5B:bella",
      "FunAudioLLM/CosyVoice2-0.5B:claire",
      "FunAudioLLM/CosyVoice2-0.5B:diana",
      "speech:my-voice:cm04:mjt",
    ]);
    expect(voices!.at(-1)!.label).toBe("my-voice · mine");
    // Only the documented custom-list call — no /audio/voices attempt.
    expect(urls).toEqual(["https://api.siliconflow.cn/v1/audio/voice/list"]);
  });

  test("siliconflow listVoices degrades to system voices when the custom list fails; null when no model either", async () => {
    globalThis.fetch = mock(async () => jsonResponse(500, { detail: "boom" }));
    const backend = openAiCompatTtsFactory({
      endpoint: "https://api.siliconflow.cn/v1",
      model: "fishaudio/fish-speech-1.5",
    });
    const voices = await backend.listVoices();
    expect(voices!.length).toBe(8);
    expect(voices![0]!.id).toBe("fishaudio/fish-speech-1.5:alex");

    const noModel = await openAiCompatTtsFactory({ endpoint: "https://api.siliconflow.cn/v1" }).listVoices();
    expect(noModel).toBeNull();
  });

  test("non-SF host with a manual audio-type stamp keeps the legacy /audio/voices attempt", async () => {
    const { captured } = captureFetch(() => new Response("not found", { status: 404 }));
    const backend = openAiCompatTtsFactory({
      endpoint: "http://localhost:9000/v1",
      modelFilter: "audio-type",
    });
    expect(await backend.listVoices()).toBeNull();
    expect(captured()!.url).toBe("http://localhost:9000/v1/audio/voices");
  });
});

// ── Clone capability + cloneVoice (clone field design 2026-08-31) ─────────
describe("OpenAI-compatible TTS clone capability + cloneVoice", () => {
  test("library-route voices (chatterbox) → supportsCloning true, even when the library is empty", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/audio/voices")) return jsonResponse(404, { detail: "nope" });
      return jsonResponse(200, { voices: [], count: 0 });
    });
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:4123/v1" });
    expect(await backend.listVoices()).toBeNull();
    const caps = backend.capabilities();
    expect(caps.supportsCloning).toBe(true);
    expect(caps.formats).toContain("mp3");
    expect(caps.maxSizeMb).toBe(10);
  });

  test("roster-route voices (kokoro-style) → supportsCloning false", async () => {
    captureFetch(() => jsonResponse(200, { voices: [{ id: "af_bella" }] }));
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:8880/v1" });
    expect(await backend.listVoices()).not.toBeNull();
    expect(backend.capabilities().supportsCloning).toBe(false);
  });

  // ── SiliconFlow cloning (TPE-8) ─────────────────────────────────────
  test("siliconflow: cloning is static — capabilities true BEFORE any listVoices, with the transcript hint", async () => {
    const backend = openAiCompatTtsFactory({ endpoint: "https://api.siliconflow.cn/v1" });
    const caps = backend.capabilities();
    expect(caps.supportsCloning).toBe(true);
    expect(caps.cloneRequiresReferenceText).toBe(true);
    expect(caps.cloneCaveatKey).toBe("siliconflow");
    expect(caps.formats).toEqual(["mp3", "wav", "pcm", "opus"]);
    // Host-based: the .com mirror too.
    expect(
      openAiCompatTtsFactory({ endpoint: "https://api.siliconflow.com/v1" }).capabilities()
        .supportsCloning,
    ).toBe(true);
  });

  test("siliconflow cloneVoice: multipart upload with model + customName + text, uri → voice id", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
      return jsonResponse(200, { uri: "speech:hero:cm02:mtt" });
    });
    const backend = openAiCompatTtsFactory({
      endpoint: "https://api.siliconflow.cn/v1",
      model: "FunAudioLLM/CosyVoice2-0.5B",
    });
    const voice = await backend.cloneVoice({
      name: "Hero Voice",
      referenceAudio: Buffer.from([1, 2, 3]),
      mimeType: "audio/mpeg",
      referenceText: "  Hello, this is my voice.  ",
    });
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.siliconflow.cn/v1/uploads/audio/voice");
    expect(call.method).toBe("POST");
    expect(call.body).toBeInstanceOf(FormData);
    const form = call.body as FormData;
    expect(form.get("model")).toBe("FunAudioLLM/CosyVoice2-0.5B");
    expect(form.get("customName")).toBe("Hero Voice");
    expect(form.get("text")).toBe("Hello, this is my voice.");
    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("voice-sample.mp3");
    expect(voice).toEqual({ id: "speech:hero:cm02:mtt", label: "Hero Voice · mine", lang: "multi" });
  });

  test("siliconflow cloneVoice: reference text is required; errors surface; uri missing throws", async () => {
    const backend = openAiCompatTtsFactory({ endpoint: "https://api.siliconflow.cn/v1" });
    await expect(
      backend.cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/mpeg" }),
    ).rejects.toThrow(/transcript/);
    await expect(
      backend.cloneVoice({
        name: "N",
        referenceAudio: Buffer.from([1]),
        mimeType: "audio/mpeg",
        referenceText: "  ",
      }),
    ).rejects.toThrow(/transcript/);

    globalThis.fetch = mock(async () =>
      jsonResponse(403, { code: 4031, message: "real-name verification required" }),
    );
    await expect(
      backend.cloneVoice({
        name: "N",
        referenceAudio: Buffer.from([1]),
        mimeType: "audio/mpeg",
        referenceText: "hi",
      }),
    ).rejects.toThrow(/HTTP 403.*real-name verification/);

    globalThis.fetch = mock(async () => jsonResponse(200, {}));
    await expect(
      backend.cloneVoice({
        name: "N",
        referenceAudio: Buffer.from([1]),
        mimeType: "audio/mpeg",
        referenceText: "hi",
      }),
    ).rejects.toThrow(/missing `uri`/);
  });

  test("siliconflow cloneVoice maps reference mime types to the documented extensions", async () => {
    const names: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      names.push(((init?.body as FormData).get("file") as File).name);
      return jsonResponse(200, { uri: "speech:x:cm:m" });
    });
    const backend = openAiCompatTtsFactory({ endpoint: "https://api.siliconflow.cn/v1" });
    const cases: Array<[string, string]> = [
      ["audio/wav", "voice-sample.wav"],
      ["audio/pcm", "voice-sample.pcm"],
      ["audio/ogg", "voice-sample.opus"],
      ["audio/opus", "voice-sample.opus"],
    ];
    for (const [mimeType, expected] of cases) {
      await backend.cloneVoice({
        name: "N",
        referenceAudio: Buffer.from([1]),
        mimeType,
        referenceText: "hi",
      });
    }
    expect(names).toEqual(cases.map((c) => c[1]));
  });

  test("cloneVoice posts multipart to /voices and resolves the fresh entry by name", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      if (url === "http://localhost:4123/v1/voices" && init?.method === "POST") {
        return jsonResponse(201, { name: "my-clone", ok: true });
      }
      // GET /audio/voices misses (chatterbox), GET /voices returns the library.
      if (url.endsWith("/audio/voices")) return jsonResponse(404, { detail: "nope" });
      return jsonResponse(200, {
        voices: [{ name: "my-clone", language: "ru", exists: true }],
        count: 1,
      });
    });
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:4123/v1" });

    const voice = await backend.cloneVoice!({
      name: "my-clone",
      referenceAudio: Buffer.from("fake-audio"),
      mimeType: "audio/mpeg",
    });

    // Upload went to the library route as multipart FormData…
    const upload = calls.find((c) => c.method === "POST");
    expect(upload?.url).toBe("http://localhost:4123/v1/voices");
    expect(upload?.body).toBeInstanceOf(FormData);
    expect((upload?.body as FormData).get("voice_name")).toBe("my-clone");
    // …and the created voice came from the re-listed library (lang carried).
    expect(voice).toEqual({ id: "my-clone", label: "my-clone", lang: "ru" });
  });

  test("cloneVoice upstream error → thrown with status text (route → client inline error)", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/voices")) {
        return jsonResponse(413, { detail: { error: { message: "file too large" } } });
      }
      if (url.endsWith("/audio/voices")) return jsonResponse(404, {});
      return jsonResponse(200, { voices: [], count: 0 });
    });
    const backend = openAiCompatTtsFactory({ endpoint: "http://localhost:4123/v1" });
    try {
      await backend.cloneVoice!({ name: "x", referenceAudio: Buffer.from("y"), mimeType: "audio/wav" });
      throw new Error("expected cloneVoice to throw");
    } catch (error) {
      expect((error as Error).message).toContain("413");
    }
  });
});
