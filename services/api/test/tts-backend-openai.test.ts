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
    // Null means no fake roster — the static id tables were removed (D20);
    // nothing can leak through.
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

  test("explicit name-heuristic + non-openrouter host → plain URL (param must not leak elsewhere)", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, { data: [{ id: "tts-1" }] }));
    const backend = openAiCompatTtsFactory({
      endpoint: "https://api.groq.com/openai/v1",
      modelFilter: "name-heuristic",
    });
    await backend.listModels();
    expect(captured()!.url).toBe("https://api.groq.com/openai/v1/models");
  });
});
