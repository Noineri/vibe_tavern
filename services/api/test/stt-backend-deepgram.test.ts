/**
 * Deepgram STT backend tests (STT_PROVIDER_EXPANSION SPE-4) — mirror of
 * stt-backend-gemini.test.ts: globalThis.fetch stub capturing the request,
 * pinning the /v1/listen request shape (query params — model, smart_format,
 * language —, `Authorization: Token` auth — NOT Bearer —, raw-binary body
 * with the clip's own MIME) and the channels[].alternatives[].transcript
 * reply extraction. Pure-transport pins — no live calls.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { DEFAULT_DEEPGRAM_STT_MODEL, STT_BACKENDS } from "@vibe-tavern/domain";

import {
  DeepgramSttConfigError,
  DeepgramSttError,
  deepgramSttFactory,
  extractListenTranscript,
} from "../src/domain/stt/backends/deepgram-stt.js";
import type { SttBackend } from "../src/domain/stt/stt-backend.js";

const LISTEN_URL = "https://api.deepgram.com/v1/listen";
const MODELS_URL = "https://api.deepgram.com/v1/models";

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
    captured = {
      url: String(input),
      init: init ?? {},
    };
    return handler();
  });
  return { captured: () => captured };
}

/** The documented /v1/listen success reply (mono dictation: one channel). */
function listenReply(transcript: string): unknown {
  return {
    metadata: {},
    results: {
      channels: [{ alternatives: [{ transcript, confidence: 0.99 }] }],
    },
  };
}

const AUDIO_BYTES = Buffer.from("fake-wav-bytes-16k-mono");

function makeBackend(overrides: Record<string, unknown> = {}): SttBackend {
  return deepgramSttFactory({
    model: "nova-3-test",
    ...overrides,
  } as never);
}

describe("deepgram-stt: config", () => {
  test("missing apiKey → DeepgramSttConfigError", () => {
    expect(() => deepgramSttFactory({ model: "m" } as never)).toThrow(DeepgramSttConfigError);
  });

  test("empty model falls back to DEFAULT_DEEPGRAM_STT_MODEL", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, listenReply("hi")));
    const backend = makeBackend({ apiKey: "k", model: "" });
    await backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" });
    expect(captured()!.url).toContain(`model=${encodeURIComponent(DEFAULT_DEEPGRAM_STT_MODEL)}`);
  });
});

describe("deepgram-stt: transcribe", () => {
  test("request shape: /v1/listen URL with model+smart_format, Token auth, raw body, clip MIME", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, listenReply("привет, как дела")));
    const backend = makeBackend({ apiKey: "test-key" });

    const result = await backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" });

    const req = captured()!;
    // model + smart_format ride the QUERY, not the body; the audio rides the
    // body as raw bytes.
    expect(req.url).toBe(`${LISTEN_URL}?model=nova-3-test&smart_format=true`);
    // The key travels via the documented Token scheme — NOT Bearer.
    expect((req.init.headers as Record<string, string>)["Authorization"]).toBe("Token test-key");
    expect((req.init.headers as Record<string, string>)["Content-Type"]).toBe("audio/wav");
    // The audio rides the body as a raw-bytes Blob, not JSON/FormData.
    expect(req.init.body).toBeInstanceOf(Blob);

    expect(result.text).toBe("привет, как дела");
    expect(result.language).toBeUndefined();
    expect(result.annotation).toBeUndefined();
  });

  test("language hint appends the language query param", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, listenReply("привет")));
    const backend = makeBackend({ apiKey: "k", language: "ru" });
    await backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" });
    expect(captured()!.url).toBe(`${LISTEN_URL}?model=nova-3-test&smart_format=true&language=ru`);
  });

  test("no language hint → no language param (nova-3's own default applies)", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, listenReply("hello")));
    const backend = makeBackend({ apiKey: "k" });
    await backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" });
    expect(captured()!.url).not.toContain("language=");
  });
});

describe("deepgram-stt: errors", () => {
  test("HTTP failure with err_code/err_msg → DeepgramSttError carrying both", async () => {
    captureFetch(() =>
      jsonResponse(422, {
        err_code: "ASR_UNPROCESSABLE_ENTITY",
        err_msg: "the file could not be processed",
        request_id: "req-123",
      }),
    );
    const backend = makeBackend({ apiKey: "k" });
    let caught: unknown;
    try {
      await backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" });
      expect.unreachable();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeepgramSttError);
    const typed = caught as DeepgramSttError;
    expect(typed.status).toBe(422);
    expect(typed.message).toContain("ASR_UNPROCESSABLE_ENTITY");
    expect(typed.message).toContain("the file could not be processed");
    expect(typed.message).toContain("req-123");
  });

  test("HTTP failure with a non-JSON body → status + raw excerpt", async () => {
    globalThis.fetch = mock(async () =>
      new Response("upstream exploded", { status: 502, headers: { "Content-Type": "text/plain" } }),
    );
    const backend = makeBackend({ apiKey: "k" });
    await expect(backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" })).rejects.toMatchObject({
      name: "DeepgramSttError",
      status: 502,
      message: expect.stringContaining("upstream exploded"),
    });
  });

  test("transport failure → DeepgramSttError (network error wrapper)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const backend = makeBackend({ apiKey: "k" });
    await expect(backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" })).rejects.toMatchObject({
      name: "DeepgramSttError",
    });
  });
});

