/**
 * Gemini STT backend tests (STT_PLAN ST-7) — mirror of
 * tts-backend-gemini.test.ts: globalThis.fetch stub capturing the request,
 * pinning the Interactions request shape (URL, x-goog-api-key auth — NOT
 * Authorization Bearer —, inline base64 audio part) and both reply modes:
 * plain transcript (toggle off) and JSON transcript+tone (toggle on, the
 * response_format structured pass). Pure-transport pins — no live calls.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { DEFAULT_GEMINI_STT_MODEL, STT_BACKENDS } from "@vibe-tavern/domain";

import {
  GeminiSttConfigError,
  GeminiSttError,
  extractInteractionText,
  geminiSttFactory,
} from "../src/domain/stt/backends/gemini-stt.js";
import type { SttBackend } from "../src/domain/stt/stt-backend.js";

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

type FetchArgs = Parameters<typeof fetch>;

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function captureFetch(handler: () => Response): { captured: () => CapturedRequest | null } {
  let captured: CapturedRequest | null = null;
  globalThis.fetch = mock(async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    const text = typeof init?.body === "string" ? init.body : "";
    captured = {
      url: String(input),
      init: init ?? {},
      body: text !== "" ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
    return handler();
  });
  return { captured: () => captured };
}

/** The Interactions text reply the repo's own chat path reads. */
function interactionsTextReply(text: string): unknown {
  return {
    steps: [{ type: "model_output", content: [{ type: "text", text }] }],
  };
}

const AUDIO_BYTES = Buffer.from("fake-webm-opus-bytes");

function makeBackend(overrides: Record<string, unknown> = {}): SttBackend {
  return geminiSttFactory({
    model: "gemini-test",
    ...overrides,
  } as never);
}

describe("gemini-stt: config", () => {
  test("missing apiKey → GeminiSttConfigError", () => {
    expect(() => geminiSttFactory({ model: "m" } as never)).toThrow(GeminiSttConfigError);
  });

  test("empty model falls back to DEFAULT_GEMINI_STT_MODEL", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, interactionsTextReply("hi")));
    const backend = makeBackend({ apiKey: "k", model: "" });
    await backend.transcribe(AUDIO_BYTES, { mime: "audio/webm" });
    expect(captured()!.body.model).toBe(DEFAULT_GEMINI_STT_MODEL);
  });
});

describe("gemini-stt: transcribe (toggle OFF — plain transcript)", () => {
  test("request shape: Interactions URL, x-goog-api-key header, inline base64 audio, no response_format", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, interactionsTextReply("hello there")));
    const backend = makeBackend({ apiKey: "test-key" });

    const result = await backend.transcribe(AUDIO_BYTES, { mime: "audio/webm;codecs=opus" });

    const req = captured()!;
    expect(req.url).toBe(INTERACTIONS_URL);
    // The key travels via x-goog-api-key — Authorization Bearer is rejected
    // with API_KEY_SERVICE_BLOCKED (pinned by the TTS adapter too).
    expect((req.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    expect((req.init.headers as Record<string, string>).Authorization).toBeUndefined();

    const input = req.body.input as Array<Record<string, unknown>>;
    expect(Array.isArray(input)).toBe(true);
    const textPart = input.find((p) => p.type === "text");
    expect(typeof textPart?.text === "string" && (textPart.text as string).includes("verbatim")).toBe(true);
    const audioPart = input.find((p) => p.type === "audio");
    expect(audioPart?.mime_type).toBe("audio/webm"); // codecs param stripped
    expect(audioPart?.data).toBe(AUDIO_BYTES.toString("base64"));

    // No structured pass without the toggle.
    expect(req.body.response_format).toBeUndefined();

    expect(result.text).toBe("hello there");
    expect(result.annotation).toBeUndefined();
  });

  test("language hint folds into the prompt", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, interactionsTextReply("привет")));
    const backend = makeBackend({ apiKey: "k", language: "ru" });
    await backend.transcribe(AUDIO_BYTES, { mime: "audio/webm" });
    const input = captured()!.body.input as Array<Record<string, unknown>>;
    const textPart = input.find((p) => p.type === "text");
    expect((textPart?.text as string).includes("ru")).toBe(true);
  });
});

