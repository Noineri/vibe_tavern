/**
 * Unit tests for the OpenAI-compatible STT adapter — mirrors
 * tts-backend-openai.test.ts (mock fetch matrix, request-shape assertions).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { STT_BACKENDS } from "@vibe-tavern/domain";

import {
  OpenAiCompatSttConfigError,
  OpenAiCompatSttError,
  openAiCompatSttFactory,
} from "../src/domain/stt/backends/openai-stt.js";
import {
  createSttBackend,
  registerSttBackend,
} from "../src/domain/stt/stt-registry.js";

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

describe("OpenAI-compatible STT transcribe", () => {
  test("happy path: URL, Bearer, multipart fields, text + language parse", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, { text: "hello world", language: "en" }),
    );
    const backend = openAiCompatSttFactory({
      endpoint: "http://localhost:8000/v1",
      apiKey: "sk-local",
      model: "whisper-1",
    });

    const result = await backend.transcribe(Buffer.from([1, 2, 3]), { mime: "audio/mpeg" });

    const req = captured()!;
    expect(req.url).toBe("http://localhost:8000/v1/audio/transcriptions");
    expect(req.init.method).toBe("POST");
    expect(headersOf(req.init)["authorization"]).toBe("Bearer sk-local");

    const form = req.init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("json");
    expect(form.has("language")).toBe(false);
    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("audio.mp3");
    expect((file as Blob).type).toBe("audio/mpeg");

    expect(result).toEqual({ text: "hello world", language: "en" });
  });

  test("trailing slash in endpoint is normalized away", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, { text: "hi" }));
    const backend = openAiCompatSttFactory({ endpoint: "http://localhost:8000/v1/" });

    await backend.transcribe(Buffer.from([1]), { mime: "audio/mpeg" });

    expect(captured()!.url).toBe("http://localhost:8000/v1/audio/transcriptions");
  });

  test("no apiKey → no Authorization header (keyless local server)", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, { text: "hi" }));
    const backend = openAiCompatSttFactory({ endpoint: "http://127.0.0.1:8000/v1" });

    await backend.transcribe(Buffer.from([1]), { mime: "audio/webm" });

    expect(headersOf(captured()!.init)["authorization"]).toBeUndefined();
    expect((captured()!.init.body as FormData).get("file")).toBeInstanceOf(Blob);
    expect(((captured()!.init.body as FormData).get("file") as File).name).toBe("audio.webm");
  });

  test("language omitted when unset, included when set", async () => {
    const withLang = captureFetch(() => jsonResponse(200, { text: "hi", language: "ru" }));
    const backend = openAiCompatSttFactory({
      endpoint: "http://localhost:8000/v1",
      language: "ru",
    });
    await backend.transcribe(Buffer.from([1]), { mime: "audio/mpeg" });
    expect((withLang.captured()!.init.body as FormData).get("language")).toBe("ru");

    const noLangCapture = captureFetch(() => jsonResponse(200, { text: "hi" }));
    const noLang = openAiCompatSttFactory({ endpoint: "http://localhost:8000/v1" });
    await noLang.transcribe(Buffer.from([1]), { mime: "audio/mpeg" });
    expect((noLangCapture.captured()!.init.body as FormData).has("language")).toBe(false);
  });

  test("non-2xx → OpenAiCompatSttError with status", async () => {
    captureFetch(() => jsonResponse(500, { error: "boom" }));
    const backend = openAiCompatSttFactory({ endpoint: "http://localhost:8000/v1" });

    await expect(backend.transcribe(Buffer.from([1]), { mime: "audio/mpeg" })).rejects.toThrow(
      OpenAiCompatSttError,
    );
    await expect(backend.transcribe(Buffer.from([1]), { mime: "audio/mpeg" })).rejects.toThrow("500");
  });

  test("network failure → OpenAiCompatSttError network error", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const backend = openAiCompatSttFactory({ endpoint: "http://localhost:8000/v1" });

    await expect(backend.transcribe(Buffer.from([1]), { mime: "audio/mpeg" })).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  test("missing endpoint → factory throws config error", async () => {
    expect(() => openAiCompatSttFactory({ model: "whisper-1" })).toThrow(OpenAiCompatSttConfigError);
  });
});

describe("OpenAI-compatible STT listModels", () => {
  test("URL contains output_modalities=transcription; data[] parsed with label", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, { data: [{ id: "whisper-1" }, { id: "gpt-4o-transcribe", name: "GPT-4o Transcribe" }] }),
    );
    const backend = openAiCompatSttFactory({ endpoint: "http://localhost:8000/v1" });

    const models = await backend.listModels();

    expect(captured()!.url).toBe("http://localhost:8000/v1/models?output_modalities=transcription");
    expect(models).toEqual([
      { id: "whisper-1", label: "whisper-1" },
      { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe" },
    ]);
  });

  test("{ models: [...] } body shape (openai-edge-tts style) parses like data", async () => {
    captureFetch(() => jsonResponse(200, { models: [{ id: "whisper-1" }, { id: "whisper-large-v3" }] }));
    const backend = openAiCompatSttFactory({ endpoint: "http://127.0.0.1:8000/v1" });

    const models = await backend.listModels();

    expect(models.map((m) => m.id)).toEqual(["whisper-1", "whisper-large-v3"]);
  });

  test("aggregator enrichment: name/description/pricing parsed into the entry", async () => {
    captureFetch(() =>
      jsonResponse(200, {
        data: [
          {
            id: "openai/whisper-large-v3-turbo:free",
            name: "Whisper large v3 turbo (free)",
            description: "Fast STT model",
            pricing: { prompt: "0", completion: "0" },
          },
          { id: "paid/stt", name: "Paid STT", pricing: { prompt: "3", completion: "0" } },
          { id: "bare/stt" },
        ],
      }),
    );
    const backend = openAiCompatSttFactory({ endpoint: "https://openrouter.ai/api/v1" });

    const models = await backend.listModels();

    expect(models[0]).toEqual({
      id: "openai/whisper-large-v3-turbo:free",
      label: "Whisper large v3 turbo (free)",
      description: "Fast STT model",
      isFree: true,
    });
    expect(models[1]).toEqual({ id: "paid/stt", label: "Paid STT", isFree: false });
    expect(models[2]).toEqual({ id: "bare/stt", label: "bare/stt" });
  });

  test("non-2xx → OpenAiCompatSttError with status", async () => {
    captureFetch(() => jsonResponse(500, { error: "boom" }));
    const backend = openAiCompatSttFactory({ endpoint: "http://localhost:8000/v1" });

    await expect(backend.listModels()).rejects.toThrow(OpenAiCompatSttError);
    await expect(backend.listModels()).rejects.toThrow("500");
  });
});

describe("OpenAI-compatible STT probe", () => {
  test("ok: counts models", async () => {
    captureFetch(() => jsonResponse(200, { data: [{ id: "whisper-1" }, { id: "whisper-2" }] }));
    const backend = openAiCompatSttFactory({ endpoint: "http://localhost:8000/v1" });

    const result = await backend.probe();

    expect(result).toEqual({ ok: true, detail: "2 models" });
  });

  test("non-200 → ok:false with status", async () => {
    captureFetch(() => jsonResponse(403, { error: "forbidden" }));
    const backend = openAiCompatSttFactory({ endpoint: "http://localhost:8000/v1" });

    const result = await backend.probe();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("403");
  });

  test("network error → ok:false, does not throw", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const backend = openAiCompatSttFactory({ endpoint: "http://localhost:8000/v1" });

    const result = await backend.probe();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ECONNREFUSED");
  });
});

describe("rosters + registration", () => {
  test("explicit registration → createSttBackend resolves the factory", () => {
    registerSttBackend(STT_BACKENDS.OpenAiCompat, openAiCompatSttFactory);
    const backend = createSttBackend(STT_BACKENDS.OpenAiCompat, {
      endpoint: "http://localhost:8000/v1",
      model: "whisper-1",
    });
    expect(typeof backend.transcribe).toBe("function");
    expect(typeof backend.probe).toBe("function");
    expect(typeof backend.dispose).toBe("function");
  });
});