describe("deepgram-stt: probe", () => {
  test("GET models with the Token key; counts the stt roster", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, {
        stt: [{ name: "2ea-nova-3", canonical_name: "nova-3" }, { name: "2ea-nova-2", canonical_name: "nova-2" }],
        tts: [{ name: "tts-entry", canonical_name: "aura-2-zeus-en" }],
      }),
    );
    const backend = makeBackend({ apiKey: "k" });
    const result = await backend.probe();
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("2 models");
    expect(captured()!.url).toBe(MODELS_URL);
    expect((captured()!.init.headers as Record<string, string>)["Authorization"]).toBe("Token k");
  });

  test("HTTP failure → ok:false with the status", async () => {
    captureFetch(() => jsonResponse(401, { err_code: "AUTH_FAILED", err_msg: "invalid api key" }));
    const backend = makeBackend({ apiKey: "bad" });
    const result = await backend.probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");
  });
});

describe("deepgram-stt: listModels (P8 — fetched picker for every listable backend)", () => {
  test("stt[] maps canonical_name to picker ids; tts[] ignored", async () => {
    captureFetch(() =>
      jsonResponse(200, {
        stt: [
          { name: "2ea-nova-3", canonical_name: "nova-3" },
          { name: "2ea-nova-2", canonical_name: "nova-2" },
          { name: "2ea-nova-3-medical", canonical_name: "nova-3-medical" },
          { name: "2ea-whisper", canonical_name: "whisper" },
        ],
        tts: [{ name: "tts-entry", canonical_name: "aura-2-zeus-en" }],
      }),
    );
    const backend = makeBackend({ apiKey: "k" });
    const list = await backend.listModels!();
    expect(list).toEqual([
      { id: "nova-3", label: "nova-3" },
      { id: "nova-2", label: "nova-2" },
      { id: "nova-3-medical", label: "nova-3-medical" },
      { id: "whisper", label: "whisper" },
    ]);
  });

  test("entries without canonical_name fall back to name; stringless entries skipped", async () => {
    captureFetch(() =>
      jsonResponse(200, {
        stt: [{ name: "2ea-nova-3" }, { canonical_name: "nova-2" }, { architecture: "nova" }],
      }),
    );
    const backend = makeBackend({ apiKey: "k" });
    const list = await backend.listModels!();
    expect(list).toEqual([
      { id: "2ea-nova-3", label: "2ea-nova-3" },
      { id: "nova-2", label: "nova-2" },
    ]);
  });

  test("HTTP failure → DeepgramSttError with status", async () => {
    captureFetch(() => jsonResponse(403, { err_code: "AUTH_FAILED", err_msg: "denied" }));
    const backend = makeBackend({ apiKey: "bad" });
    try {
      await backend.listModels!();
      expect.unreachable();
    } catch (error) {
      expect(error.constructor.name).toBe("DeepgramSttError");
      expect((error as { status?: number }).status).toBe(403);
    }
  });
});

describe("deepgram-stt: extractListenTranscript (defensive containers)", () => {
  test("mono shape: channels[0].alternatives[0].transcript", () => {
    expect(extractListenTranscript(listenReply("from channel 0"))).toBe("from channel 0");
  });

  test("stereo shape: non-empty channel transcripts join with a space", () => {
    expect(
      extractListenTranscript({
        results: {
          channels: [
            { alternatives: [{ transcript: "left says" }] },
            { alternatives: [{ transcript: "right says" }] },
          ],
        },
      }),
    ).toBe("left says right says");
  });

  test("empty channel transcripts are dropped from the join", () => {
    expect(
      extractListenTranscript({
        results: {
          channels: [{ alternatives: [{ transcript: "" }] }, { alternatives: [{ transcript: "only this" }] }],
        },
      }),
    ).toBe("only this");
  });

  test("missing containers → empty string, never a throw", () => {
    expect(extractListenTranscript(null)).toBe("");
    expect(extractListenTranscript({})).toBe("");
    expect(extractListenTranscript({ results: {} })).toBe("");
    expect(extractListenTranscript({ results: { channels: [] } })).toBe("");
    expect(extractListenTranscript({ results: { channels: [{ alternatives: [] }] } })).toBe("");
  });
});

describe("deepgram-stt: registry slug", () => {
  test("module-scope registration binds the deepgram slug", async () => {
    const { createSttBackend } = await import("../src/domain/stt/stt-registry.js");
    const backend = createSttBackend(STT_BACKENDS.Deepgram, { apiKey: "k" } as never);
    expect(typeof backend.transcribe).toBe("function");
    expect(typeof backend.listModels).toBe("function");
  });
});