describe("gemini-stt: transcribe (toggle ON — transcript + tone in one pass)", () => {
  test("response_format present; JSON reply parses into text + annotation", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, interactionsTextReply('{"transcript":"я не могу больше","tone":"дрожит, сбивчиво"}')),
    );
    const backend = makeBackend({ apiKey: "k", emotionAnnotation: true });

    const result = await backend.transcribe(AUDIO_BYTES, { mime: "audio/webm" });

    const req = captured()!;
    const format = req.body.response_format as Record<string, unknown>;
    expect(format.type).toBe("object");
    expect(format.required).toEqual(["transcript", "tone"]);
    // The prompt asks for the tone in the speech's language.
    const input = req.body.input as Array<Record<string, unknown>>;
    const textPart = input.find((p) => p.type === "text");
    expect((textPart?.text as string).includes("tone of voice")).toBe(true);

    expect(result.text).toBe("я не могу больше");
    expect(result.annotation).toBe("дрожит, сбивчиво");
  });

  test("schema-violating reply degrades to the raw text as the transcript", async () => {
    captureFetch(() => jsonResponse(200, interactionsTextReply("not json at all")));
    const backend = makeBackend({ apiKey: "k", emotionAnnotation: true });
    const result = await backend.transcribe(AUDIO_BYTES, { mime: "audio/webm" });
    expect(result.text).toBe("not json at all");
    expect(result.annotation).toBeUndefined();
  });

  test("empty tone in the JSON reply is treated as absent", async () => {
    captureFetch(() =>
      jsonResponse(200, interactionsTextReply('{"transcript":"words","tone":"   "}')),
    );
    const backend = makeBackend({ apiKey: "k", emotionAnnotation: true });
    const result = await backend.transcribe(AUDIO_BYTES, { mime: "audio/webm" });
    expect(result.text).toBe("words");
    expect(result.annotation).toBeUndefined();
  });

  test("fenced JSON reply still parses", async () => {
    captureFetch(() =>
      jsonResponse(200, interactionsTextReply('```json\n{"transcript":"hi","tone":"calm"}\n```')),
    );
    const backend = makeBackend({ apiKey: "k", emotionAnnotation: true });
    const result = await backend.transcribe(AUDIO_BYTES, { mime: "audio/webm" });
    expect(result.text).toBe("hi");
    expect(result.annotation).toBe("calm");
  });
});

describe("gemini-stt: errors", () => {
  test("HTTP failure → GeminiSttError with status", async () => {
    captureFetch(() => jsonResponse(429, { error: { message: "quota" } }));
    const backend = makeBackend({ apiKey: "k" });
    await expect(backend.transcribe(AUDIO_BYTES, { mime: "audio/webm" })).rejects.toMatchObject({
      name: "GeminiSttError",
      status: 429,
    });
  });

  test("transport failure → GeminiSttError (network error wrapper)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const backend = makeBackend({ apiKey: "k" });
    await expect(backend.transcribe(AUDIO_BYTES, { mime: "audio/webm" })).rejects.toMatchObject({
      name: "GeminiSttError",
    });
  });
});

describe("gemini-stt: probe", () => {
  test("GET models with the key; counts the catalog", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, { models: [{ name: "models/a" }, { name: "models/b" }] }),
    );
    const backend = makeBackend({ apiKey: "k" });
    const result = await backend.probe();
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("2 models");
    expect(captured()!.url).toBe(MODELS_URL);
    expect((captured()!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
  });

  test("HTTP failure → ok:false with the status", async () => {
    captureFetch(() => jsonResponse(401, { error: { message: "bad key" } }));
    const backend = makeBackend({ apiKey: "bad" });
    const result = await backend.probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");
  });
});

describe("gemini-stt: listModels (P8 — fetched picker for every listable backend)", () => {
  test("catalog maps to bare ids, stripping the models/ prefix", async () => {
    captureFetch(() =>
      jsonResponse(200, { models: [{ name: "models/gemini-3.8-flash" }, { name: "models/gemini-3.8-pro" }] }),
    );
    const backend = makeBackend({ apiKey: "k" });
    const list = await backend.listModels!();
    expect(list).toEqual([
      { id: "gemini-3.8-flash", label: "gemini-3.8-flash" },
      { id: "gemini-3.8-pro", label: "gemini-3.8-pro" },
    ]);
  });

  test("non-chat families are filtered out of the picker list", async () => {
    captureFetch(() =>
      jsonResponse(200, {
        models: [
          { name: "models/gemini-3.8-flash" },
          { name: "models/gemini-2.5-flash-preview-tts" },
          { name: "models/imagen-4.0-generate" },
          { name: "models/veo-3.0" },
          { name: "models/text-embedding-005" },
          { name: "models/gemini-2.5-flash-native-audio" },
          { name: "models/aqa" },
        ],
      }),
    );
    const backend = makeBackend({ apiKey: "k" });
    const list = await backend.listModels!();
    expect(list).toEqual([{ id: "gemini-3.8-flash", label: "gemini-3.8-flash" }]);
  });

  test("HTTP failure → GeminiSttError with status", async () => {
    captureFetch(() => jsonResponse(403, { error: { message: "denied" } }));
    const backend = makeBackend({ apiKey: "bad" });
    try {
      await backend.listModels!();
      expect.unreachable();
    } catch (error) {
      expect(error.constructor.name).toBe("GeminiSttError");
      expect((error as { status?: number }).status).toBe(403);
    }
  });
});

describe("gemini-stt: extractInteractionText (defensive containers)", () => {
  test("steps → candidates → output precedence", () => {
    expect(extractInteractionText(interactionsTextReply("from steps"))).toBe("from steps");
    expect(
      extractInteractionText({ candidates: [{ content: { parts: [{ text: "from candidates" }] } }] }),
    ).toBe("from candidates");
    expect(extractInteractionText({ output: [{ text: "from output" }] })).toBe("from output");
    expect(extractInteractionText(null)).toBe("");
    expect(extractInteractionText({ steps: [{ type: "thought", content: [{ type: "text", text: "x" }] }] })).toBe("");
  });
});

describe("gemini-stt: registry slug", () => {
  test("module-scope registration binds the gemini slug", async () => {
    const { createSttBackend } = await import("../src/domain/stt/stt-registry.js");
    const backend = createSttBackend(STT_BACKENDS.Gemini, { apiKey: "k" } as never);
    expect(typeof backend.transcribe).toBe("function");
  });
});
